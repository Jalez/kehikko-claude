/**
 * How full a conversation's context window is, and the rest of what Claude Code's own `/context`
 * and status line say about a session — read without anybody typing anything into it.
 *
 * ## Where the figures come from, and it is the whole list
 *
 *  1. **The transcript** (`<config>/projects/<folder>/<id>.jsonl`), which this module already finds
 *     for every session. Its last assistant row carries the request's `usage`; what is in the
 *     context window is that request's input side — `input_tokens + cache_creation_input_tokens +
 *     cache_read_input_tokens` — which is exactly what Claude Code's status line calls
 *     `context_window.total_input_tokens` and divides by the window for `used_percentage` (read in
 *     the 2.1.310 binary, `Rnr` and `Lit`, and measured against it below). The model id is on the
 *     same row. A compaction is a `system` row with `subtype: "compact_boundary"` and
 *     `compactMetadata: { trigger, preTokens, postTokens }`. A `cost-state` row holds the session's
 *     `totalCostUSD`, written when the session is cleared or its process ends — never while it runs.
 *  2. **The session's own status line**, for a session this module starts: Claude Code hands the
 *     status line command its JSON on stdin (`context_window.context_window_size`, `cost.
 *     total_cost_usd`, `model.display_name`, `exceeds_200k_tokens`, …), and `statusline.sh` posts
 *     it here after it has run the person's own status line command, unchanged. That is the only
 *     place the exact window and the live cost are said.
 *
 * Only these rows are parsed (`ROWS`), and of them only numbers, a model id, a trigger word and
 * times are kept. Nothing anybody wrote — a prompt, an answer, a tool's output — is read out of a
 * transcript for this, stored or shown.
 *
 * ## What cannot be known from here, and it is said rather than guessed
 *
 *  - **How the window splits** into system prompt, tools, MCP tools and messages. Claude Code's
 *    `/context` counts each part by asking the model API; the transcript and the status line carry
 *    totals only. So the breakdown shows the last request's own numbers (new input, read from the
 *    cache, written to the cache, output) and says that the split by kind is `/context`'s.
 *  - **The window, for a session this module did not start**, when the model can run with either
 *    of two (a `[1m]` choice is the person's and is not written in the transcript). The table below
 *    is Claude Code 2.1.310's own; a session that is using more than the smaller window is on the
 *    larger one. Said as `windowSure: false`.
 *  - **The cost of a session that is running, for one this module did not start.** Its
 *    `cost-state` row is written when it is cleared or ends, so the last one is shown only when no
 *    request has been made since (it is then the whole cost), and never as live.
 */

/* ------------------------------------------------------------------------ *
 * The window and the threshold, as Claude Code 2.1.310 has them
 * ------------------------------------------------------------------------ */

/**
 * Each model's context window and its default maximum output, from the model catalog baked into
 * Claude Code 2.1.310 (`m5r`: `context.window`, `max_output_tokens.default`). Matched by the
 * longest id that is the model's, or its prefix followed by a dash (a dated release:
 * `claude-sonnet-4-5-20250929`).
 */
export const MODELS: Readonly<Record<string, { window: number; output: number }>> = {
  'claude-3-5-haiku': { window: 200_000, output: 8_192 },
  'claude-haiku-4-5': { window: 200_000, output: 32_000 },
  'claude-haiku-5-5': { window: 1_000_000, output: 128_000 },
  'claude-3-5-sonnet': { window: 200_000, output: 8_192 },
  'claude-3-7-sonnet': { window: 200_000, output: 32_000 },
  'claude-sonnet-4-0': { window: 200_000, output: 32_000 },
  'claude-sonnet-4-5': { window: 200_000, output: 32_000 },
  'claude-sonnet-4-6': { window: 200_000, output: 32_000 },
  'claude-sonnet-5': { window: 1_000_000, output: 64_000 },
  'claude-sonnet-5-5': { window: 1_000_000, output: 128_000 },
  'claude-opus-4-0': { window: 200_000, output: 32_000 },
  'claude-opus-4-1': { window: 200_000, output: 32_000 },
  'claude-opus-4-5': { window: 200_000, output: 32_000 },
  'claude-opus-4-6': { window: 200_000, output: 64_000 },
  'claude-opus-4-7': { window: 1_000_000, output: 64_000 },
  'claude-opus-4-8': { window: 1_000_000, output: 64_000 },
  'claude-opus-5': { window: 1_000_000, output: 64_000 },
  'claude-opus-5-5': { window: 1_000_000, output: 128_000 },
  'claude-fable-5': { window: 1_000_000, output: 64_000 },
  'claude-fable-5-1': { window: 1_000_000, output: 64_000 },
  'claude-mythos-5': { window: 1_000_000, output: 64_000 },
  'claude-mythos-5-1': { window: 1_000_000, output: 64_000 },
}

