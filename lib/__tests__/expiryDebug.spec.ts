import { describe, expect, it } from 'vitest'
import {
  Cookie,
  CookieJar,
  EXPIRY_DEBUG_JSON_KEY,
  MemoryCookieStore,
  isExpiryDebugInfo,
} from '../cookie/index.js'
import type {
  Cookie as CookieType,
  ExpiryDebugInfo,
  SerializedCookieJar,
} from '../cookie/index.js'

// Fixed instant kept in the future relative to the real wall clock so the
// expiry check in getCookies() does not remove test cookies.
const NOW = new Date(
  Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000) * 1000,
)
const NOW_EPOCH = NOW.getTime()
const NOW_ISO = NOW.toISOString()
// RFC6265 cookie dates have 1-second resolution
const EXPIRES = new Date(NOW_EPOCH + 60 * 60 * 1000)
const EXPIRES_HEADER = EXPIRES.toUTCString()
const EXPIRES_EPOCH = Date.parse(EXPIRES_HEADER)
const SERVER_DATE = new Date(NOW_EPOCH + 5 * 60 * 1000).toUTCString()
const SERVER_EPOCH = Date.parse(SERVER_DATE) // +5 minutes relative to NOW
const SERVER_ISO = new Date(SERVER_EPOCH).toISOString()
const SKEW_MS = SERVER_EPOCH - NOW_EPOCH

function parseDebug(
  str: string,
  options?: { expiryDebug?: boolean },
): { cookie: CookieType; info: ExpiryDebugInfo } {
  const cookie = Cookie.parse(str, options ?? { expiryDebug: true })
  if (!cookie) {
    throw new Error(`expected ${JSON.stringify(str)} to parse`)
  }
  const info = cookie.getExpiryDebugInfo()
  if (!info) {
    throw new Error('expected expiry debug info to be attached')
  }
  return { cookie, info }
}

function setDebug(
  jar: CookieJar,
  str: string | CookieType,
  options?: Parameters<CookieJar['setCookieSync']>[2],
): { cookie: CookieType; info: ExpiryDebugInfo } {
  const cookie = jar.setCookieSync(str, 'http://example.com/', {
    expiryDebug: true,
    now: NOW,
    ...options,
  })
  if (!cookie) {
    throw new Error('expected cookie to be stored')
  }
  const info = cookie.getExpiryDebugInfo()
  if (!info) {
    throw new Error('expected expiry debug info to be attached')
  }
  return { cookie, info }
}

function expiryEpoch(info: ExpiryDebugInfo): number {
  if (!info.expiry) {
    throw new Error('expected an absolute expiry')
  }
  return info.expiry.epochMs
}

