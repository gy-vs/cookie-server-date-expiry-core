/* eslint @typescript-eslint/no-non-null-assertion: off */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Cookie } from '../cookie/cookie.js'
import { CookieJar } from '../cookie/cookieJar.js'

const FAKE_NOW = '2026-10-03T00:00:00.000Z'
const SERVER_NOW = '2030-01-01T00:00:00.000Z'

beforeAll(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(FAKE_NOW))
})

afterAll(() => {
  vi.useRealTimers()
})

describe('expiry diagnostics: legacy API behavior is unchanged', () => {
  const setCookie =
    'alpha=beta; Domain=example.com; Path=/foo; Expires=Tue, 19 Jan 2038 03:14:07 GMT; Max-Age=3600; HttpOnly; Max-Age=not-a-number; Expires=not-a-date'

  it('parsing with recordExpiryInfo produces an identical cookie', () => {
    const plain = Cookie.parse(setCookie)
    const recorded = Cookie.parse(setCookie, { recordExpiryInfo: true })

    expect(recorded).toBeInstanceOf(Cookie)
    expect(recorded).toEqual(plain)
    expect(Object.keys(recorded!)).toEqual(Object.keys(plain!))
    expect(recorded!.toString()).toBe(plain!.toString())
    expect(recorded!.cookieString()).toBe(plain!.cookieString())
    expect(recorded!.toJSON()).toEqual(plain!.toJSON())
    expect(JSON.stringify(recorded)).toBe(JSON.stringify(plain))
  })

  it('parsing without recordExpiryInfo records nothing', () => {
    const cookie = Cookie.parse(setCookie)
    expect(cookie!.getExpiryInfo()).toBeUndefined()
  })

  it('getCookieString and getSetCookieStrings are identical with and without recording', async () => {
    const url = 'https://example.com/foo'
    const withRecording = new CookieJar()
    const withoutRecording = new CookieJar()

    await withRecording.setCookie('a=b; Max-Age=1000; Path=/', url, {
      recordExpiryInfo: true,
    })
    await withoutRecording.setCookie('a=b; Max-Age=1000; Path=/', url)

    const headerWith = await withRecording.getCookieString(url)
    const headerWithout = await withoutRecording.getCookieString(url)
    expect(headerWith).toBe('a=b')
    expect(headerWith).toBe(headerWithout)

    const setCookiesWith = await withRecording.getSetCookieStrings(url)
    const setCookiesWithout = await withoutRecording.getSetCookieStrings(url)
    expect(setCookiesWith).toEqual(setCookiesWithout)
  })

  it('serialized jars are identical with and without recording', async () => {
    const url = 'https://example.com/'
    const now = new Date(SERVER_NOW)
    const withRecording = new CookieJar()
    const withoutRecording = new CookieJar()

    await withRecording.setCookie(
      'a=b; Expires=Tue, 19 Jan 2038 03:14:07 GMT; Max-Age=1000',
      url,
      { now, recordExpiryInfo: true },
    )
    await withoutRecording.setCookie(
      'a=b; Expires=Tue, 19 Jan 2038 03:14:07 GMT; Max-Age=1000',
      url,
      { now },
    )

    const serializedWith = await withRecording.serialize()
    const serializedWithout = await withoutRecording.serialize()
    expect(serializedWith).toEqual(serializedWithout)
    expect(JSON.stringify(serializedWith)).toBe(
      JSON.stringify(serializedWithout),
    )
    // no diagnostics leak into the persisted cookie content
    expect(serializedWith.cookies[0]).toEqual({
      key: 'a',
      value: 'b',
      expires: '2038-01-19T03:14:07.000Z',
      maxAge: 1000,
      domain: 'example.com',
      path: '/',
      hostOnly: true,
      pathIsDefault: true,
      creation: SERVER_NOW,
      lastAccessed: SERVER_NOW,
    })
  })

  it('diagnostics do not survive clone() or JSON round-trips', () => {
    const cookie = Cookie.parse('a=b; Max-Age=100', {
      recordExpiryInfo: true,
    })!
    expect(cookie.getExpiryInfo()).toBeDefined()

    const cloned = cookie.clone()!
    expect(cloned).toEqual(cookie)
    expect(cloned.getExpiryInfo()).toBeUndefined()

    const revived = Cookie.fromJSON(JSON.stringify(cookie))!
    expect(revived.getExpiryInfo()).toBeUndefined()
  })
})

