import { PROJECT_ID, doorContext } from 'kehikot-module-protocol'
import { establishBuild, hostHasProject, refuseTicket, sameTicket, type Reply, type Stream } from 'kehikot-module-protocol/serve'

import { TICKET, elsewhereOf, sameProject, theRuns, type Elsewhere, type Run, type Runs } from './live.ts'
import { ID, MANIFEST, VERSION } from './manifest.ts'
import { isKehikkoKey, kehikkoOf, placeKey, readPlaceKey, type Place } from './place.ts'
import { PROGRAM, headOf, home, type Program, type Recorded, type Running, type State } from './program.ts'
import { PLACE_TOKEN, WHERE, assign, detach, follow, homeOf, ignore, ownOf, projectRoot, readPlaces, recordedIds, rekey, sessionsAt, unassigned, type Places } from './record.ts'
import { enable, enabled, hookCommand, settingsFile } from './hook.ts'

/**
 * The HTTP doors, as one function: `answer` takes a request and returns a
 * status and a body, or `null` for "not ours, let Vite have it". `doors()` in
 * vite.config.ts is the only thing that touches a socket, which is what lets
 * the tests call this directly.
 *
 * Almost everything this module does happens on the socket in `live.ts`.
 * What is here is what the page needs to know BEFORE it opens one — which
 * sessions this place has, whether the program is installed — and the two
 * things a person can do to a session that are not typing into it.
 *
 * ## Reads carry the ticket too
 *
 * `GET /api/place` says what somebody has been working on: the first line of
 * each session's first prompt, and when. Terminal deleted the one door it had
 * like that (`/api/chats`) and was right to. This one is needed — it is the
 * list the person chooses from — so it is fenced the way a write is: the
 * ticket this process printed into its own page. The MCP door says the same
 * things to an agent without one, because an agent has no page to have been
 * handed a ticket by; what fences that is what fences every module's MCP
 * door, the loopback bind and the absence of any CORS header.
 *
 * ## Nothing here starts anything
 *
 * A session is started by the socket's first frame, from the page, and the
 * installer by a press in the page. No door below runs a program, and the MCP
 * door has one tool, which reads.
 *
 * ## One door is not the page's
 *
 * `POST /api/state` is where a session's own program says what it is doing
 * (see "Told, not read" in live.ts). It carries no page ticket and is not
 * asked for one: what it must carry is the secret of the one session it
 * speaks for, in the same header. It answers 204 to a report it took and 403
 * to everything else — a wrong secret, no secret, a session that is not
 * running — in one sentence that does not say which. It reads no body, and
 * nothing in a report is stored or shown.
 */

export { TICKET }

/** Whether the host holds a folder as a project: the protocol's question, here so a test can stand a host in. */
export const hostCheck = { has: (folder: string) => hostHasProject(folder) }

/** What this process is built from, said in the manifest, at `/healthz`, in the page and on every answer. */
export const BUILD = establishBuild({ version: VERSION, dir: import.meta.dirname })

const ok = (body: unknown): Reply => ({ status: 200, body })
const bad = (why: string, status = 400): Reply => ({ status, body: { ok: false, error: why } })

/** One session, as a row in a list. */
export interface Row {
  id: string
  /** What it is called: its name, else Claude Code's title for it, else its first prompt. `''` when it has none yet. */
  label: string
  /** The first line of its first prompt, when that is not already the label. */
  firstPrompt?: string
  /** The last thing its person said. */
  lastPrompt?: string
  /** The pull requests it opened or pushed to, newest last. */
  prs?: { number: number; url: string }[]
  /** Milliseconds, or null when nothing is known. */
  lastActive: number | null
  /** Whether this module is running it now. */
  running: boolean
  /**
   * What its program last said it is doing, and since when — for one that is
   * running and has said. Absent otherwise: a copy too old to say, a session
   * nobody has spoken to yet, one that is not running.
   */
  state?: State
  since?: number
  /**
   * Set when the record lists it for this place and Claude Code has nothing
   * by that id on this computer: it ran on another one, or its transcript has
   * been cleaned away here. It cannot be opened, and is shown so that the
   * list agrees with the file.
   */
  missing?: true
  /**
   * Set when Claude Code is running it in a process this module did not
   * start, as the program itself said a moment ago (`agents --json`):
   * `background` is a session with no terminal, and opening it here attaches
   * to it — no second process; anything else is open in a terminal or an
   * editor, cannot be attached to, and opening it here asks first. Absent
   * when nothing else has it, and when the program cannot be asked.
   */
  elsewhere?: Elsewhere
  /**
   * For one this module is running: `background` when what runs here is a
   * view of a background session, `copy` when a person opened it here beside
   * another process that has it too. Absent for a session that is only here.
   */
  as?: 'background' | 'copy'
  /**
   * Among the project's others: the places of the SAME EPIC that already
   * hold this session — under other parts, or on another kehikko — in words.
   * Those are the ones most likely to be wanted, and they are listed first.
   */
  near?: string[]
}

