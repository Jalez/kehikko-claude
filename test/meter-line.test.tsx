import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'

import { contextOf, emptyGauge, readLines } from '../meter.ts'
import { CLEAR_ARMED, ContextLine, NO_SPLIT, type Command } from '../src/view/meter.tsx'
import { readLimits } from '../usage.ts'

/** The line under the session on screen: what it says, its breakdown, and Compact and Clear. */

afterEach(cleanup)

const near = contextOf({ ...emptyGauge(), model: 'claude-sonnet-4-5', usage: { input: 40, cacheRead: 162_760, cacheWrite: 1_200, output: 20 }, usageAt: 1, cost: 0.42, costSince: false })!
const compacted = contextOf(
  readLines(
    [
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-24T11:55:51.076Z', message: { model: 'claude-opus-5-5', usage: { input_tokens: 40, cache_creation_input_tokens: 1200, cache_read_input_tokens: 170000, output_tokens: 20 } } }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-24T11:56:05.800Z', compactMetadata: { trigger: 'manual', preTokens: 171260, postTokens: 2743 } }),
    ].join('\n'),
  ),
)!

function line(props: { ready?: string | null; context?: typeof near | null; armedMs?: number } = {}) {
  const sent: Command[] = []
  const view = render(
    <ContextLine context={props.context === undefined ? near : props.context} ready={props.ready ?? null} armedMs={props.armedMs} onCommand={(which) => (sent.push(which), true)} />,
  )
  const q = (selector: string) => view.container.querySelector(selector) as HTMLElement | null
  return { view, sent, q }
}

describe('the context line', () => {
  test('says the share, the figure and the warning in words — never by colour alone', () => {
    const { q, view } = line()
    expect(q('[data-context-percent]')?.textContent).toBe('82% — compacts soon')
    expect(view.container.textContent).toContain('164k / 200k')
    expect(q('[data-meter-bar]')?.getAttribute('data-meter-bar')).toBe('82')
    expect(q('[data-context-trigger]')?.getAttribute('title')).toContain('compacts by itself at about 84%')
  })

  test('nothing sent yet is said as such', () => {
    const { q } = line({ context: null })
    expect(q('[data-context-percent]')?.textContent).toBe('nothing sent yet')
  })

  test('pressed, it opens a breakdown with the figures it has, and says the split by kind is /context’s; Escape closes it', () => {
    const { q, view } = line({ context: compacted })
    fireEvent.click(q('[data-context-trigger]')!)
    const panel = q('[data-breakdown]')!
    expect(panel.textContent).toContain('about 2,743 of 1,000,000 tokens')
    expect(panel.textContent).toContain('once — last by /compact')
    expect(panel.textContent).toContain('171k → 3k')
    expect(panel.textContent).toContain(NO_SPLIT)
    expect(q('[data-context-trigger]')?.getAttribute('aria-expanded')).toBe('true')
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(q('[data-breakdown]')).toBeNull()
    expect(view.container.querySelector('[data-compacted]')).not.toBeNull()
  })

  test('Compact goes at once; Clear asks first, saying the session starts over and the old one is kept', () => {
    const { q, sent } = line()
    fireEvent.click(q('[data-command="compact"]')!)
    expect(sent).toEqual(['compact'])
    fireEvent.click(q('[data-command="clear"]')!)
    expect(sent).toEqual(['compact'])
    expect(q('[data-context-said]')?.textContent).toBe(CLEAR_ARMED)
    expect(CLEAR_ARMED).toContain('new conversation')
    expect(CLEAR_ARMED).toContain('This one is kept')
    expect(q('[data-command="clear"]')?.textContent).toBe('Clear: sure?')
    fireEvent.click(q('[data-command="clear"]')!)
    expect(sent).toEqual(['compact', 'clear'])
  })

  test('an armed Clear lets go by itself, and on Escape', async () => {
    const { q, sent } = line({ armedMs: 30 })
    fireEvent.click(q('[data-command="clear"]')!)
    await act(() => new Promise((done) => setTimeout(done, 60)))
    expect(q('[data-command="clear"]')?.textContent).toBe('Clear')
    fireEvent.click(q('[data-command="clear"]')!)
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    fireEvent.click(q('[data-command="clear"]')!)
    expect(sent).toEqual([])
  })

  test('while Claude is working both wait, and a press says why in words', () => {
    const why = 'Claude is working. Compact and Clear wait until it is back at its prompt.'
    const { q, sent, view } = line({ ready: why })
    expect(q('[data-command="compact"]')?.getAttribute('aria-disabled')).toBe('true')
    expect(q('[data-command="clear"]')?.getAttribute('title')).toBe(`Clear waits: ${why}`)
    fireEvent.click(q('[data-command="clear"]')!)
    fireEvent.click(q('[data-command="clear"]')!)
    fireEvent.click(q('[data-command="compact"]')!)
    expect(sent).toEqual([])
    expect(q('[data-context-said]')?.textContent).toBe(`Compact waits: ${why}`)
    expect(view.container.querySelector('[data-context-line]')?.getAttribute('data-ready')).toBe('no')
  })
})

