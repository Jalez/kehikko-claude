/**
 * How much of the person's Claude subscription allowance is used: the rolling five-hour window and
 * the weekly one, as Claude Code itself reports them to a status line command.
 *
 * ## Where the figures come from, and it is the whole list
 *
 * Claude Code's status line JSON (`rate_limits`, documented under "Customize your status line" at
 * code.claude.com/docs/en/statusline, and built in the 2.1.314 binary as
 * `seven_day:{used_percentage:…,resets_at:…}`):
 *
 *     "rate_limits": {
 *       "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
 *       "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
 *     }
 *
 * `used_percentage` runs from 0 to 100; `resets_at` is Unix epoch seconds. It is there only for
 * claude.ai Pro and Max subscribers and only after a session's first API response; each window may
 * be absent on its own, and Claude Code drops a window once its `resets_at` has passed. The same
 * `statusline.sh` that brings the context meter its figures brings these: nothing else is asked,
 * nothing is polled, and no credential is read.
 *
 * ## One allowance, several sessions
 *
 * The allowance is the account's, so every session shows the same, newest figure, kept in this
 * process's memory (never in a project). Sessions report on their own schedules, and an idle one
 * repeats the figure it last had, so a report is believed per window: a later window (its
 * `resets_at` further on) replaces the one held; within the same window the share only grows, so a
 * smaller share is an older report and is passed over.
 */

/** One window of the allowance. */
export interface Window {
  /** 0–100, as Claude Code said it. */
  used: number
  /** Milliseconds. */
  resets: number
  /** When this window's figure was last heard. */
  at: number
}

/** What is known of the allowance; null when nothing is (an API-key login, an older Claude Code, no report yet). */
export interface Limits {
  week: Window | null
  hours: Window | null
}

/** Two `resets_at` of the same window can differ by a little between responses; further apart they are different windows. */
const SAME_WINDOW_MS = 10 * 60_000

function windowOf(raw: unknown, at: number): Window | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const said = raw as Record<string, unknown>
  const used = said.used_percentage
  const resets = said.resets_at
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null
  if (typeof resets !== 'number' || !Number.isFinite(resets) || resets <= 0) return null
  return { used: Math.min(100, used), resets: Math.round(resets * 1000), at }
}

/** The `rate_limits` of one status line report, as far as it is believed: two windows of numbers. Null when it has neither. */
export function readLimits(raw: unknown, at: number): Limits | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const limits = (raw as Record<string, unknown>).rate_limits
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return null
  const said = limits as Record<string, unknown>
  const week = windowOf(said.seven_day, at)
  const hours = windowOf(said.five_hour, at)
  return week || hours ? { week, hours } : null
}

/** A window that has reset says nothing any more. */
const live = (window: Window | null, now: number): Window | null => (window && window.resets > now ? window : null)

function newerWindow(held: Window | null, heard: Window | null, now: number): Window | null {
  const was = live(held, now)
  if (!heard || heard.resets <= now) return was
  if (!was) return heard
  if (heard.resets > was.resets + SAME_WINDOW_MS) return heard
  if (heard.resets < was.resets - SAME_WINDOW_MS) return was
  return heard.used >= was.used ? heard : was
}

/** What is held after one more report (see "One allowance, several sessions"). Null when nothing live is known. */
export function mergeLimits(held: Limits | null, heard: Limits | null, now: number): Limits | null {
  const week = newerWindow(held?.week ?? null, heard?.week ?? null, now)
  const hours = newerWindow(held?.hours ?? null, heard?.hours ?? null, now)
  return week || hours ? { week, hours } : null
}

/** What is held, as it stands at `now`: windows that have reset are left out. */
export function limitsNow(held: Limits | null, now: number): Limits | null {
  return mergeLimits(held, null, now)
}

/* ------------------------------------------------------------------------ *
 * In words
 * ------------------------------------------------------------------------ */

/** From here the share is "near the limit" (amber), and from here "at the limit" (red). */
export const NEAR = 80
export const AT = 95
/** A figure older than this is said with its time. */
export const STALE_MS = 5 * 60_000

export type Level = 'ok' | 'near' | 'at'

export const levelOf = (used: number): Level => (used >= AT ? 'at' : used >= NEAR ? 'near' : 'ok')

const pct = (used: number) => `${Math.floor(used)}%`
const hhmm = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const day = (at: number) => new Date(at).toLocaleDateString('en-GB', { weekday: 'short' })

/** When a window resets, as a person reads it: `14:30` today, else `Mon 09:00`. */
export function resetSaid(resets: number, now: number): string {
  const same = new Date(resets).toDateString() === new Date(now).toDateString()
  return same ? hhmm(resets) : `${day(resets)} ${hhmm(resets)}`
}

const levelWord = (level: Level, used: number): string | null => (level === 'at' ? (used >= 100 ? 'limit reached' : 'at the limit') : level === 'near' ? 'near the limit' : null)

/**
 * The allowance in words, for the footer. `headline` is the weekly window, or the five-hour one when
 * Claude Code said no weekly one. The five-hour one is added to the line when it is near its limit.
 * Null when nothing is known — never a zero.
 */
export function limitsWords(held: Limits | null, now: number): {
  /** The window the line is about. */
  which: 'week' | 'hours'
  used: number
  level: Level
  /** `Week 62% · resets Mon 09:00`, with `near the limit` and `as of 14:02` where they apply. */
  full: string
  /** `W 62%`. */
  short: string
  /** `as of 14:02` when the figure is older than `STALE_MS`, else null. */
  stale: string | null
  /** The five-hour window, when it is near its limit and is not the headline: `5h 91%`. */
  hoursNear: string | null
  /** Everything, for the tooltip. */
  title: string
} | null {
  const limits = limitsNow(held, now)
  if (!limits) return null
  const which = limits.week ? 'week' : 'hours'
  const head = (limits.week ?? limits.hours)!
  const level = levelOf(head.used)
  const at = Math.max(limits.week?.at ?? 0, limits.hours?.at ?? 0)
  const stale = now - at > STALE_MS ? `as of ${hhmm(at)}` : null
  const name = which === 'week' ? 'Week' : '5h'
  const warn = levelWord(level, head.used)
  const hoursNear = which === 'week' && limits.hours && levelOf(limits.hours.used) !== 'ok' ? `5h ${pct(limits.hours.used)}` : null
  const full = [`${name} ${pct(head.used)}${warn ? ` — ${warn}` : ''}`, `resets ${resetSaid(head.resets, now)}`, stale].filter(Boolean).join(' · ')
  const short = `${which === 'week' ? 'W' : '5h'} ${pct(head.used)}`
  const line = (label: string, window: Window | null) => {
    if (!window) return `${label}: not reported`
    const word = levelWord(levelOf(window.used), window.used)
    return `${label}: ${pct(window.used)} used${word ? ` (${word})` : ''}, resets ${resetSaid(window.resets, now)}`
  }
  const title = [
    'Claude subscription usage',
    line('This week', limits.week),
    line('5-hour session', limits.hours),
    `As Claude Code last reported it, at ${hhmm(at)}, in a session's status line. The allowance is the account's: every session shows the newest figure.`,
  ].join('\n')
  return { which, used: head.used, level, full, short, stale, hoursNear, title }
}
