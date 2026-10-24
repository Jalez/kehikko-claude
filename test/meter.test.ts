import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Gauges } from '../gauges.ts'
import { contextOf, contextWords, emptyGauge, modelName, readLines, readStatus, thresholds, windowFor, type Gauge } from '../meter.ts'

/*
 * Rows shaped as Claude Code 2.1.310 wrote them in a scratch session (a stand-in for the model API
 * answered; the ids and times are these tests' own). Only the fields that matter are kept, plus a
 * few that do not, so that a reader that looked at the wrong thing would be caught.
 */
const ID = '052f0117-280c-41eb-b1a7-ecdb8403a8c1'
const user = (text: string, at = '2026-10-24T11:55:50.000Z') =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid: 'u1', timestamp: at, sessionId: ID })
const assistant = (usage: Record<string, unknown>, more: Record<string, unknown> = {}, model = 'claude-opus-5-5', at = '2026-10-24T11:55:51.076Z') =>
  JSON.stringify({
    parentUuid: 'u1',
    isSidechain: false,
    message: { model, id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'FILL 999999 is not a usage' }], stop_reason: 'end_turn', usage },
    requestId: 'req_standin',
    type: 'assistant',
    uuid: 'a1',
    timestamp: at,
    sessionId: ID,
    ...more,
  })
const USAGE = {
  input_tokens: 40,
  cache_creation_input_tokens: 1200,
  cache_read_input_tokens: 170000,
  output_tokens: 20,
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  iterations: [],
  speed: 'standard',
}
const boundary = (pre: number, post: number, trigger = 'manual', at = '2026-10-24T11:56:05.800Z') =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info', compactMetadata: { trigger, preTokens: pre, postTokens: post, cumulativeDroppedTokens: pre - post, durationMs: 33 }, timestamp: at, uuid: 'b1', sessionId: ID })
const costState = (usd: number) => JSON.stringify({ type: 'cost-state', sessionId: ID, totalCostUSD: usd, totalAPIDuration: 58, totalDuration: 27526, modelUsage: { 'claude-opus-5-5': { inputTokens: 40, costUSD: usd } }, hasUnknownModelCost: false })
const lastPrompt = JSON.stringify({ type: 'last-prompt', lastPrompt: 'hello FILL 170000', sessionId: ID })

