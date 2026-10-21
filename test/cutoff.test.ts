import { describe, expect, test } from 'bun:test'

import { cutOffWords, cutOffs, judged, midTurn, movedOn } from '../cutoff.ts'

import { AGENT_CUT, FAILED, SHELL_CUT, T0, asked, notified, queued, toolResult, turnEnded, typed } from './transcripts.ts'

const iso = (at: number) => new Date(at).toISOString()

describe('what counts as background work cut off or failed', () => {
  test('a background shell command that did not finish before the session ended', () => {
    const found = cutOffs(notified(T0, 'stopped', SHELL_CUT))
    expect(found).toEqual([{ at: T0, kind: 'ended', summary: SHELL_CUT, tasks: 1 }])
  })

  test('a background agent that did not finish (the live example)', () => {
    const found = cutOffs(notified(T0, 'stopped', AGENT_CUT.replace(/"/g, '&quot;')))
    expect(found.length).toBe(1)
    expect(found[0]).toMatchObject({ kind: 'ended', tasks: 1 })
    expect(found[0]!.summary.startsWith('Background agent "Claude: Inbox alert for interrupted work"')).toBe(true)
  })

  test('several in one notification are counted, and an internal scan marker is not a task', () => {
    const shells = cutOffs(notified(T0, 'stopped', "2 background shell command tasks didn't finish before the previous session ended. Task ids: bfzrzigoq, bx70mowdy.", ['bfzrzigoq', 'bx70mowdy', '__orphan_summary__:shell']))
    expect(shells[0]).toMatchObject({ kind: 'ended', tasks: 2 })
    const agents = cutOffs(notified(T0, 'stopped', '4 background agents didn&apos;t finish before the previous session ended: &quot;A&quot; (a1), &quot;B&quot; (a2).'.replace('&apos;', "'"), ['a1', 'a2', 'a3', 'a4']))
    expect(agents[0]).toMatchObject({ kind: 'ended', tasks: 4 })
  })

  test('a command that exited 1, and an agent that failed, are failures', () => {
    expect(cutOffs(notified(T0, 'failed', FAILED.replace(/"/g, '&quot;')))[0]).toMatchObject({ kind: 'failed', summary: FAILED })
    expect(cutOffs(notified(T0, 'failed', 'Agent "Screenshots" failed: Agent stalled: no progress for 600s (stream watchdog did not recover)'))[0]).toMatchObject({ kind: 'failed' })
  })

  test('stopped for want of memory or time, or because auto mode stopped it, is cut off — not by the person', () => {
    expect(judged('killed', 'Background command "x" was stopped because the system is running low on memory')).toBe('stopped')
    expect(judged('killed', 'Background command "x" was stopped after reaching its background time limit')).toBe('stopped')
    expect(judged('killed', 'Agent "x" was stopped: Auto mode is unavailable: the server returned no safety verdict')).toBe('stopped')
  })

  test('successes, deliberate stops, signals, watchers and restarts are not counted', () => {
    expect(judged('completed', 'Background command "x" completed (exit code 0)')).toBeNull()
    expect(judged('completed', 'Background command "x" completed (exit code 1: No matches found)')).toBeNull()
    expect(judged('completed', 'Agent "x" finished')).toBeNull()
    expect(judged('failed', 'Background command "x" failed with exit code 143')).toBeNull()
    expect(judged('failed', 'Background command "x" failed with exit code 144')).toBeNull()
    expect(judged('killed', 'Agent "x" was stopped by user')).toBeNull()
    expect(judged('killed', 'Agent "x" was stopped by Claude')).toBeNull()
    expect(judged('killed', 'Background command "x" was stopped')).toBeNull()
    expect(judged('failed', 'Monitor "x" script failed (exit 1)')).toBeNull()
    expect(judged('', 'Background agent "x" was restarted after the previous session ended')).toBeNull()
    const text = [
      notified(T0, 'completed', 'Background command "x" completed (exit code 0)'),
      notified(T0 + 1, 'completed', 'Agent "x" finished'),
      notified(T0 + 2, 'failed', 'Background command "x" failed with exit code 143'),
    ].join('\n')
    expect(cutOffs(text)).toEqual([])
  })

  test('the queue’s copy and a subagent’s own thread are not read', () => {
    expect(cutOffs(queued(T0, SHELL_CUT))).toEqual([])
    expect(cutOffs(notified(T0, 'stopped', SHELL_CUT, ['b1'], { isSidechain: true }))).toEqual([])
  })

  test('an older row (meta, with a preamble above the block) is read too', () => {
    const old = JSON.stringify({
      type: 'user',
      isMeta: true,
      isSidechain: false,
      timestamp: iso(T0),
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: `[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n<task-notification>\n<task-id>b1</task-id>\n<status>failed</status>\n<summary>Background command "x" failed with exit code 2</summary>\n</task-notification>` },
    })
    expect(cutOffs(old)[0]).toMatchObject({ kind: 'failed' })
  })

  test('a summary is one line, cut short', () => {
    const long = `Background command "${'a'.repeat(300)}" failed with exit code 1`
    const found = cutOffs(notified(T0, 'failed', long))[0]!
    expect(found.summary.length).toBe(90)
    expect(found.summary.endsWith('…')).toBe(true)
  })
})

describe('whether the person has moved on', () => {
  test('a prompt they typed after it is moving on; one before it is not', () => {
    const text = [typed(T0 - 1000), notified(T0, 'stopped', SHELL_CUT)].join('\n')
    expect(movedOn(text, T0)).toBe(false)
    expect(movedOn(`${text}\n${typed(T0 + 1000)}`, T0)).toBe(true)
  })

  test('a notification, a tool’s answer, the agent and this module’s own line are not the person', () => {
    const line = 'Kehikot restarted while you were working.'
    const text = [notified(T0, 'stopped', SHELL_CUT), notified(T0 + 1, 'completed', 'Agent "x" finished'), toolResult(T0 + 2), asked(T0 + 3, 'end_turn'), typed(T0 + 4, line)].join('\n')
    expect(movedOn(text, T0, [line])).toBe(false)
  })
})

describe('whether a turn was under way', () => {
  test('a turn that ended is not; one waiting on a tool, or a prompt with no answer, is', () => {
    expect(midTurn([typed(T0), asked(T0 + 1, 'end_turn'), turnEnded(T0 + 2)].join('\n'))).toBe(false)
    expect(midTurn([typed(T0), asked(T0 + 1, 'tool_use')].join('\n'))).toBe(true)
    expect(midTurn([typed(T0), asked(T0 + 1, 'tool_use'), toolResult(T0 + 2)].join('\n'))).toBe(true)
    expect(midTurn(typed(T0))).toBe(true)
    expect(midTurn('')).toBe(false)
  })
})

describe('the words', () => {
  const one = (kind: 'ended' | 'stopped' | 'failed', tasks = 1) => ({ at: T0, kind, summary: `s-${kind}`, tasks })

  test('said as plainly as what happened', () => {
    expect(cutOffWords([one('ended'), one('ended')]).said).toBe("2 background tasks didn't finish before the session ended")
    expect(cutOffWords([one('ended')]).said).toBe("1 background task didn't finish before the session ended")
    expect(cutOffWords([one('failed')]).said).toBe('1 background task failed')
    expect(cutOffWords([one('stopped', 2)]).said).toBe('2 background tasks were stopped before finishing')
    expect(cutOffWords([one('ended'), one('failed')]).said).toBe('2 background tasks were cut off or failed')
    expect(cutOffWords([one('ended'), one('failed')]).detail).toBe('s-ended; s-failed')
  })
})