describe('expiry diagnostics: parsed attributes', () => {
  it('explains an Expires-only cookie', () => {
    const cookie = Cookie.parse('a=b; Expires=Tue, 19 Jan 2038 03:14:07 GMT', {
      recordExpiryInfo: true,
    })!
    expect(cookie.getExpiryInfo()).toEqual({
      rawExpires: 'Tue, 19 Jan 2038 03:14:07 GMT',
      rawMaxAge: null,
      parsedExpires: '2038-01-19T03:14:07.000Z',
      parsedMaxAge: null,
      parsedAt: FAKE_NOW,
      droppedAttributes: [],
      storedAt: null,
      localClockAt: null,
      clockSkewMs: null,
      decidedBy: 'expires',
      expiresAt: '2038-01-19T03:14:07.000Z',
    })
  })

  it('explains a Max-Age-only cookie', () => {
    const cookie = Cookie.parse('a=b; Max-Age=3600', {
      recordExpiryInfo: true,
    })!
    expect(cookie.getExpiryInfo()).toEqual({
      rawExpires: null,
      rawMaxAge: '3600',
      parsedExpires: null,
      parsedMaxAge: 3600,
      parsedAt: FAKE_NOW,
      droppedAttributes: [],
      storedAt: null,
      localClockAt: null,
      clockSkewMs: null,
      decidedBy: 'max-age',
      // not stored, so the parse time is the basis
      expiresAt: '2026-10-03T01:00:00.000Z',
    })
  })

  it('Max-Age takes precedence over Expires when both are present', () => {
    const cookie = Cookie.parse(
      'a=b; Expires=Tue, 19 Jan 2038 03:14:07 GMT; Max-Age=60',
      { recordExpiryInfo: true },
    )!
    const info = cookie.getExpiryInfo()!
    expect(info.rawExpires).toBe('Tue, 19 Jan 2038 03:14:07 GMT')
    expect(info.parsedExpires).toBe('2038-01-19T03:14:07.000Z')
    expect(info.rawMaxAge).toBe('60')
    expect(info.decidedBy).toBe('max-age')
    expect(info.expiresAt).toBe('2026-10-03T00:01:00.000Z')
  })

  it('explains a session cookie (no expiry attributes)', () => {
    const cookie = Cookie.parse('a=b', { recordExpiryInfo: true })!
    const info = cookie.getExpiryInfo()!
    expect(info.rawExpires).toBeNull()
    expect(info.rawMaxAge).toBeNull()
    expect(info.parsedExpires).toBeNull()
    expect(info.parsedMaxAge).toBeNull()
    expect(info.droppedAttributes).toEqual([])
    expect(info.decidedBy).toBe('session')
    expect(info.expiresAt).toBeNull()
  })

  it('records invalid Max-Age values as dropped and falls back to Expires', () => {
    const cookie = Cookie.parse(
      'a=b; Max-Age=3600.5; Expires=Tue, 19 Jan 2038 03:14:07 GMT',
      { recordExpiryInfo: true },
    )!
    const info = cookie.getExpiryInfo()!
    expect(info.droppedAttributes).toEqual([
      { name: 'max-age', value: '3600.5', reason: 'invalid-integer' },
    ])
    expect(info.rawMaxAge).toBeNull()
    expect(info.parsedMaxAge).toBeNull()
    expect(info.decidedBy).toBe('expires')
    expect(info.expiresAt).toBe('2038-01-19T03:14:07.000Z')
  })

  it('records invalid Expires values as dropped', () => {
    const cookie = Cookie.parse('a=b; Expires=not-a-date; Max-Age=10', {
      recordExpiryInfo: true,
    })!
    const info = cookie.getExpiryInfo()!
    expect(info.droppedAttributes).toEqual([
      { name: 'expires', value: 'not-a-date', reason: 'invalid-date' },
    ])
    expect(info.decidedBy).toBe('max-age')
  })

  it('records empty expiry attributes as dropped', () => {
    const cookie = Cookie.parse('a=b; Expires=; Max-Age; Expires', {
      recordExpiryInfo: true,
    })!
    expect(cookie.getExpiryInfo()!.droppedAttributes).toEqual([
      { name: 'expires', value: '', reason: 'empty-value' },
      { name: 'max-age', value: null, reason: 'empty-value' },
      { name: 'expires', value: null, reason: 'empty-value' },
    ])
    expect(cookie.getExpiryInfo()!.decidedBy).toBe('session')
  })

  it('an invalid later Expires does not overwrite a valid earlier one', () => {
    const cookie = Cookie.parse(
      'a=b; Expires=Tue, 19 Jan 2038 03:14:07 GMT; Expires=garbage',
      { recordExpiryInfo: true },
    )!
    const info = cookie.getExpiryInfo()!
    expect(info.rawExpires).toBe('Tue, 19 Jan 2038 03:14:07 GMT')
    expect(info.parsedExpires).toBe('2038-01-19T03:14:07.000Z')
    expect(info.droppedAttributes).toEqual([
      { name: 'expires', value: 'garbage', reason: 'invalid-date' },
    ])
    expect(info.decidedBy).toBe('expires')
  })

  it('the last valid duplicate attribute wins', () => {
    const cookie = Cookie.parse('a=b; Max-Age=10; Max-Age=20', {
      recordExpiryInfo: true,
    })!
    const info = cookie.getExpiryInfo()!
    expect(info.rawMaxAge).toBe('20')
    expect(info.parsedMaxAge).toBe(20)
    expect(info.expiresAt).toBe('2026-10-03T00:00:20.000Z')
  })

  it('a zero or negative Max-Age expires at the epoch', () => {
    for (const maxAge of ['0', '-100']) {
      const cookie = Cookie.parse(`a=b; Max-Age=${maxAge}`, {
        recordExpiryInfo: true,
      })!
      const info = cookie.getExpiryInfo()!
      expect(info.decidedBy).toBe('max-age')
      expect(info.expiresAt).toBe('1970-01-01T00:00:00.000Z')
    }
  })

  it('an unrepresentable Max-Age yields a null expiresAt but keeps the parsed value', () => {
    const cookie = Cookie.parse('a=b; Max-Age=99999999999999', {
      recordExpiryInfo: true,
    })!
    const info = cookie.getExpiryInfo()!
    expect(info.parsedMaxAge).toBe(99999999999999)
    expect(info.decidedBy).toBe('max-age')
    expect(info.expiresAt).toBeNull()
  })
})