describe('reading the context out of a transcript', () => {
  test('the window holds the last request’s input side: new input, cache read and cache written', () => {
    const g = readLines([user('hello'), assistant(USAGE), lastPrompt].join('\n'))
    expect(g.usage).toEqual({ input: 40, cacheRead: 170000, cacheWrite: 1200, output: 20 })
    expect(g.model).toBe('claude-opus-5-5')
    const c = contextOf(g)!
    expect(c.tokens).toBe(171240)
    expect(c.window).toBe(1_000_000)
    expect(c.percent).toBe(17)
    expect(c.from).toBe('transcript')
    expect(c.split).toEqual({ input: 40, cacheRead: 170000, cacheWrite: 1200, output: 20 })
  })

  test('the last request counts, and a subagent’s, a synthetic one and an API error do not', () => {
    const lines = [
      assistant({ ...USAGE, cache_read_input_tokens: 10000 }),
      assistant({ ...USAGE, cache_read_input_tokens: 500000 }, { isSidechain: true }),
      assistant({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, {}, '<synthetic>'),
      assistant({ ...USAGE, cache_read_input_tokens: 900000 }, { isApiErrorMessage: true }),
    ]
    expect(contextOf(readLines(lines.join('\n')))!.tokens).toBe(10000 + 40 + 1200)
  })

  test('a request made of iterations counts its last message iteration, as Claude Code does', () => {
    const usage = { ...USAGE, iterations: [{ type: 'message', input_tokens: 5, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0, output_tokens: 3 }, { type: 'compaction', input_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }] }
    expect(contextOf(readLines(assistant(usage)))!.tokens).toBe(50005)
  })

  test('a compaction since the last request says what it compacted to, and is counted', () => {
    const g = readLines([assistant(USAGE), user('/compact'), boundary(171260, 2743)].join('\n'))
    const c = contextOf(g)!
    expect(c.tokens).toBe(2743)
    expect(c.afterCompact).toBe(true)
    expect(c.split).toBeNull()
    expect(c.compacted).toEqual({ times: 1, last: { at: Date.parse('2026-10-24T11:56:05.800Z'), trigger: 'manual', before: 171260, after: 2743 } })
    expect(contextWords(c).line).toBe('about 3k of 1.0M · 0%')
    /* The next request is the figure again; the compaction stays counted. */
    const next = readLines(assistant({ ...USAGE, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, input_tokens: 12 }), g)
    expect(contextOf(next)!.tokens).toBe(9012)
    expect(contextOf(next)!.afterCompact).toBe(false)
    expect(contextOf(next)!.compacted?.times).toBe(1)
    expect(contextOf(readLines(boundary(160000, 30000, 'auto'), next))!.compacted).toMatchObject({ times: 2, last: { trigger: 'auto' } })
  })

  test('the cost a session wrote when it was cleared or ended is shown only when no request came after it', () => {
    const ended = readLines([assistant(USAGE), costState(0.0512)].join('\n'))
    expect(contextOf(ended)!.cost).toEqual({ usd: 0.0512, live: false })
    const resumed = readLines(assistant(USAGE), ended)
    expect(contextOf(resumed)!.cost).toBeNull()
  })

  test('nothing in the transcript is nothing to show, and a line that is not JSON is passed over', () => {
    expect(contextOf(readLines([user('hi'), lastPrompt, '{"type":"assistant", cut short'].join('\n')))).toBeNull()
    expect(contextOf(null)).toBeNull()
  })

  test('the text of a row is never read for figures', () => {
    const g = readLines(user('"type":"assistant" "cache_read_input_tokens": 999999'))
    expect(g).toEqual(emptyGauge())
  })
})

describe('the window, the percentage and the threshold', () => {
  test('the window is the model’s, from Claude Code 2.1.310’s catalog, and Claude Code’s own word when it said one', () => {
    expect(windowFor('claude-opus-5-5', 1000)).toEqual({ window: 1_000_000, sure: false })
    expect(windowFor('claude-sonnet-4-5-20250929', 1000)).toEqual({ window: 200_000, sure: false })
    expect(windowFor('claude-haiku-4-5', 1000)).toEqual({ window: 200_000, sure: false })
    expect(windowFor('claude-sonnet-4-6[1m]', 1000)).toEqual({ window: 1_000_000, sure: false })
    /* A model it does not know is Claude Code's own default. */
    expect(windowFor('some-other-model', 1000)).toEqual({ window: 200_000, sure: false })
    /* More in use than the smaller window holds: it is on the larger one (a [1m] choice is not in the transcript). */
    expect(windowFor('claude-sonnet-4-6', 250_000)).toEqual({ window: 1_000_000, sure: false })
    expect(windowFor('claude-sonnet-4-6', 250_000, 1_000_000)).toEqual({ window: 1_000_000, sure: true })
  })

  test('the percentage is rounded as the status line’s used_percentage is', () => {
    const at = (tokens: number) => contextOf({ ...emptyGauge(), model: 'claude-sonnet-4-5', usage: { input: tokens, cacheRead: 0, cacheWrite: 0, output: 0 }, usageAt: 1 })!.percent
    expect(at(1)).toBe(0)
    expect(at(1_000)).toBe(1)
    expect(at(164_000)).toBe(82)
    expect(at(199_999)).toBe(100)
  })

  test('auto-compact: the window less the answer’s room (at most 20k) less 13k; warned 20k before', () => {
    expect(thresholds(200_000, 'claude-sonnet-4-5')).toEqual({ compactAt: 167_000, warnAt: 147_000, effective: 180_000 })
    expect(thresholds(1_000_000, 'claude-opus-5-5')).toEqual({ compactAt: 967_000, warnAt: 947_000, effective: 980_000 })
    /* An older model with less room for its answer keeps less back. */
    expect(thresholds(200_000, 'claude-3-5-haiku')).toEqual({ compactAt: 200_000 - 8_192 - 13_000, warnAt: 200_000 - 8_192 - 33_000, effective: 200_000 - 8_192 })
  })

  test('near the threshold it says so in words', () => {
    const near = (tokens: number) => contextOf({ ...emptyGauge(), model: 'claude-sonnet-4-5', usage: { input: 40, cacheRead: tokens - 40, cacheWrite: 0, output: 0 }, usageAt: 1 })!
    expect(contextWords(near(100_000)).warning).toBeNull()
    expect(near(146_999).soon).toBe(false)
    expect(near(164_000).soon).toBe(true)
    expect(contextWords(near(164_000)).warning).toBe('82% — compacts soon')
    expect(contextWords(near(170_000)).warning).toBe('85% — compacting')
    expect(contextWords(near(164_000)).line).toBe('164k of 200k · 82%')
    expect(contextWords(near(164_000)).title).toContain('compacts by itself at about 84%')
  })
})

describe('the status line’s JSON', () => {
  /* As Claude Code 2.1.310 handed it to a status line command in the scratch session. */
  const RAW = {
    session_id: ID,
    transcript_path: `/tmp/x/${ID}.jsonl`,
    cwd: '/private/tmp/kc-ctx/scratch/proj',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    workspace: { current_dir: '/private/tmp/kc-ctx/scratch/proj', project_dir: '/private/tmp/kc-ctx/scratch/proj', added_dirs: [] },
    version: '2.1.310',
    cost: { total_cost_usd: 0.04488, total_duration_ms: 7380, total_api_duration_ms: 35, total_lines_added: 0, total_lines_removed: 0 },
    context_window: {
      total_input_tokens: 151240,
      total_output_tokens: 20,
      context_window_size: 1000000,
      current_usage: { input_tokens: 40, output_tokens: 20, cache_creation_input_tokens: 1200, cache_read_input_tokens: 150000 },
      used_percentage: 15,
      remaining_percentage: 85,
    },
    exceeds_200k_tokens: false,
  }

  test('only the numbers, the session and the model are kept', () => {
    const status = readStatus(RAW, 5)!
    expect(status).toEqual({ at: 5, session: ID, model: { id: 'claude-opus-5-5', name: 'Opus 5.5' }, window: 1_000_000, tokens: 151240, usage: { input: 40, cacheRead: 150000, cacheWrite: 1200, output: 20 }, cost: 0.04488 })
    expect(JSON.stringify(status)).not.toContain('/tmp')
    expect(readStatus({ ...RAW, session_id: '../x' }, 5)).toBeNull()
    expect(readStatus('nope', 5)).toBeNull()
  })

  test('its window and live cost win; the same percentage as Claude Code’s own', () => {
    const c = contextOf(null, readStatus(RAW, 5))!
    expect(c.percent).toBe(RAW.context_window.used_percentage)
    expect(c.windowSure).toBe(true)
    expect(c.cost).toEqual({ usd: 0.04488, live: true })
    expect(c.from).toBe('status')
  })

  test('after a compaction, before the next request, it counts nothing; the transcript says what is there', () => {
    const empty = readStatus({ ...RAW, context_window: { ...RAW.context_window, current_usage: null, total_input_tokens: 0, used_percentage: null } }, Date.parse('2026-10-24T11:57:00.000Z'))!
    expect(empty.tokens).toBeNull()
    const g: Gauge = readLines([assistant(USAGE), boundary(171260, 2743)].join('\n'))
    const c = contextOf(g, empty)!
    expect(c.tokens).toBe(2743)
    expect(c.afterCompact).toBe(true)
    expect(c.windowSure).toBe(true)
    expect(c.cost?.live).toBe(true)
  })

  test('a new conversation (after /clear) has its model and nothing sent yet', () => {
    const fresh = readStatus({ ...RAW, cost: { total_cost_usd: 0 }, context_window: { context_window_size: 1000000, current_usage: null } }, 9)!
    const c = contextOf(emptyGauge(), fresh)!
    expect(c.tokens).toBeNull()
    expect(c.percent).toBeNull()
    expect(contextWords(c).line).toBe('nothing sent yet')
    expect(c.model?.name).toBe('Opus 5.5')
  })
})

describe('a model’s name', () => {
  test('as a person reads it', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(modelName('claude-haiku-4-5')).toBe('Haiku 4.5')
    expect(modelName('claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelName('claude-3-7-sonnet-20250219')).toBe('Sonnet 3.7')
    expect(modelName('claude-sonnet-4-6[1m]')).toBe('Sonnet 4.6 (1M)')
    expect(modelName('gpt-oss')).toBe('gpt-oss')
  })
})

describe('reading a growing transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kehikko-claude-meter-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('only what was appended is read, and a line still being written waits for its end', async () => {
    const file = join(dir, `${ID}.jsonl`)
    writeFileSync(file, `${user('hello')}\n${assistant({ ...USAGE, cache_read_input_tokens: 1000 })}\n`)
    const gauges = new Gauges()
    expect(contextOf(await gauges.read(file))!.tokens).toBe(2240)
    const next = assistant({ ...USAGE, cache_read_input_tokens: 5000 })
    appendFileSync(file, next.slice(0, 40))
    expect(contextOf(await gauges.read(file))!.tokens).toBe(2240)
    appendFileSync(file, `${next.slice(40)}\n${boundary(6240, 800)}\n`)
    const now = contextOf(await gauges.read(file))!
    expect(now.tokens).toBe(800)
    expect(now.compacted?.times).toBe(1)
  })

  test('a transcript that was replaced is read afresh, and one that is gone is nothing', async () => {
    const file = join(dir, 'other.jsonl')
    writeFileSync(file, `${assistant({ ...USAGE, cache_read_input_tokens: 90000 })}\n${boundary(1, 1)}\n`)
    const gauges = new Gauges()
    expect((await gauges.read(file))!.compactions).toBe(1)
    writeFileSync(file, `${assistant({ ...USAGE, cache_read_input_tokens: 10 })}\n`)
    const again = (await gauges.read(file))!
    expect(again.compactions).toBe(0)
    rmSync(file)
    expect(await gauges.read(file)).toBeNull()
    expect(await gauges.read(null)).toBeNull()
  })
})
