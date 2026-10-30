/**
 * The status line this module prints in a session it started when the person has no status line of
 * their own (`statusline.sh` runs it; "Status line in sessions" in settings.ts turns it off):
 *
 *     ctx 42% · week 62% (resets Mon 09:00) · 5h 18% · Opus 5.5
 *
 * The same figures the footer shows, from the same JSON Claude Code gives a status line command:
 * `context_window.used_percentage` (meter.ts) and `rate_limits` (usage.ts), and the model's own
 * name. One line. Too wide for the terminal (`COLUMNS`, which Claude Code sets for the command), the
 * model goes first, then the reset times, then whole parts from the right. Colour only beside the words that say the
 * same ("near limit", "at limit", "limit reached"); none at all under `NO_COLOR`.
 *
 * Plain JavaScript, no imports beyond Node's own, so that whichever runtime serves this module —
 * Bun or Node — can run it from the session's plugin folder. Its types are in `statusline-line.d.mts`.
 *
 *   <runtime> statusline-line.mjs   (the JSON on stdin; prints the line, or nothing)
 */

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* The footer's levels (usage.ts `NEAR`, `AT`). */
export const NEAR = 80
export const AT = 95
/** What the footer row leaves of the terminal's width beside the line (Claude Code's own margins). */
export const MARGIN = 4
/** A width to assume when Claude Code says none. */
export const WIDE = 120

const SEP = ' · '
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const AMBER = '\u001b[33m'
const RED = '\u001b[31m'
const RESET = '\u001b[39m'

const two = (n) => String(n).padStart(2, '0')
const hhmm = (date) => `${two(date.getHours())}:${two(date.getMinutes())}`

/** When a window resets, as the footer says it (usage.ts `resetSaid`): `14:30` today, else `Mon 09:00`. */
export function resetSaid(resets, now) {
  const at = new Date(resets)
  return at.toDateString() === new Date(now).toDateString() ? hhmm(at) : `${DAYS[at.getDay()]} ${hhmm(at)}`
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const pct = (used) => `${Math.floor(Math.min(100, Math.max(0, used)))}%`

/** A window of `rate_limits` that is still live, as numbers; null for anything else. */
function windowOf(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!finite(raw.used_percentage) || raw.used_percentage < 0) return null
  if (!finite(raw.resets_at) || raw.resets_at <= 0) return null
  const resets = Math.round(raw.resets_at * 1000)
  return resets > now ? { used: raw.used_percentage, resets } : null
}

/** The word a share near or at its limit is said with, and its colour; null below `NEAR`. */
function warning(used) {
  if (used >= AT) return { word: used >= 100 ? 'limit reached' : 'at limit', colour: RED }
  if (used >= NEAR) return { word: 'near limit', colour: AMBER }
  return null
}

/** A name, as text: control characters gone, at most `most` characters. */
function text(value, most) {
  if (typeof value !== 'string') return null
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, most) : null
}

/**
 * The parts of the line, left to right in the order they are kept: each a `full` and a `short`
 * form, as plain text and as printed (with colour).
 */
export function parts(json, now) {
  /* The model is `extra`: shown only when everything else fits in full. */
  const said = json && typeof json === 'object' && !Array.isArray(json) ? json : {}
  const out = []
  const window = said.context_window && typeof said.context_window === 'object' ? said.context_window : {}
  if (finite(window.used_percentage)) {
    const plain = `ctx ${pct(window.used_percentage)}`
    out.push({ full: plain, short: plain })
  }
  const limits = said.rate_limits && typeof said.rate_limits === 'object' ? said.rate_limits : {}
  for (const [name, raw] of [['week', limits.seven_day], ['5h', limits.five_hour]]) {
    const one = windowOf(raw, now)
    if (!one) continue
    const warn = warning(one.used)
    const head = `${name} ${pct(one.used)}${warn ? ` ${warn.word}` : ''}`
    /* The week's reset always, as the footer says it; the five hours' only when it is near its limit. */
    const full = name === 'week' || warn ? `${head} (resets ${resetSaid(one.resets, now)})` : head
    out.push({ full, short: head, colour: warn?.colour })
  }
  const model = said.model && typeof said.model === 'object' ? text(said.model.display_name, 24) : null
  if (model) out.push({ full: model, short: model, extra: true })
  return out
}

/** Visible width: one column a character (what is printed here is ASCII, a middle dot and the model's name). */
const width = (plain) => [...plain].length

/**
 * The line, for a terminal `columns` wide (null: unknown). `colour: false` for none. Empty when the
 * JSON says nothing worth a line.
 */
export function compose(json, { columns = null, now = Date.now(), colour = true } = {}) {
  const all = parts(json, now)
  if (all.length === 0) return ''
  const room = Math.max(10, (finite(columns) && columns > 0 ? Math.floor(columns) : WIDE) - MARGIN)
  /* What is tried, in order: everything in full; then without the model, the figures in full and
     then short, one part fewer from the right each time. */
  const core = all.some((one) => !one.extra) ? all.filter((one) => !one.extra) : all
  const tries = [{ kept: all, form: 'full' }]
  for (let n = core.length; n >= 1; n--) for (const form of ['full', 'short']) tries.push({ kept: core.slice(0, n), form })
  /* Nothing fits: the first part, short, and Claude Code cuts what is left over. */
  const pick = tries.find((one) => width(one.kept.map((part) => part[one.form]).join(SEP)) <= room) ?? { kept: core.slice(0, 1), form: 'short' }
  return pick.kept.map((one) => (colour && one.colour ? `${one.colour}${one[pick.form]}${RESET}` : one[pick.form])).join(SEP)
}

/** Run as the status line: the JSON on stdin, the line on stdout. Any failure prints nothing. */
function main() {
  let json = null
  try {
    json = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return
  }
  const columns = Number.parseInt(process.env.COLUMNS ?? '', 10)
  const line = compose(json, { columns: Number.isFinite(columns) ? columns : null, colour: !process.env.NO_COLOR })
  if (line) process.stdout.write(`${line}\n`)
}

/* Run, not imported (a test imports it): the script Node or Bun was asked to run is this file. */
const run = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (run) main()