export interface Listing {
  ok: true
  program: {
    name: string
    /** The binary, or null when it was not found. `foundAt` is the same with the home folder as `~`. */
    found: string | null
    foundAt: string | null
    looked: string[]
    /** The same, short enough for one sentence: PATH as one word, then the usual places. */
    where: string
    /** What an installed copy lacks, when it is too old to use. Null otherwise. */
    lacks: string | null
    install: { line: string; lands: string }
    /**
     * Whether the program could be asked what is running elsewhere: `yes`, or
     * why not. `too-old` is a copy from before `agents --json` and `attach`;
     * its rows never say `elsewhere`, which is then not the same as nothing
     * running elsewhere.
     */
    asked: 'yes' | 'too-old' | 'failed'
  }
  /** The sessions of this place, in the order they were added. */
  sessions: Row[]
  /** The one last open here, which opens directly. Null, or absent, when the place has none. */
  current?: string | null
  /** This place's OWN conversation: the one its frame names as its own. Null when it has none. */
  own?: string | null
  /** Where each listed conversation belongs, by id, when it belongs to another place: that place in a few words. */
  homes?: Record<string, string>
  /**
   * The project's conversations that belong to no place: reported started by Claude Code's hook,
   * or running (`agents --json`) in this folder with no record. Each can be assigned here.
   */
  unassigned?: Row[]
  /**
   * The project's other places an unassigned conversation can be assigned to: every place the
   * record knows on a kehikko, but this one. Grouped by kehikko, each kehikko's most recently used
   * place first — the one a person most likely means by "that kehikko".
   */
  assignable?: Assignable[]
  /** This place's own conversation as the record has it (what "Assign here" keeps or replaces), or null for none. */
  ownNow?: OwnConversation | null
  /** Whether sessions started outside Kehikot are reported here (the SessionStart hook is installed). */
  hook?: boolean
  /**
   * The project's other sessions: they belong to no place, or to another.
   * The ones another place of this epic holds first (`near`), then the rest,
   * each by when it was last active.
   */
  others: Row[]
  /**
   * Everything running, in any project. Said, and not counted against
   * anything: there is no number of sessions at which an open is refused.
   */
  running: { id: string; label: string; projectPath: string; place: string | null; here: boolean; startedAt: number; state?: State; since?: number }[]
}

/** A state in words an agent reads without the key to `needs-you`. */
const DOING = { working: 'working on a turn', 'needs-you': 'waiting for its person (a permission or an answer)', finished: 'its turn is over; at its prompt' } as const

/** A running session's state, as the fields a row carries: nothing when nothing is known. */
const stated = (run: Run | undefined): { state?: State; since?: number } => (run?.state ? { state: run.state, since: run.stateSince } : {})

/**
 * Where a session is running besides here, as a row says it.
 *
 * For one this module runs, what the run itself knows: the background
 * session it is a view of, or the process it was opened as a copy beside.
 * For one it does not, what the program said just now.
 */
function besides(id: string, run: Run | undefined, running: Running, runs: Runs): { elsewhere?: Elsewhere; as?: 'background' | 'copy' } {
  if (run) {
    if (run.joined) return { elsewhere: elsewhereOf(run.joined), as: 'background' }
    if (run.copyOf) return { elsewhere: elsewhereOf(run.copyOf), as: 'copy' }
    return {}
  }
  const { background, open } = runs.others(running, id)
  const there = background ?? open
  return there ? { elsewhere: elsewhereOf(there) } : {}
}

/** A place an unassigned conversation can be assigned to, in words. */
export interface Assignable {
  key: string
  /** The kehikko's name, by which the choices are grouped. */
  kehikko: string
  /** The epic and parts: "thesis · methods + results", "thesis · whole epic", "no epic". */
  label: string
  /** That place's own conversation — what assigning here would keep or replace — or null when it has none yet. */
  own: OwnConversation | null
}

/** A place's own conversation, said by title and when it was last active. */
export interface OwnConversation {
  id: string
  /** Its title; `''` when it has none yet (the page says "untitled"). */
  title: string
  lastActive: number | null
}

/**
 * The places, other than `key`, that a conversation can be assigned to: those on a kehikko, by
 * kehikko (in the order each was last used), most recently used first within each. At most `most`.
 */
