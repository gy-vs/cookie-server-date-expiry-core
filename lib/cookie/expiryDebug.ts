/*!
 * Copyright (c) 2026, Salesforce.com, Inc.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 * this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 * this list of conditions and the following disclaimer in the documentation
 * and/or other materials provided with the distribution.
 *
 * 3. Neither the name of Salesforce.com nor the names of its contributors may
 * be used to endorse or promote products derived from this software without
 * specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */
import type { Cookie } from './cookie.js'
import { parseDate } from './parseDate.js'

/**
 * An absolute instant rendered in two equivalent, JSON-friendly forms.
 * Both forms are absolute (UTC) and therefore identical on machines in any
 * timezone, which makes them safe to compare across hosts or put in logs.
 *
 * @public
 */
export interface ExpiryDebugInstant {
  /**
   * Milliseconds since the Unix epoch, as returned by `Date.getTime()`.
   */
  epochMs: number
  /**
   * The same instant in UTC ISO-8601 form (always ending in `Z`), as returned
   * by `Date.toISOString()`.
   */
  iso: string
}

/**
 * One occurrence of an `Expires` attribute in the original `Set-Cookie`
 * string. The RFC says the last such attribute wins, so a cookie may carry
 * several occurrences.
 *
 * @public
 */
export interface ExpiresDebugOccurrence {
  /**
   * The exact text following `Expires=`, with no normalization. `null` when
   * the attribute appeared without a value (e.g. a bare `; Expires`).
   */
  raw: string | null
  /**
   * The result of parsing `raw` per RFC6265 section 5.1.1. `null` means the
   * value could not be parsed as a cookie date and the attribute was ignored.
   */
  parsed: ExpiryDebugInstant | null
}

/**
 * One occurrence of a `Max-Age` attribute in the original `Set-Cookie`
 * string. The RFC says the last such attribute wins, so a cookie may carry
 * several occurrences.
 *
 * @public
 */
export interface MaxAgeDebugOccurrence {
  /**
   * The exact text following `Max-Age=`, with no normalization. `null` when
   * the attribute appeared without a value.
   */
  raw: string | null
  /**
   * The parsed delta-seconds value. `null` means the value was not a valid
   * (optionally signed) integer and the attribute was ignored.
   */
  deltaSeconds: number | null
}

/**
 * An expiry-related attribute that appeared in the `Set-Cookie` string but
 * was ignored because it was invalid.
 *
 * @public
 */
export type DroppedExpiryAttribute =
  | {
      attribute: 'expires'
      raw: string | null
      reason: 'empty' | 'invalid-date'
    }
  | {
      attribute: 'max-age'
      raw: string | null
      reason: 'empty' | 'invalid-integer'
    }

/**
 * Which attribute ultimately determined the expiry of the cookie.
 *
 * @public
 */
export type ExpirySource = 'max-age' | 'expires' | 'session'

/**
 * Human-readable, JSON-serializable diagnostic information describing how a
 * cookie's expiry was derived.
 *
 * @remarks
 * This object is produced only when the caller explicitly asks for it (via
 * the `expiryDebug` option of {@link Cookie.parse} or the `setCookie` method
 * of {@link CookieJar}). It is never sent in a cookie header and is
 * never included in {@link Cookie.toJSON}; retrieving it has no effect on
 * cookie storage or matching behavior.
 *
 * Every timestamp appears both as epoch milliseconds and a UTC ISO string, so
 * the information is identical regardless of the machine's local timezone.
 *
 * Note that tough-cookie does not adjust cookies for clock skew: the
 * `clockSkewMs` and `correctedExpiry*` fields are reported for diagnostic
 * purposes only; `expiry` is always the value actually enforced.
 *
 * @public
 */