describe('expiry diagnostics: server-time correction at store time', () => {
  const url = 'https://example.com/'

  it('records the server date, the local clock, and the skew between them', async () => {
    const jar = new CookieJar()
    // simulate passing the server response's Date header, one hour ahead of
    // the (misconfigured) local clock
    const serverDate = new Date(Date.now() + 3_600_000)
    const cookie = await jar.setCookie('a=b; Max-Age=60', url, {
      now: serverDate,
      recordExpiryInfo: true,
    })

    const info = cookie!.getExpiryInfo()!
    expect(info.storedAt).toBe(serverDate.toISOString())
    expect(info.localClockAt).toBe(FAKE_NOW)
    expect(info.clockSkewMs).toBe(3_600_000)
    // the Max-Age is measured against the server date, not the local clock
    expect(info.expiresAt).toBe(
      new Date(serverDate.getTime() + 60_000).toISOString(),
    )
  })

  it('reports zero skew when no server date is supplied', async () => {
    const jar = new CookieJar()
    const cookie = await jar.setCookie('a=b; Max-Age=60', url, {
      recordExpiryInfo: true,
    })
    const info = cookie!.getExpiryInfo()!
    expect(info.storedAt).toBe(FAKE_NOW)
    expect(info.localClockAt).toBe(FAKE_NOW)
    expect(info.clockSkewMs).toBe(0)
    expect(info.expiresAt).toBe('2026-10-03T00:01:00.000Z')
  })

  it('keeps recording at store time for cookies parsed with recording (sticky)', async () => {
    const jar = new CookieJar()
    const cookie = Cookie.parse('a=b; Max-Age=60', { recordExpiryInfo: true })!
    // no recordExpiryInfo on setCookie: the existing record is still updated
    await jar.setCookie(cookie, url, { now: new Date(SERVER_NOW) })
    const info = cookie.getExpiryInfo()!
    expect(info.storedAt).toBe(SERVER_NOW)
    expect(info.clockSkewMs).toBe(
      new Date(SERVER_NOW).getTime() - new Date(FAKE_NOW).getTime(),
    )
  })

  it('records store-time info for cookie objects when enabled on setCookie', async () => {
    const jar = new CookieJar()
    const cookie = Cookie.parse('a=b; Expires=Tue, 19 Jan 2038 03:14:07 GMT')!
    expect(cookie.getExpiryInfo()).toBeUndefined()

    await jar.setCookie(cookie, url, {
      now: new Date(SERVER_NOW),
      recordExpiryInfo: true,
    })
    const info = cookie.getExpiryInfo()!
    // no raw attributes are known (the cookie was parsed without recording),
    // but the parsed values are recovered from the cookie itself
    expect(info.rawExpires).toBeNull()
    expect(info.parsedExpires).toBe('2038-01-19T03:14:07.000Z')
    expect(info.storedAt).toBe(SERVER_NOW)
    expect(info.decidedBy).toBe('expires')
    expect(info.expiresAt).toBe('2038-01-19T03:14:07.000Z')
  })
})

