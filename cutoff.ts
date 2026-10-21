/**
 * What a conversation's own record says about its background work: the tasks that were cut off
 * or failed, whether the person has moved on since, and whether its last turn ended.
 *
 * ## What is read, and it is the whole list
 *
 * Claude Code writes a `<task-notification>` into a conversation's transcript each time one of its
 * background tasks (a shell command run in the background, a background agent) ends — and, when a
 * conversation is opened again after its process exited, one for the tasks that had no completion
 * record. Measured on 2.1.282–2.1.306, in the person's own transcripts (read, never written), a row
 * of this shape, its content one string:
 *
 *     { "type": "user", "isSidechain": false, "origin": { "kind": "task-notification", … },
 *       "promptSource": "system", "uuid": "…", "timestamp": "2026-10-21T17:30:23.993Z",
 *       "message": { "role": "user", "content": "<task-notification>\n<task-id>…</task-id>\n…
 *         <status>stopped</status>\n<summary>…</summary>\n<note>…</note>\n</task-notification>" } }
 *
 * (A `queue-operation` row carries the same text a moment before; it is not read, or each would
 * count twice. Older rows have `isMeta: true` and a preamble above the block.) The status and the
 * summary seen, by what this module makes of them:
 *
 *     stopped    Background shell command didn't finish before the previous session ended          ended
 *     stopped    N background shell command tasks didn't finish before the previous session ended. …   ended
 *     stopped    Background agent "…" didn't finish before the previous session ended                ended
 *     stopped    N background agents didn't finish before the previous session ended: …              ended
 *     failed     Background command "…" failed with exit code N          (N below 128)               failed
 *     failed     Agent "…" failed: Agent stalled: no progress for 600s (…) / terminated early …       failed
 *     killed     Background command "…" was stopped after reaching its background time limit        stopped
 *     killed     Background command "…" was stopped because the system is running low on memory      stopped
 *     killed     Agent "…" was stopped: Auto mode is unavailable: …                                  stopped
 *
 * and what is NOT counted:
 *
 *     completed  Agent "…" finished / Background command "…" completed (exit code N)   a success, whatever N
 *     failed     Background command "…" failed with exit code 143 (130, 137, 144…)    ended by a signal: stopped on purpose
 *     killed     Background command "…" was stopped / Agent "…" was stopped by user / by Claude   stopped on purpose
 *     failed     Monitor "…" script failed (exit N)                                   a watcher, not work
 *     (none)     Background agent "…" was restarted after the previous session ended  it runs again
 *
 * A row inside a subagent's own thread (`isSidechain`) is that agent's business and is not read.
 * Nothing of a notification is kept but its summary line, cut short, to be said back to the person.
 *
 * `claude agents --json` says nothing of any of this: it lists sessions, not their tasks.
 */

/** Which way a task did not finish. */
export type CutKind = 'ended' | 'stopped' | 'failed'

export interface CutOff {
  /** When the notification was written, in milliseconds. */
  at: number
  kind: CutKind
  /** The summary line, unescaped, one line, cut short. */
  summary: string
  /** How many tasks the notification is about (one notification may name several). */
  tasks: number
}

/** How much of a summary is kept. */
export const SUMMARY_CHARS = 90

const one = (text: string, most: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= most ? flat : `${flat.slice(0, most - 1).trimEnd()}…`
}

const unescaped = (text: string): string =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** The status and summary of one `<task-notification>` block, judged: null for what is not counted. */
export function judged(status: string, summary: string): CutKind | null {
  if (/^Monitor\b/.test(summary)) return null
  if (/didn['’]t finish before the previous session ended/.test(summary)) return status === 'stopped' || status === '' ? 'ended' : null
  if (status === 'failed') {
    const code = /failed with exit code (-?\d+)/.exec(summary)
    /* 128 and above is a signal: a command stopped with KillShell or TaskStop ends 143 or 144. */
    if (code && Number(code[1]) >= 128) return null
    return 'failed'
  }
  if (status === 'killed' || status === 'stopped') {
    if (/stopped by (user|Claude)\b/.test(summary)) return null
    if (/was stopped\.?$/.test(summary.trim())) return null
    return 'stopped'
  }
  return null
}

interface Row {
  type?: unknown
  isSidechain?: unknown
  isMeta?: unknown
  origin?: { kind?: unknown } | null
  promptSource?: unknown
  timestamp?: unknown
  message?: { content?: unknown; stop_reason?: unknown } | null
  subtype?: unknown
}

const rows = function* (text: string): Generator<Row> {
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      yield JSON.parse(trimmed) as Row
    } catch {
      /* A tail that began mid-line. */
    }
  }
}

