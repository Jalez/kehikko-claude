import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

import { mintTicket, sameTicket } from 'kehikot-module-protocol/serve'

import { typedByPerson } from './input.ts'
import { isKehikkoKey, placeKey, sortedParts, type Kehikko } from './place.ts'
import { PROGRAM, home, type Program, type State } from './program.ts'
import { attach, note, projectRoot, type NamedPlace } from './record.ts'

/**
 * The sessions that are running, and the socket a page watches one through.
 *
 * ## What is different from Terminal, and it is the point of this file
 *
 * In `kehikko-terminal` a shell lives exactly as long as its socket: the page
 * closes, the socket closes, the pty is killed. That is right for a shell and
 * wrong here. What runs in this pty is an agent that may be twenty minutes
 * into something, and a page reload — which the plumbing does by itself when
 * it finds the page older than its server, and Vite's client does on its own
 * — would end it mid-edit.
 *
 * So a session is owned by THIS PROCESS, not by a socket. A socket is a
 * viewer: it attaches, is sent the screen as it stands, then follows along,
 * and when it goes away nothing else happens. The screen it is sent comes
 * from a second emulator kept here, headless, fed every byte the pty
 * produces — the same arrangement a code editor uses to bring a terminal back
 * after its window reloads. A viewer that returns sees what it would have
 * seen had it never left.
 *
 * A session ends when the program in it exits, when a person ends it from the
 * list, or when this process stops. Never merely because nobody is looking:
 * an agent at work is left to finish.
 *
 * ## There is no limit, and nothing is ever refused for room
 *
 * A place has its session, and going to the place opens it — every time,
 * however many others are running. There used to be a bound here (six), and
 * at it every open was refused and the person was shown a list and asked to
 * end something. Nobody had asked for that, and it locked a person out of
 * their own work: the app does not make a person do its housekeeping. So
 * there is no count anywhere in this file, and no open is refused because of
 * what else is running.
 *
 * What keeps the number of processes down is quiet, and is not a person's
 * business. Two things are ended without anybody choosing, and neither loses
 * anything:
 *
 *  - what was never a session — opened by looking at a place, never typed
 *    into, never recorded — a moment after nobody is looking
 *    (`UNTOUCHED_GRACE`);
 *  - a session nobody is looking at that has been done with its turn for a
 *    long time (`QUIET_REST`). It is a process put away, not a conversation:
 *    a session is resumable by id, and the next visit to its place starts
 *    the program again on the same one, without a question and without a
 *    message.
 *
 * Never one somebody has on screen, never one that is working, and never one
 * that is waiting for an answer.
 *
 * ## Told, not read
 *
 * Whether a session is working, waiting for the person or done with its turn
 * is something the program SAYS (`reports` in program.ts): at each of those
 * moments it runs `tell.sh`, which posts one word to this process over
 * loopback. Nothing here reads a screen to guess at it.
 *
 * What stands behind that word:
 *
 *  - **A secret per run**, minted here when the pty is started and handed to
 *    it in the environment — never on a command line, never in a file. A
 *    report is taken only when it names a running session AND carries that
 *    session's own secret. Everything the program starts inherits the
 *    environment, so the agent in the pty and whatever a project's own hooks
 *    run can read it: the most either can do with it is misstate the state of
 *    the one session they are already inside. It cannot speak for another
 *    session, and it opens no other door — it is not the page's ticket.
 *  - **Only an event's name is heard.** A name this program does not use is
 *    dropped. Nothing a report carries is stored, shown or logged, so a
 *    report cannot put a sentence in front of a person.
 *  - **A report cannot ask for anything.** The most a false one does is move
 *    a dot, send one notice about its own session, or keep its own process
 *    from being put away. Notices are rationed (`NOTICES_AT_ONCE`), so it cannot
 *    fill a panel either.
 *
 * Two things the program does not report are covered from this side, and
 * both are in `program.ts` at length: a person typing into a session that
 * was waiting for them has answered it, and a session called working that
 * has printed nothing for minutes is not (`STALE_WORK`).
 *
 * A program too old to report, or one whose reports never arrive, has no
 * state. Everything else is as it was, including the rule that used to be
 * the only one: put away after a long silence.
 *
 * When this process stops, its sessions stop with it — nothing is left
 * running with no owner — and that costs nothing lasting, for the same
 * reason.
 *
 * ## The fence
 *
 * Unchanged from Terminal, whose `shell.ts` argues it at length: loopback
 * bind, `Origin` and `Host` checked on the upgrade, and the ticket this
 * process printed into its own page carried in the socket's first frame, with
 * nothing started until that frame has been read. It keeps other pages out.
 * It does not keep out a program already running as this user, which could
 * run `claude` itself without asking.
 *
 * What a socket can ask for is narrower than there: not a shell, but this one
 * program, in a folder that exists, on a session id this module minted or the
 * program already holds for that folder — and, once, the vendor's installer
 * when the program is missing. No argument arrives over the wire.
 */

export const TICKET = mintTicket()

/** How long a connection may stay silent before it has proved itself. */
const MUST_SPEAK_WITHIN = 5_000
/** What the program is told it is running in. */
const TERM = 'xterm-256color'
/** How much of what scrolled past a returning viewer is given back. */
const SCROLLBACK = 5000
/** At most this often is the program asked whether a new session exists yet. */
const SETTLE_EVERY = 2_000
/**
 * How long a session that was never a session is kept once nobody is looking.
 *
 * A place is opened by looking at it, and a new session is started for a
 * place that has none — so picking through the parts of an epic would leave a
 * process behind at every stop. One that nobody has typed a character into
 * and that the program has recorded nothing for holds nothing at all: when
 * its last viewer leaves it is given this long (a page reload is back well
 * inside it) and then ended. It is not a session: anything typed into, and
 * anything that exists, is left to `QUIET_REST`.
 *
 * "Typed" means by a person. What the page's emulator answers the program by
 * itself, and where the pointer is, arrive on the same channel and are not
 * typing (see `input.ts`) — counted as such, every session was typed into a
 * third of a second after it started and none was ever ended.
 */
