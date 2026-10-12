import { establishBuild, refuseTicket, sameTicket, type Reply, type Stream } from 'kehikot-module-protocol/serve'

import { TICKET, theRuns, type Run, type Runs } from './live.ts'
import { ID, MANIFEST, VERSION } from './manifest.ts'
import { isKehikkoKey, readPlaceKey } from './place.ts'
import { PROGRAM, home, type Program, type State } from './program.ts'
import { WHERE, detach, projectRoot, readPlaces, rekey, sessionsAt } from './record.ts'

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

/** What this process is built from, said in the manifest, at `/healthz`, in the page and on every answer. */
export const BUILD = establishBuild({ version: VERSION, dir: import.meta.dirname })

const ok = (body: unknown): Reply => ({ status: 200, body })
const bad = (why: string, status = 400): Reply => ({ status, body: { ok: false, error: why } })

/** One session, as a row in a list. */
export interface Row {
  id: string
  /** The first line of its first prompt, cut short; `''` when it has none yet. */
  label: string
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
  }
  /** The sessions of this place, in the order they were added. */
  sessions: Row[]
  /** The project's other sessions: they belong to no place, or to another. */
  others: Row[]
  /**
   * Everything running, in any project. Said, and not counted against
   * anything: there is no number of sessions at which an open is refused.
   */
  running: { id: string; label: string; projectPath: string; place: string | null; here: boolean; startedAt: number; state?: State; since?: number }[]
}

/** A running session's state, as the fields a row carries: nothing when nothing is known. */
const stated = (run: Run | undefined): { state?: State; since?: number } => (run?.state ? { state: run.state, since: run.stateSince } : {})

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
): Promise<Listing | { ok: false; error: string }> {
  const root = projectRoot(projectPath)
  if (!root.ok) return root
  if (!readPlaceKey(key)) return { ok: false, error: 'That is not a place.' }
  const read = readPlaces(root.value)
  if (!read.ok) return read

  const found = program.find()
  const able = found.file ? await program.supports(found.file) : { ok: true, missing: null, tells: false }
  const live = runs.sessions()
  /* A running session that had not been recorded, or named, the last time the
     program spoke may have been since: somebody is about to read the list. */
  await Promise.all(live.filter((run) => !run.settled || !run.label).map((run) => runs.settle(run).catch(() => {})))
  const held = await program.sessions(root.value)
  const known = new Map(held.map((one) => [one.id, one]))

  const row = (id: string): Row => {
    const run = live.find((one) => one.id === id || one.settled === id)
    const kept = Object.hasOwn(read.value.sessions, id) ? read.value.sessions[id] : undefined
    const keptAt = kept?.lastActive ? Date.parse(kept.lastActive) : NaN
    return {
      id,
      label: known.get(id)?.label || run?.label || kept?.label || '',
      lastActive: known.get(id)?.lastActive ?? (Number.isFinite(keptAt) ? keptAt : (run?.startedAt ?? null)),
      running: Boolean(run),
      ...stated(run),
      /* Neither the program's nor running: all there is of it here is the row in the record. */
      ...(known.has(id) || run ? {} : { missing: true as const }),
    }
  }

  const here = sessionsAt(read.value, key)
  for (const run of live) {
    const id = run.settled ?? run.id
    if (run.projectPath === root.value && run.key === key && !here.includes(id)) here.push(id)
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
    },
    sessions: here.map(row),
    others: held.filter((one) => !here.includes(one.id)).map((one) => row(one.id)),
    running: live.map((run) => ({
      id: run.settled ?? run.id,
      label: run.label,
      projectPath: run.projectPath,
      place: run.key,
      here: run.projectPath === root.value && run.key === key,
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
        + `it is idle. Read from ${WHERE}. Give the absolute project directory as `
        + 'projectPath, and an epic slug to see only that epic’s places. Reads only: nothing here starts, ends or types '
        + 'into a session.',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: { type: 'string', description: 'The absolute directory of the project.' },
          epic: { type: 'string', description: 'An epic’s slug, to list only its places.' },
        },
        required: ['projectPath'],
      },
      annotations: { title: 'Sessions by place', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ]
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  if (name !== 'sessions') throw new Error(`no tool "${name.slice(0, 60)}" here`)
  const root = projectRoot(typeof args.projectPath === 'string' ? args.projectPath : null)
  if (!root.ok) throw new Error(root.error)
  const read = readPlaces(root.value)
  if (!read.ok) throw new Error(read.error)
  const epic = typeof args.epic === 'string' && args.epic ? args.epic : null
  const held = new Map((await PROGRAM.sessions(root.value)).map((one) => [one.id, one]))
  const live = theRuns().sessions()
  const places = Object.entries(read.value.places)
    .filter(([, place]) => epic === null || place.epic === epic)
    .map(([key, place]) => ({
      place: key,
      epic: place.epic,
      parts: place.parts,
      kehikko: place.kehikko,
      sessions: place.sessions.map((id) => {
        const kept = Object.hasOwn(read.value.sessions, id) ? read.value.sessions[id] : undefined
        const at = held.get(id)?.lastActive
        const run = live.find((one) => one.id === id || one.settled === id)
        const running = Boolean(run)
        return {
          id,
          firstPrompt: held.get(id)?.label || kept?.label || '',
          lastActive: at ? new Date(at).toISOString() : (kept?.lastActive ?? null),
          running,
          ...(run?.state ? { state: run.state, since: new Date(run.stateSince).toISOString() } : {}),
          ...(held.has(id) || running ? {} : { missing: true }),
        }
      }),
    }))
  if (!places.length) return epic ? `No session is recorded for the epic "${epic}" in that project.` : 'No session is recorded for that project yet.'
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
    const took = theRuns().heard(query.get('session') ?? '', ticket, query.get('event') ?? '')
    return took ? { status: 204, body: null } : bad('that is not a running session’s own report', 403)
  }

  /* Every other door under /api, the read included: see "Reads carry the ticket too". */
  const refused = refuseTicket(ticket, TICKET)
  if (refused) return refused

  if (path === '/api/place' && method === 'GET') {
    const said = await listing(query.get('projectPath') ?? '', query.get('key') ?? '')
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
 * is not looking (`notice`), which only a framed page can pass on. The page
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
  const close = theRuns().subscribe({
    notices: query.get('notices') === '1',
    state: (stated) => emit(stated),
    notice: (notice) => emit(notice, 'notice'),
  })
  return { close }
}

export { MANIFEST }