describe('Cookie.parse expiry diagnostics', () => {
  it('reports a max-age-based expiry', () => {
    const before = Date.now()
    const { info } = parseDebug('a=b; Max-Age=60')
    const after = Date.now()
    expect(info.version).toBe(1)
    expect(info.source).toBe('max-age')
    expect(info.maxAgeOccurrences).toEqual([{ raw: '60', deltaSeconds: 60 }])
    expect(info.expiresOccurrences).toEqual([])
    expect(info.dropped).toEqual([])
    // Standalone parse finalizes against the local clock at parse time
    expect(info.expiry).not.toBeNull()
    expect(expiryEpoch(info)).toBeGreaterThanOrEqual(before + 60_000)
    expect(expiryEpoch(info)).toBeLessThanOrEqual(after + 60_000)
    expect(info.expiry?.iso).toBe(new Date(expiryEpoch(info)).toISOString())
    expect(info.localNow.epochMs).toBe(expiryEpoch(info) - 60_000)
    expect(info.expiryImmediate).toBe(false)
    expect(info.expiryInfinite).toBe(false)
    expect(info.serverDate).toBeNull()
    expect(info.serverDateRaw).toBeNull()
    expect(info.clockSkewMs).toBeNull()
    expect(info.correctedExpiry).toBeNull()
  })

  it('reports an expires-based expiry with the parsed absolute time', () => {
    const { info } = parseDebug('a=b; Expires=Thu, 15 Jan 2026 13:00:00 GMT')
    expect(info.source).toBe('expires')
    expect(info.expiresOccurrences).toEqual([
      {
        raw: 'Thu, 15 Jan 2026 13:00:00 GMT',
        parsed: {
          epochMs: Date.parse('Thu, 15 Jan 2026 13:00:00 GMT'),
          iso: '2026-01-15T13:00:00.000Z',
        },
      },
    ])
    expect(info.expiry).toEqual({
      epochMs: Date.parse('Thu, 15 Jan 2026 13:00:00 GMT'),
      iso: '2026-01-15T13:00:00.000Z',
    })
    expect(info.expiryImmediate).toBe(false)
  })

  it('reports a session cookie with no expiry', () => {
    const { info } = parseDebug('a=b; Path=/')
    expect(info.source).toBe('session')
    expect(info.expiry).toBeNull()
    expect(info.expiryImmediate).toBe(false)
    expect(info.expiryInfinite).toBe(false)
  })

  it('records max-age winning over a valid expires', () => {
    const { info } = parseDebug(
      'a=b; Expires=Thu, 15 Jan 2026 13:00:00 GMT; Max-Age=30',
    )
    expect(info.source).toBe('max-age')
    expect(info.expiresOccurrences).toHaveLength(1)
    expect(info.maxAgeOccurrences).toEqual([{ raw: '30', deltaSeconds: 30 }])
    expect(info.dropped).toEqual([])
  })

  it('records zero and negative max-age as immediate expiry', () => {
    expect(parseDebug('a=b; Max-Age=0').info).toMatchObject({
      source: 'max-age',
      expiryImmediate: true,
      expiry: { epochMs: 0, iso: '1970-01-01T00:00:00.000Z' },
    })
    expect(parseDebug('a=b; Max-Age=-5').info).toMatchObject({
      source: 'max-age',
      expiryImmediate: true,
    })
  })

  it('records invalid and dropped expiry attributes', () => {
    const { info } = parseDebug(
      'a=b; Expires=not-a-date; Max-Age=soon; Expires=; Max-Age=',
    )
    expect(info.dropped).toEqual([
      { attribute: 'expires', raw: 'not-a-date', reason: 'invalid-date' },
      { attribute: 'max-age', raw: 'soon', reason: 'invalid-integer' },
      { attribute: 'expires', raw: '', reason: 'empty' },
      { attribute: 'max-age', raw: '', reason: 'empty' },
    ])
    // Nothing valid applied: session cookie
    expect(info.source).toBe('session')
    expect(info.expiresOccurrences).toEqual([
      { raw: 'not-a-date', parsed: null },
      { raw: '', parsed: null },
    ])
    expect(info.maxAgeOccurrences).toEqual([
      { raw: 'soon', deltaSeconds: null },
      { raw: '', deltaSeconds: null },
    ])
  })

  it('records every occurrence; the last valid one is applied', () => {
    const { info } = parseDebug(
      'a=b; Expires=bad; Expires=Thu, 15 Jan 2026 13:00:00 GMT; Max-Age=1x; Max-Age=45',
    )
    expect(info.expiresOccurrences).toEqual([
      { raw: 'bad', parsed: null },
      {
        raw: 'Thu, 15 Jan 2026 13:00:00 GMT',
        parsed: {
          epochMs: Date.parse('Thu, 15 Jan 2026 13:00:00 GMT'),
          iso: '2026-01-15T13:00:00.000Z',
        },
      },
    ])
    expect(info.maxAgeOccurrences).toEqual([
      { raw: '1x', deltaSeconds: null },
      { raw: '45', deltaSeconds: 45 },
    ])
    expect(info.source).toBe('max-age')
    expect(info.dropped).toHaveLength(2)
  })
})