const UNTOUCHED_GRACE = 20_000
/**
 * How long a session nobody is looking at is left before its process is put
 * away — once it is done.
 *
 * Each running session is an agent holding a few hundred megabytes, and a
 * session keeps running when a person looks elsewhere, so one would
 * accumulate for every place ever worked in. The ones worth keeping are the
 * ones in the middle of something, and which those are is no longer guessed
 * at: the program says (see "Told, not read", and `rest` for the rule). A
 * session that has FINISHED its turn, and has been left alone for this long
 * since, is put away. One that is working, or waiting for an answer, never
 * is.
 *
 * Half an hour, so that a person who stepped away from a place mid-thought
 * comes back to the same process: to the line they had typed and not sent.
 *
 * ## When the program says nothing: silence, as before
 *
 * A copy too old to report, and a session whose reports do not arrive, are
 * judged the way every session used to be — by how long the program has
 * printed nothing:
 *
 *  - Waiting at its prompt, Claude Code prints NOTHING. Measured on 2.1.296:
 *    started in a pty, brought to its prompt, nothing typed, and every byte
 *    it printed in twenty minutes timed. There were 1133 of them, and the
 *    last came eleven seconds after it started.
 *  - Working, it draws a spinner and a running clock for as long as a turn
 *    or a tool lasts: several writes a second (the numbers are at
 *    `STALE_WORK`, below).
 *
 * There the time is counted from the last byte the program printed, the last
 * thing a person typed, or the moment the last person looked away —
 * whichever is latest. It is the weaker rule and it is known to be: a
 * question left on screen is as silent as a prompt, and under this rule is
 * put away with it. That is what being told is for.
 *
 * What is put away is the process. The conversation is the program's record,
 * and the next visit to the place resumes it by id (`open`, below).
 * `KEHIKOT_CLAUDE_QUIET_MS` moves it; it is not a limit anybody can run into.
 */
export const QUIET_REST = Math.max(1_000, Math.trunc(Number(process.env.KEHIKOT_CLAUDE_QUIET_MS) || 30 * 60_000))
/** How often the quiet ones are looked for. */
const REST_EVERY = 60_000
/**
 * How long a session called `working` may print nothing before it is no
 * longer called anything.
 *
 * Measured on 2.1.296, with a stand-in for the model so that a turn could be
 * held open: mid-turn it printed 2834 bytes in 67 writes over ten seconds;
 * the same with its terminal told it had lost focus (3070 in twelve); the
 * same while a tool ran. And a turn interrupted with Esc reported nothing —
 * no `Stop`, and no idle notification in the seventy-five seconds after — and
 * printed nothing either. So two minutes of nothing at all from a session
 * called working means the turn ended without a word, and "unknown" is the
 * true thing to say. It then falls under the silence rule like any session
 * with no state, which is where it would have been before states existed.
 */
const STALE_WORK = 2 * 60_000
/**
 * How many notices one session may raise in a row, and how long until it may
 * raise one more. A session that finishes and, on the prompt queued behind
 * it, stops to ask three seconds later has two things to say and says both;
 * one reporting in a loop says four and then one every quarter of a minute.
 */
const NOTICES_AT_ONCE = 4
const NOTICE_EVERY = 15_000
/** How many notices are held for a page that is not there to take them. The oldest go. */
const NOTICES_HELD = 32
/**
 * How long a page that has just arrived waits before it is handed what was
 * held. A page begins following the moment it loads and puts its session on
 * screen a moment after that; handed over at once, the first thing a person
 * opening the app would be told is that the session in front of them has
 * finished.
 */
const HELD_WAIT = 3_000
/** The script a session's program runs to report (see "Told, not read"). */
const TELL = join(import.meta.dirname, 'tell.sh')
/** The environment a report is made from. Read by `tell.sh` and by nothing else. */
export const TELL_ENV = { port: 'KEHIKOT_TELL_PORT', secret: 'KEHIKOT_TELL_SECRET', session: 'KEHIKOT_TELL_SESSION' } as const

/** A word in single quotes for `/bin/sh`, whatever is in it. Used for one thing: this module's own path. */
export const quoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/** The line the program is to run for one event. The event is a name out of `program.ts`, never anything heard. */
export const tellLine = (event: string, script: string = TELL): string => `/bin/sh ${quoted(script)} ${event}`
/** A session that still has no first prompt after this many looks is not asked again until it ends. */
const LABEL_TRIES = 8

/**
 * Why a socket was closed, as a number the page can act on. The sentence
 * beside it is for a person; the number is what decides what is drawn.
 */
export const CLOSED = {
  ended: 4000,
  /** Put away for being quiet with nobody looking: not news, and the page draws nothing for it. */
  rested: 4001,
  installed: 4010,
  notInstalled: 4011,
  refused: 4403,
  missing: 4404,
  silent: 4408,
  failed: 4500,
} as const

/* ------------------------------------------------------------------------ *
 * The fence, as pure functions (see kehikko-terminal/shell.ts for the essays)
 * ------------------------------------------------------------------------ */

export interface Fenced {
  ok: boolean
  why: string
}

/** Is this handshake from this module's own page? `Origin` and `Host`, both, against the port actually bound. */
export function fenced(headers: { origin?: string; host?: string }, port: number): Fenced {
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  const origin = headers.origin
  if (!origin) return { ok: false, why: 'That handshake carried no Origin. Every browser sends one, so this did not come from a page.' }
  if (!allowed.has(origin)) return { ok: false, why: `${origin} is not this module's own page, and only its own page may open a session.` }
  const host = headers.host
  if (!host || !allowed.has(`http://${host}`)) {
    return { ok: false, why: `That request asked for host ${host ?? '(none)'}, which is not this module's address.` }
  }
  return { ok: true, why: '' }
}

/** A close reason short enough that closing does not throw: the protocol caps one at 123 BYTES. */
export function sayable(reason: string, limit = 123): string {
  const bytes = Buffer.from(reason, 'utf8')
  if (bytes.length <= limit) return reason
  let cut = limit
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1
  return Buffer.from(bytes.subarray(0, cut)).toString('utf8')
}

/** The first frame a page sends, before anything is started. */
export type Opening =
  | { what: 'install'; cols: number; rows: number }
  | {
      what: 'session'
      projectPath: string
      place: NamedPlace
      /** The session to open, or null for a new one. */
      session: string | null
      cols: number
      rows: number
    }