export function assignable(places: Places, key: string, most = 24, own: (id: string) => OwnConversation = (id) => recordedOwn(places, id)): Assignable[] {
  const used = (entry: Places['places'][string]) =>
    Math.max(0, ...entry.sessions.map((id) => Date.parse((Object.hasOwn(places.sessions, id) ? places.sessions[id]?.lastActive : null) ?? '') || 0))
  const rows = Object.entries(places.places)
    .filter(([one, entry]) => one !== key && entry.kehikko !== null)
    .map(([one, entry]) => ({
      key: one,
      kehikko: entry.kehikko?.name || 'a kehikko',
      label: entry.epic ? `${entry.epic} · ${entry.parts.length ? entry.parts.join(' + ') : 'whole epic'}` : 'no epic',
      own: ownOf(places, one) ? own(ownOf(places, one)!) : null,
      used: used(entry),
    }))
    .sort((a, b) => b.used - a.used)
  const order = [...new Set(rows.map((one) => one.kehikko))]
  return order.flatMap((name) => rows.filter((one) => one.kehikko === name)).slice(0, most).map(({ used: _used, ...rest }) => rest)
}

/** A conversation as the record alone knows it: the title it was given, and when it was last active. */
function recordedOwn(places: Places, id: string): OwnConversation {
  const kept = Object.hasOwn(places.sessions, id) ? places.sessions[id] : undefined
  const at = kept?.lastActive ? Date.parse(kept.lastActive) : NaN
  return { id, title: kept?.label ?? '', lastActive: Number.isFinite(at) ? at : null }
}

/** A recorded place in a few words: its parts, or "whole epic", and what its kehikko is called. */
function placeSaid(entry: Places['places'][string]): string {
  return [entry.parts.length ? entry.parts.join(' + ') : 'whole epic', entry.kehikko?.name || ''].filter(Boolean).join(' · ')
}

/**
 * The project's sessions that are not this place's, most likely wanted first:
 * the ones another place of the SAME EPIC holds — other parts, another
 * kehikko — and then the rest, each group by when it was last active (which
 * is the order `held` arrives in).
 *
 * A place with no epic has no "same epic": nothing is near it.
 */
export function ordered(held: readonly Recorded[], here: readonly string[], key: string, places: Places): { one: Recorded; near: string[] }[] {
  const epic = readPlaceKey(key)?.epic ?? null
  const all = held
    .filter((one) => !here.includes(one.id))
    .map((one) => ({
      one,
      near: epic === null ? [] : Object.entries(places.places).filter(([other, entry]) => other !== key && entry.epic === epic && entry.sessions.includes(one.id)).map(([, entry]) => placeSaid(entry)),
    }))
  return [...all.filter((each) => each.near.length), ...all.filter((each) => !each.near.length)]
}

/**
 * What the page draws a place from.
 *
 * A place's sessions are the ones the record lists for it, plus any that is
 * running for it and does not exist yet — a new session nobody has spoken to
 * is in memory only (see `record.ts`), and a page that reloads has to find it
 * rather than start a second one beside it.
 */