export interface ExpiryDebugInfo {
  /**
   * Schema version of this object, currently always `1`.
   */
  version: 1
  /**
   * Which attribute determined {@link ExpiryDebugInfo.expiry}: `max-age`
   * (Max-Age always wins over Expires), `expires`, or `session` for a cookie
   * with no expiry attribute.
   */
  source: ExpirySource
  /**
   * Every `Expires` attribute seen while parsing, in the order in which they
   * appeared. The last parseable one is applied to the cookie.
   */
  expiresOccurrences: ExpiresDebugOccurrence[]
  /**
   * Every `Max-Age` attribute seen while parsing, in the order in which they
   * appeared. The last valid one is applied to the cookie.
   */
  maxAgeOccurrences: MaxAgeDebugOccurrence[]
  /**
   * Expiry attributes that were seen but ignored because their values were
   * missing or invalid, in parse order.
   */
  dropped: DroppedExpiryAttribute[]
  /**
   * The local clock value used as "now": the base from which Max-Age is
   * counted and against which clock skew is measured.
   */
  localNow: ExpiryDebugInstant
  /**
   * The raw value of the HTTP `Date` response header passed via the
   * `serverDate` option, or `null` when none was provided.
   */
  serverDateRaw: string | null
  /**
   * The parsed response `Date` header. `null` when it was absent or could not
   * be parsed as an HTTP date.
   */
  serverDate: ExpiryDebugInstant | null
  /**
   * `serverDate - localNow` in milliseconds: `null` without a parseable
   * server date; a positive value means the local clock is behind the
   * server's clock.
   */
  clockSkewMs: number | null
  /**
   * The expiry that tough-cookie actually enforces: `null` for a session
   * cookie, the epoch (see {@link ExpiryDebugInfo.expiryImmediate}) for an
   * already-expired cookie, otherwise the absolute expiry instant.
   */
  expiry: ExpiryDebugInstant | null
  /**
   * `true` when Max-Age was zero or negative (the "earliest representable
   * date" case), meaning the cookie expires immediately.
   */
  expiryImmediate: boolean
  /**
   * `true` when the cookie effectively never expires (an infinite Max-Age).
   */
  expiryInfinite: boolean
  /**
   * What the expiry would be if the response `Date` header was trusted as the
   * correct current time. This is never applied by tough-cookie; it is
   * reported only to help diagnose clock-skew problems. `null` when it cannot
   * be computed (no parseable server date or a session cookie).
   */
  correctedExpiry: ExpiryDebugInstant | null
  /**
   * Corrected counterpart of {@link ExpiryDebugInfo.expiryImmediate}, or
   * `null` when no corrected expiry can be computed.
   */
  correctedExpiryImmediate: boolean | null
  /**
   * Corrected counterpart of {@link ExpiryDebugInfo.expiryInfinite}, or
   * `null` when no corrected expiry can be computed.
   */
  correctedExpiryInfinite: boolean | null
}

interface ExpiresOccurrenceRecord {
  raw: string | null
  date: Date | null
}

interface MaxAgeOccurrenceRecord {
  raw: string | null
  delta: number | null
}

/**
 * Accumulated, pre-finalization parse state. Held on the cookie as a
 * non-enumerable symbol so {@link CookieJar.setCookie} can re-finalize the
 * information once the request context (now, server Date) is known.
 */
interface ParseDebugState {
  expiresOccurrences: ExpiresOccurrenceRecord[]
  maxAgeOccurrences: MaxAgeOccurrenceRecord[]
  dropped: DroppedExpiryAttribute[]
}

const parseDebugStateSymbol = Symbol('tough-cookie:expiryDebugState')
const expiryDebugInfoSymbol = Symbol('tough-cookie:expiryDebugInfo')

const MAX_AGE_INTEGER = /^-?[0-9]+$/

/**
 * Well-known JSON key under which {@link ExpiryDebugInfo} may be embedded when
 * persisting cookies through a custom store, enabling {@link Cookie.fromJSON}
 * to reattach it automatically.
 *
 * @public
 */
export const EXPIRY_DEBUG_JSON_KEY = 'expiryDebug' as const

function defineHidden(target: object, symbol: symbol, value: unknown): void {
  Object.defineProperty(target, symbol, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  })
}

function readHidden(target: object, symbol: symbol): unknown {
  return (target as unknown as Record<symbol, unknown>)[symbol]
}

function toInstant(date: Date): ExpiryDebugInstant {
  return {
    epochMs: date.getTime(),
    iso: date.toISOString(),
  }
}

/**
 * Creates the accumulator used while parsing a `Set-Cookie` string with
 * expiry diagnostics enabled.
 *
 * @internal
 */