const size = (raw: unknown, least: number, most: number, otherwise: number) => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.min(most, Math.max(least, Math.trunc(n))) : otherwise
}

const SLUG = /^[a-z0-9-]{1,80}$/

/**
 * Which kehikko, off the wire: `{ key }`, `{ id }`, or — as pages older than
 * the key sent it — a bare number, which is an id. `undefined` for anything
 * else. Told apart by the field it came in and never by how it looks: a key
 * may be all digits, and a string is never read as a number here.
 */
function readKehikko(raw: unknown): Kehikko | null | undefined {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? { id: raw } : undefined
  if (typeof raw !== 'object') return undefined
  const said = raw as { key?: unknown; id?: unknown }
  if (said.key !== undefined) return isKehikkoKey(said.key) && said.id === undefined ? { key: said.key } : undefined
  return typeof said.id === 'number' && Number.isSafeInteger(said.id) ? { id: said.id } : undefined
}

/** A place off the wire, or null. Ids and the kehikko's key are checked; the names — the kehikko's, the parts' — are labels and only bounded. */
export function readPlace(raw: unknown): NamedPlace | null {
  if (typeof raw !== 'object' || raw === null) return null
  const said = raw as { epic?: unknown; parts?: unknown; kehikko?: unknown; kehikkoName?: unknown; kehikkoId?: unknown; partNames?: unknown }
  const epic = said.epic ?? null
  if (epic !== null && (typeof epic !== 'string' || !SLUG.test(epic))) return null
  const parts = said.parts ?? []
  if (!Array.isArray(parts) || parts.length > 200 || parts.some((one) => typeof one !== 'string' || !SLUG.test(one))) return null
  const kehikko = readKehikko(said.kehikko)
  if (kehikko === undefined) return null
  const ids = sortedParts(parts as string[])
  /* Names for the parts, by id: labels like the kehikko's, bounded and never compared. Given in
     any order and for any subset; what comes out is in the order of `parts`. */
  const names = typeof said.partNames === 'object' && said.partNames !== null && !Array.isArray(said.partNames) ? (said.partNames as Record<string, unknown>) : null
  const partNames = names ? ids.map((id) => (Object.hasOwn(names, id) && typeof names[id] === 'string' ? (names[id] as string).slice(0, 120) : '')) : undefined
  return {
    epic,
    parts: ids,
    kehikko,
    kehikkoName: typeof said.kehikkoName === 'string' ? said.kehikkoName.slice(0, 120) : undefined,
    ...(partNames?.some(Boolean) ? { partNames } : {}),
    /* The host's row number, carried only to be written beside a key as a note. */
    ...(kehikko && 'key' in kehikko && typeof said.kehikkoId === 'number' && Number.isSafeInteger(said.kehikkoId) ? { kehikkoId: said.kehikkoId } : {}),
  }
}

/**
 * Read the opening frame, refusing anything that is not one. A string is the
 * sentence to close the socket with. The ticket is compared first, whole and
 * in constant time.
 */
export function opening(raw: unknown, ticket: string = TICKET): Opening | string {
  if (typeof raw !== 'string') return 'The first frame must be text.'
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'The first frame must be JSON naming a ticket.'
  }
  if (typeof parsed !== 'object' || parsed === null) return 'The first frame must be a JSON object.'
  const held = parsed as Record<string, unknown>
  if (typeof held.ticket !== 'string' || !sameTicket(held.ticket, ticket)) {
    return 'That did not carry this module’s ticket. Only the page this module serves has it.'
  }
  const cols = size(held.cols, 20, 500, 80)
  const rows = size(held.rows, 5, 200, 24)
  if (held.install === true) return { what: 'install', cols, rows }

  if (typeof held.projectPath !== 'string' || !held.projectPath) return 'A session belongs to a project, and no project was named.'
  const place = readPlace(held.place)
  if (!place) return 'That did not say which place the session is for.'
  const session = held.session ?? null
  if (session !== null && (typeof session !== 'string' || !PROGRAM.isId(session))) return 'That is not a session id.'
  return { what: 'session', projectPath: held.projectPath, place, session, cols, rows }
}

/* ------------------------------------------------------------------------ *
 * The runs
 * ------------------------------------------------------------------------ */

/** The least of a pty this file uses, so a test can stand one in. */
export interface Pty {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(heard: (chunk: string) => void): unknown
  onExit(heard: (exit: { exitCode: number }) => void): unknown
}

export type Spawn = (
  file: string,
  args: string[],
  options: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv },
) => Pty | Promise<Pty>

/** The second emulator: fed what the pty says, asked for the screen when a viewer arrives. */
export interface Screen {
  write(data: string, done?: () => void): void
  resize(cols: number, rows: number): void
  /** The screen and its scrollback, as bytes a fresh emulator can be written. */
  serialize(): string
  dispose(): void
}

/** One socket watching a run. `output` is the program's bytes; `say` is this module's own word. */
export interface Viewer {
  output(data: string): void
  say(message: Record<string, unknown>): void
  close(code: number, reason: string): void
}

export interface Run {
  what: 'session' | 'install'
  /** The id it was opened under. */
  id: string
  /** The id the program recorded it under, once it has recorded anything. */
  settled: string | null
  projectPath: string
  /** The place a new session is recorded for once it exists. */
  place: NamedPlace | null
  /** The place it was last opened from, with the names a person knows it by. For a notice. */
  at: NamedPlace | null
  key: string | null
  label: string
  /** How many times the program has been asked what this session is called. Bounded: some never have a first prompt. */
  asked: number
  /** Whether a person has typed anything into it. The emulator's own replies do not count (see `input.ts`). */
  touched: boolean
  /** When the program last printed, a person last typed, or the last person looked away: what `QUIET_REST` counts from when nothing is known. */
  stirredAt: number
  /** When the program last printed anything. */
  printedAt: number
  /** When a person last typed into it or last looked away from it: what a finished session's rest is counted from. */
  attendedAt: number
  /** What the program last said it is doing, or null when it has said nothing that still holds. */
  state: State | null
  /** Since when. Meaningless while `state` is null. */
  stateSince: number
  /** What a report has to carry to be believed about this run. Null for one that was not asked to report. */
  secret: string | null
  /** How many notices it may still raise, and when that was last true (see `NOTICES_AT_ONCE`). */
  notices: { left: number; at: number }
  /** Put away by `rest`, so that its viewers are told that and not that it ended. */
  rested: boolean
  /** The clock on an untouched, unrecorded run nobody is watching (see `UNTOUCHED_GRACE`). */
  idle: ReturnType<typeof setTimeout> | null
  startedAt: number
  pty: Pty
  screen: Screen
  viewers: Set<Viewer>
  /**
   * The viewers that have it on screen. A page keeps views of other places
   * mounted behind the one it shows, each with its socket open, so "has a
   * viewer" is not "is being looked at"; the page says which (`look`).
   */
  looking: Set<Viewer>
  ended: boolean
}