export async function listing(
  projectPath: string,
  key: string,
  runs: Runs = theRuns(),
  program: Program = PROGRAM,
  /** The project's permanent id (`context.projectId`), when the page has one: what a run is matched by. */
  projectId: string | null = null,
): Promise<Listing | { ok: false; error: string }> {
  const root = projectRoot(projectPath)
  if (!root.ok) return root
  if (!readPlaceKey(key)) return { ok: false, error: 'That is not a place.' }
  const recorded = readPlaces(root.value)
  if (!recorded.ok) return recorded
  /* The page framed in this project: the background sessions of all its places are listed from now on, viewed or not. */
  runs.know(root.value)

  const found = program.find()
  const able = found.file ? await program.supports(found.file) : { ok: true, missing: null, tells: false, lists: false }
  const live = runs.sessions()
  /* A session started before this project's folder was renamed is still this project's: it is
     followed to the new folder (`claim`), never matched by the path string alone. */
  for (const run of live) runs.claim(run, root.value, projectId)
  const ours = (run: Run) => sameProject(run, root.value, projectId)
  /* A running session that had not been recorded, or named, the last time the
     program spoke may have been since: somebody is about to read the list. */
  await Promise.all(live.filter((run) => !run.settled || !run.label).map((run) => runs.settle(run).catch(() => {})))
  /* With the ids the record names, which may be under the folder's old name (a renamed project). */
  const all = await program.sessions(root.value, recordedIds(recorded.value))
  const known = new Map(all.map((one) => [one.id, one]))
  /* Asked now, for this list, and kept nowhere: what is running elsewhere a
     moment from now is asked again when a session is opened (live.ts). */
  const running: Running = found.file && able.ok ? await runs.running(found.file) : { known: false, why: 'failed' }

  /* A conversation Claude Code carried on under a new id is listed under the new one: the old id
     is a step behind it, and opening it would start another copy of an old point in it. The
     record is brought along, so that the next open — here or anywhere — goes straight there. */
  const holding = new Set<string>([...(running.known ? running.active.map((one) => one.session) : []), ...runs.sessions().flatMap((run) => (run.settled ? [run.settled] : []))])
  let read = recorded
  for (const id of sessionsAt(recorded.value, key)) {
    const head = headOf(id, known, holding)
    if (head === id) continue
    const moved = follow(root.value, id, head, { label: known.get(head)?.label, lastActive: known.get(head)?.lastActive })
    if (!moved.ok) continue
    const again = readPlaces(root.value)
    if (!again.ok) return again
    read = again
  }
  /* What has been carried on elsewhere is not offered beside where it went. */
  const held = all.filter((one) => !(one.next ?? []).some((next) => known.has(next)))

  /* A session running in this folder that nothing here started and no place holds is a fact
     about this project too: listed as not yet assigned, never guessed into a place. */
  if (running.known) {
    for (const one of running.active) {
      if (one.cwd !== root.value || live.some((run) => run.id === one.session || run.settled === one.session)) continue
      if (!homeOf(read.value, one.session)) runs.sighted(root.value, one.session, 'agents', one.name)
    }
    const again = readPlaces(root.value)
    if (again.ok) read = again
  }

  const row = (id: string): Row => {
    const run = live.find((one) => one.id === id || one.settled === id)
    const kept = Object.hasOwn(read.value.sessions, id) ? read.value.sessions[id] : undefined
    const keptAt = kept?.lastActive ? Date.parse(kept.lastActive) : NaN
    const said = known.get(id)
    const label = said?.label || run?.label || kept?.label || ''
    return {
      id,
      label,
      ...(said?.firstPrompt && said.firstPrompt !== label ? { firstPrompt: said.firstPrompt } : {}),
      ...(said?.lastPrompt && said.lastPrompt !== label ? { lastPrompt: said.lastPrompt } : {}),
      ...(said?.prs?.length ? { prs: said.prs } : {}),
      lastActive: known.get(id)?.lastActive ?? (Number.isFinite(keptAt) ? keptAt : (run?.startedAt ?? null)),
      running: Boolean(run),
      ...stated(run),
      /* Neither the program's nor running: all there is of it here is the row in the record. */
      ...(known.has(id) || run ? {} : { missing: true as const }),
      ...besides(id, run, running, runs),
    }
  }

  const here = sessionsAt(read.value, key)
  for (const run of live) {
    const id = run.settled ?? run.id
    if (ours(run) && run.key === key && !here.includes(id)) here.push(id)
  }

  const install = program.install()
  return {
    ok: true,
    program: {
      name: program.name,
      found: found.file,
      foundAt: found.file ? tidy(found.file) : null,
      looked: found.looked,
      where: lookedIn(found.usual),
      lacks: able.ok ? null : able.missing,
      install: { line: install.line, lands: install.lands },
      asked: running.known ? 'yes' : running.why,
    },
    sessions: here.map(row),
    current: (() => {
      const entry = Object.hasOwn(read.value.places, key) ? read.value.places[key] : undefined
      return entry?.current && here.includes(entry.current) ? entry.current : null
    })(),
    own: (() => {
      const own = ownOf(read.value, key)
      return own && here.includes(own) ? own : null
    })(),
    homes: Object.fromEntries(
      here.flatMap((id) => {
        const home = homeOf(read.value, id)
        return home && home !== key && Object.hasOwn(read.value.places, home) ? [[id, placeSaid(read.value.places[home]!)]] : []
      }),
    ),
    unassigned: unassigned(read.value).filter((id) => !here.includes(id)).map(row),
    assignable: assignable(read.value, key, 24, (id) => {
      const one = row(id)
      return { id, title: one.label, lastActive: one.lastActive }
    }),
    ownNow: (() => {
      const id = ownOf(read.value, key)
      if (!id) return null
      const one = row(id)
      return { id, title: one.label, lastActive: one.lastActive }
    })(),
    hook: enabled(),
    others: ordered(held, here, key, read.value).map(({ one, near }) => ({ ...row(one.id), ...(near.length ? { near } : {}) })),
    running: live.map((run) => ({
      id: run.settled ?? run.id,
      label: run.label,
      projectPath: run.projectPath,
      place: run.key,
      here: ours(run) && run.key === key,
      startedAt: run.startedAt,
      ...stated(run),
    })),
  }
}

/** Where the program was looked for, in few enough words for one sentence. The whole list is `looked`. */
export function lookedIn(usual: readonly string[], at = home()): string {
  return ['PATH', ...usual.slice(0, 3).map((dir) => tidy(dir, at))].join(', ')
}

/** A path with the home folder written as `~`, as a person would say it. */
function tidy(path: string, at = home()): string {
  return at && path.startsWith(`${at}/`) ? `~${path.slice(at.length)}` : path
}