describe('the subscription usage beside the context', () => {
  const NOW = new Date(2026, 9, 30, 14, 2).getTime()
  const MONDAY_9 = new Date(2026, 10, 2, 9, 0).getTime()
  const LATER = new Date(2026, 9, 30, 16, 30).getTime()
  const limits = (week: number | null, hours: number | null, at = NOW) =>
    readLimits({ rate_limits: { ...(week === null ? {} : { seven_day: { used_percentage: week, resets_at: MONDAY_9 / 1000 } }), ...(hours === null ? {} : { five_hour: { used_percentage: hours, resets_at: LATER / 1000 } }) } }, at)
  const drawn = (value: ReturnType<typeof limits>, now = NOW) => {
    const view = render(<ContextLine context={near} ready={null} limits={value} now={now} onCommand={() => true} />)
    const q = (selector: string) => view.container.querySelector(selector) as HTMLElement | null
    return { view, q }
  }

  test('wide, the week and its reset; the tooltip says both windows and where the figure comes from', () => {
    const { q } = drawn(limits(62.4, 23.5))
    expect(q('[data-usage-full]')?.textContent).toBe('Week 62% · resets Mon 09:00')
    expect(q('[data-usage]')?.getAttribute('data-usage')).toBe('ok')
    const title = q('[data-usage]')?.getAttribute('title') ?? ''
    expect(title).toContain('This week: 62% used, resets Mon 09:00')
    expect(title).toContain('5-hour session: 23% used, resets 16:30')
    expect(title).toContain('status line')
    expect(q('[data-usage]')?.getAttribute('aria-label')).toContain('This week: 62% used')
  })

  test('it narrows by the line’s width: the full line from 560 pixels, “W 62%” from 300, a small meter under it', () => {
    const { q } = drawn(limits(62, 23))
    expect(q('[data-usage-full]')?.className).toContain('hidden')
    expect(q('[data-usage-full]')?.className).toContain('@[560px]:inline')
    expect(q('[data-usage-short]')?.textContent).toBe('W 62%')
    expect(q('[data-usage-short]')?.className).toContain('@[300px]:inline')
    expect(q('[data-usage-short]')?.className).toContain('@[560px]:hidden')
    expect(q('[data-usage-bar]')?.getAttribute('data-usage-bar')).toBe('62')
    expect(q('[data-usage-bar]')?.className).toContain('@[300px]:hidden')
    expect(q('[data-usage-tiny]')?.textContent).toBe('62%')
  })

  test('amber near the limit and red at it, and said in words, never by colour alone', () => {
    const amber = drawn(limits(85, 10))
    expect(amber.q('[data-usage]')?.getAttribute('data-usage')).toBe('near')
    expect(amber.q('[data-usage-full]')?.textContent).toContain('near the limit')
    expect(amber.q('[data-usage-full]')?.className).toContain('needs-you')
    expect(amber.q('[data-usage-short]')?.textContent).toBe('W 85%!')
    expect(amber.q('[data-usage-tiny]')?.textContent).toBe('85%!')
    amber.view.unmount()
    const red = drawn(limits(100, 10))
    expect(red.q('[data-usage]')?.getAttribute('data-usage')).toBe('at')
    expect(red.q('[data-usage-full]')?.textContent).toContain('limit reached')
    expect(red.q('[data-usage-full]')?.className).toContain('text-destructive')
    expect(red.q('[data-usage-bar] span')?.className).toContain('bg-destructive')
  })

  test('the five-hour window joins the line when it is near its own limit', () => {
    const { q } = drawn(limits(40, 92))
    expect(q('[data-usage-full]')?.textContent).toBe('Week 40% · resets Mon 09:00 · 5h 92%')
  })

  test('an old figure says when it is from', () => {
    const at = NOW - 10 * 60_000
    const { q } = drawn(limits(62, 23, at))
    expect(q('[data-usage]')?.getAttribute('data-usage-stale')).toBe('yes')
    expect(q('[data-usage-full]')?.textContent).toBe('Week 62% · resets Mon 09:00 · as of 13:52')
    expect(q('[data-usage-short]')?.textContent).toBe('W 62% · as of 13:52')
  })

  test('nothing known — an API-key login, an older Claude Code — draws nothing, not a zero', () => {
    const none = drawn(null)
    expect(none.q('[data-usage]')).toBeNull()
    expect(none.view.container.textContent).not.toContain('Week')
    none.view.unmount()
    /* Both windows have reset since the report. */
    expect(drawn(limits(62, 23), MONDAY_9 + 1).q('[data-usage]')).toBeNull()
  })

  test('the usage stays while the line says a sentence in place of the context', () => {
    const { q } = drawn(limits(62, 23))
    fireEvent.click(q('[data-command="clear"]')!)
    expect(q('[data-context-said]')?.textContent).toBe(CLEAR_ARMED)
    expect(q('[data-usage-full]')?.textContent).toBe('Week 62% · resets Mon 09:00')
  })
})