export type Refusal = { code: number; why: string }

/**
 * Something worth telling a person who is not looking: a session of theirs
 * came to need them, or finished.
 *
 * It is raised here and said by a page, because only a page can speak to a
 * host (the wire is `postMessage`), and it carries no sentence: the page
 * writes one from these fields. What a person wrote — the session's label,
 * the names of the place — is theirs; nothing in it came from a report.
 */
export interface Notice {
  seq: number
  session: string
  state: 'needs-you' | 'finished'
  label: string
  projectPath: string
  epic: string | null
  /** The picked parts by what a person calls them, falling back to their ids. */
  parts: string[]
  kehikko: string
  at: number
}

/** One session's state, as a feed says it. */
export interface Stated {
  session: string
  state: State | null
  since: number
}

/** Something following along: every change of state, and — when it asked for them — notices. */
export interface Follower {
  /** Whether this one can pass a notice on to a host. */
  notices: boolean
  state(stated: Stated): void
  notice(notice: Notice): void
}

export interface RunsOptions {
  spawn: Spawn
  screen: (cols: number, rows: number) => Screen | Promise<Screen>
  program?: Program
  /** How long an untouched, unrecorded session outlives its last viewer. */
  grace?: number
  /** How long a session nobody is looking at may print nothing before it is put away. */
  quiet?: number
  /** How long a session called working may print nothing before it is called nothing. */
  stale?: number
  /** How long a page that has just arrived waits for what was held; 0 hands it over at once. */
  heldWait?: number
  /** The port a report is posted to: this server's own. Null (and before it is known) nothing is asked to report. */
  port?: () => number | null
  /** How often the quiet ones are looked for; null for never, when a test calls `rest` itself. */
  every?: number | null
  now?: () => number
  log?: (line: string) => void
}

/**
 * Every run this process holds. A class so that a test can have one of its
 * own with a stand-in pty; the server has exactly one (see `theRuns`).
 */
export class Runs {
  readonly runs = new Map<string, Run>()
  private readonly program: Program
  private readonly grace: number
  private readonly quiet: number
  private readonly stale: number
  private readonly heldWait: number
  private readonly now: () => number
  private readonly log: (line: string) => void
  /** Opens in flight, by id, so two viewers arriving together get one run and not two. */
  private readonly starting = new Map<string, Promise<Run | Refusal>>()
  /** Pages following along (see `subscribe`). */
  private readonly followers = new Set<Follower>()
  /** Notices no page was there to take, oldest first. */
  private readonly held: Notice[] = []
  private noticed = 0
  /** Where reports are posted. Set by whoever knows the port this server bound. */
  port: () => number | null