describe('CookieJar.setCookie expiry diagnostics', () => {
  it('finalizes max-age against the now option and reports clock skew from the response Date', () => {
    const jar = new CookieJar(null, { rejectPublicSuffixes: false })
    const { info } = setDebug(jar, 'sid=1; Max-Age=60', {
      serverDate: SERVER_DATE,
    })
    expect(info.localNow).toEqual({ epochMs: NOW_EPOCH, iso: NOW_ISO })
    expect(info.serverDateRaw).toBe(SERVER_DATE)
    expect(info.serverDate).toEqual({
      epochMs: SERVER_EPOCH,
      iso: SERVER_ISO,
    })
    expect(info.clockSkewMs).toBe(SKEW_MS)
    expect(info.expiry).toEqual({
      epochMs: NOW_EPOCH + 60_000,
      iso: new Date(NOW_EPOCH + 60_000).toISOString(),
    })
    // +5 min skew means the corrected (server-trusted) expiry is +5 min too
    expect(info.correctedExpiry).toEqual({
      epochMs: NOW_EPOCH + 60_000 + SKEW_MS,
      iso: new Date(NOW_EPOCH + 60_000 + SKEW_MS).toISOString(),
    })
    expect(info.correctedExpiryImmediate).toBe(false)
    expect(info.correctedExpiryInfinite).toBe(false)
  })

  it('reports clock skew and corrected expiry for expires-based cookies', () => {
    const jar = new CookieJar(null, { rejectPublicSuffixes: false })
    const { info } = setDebug(jar, `sid=1; Expires=${EXPIRES_HEADER}`, {
      serverDate: SERVER_DATE,
    })
    expect(info.source).toBe('expires')
    expect(expiryEpoch(info)).toBe(EXPIRES_EPOCH)
    expect(info.correctedExpiry?.epochMs).toBe(EXPIRES_EPOCH + SKEW_MS)
  })

  it('accepts a Date object as serverDate', () => {
    const jar = new CookieJar(null, { rejectPublicSuffixes: false })
    const { info } = setDebug(jar, 'sid=1; Max-Age=60', {
      serverDate: new Date(SERVER_EPOCH),
    })
    expect(info.serverDateRaw).toBeNull()
    expect(info.serverDate?.epochMs).toBe(SERVER_EPOCH)
    expect(info.clockSkewMs).toBe(SKEW_MS)
  })

  it('reports an invalid serverDate without affecting the cookie', () => {
    const jar = new CookieJar(null, { rejectPublicSuffixes: false })
    const { info } = setDebug(jar, 'sid=1; Max-Age=60', {
      serverDate: 'garbage',
    })
    expect(info.serverDateRaw).toBe('garbage')
    expect(info.serverDate).toBeNull()
    expect(info.clockSkewMs).toBeNull()
    expect(info.correctedExpiry).toBeNull()
    expect(expiryEpoch(info)).toBe(NOW_EPOCH + 60_000)
  })

  it('builds diagnostics for a Cookie object passed to setCookie', () => {
    const jar = new CookieJar(null, { rejectPublicSuffixes: false })
    const parsed = Cookie.parse('sid=1; Max-Age=60')
    expect(parsed).toBeInstanceOf(Cookie)
    if (!parsed) {
      throw new Error('expected cookie to parse')
    }
    const { info } = setDebug(jar, parsed)
    expect(info.source).toBe('max-age')
    // Raw attribute text was never seen: occurrence lists stay empty.
    expect(info.maxAgeOccurrences).toEqual([])
    expect(expiryEpoch(info)).toBe(NOW_EPOCH + 60_000)
  })

  it('attaches no diagnostics by default', () => {
    const jar = new CookieJar(null, { rejectPublicSuffixes: false })
    const cookie = jar.setCookieSync(
      'sid=1; Max-Age=60',
      'http://example.com/',
      {
        now: NOW,
      },
    )
    expect(cookie?.getExpiryDebugInfo()).toBeUndefined()
    expect(
      Cookie.parse('sid=1; Max-Age=60')?.getExpiryDebugInfo(),
    ).toBeUndefined()
  })
})

