import { describe, expect, test } from 'bun:test'

import { AT, NEAR, STALE_MS, levelOf, limitsNow, limitsWords, mergeLimits, readLimits, resetSaid, type Limits } from '../usage.ts'

/**
 * The subscription allowance, from Claude Code's status line JSON (`rate_limits`, as
 * code.claude.com/docs/en/statusline documents it): what is believed, how several sessions'
 * reports are put together, and how it is said.
 */

/* Local times, so the words do not depend on the zone the tests run in. Friday 30 October 2026, 14:02. */
const NOW = new Date(2026, 9, 30, 14, 2).getTime()
const MONDAY_9 = new Date(2026, 10, 2, 9, 0).getTime()
const TODAY_1630 = new Date(2026, 9, 30, 16, 30).getTime()
const sec = (ms: number) => ms / 1000

/** A status line report, as the docs' example has it. */
const report = (week: number | null, hours: number | null, weekResets = MONDAY_9, hoursResets = TODAY_1630) => ({
  session_id: '11111111-1111-4111-8111-111111111111',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  rate_limits: {
    ...(week === null ? {} : { seven_day: { used_percentage: week, resets_at: sec(weekResets) } }),
    ...(hours === null ? {} : { five_hour: { used_percentage: hours, resets_at: sec(hoursResets) } }),
  },
})

describe('reading rate_limits', () => {
  test('both windows, in milliseconds, with when they were heard', () => {
    expect(readLimits(report(62.4, 23.5), NOW)).toEqual({
      week: { used: 62.4, resets: MONDAY_9, at: NOW },
      hours: { used: 23.5, resets: TODAY_1630, at: NOW },
    })
  })

  test('each window may be absent on its own', () => {
    expect(readLimits(report(null, 23.5), NOW)).toEqual({ week: null, hours: { used: 23.5, resets: TODAY_1630, at: NOW } })
  })

  test('no rate_limits — an API-key login or an older Claude Code — is nothing, not a zero', () => {
    expect(readLimits({ session_id: 'x', model: {} }, NOW)).toBeNull()
    expect(readLimits(report(null, null), NOW)).toBeNull()
    expect(readLimits({ rate_limits: { seven_day: { used_percentage: '62', resets_at: 1 } } }, NOW)).toBeNull()
    expect(readLimits({ rate_limits: { seven_day: { used_percentage: 62 } } }, NOW)).toBeNull()
    expect(readLimits({ rate_limits: [1] }, NOW)).toBeNull()
    expect(readLimits(null, NOW)).toBeNull()
  })

  test('only the gateway spend limit is not a subscription allowance', () => {
    expect(readLimits({ rate_limits: { spend_limit: { used_percentage: 40, resets_at: sec(MONDAY_9) } } }, NOW)).toBeNull()
  })
})

describe('several sessions, one allowance', () => {
  const held = readLimits(report(62, 30), NOW - 60_000)

  test('a newer figure in the same window replaces the held one', () => {
    expect(mergeLimits(held, readLimits(report(64, 31), NOW), NOW)?.week).toEqual({ used: 64, resets: MONDAY_9, at: NOW })
  })

  test('an idle session repeating an older, smaller figure of the same window is passed over', () => {
    expect(mergeLimits(held, readLimits(report(55, 10), NOW), NOW)).toEqual(held)
  })

  test('a report without rate_limits leaves what is held', () => {
    expect(mergeLimits(held, null, NOW)).toEqual(held)
  })

  test('a new window replaces the old one even with a smaller share', () => {
    const next = MONDAY_9 + 7 * 86_400_000
    expect(mergeLimits(held, readLimits(report(2, null, next), NOW), NOW)?.week).toEqual({ used: 2, resets: next, at: NOW })
  })

  test('a window that has reset is dropped, and with both gone nothing is known', () => {
    expect(limitsNow(held, TODAY_1630 + 1)?.hours).toBeNull()
    expect(limitsNow(held, MONDAY_9 + 1)).toBeNull()
  })
})

describe('in words', () => {
  const limits = (week: number | null, hours: number | null, at = NOW): Limits | null => readLimits(report(week, hours), at)

  test('the week and when it resets', () => {
    const words = limitsWords(limits(62.4, 23.5), NOW)!
    expect(words.full).toBe('Week 62% · resets Mon 09:00')
    expect(words.short).toBe('W 62%')
    expect(words.level).toBe('ok')
    expect(words.stale).toBeNull()
    expect(words.hoursNear).toBeNull()
  })

  test('the tooltip says both windows, their resets and where the figure comes from', () => {
    const { title } = limitsWords(limits(62, 23.5), NOW)!
    expect(title).toContain('This week: 62% used, resets Mon 09:00')
    expect(title).toContain('5-hour session: 23% used, resets 16:30')
    expect(title).toContain('status line')
    expect(title).toContain('at 14:02')
  })

  test('thresholds: amber near the limit, red at it, always said in words', () => {
    expect(levelOf(NEAR - 1)).toBe('ok')
    expect(levelOf(NEAR)).toBe('near')
    expect(levelOf(AT)).toBe('at')
    expect(limitsWords(limits(85, 1), NOW)!.full).toBe('Week 85% — near the limit · resets Mon 09:00')
    expect(limitsWords(limits(97, 1), NOW)!.full).toBe('Week 97% — at the limit · resets Mon 09:00')
    expect(limitsWords(limits(100, 1), NOW)!.full).toBe('Week 100% — limit reached · resets Mon 09:00')
  })

  test('the five-hour window joins the line when it is near its own limit', () => {
    expect(limitsWords(limits(40, 91), NOW)!.hoursNear).toBe('5h 91%')
  })

  test('with no weekly window, the five-hour one is the headline', () => {
    const words = limitsWords(limits(null, 40), NOW)!
    expect(words.which).toBe('hours')
    expect(words.full).toBe('5h 40% · resets 16:30')
    expect(words.short).toBe('5h 40%')
    expect(words.title).toContain('This week: not reported')
  })

  test('a figure older than a few minutes says when it is from', () => {
    const at = NOW - STALE_MS - 1
    const words = limitsWords(limits(62, 23, at), NOW)!
    expect(words.stale).toBe(`as of ${new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`)
    expect(words.full).toEndWith(words.stale!)
    expect(limitsWords(limits(62, 23, NOW - STALE_MS + 1), NOW)!.stale).toBeNull()
  })

  test('nothing known is nothing said', () => {
    expect(limitsWords(null, NOW)).toBeNull()
  })

  test('a reset later today is just its time', () => {
    expect(resetSaid(TODAY_1630, NOW)).toBe('16:30')
    expect(resetSaid(MONDAY_9, NOW)).toBe('Mon 09:00')
  })
})
