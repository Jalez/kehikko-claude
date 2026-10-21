/**
 * The shapes Claude Code writes into a conversation's transcript, copied from real transcripts
 * (2.1.282–2.1.306) with everything but the shape taken out: no conversation, no paths, no
 * commands. See the table at the top of cutoff.ts.
 */
export const T0 = Date.parse('2026-10-21T17:30:00.000Z')
const iso = (at: number) => new Date(at).toISOString()
let n = 0

/** A task notification as the conversation's own row (`origin.kind: task-notification`). */
export function notified(at: number, status: string, summary: string, ids: string[] = ['bx70mowdy'], more: Record<string, unknown> = {}): string {
  n += 1
  const blocks = `<task-notification>\n${ids.map((id) => `<task-id>${id}</task-id>\n`).join('')}<output-file>/tmp/x</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n<note>…</note>\n</task-notification>`
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: blocks },
    uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    timestamp: iso(at),
    permissionMode: 'auto',
    origin: { kind: 'task-notification' },
    promptSource: 'system',
    queueSkipAttachments: true,
    userType: 'external',
    entrypoint: 'cli',
    sessionId: '11111111-1111-4111-8111-111111111111',
    version: '2.1.306',
    ...more,
  })
}

/** The same text a moment before, as the queue writes it: not a row of the conversation. */
export const queued = (at: number, summary: string) =>
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(at), sessionId: '11111111-1111-4111-8111-111111111111', content: `<task-notification>\n<status>stopped</status>\n<summary>${summary}</summary>\n</task-notification>` })

/** A prompt the person typed. */
export const typed = (at: number, text = 'carry on') =>
  JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text }, timestamp: iso(at), origin: { kind: 'human' }, promptSource: 'typed', userType: 'external' })

export const toolResult = (at: number) =>
  JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] }, timestamp: iso(at) })
export const asked = (at: number, stop: 'tool_use' | 'end_turn') =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: '…' }], stop_reason: stop }, timestamp: iso(at) })
export const turnEnded = (at: number) => JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: iso(at) })

export const SHELL_CUT = "Background shell command didn't finish before the previous session ended"
/** The live example: the very interruption this was built in. */
export const AGENT_CUT = 'Background agent "Claude: Inbox alert for interrupted work" didn\'t finish before the previous session ended'
export const FAILED = 'Background command "bun test" failed with exit code 1'