/* ------------------------------------------------------------------ *
 * The MCP door, for agents. One tool, and it reads.
 * ------------------------------------------------------------------ */

function tools() {
  return [
    {
      name: 'sessions',
      description:
        `The ${PROGRAM.name} sessions a person keeps in a project, by place. A place is an epic, the set of parts picked `
        + 'out of it and a kehikko; each lists its sessions with the first line of their first prompt, when each was '
        + 'last active, whether it is running now, and `missing: true` when Claude Code has no record of it on this '
        + 'computer (sessions stay on the computer they ran on). A running session that has said so also has `state` — '
        + '`working` (a turn is under way), `needs-you` (it has stopped at a question only its person can answer) or '
        + '`finished` (its turn is over and it is at its prompt) — and `since`. No `state` means it has not said, not that '
        + 'it is idle. `runningElsewhere` is on a session Claude Code is running in a process this module did not start: '
        + 'kind `background` is attached to when it is opened here (no second process), anything else is open in a '
        + 'terminal or an editor and its person is asked before a copy is started. '
        + `Read from ${WHERE}. Give the absolute project directory as `
        + 'project, and an epic slug to see only that epic’s places. Give `place` — the epic, the picked parts and '
        + 'the kehikko — to be told in words what opening the module there will do: a place with a session opens it; a '
        + 'place with none starts a new one at once only when the project has no other session, and otherwise asks its '
        + 'person which to carry on with, and the answer lists those sessions in the order they are offered. Reads '
        + 'only: nothing here starts, ends, attaches or types into a session.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'The absolute directory of the project.' },
          epic: { type: 'string', description: 'An epic’s slug, to list only its places.' },
          place: {
            type: 'object',
            description: 'One place, to be told what it holds and what opening the module there does.',
            properties: {
              epic: { type: ['string', 'null'], description: 'The epic’s slug, or null when none is open.' },
              parts: { type: 'array', items: { type: 'string' }, description: 'The ids of the picked parts. Empty, or left out, is the whole epic.' },
              kehikko: { type: ['string', 'number', 'null'], description: 'The kehikko’s key (a string), or — for a host that has no keys — its row number.' },
            },
          },
        },
        required: ['project'],
      },
      annotations: { title: 'Sessions by place', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ]
}