  constructor(private readonly options: RunsOptions) {
    this.program = options.program ?? PROGRAM
    this.grace = options.grace ?? UNTOUCHED_GRACE
    this.quiet = options.quiet ?? QUIET_REST
    this.stale = options.stale ?? STALE_WORK
    this.heldWait = options.heldWait ?? HELD_WAIT
    this.port = options.port ?? (() => null)
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => {})
    const every = options.every === undefined ? Math.min(REST_EVERY, this.quiet) : options.every
    if (every !== null) setInterval(() => this.rest(), every).unref?.()
  }

  /** The run a session id names — by the id it was opened under or the one it settled as. */
  find(id: string): Run | null {
    for (const run of this.runs.values()) {
      if (run.what === 'session' && (run.id === id || run.settled === id)) return run
    }
    return null
  }

  /** The sessions running now, oldest first. */
  sessions(): Run[] {
    return [...this.runs.values()].filter((run) => run.what === 'session').sort((a, b) => a.startedAt - b.startedAt)
  }

  /**
   * Open a session for a viewer: attach to it if it is running, start it if
   * it is not. `session: null` is a new one.
   *
   * A new one is started `fresh` under an id minted here. An id that was
   * ASKED for is opened only if the program holds a record for it on this
   * machine, and then it is `resume`d. One it holds nothing for is refused —
   * whatever `places.json` says about it. That file travels with the project
   * and a transcript does not: the id may be a session on another computer,
   * or one whose transcript has been cleaned away here, and starting the
   * program fresh under it would be a new, empty conversation wearing the
   * old one's id — and, back on the other computer, a clash with the real
   * one.
   */
  async open(asked: Extract<Opening, { what: 'session' }>, viewer: Viewer): Promise<Run | Refusal> {
    const root = projectRoot(asked.projectPath)
    if (!root.ok) return { code: CLOSED.refused, why: root.error }
    const projectPath = root.value

    const running = asked.session ? this.find(asked.session) : null
    if (running) {
      if (running.projectPath !== projectPath) return { code: CLOSED.refused, why: 'That session is running in another project.' }
      this.remember(running, asked.place)
      this.attach(running, viewer, asked.cols, asked.rows, 'attached')
      return running
    }

    const id = asked.session ?? this.program.newId()
    const inFlight = this.starting.get(id)
    const started = inFlight ?? this.start(projectPath, id, asked)
    if (!inFlight) {
      this.starting.set(id, started)
      void started.finally(() => this.starting.delete(id))
    }
    const run = await started
    if ('code' in run) return run
    this.attach(run, viewer, asked.cols, asked.rows, inFlight ? 'attached' : run.settled ? 'resumed' : 'new')
    return run
  }

  private async start(projectPath: string, id: string, asked: Extract<Opening, { what: 'session' }>): Promise<Run | Refusal> {
    const found = this.program.find()
    if (!found.file) return { code: CLOSED.missing, why: `${this.program.name} is not installed.` }

    const settled = await this.program.settled(projectPath, id, 0)
    if (asked.session && !settled) {
      return { code: CLOSED.refused, why: `${this.program.name} has no session by that id for this project on this computer.` }
    }
    /* And nothing about how many are running: see "There is no limit" at the top. */

    /* Asked to report only when this copy can take the asking and there is
       somewhere to report to. Otherwise the command is the two words it
       always was, and the session has no state. */
    const port = this.port()
    const tells = port !== null && (await this.program.supports(found.file)).tells
    const secret = tells ? randomBytes(24).toString('hex') : null
    const args = [...(settled ? this.program.resume(settled) : this.program.fresh(id)), ...(tells ? this.program.reports(tellLine) : [])]
    let pty: Pty
    let screen: Screen
    try {
      screen = await this.options.screen(asked.cols, asked.rows)
      pty = await this.options.spawn(found.file, args, {
        cwd: projectPath,
        cols: asked.cols,
        rows: asked.rows,
        env: {
          ...this.program.environment(),
          TERM,
          /* The secret travels here and nowhere else: not in `args`, which any
             process on the machine can list, and not in a file. */
          ...(secret ? { [TELL_ENV.port]: String(port), [TELL_ENV.secret]: secret, [TELL_ENV.session]: settled ?? id } : {}),
        },
      })
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      this.log(`claude: could not start ${found.file} in ${projectPath} — ${why}`)
      return { code: CLOSED.failed, why: `${this.program.name} could not be started on this machine.` }
    }

    const run: Run = {
      what: 'session',
      id,
      settled,
      projectPath,
      place: asked.place,
      at: asked.place,
      key: placeKey(asked.place),
      label: '',
      asked: 0,
      touched: false,
      stirredAt: this.now(),
      printedAt: this.now(),
      attendedAt: this.now(),
      state: null,
      stateSince: this.now(),
      secret,
      notices: { left: NOTICES_AT_ONCE, at: this.now() },
      rested: false,
      idle: null,
      startedAt: this.now(),
      pty,
      screen,
      viewers: new Set(),
      looking: new Set(),
      ended: false,
    }
    this.runs.set(id, run)
    this.log(`claude: ${found.file} ${args.slice(0, 2).join(' ')}${tells ? ', asked to report' : ''} in ${projectPath} (pid ${pty.pid})`)
    if (settled) this.remember(run, asked.place)
    this.follow(run)
    return run
  }

  /**
   * Record that this run's session belongs to a place — if the session exists.
   * One that does not yet is recorded by `settle` when it does.
   */
  private remember(run: Run, place: NamedPlace): void {
    run.at = place
    if (!run.settled) return
    const written = attach(run.projectPath, place, run.settled, { label: run.label, lastActive: this.now() })
    if (!written.ok) this.log(`claude: ${written.error}`)
  }

  private follow(run: Run): void {
    let asked = 0
    run.pty.onData((chunk) => {
      run.stirredAt = this.now()
      run.printedAt = run.stirredAt
      run.screen.write(chunk)
      for (const viewer of run.viewers) viewer.output(chunk)
      /* A new session exists once the program has written its record, which
         is when the person first says something. Asked when the program
         speaks rather than on a clock, and not more often than this. */
      if (run.what === 'session' && (!run.settled || (!run.label && run.asked < LABEL_TRIES)) && this.now() - asked >= SETTLE_EVERY) {
        asked = this.now()
        void this.settle(run)
      }
    })
    run.pty.onExit(({ exitCode }) => {
      run.ended = true
      if (run.idle) clearTimeout(run.idle)
      this.runs.delete(run.id)
      /* Gone: no state to show for it, and nothing held about it is still true. */
      if (run.what === 'session') {
        run.state = null
        this.tell(run)
      }
      void this.finish(run, exitCode)
    })
  }

  /** Ask the program whether this session exists yet, and what it is called; record what it says. */
  async settle(run: Run): Promise<void> {
    if (run.what !== 'session') return
    if (!run.settled) {
      run.settled = await this.program.settled(run.projectPath, run.id, run.startedAt)
      if (!run.settled) return
      for (const viewer of run.viewers) viewer.say({ exists: true, session: run.settled })
    }
    run.asked += 1
    const known = (await this.program.sessions(run.projectPath)).find((one) => one.id === run.settled)
    const label = known?.label ?? ''
    if (run.place) {
      const written = attach(run.projectPath, run.place, run.settled, { label, lastActive: known?.lastActive })
      if (!written.ok) this.log(`claude: ${written.error}`)
      run.place = null
    } else {
      note(run.projectPath, run.settled, { label, lastActive: known?.lastActive })
    }
    if (label && label !== run.label) {
      run.label = label
      for (const viewer of run.viewers) viewer.say({ label, session: run.settled })
    }
  }

  private async finish(run: Run, exitCode: number): Promise<void> {
    let code: number = run.rested ? CLOSED.rested : CLOSED.ended
    let why = run.rested ? 'put away while it was quiet' : `the session ended (${exitCode})`
    if (run.what === 'install') {
      const found = this.program.find()
      const done = exitCode === 0 && found.file !== null
      code = done ? CLOSED.installed : CLOSED.notInstalled
      why = done ? `installed at ${found.file}` : exitCode === 0 ? 'the installer finished and no binary was found' : `the installer exited with ${exitCode}`
      this.log(`claude: the installer exited with ${exitCode}; ${found.file ?? 'no binary found'}`)
    } else {
      await this.settle(run).catch(() => {})
      this.log(`claude: session ${run.settled ?? run.id} ended (${exitCode})`)
    }
    for (const viewer of run.viewers) viewer.close(code, why)
    run.viewers.clear()
    run.looking.clear()
    run.screen.dispose()
  }

  /**
   * Put a viewer on a run: the screen as it stands, then everything after.
   *
   * The screen is asked for from inside the emulator's own write queue, so
   * what is sent is everything the pty said up to this moment and the viewer
   * joins exactly there — nothing twice and nothing missed. Then the pty is
   * told this viewer's size, which is also what makes a full-screen program
   * redraw itself for the window it is now in.
   */
  attach(run: Run, viewer: Viewer, cols: number, rows: number, how: 'new' | 'resumed' | 'attached' | 'install'): void {
    if (run.idle) clearTimeout(run.idle)
    run.idle = null
    viewer.say({
      opened: how,
      session: run.what === 'session' ? (run.settled ?? run.id) : null,
      label: run.label,
      exists: Boolean(run.settled),
      state: run.state,
      since: run.stateSince,
    })
    /* On screen until the page says otherwise: a view connects when it is shown. */
    run.looking.add(viewer)
    run.screen.write('', () => {
      if (run.ended) return
      const screen = run.screen.serialize()
      if (screen) viewer.output(screen)
      run.viewers.add(viewer)
      this.resize(run, cols, rows)
    })
  }

  /**
   * The page says whether this viewer has the run on screen. A view mounted
   * behind another keeps following, and is not somebody looking.
   */
  look(run: Run, viewer: Viewer, looking: boolean): void {
    if (run.ended) return
    if (looking) {
      run.looking.add(viewer)
      return
    }
    if (run.looking.delete(viewer) && run.looking.size === 0) this.left(run)
  }

  /** The last person looking at it looked away. */
  private left(run: Run): void {
    run.stirredAt = this.now()
    run.attendedAt = run.stirredAt
  }

  /**
   * The program in a session reported something (see "Told, not read").
   *
   * `session` is the id the pty was started on and `secret` what the report
   * carried. False for anything that is not a running session's own report;
   * the caller answers every such thing the same way, so that what is running
   * cannot be learned by asking.
   */
  heard(session: string, secret: string | null, event: string): boolean {
    const run = this.runs.get(session)
    if (!run || run.what !== 'session' || run.ended || !run.secret || !sameTicket(secret, run.secret)) return false
    const state = this.program.signal(event)
    if (state) this.become(run, state)
    return true
  }

  /**
   * A session's state changed. Said to everything following, and — when it
   * came to need the person or finished while nobody had it on screen —
   * raised as a notice, once.
   *
   * "Once" is per change: a second report of the same state is not a change.
   * Nothing is raised about a session somebody is looking at — they saw it —
   * and a session that has spent its ration (`NOTICES_AT_ONCE`) waits.
   */
  private become(run: Run, state: State | null): void {
    if (run.state === state) return
    run.state = state
    run.stateSince = this.now()
    this.tell(run)
    if (state !== 'needs-you' && state !== 'finished') return
    if (run.looking.size > 0) return
    const ration = run.notices
    ration.left = Math.min(NOTICES_AT_ONCE, ration.left + (this.now() - ration.at) / NOTICE_EVERY)
    ration.at = this.now()
    if (ration.left < 1) return
    ration.left -= 1
    const at = run.at
    this.noticed += 1
    this.raise({
      seq: this.noticed,
      session: run.settled ?? run.id,
      state,
      label: run.label,
      projectPath: run.projectPath,
      epic: at?.epic ?? null,
      parts: (at?.parts ?? []).map((id, index) => at?.partNames?.[index] || id),
      kehikko: at?.kehikkoName ?? '',
      at: this.now(),
    })
  }

  /** Say a session's state to its viewers and to every page following. */
  private tell(run: Run): void {
    const stated: Stated = { session: run.settled ?? run.id, state: run.state, since: run.stateSince }
    for (const viewer of run.viewers) viewer.say({ ...stated })
    for (const follower of this.followers) follower.state(stated)
  }

  /**
   * Hand a notice to ONE page that can pass it on — the one that began
   * following last — or hold it for the next that arrives. One, because every
   * page of this module could say it and a person should be told once.
   */
  private raise(notice: Notice): void {
    const taker = [...this.followers].reverse().find((one) => one.notices)
    if (taker) return taker.notice(notice)
    this.held.push(notice)
    if (this.held.length > NOTICES_HELD) this.held.shift()
  }

  /**
   * Follow along: told every change of state from now on, and — a moment
   * later (`HELD_WAIT`) — handed the notices nobody was there for: those
   * that are still true then, which is to say the session is still in that
   * state and still on nobody's screen. Returns the function that stops
   * following.
   */
  subscribe(follower: Follower): () => void {
    this.followers.add(follower)
    for (const run of this.sessions()) {
      if (run.state) follower.state({ session: run.settled ?? run.id, state: run.state, since: run.stateSince })
    }
    const hand = () => {
      if (!this.followers.has(follower)) return
      for (const notice of this.held.splice(0)) {
        const run = this.find(notice.session)
        if (run && run.state === notice.state && run.looking.size === 0) follower.notice(notice)
      }
    }
    if (follower.notices && this.held.length) {
      if (this.heldWait > 0) setTimeout(hand, this.heldWait).unref?.()
      else hand()
    }
    return () => void this.followers.delete(follower)
  }

  /**
   * Put away the sessions that are done and that nobody is looking at
   * (see `QUIET_REST`). Called on a clock; returns the ones it ended.
   *
   * What decides is what the session's program has said it is doing:
   *
   *  - `working`, `needs-you`: never. Not after an hour and not after a day.
   *    One is an agent mid-task; the other holds a question whose answer
   *    exists nowhere but in that process.
   *  - `finished`: once it has been finished, and left alone, for the whole
   *    time. Counted from the turn ending, the last thing a person typed, or
   *    the last person looking away, whichever is latest. What it prints at
   *    its prompt does not start the clock again.
   *  - nothing known — a copy too old to report, or one whose reports do not
   *    arrive: the rule there was before, silence for the whole time.
   *
   * Never one somebody has on screen, and never the installer. Nothing is
   * recorded and nothing is said to a person: a viewer still following from
   * behind another view is told `rested` and lets go, and the place resumes
   * the session when it is next opened.
   *
   * This is also where a `working` that has outlived its evidence is taken
   * back (see `STALE_WORK`).
   */
  rest(): Run[] {
    const put: Run[] = []
    for (const run of this.runs.values()) {
      if (run.what !== 'session' || run.ended || run.rested) continue
      if (run.state === 'working' && this.now() - run.printedAt >= this.stale) {
        this.log(`claude: ${run.settled ?? run.id} was working and has printed nothing for ${Math.round((this.now() - run.printedAt) / 60_000)} min — its state is no longer known`)
        this.become(run, null)
      }
      if (run.looking.size > 0 || run.state === 'working' || run.state === 'needs-you') continue
      const finished = run.state === 'finished'
      const quietFor = this.now() - (finished ? Math.max(run.stateSince, run.attendedAt) : run.stirredAt)
      if (quietFor < this.quiet) continue
      run.rested = true
      this.log(
        `claude: put away ${run.settled ?? run.id}, which nobody was looking at and which had ${finished ? 'been finished' : 'printed nothing'} for ${Math.round(quietFor / 60_000)} min — its place resumes it`,
      )
      kill(run.pty)
      put.push(run)
    }
    return put
  }

  detach(run: Run, viewer: Viewer): void {
    run.viewers.delete(viewer)
    if (run.looking.delete(viewer) && run.looking.size === 0) this.left(run)
    if (run.what !== 'session' || run.ended || run.viewers.size > 0 || run.touched || run.settled || run.idle) return
    run.idle = setTimeout(() => {
      run.idle = null
      if (run.ended || run.viewers.size > 0 || run.touched) return
      /* Asked once more: the program may have recorded it since. */
      void this.settle(run)
        .catch(() => {})
        .then(() => {
          if (run.ended || run.viewers.size > 0 || run.touched || run.settled) return
          this.log(`claude: ended ${run.id}, which nobody had typed into and nobody was looking at`)
          kill(run.pty)
        })
    }, this.grace)
    run.idle.unref?.()
  }

  resize(run: Run, cols: number, rows: number): void {
    if (run.ended) return
    try {
      run.pty.resize(cols, rows)
      run.screen.resize(cols, rows)
    } catch {
      /* A resize the pty refuses is dropped rather than ending somebody's session over a number. */
    }
  }

  /**
   * Hand the program what the page's emulator sent. All of it reaches the
   * program — its questions have to be answered — and only what a person
   * typed marks the session as typed into (see `input.ts`).
   */
  type(run: Run, data: string): void {
    if (run.ended) return
    if (typedByPerson(data)) {
      run.touched = true
      run.stirredAt = this.now()
      run.attendedAt = run.stirredAt
      /* The program reports a question being asked and never one being
         answered (program.ts). A person typing into a session that was
         waiting for them is that answer. A lone Esc is the exception: it
         dismisses the question without answering it, and the session still
         needs them. */
      if (run.state === 'needs-you' && data !== '\x1b') this.become(run, 'working')
    }
    run.pty.write(data)
  }

  /**
   * Run the vendor's installer, in a pty the person is watching.
   *
   * Reached only from a press in the page — there is no other caller, and
   * nothing at server start, in the MCP door or in a project can get here. It
   * is refused outright while a usable copy is installed, so the socket is
   * not a way to run the installer again at will. The command is said on the
   * first line, exactly as it is run, before any of its output.
   */
  async install(asked: Extract<Opening, { what: 'install' }>, viewer: Viewer): Promise<Run | Refusal> {
    const running = this.runs.get(INSTALL)
    if (running) {
      this.attach(running, viewer, asked.cols, asked.rows, 'install')
      return running
    }
    const found = this.program.find()
    if (found.file && (await this.program.supports(found.file)).ok) {
      return { code: CLOSED.installed, why: `installed at ${found.file}` }
    }
    const { line } = this.program.install()
    let pty: Pty
    let screen: Screen
    try {
      screen = await this.options.screen(asked.cols, asked.rows)
      pty = await this.options.spawn('/bin/sh', ['-c', line], {
        cwd: home(),
        cols: asked.cols,
        rows: asked.rows,
        env: { ...this.program.environment(), TERM },
      })
    } catch (error) {
      this.log(`claude: the installer could not be started — ${error instanceof Error ? error.message : String(error)}`)
      return { code: CLOSED.failed, why: 'the installer could not be started on this machine' }
    }
    const run: Run = {
      what: 'install',
      id: INSTALL,
      settled: null,
      projectPath: '',
      place: null,
      at: null,
      key: null,
      label: '',
      asked: 0,
      touched: false,
      stirredAt: this.now(),
      printedAt: this.now(),
      attendedAt: this.now(),
      state: null,
      stateSince: this.now(),
      secret: null,
      notices: { left: NOTICES_AT_ONCE, at: this.now() },
      rested: false,
      idle: null,
      startedAt: this.now(),
      pty,
      screen,
      viewers: new Set(),
      looking: new Set(),
      ended: false,
    }
    this.runs.set(INSTALL, run)
    this.log(`claude: installing, on a press in the page — ${line}`)
    run.screen.write(`$ ${line}\r\n`)
    this.follow(run)
    this.attach(run, viewer, asked.cols, asked.rows, 'install')
    return run
  }

  /** End a session because a person chose to. False when nothing by that id is running. */
  end(id: string): boolean {
    const run = this.find(id)
    if (!run) return false
    kill(run.pty)
    return true
  }

  /** End everything: this process is stopping, and nothing it started may outlive it. */
  endAll(): void {
    for (const run of this.runs.values()) kill(run.pty)
  }
}

