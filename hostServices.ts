import {
  CONVERSATION_MATCHES,
  LIMITS,
  agentTaskStartParams,
  conversationsBringParams,
  conversationsFindParams,
  sameConversationPlace,
  type AgentTaskStartParams,
  type AgentTaskStartResult,
  type ConversationCandidate,
  type ConversationMatch,
  type ConversationPlace,
  type ConversationsBringParams,
  type ConversationsBringResult,
  type ConversationsFindParams,
} from 'kehikot-module-protocol'
import { acceptTask, vouchHost, type Before } from 'kehikot-module-protocol/serve'

import { freshToken } from './doorConfig.ts'
import { NOWHERE, theRuns } from './live.ts'
import { ID } from './manifest.ts'
import { isKehikkoKey, placeKey, sortedParts } from './place.ts'
import { PROGRAM, headOf, type Program, type Recorded } from './program.ts'
import { assign, disconnect, homeOf, projectRoot, readPlaces, recordedIds, tokenFor, type NamedPlace, type PlaceEntry, type Places } from './record.ts'

/**
 * The two services this module provides to the HOST (protocol 2.88.0), when a person adopts a pull
 * or merge request (or an issue) that belongs to no epic, with the Claude Code conversation that
 * worked on it outside Kehikot.
 *
 * - `conversations.finder` — `find`: which of this project's Claude Code conversations worked on
 *   that change; `bring`: file one of them under a place, what `/kehikot-here` does (`here.ts`), as a
 *   compare-and-set so another place's conversation is never taken.
 * - `agent.tasks` — `start`: a NEW conversation fed a brief as its first prompt, the way a
 *   conversation is started for a message (`startTask` in live.ts, beside `resumeFor`). It ANSWERS at
 *   once (protocol 2.99.0): the project and Claude Code being installed are checked, the task is
 *   accepted under a handle (`pending`), and Claude Code is started after the answer — `--bg` boots a
 *   process, the host is asked for the session's doors, the skills are gathered, `agents --json` is
 *   asked until it lists the session. That took longer than the host waits, and the person was told
 *   Claude did not answer while the conversation started anyway. What it came to is reported to the
 *   host (`tasks.report`, `acceptTask`): a failure is said in the person's Inbox.
 *
 * Only the host's own server may call them: every route is held to `vouchHost` before its body is
 * read, and anything else is a 403. They are a `Before` door (the protocol's `beforeDoors` on Vite,
 * `run({ before })` built), because the doors' `answer` is not handed the request's headers.
 *
 * ## What `find` reads, and what it can tell
 *
 * Only what this module already reads of Claude Code's conversations: the project's session listing
 * (`Program.sessions`: the head and the tail of each record in the project's own Claude Code folder,
 * and the ids the project's record names elsewhere) and `claude agents --json` for what is running.
 * Of a record that is its title, first and last prompt, the `pr-link` rows Claude Code writes when a
 * conversation opens a pull request, and the `gitBranch` each row carries. From those:
 *
 * - `created`: a `pr-link` row names the change (its URL, or its number in its repository);
 * - `branch`: the record's rows say it was on the change's branch;
 * - `mentioned`: its title, first or last prompt names the ref or the URL;
 * - `folder`: any other conversation of the project — it worked in this repository.
 *
 * `pushed` is never said: telling a push from the rest of a conversation would mean reading its
 * tool calls, which this module does not read. A conversation a person said is no Kehikot one
 * (`ignored`) is not offered. Titles and reasons only, never a transcript's words.
 */

/* ------------------------------------------------------------------ the change, as asked */

interface Spelled {
  /** As the host spelled it, for the reason ("created !4721"). */
  said: string
  number: number | null
  /** `owner/repo` (or a GitLab path) when the spelling names one, lower case. */
  repo: string | null
}

/** A repository path as compared: lower case, no host, no `.git`, no slashes at its ends. */
function repoOf(raw: string | null | undefined): string | null {
  if (!raw) return null
  let said = raw.trim().toLowerCase()
  said = said.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^git@([^:]+):/, '$1/')
  said = said.replace(/\.git$/, '').replace(/^\/+|\/+$/g, '')
  /* A host in front (`github.com/owner/repo`): what follows it. */
  const parts = said.split('/')
  if (parts.length > 2 && parts[0]!.includes('.')) said = parts.slice(1).join('/')
  return said || null
}

const sameRepo = (a: string | null, b: string | null): boolean => Boolean(a && b && (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)))