/** A place an agent named, or the sentence saying why it is not one. */
function placeAsked(raw: unknown): Place | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'place must be an object: { epic, parts, kehikko }.'
  const said = raw as { epic?: unknown; parts?: unknown; kehikko?: unknown }
  const parts = said.parts ?? []
  if (!Array.isArray(parts) || parts.some((one) => typeof one !== 'string')) return 'place.parts must be a list of part ids.'
  const kehikko = said.kehikko ?? null
  if (kehikko !== null && typeof kehikko !== 'string' && typeof kehikko !== 'number') return 'place.kehikko must be the kehikko’s key, or its row number.'
  const epic = said.epic ?? null
  if (epic !== null && typeof epic !== 'string') return 'place.epic must be an epic’s slug, or null.'
  const which = kehikko === null ? null : kehikkoOf(typeof kehikko === 'string' ? { key: kehikko } : { id: kehikko })
  if (kehikko !== null && which === null) return 'place.kehikko is not a kehikko’s key or row number.'
  const place: Place = { epic, parts: parts as string[], kehikko: which }
  /* Round-tripped: an epic or a part that is not a slug does not name a place this module could have written. */
  return readPlaceKey(placeKey(place)) ? place : 'That is not a place: an epic and a part are named by their slugs.'
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  if (name !== 'sessions') throw new Error(`no tool "${name.slice(0, 60)}" here`)
  /* `project` and `epic`, or `projectPath`, the name this door used before the protocol agreed one. */
  const named = doorContext(args)
  const root = projectRoot(named.project)
  if (!root.ok) throw new Error(root.error)
  const read = readPlaces(root.value)
  if (!read.ok) throw new Error(read.error)
  const epic = named.epic
  const recorded = await PROGRAM.sessions(root.value, recordedIds(read.value))
  const held = new Map(recorded.map((one) => [one.id, one]))
  const runs = theRuns()
  const live = runs.sessions()
  const running = await runs.running()
  const session = (id: string) => {
    const kept = Object.hasOwn(read.value.sessions, id) ? read.value.sessions[id] : undefined
    const at = held.get(id)?.lastActive
    const run = live.find((one) => one.id === id || one.settled === id)
    const { elsewhere } = besides(id, run, running, runs)
    return {
      id,
      firstPrompt: held.get(id)?.label || kept?.label || '',
      lastActive: at ? new Date(at).toISOString() : (kept?.lastActive ?? null),
      running: Boolean(run),
      ...(run?.state ? { state: run.state, doing: DOING[run.state], since: new Date(run.stateSince).toISOString() } : {}),
      ...(elsewhere ? { runningElsewhere: { kind: elsewhere.called || elsewhere.kind, since: elsewhere.since ? new Date(elsewhere.since).toISOString() : null, pid: elsewhere.pid, cwd: elsewhere.cwd } } : {}),
      ...(held.has(id) || run ? {} : { missing: true }),
    }
  }
  /* The project's sessions that are not one place's, as that place would offer them. */
  const offered = (here: readonly string[], key: string) =>
    ordered(recorded, here, key, read.value).map(({ one, near }) => ({ ...session(one.id), ...(near.length ? { sameEpicAt: near } : {}) }))
  const unasked = running.known
    ? ''
    : ` (${PROGRAM.name} ${running.why === 'too-old' ? 'here is too old to say' : 'could not be asked'} what is running elsewhere, so no session below says \`runningElsewhere\` — which is not the same as none being so.)`

  if (args.place !== undefined) {
    const place = placeAsked(args.place)
    if (typeof place === 'string') throw new Error(place)
    const key = placeKey(place)
    const all = sessionsAt(read.value, key)
    for (const run of live) {
      const id = run.settled ?? run.id
      if (sameProject(run, root.value) && run.key === key && !all.includes(id)) all.push(id)
    }
    const here = all.map(session)
    const openable = here.filter((one) => !('missing' in one))
    const others = offered(all, key)
    const kept = here.length > openable.length ? ` It also lists ${here.length - openable.length} that ${PROGRAM.name} has no record of on this computer, which cannot be opened here.` : ''
    if (openable.length > 1) return `This place (${key}) has ${openable.length} sessions, so opening the module here asks its person which one before anything is opened.${kept}${unasked}\n${JSON.stringify(here, null, 2)}`
    if (openable.length === 1) {
      const one = openable[0]!
      const how = one.running
        ? 'which this module is already running'
        : one.runningElsewhere?.kind === 'background'
          ? 'which is running in the background: it is attached to, and no second process is started'
          : one.runningElsewhere
            ? 'which is open in another process that cannot be attached to: its person is asked whether to open a copy anyway or leave it, and nothing is started until they answer'
            : 'which is resumed'
      return `This place (${key}) has one session, and opening the module here opens it at once — ${how}.${kept}${unasked}\n${JSON.stringify(here, null, 2)}`
    }
    if (!others.length) return `This place (${key}) has no session, and ${PROGRAM.name} has no other session for this project: opening the module here starts a new one at once.${kept}`
    return (
      `This place (${key}) has no session yet. ${PROGRAM.name} has ${others.length} other session${others.length === 1 ? '' : 's'} for this project, so opening the module here starts nothing: `
      + 'it asks its person which to carry on with — "New session" first, which Enter takes, then these in this order (the ones another place of the same epic holds, `sameEpicAt`, then the rest by when '
      + `each was last active). Choosing one makes it this place’s session without taking it from any other place.${kept}${unasked}\n${JSON.stringify(others, null, 2)}`
    )
  }

  const places = Object.entries(read.value.places)
    .filter(([, place]) => epic === null || place.epic === epic)
    .map(([key, place]) => ({
      place: key,
      epic: place.epic,
      parts: place.parts,
      kehikko: place.kehikko,
      sessions: place.sessions.map(session),
    }))
  if (!places.length) {
    const said = epic ? `No session is recorded for the epic "${epic}" in that project.` : 'No session is recorded for that project yet.'
    const loose = offered([], placeKey({ epic, parts: [], kehikko: null }))
    if (!loose.length) return said
    return (
      `${said} ${PROGRAM.name} has ${loose.length} session${loose.length === 1 ? '' : 's'} for the folder that ${epic ? 'no place of that epic holds' : loose.length === 1 ? 'belongs to no place' : 'belong to no place'}: `
      + `a place opened there asks its person which to carry on with before starting a new one.${unasked}\n${JSON.stringify(loose, null, 2)}`
    )
  }
  return JSON.stringify(places, null, 2)
}

interface Rpc {
  id?: number | string
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

async function mcp(rpc: Rpc): Promise<Reply> {
  const reply = (result: unknown) => ok({ jsonrpc: '2.0', id: rpc.id ?? null, result })
  const text = (s: string, isError = false) => reply({ content: [{ type: 'text', text: s }], ...(isError ? { isError } : {}) })

  if (rpc.method === 'initialize') {
    return reply({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: ID, version: VERSION },
      instructions: MANIFEST.mcp?.about ?? '',
    })
  }
  /* A notification carries no id and is answered with nothing. */
  if (typeof rpc.method === 'string' && rpc.method.startsWith('notifications/')) return { status: 202, body: null }
  if (rpc.method === 'tools/list') return reply({ tools: tools() })
  if (rpc.method === 'tools/call') {
    try {
      return text(await call(String(rpc.params?.name ?? ''), rpc.params?.arguments ?? {}))
    } catch (e) {
      /* A refusal is an answer the agent reads, not a transport failure it retries. */
      return text(e instanceof Error ? e.message : String(e), true)
    }
  }
  return { status: 404, body: { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: String(rpc.method) } } }
}