const INSTALL = 'install'

/** The process and everything it started: the group first, then the pty. */
function kill(pty: Pty): void {
  try {
    if (pty.pid > 1) process.kill(-pty.pid, 'SIGHUP')
  } catch {
    /* Already gone, or never had its own group. */
  }
  try {
    pty.kill()
  } catch {
    /* Same. */
  }
}

/* ------------------------------------------------------------------------ *
 * The one set of runs this process has, and the socket in front of it
 * ------------------------------------------------------------------------ */

const HELD = Symbol.for('kehikot.claude.runs')

/**
 * This process's runs, found again by whoever asks.
 *
 * On `globalThis` rather than at module scope, because Vite restarts its dev
 * server IN PROCESS when the config or anything it imports changes, and the
 * restarted server imports this file afresh. A registry at module scope would
 * be a second, empty one, with the first one's sessions still running and
 * nothing left that could find or end them.
 */
export function theRuns(log: (line: string) => void = () => {}): Runs {
  const held = globalThis as { [HELD]?: Runs }
  if (held[HELD]) return held[HELD]

  const runs = new Runs({
    log,
    /* Native and CommonJS, so imported when first needed: the tests are about
       the deciding and must run without a compiled binary. */
    spawn: async (file, args, options) => {
      const nodePty = await import('node-pty')
      return nodePty.spawn(file, args, { name: TERM, ...options })
    },
    screen: headless,
  })
  held[HELD] = runs

  /* Stopping, however it is asked. `exit` covers Vite's own handling of
     SIGTERM; the signals are here for when nothing else is listening. */
  process.on('exit', () => runs.endAll())
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => {
      runs.endAll()
      if (process.listenerCount(signal) === 0) process.exit(0)
    })
  }
  return runs
}