describe('diagnostics never change cookie behavior', () => {
  it('getCookieString and stored cookie JSON are identical with or without diagnostics', () => {
    const header = 'sid=abc; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax'
    const jarA = new CookieJar(null, { rejectPublicSuffixes: false })
    const jarB = new CookieJar(null, { rejectPublicSuffixes: false })
    const cookieA = jarA.setCookieSync(header, 'http://example.com/', {
      now: NOW,
    })
    const cookieB = jarB.setCookieSync(header, 'http://example.com/', {
      now: NOW,
      expiryDebug: true,
      serverDate: SERVER_DATE,
    })
    expect(cookieA).toBeInstanceOf(Cookie)
    expect(cookieB).toBeInstanceOf(Cookie)

    expect(cookieB?.cookieString()).toBe(cookieA?.cookieString())
    expect(cookieB?.toString()).toBe(cookieA?.toString())
    expect(cookieB?.toJSON()).toEqual(cookieA?.toJSON())
    // The diagnostic object itself is non-enumerable
    expect(Object.keys(cookieB ?? {})).toEqual(Object.keys(cookieA ?? {}))

    // Serialize before any read, since reads update lastAccessed at wall-clock
    // granularity.
    const serializedA = jarA.serializeSync()
    const serializedB = jarB.serializeSync()
    expect(serializedB).toEqual(serializedA)

    expect(jarB.getCookieStringSync('http://example.com/')).toBe(
      jarA.getCookieStringSync('http://example.com/'),
    )
    expect(jarB.getSetCookieStringsSync('http://example.com/')).toEqual(
      jarA.getSetCookieStringsSync('http://example.com/'),
    )
  })

  it('does not change parsing or expiry semantics', () => {
    const cases = [
      `a=b; Max-Age=60; Expires=${EXPIRES_HEADER}`,
      'a=b; Max-Age=-1',
      'a=b; Expires=xyzzy',
      'a=b; Expires=; Max-Age=12x',
      'a=b; Max-Age=0',
      'plain',
    ]
    for (const str of cases) {
      const without = Cookie.parse(str, { loose: true })
      const withDebug = Cookie.parse(str, { loose: true, expiryDebug: true })
      expect(withDebug).toBeInstanceOf(Cookie)
      expect(without).toBeInstanceOf(Cookie)
      expect(withDebug?.toString()).toBe(without?.toString())
      // creation is wall-clock at construction time, so compare serialization
      // with that single field normalized away.
      const stripCreation = (c: CookieType): Record<string, unknown> => {
        const json = { ...c.toJSON() }
        delete json.creation
        return json
      }
      expect(stripCreation(withDebug as CookieType)).toEqual(
        stripCreation(without as CookieType),
      )
      expect(withDebug?.expiryTime(NOW)).toBe(without?.expiryTime(NOW))
      expect(withDebug?.TTL(NOW_EPOCH)).toBe(without?.TTL(NOW_EPOCH))
      expect(withDebug?.isPersistent()).toBe(without?.isPersistent())
      // Still parses exactly the same (non-debug) attributes
      expect(withDebug?.expires).toEqual(without?.expires)
      expect(withDebug?.maxAge).toBe(without?.maxAge)
    }
  })
})

describe('diagnostic serialization and round-trips', () => {
  it('serializes to plain JSON and survives JSON.stringify', () => {
    const { info } = parseDebug('a=b; Max-Age=60; Expires=bad')
    const json = JSON.stringify(info)
    const reparsed: unknown = JSON.parse(json)
    expect(isExpiryDebugInfo(reparsed)).toBe(true)
    expect(reparsed).toEqual(info)
  })

  it('is preserved through the in-memory store after re-reading', () => {
    const jar = new CookieJar(null, { rejectPublicSuffixes: false })
    const { cookie: stored } = setDebug(jar, 'sid=1; Max-Age=60', {
      serverDate: SERVER_DATE,
    })
    const read = jar.getCookiesSync('http://example.com/')[0]
    expect(read).toBe(stored) // same object reference in the memory store
    expect(read?.getExpiryDebugInfo()).toEqual(stored.getExpiryDebugInfo())
  })

  it('can be reattached via Cookie.fromJSON argument or embedded key', () => {
    const { cookie, info } = parseDebug('a=b; Max-Age=60')
    const json = cookie.toJSON()
    expect(json[EXPIRY_DEBUG_JSON_KEY]).toBeUndefined() // never in cookie JSON

    const restored = Cookie.fromJSON(json, info)
    expect(restored?.getExpiryDebugInfo()).toEqual(info)

    const embedded = { ...json, [EXPIRY_DEBUG_JSON_KEY]: info }
    const restoredEmbedded = Cookie.fromJSON(embedded)
    expect(restoredEmbedded?.getExpiryDebugInfo()).toEqual(info)
  })

  it('preserves diagnostics on clone', () => {
    const { cookie, info } = parseDebug('a=b; Max-Age=60')
    const clone = cookie.clone()
    expect(clone).not.toBe(cookie)
    expect(clone?.getExpiryDebugInfo()).toEqual(info)
  })

  it('is absent from serialized jars', () => {
    const jar = new CookieJar(null, { rejectPublicSuffixes: false })
    setDebug(jar, 'sid=1; Max-Age=60', { serverDate: SERVER_DATE })
    const serialized: SerializedCookieJar | undefined = jar.serializeSync()
    expect(serialized).toBeDefined()
    for (const c of serialized?.cookies ?? []) {
      expect(c[EXPIRY_DEBUG_JSON_KEY]).toBeUndefined()
    }
    // Round-tripping the jar itself keeps behavior identical
    const jar2 = CookieJar.deserializeSync(serialized as SerializedCookieJar)
    expect(jar2.getCookieStringSync('http://example.com/')).toBe(
      jar.getCookieStringSync('http://example.com/'),
    )
  })
})