/** `#12`, `!12`, `owner/repo#12`, `group/sub/project!12`: its number and its repository. */
export function readRef(raw: string): Spelled {
  const said = raw.trim()
  const found = /^(.*?)([#!])(\d{1,12})$/.exec(said)
  if (!found) return { said, number: null, repo: null }
  return { said, number: Number(found[3]), repo: repoOf(found[1]) }
}

/** A pull or merge request's address: its repository and number, or null. */
export function readChangeUrl(raw: string | null | undefined): { repo: string; number: number } | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const found = /^\/(.+?)\/(?:-\/)?(?:pull|pulls|merge_requests|issues)\/(\d{1,12})(?:\/|$)/.exec(url.pathname)
  if (!found) return null
  const repo = repoOf(found[1])
  return repo ? { repo, number: Number(found[2]) } : null
}

/** An address as compared: host and path, lower case, without a query, a fragment or a trailing slash. */
function sameAddress(a: string, b: string): boolean {
  const norm = (raw: string) => {
    try {
      const url = new URL(raw)
      return `${url.host}${url.pathname}`.toLowerCase().replace(/\/+$/, '')
    } catch {
      return null
    }
  }
  const one = norm(a)
  return one !== null && one === norm(b)
}

/** Whether a `pr-link` of the record is the change asked about. */
function isTheChange(pr: { number: number; url: string }, asked: ConversationsFindParams, spelled: readonly Spelled[]): boolean {
  if (asked.url && sameAddress(pr.url, asked.url)) return true
  const linked = readChangeUrl(pr.url)
  if (!linked) return false
  const fromUrl = readChangeUrl(asked.url)
  const repo = repoOf(asked.repo) ?? fromUrl?.repo ?? null
  return spelled.some((one) => one.number === linked.number && (one.repo ? sameRepo(one.repo, linked.repo) : repo ? sameRepo(repo, linked.repo) : true))
}

/** Whether a line names the ref or the address: as a whole, not the start of a longer number. */
function names(line: string, spellings: readonly string[]): string | null {
  const text = line.toLowerCase()
  for (const spelling of spellings) {
    const wanted = spelling.trim().toLowerCase()
    if (wanted.length < 2) continue
    let at = text.indexOf(wanted)
    while (at >= 0) {
      const after = text.charAt(at + wanted.length)
      if (!/[0-9]/.test(after)) return spelling.trim()
      at = text.indexOf(wanted, at + 1)
    }
  }
  return null
}

/* ------------------------------------------------------------------ where a conversation is filed */

/** A place of the record as the protocol says one; null for the project itself (no epic, no parts, no kehikko). */
export function conversationPlaceOf(entry: PlaceEntry | null | undefined): ConversationPlace | null {
  if (!entry) return null
  const kehikko = entry.kehikko?.key && isKehikkoKey(entry.kehikko.key) ? entry.kehikko.key : null
  if (!entry.epic && entry.parts.length === 0 && !kehikko) return null
  return { epic: entry.epic, parts: sortedParts(entry.parts), kehikko }
}

/** Where the record files a conversation now, as the protocol says it. */
export function filedUnder(places: Places, id: string): ConversationPlace | null {
  const home = homeOf(places, id)
  return home && Object.hasOwn(places.places, home) ? conversationPlaceOf(places.places[home]) : null
}

/** A protocol place as this module's: the project itself for null. */
export function namedPlace(place: ConversationPlace | null): NamedPlace {
  if (!place) return { ...NOWHERE }
  return { epic: place.epic, parts: sortedParts(place.parts), kehikko: place.kehikko ? { key: place.kehikko } : null }
}

/* ------------------------------------------------------------------ the three */

export interface HostNeeds {
  program: Program
  /** Whether this module holds the conversation's terminal now (a run of its own, not ended). */
  holds(session: string): boolean
  /** The record changed under this project: what `here.ts` tells (`Runs.told`). */
  told(projectPath: string, assigned?: { key: string; session: string }): void
  /** Start a new conversation with a first prompt (`Runs.startTask`); `handle`, what `start` answered, is followed to it. */
  start(projectPath: string, place: NamedPlace, brief: string, title: string, handle?: string): Promise<{ ok: true; session: string } | { ok: false; why: string }>
  /** Where `tasks.report` goes, for a test (the host this module was started by, otherwise). */
  report?: { env?: Record<string, string | undefined>; fetch?: typeof fetch; log?: (line: string) => void }
  /** Whether the host's server sent this request (`vouchHost`). */
  vouch(headers: Headers): Promise<{ ok: true } | { ok: false; why: string }>
}

/** The most candidates one answer carries. */
const MOST = 20

const clip = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text)

/** What Claude Code says is running, by session; empty when it cannot be asked. */
async function runningIds(program: Program): Promise<Set<string>> {
  const file = program.find().file
  if (!file || !(await program.supports(file)).lists) return new Set()
  const running = await program.active(file)
  return new Set(running.known ? running.active.map((one) => one.session) : [])
}