export function createExpiryDebugState(): ParseDebugState {
  return {
    expiresOccurrences: [],
    maxAgeOccurrences: [],
    dropped: [],
  }
}

/**
 * Records one `Expires` attribute occurrence while parsing. Mirrors the
 * acceptance logic of RFC6265 section 5.2.1 exactly.
 *
 * @internal
 */
export function recordExpiresOccurrence(
  state: ParseDebugState,
  raw: string | null,
): void {
  const date = raw ? (parseDate(raw) ?? null) : null
  state.expiresOccurrences.push({ raw, date })
  if (!raw) {
    state.dropped.push({ attribute: 'expires', raw, reason: 'empty' })
  } else if (!date) {
    state.dropped.push({
      attribute: 'expires',
      raw,
      reason: 'invalid-date',
    })
  }
}

/**
 * Records one `Max-Age` attribute occurrence while parsing and returns the
 * parsed delta-seconds (or `null` when invalid). Mirrors the acceptance logic
 * of RFC6265 section 5.2.2 exactly.
 *
 * @internal
 */
export function recordMaxAgeOccurrence(
  state: ParseDebugState,
  raw: string | null,
): number | null {
  let delta: number | null = null
  if (raw && MAX_AGE_INTEGER.test(raw)) {
    delta = parseInt(raw, 10)
  }
  state.maxAgeOccurrences.push({ raw, delta })
  if (!raw) {
    state.dropped.push({ attribute: 'max-age', raw, reason: 'empty' })
  } else if (delta === null) {
    state.dropped.push({
      attribute: 'max-age',
      raw,
      reason: 'invalid-integer',
    })
  }
  return delta
}

/** @internal */
export function attachParseDebugState(
  cookie: Cookie,
  state: ParseDebugState,
): void {
  defineHidden(cookie, parseDebugStateSymbol, state)
}

/** @internal */
export function getParseDebugState(
  cookie: Cookie,
): ParseDebugState | undefined {
  const state = readHidden(cookie, parseDebugStateSymbol)
  return state ? (state as ParseDebugState) : undefined
}

/**
 * Attaches finalized diagnostic information to a cookie. The property is
 * non-enumerable and therefore invisible to JSON serialization, `for...in`,
 * property enumeration, and deep-equality checks.
 *
 * @internal
 */
export function attachExpiryDebugInfo(
  cookie: Cookie,
  info: ExpiryDebugInfo,
): void {
  defineHidden(cookie, expiryDebugInfoSymbol, info)
}

/**
 * Returns the finalized diagnostic information previously attached to the
 * cookie, if any.
 *
 * @internal
 */
export function getExpiryDebugInfo(
  cookie: Cookie,
): ExpiryDebugInfo | undefined {
  const info = readHidden(cookie, expiryDebugInfoSymbol)
  return info ? (info as ExpiryDebugInfo) : undefined
}

/**
 * Structural validation for an {@link ExpiryDebugInfo} coming from an
 * untrusted source such as deserialized JSON.
 *
 * @public
 */
export function isExpiryDebugInfo(value: unknown): value is ExpiryDebugInfo {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    candidate.version === 1 &&
    (candidate.source === 'max-age' ||
      candidate.source === 'expires' ||
      candidate.source === 'session') &&
    Array.isArray(candidate.expiresOccurrences) &&
    Array.isArray(candidate.maxAgeOccurrences) &&
    Array.isArray(candidate.dropped) &&
    typeof candidate.localNow === 'object' &&
    candidate.localNow !== null
  )
}

interface ComputedExpiry {
  source: ExpirySource
  epoch: number | null
  immediate: boolean
  infinite: boolean
}

/**
 * Replicates {@link Cookie.expiryTime} exactly, including its handling of the
 * serialized `'Infinity'`/`'-Infinity'` Max-Age strings (non-numeric Max-Age
 * is treated as -Infinity there).
 */