/** The headless emulator behind a run, and the addon that writes its screen out. */
export async function headless(cols: number, rows: number): Promise<Screen> {
  const [xterm, addon] = await Promise.all([import('@xterm/headless'), import('@xterm/addon-serialize')])
  const { Terminal } = (xterm as unknown as { default?: typeof xterm }).default ?? xterm
  const { SerializeAddon } = (addon as unknown as { default?: typeof addon }).default ?? addon
  const terminal = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
  const serializer = new SerializeAddon()
  terminal.loadAddon(serializer as unknown as Parameters<typeof terminal.loadAddon>[0])
  return {
    write: (data, done) => terminal.write(data, done),
    resize: (c, r) => terminal.resize(c, r),
    serialize: () => serializer.serialize(),
    dispose: () => terminal.dispose(),
  }
}

/** The least a server has to be for this to attach to it (Vite's may be HTTP/2, which is not `http.Server`). */
export interface Upgradable {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown
}

/** The path the socket answers on. */
export const SOCKET = '/session'

/**
 * Attach the socket to an HTTP server's upgrade event. `noServer`, because
 * the port is Vite's and a module is one origin: a second listener would make
 * this module's own socket cross-origin to its own page.
 */
export function serveSessions(server: Upgradable, port: number, log: (line: string) => void): void {
  const runs = theRuns(log)
  /* Where a session's program reports to: this server, on the port it really bound. */
  runs.port = () => port
  void (async () => {
    const { WebSocketServer } = await import('ws')
    const sockets = new WebSocketServer({ noServer: true })

    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      /* Vite's own HMR websocket shares this server. Anything not ours is left alone. */
      if (url.pathname !== SOCKET) return
      const gate = fenced({ origin: request.headers.origin, host: request.headers.host }, port)
      if (!gate.ok) {
        log(`claude: refused an upgrade — ${gate.why}`)
        /* A bare 403. Which check failed is logged here and not sent. */
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      sockets.handleUpgrade(request, socket, head, (ws) => hold(ws, runs, log))
    })
    log(`claude: ready on ws://127.0.0.1:${port}${SOCKET}`)
  })().catch((error: unknown) => {
    log(`claude: could not start — ${error instanceof Error ? error.message : String(error)}`)
  })
}