describe('concurrent updates of the same cookie', () => {
  it('each update carries the diagnostics of its own Set-Cookie', () => {
    const store = new MemoryCookieStore()
    const jar = new CookieJar(store, { rejectPublicSuffixes: false })

    const { cookie: first, info: firstInfo } = setDebug(
      jar,
      'sid=1; Max-Age=60',
      { serverDate: SERVER_DATE },
    )
    const { cookie: second, info: secondInfo } = setDebug(
      jar,
      'sid=2; Max-Age=120; Expires=nope',
      { now: new Date(NOW_EPOCH + 1000) },
    )

    expect(expiryEpoch(firstInfo)).toBe(NOW_EPOCH + 60_000)
    expect(expiryEpoch(secondInfo)).toBe(NOW_EPOCH + 1000 + 120_000)
    expect(secondInfo.dropped).toEqual([
      { attribute: 'expires', raw: 'nope', reason: 'invalid-date' },
    ])
    expect(secondInfo.maxAgeOccurrences).toEqual([
      { raw: '120', deltaSeconds: 120 },
    ])

    const stored = jar.getCookiesSync('http://example.com/')[0]
    expect(stored).toBe(second) // old cookie replaced
    expect(stored?.value).toBe('2')
    expect(stored?.getExpiryDebugInfo()).toEqual(second.getExpiryDebugInfo())
    // RFC step 11.3: creation time is inherited from the old cookie
    expect(stored?.creation).toEqual(first.creation)
  })

  it('an update without diagnostics does not inherit the old cookie diagnostics', () => {
    const jar = new CookieJar(null, { rejectPublicSuffixes: false })
    setDebug(jar, 'sid=1; Max-Age=60')
    const updated = jar.setCookieSync(
      'sid=2; Max-Age=120',
      'http://example.com/',
      { now: NOW },
    )
    expect(updated?.getExpiryDebugInfo()).toBeUndefined()
  })
})

describe('timezone independence', () => {
  // On Node.js (Linux at least), changing process.env.TZ at runtime changes
  // how local Date operations behave until the process exits. It is
  // process-global state, so the previous value is restored.
  const timezones = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']

  function parseInfoInTimezone(tz: string): ExpiryDebugInfo {
    const previousTz = process.env.TZ
    process.env.TZ = tz
    try {
      const jar = new CookieJar(null, { rejectPublicSuffixes: false })
      const cookie = jar.setCookieSync(
        'a=b; Max-Age=60; Expires=Thu, 15 Jan 2026 13:00:00 GMT',
        'http://example.com/',
        {
          now: new Date('2026-01-15T12:00:00.000Z'),
          expiryDebug: true,
          serverDate: 'Thu, 15 Jan 2026 12:05:00 GMT',
        },
      )
      const info = cookie?.getExpiryDebugInfo()
      if (!info) {
        throw new Error('expected expiry debug info to be attached')
      }
      return info
    } finally {
      if (previousTz === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = previousTz
      }
    }
  }

  it('produces identical diagnostics in different timezones', () => {
    const infos = timezones.map((tz) => ({
      tz,
      info: parseInfoInTimezone(tz),
    }))
    for (const { tz, info } of infos.slice(1)) {
      expect(info, `timezone ${tz}`).toEqual(infos[0]?.info)
    }
    const utc = infos[0]?.info
    // Every instant is rendered as an absolute UTC instant
    expect(utc?.localNow.iso).toBe('2026-01-15T12:00:00.000Z')
    expect(utc?.serverDate?.iso).toBe('2026-01-15T12:05:00.000Z')
    expect(utc?.expiry?.iso).toBe('2026-01-15T12:01:00.000Z')
    expect(utc?.correctedExpiry?.iso).toBe('2026-01-15T12:06:00.000Z')
    expect(utc?.expiresOccurrences[0]?.parsed?.iso).toBe(
      '2026-01-15T13:00:00.000Z',
    )
  })
})
