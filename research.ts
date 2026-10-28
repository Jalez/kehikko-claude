import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * "Research complete": the Inbox event this module declares (protocol 2.31.0, `events` in the
 * manifest), and the one rule for when a subagent's finish is one.
 *
 * ## How a finished piece of research is told
 *
 *  - **The session's own agent** calls `tell_finished({ event: 'research-complete', label })` on
 *    this module's MCP door (`doors.ts`). The door knows the conversation by the place token on its
 *    URL, so only that conversation's agent (or one of its subagents, which call the same doors)
 *    can tag its item. The tag waits for the turn to end (`Stop`), and the session's finished item
 *    then names the event and carries the label.
 *  - **A subagent** that finishes (`SubagentStop`, through `tell.sh`) is one when it called the
 *    tool while it ran (the tag is newer than its `SubagentStart`), or when what it was asked to do
 *    reads as research (`isResearch`). It is then an item of its own, labelled with its
 *    description. Any other subagent finishing says nothing: that would be noise.
 *
 * ## What is read, and only that
 *
 * Of a subagent, its `agentType` and `description`, from the small sidecar Claude Code writes
 * beside its transcript (`agent-<id>.meta.json`, read through `subagentMeta`): the words the
 * session's agent gave it when it started it. Never its transcript, its prompt or its answer.
 */

export { EVENTS, EVENT_IDS, RESEARCH_EVENT } from './events.ts'

/** The words that make a subagent's description research. */
const RESEARCH_WORDS =
  /\b(research\w*|investigat\w*|find(?:ing)? out|look(?:ing)? into|compar\w*|audit\w*|survey\w*|explor\w*|analy[sz]\w*|stud(?:y|ies|ying)|review\w*|evaluat\w*|assess\w*|read(?:ing)? up)\b/i
/** For a read-only search agent, finding and tracing are research too. */
const SEARCH_WORDS = /\b(find\w*|search\w*|locat\w*|trac\w*|map(?:ping)?|understand\w*|learn\w*|where|how|which|why)\b/i
/** The agent types whose work is reading, not writing: Claude Code's own. */
const READING_AGENTS = new Set(['Explore', 'Plan', 'general-purpose'])

/**
 * Whether a finished subagent was doing research, from what it was asked to do: a description
 * with a research word, or — for an agent that only reads (`Explore`, `Plan`, `general-purpose`) —
 * one that asks it to find, search or trace something.
 */
export function isResearch(agent: { agentType?: string | null; description?: string | null }): boolean {
  const said = (agent.description ?? '').trim()
  if (!said) return false
  if (RESEARCH_WORDS.test(said)) return true
  return Boolean(agent.agentType && READING_AGENTS.has(agent.agentType) && SEARCH_WORDS.test(said))
}

/** An agent id as Claude Code gives one; nothing else is used in a path. */
export const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/
/** An agent type as a hook gives one. */
export const AGENT_TYPE = /^[A-Za-z0-9:._-]{1,64}$/

const META_BYTES = 64 * 1024
const DESCRIPTION_CHARS = 200

/**
 * A subagent's type and description, from the sidecar beside its transcript:
 * `<record folder>/<session>/subagents/[<subdir>/]agent-<id>.meta.json`, where the session's own
 * record is `<record folder>/<session>.jsonl`. Null when there is none, or it is not what it should be.
 */
export function subagentMeta(sessionRecord: string, session: string, agent: string): { agentType: string | null; description: string | null } | null {
  if (!AGENT_ID.test(agent) || !/^[0-9a-f-]{1,64}$/.test(session)) return null
  const root = join(dirname(sessionRecord), session, 'subagents')
  const name = `agent-${agent}.meta.json`
  const candidates = [join(root, name)]
  try {
    for (const one of readdirSync(root, { withFileTypes: true })) if (one.isDirectory()) candidates.push(join(root, one.name, name))
  } catch {
    return null
  }
  for (const file of candidates) {
    try {
      if (statSync(file).size > META_BYTES) continue
      const read = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      if (typeof read !== 'object' || read === null) continue
      const agentType = typeof read.agentType === 'string' ? read.agentType.slice(0, 64) : null
      const description = typeof read.description === 'string' ? read.description.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_CHARS) : null
      return { agentType, description }
    } catch {
      /* Not there, or not JSON: the next. */
    }
  }
  return null
}

/** What the session's agent said it finished, waiting for the turn or a subagent to end. */
export interface Told {
  event: string
  label: string
  at: number
}

/** A subagent's finished research, as an item of its own until the person opens the session. */
export interface Found {
  agent: string
  event: string
  label: string
  at: number
}

/** How many subagent items one session keeps at most; the oldest go first. */
export const FOUND_MOST = 8