/** Claude Code's window for a model it does not know (`Snt`), and the larger one a model may run with. */
export const DEFAULT_WINDOW = 200_000
export const LARGE_WINDOW = 1_000_000
const DEFAULT_OUTPUT = 32_000

/** The catalog entry a model id is, or null. `[1m]` and a date are not part of the name. */
export function modelEntry(id: string | null | undefined): { window: number; output: number } | null {
  if (!id) return null
  const bare = id.toLowerCase().replace(/\[1m\]/g, '').trim()
  let best: string | null = null
  for (const name of Object.keys(MODELS)) {
    if (bare !== name && !bare.startsWith(`${name}-`)) continue
    if (!best || name.length > best.length) best = name
  }
  return best ? MODELS[best]! : null
}

/**
 * The window a session runs with: what Claude Code said (its status line), else the catalog's for
 * the model — the larger one for a `[1m]` id, or when more than the catalog's is in use already.
 */
export function windowFor(model: string | null, tokens: number | null, said: number | null = null): { window: number; sure: boolean } {
  if (said !== null && Number.isFinite(said) && said > 0) return { window: said, sure: true }
  const entry = modelEntry(model)
  let window = entry?.window ?? DEFAULT_WINDOW
  if (model && /\[1m\]/i.test(model)) window = Math.max(window, LARGE_WINDOW)
  if (tokens !== null && tokens > window) window = Math.max(LARGE_WINDOW, tokens)
  return { window, sure: false }
}

/**
 * Where Claude Code 2.1.310 compacts by itself, in tokens, and where it starts warning.
 *
 * Read in the binary (`B7`, `MQ`, `_4e`): the effective window is the window less the room kept
 * for an answer — the model's maximum output, at most 20 000 (`wPr`) — and the automatic
 * compaction starts 13 000 tokens below that (`kXt`); its warning level is 20 000 below the
 * threshold. A person's `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` or `autoCompactWindow` moves it, and is
 * not known here: the threshold is said as "about".
 */
export function thresholds(window: number, model: string | null = null): { compactAt: number; warnAt: number } {
  const output = modelEntry(model)?.output ?? DEFAULT_OUTPUT
  const effective = window - Math.min(output, 20_000)
  const compactAt = effective - 13_000
  return { compactAt, warnAt: compactAt - 20_000 }
}

/** The share of the window in use, as Claude Code's status line rounds it (`used_percentage`). */
export const percentOf = (tokens: number, window: number): number => Math.min(100, Math.max(0, Math.round((tokens / window) * 100)))

/* ------------------------------------------------------------------------ *
 * What a transcript says
 * ------------------------------------------------------------------------ */

/** One request's own numbers. `input` is what was sent new, `cacheRead` and `cacheWrite` what the prompt cache read and wrote. */
export interface Usage {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export interface Compaction {
  /** Milliseconds; null when the row had no time. */
  at: number | null
  /** `manual` (`/compact`) or `auto`, as Claude Code wrote it. */
  trigger: string
  /** The tokens in use before and after, as Claude Code counted them. */
  before: number | null
  after: number | null
}

/** What the rows read so far say. Kept as it is between reads of a growing transcript. */
export interface Gauge {
  model: string | null
  usage: Usage | null
  /** When the request behind `usage` was answered. */
  usageAt: number | null
  /** How many compactions were read. */
  compactions: number
  last: Compaction | null
  /** Whether the last compaction came after the last request: then what is in use is its `after`, until the next one. */
  compactedSince: boolean
  /** The last `cost-state` row's total, and whether a request was made after it (then it is not the whole cost). */
  cost: number | null
  costSince: boolean
}

export const emptyGauge = (): Gauge => ({ model: null, usage: null, usageAt: null, compactions: 0, last: null, compactedSince: false, cost: null, costSince: false })

/** The rows this reads. A cheap test of the raw line before anything is parsed. */
const ROWS = /"type":"assistant"|"subtype":"compact_boundary"|"type":"cost-state"/

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0)
const timeOf = (value: unknown): number | null => {
  const at = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(at) ? at : null
}