function computeExpiry(cookie: Cookie, base: Date): ComputedExpiry {
  if (cookie.maxAge != null) {
    // A serialized 'Infinity' Max-Age (or numeric Infinity) never expires; a
    // serialized '-Infinity' (and any other non-number) expires immediately.
    if (cookie.maxAge === 'Infinity' || cookie.maxAge === Infinity) {
      return {
        source: 'max-age',
        epoch: null,
        immediate: false,
        infinite: true,
      }
    }
    const seconds =
      typeof cookie.maxAge === 'number' ? cookie.maxAge : -Infinity
    if (!Number.isFinite(seconds)) {
      return {
        source: 'max-age',
        epoch: 0,
        immediate: true,
        infinite: false,
      }
    }
    if (seconds <= 0) {
      return {
        source: 'max-age',
        epoch: 0,
        immediate: true,
        infinite: false,
      }
    }
    if (!Number.isFinite(base.getTime())) {
      return {
        source: 'max-age',
        epoch: null,
        immediate: false,
        infinite: true,
      }
    }
    return {
      source: 'max-age',
      epoch: base.getTime() + seconds * 1000,
      immediate: false,
      infinite: false,
    }
  }

  if (cookie.expires instanceof Date) {
    return {
      source: 'expires',
      epoch: cookie.expires.getTime(),
      immediate: false,
      infinite: false,
    }
  }

  return { source: 'session', epoch: null, immediate: false, infinite: false }
}

function emptyDebugState(): ParseDebugState {
  // A Cookie object (rather than a parsed string) reached setCookie(): the
  // original attribute text is unavailable, so occurrences are reported as
  // empty lists and the source is derived from the parsed fields instead.
  return {
    expiresOccurrences: [],
    maxAgeOccurrences: [],
    dropped: [],
  }
}

/**
 * Builds (and attaches) the finalized {@link ExpiryDebugInfo} for a cookie.
 *
 * @internal
 */
export function finalizeExpiryDebug(
  cookie: Cookie,
  options: { now: Date; serverDate?: string | Date | null | undefined },
): ExpiryDebugInfo {
  const state = getParseDebugState(cookie) ?? emptyDebugState()
  const { now } = options

  let serverDateRaw: string | null = null
  let serverDate: Date | null = null
  if (typeof options.serverDate === 'string') {
    serverDateRaw = options.serverDate
    serverDate = parseDate(options.serverDate) ?? null
  } else if (options.serverDate instanceof Date) {
    serverDate = Number.isNaN(options.serverDate.getTime())
      ? null
      : options.serverDate
  }

  const clockSkewMs = serverDate ? serverDate.getTime() - now.getTime() : null

  const actual = computeExpiry(cookie, now)

  let correctedExpiry: ExpiryDebugInstant | null = null
  let correctedExpiryImmediate: boolean | null = null
  let correctedExpiryInfinite: boolean | null = null
  if (serverDate && clockSkewMs != null) {
    if (actual.infinite) {
      correctedExpiry = null
      correctedExpiryImmediate = false
      correctedExpiryInfinite = true
    } else if (actual.immediate) {
      correctedExpiry = toInstant(new Date(0))
      correctedExpiryImmediate = true
      correctedExpiryInfinite = false
    } else if (actual.epoch != null) {
      correctedExpiry = toInstant(new Date(actual.epoch + clockSkewMs))
      correctedExpiryImmediate = false
      correctedExpiryInfinite = false
    }
  }

  const info: ExpiryDebugInfo = {
    version: 1,
    source: actual.source,
    expiresOccurrences: state.expiresOccurrences.map((occurrence) => ({
      raw: occurrence.raw,
      parsed: occurrence.date ? toInstant(occurrence.date) : null,
    })),
    maxAgeOccurrences: state.maxAgeOccurrences.map((occurrence) => ({
      raw: occurrence.raw,
      deltaSeconds: occurrence.delta,
    })),
    dropped: state.dropped.map((entry) => ({ ...entry })),
    localNow: toInstant(now),
    serverDateRaw,
    serverDate: serverDate ? toInstant(serverDate) : null,
    clockSkewMs,
    expiry: actual.epoch != null ? toInstant(new Date(actual.epoch)) : null,
    expiryImmediate: actual.immediate,
    expiryInfinite: actual.infinite,
    correctedExpiry,
    correctedExpiryImmediate,
    correctedExpiryInfinite,
  }

  attachExpiryDebugInfo(cookie, info)
  return info
}
