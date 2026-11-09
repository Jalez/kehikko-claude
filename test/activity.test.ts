import { describe, expect, test } from 'bun:test'
import { MESSAGE, PROTOCOL, activityItemsSchema } from 'kehikot-module-protocol'
import { connect, type MessageSource } from 'kehikot-module-protocol/client'

import { activityRows, type Run } from '../live.ts'

/**
 * What the page does with the list the server writes: the protocol's own client is the one that
 * decides whether to send, so this drives the real one with a stand-in host.
 */

function host(extra: Record<string, unknown> = {}) {
  const listeners = new Set<(ev: MessageEvent) => void>()
  const source: MessageSource = {
    parent: {} as Window,
    addEventListener: (_t, fn) => void listeners.add(fn),
    removeEventListener: (_t, fn) => void listeners.delete(fn),
  }
  const said: { type: string; id: string; method?: string; params?: { items: unknown[] } }[] = []
  const from = { postMessage: (m: never) => void said.push(m) }
  const live = connect('kehikot.claude', {}, { source })
  live.listen()
  for (const fn of listeners) {
    fn({ data: { type: MESSAGE.HELLO, protocol: PROTOCOL, session: 's', context: { epic: null, project: null, theme: 'light' }, ...extra }, origin: 'null', source: from } as unknown as MessageEvent)
  }
  return { live, sets: () => said.filter((m) => m.type === MESSAGE.REQUEST && m.method === 'activity.set') }
}

const run = (over: Record<string, unknown>): Run =>
  ({ what: 'session', ended: false, state: 'working', id: 'a', settled: 'a', label: 'draft the results', at: { epic: 'thesis', parts: ['results'], kehikko: { key: '4072c9e5' } }, stateSince: 1000, background: 0, turned: true, seen: false, looking: new Set(), ...over }) as unknown as Run

describe('the list as the protocol takes it', () => {
  test('every row the server writes parses, whatever the label and the place', () => {
    const rows = activityRows([
      run({ id: 'a', settled: 'a' }),
      run({ id: 'b', settled: null, label: 'x'.repeat(500), state: 'needs-you' }),
      run({ id: 'c', settled: 'c', label: '', state: 'finished', background: 2, at: null }),
    ])
    expect(activityItemsSchema.safeParse(rows).success).toBe(true)
    expect(rows.map((row) => row.state)).toEqual(['attention', 'working', 'done'])
    expect(rows[2]).toMatchObject({ label: 'Claude session', detail: 'turn ended; 2 background tasks still running' })
    expect(rows[2]).not.toHaveProperty('place')
  })

  test('a host that answers the method is sent the whole list, and an identical one once', () => {
    const h = host({ answers: ['activity.set'] })
    const rows = activityRows([run({})])
    h.live.activity(rows)
    h.live.activity(activityRows([run({})]))
    expect(h.sets()).toHaveLength(1)
    expect(h.sets()[0]!.params).toEqual({ items: rows })
    h.live.activity([])
    expect(h.sets()).toHaveLength(2)
    expect(h.sets()[1]!.params).toEqual({ items: [] })
  })

  test('an older host, whose greeting lacks the method, is sent nothing', () => {
    const h = host({ answers: ['parts.set', 'events.emit'] })
    h.live.activity(activityRows([run({})]))
    h.live.activity([])
    expect(h.sets()).toHaveLength(0)
  })
})

describe('how a turn ended, as the protocol takes it (protocol 2.55.0)', () => {
  test('a decision with choices, a refusal and a stall all parse, the question addressed to the session', () => {
    const decision = { kind: 'needs-decision' as const, label: 'Which branch?', choices: ['main', 'release'] }
    const ended = (turnEnd: unknown, more: Record<string, unknown> = {}) => run({ id: 'd', settled: 'd', state: 'finished', turnEnd, crons: 0, ...more })
    const rows = activityRows([
      ended({ state: 'attention', event: 'needs-decision', label: 'Which branch?', detail: 'asks you to decide: answer here or in the session', asks: { text: decision.label, choices: decision.choices } }),
      ended({ state: 'attention', event: 'stalled', label: null, detail: 'stopped without finishing or asking', asks: null }, { id: 'e', settled: 'e' }),
      run({ id: 'f', settled: 'f', state: 'working', refused: { tool: 'Bash', action: 'rm -rf build', reason: '[Irreversible Local Destruction]', at: 5 }, crons: 0 }),
    ])
    expect(activityItemsSchema.safeParse(rows).success).toBe(true)
    expect(rows.find((one) => one.id === 'd')!.question).toEqual({ text: 'Which branch?', choices: ['main', 'release'], to: { module: 'kehikot.claude', session: 'd' } })
    expect(rows.find((one) => one.id === 'e')!.question).toBeUndefined()
    expect(rows.find((one) => one.id === 'f:refused')).toMatchObject({ state: 'attention', event: 'action-refused', question: { to: { module: 'kehikot.claude', session: 'f' } } })
  })
})