/**
 * A request's usage as Claude Code counts it (`xD`, `EQ` in 2.1.310): the last of its `iterations`
 * that is a message, when it has any, else the usage itself. Null for a row that is no request of
 * the conversation's own: a subagent's (`isSidechain`), a synthetic one (an error Claude Code wrote
 * itself, model `<synthetic>`), an API error, or one that sent nothing.
 */
export function usageOf(row: Record<string, unknown>): { model: string | null; usage: Usage } | null {
  if (row.type !== 'assistant' || row.isSidechain === true || row.isApiErrorMessage === true) return null
  const message = row.message as { model?: unknown; usage?: unknown } | undefined
  if (!message || typeof message !== 'object') return null
  const model = typeof message.model === 'string' ? message.model.slice(0, 80) : null
  if (model === '<synthetic>') return null
  const said = message.usage as Record<string, unknown> | undefined
  if (!said || typeof said !== 'object') return null
  let from: Record<string, unknown> = said
  if (Array.isArray(said.iterations)) {
    const last = [...said.iterations].reverse().find((one) => {
      if (!one || typeof one !== 'object') return false
      const it = one as Record<string, unknown>
      return (it.type === 'message' || it.type === 'fallback_message') && count(it.input_tokens) + count(it.cache_creation_input_tokens) + count(it.cache_read_input_tokens) > 0
    })
    if (last) from = last as Record<string, unknown>
  }
  const usage = { input: count(from.input_tokens), cacheRead: count(from.cache_read_input_tokens), cacheWrite: count(from.cache_creation_input_tokens), output: count(from.output_tokens) }
  if (usage.input + usage.cacheRead + usage.cacheWrite === 0) return null
  return { model, usage }
}

/** The gauge after one more row. Rows of other kinds leave it as it was. */
export function readRow(gauge: Gauge, row: Record<string, unknown>): Gauge {
  const used = usageOf(row)
  if (used) {
    return { ...gauge, model: used.model ?? gauge.model, usage: used.usage, usageAt: timeOf(row.timestamp), compactedSince: false, costSince: gauge.cost !== null }
  }
  if (row.type === 'system' && row.subtype === 'compact_boundary') {
    const meta = (typeof row.compactMetadata === 'object' && row.compactMetadata !== null ? row.compactMetadata : {}) as Record<string, unknown>
    const trigger = typeof meta.trigger === 'string' && /^[a-z_-]{1,20}$/.test(meta.trigger) ? meta.trigger : 'auto'
    const before = typeof meta.preTokens === 'number' ? count(meta.preTokens) : null
    const after = typeof meta.postTokens === 'number' ? count(meta.postTokens) : null
    return { ...gauge, compactions: gauge.compactions + 1, last: { at: timeOf(row.timestamp), trigger, before, after }, compactedSince: true }
  }
  if (row.type === 'cost-state' && typeof row.totalCostUSD === 'number' && Number.isFinite(row.totalCostUSD) && row.totalCostUSD >= 0) {
    return { ...gauge, cost: row.totalCostUSD, costSince: false }
  }
  return gauge
}

/** The gauge after some whole lines of a transcript. A line that is not one of `ROWS`, or is not JSON (a slice that began mid-line), is passed over. */
export function readLines(text: string, gauge: Gauge = emptyGauge()): Gauge {
  let now = gauge
  for (const line of text.split('\n')) {
    if (!ROWS.test(line)) continue
    let row: unknown
    try {
      row = JSON.parse(line.trim())
    } catch {
      continue
    }
    if (row && typeof row === 'object' && !Array.isArray(row)) now = readRow(now, row as Record<string, unknown>)
  }
  return now
}