/** `find`: this project's conversations that worked on the change, strongest match first, then newest. */
export async function findConversations(asked: ConversationsFindParams, needs: Pick<HostNeeds, 'program' | 'holds'>): Promise<ConversationCandidate[]> {
  const root = projectRoot(asked.project)
  if (!root.ok) return []
  const project = root.value
  const read = readPlaces(project)
  const places = read.ok ? read.value : { version: 1 as const, places: {}, sessions: {} }
  const listed = await needs.program.sessions(project, recordedIds(places))
  const held = new Map<string, Recorded>(listed.map((one) => [one.id, one]))
  const live = await runningIds(needs.program)
  const spelled = asked.refs.map(readRef)
  const spellings = [...asked.refs, ...(asked.url ? [asked.url] : [])]
  const branch = asked.branch?.trim() || null
  const rank = (match: ConversationMatch) => CONVERSATION_MATCHES.indexOf(match)

  /* One answer per conversation: an id it was carried on from counts for the id it is under now (`headOf`). */
  const best = new Map<string, { match: ConversationMatch; reason: string }>()
  for (const one of listed) {
    let found: { match: ConversationMatch; reason: string }
    const pr = (one.prs ?? []).find((link) => isTheChange(link, asked, spelled))
    const mentioned = names([one.label, one.firstPrompt ?? '', one.lastPrompt ?? ''].join('\n'), spellings)
    if (pr) found = { match: 'created', reason: `created ${asked.refs[0]!.trim()}` }
    else if (branch && (one.branches ?? []).includes(branch)) found = { match: 'branch', reason: `worked on branch ${branch}` }
    else if (mentioned) found = { match: 'mentioned', reason: `mentioned ${mentioned}` }
    else found = { match: 'folder', reason: 'worked in this repository' }
    const head = headOf(one.id, held, live)
    const had = best.get(head)
    if (!had || rank(found.match) < rank(had.match)) best.set(head, found)
  }

  const out: ConversationCandidate[] = []
  for (const [id, found] of best) {
    const entry = Object.hasOwn(places.sessions, id) ? places.sessions[id] : undefined
    if (entry?.ignored) continue
    const recorded = held.get(id)
    out.push({
      session: id,
      title: clip((recorded?.label || entry?.label || '').replace(/\s+/g, ' ').trim(), LIMITS.TITLE),
      folder: project,
      lastActive: Math.max(0, Math.trunc(recorded?.lastActive ?? 0)),
      match: found.match,
      reason: clip(found.reason, LIMITS.REASON),
      place: filedUnder(places, id),
      running: live.has(id) || needs.holds(id),
    })
  }
  return out.sort((a, b) => rank(a.match) - rank(b.match) || b.lastActive - a.lastActive).slice(0, MOST)
}

/**
 * `bring`: file the conversation under `to` (the project itself for null) only if it is under
 * `from` now — what "Assign here" and `/kehikot-here` write (`assign`), and `/kehikot-here off`
 * (`disconnect`) for null. A running conversation is not restarted: the record is what its doors
 * read its place from, so one whose terminal this module holds has it at once (`resumed`).
 */
export async function bringConversation(asked: ConversationsBringParams, needs: Pick<HostNeeds, 'program' | 'holds' | 'told'>): Promise<ConversationsBringResult> {
  const root = projectRoot(asked.project)
  if (!root.ok) return { outcome: 'declined', place: null, resumed: false, why: clip(root.error, LIMITS.REASON) }
  const project = root.value
  /* A handle `start` answered (protocol 2.99.0) stands for the conversation it started. */
  const id = theRuns().sessionOf(asked.session)
  if (!needs.program.isId(id)) return { outcome: 'no-such-session', place: null, resumed: false, why: 'That is not a Claude Code conversation’s id.' }
  const read = readPlaces(project)
  if (!read.ok) return { outcome: 'declined', place: null, resumed: false, why: clip(read.error, LIMITS.REASON) }
  const places = read.value
  const recorded = Object.hasOwn(places.sessions, id) || Object.values(places.places).some((entry) => entry.sessions.includes(id))
  if (!recorded && !(await needs.program.settled(project, id, 0))) {
    return { outcome: 'no-such-session', place: null, resumed: false, why: 'Claude Code has no conversation by that id for this project on this computer.' }
  }
  const now = filedUnder(places, id)
  if (!sameConversationPlace(now, asked.from)) {
    return { outcome: 'elsewhere', place: now, resumed: false, why: 'It is filed under another place now, so nothing was changed.' }
  }
  const resumed = needs.holds(id)
  if (sameConversationPlace(now, asked.to)) return { outcome: 'brought', place: now, resumed, why: '' }
  if (!asked.to) {
    const written = disconnect(project, id)
    if (!written.ok) return { outcome: 'declined', place: now, resumed: false, why: clip(written.error, LIMITS.REASON) }
    needs.told(project)
    return { outcome: 'brought', place: null, resumed, why: '' }
  }
  const place = namedPlace(asked.to)
  const written = assign(project, place, id)
  if (!written.ok) return { outcome: 'declined', place: now, resumed: false, why: clip(written.error, LIMITS.REASON) }
  /* Its token, so the doors of a session this module gives them know its place now (as `here.ts`). */
  tokenFor(project, id, freshToken)
  needs.told(project, { key: placeKey(place), session: id })
  return { outcome: 'brought', place: conversationPlaceOf(written.value.places[placeKey(place)]), resumed, why: '' }
}