/**
 * One connection: silent, then admitted, then a viewer on a run.
 *
 * The two directions are told apart by the KIND of frame and not by anything
 * inside one. What the program prints goes to the page as binary and is
 * written to the emulator unread; what this module says to its own page is
 * text. A program cannot print its way into the second.
 */
function hold(ws: import('ws').WebSocket, runs: Runs, log: (line: string) => void): void {
  let run: Run | null = null
  let admitted = false
  /* What arrives between admission and the run existing: the page sends its
     first resize a millisecond behind the opening frame. Read as a second
     opening frame it would be refused in the words for a wrong ticket — the
     race Terminal had and fixed. */
  const early: string[] = []

  const shut = (code: number, reason: string) => {
    try {
      ws.close(code, sayable(reason))
    } catch {
      try {
        ws.terminate()
      } catch {
        /* Gone. */
      }
    }
  }

  const viewer: Viewer = {
    output: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, 'utf8'))
    },
    say: (message) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
    },
    close: shut,
  }

  const silent = setTimeout(() => {
    if (!admitted) shut(CLOSED.silent, 'nothing was said')
  }, MUST_SPEAK_WITHIN)

  const heard = (text: string) => {
    if (!admitted) {
      clearTimeout(silent)
      const said = opening(text)
      if (typeof said === 'string') {
        log(`claude: ${said}`)
        shut(CLOSED.refused, said)
        return
      }
      admitted = true
      void (said.what === 'install' ? runs.install(said, viewer) : runs.open(said, viewer))
        .then((opened) => {
          if ('code' in opened) return shut(opened.code, opened.why)
          /* The socket ended while the run was starting. The run is not ended
             with it: it belongs to this process, and the page that comes back
             finds it. */
          if (ws.readyState !== ws.OPEN) return runs.detach(opened, viewer)
          run = opened
          for (const waiting of early.splice(0)) heard(waiting)
        })
        .catch((error: unknown) => {
          log(`claude: ${error instanceof Error ? error.message : String(error)}`)
          shut(CLOSED.failed, 'that could not be opened')
        })
      return
    }

    if (!run) {
      if (early.length < 64) early.push(text)
      return
    }

    /* Every frame after the first is an envelope: `d` is what the emulator
       sent (typing, and its own replies), `r` a resize, `w` whether the view
       is the one on screen, and anything else is dropped rather than typed
       into somebody's session. */
    let said: unknown
    try {
      said = JSON.parse(text)
    } catch {
      return
    }
    if (typeof said !== 'object' || said === null) return
    const frame = said as Record<string, unknown>
    if (typeof frame.d === 'string') return runs.type(run, frame.d)
    if (typeof frame.w === 'boolean') return runs.look(run, viewer, frame.w)
    if (typeof frame.r === 'object' && frame.r !== null) {
      const asked = frame.r as { cols?: unknown; rows?: unknown }
      runs.resize(run, size(asked.cols, 20, 500, 80), size(asked.rows, 5, 200, 24))
    }
  }

  ws.on('message', (data: unknown, isBinary: boolean) => {
    if (!isBinary) heard(String(data))
  })
  const gone = () => {
    clearTimeout(silent)
    /* The viewer leaves. The run stays. */
    if (run) runs.detach(run, viewer)
  }
  ws.on('close', gone)
  ws.on('error', gone)
}
