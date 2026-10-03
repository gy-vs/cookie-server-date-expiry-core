import type { Cookie } from './cookie.js'

/**
 * An `Expires` or `Max-Age` attribute that was ignored while parsing a
 * `Set-Cookie` string because its value was not valid.
 *
 * @public
 */
export interface DroppedExpiryAttribute {
  /**
   * The lower-cased attribute name (`'expires'` or `'max-age'`).
   */
  name: 'expires' | 'max-age'
  /**
   * The raw attribute value as it appeared in the `Set-Cookie` string, or
   * `null` if the attribute had no value at all (e.g. `Expires` without `=`).
   */
  value: string | null
  /**
   * Why the attribute was ignored:
   *
   * - `'empty-value'` - the attribute had no value (e.g. `Expires=` or a bare `Max-Age`)
   * - `'invalid-date'` - the `Expires` value could not be parsed as a cookie date
   * - `'invalid-integer'` - the `Max-Age` value was not a (optionally negative) integer
   */
  reason: 'empty-value' | 'invalid-date' | 'invalid-integer'
}

/**
 * Diagnostics explaining how the expiry of a {@link Cookie} was determined.
 *
 * @remarks
 * This is a debugging aid: it captures the raw `Expires`/`Max-Age` attributes
 * as received, what they parsed to, the clock readings used when the cookie
 * was stored (including any server-time correction supplied via
 * {@link SetCookieOptions.now}), which attribute ended up deciding the expiry,
 * and the final expiry time that was derived.
 *
 * All timestamps are ISO-8601 strings in UTC (`Date.toISOString()`), so the
 * same `Set-Cookie` string produces the same values regardless of the local
 * timezone of the machine that parsed it. The object contains only plain
 * JSON-safe values (strings, numbers, `null`, and arrays thereof) so it can
 * be logged with `JSON.stringify`.
 *
 * The information is a snapshot of the parse and store operations; later
 * mutations of the cookie (e.g. calling {@link Cookie.setMaxAge}) are not
 * reflected.
 *
 * @public
 */
export interface CookieExpiryInfo {
  /**
   * The raw value of the last `Expires` attribute in the `Set-Cookie` string,
   * or `null` if there was none. Only available when the cookie was parsed
   * from a string with recording enabled.
   */
  rawExpires: string | null
  /**
   * The raw value of the last `Max-Age` attribute in the `Set-Cookie` string,
   * or `null` if there was none. Only available when the cookie was parsed
   * from a string with recording enabled.
   */
  rawMaxAge: string | null
  /**
   * The `Expires` attribute parsed to an absolute time (ISO-8601 UTC), or
   * `null` if there was no valid `Expires` attribute.
   */
  parsedExpires: string | null
  /**
   * The `Max-Age` attribute parsed to a number of seconds, or `null` if there
   * was no valid `Max-Age` attribute. `'Infinity'`/`'-Infinity'` mirror the
   * corresponding {@link Cookie.maxAge} values.
   */
  parsedMaxAge: number | 'Infinity' | '-Infinity' | null
  /**
   * When the `Set-Cookie` string was parsed (ISO-8601 UTC), according to the
   * local clock.
   */
  parsedAt: string
  /**
   * `Expires`/`Max-Age` attributes that were ignored during parsing because
   * their values were invalid, in the order they were encountered.
   */
  droppedAttributes: DroppedExpiryAttribute[]
  /**
   * The date used as "now" when the cookie was stored in a {@link CookieJar}
   * (ISO-8601 UTC). This is {@link SetCookieOptions.now} when that option is
   * used (e.g. to pass the server response's `Date` header), otherwise it is
   * the local clock. `null` if the cookie was never stored with recording
   * enabled.
   */
  storedAt: string | null
  /**
   * The local machine clock reading taken when the cookie was stored
   * (ISO-8601 UTC). `null` if the cookie was never stored with recording
   * enabled.
   */
  localClockAt: string | null
  /**
   * {@link CookieExpiryInfo.storedAt} minus {@link CookieExpiryInfo.localClockAt}
   * in milliseconds: the server-time correction that was applied when storing
   * the cookie. A large absolute value indicates the local clock disagrees
   * with the server clock. `null` if the cookie was never stored with
   * recording enabled.
   */
  clockSkewMs: number | null
  /**
   * Which attribute determined the final expiry:
   *
   * - `'max-age'` - a valid `Max-Age` attribute was present (it takes
   *   precedence over `Expires`, per RFC6265 S4.1.2.2)
   * - `'expires'` - no valid `Max-Age`, but a valid `Expires` attribute
   * - `'session'` - neither attribute was valid; the cookie is a session cookie
   */
  decidedBy: 'max-age' | 'expires' | 'session'
  /**
   * The final expiry time derived from the above (ISO-8601 UTC). For
   * `Max-Age` cookies this is computed against {@link CookieExpiryInfo.storedAt}
   * (or {@link CookieExpiryInfo.parsedAt} if the cookie was never stored).
   * `null` for session cookies and for values outside the representable
   * `Date` range. A `Max-Age` of zero or less yields the epoch
   * (`1970-01-01T00:00:00.000Z`), mirroring {@link Cookie.expiryDate}.
   */
  expiresAt: string | null
}

/**
 * The recorded facts about a cookie's expiry, captured while parsing and
 * storing. Kept internal; the public, JSON-safe view is produced by
 * {@link buildCookieExpiryInfo}.
 *
 * @internal
 */