/* ------------------------------------------------------------------------ *
 * What the session's own status line says
 * ------------------------------------------------------------------------ */

/** The fields of Claude Code's status line JSON this module keeps (2.1.310). Nothing else of it is stored. */
export interface Status {
  /** When it arrived. */
  at: number
  session: string
  model: { id: string; name: string } | null
  window: number | null
  /** The input side in use, or null when Claude Code has no request to count from (a new or just compacted conversation). */
  tokens: number | null
  usage: Usage | null
  cost: number | null
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const text = (value: unknown, most: number): string | null => (typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, most) : null)

/** The status line JSON, as far as it is believed: a session id, numbers, and a model's id and name. Null for anything else. */
export function readStatus(raw: unknown, at: number): Status | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const said = raw as Record<string, unknown>
  const session = typeof said.session_id === 'string' && SESSION_ID.test(said.session_id) ? said.session_id : null
  if (!session) return null
  const model = (said.model && typeof said.model === 'object' ? said.model : {}) as Record<string, unknown>
  const id = text(model.id, 80)
  const window = (said.context_window && typeof said.context_window === 'object' ? said.context_window : {}) as Record<string, unknown>
  const size = typeof window.context_window_size === 'number' && Number.isFinite(window.context_window_size) && window.context_window_size >= 1_000 ? Math.floor(window.context_window_size) : null
  const current = window.current_usage && typeof window.current_usage === 'object' ? (window.current_usage as Record<string, unknown>) : null
  const usage = current ? { input: count(current.input_tokens), cacheRead: count(current.cache_read_input_tokens), cacheWrite: count(current.cache_creation_input_tokens), output: count(current.output_tokens) } : null
  const tokens = usage && usage.input + usage.cacheRead + usage.cacheWrite > 0 ? usage.input + usage.cacheRead + usage.cacheWrite : null
  const cost = (said.cost && typeof said.cost === 'object' ? said.cost : {}) as Record<string, unknown>
  return {
    at,
    session,
    model: id ? { id, name: text(model.display_name, 40) ?? modelName(id) } : null,
    window: size,
    tokens,
    usage: tokens === null ? null : usage,
    cost: typeof cost.total_cost_usd === 'number' && Number.isFinite(cost.total_cost_usd) && cost.total_cost_usd >= 0 ? cost.total_cost_usd : null,
  }
}

/* ------------------------------------------------------------------------ *
 * The two together: what is shown
 * ------------------------------------------------------------------------ */

/** A model's name as a person reads it: `claude-opus-5-5` is "Opus 5.5", `claude-sonnet-4-5-20250929` "Sonnet 4.5". */
export function modelName(id: string): string {
  const bare = id.replace(/\[1m\]/gi, '').replace(/-\d{8}$/, '')
  const said = /^claude-(?:(\d+(?:-\d+)?)-)?([a-z]+)(?:-(\d+(?:-\d+)?))?$/.exec(bare)
  if (!said) return id.slice(0, 40)
  const family = said[2]!.charAt(0).toUpperCase() + said[2]!.slice(1)
  const version = (said[3] ?? said[1] ?? '').replace('-', '.')
  return `${family}${version ? ` ${version}` : ''}${/\[1m\]/i.test(id) ? ' (1M)' : ''}`
}

/** A session's context, whole: what the page draws, the list's rows carry and the MCP tool says. */
export interface Context {
  /** The tokens in the window now, or null when nothing has been sent yet. */
  tokens: number | null
  window: number
  /** Whether Claude Code itself said the window (its status line), rather than the catalog. */
  windowSure: boolean
  percent: number | null
  /** About where Claude Code compacts by itself, and where it starts warning. */
  compactAt: number
  warnAt: number
  /** In use is at or past the warning level: "compacts soon". */
  soon: boolean
  model: { id: string; name: string } | null
  /** The session's cost so far, in US dollars: `live` from its status line, else the last one it wrote when it was cleared or ended. */
  cost: { usd: number; live: boolean } | null
  compacted: { times: number; last: Compaction } | null
  /** `tokens` is the compaction's own "after" figure: no request has been made since. */
  afterCompact: boolean
  /** The last request's own numbers, or null when there is none to show. */
  split: Usage | null
  /** Where the figure came from. */
  from: 'status' | 'transcript'
  /** When the figure was last true: the request, or the status line's report. */
  at: number | null
}