const contentOf = (row: Row): string => {
  const content = row.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part: unknown) => (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : '')).join('')
}

const timeOf = (row: Row): number => (typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN)

const isToolResult = (row: Row): boolean =>
  Array.isArray(row.message?.content) && (row.message!.content as unknown[]).some((part) => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'tool_result')

/** A row that is a task notification of the conversation itself. */
function notification(row: Row): string | null {
  if (row.type !== 'user' || row.isSidechain === true) return null
  const text = contentOf(row)
  if (!text.includes('<task-notification>')) return null
  if (row.origin?.kind !== 'task-notification' && !text.trimStart().startsWith('<task-notification>') && row.isMeta !== true) return null
  return text
}

/** Every background task the transcript (or a tail of it) says was cut off or failed, oldest first. */
export function cutOffs(text: string): CutOff[] {
  const out: CutOff[] = []
  for (const row of rows(text)) {
    const said = notification(row)
    if (said === null) continue
    const at = timeOf(row)
    if (!Number.isFinite(at)) continue
    for (const block of said.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
      const status = /<status>([^<]*)<\/status>/.exec(block)?.[1]?.trim() ?? ''
      const summary = unescaped(/<summary>([\s\S]*?)<\/summary>/.exec(block)?.[1] ?? '')
      const kind = judged(status, one(summary, 400))
      if (!kind) continue
      const ids = [...block.matchAll(/<task-id>([^<]*)<\/task-id>/g)].map((m) => m[1]!.trim()).filter((id) => id && !id.startsWith('__'))
      const counted = /^(\d+) background/.exec(summary.trim())
      out.push({ at, kind, summary: one(summary, SUMMARY_CHARS), tasks: Math.max(1, counted ? Number(counted[1]) : ids.length) })
    }
  }
  return out
}

/**
 * Whether the person said something in the conversation after `after`: a prompt they typed, which
 * is a conversation that has moved on. A task notification, a tool's answer, a meta row and a
 * subagent's thread are not the person; nor is a line of this module's own (`except`).
 */
export function movedOn(text: string, after: number, except: readonly string[] = []): boolean {
  for (const row of rows(text)) {
    if (row.type !== 'user' || row.isSidechain === true || row.isMeta === true || row.promptSource === 'system') continue
    const kind = row.origin?.kind
    if (kind !== undefined && kind !== 'human') continue
    if (isToolResult(row)) continue
    const said = contentOf(row).trim()
    if (!said || said.startsWith('<task-notification>') || except.some((line) => said === line)) continue
    const at = timeOf(row)
    if (Number.isFinite(at) && at > after) return true
  }
  return false
}

/**
 * Whether the conversation's last turn was still under way when its record stopped growing: the
 * last thing in it is a prompt, a tool's answer, or the agent asking for a tool — and not the
 * agent's last word (`end_turn`) or the turn's own closing row (`turn_duration`). What a process
 * that was killed mid-turn leaves behind; one that ended its turn says so.
 */
export function midTurn(text: string): boolean {
  let last: 'open' | 'closed' | null = null
  for (const row of rows(text)) {
    if (row.isSidechain === true) continue
    if (row.type === 'system' && (row.subtype === 'turn_duration' || row.subtype === 'stop_hook_summary')) last = 'closed'
    else if (row.type === 'assistant') {
      const reason = row.message?.stop_reason
      last = reason === 'end_turn' || reason === 'stop_sequence' || reason === 'max_tokens' ? 'closed' : reason === 'tool_use' ? 'open' : last
    } else if (row.type === 'user' && row.isMeta !== true) last = 'open'
  }
  return last === 'open'
}

/** The words for a set of cut-off tasks: the label's tail, and the detail. */
export function cutOffWords(open: readonly CutOff[]): { said: string; detail: string } {
  const count = open.reduce((sum, one) => sum + one.tasks, 0)
  const kinds = new Set(open.map((one) => one.kind))
  const tasks = `${count} background task${count === 1 ? '' : 's'}`
  const said =
    kinds.size === 1 && kinds.has('ended')
      ? `${tasks} didn't finish before the session ended`
      : kinds.size === 1 && kinds.has('failed')
        ? `${tasks} failed`
        : kinds.size === 1 && kinds.has('stopped')
          ? `${tasks} ${count === 1 ? 'was' : 'were'} stopped before finishing`
          : `${tasks} ${count === 1 ? 'was' : 'were'} cut off or failed`
  return { said, detail: open.map((one) => one.summary).join('; ') }
}