describe('expiry diagnostics: consistency across stores and updates', () => {
  const url = 'https://example.com/'

  it('cookies read back from the jar carry the same diagnostics', async () => {
    const jar = new CookieJar()
    const stored = await jar.setCookie('a=b; Max-Age=100', url, {
      now: new Date(SERVER_NOW),
      recordExpiryInfo: true,
    })

    const [retrieved] = await jar.getCookies(url)
    expect(retrieved.getExpiryInfo()).toEqual(stored!.getExpiryInfo())

    const found = await jar.store.findCookie('example.com', '/', 'a')
    expect(found!.getExpiryInfo()).toEqual(stored!.getExpiryInfo())
  })

  it('updating a cookie replaces the diagnostics with the latest Set-Cookie', async () => {
    const jar = new CookieJar()
    await jar.setCookie('a=first; Max-Age=100', url, {
      recordExpiryInfo: true,
    })
    await jar.setCookie('a=second; Max-Age=200', url, {
      recordExpiryInfo: true,
    })

    const [retrieved] = await jar.getCookies(url)
    expect(retrieved.value).toBe('second')
    const info = retrieved.getExpiryInfo()!
    expect(info.rawMaxAge).toBe('200')
    expect(info.parsedMaxAge).toBe(200)
  })

  it('concurrent updates leave diagnostics that match the stored cookie', async () => {
    const jar = new CookieJar()
    await Promise.all([
      jar.setCookie('a=v1; Max-Age=300', url, { recordExpiryInfo: true }),
      jar.setCookie('a=v2; Max-Age=400', url, { recordExpiryInfo: true }),
    ])

    const [retrieved] = await jar.getCookies(url)
    const info = retrieved.getExpiryInfo()!
    // whichever write won, the diagnostics describe the cookie actually stored
    expect(['v1', 'v2']).toContain(retrieved.value)
    expect(info.rawMaxAge).toBe(String(retrieved.maxAge))
    expect(info.parsedMaxAge).toBe(retrieved.maxAge)
    expect(info.decidedBy).toBe('max-age')
  })
})

describe('expiry diagnostics: output properties', () => {
  it('produces the same absolute times regardless of the local timezone', () => {
    const originalTz = process.env.TZ
    try {
      process.env.TZ = 'America/New_York'
      const nyOffset = new Date().getTimezoneOffset()
      const infoNY = Cookie.parse(
        'a=b; Expires=Tue, 19 Jan 2038 03:14:07 GMT; Max-Age=60',
        { recordExpiryInfo: true },
      )!.getExpiryInfo()

      process.env.TZ = 'Asia/Shanghai'
      const shOffset = new Date().getTimezoneOffset()
      const infoSH = Cookie.parse(
        'a=b; Expires=Tue, 19 Jan 2038 03:14:07 GMT; Max-Age=60',
        { recordExpiryInfo: true },
      )!.getExpiryInfo()

      // sanity check: the timezones really are different in this process
      expect(nyOffset).not.toBe(shOffset)
      expect(infoSH).toEqual(infoNY)
    } finally {
      if (originalTz === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = originalTz
      }
    }
  })

  it('is JSON-serializable for logging', async () => {
    const jar = new CookieJar()
    const cookie = await jar.setCookie(
      'a=b; Expires=Tue, 19 Jan 2038 03:14:07 GMT; Max-Age=oops',
      'https://example.com/',
      { now: new Date(SERVER_NOW), recordExpiryInfo: true },
    )
    const info = cookie!.getExpiryInfo()!
    expect(JSON.parse(JSON.stringify(info))).toEqual(info)
  })

  it('returns a fresh object on each call', () => {
    const cookie = Cookie.parse('a=b; Max-Age=100', {
      recordExpiryInfo: true,
    })!
    const first = cookie.getExpiryInfo()!
    first.decidedBy = 'session'
    first.droppedAttributes.push({
      name: 'expires',
      value: 'x',
      reason: 'invalid-date',
    })
    const second = cookie.getExpiryInfo()!
    expect(second.decidedBy).toBe('max-age')
    expect(second.droppedAttributes).toEqual([])
  })
})