/* ------------------------------------------------------------------ *
 * The doors.
 * ------------------------------------------------------------------ */

export async function answer(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  ticket: string | null,
): Promise<Reply | null> {
  if (path === '/healthz') return ok({ ok: true, id: ID, version: VERSION, where: WHERE })

  if (path === '/mcp') {
    if (method !== 'POST') return bad('the MCP door takes POST', 405)
    if (!body || typeof body.method !== 'string') {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a request' } } }
    }
    return mcp(body as Rpc)
  }

  if (!path.startsWith('/api/')) return null

  /* A session's program saying what it is doing. Before the page's ticket is
     asked for, because it does not have one: see "One door is not the page's". */
  if (path === '/api/state') {
    if (method !== 'POST') return bad('this door takes POST', 405)
    /* `background` is a count, digits only and at most three: anything else is no count. */
    const counted = query.get('background') ?? ''
    const took = theRuns().heard(query.get('session') ?? '', ticket, query.get('event') ?? '', /^\d{1,3}$/.test(counted) ? Number(counted) : null)
    return took ? { status: 204, body: null } : bad('that is not a running session’s own report', 403)
  }

  /* What this module's record says about a place token (protocol 2.4.0): asked by the host, for
     a Kehikot door a session called with it. A program's door, like `/api/state`: the token is a
     pointer to a record, and grants nothing. */
  if (path === '/api/kehikot/place' && method === 'GET') {
    const token = query.get('kehikot-place') ?? ''
    if (!PLACE_TOKEN.test(token)) return ok({ ok: true, place: null })
    return ok({ ok: true, place: theRuns().placeOf(token, query.get('project')) })
  }

  /* Claude Code's SessionStart hook, through `started.sh`: a session started somewhere, in a
     folder. Listed at once in that project as not yet assigned — when the host holds the folder
     as a project. A program's door; nothing it says assigns anything. */
  if (path === '/api/sessions/started' && method === 'POST') {
    const id = typeof body?.session_id === 'string' ? body.session_id : ''
    const cwd = typeof body?.cwd === 'string' && body.cwd.length <= 4096 ? body.cwd : ''
    if (!PROGRAM.isId(id) || !cwd) return bad('that is not a session start')
    const root = projectRoot(cwd)
    if (!root.ok || !(await hostCheck.has(root.value))) return ok({ ok: true, listed: false })
    return ok({ ok: true, listed: theRuns().sighted(root.value, id, 'hook') })
  }

  /* Every other door under /api, the read included: see "Reads carry the ticket too". */
  const refused = refuseTicket(ticket, TICKET)
  if (refused) return refused

  if (path === '/api/place' && method === 'GET') {
    const id = query.get('projectId') ?? ''
    const said = await listing(query.get('projectPath') ?? '', query.get('key') ?? '', undefined, undefined, PROJECT_ID.test(id) ? id : null)
    return said.ok ? ok(said) : bad(said.error)
  }

  /* Bring the entries an older release filed under this kehikko's row number
     across to its key (see `rekey` in record.ts). A write, so a POST: the read
     above never moves anything. */
  if (path === '/api/rekey' && method === 'POST') {
    const said = (typeof body?.kehikko === 'object' && body.kehikko !== null ? body.kehikko : {}) as { key?: unknown; name?: unknown; id?: unknown }
    if (!isKehikkoKey(said.key)) return bad('that is not a kehikko’s key')
    const written = rekey(typeof body?.projectPath === 'string' ? body.projectPath : null, {
      key: said.key,
      name: typeof said.name === 'string' ? said.name.slice(0, 120) : '',
      id: typeof said.id === 'number' && Number.isSafeInteger(said.id) ? said.id : undefined,
    })
    return written.ok ? ok({ ok: true, moved: written.value.moved }) : bad(written.error)
  }

  /* End a running session, because a person chose that one. Never asked OF a
     person: nothing is refused for want of one being ended (see live.ts). */
  if (path === '/api/end' && method === 'POST') {
    const id = typeof body?.session === 'string' ? body.session : ''
    if (!PROGRAM.isId(id)) return bad('that is not a session id')
    return ok({ ok: true, ended: theRuns().end(id) })
  }

  /* Resume a running session in its project's new folder, because a person pressed that: the
     folder was renamed while it ran. Refused while it is working (see `restartIn` in live.ts). */
  if (path === '/api/restart' && method === 'POST') {
    const id = typeof body?.session === 'string' ? body.session : ''
    if (!PROGRAM.isId(id)) return bad('that is not a session id')
    const done = theRuns().restartIn(id, body?.why === 'doors' ? 'doors' : 'moved')
    return done === true ? ok({ ok: true }) : bad(done, 409)
  }

  /* A person's say about where a conversation belongs: "Assign to this kehikko" for one that
     belongs nowhere, "Make this the kehikko's own" for one being viewed here (`own`). */
  if (path === '/api/assign' && method === 'POST') {
    const id = typeof body?.session === 'string' ? body.session : ''
    const key = typeof body?.key === 'string' ? body.key : ''
    const place = readPlaceKey(key)
    if (!PROGRAM.isId(id)) return bad('that is not a session id')
    if (!place) return bad('that is not a place')
    const names = (typeof body?.names === 'object' && body.names !== null ? body.names : {}) as { kehikko?: unknown }
    const written = assign(typeof body?.projectPath === 'string' ? body.projectPath : null, { ...place, ...(typeof names.kehikko === 'string' ? { kehikkoName: names.kehikko.slice(0, 120) } : {}) }, id, { own: body?.own === true })
    if (written.ok) theRuns().recorded()
    return written.ok ? ok({ ok: true }) : bad(written.error)
  }

  /* A person's say that a conversation that belongs nowhere is not a Kehikot one at all: kept in
     the record like an assignment, so it is never listed or counted in the Inbox again. */
  if (path === '/api/ignore' && method === 'POST') {
    const id = typeof body?.session === 'string' ? body.session : ''
    if (!PROGRAM.isId(id)) return bad('that is not a session id')
    const written = ignore(typeof body?.projectPath === 'string' ? body.projectPath : null, id)
    if (written.ok) theRuns().recorded()
    return written.ok ? ok({ ok: true }) : bad(written.error)
  }

  /* Whether sessions started outside Kehikot are reported, and the press that makes them so. */
  if (path === '/api/hook' && method === 'GET') {
    return ok({ ok: true, enabled: enabled(), file: settingsFile(), command: hookCommand() })
  }
  if (path === '/api/hook' && method === 'POST') {
    const done = enable()
    return done.ok ? ok(done) : bad(done.error, 409)
  }

  /* Which doors a running session would be given now that it was not: the line offering a restart. */
  if (path === '/api/doors' && method === 'GET') {
    const id = query.get('session') ?? ''
    if (!PROGRAM.isId(id)) return bad('that is not a session id')
    return ok({ ok: true, changed: await theRuns().doorsChanged(id) })
  }

  /* Take a session off a place. The session is kept, and so is its transcript:
     it goes back among the ones that can be attached. */
  if (path === '/api/detach' && method === 'POST') {
    const id = typeof body?.session === 'string' ? body.session : ''
    const key = typeof body?.key === 'string' ? body.key : ''
    if (!PROGRAM.isId(id)) return bad('that is not a session id')
    const written = detach(typeof body?.projectPath === 'string' ? body.projectPath : null, key, id)
    return written.ok ? ok({ ok: true }) : bad(written.error)
  }

  return bad('not here', 404)
}