export interface ExpiryInfoRecord {
  rawExpires: string | null
  rawMaxAge: string | null
  parsedExpires: Date | null
  parsedMaxAge: number | 'Infinity' | '-Infinity' | null
  parsedAtMs: number
  droppedAttributes: DroppedExpiryAttribute[]
  storedAt: Date | null
  localClockAtMs: number | null
}

/*
 * Records are kept in a WeakMap (rather than a property on the Cookie) so
 * that enabling diagnostics cannot change anything observable about the
 * cookie itself: its enumerable properties, serialization, `toString()`,
 * equality checks, and the `Cookie` header it produces are all untouched.
 */
const expiryInfoRecords = new WeakMap<Cookie, ExpiryInfoRecord>()

/**
 * Start recording expiry diagnostics for a cookie. Called by {@link Cookie.parse}
 * and {@link CookieJar.setCookie} when their `recordExpiryInfo` option is enabled.
 *
 * @internal
 */
export function createExpiryInfoRecord(cookie: Cookie): ExpiryInfoRecord {
  const record: ExpiryInfoRecord = {
    rawExpires: null,
    rawMaxAge: null,
    parsedExpires: null,
    parsedMaxAge: null,
    parsedAtMs: Date.now(),
    droppedAttributes: [],
    storedAt: null,
    localClockAtMs: null,
  }
  expiryInfoRecords.set(cookie, record)
  return record
}

/**
 * Get the diagnostics record for a cookie, if recording was enabled for it.
 *
 * @internal
 */
export function getExpiryInfoRecord(
  cookie: Cookie,
): ExpiryInfoRecord | undefined {
  return expiryInfoRecords.get(cookie)
}

/**
 * Snapshot the parsed expiry attributes from the cookie's current state.
 * Called once parsing has finished (or when a cookie object is stored
 * directly) so the record reflects what the attributes resolved to.
 *
 * @internal
 */
export function snapshotParsedExpiry(
  cookie: Cookie,
  record: ExpiryInfoRecord,
): void {
  record.parsedExpires = cookie.expires instanceof Date ? cookie.expires : null
  record.parsedMaxAge = cookie.maxAge
}

/**
 * Record the clock readings used when a cookie is stored in a jar. Sticky:
 * if the cookie already has a record (e.g. it was parsed with recording
 * enabled) the store-time readings are added even if `enabled` is false.
 *
 * @internal
 */
export function recordStoreClock(
  cookie: Cookie,
  now: Date,
  enabled: boolean,
): void {
  let record = getExpiryInfoRecord(cookie)
  if (!record) {
    if (!enabled) {
      return
    }
    record = createExpiryInfoRecord(cookie)
    snapshotParsedExpiry(cookie, record)
  }
  // Copy the date so later mutations of the `now` object don't rewrite history.
  record.storedAt = new Date(now.getTime())
  record.localClockAtMs = Date.now()
}

// The maximum absolute value of a Date's time value (ECMA-262 S21.4.1.1).
const MAX_DATE_TIME = 8.64e15

function toISOStringOrNull(date: Date | null): string | null {
  if (date == null || !Number.isFinite(date.getTime())) {
    return null
  }
  return date.toISOString()
}

function epochMsToISOStringOrNull(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < -MAX_DATE_TIME || ms > MAX_DATE_TIME) {
    return null
  }
  return new Date(ms).toISOString()
}

/**
 * Shape a diagnostics record into the public, JSON-safe view.
 *
 * @internal
 */
export function buildCookieExpiryInfo(
  record: ExpiryInfoRecord,
): CookieExpiryInfo {
  const storedAtMs =
    record.storedAt && Number.isFinite(record.storedAt.getTime())
      ? record.storedAt.getTime()
      : null

  let decidedBy: CookieExpiryInfo['decidedBy']
  let expiresAt: string | null
  if (record.parsedMaxAge != null) {
    decidedBy = 'max-age'
    // Mirror Cookie.expiryTime(): a non-numeric maxAge is treated as
    // -Infinity, and a maxAge <= 0 means "the earliest representable date".
    const maxAge =
      typeof record.parsedMaxAge === 'number' ? record.parsedMaxAge : -Infinity
    const ageMs = maxAge <= 0 ? -Infinity : maxAge * 1000
    const basisMs = storedAtMs ?? record.parsedAtMs
    const expiryMs = basisMs + ageMs
    expiresAt =
      expiryMs === -Infinity
        ? new Date(0).toISOString()
        : epochMsToISOStringOrNull(expiryMs)
  } else if (record.parsedExpires != null) {
    decidedBy = 'expires'
    expiresAt = toISOStringOrNull(record.parsedExpires)
  } else {
    decidedBy = 'session'
    expiresAt = null
  }

  return {
    rawExpires: record.rawExpires,
    rawMaxAge: record.rawMaxAge,
    parsedExpires: toISOStringOrNull(record.parsedExpires),
    parsedMaxAge: record.parsedMaxAge,
    parsedAt: new Date(record.parsedAtMs).toISOString(),
    droppedAttributes: record.droppedAttributes.map((dropped) => ({
      ...dropped,
    })),
    storedAt: toISOStringOrNull(record.storedAt),
    localClockAt:
      record.localClockAtMs == null
        ? null
        : new Date(record.localClockAtMs).toISOString(),
    clockSkewMs:
      storedAtMs != null && record.localClockAtMs != null
        ? storedAtMs - record.localClockAtMs
        : null,
    decidedBy,
    expiresAt,
  }
}