/**
 * What is shown for a session, from its transcript and — when it has one — its status line. The
 * status line is newer or as new for the figures it has (its window, cost and model are Claude
 * Code's own); the transcript knows what it does not: a compaction since the last request, and
 * how many there were.
 */
export function contextOf(gauge: Gauge | null, status: Status | null = null): Context | null {
  if (!gauge && !status) return null
  const g = gauge ?? emptyGauge()
  const fromTranscript = g.usage ? g.usage.input + g.usage.cacheRead + g.usage.cacheWrite : null
  const afterCompact = g.compactedSince && g.last?.after !== null && g.last?.after !== undefined
  /* After a compaction, before the next request, the window holds what it was compacted to. */
  const transcriptTokens = afterCompact ? g.last!.after! : fromTranscript
  const statusNewer = status !== null && status.tokens !== null && (g.usageAt === null || status.at >= g.usageAt) && !afterCompact
  const tokens = statusNewer ? status!.tokens : transcriptTokens
  const modelId = status?.model?.id ?? g.model
  if (tokens === null && !modelId && !g.compactions && g.cost === null && status?.cost == null) return null
  const { window, sure } = windowFor(modelId, tokens, status?.window ?? null)
  const { compactAt, warnAt } = thresholds(window, modelId)
  const cost = status?.cost != null ? { usd: status.cost, live: true } : g.cost !== null && !g.costSince ? { usd: g.cost, live: false } : null
  return {
    tokens,
    window,
    windowSure: sure,
    percent: tokens === null ? null : percentOf(tokens, window),
    compactAt,
    warnAt,
    soon: tokens !== null && tokens >= warnAt,
    model: status?.model ?? (g.model ? { id: g.model, name: modelName(g.model) } : null),
    cost,
    compacted: g.compactions && g.last ? { times: g.compactions, last: g.last } : null,
    afterCompact: !statusNewer && afterCompact,
    split: afterCompact ? null : statusNewer ? status!.usage : g.usage,
    from: statusNewer || (status !== null && tokens === null) ? 'status' : 'transcript',
    at: statusNewer ? status!.at : afterCompact ? (g.last?.at ?? null) : g.usageAt,
  }
}

/** A number of tokens as a person reads it: 823, 12k, 182k, 1.0M. */
export function tokensSaid(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  if (tokens < 999_500) return `${Math.round(tokens / 1_000)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

/** Dollars as a person reads them: $0.04, $3.20, $41. */
export function costSaid(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
}

/**
 * A context in words: the share (`41%`), the line beside a meter (`82k of 200k · 41%`), and the
 * warning, in words and never by colour alone (`82% — compacts soon`). Null words where there is
 * nothing to say.
 */
export function contextWords(context: Context): { percent: string; line: string; warning: string | null; title: string } {
  const pct = context.percent === null ? '—' : `${context.percent}%`
  const about = context.afterCompact ? 'about ' : ''
  const line = context.tokens === null ? 'nothing sent yet' : `${about}${tokensSaid(context.tokens)} of ${tokensSaid(context.window)} · ${pct}`
  const warning = context.soon ? (context.tokens !== null && context.tokens >= context.compactAt ? `${pct} — compacting` : `${pct} — compacts soon`) : null
  const parts = [
    context.tokens === null ? 'Context: nothing sent yet in this conversation' : `Context: ${about}${context.tokens.toLocaleString('en-US')} of ${context.window.toLocaleString('en-US')} tokens (${pct})${context.windowSure ? '' : ', window from the model'}`,
    `compacts by itself at about ${percentOf(context.compactAt, context.window)}%`,
    context.model ? context.model.name : '',
    context.cost ? `${costSaid(context.cost.usd)}${context.cost.live ? ' so far' : ' when it last stopped'}` : '',
    context.compacted ? `compacted ${context.compacted.times === 1 ? 'once' : `${context.compacted.times} times`}` : '',
  ]
  return { percent: pct, line, warning, title: parts.filter(Boolean).join(' · ') }
}