/**
 * `GET /api/feed`: what changes while a page is open, as server-sent events.
 *
 * Every change of a running session's state (an unnamed event), and — for a
 * page that says a host is framing it — the notices raised for a person who
 * is not looking (`notice`), which only a framed page can pass on, and the whole
 * activity list (`activity`: on arrival and on every change) that the page hands to
 * the host as `activity.set`. The page
 * opens it instead of asking on a clock.
 *
 * Ticketed like the read it sits beside, since a notice carries a session's
 * label. An `EventSource` cannot send a header, so the ticket is in the
 * query; the address is this module's own origin and is asked by its own
 * page, and nothing logs it.
 */
export const stream: Stream = (method, path, query, emit, ticket) => {
  if (path !== '/api/feed') return null
  if (method !== 'GET') return { reply: bad('this door takes GET', 405) }
  if (!sameTicket(ticket ?? query.get('ticket'), TICKET)) return { reply: refuseTicket(null, TICKET)! }
  /* The project the page is framed in: its activity list is that project's sessions only. */
  const asked = query.get('project')
  const project = asked ? projectRoot(asked) : null
  const close = theRuns().subscribe({
    notices: query.get('notices') === '1',
    project: project?.ok ? project.value : null,
    state: (stated) => emit(stated),
    notice: (notice) => emit(notice, 'notice'),
    activity: (items) => emit({ items }, 'activity'),
    sessions: (project) => emit({ project }, 'sessions'),
  })
  return { close }
}

export { MANIFEST }