/**
 * `start`: a new conversation in the project, fed the brief, filed under the place (the project itself
 * for null). Answered at once (protocol 2.99.0): declined when the folder is no project or Claude Code
 * is not installed, else accepted under a handle while Claude Code starts after the answer.
 */
export async function startTask(asked: AgentTaskStartParams, needs: Pick<HostNeeds, 'start' | 'program' | 'report'>): Promise<AgentTaskStartResult> {
  const root = projectRoot(asked.project)
  if (!root.ok) return { outcome: 'declined', session: null, why: clip(root.error, LIMITS.REASON), pending: false }
  if (!needs.program.find().file) return { outcome: 'declined', session: null, why: `${needs.program.name} is not installed on this computer.`, pending: false }
  const handle = needs.program.newId()
  const place = namedPlace(asked.place)
  return acceptTask(
    handle,
    async () => {
      const started = await needs.start(root.value, place, asked.brief, asked.title, handle)
      return started.ok ? { ok: true, conversation: started.session } : { ok: false, why: clip(started.why, LIMITS.REASON) }
    },
    { module: ID, ...needs.report, log: needs.report?.log ?? ((line) => console.log(`claude: ${line}`)) },
  )
}

/* ------------------------------------------------------------------ the door */

/** Where each answers: what the manifest's `services` say (manifest.ts). */
export const FIND_PATH = '/api/conversations/find'
export const BRING_PATH = '/api/conversations/bring'
export const START_PATH = '/api/tasks/start'

/** The largest body read: a brief, and room around it. */
const BODY_MOST = 64 * 1024

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/** The three routes as one `Before`, each held to the host before its body is read. */
export function hostDoor(needs: () => HostNeeds): Before {
  return async (request, { url }) => {
    const path = url.pathname
    if (path !== FIND_PATH && path !== BRING_PATH && path !== START_PATH) return undefined
    if (request.method !== 'POST') return json({ ok: false, error: 'this door takes POST' }, 405)
    const said = needs()
    const vouched = await said.vouch(request.headers)
    if (!vouched.ok) return json({ ok: false, error: vouched.why }, 403)
    let body: unknown
    try {
      const text = await request.text()
      if (text.length > BODY_MOST) return json({ ok: false, error: 'that body is too large' }, 413)
      body = JSON.parse(text)
    } catch {
      return json({ ok: false, error: 'the body must be JSON' }, 400)
    }
    if (path === FIND_PATH) {
      const parsed = conversationsFindParams.safeParse(body)
      if (!parsed.success) return json({ ok: false, error: 'that is not a find: { project, refs, url?, branch?, repo? }' }, 400)
      return json({ conversations: await findConversations(parsed.data, said) })
    }
    if (path === BRING_PATH) {
      const parsed = conversationsBringParams.safeParse(body)
      if (!parsed.success) return json({ ok: false, error: 'that is not a bring: { project, session, to, from }' }, 400)
      return json(await bringConversation(parsed.data, said))
    }
    const parsed = agentTaskStartParams.safeParse(body)
    if (!parsed.success) return json({ ok: false, error: 'that is not a task: { project, brief, place, title }' }, 400)
    return json(await startTask(parsed.data, said))
  }
}

/** The door as this module's server mounts it: the one `Runs`, Claude Code, and the host's own vouching. */
export const HOST_DOOR: Before = hostDoor(() => {
  const runs = theRuns()
  return {
    program: PROGRAM,
    holds: (session) => {
      const run = runs.find(session)
      return Boolean(run && !run.ended)
    },
    told: (projectPath, assigned) => runs.told(projectPath, assigned),
    start: (projectPath, place, brief, title, handle) => runs.startTask(projectPath, place, brief, title, handle),
    vouch: (headers) => vouchHost(headers),
  }
})
