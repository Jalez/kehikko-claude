import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { basename, join } from 'node:path'
import type { Duplex } from 'node:stream'

import { PROJECT_ID, projectFile, readProjectFile } from 'kehikot-module-protocol'
import { mintTicket, sameTicket } from 'kehikot-module-protocol/serve'

import { typedByPerson } from './input.ts'
import { isKehikkoKey, kehikkoOf, placeKey, sortedParts, type Kehikko } from './place.ts'
import { PROGRAM, headOf, home, sessionName, type Active, type Program, type Running, type State } from './program.ts'
import { assign, attach, born, byToken, follow, homeOf, note, projectRoot, readPlaces, recordedIds, sighted, tokenFor, unassigned, type NamedPlace, type PlaceEntry, type Places } from './record.ts'
import { freshToken, hostDoors, removeConfig, writeConfig, type DoorsAsked, type SessionDoor } from './doorConfig.ts'
import { readPlaceKey } from './place.ts'

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
 * ## A conversation that is already running somewhere else
 *
 * A session this process started is found in `runs`, and a second viewer is
 * put on it. One it did NOT start — a Claude Code background session, one
 * left open in another terminal or in an editor — is not in `runs`, and
 * `claude --resume` on it would be a second process on the same conversation:
 * Remote Control stays with the first, each appends to the one history, and
 * neither sees the other's turns. So before every resume the program is asked
 * what is running (`active` in program.ts), and it is asked every time: a
 * session can start or stop between two opens, so no answer is kept.
 *
 *  - **Running in the background**: the pty is given `claude attach <handle>`
 *    in place of `--resume`. That is a view of the process that is already
 *    there. No second process holds the conversation, and Remote Control is
 *    where it was. The view is this module's to close; the session is not —
 *    ending the run here, putting it away, or this server stopping hangs up
 *    the view and leaves the session running (measured: the client gone, the
 *    session's own process untouched).
 *  - **Open in a process with a terminal of its own**: it cannot be attached
 *    to (`attach` answers "No job matching …" for one). Nothing is started.
 *    The socket is told who has it, since when and where (`elsewhere`), and
 *    is closed with `CLOSED.elsewhere`; the page puts the choice to the
 *    person in words. Only an opening frame that says `copy` — which only
 *    that press sends — resumes it anyway, and the run remembers what it is a
 *    copy of so that it can be said for as long as it is on screen.
 *  - **Nothing running**: resumed, exactly as before.
 *  - **The program cannot be asked** — a copy from before `agents --json` and
 *    `attach`, or one where the asking failed: resumed as before, and SAID,
 *    on the first line of the terminal and to the page. Not being able to ask
 *    is never treated as having heard "nothing is running".
 *
 * Nothing here stops, signals or takes over a process this module did not
 * start. The other process may be mid-task.
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
 * How often the program is asked what the background sessions this module
 * has a view of are doing, while it has any, and those of every watched
 * project's places while a page follows along (see `watch`, `Unviewed`). A view of a
 * background session is `claude attach`: its process was started elsewhere
 * and runs no hooks of this module's, so nothing is told — it is asked.
 * Measured at a tenth of a second per asking.
 */
const WATCH_EVERY = 7_000
/** The longest wait between two askings after the asking has failed: it doubles up to this. */
const WATCH_MOST = 60_000
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
/** How often a running session's process is asked which conversation it is showing (see `track`). */
const TRACK_EVERY = 10_000

/**
 * What a session is called in Claude Code's own lists, from where it belongs:
 * the project's folder, the epic, the picked parts by their headings, the
 * kehikko — `hippos-portal · kiosk-info-reel · Reel · main`.
 */
export function placeName(projectPath: string, place: NamedPlace | null): string {
  if (!place) return sessionName([basename(projectPath)])
  const parts = place.parts.map((id, at) => place.partNames?.[at] || id)
  return sessionName([basename(projectPath), place.epic, parts.join(' + '), place.kehikkoName])
}

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
  /** The session is open in another process that cannot be attached to, and nothing was started. The page asks. */
  elsewhere: 4409,
  /** Ended on a person's press to be resumed in the project's new folder: the page opens it again at once. */
  moved: 4002,
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
      /**
       * The project's permanent id (protocol 2.1.0, `context.projectId`), when the host sent one.
       * What tells a project whose folder was renamed from another project (`sameProject`).
       */
      projectId?: string | null
      place: NamedPlace
      /** The session to open, or null for a new one. */
      session: string | null
      /**
       * A person, told that the session is open in another process, chose to
       * open a copy anyway. A word and not an argument: the command it leads
       * to is `--resume <id>`, the same as ever. Absent unless it was said.
       */
      copy?: true
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
  const projectId = typeof held.projectId === 'string' && PROJECT_ID.test(held.projectId) ? held.projectId : null
  return { what: 'session', projectPath: held.projectPath, ...(projectId ? { projectId } : {}), place, session, ...(held.copy === true && session !== null ? { copy: true as const } : {}), cols, rows }
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
  /**
   * Where the project is NOW: what the record is written in, what the lists compare and what a
   * row says. The folder the program was started in until the project's folder is renamed or moved
   * while it runs; then the new one (`claim`).
   */
  projectPath: string
  /**
   * The folder the program was started in, and so its working directory and the project root it
   * keeps for its whole life. Never changes: after a rename the process goes on in the renamed
   * folder (macOS keeps a running process's directory), but under the old name.
   */
  cwd: string
  /** The project's permanent id: the host's, or read off `.kehikot/project.json` when it started. Null when neither said. */
  projectId: string | null
  /** Ended by a person to be started again where the project is now (`restartIn`): its viewers are told so. */
  restarting: boolean
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
  /**
   * How many background tasks the program said were still running when its turn last ended: the
   * number from its `Stop` hook and nothing else of it. Above zero, a finished turn is not a finished
   * session, and it is not put away (see `rest`). Zero when it said none, or said nothing.
   */
  background: number
  /**
   * The background session this run is a VIEW of: the pty holds `claude
   * attach`, and the session's own process is another one, started elsewhere.
   * Null for a session this module started itself.
   */
  joined: Active | null
  /** The other process that had this conversation open when a person chose to open a copy of it here. Null otherwise. */
  copyOf: Active | null
  /** Why the program could not be asked whether the session was running elsewhere before it was resumed. Null when it was asked. */
  unchecked: 'too-old' | 'failed' | null
  /** Put away by `rest`, so that its viewers are told that and not that it ended. */
  rested: boolean
  /** When the program was last asked which conversation this run's process is showing (see `track`). */
  trackedAt: number
  /** The clock on an untouched, unrecorded run nobody is watching (see `UNTOUCHED_GRACE`). */
  idle: ReturnType<typeof setTimeout> | null
  startedAt: number
  pty: Pty
  screen: Screen
  viewers: Set<Viewer>
  /**
   * Viewers that have attached and are waiting for the screen as it stands, each with what the
   * program has said since it asked. The screen is taken from inside the emulator's write queue,
   * so it holds everything said BEFORE the viewer asked and nothing after; what is said after is
   * kept here and sent behind the screen. Without it, output that arrived while the screen was
   * being taken reached neither: the viewer was not yet following, and the screen was already cut.
   */
  joining: Map<Viewer, string[]>
  /**
   * The viewers that have it on screen. A page keeps views of other places
   * mounted behind the one it shows, each with its socket open, so "has a
   * viewer" is not "is being looked at"; the page says which (`look`).
   */
  looking: Set<Viewer>
  ended: boolean
  /**
   * The conversation's place token (protocol 2.4.0), on every Kehikot door it
   * was given; null for a copy that cannot be given doors, and for a view of a
   * background session, which was started elsewhere.
   */
  token: string | null
  /** The doors it was started with, by module id: what "Restart to load …" compares against. */
  doors: SessionDoor[]
  /** Its `--mcp-config` file, removed when the process ends. */
  config: string | null
}

/** A conversation's place, as this module's record says it: what `/api/kehikot/place` answers. */
export interface RecordedPlace {
  conversation: string
  epic: string | null
  parts: string[]
  /** The kehikko's key; null for a place with none, or filed under an older host's row number. */
  kehikko: string | null
}

export type Refusal = { code: number; why: string; elsewhere?: Elsewhere }

/** The id in `<projectPath>/.kehikot/project.json`, read with the protocol's `readProjectFile`, or null. Never throws. */
export function projectIdAt(projectPath: string): string | null {
  const file = projectFile(projectPath)
  if (!file) return null
  try {
    return readProjectFile(JSON.parse(readFileSync(file, 'utf8')))?.id ?? null
  } catch {
    return null
  }
}

/**
 * Whether a run belongs to the project at `root` (resolved), asked by `id` when the asker knows it.
 *
 * ## A project whose folder is renamed while a session runs
 *
 * The host gives every project a permanent id (protocol 2.1.0) and, after a rename, sends the new
 * folder with the same id. The process keeps running — macOS keeps its working directory through the
 * rename — so the run is still this project's, at a new path. The path alone cannot say so, and a
 * path alone can also be wrong the other way: another project put where an old one was. So:
 *
 *   - both ids known: the ids decide, and nothing else;
 *   - the same folder, with an id missing on one side: the same project, as before ids;
 *   - otherwise only when the run's folder is gone AND the asked folder's `.kehikot/project.json`
 *     names the run's id — the case of an asker that sent no id (an agent through the MCP door, an
 *     older host).
 *
 * Never by string equality alone when both sides have an id.
 */
export function sameProject(
  run: { projectPath: string; projectId: string | null },
  root: string,
  id: string | null = null,
  idAt: (projectPath: string) => string | null = projectIdAt,
  there: (path: string) => boolean = existsSync,
): boolean {
  if (id && run.projectId) return id === run.projectId
  if (run.projectPath === root) return true
  if (!run.projectId) return false
  if (there(run.projectPath)) return false
  return idAt(root) === run.projectId
}

/** The sentence for a session whose project's folder was renamed under it: the run's word to its viewers. */
export function movedWord(run: Pick<Run, 'cwd' | 'projectPath'>): { moved: string | null; cwd: string } {
  return { moved: run.cwd && run.cwd !== run.projectPath ? run.projectPath : null, cwd: run.cwd }
}

/**
 * Where a session is running that this module did not start, as a page is
 * told it: what the program said, and nothing read off a process table.
 */
export interface Elsewhere {
  kind: Active['kind']
  /** The program's own word for the kind. */
  called: string
  pid: number | null
  cwd: string
  /** Since when, in milliseconds, or null when the program did not say. */
  since: number | null
  name: string
}

export const elsewhereOf = (one: Active): Elsewhere => ({ kind: one.kind, called: one.called, pid: one.pid, cwd: one.cwd, since: one.startedAt, name: one.name })

/**
 * The line put on a terminal's first row when a session was resumed without
 * the program having been asked whether it was already running. Dim, one
 * line, and only ever for a copy that cannot be asked.
 */
export function uncheckedLine(name: string, why: 'too-old' | 'failed'): string {
  const said =
    why === 'too-old'
      ? `This ${name} is too old to say whether a conversation is already running somewhere else (it has no \`agents --json\` or no \`attach\`), so this one was resumed without checking. Update ${name} to have that checked.`
      : `${name} could not be asked whether this conversation is already running somewhere else, so it was resumed without checking.`
  return `\x1b[2m${said}\x1b[0m\r\n`
}

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
  /** The picked parts' ids, as the place holds them (a press goes by id, never by name). */
  partIds?: string[]
  /** The kehikko's key, when the place is held by one. */
  kehikkoKey?: string | null
  at: number
}

/** One session's state, as a feed says it. */
export interface Stated {
  session: string
  state: State | null
  since: number
}

/**
 * One session as the host's activity list says it (protocol 1.5.0, `activity.set`): the
 * server knows every running session's state, label and place, so it is the one that
 * writes the list, and a page only passes it on. The shape is the protocol's `ActivityItem`.
 */
export interface ActivityRow {
  id: string
  state: 'working' | 'attention' | 'done'
  label: string
  place?: { epic?: string; parts?: string[]; kehikko?: string }
  since: number
  detail: string
  /** How pressing it is (protocol 1.7.0): absent is `normal`. The unassigned count is `low` — informational. */
  priority?: 'urgent' | 'normal' | 'low'
  /**
   * The folder of the project the session runs in (protocol 1.8.0). A session keeps running
   * when the person switches project, and the page framed now is the one that reports it; a
   * host that files by project puts it under its own, and the protocol's client sends a host
   * that does not only the open project's rows, without it.
   */
  project: string
}

/** The protocol's limits (`LIMITS.ACTIVITY_*`, `PLACE_PARTS`), spelled here because the server does not import the client. */
const ACTIVITY_ITEMS = 64
const ACTIVITY_LABEL = 120
const ACTIVITY_DETAIL = 200
const PLACE_PARTS = 16

const ACTIVITY_STATE = { working: 'working', 'needs-you': 'attention', finished: 'done' } as const
const ACTIVITY_ORDER = { attention: 0, working: 1, done: 2 } as const

const clip = (text: string, most: number): string => (text.length <= most ? text : `${text.slice(0, most - 1).trimEnd()}…`)

/**
 * The id of the one Inbox item that counts a project's unassigned conversations. One per project,
 * and a list spanning projects has no id twice (the protocol refuses that), so the project is in it.
 */
export const unassignedItem = (project: string): string => `unassigned-in:${createHash('sha256').update(project).digest('hex').slice(0, 16)}`

/**
 * The project's conversations that belong to no place, as ONE quiet Inbox
 * item: how many there are, and where the answers are. Null when there are
 * none, which closes the item.
 *
 * Not `attention`: a conversation started in a terminal or as a background
 * job is not waiting for anybody, and many of them were never meant for a
 * kehikko. It is `working` at `low` priority — the protocol's informational
 * item — so it is listed and counted without lighting "needs you" or Next.
 *
 * No `place`: a host opens an item without one by revealing this module's
 * container — on the kehikko on screen when that has one, else on a kehikko
 * of the project that does — and that container draws the answers (assign
 * here, to another kehikko, or "Not a Kehikot conversation") in its own page,
 * at any width. A `place` would only switch the kehikko.
 */
export function unassignedRow(places: Places, project: string, now: number): ActivityRow | null {
  const ids = unassigned(places)
  if (!ids.length) return null
  const first = places.sessions[ids[0]!]
  const name = ids.length === 1 ? (first?.label ?? '').replace(/\s+/g, ' ').trim() : ''
  const since = Math.min(...ids.map((id) => Date.parse(places.sessions[id]?.seen?.at ?? '') || now))
  return {
    id: unassignedItem(project),
    state: 'working',
    priority: 'low',
    label: clip(
      ids.length === 1
        ? `A Claude Code session isn’t assigned to a kehikko${name ? `: ${name}` : ''}`
        : `${ids.length} Claude Code sessions aren’t assigned to a kehikko`,
      ACTIVITY_LABEL,
    ),
    since,
    detail: clip(
      'Started outside Kehikot. Open the Claude container to assign them to a kehikko, or mark them “Not a Kehikot conversation”. With no Claude container on a kehikko, add one to answer.',
      ACTIVITY_DETAIL,
    ),
    project,
  }
}

/**
 * The COMPLETE list of the sessions whose state is known, most urgent first: needs you,
 * working, then finished by recency. A session with no state said is not in it. More than
 * 64 are cut from the end (the finished, oldest first). The label is clipped here, since
 * the protocol refuses a long one; a place with more than 16 parts leaves them out and
 * keeps the epic and the kehikko.
 */
export function activityRows(runs: Iterable<Run>, project: string | null = null, unviewed: Iterable<Unviewed> = []): ActivityRow[] {
  const rows: ActivityRow[] = []
  for (const run of runs) {
    if (run.what !== 'session' || run.ended || !run.state) continue
    /* One project's only, for a follower that asked for one; a page asks for every project's
       and each row says its own (`project`). */
    if (project !== null && !sameProject(run, project)) continue
    const state = ACTIVITY_STATE[run.state]
    const at = run.at
    const parts = at?.parts ?? []
    const place: NonNullable<ActivityRow['place']> = {}
    if (at?.epic) place.epic = at.epic
    if (parts.length > 0 && parts.length <= PLACE_PARTS) place.parts = [...parts]
    if (at?.kehikko && 'key' in at.kehikko) place.kehikko = at.kehikko.key
    const detail =
      run.state === 'needs-you'
        ? 'waiting for you: a permission or an answer'
        : run.state === 'finished'
          ? run.background > 0 ? `turn ended; ${run.background} background task${run.background === 1 ? '' : 's'} still running` : 'turn ended'
          : 'working'
    rows.push({
      id: run.settled ?? run.id,
      state,
      label: clip(run.label.replace(/\s+/g, ' ').trim() || 'Claude session', ACTIVITY_LABEL),
      ...(Object.keys(place).length > 0 ? { place } : {}),
      since: run.stateSince,
      detail: clip(detail, ACTIVITY_DETAIL),
      project: run.projectPath,
    })
  }
  /* The background sessions of the project's places that no run here is a view of (`Unviewed`).
     One row per session: a run holding the same session is the one that says it. */
  const said = new Set(rows.map((row) => row.id))
  for (const one of unviewed) {
    if (!one.state || said.has(one.session)) continue
    if (project !== null && one.projectPath !== project) continue
    said.add(one.session)
    const parts = one.at.parts
    const place: NonNullable<ActivityRow['place']> = {}
    if (one.at.epic) place.epic = one.at.epic
    if (parts.length > 0 && parts.length <= PLACE_PARTS) place.parts = [...parts]
    if (one.at.kehikko && 'key' in one.at.kehikko) place.kehikko = one.at.kehikko.key
    rows.push({
      id: one.session,
      state: ACTIVITY_STATE[one.state],
      label: clip(one.label.replace(/\s+/g, ' ').trim() || 'Claude session', ACTIVITY_LABEL),
      ...(Object.keys(place).length > 0 ? { place } : {}),
      since: one.since,
      detail: clip(one.state === 'needs-you' ? 'waiting for you: a permission or an answer' : one.state === 'finished' ? 'turn ended' : 'working', ACTIVITY_DETAIL),
      project: one.projectPath,
    })
  }
  rows.sort((a, b) => ACTIVITY_ORDER[a.state] - ACTIVITY_ORDER[b.state] || b.since - a.since || a.id.localeCompare(b.id))
  return rows.slice(0, ACTIVITY_ITEMS)
}

/**
 * A background session that belongs to one of a project's places and that no run here is a view
 * of: one the person started with `claude --bg`, or a place's conversation that Claude Code carried
 * on in a background session, in an epic nobody has a Claude view of right now. Its process is not
 * this module's and runs none of its hooks, so what it is doing is what the program says
 * (`agents --json`, its `state`), asked on the same clock as the views (`watch`).
 *
 * Built afresh on every asking from two things and nothing else: what the program says is running,
 * and the project's `places.json` — each place's sessions followed to where the conversation is now
 * (`headOf`). Never written anywhere.
 */
export interface Unviewed {
  /** The session the background process holds. */
  session: string
  /** The project (resolved) whose place holds it. */
  projectPath: string
  /** The place it belongs to: the one whose `current` it is, else the first that lists it. */
  at: NamedPlace
  label: string
  state: State | null
  since: number
}

/** A place as `places.json` holds it, as the rest of this file names one. */
export function placeOf(entry: PlaceEntry): NamedPlace {
  const kehikko = kehikkoOf(entry.kehikko)
  return {
    epic: entry.epic,
    parts: [...entry.parts],
    kehikko,
    ...(entry.kehikko?.name ? { kehikkoName: entry.kehikko.name } : {}),
  }
}

/** Something following along: every change of state, and — when it asked for them — notices. */
export interface Follower {
  /** Whether this one can pass a notice on to a host. */
  notices: boolean
  /** The project (resolved) whose sessions its activity list is about; null for every project's. */
  project?: string | null
  state(stated: Stated): void
  notice(notice: Notice): void
  /** The whole activity list, when it changes and once on arrival. */
  activity?(rows: ActivityRow[]): void
  /** A project's list of sessions changed under the page: one was reported started, not yet assigned. */
  sessions?(project: string): void
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
  /** How often background sessions with a view here are asked about (see `watch`); null for never, when a test calls `watch` itself. */
  watchEvery?: number | null
  now?: () => number
  log?: (line: string) => void
  /** Asks the host for a session's doors (`hostDoors`); a test stands one in. */
  doors?: (asked: DoorsAsked) => Promise<SessionDoor[] | null>
  /** Where `--mcp-config` files are written; this user's temporary folder by default. */
  configBase?: string
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
  /** The last activity list handed to each follower, as text, so that only a change is said. */
  private readonly activityIs = new Map<Follower, string>()
  /** Where reports are posted. Set by whoever knows the port this server bound. */
  port: () => number | null
  private readonly watchEvery: number | null
  /** The next asking about background sessions, while one is due (see `watch`). */
  private watchTimer: ReturnType<typeof setTimeout> | null = null
  /** An asking in flight: never two at once. */
  private watchBusy = false
  /** How many askings in a row have failed: the wait doubles with each, and only the first is logged. */
  private watchFailed = 0
  /**
   * The projects (resolved) whose places' background sessions are watched: every project a page or
   * an open has named since this server started. A project is named by the page framed in it, so
   * the background sessions of every epic and part of it are watched, not only those with a view.
   */
  private readonly projects = new Set<string>()
  /** The background sessions of those projects' places that no run here is a view of, by session (see `Unviewed`). */
  private readonly unviewed = new Map<string, Unviewed>()
  /** Where each project's places' sessions were followed to, kept while the record and what is running are unchanged. */
  private readonly heads = new Map<string, { stamp: string; heads: Map<string, string> }>()

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
    this.watchEvery = options.watchEvery === undefined ? WATCH_EVERY : options.watchEvery
  }

  /** Whether an asking about background sessions is due or under way. */
  get watching(): boolean {
    return this.watchTimer !== null || this.watchBusy
  }

  /** The runs that are views of a background session, still open. */
  private views(): Run[] {
    return [...this.runs.values()].filter((run) => run.what === 'session' && !run.ended && run.joined !== null)
  }

  /**
   * Whether there is anything to ask about: a view of a background session, or a project whose
   * places' background sessions are listed — the latter only while a page follows along, since
   * nothing else reads that list.
   */
  private due(): boolean {
    return this.views().length > 0 || (this.projects.size > 0 && this.followers.size > 0)
  }

  /**
   * Watch the background sessions of this project's places from now on (see `Unviewed`): what
   * every epic and part of it has running in the background is listed, whether or not anybody has
   * a view of it here. Asked at once when it is new, and then on the clock.
   */
  know(projectPath: string): void {
    if (this.projects.has(projectPath)) return
    this.projects.add(projectPath)
    this.kick()
  }

  /** Ask now, if something is to be asked about and the clock runs, and then keep the clock. */
  private kick(): void {
    if (this.watchEvery === null || this.watchBusy || !this.due()) return
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = null
    void this.watch().finally(() => this.keepWatching())
  }

  /** Have the next asking due, if there is a view to ask about and none is due or under way. */
  private keepWatching(): void {
    if (this.watchEvery === null || this.watchTimer || this.watchBusy || !this.due()) return
    const wait = this.watchFailed === 0 ? this.watchEvery : Math.min(WATCH_MOST, this.watchEvery * 2 ** Math.min(this.watchFailed, 10))
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null
      void this.watch().finally(() => this.keepWatching())
    }, wait)
    this.watchTimer.unref?.()
  }

  /**
   * Ask the program what each background session this module has a view of is
   * doing (`agents --json`, its `state`), and make that the run's state — so
   * that it is said, listed and noticed exactly as a session that reports is.
   *
   * A view runs `claude attach`, which runs no hooks of this module's: the
   * process that holds the session was started elsewhere. So its state is
   * asked, on a clock, for as long as there is a view open, and the clock
   * stops with the last one. One asking at a time. A failed asking changes
   * nothing, waits longer before the next, and is logged once until one works.
   * A session the program no longer lists has no state that still holds.
   */
  async watch(): Promise<void> {
    if (this.watchBusy || (this.views().length === 0 && this.projects.size === 0)) return
    this.watchBusy = true
    try {
      const running = await this.running()
      if (!running.known) {
        if (this.watchFailed === 0) this.log(`claude: could not ask what the background sessions are doing (${running.why === 'too-old' ? 'this copy has no `agents --json`' : 'the asking failed'}) — asking less often until it works`)
        this.watchFailed += 1
        return
      }
      if (this.watchFailed > 0) this.log('claude: asking what the background sessions are doing works again')
      this.watchFailed = 0
      for (const run of this.views()) {
        const listed = running.active.find((one) => one.kind === 'background' && one.session === run.joined!.session)
        this.become(run, listed?.state ?? null)
      }
      await this.see(running)
    } finally {
      this.watchBusy = false
    }
  }

  /**
   * The background sessions of every watched project's places that no run here is a view of, from
   * what the program says is running and each project's `places.json` — and nothing else. A place's
   * session is followed to where its conversation is now (`headOf`), since Claude Code carries a
   * conversation on under a new id. A session listed under several places is said once, under the
   * place whose `current` it is, else the first place that lists it. A change of state is said to
   * every follower, and a turn that ended or stopped for the person is noticed as a view's is; one
   * first seen in a state is listed and not noticed, since when it got there is not known.
   */
  private async see(running: Extract<Running, { known: true }>): Promise<void> {
    const background = new Map(running.active.filter((one) => one.kind === 'background').map((one) => [one.session, one]))
    const mine = new Set<string>()
    for (const run of this.runs.values()) {
      if (run.what !== 'session' || run.ended) continue
      mine.add(run.id)
      if (run.settled) mine.add(run.settled)
      if (run.joined) mine.add(run.joined.session)
    }
    const next = new Map<string, Unviewed>()
    if (background.size > 0) {
      for (const projectPath of this.projects) {
        const read = readPlaces(projectPath)
        if (!read.ok) continue
        const places = read.value
        const entries = Object.entries(places.places).sort(([a], [b]) => a.localeCompare(b))
        if (entries.length === 0) continue
        const heads = await this.headsOf(projectPath, places, running)
        /* The place whose current session it is first, then every other place that lists it. */
        const claims: [PlaceEntry, string][] = [
          ...entries.flatMap(([, entry]) => (entry.current ? [[entry, entry.current] as [PlaceEntry, string]] : [])),
          ...entries.flatMap(([, entry]) => entry.sessions.map((id) => [entry, id] as [PlaceEntry, string])),
        ]
        for (const [entry, id] of claims) {
          const head = heads.get(id) ?? id
          const listed = background.get(head)
          if (!listed || mine.has(head) || next.has(head)) continue
          const was = this.unviewed.get(head)
          const state = listed.state ?? null
          next.set(head, {
            session: head,
            projectPath,
            at: placeOf(entry),
            label: listed.name || places.sessions[head]?.label || places.sessions[id]?.label || '',
            state,
            since: was && was.state === state ? was.since : this.now(),
          })
        }
      }
    }
    const before = new Map(this.unviewed)
    const gone = [...before.values()].filter((one) => !next.has(one.session))
    const moved = [...next.values()].filter((one) => (before.has(one.session) ? before.get(one.session)!.state !== one.state : one.state !== null))
    this.unviewed.clear()
    for (const [id, one] of next) this.unviewed.set(id, one)
    for (const one of gone) if (!mine.has(one.session)) this.announce({ session: one.session, state: null, since: this.now() })
    for (const one of moved) {
      this.announce({ session: one.session, state: one.state, since: one.since })
      if (before.has(one.session)) this.noticeOf(one)
    }
    /* Said only where the list differs from what a follower was last handed (`changed`). */
    this.changed()
  }

  /**
   * Where each session `places` names is now (`headOf`): asked of the program's records once, and
   * kept until the record or what is running changes — a conversation is carried on only by a
   * process starting on it, which changes what is running.
   */
  private async headsOf(projectPath: string, places: Places, running: Extract<Running, { known: true }>): Promise<Map<string, string>> {
    const ids = recordedIds(places)
    const live = new Set<string>(running.active.map((one) => one.session))
    for (const run of this.runs.values()) if (run.settled) live.add(run.settled)
    const stamp = JSON.stringify([ids, [...live].sort()])
    const kept = this.heads.get(projectPath)
    if (kept?.stamp === stamp) return kept.heads
    const held = new Map((await this.program.sessions(projectPath, ids)).map((one) => [one.id, one]))
    const heads = new Map(ids.map((id) => [id, headOf(id, held, live)]))
    this.heads.set(projectPath, { stamp, heads })
    return heads
  }

  /** Say a session's state to every page following: one this module has no run for. */
  private announce(stated: Stated): void {
    for (const follower of this.followers) follower.state(stated)
  }

  /** A background session nobody has a view of came to need the person, or finished its turn: noticed once. */
  private noticeOf(one: Unviewed): void {
    if (one.state !== 'needs-you' && one.state !== 'finished') return
    const at = one.at
    this.noticed += 1
    this.raise({
      seq: this.noticed,
      session: one.session,
      state: one.state,
      label: one.label,
      projectPath: one.projectPath,
      epic: at.epic,
      parts: at.parts.map((id, index) => at.partNames?.[index] || id),
      kehikko: at.kehikkoName ?? '',
      partIds: [...at.parts],
      kehikkoKey: at.kehikko && 'key' in at.kehikko ? at.kehikko.key : null,
      at: this.now(),
    })
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
    this.know(projectPath)

    const running = asked.session ? this.find(asked.session) : null
    if (running) {
      if (!this.claim(running, projectPath, asked.projectId ?? null)) return { code: CLOSED.refused, why: 'That session is running in another project.' }
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
    if ('code' in run) {
      /* Said before the socket closes: a close reason is 123 bytes, and this is what the page asks its person with. */
      if (run.elsewhere) viewer.say({ elsewhere: run.elsewhere, session: id })
      return run
    }
    this.attach(run, viewer, asked.cols, asked.rows, inFlight ? 'attached' : run.joined ? 'background' : run.copyOf ? 'copy' : run.settled ? 'resumed' : 'new')
    return run
  }

  /**
   * Whether `run` is the project's at `root` (`sameProject`), and if it is and the project's folder
   * has moved since, follow it there: what is recorded is written in the new folder from now on,
   * the lists find it there, and its viewers are told that the program is still in the old one.
   * The process is not touched: it is never ended or restarted here.
   */
  claim(run: Run, root: string, id: string | null = null): boolean {
    if (run.what !== 'session' || !sameProject(run, root, id)) return false
    if (!run.projectId && id) run.projectId = id
    if (run.projectPath === root) return true
    this.log(`claude: the project of ${run.settled ?? run.id} moved from ${run.projectPath} to ${root}; the session runs on, started in ${run.cwd}`)
    run.projectPath = root
    for (const viewer of run.viewers) viewer.say({ session: run.settled ?? run.id, ...movedWord(run) })
    this.changed()
    return true
  }

  /**
   * A conversation this module did not start was reported in a project — by
   * Claude Code's SessionStart hook or `agents --json`. Recorded as not yet
   * assigned (one this module runs, or one that belongs somewhere, is left as
   * it is), and every page following that project reads its list again.
   */
  sighted(projectPath: string, id: string, via: 'hook' | 'agents', label = ''): boolean {
    if (!this.program.isId(id)) return false
    if ([...this.runs.values()].some((run) => run.id === id || run.settled === id)) return false
    const root = projectRoot(projectPath)
    if (!root.ok) return false
    const before = readPlaces(root.value)
    const written = sighted(root.value, id, via, this.now(), label)
    if (!written.ok) return false
    const was = before.ok ? JSON.stringify(before.value.sessions[id] ?? null) : ''
    if (JSON.stringify(written.value.sessions[id] ?? null) === was) return false
    this.log(`claude: ${id} was reported started in ${root.value} (${via}); it is listed there as not yet assigned`)
    this.projects.add(root.value)
    this.changed()
    for (const follower of this.followers) if (!follower.project || follower.project === root.value) follower.sessions?.(root.value)
    return true
  }

  /**
   * The place a token's conversation belongs to, as the record says — what a
   * Kehikot door is told (`/api/kehikot/place`). A conversation running here
   * that the program has not recorded yet belongs to the place it was started
   * at. Null for a token nothing here gave out.
   */
  placeOf(token: string, projectPath: string | null): RecordedPlace | null {
    const run = [...this.runs.values()].find((one) => one.token === token && !one.ended)
    const root = projectRoot(run?.projectPath ?? projectPath)
    const read = root.ok ? readPlaces(root.value) : null
    const recorded = read?.ok ? read.value : null
    const said = (conversation: string, key: string | null): RecordedPlace | null => {
      const place = key ? readPlaceKey(key) : null
      if (!place) return null
      return { conversation, epic: place.epic, parts: place.parts, kehikko: place.kehikko && 'key' in place.kehikko ? place.kehikko.key : null }
    }
    if (run) {
      const conversation = run.settled ?? run.id
      const home = recorded && run.settled ? homeOf(recorded, run.settled) : null
      return said(conversation, home ?? (run.place ? placeKey(run.place) : run.settled ? null : run.key))
    }
    const found = recorded ? byToken(recorded, token) : null
    return found ? said(found.id, found.home) : null
  }

  /**
   * Which doors a running session would be given now that it was not, and
   * which it has that its kehikko no longer holds — by name, for the line that
   * offers a restart. Null when it was given none, or the host does not answer.
   */
  async doorsChanged(id: string): Promise<{ added: string[]; removed: string[] } | null> {
    const run = this.find(id)
    if (!run?.token || !run.config) return null
    const kehikko = run.at?.kehikko && 'key' in run.at.kehikko ? run.at.kehikko.key : null
    const now = await (this.options.doors ?? hostDoors)({ projectPath: run.projectPath, projectId: run.projectId, token: run.token, kehikko }).catch(() => null)
    if (!now) return null
    const had = new Set(run.doors.map((door) => door.name))
    const has = new Set(now.map((door) => door.name))
    return { added: [...has].filter((name) => !had.has(name)), removed: [...had].filter((name) => !has.has(name)) }
  }

  /**
   * End a session whose project's folder was renamed under it, so that it is resumed in the new
   * folder: only on a person's press, and never while it is working. Its viewers are closed with
   * `CLOSED.moved` and open it again, which resumes the same session with the new folder as its
   * working directory. A sentence when it is not done.
   */
  restartIn(id: string, why: 'moved' | 'doors' = 'moved'): true | string {
    const run = this.find(id)
    if (!run) return 'That session is not running.'
    if (why === 'moved' && run.cwd === run.projectPath) return 'That session already runs in its project’s folder.'
    if (run.joined) return 'That is a view of a session running in the background: it runs where it was started.'
    if (run.state === 'working') return 'It is working. Restart it when it is idle.'
    run.restarting = true
    this.log(`claude: ${run.settled ?? run.id} is ended by a person to be resumed ${why === 'doors' ? 'with the doors of its kehikko now' : `in ${run.projectPath}`}`)
    kill(run.pty)
    return true
  }

  /**
   * What the program says is running, asked now. Not asked of a copy that
   * cannot answer, and that is said as what it is.
   */
  async running(file: string | null = this.program.find().file): Promise<Running> {
    if (!file) return { known: false, why: 'failed' }
    if (!(await this.program.supports(file)).lists) return { known: false, why: 'too-old' }
    return this.program.active(file).catch((): Running => ({ known: false, why: 'failed' }))
  }

  /**
   * Of what is running, the processes that hold this session and are not
   * this module's own: the background one if there is one — a view of it
   * starts nothing, so it is always the one to take — and otherwise a process
   * with a terminal of its own.
   */
  others(running: Running, session: string): { background: Active | null; open: Active | null } {
    if (!running.known) return { background: null, open: null }
    const mine = new Set([...this.runs.values()].map((run) => run.pty.pid))
    const there = running.active.filter((one) => one.session === session && !(one.pid !== null && mine.has(one.pid)))
    return { background: there.find((one) => one.kind === 'background' && one.handle) ?? null, open: there.find((one) => !(one.kind === 'background' && one.handle)) ?? null }
  }

  /**
   * Where the conversation recorded as `id` is now: `id` itself, or the
   * session Claude Code carried it on in (see `headOf`) — preferring one a
   * process is holding right now.
   */
  async head(projectPath: string, id: string, running?: Running): Promise<string> {
    const held = new Map((await this.program.sessions(projectPath, [id])).map((one) => [one.id, one]))
    const live = new Set<string>(running?.known ? running.active.map((one) => one.session) : [])
    for (const run of this.runs.values()) if (run.settled) live.add(run.settled)
    return headOf(id, held, live)
  }

  /**
   * Which conversation this run's process is showing now, and if it is no
   * longer the one recorded, make it the one recorded — as this place's
   * current session — and tell the viewers.
   *
   * It moves without this module doing anything: Claude Code resumes a
   * conversation under a new id, and a person may `/resume` another one or
   * `/clear` inside the terminal. Asked of the program itself
   * (`agents --json`, which lists each process with the session it holds, by
   * pid); a copy that cannot be asked is followed by its record instead —
   * the conversation carried on from the recorded one that nobody else holds.
   *
   * Never for a view of a background session: that process is not this
   * module's, and it is `attach`ed to by its handle.
   */
  async track(run: Run): Promise<void> {
    if (run.what !== 'session' || run.ended || run.joined || !run.settled) return
    run.trackedAt = this.now()
    const running = await this.running()
    let now: string | null = null
    if (running.known) {
      const mine = running.active.find((one) => one.pid !== null && one.pid === run.pty.pid)
      if (mine && this.program.isId(mine.session)) now = mine.session
    }
    if (!now) {
      const head = await this.head(run.projectPath, run.settled, running)
      const { background, open } = this.others(running, head)
      if (head !== run.settled && !background && !open) now = head
    }
    if (!now || now === run.settled || run.ended) return
    if (!(await this.program.settled(run.projectPath, now, 0))) return
    const was = run.settled
    const continued = (await this.head(run.projectPath, was, running)) === now
    run.settled = now
    this.log(`claude: the process behind ${run.id} is now on ${now} (${continued ? 'carried on from' : 'switched from'} ${was}) — recorded as its place's session`)
    const known = (await this.program.sessions(run.projectPath, [now])).find((one) => one.id === now)
    if (known?.label) run.label = known.label
    /* Carried on: the old id is the same conversation a step behind, and is replaced wherever it is. */
    if (continued) {
      const moved = follow(run.projectPath, was, now, { label: known?.label, lastActive: known?.lastActive })
      if (!moved.ok) this.log(`claude: ${moved.error}`)
    }
    if (run.at) {
      const written = attach(run.projectPath, run.at, now, { label: known?.label, lastActive: known?.lastActive })
      if (!written.ok) this.log(`claude: ${written.error}`)
    }
    for (const viewer of run.viewers) viewer.say({ exists: true, session: now, ...(run.label ? { label: run.label } : {}) })
    this.changed()
  }

  private async start(projectPath: string, id: string, asked: Extract<Opening, { what: 'session' }>): Promise<Run | Refusal> {
    const found = this.program.find()
    if (!found.file) return { code: CLOSED.missing, why: `${this.program.name} is not installed.` }

    let settled = await this.program.settled(projectPath, id, 0)
    if (asked.session && !settled) {
      return { code: CLOSED.refused, why: `${this.program.name} has no session by that id for this project on this computer.` }
    }
    /* And nothing about how many are running: see "There is no limit" at the top. */

    /* A session that exists may be running somewhere this module did not
       start it. Asked now, every time, and never remembered: see "A
       conversation that is already running somewhere else" at the top. */
    let joined: Active | null = null
    let copyOf: Active | null = null
    let unchecked: Run['unchecked'] = null
    if (settled) {
      const running = await this.running(found.file)
      if (!running.known) unchecked = running.why
      /* The conversation may have been carried on under another id since this one was recorded
         (Claude Code resumes under a new id). Opening the old id would start yet another copy of
         an old point in it, beside the process that has the conversation now. */
      const head = await this.head(projectPath, settled, running)
      if (head !== settled) {
        this.log(`claude: ${settled} was carried on as ${head} — opening that, and the record follows it`)
        const moved = follow(projectPath, settled, head)
        if (!moved.ok) this.log(`claude: ${moved.error}`)
        settled = head
      }
      const { background, open } = this.others(running, settled)
      if (background) joined = background
      else if (open && asked.copy) copyOf = open
      else if (open) {
        this.log(`claude: ${settled} is open in another ${this.program.name} process (${open.called || 'unknown kind'}, pid ${open.pid ?? '?'}) — nothing was started, and the page asks`)
        return { code: CLOSED.elsewhere, why: 'open in another process; nothing was started', elsewhere: elsewhereOf(open) }
      }
    }

    /* Asked to report only when this copy can take the asking and there is
       somewhere to report to. Otherwise the command is the two words it
       always was, and the session has no state. A view of a background
       session is never asked to report: its process was started elsewhere,
       and what it is doing is asked of the program instead (`watch`). */
    const port = this.port()
    const tells = !joined && port !== null && (await this.program.supports(found.file)).tells
    const secret = tells ? randomBytes(24).toString('hex') : null
    const name = (await this.program.supports(found.file)).names ? placeName(projectPath, asked.place) : ''
    /* The conversation's place, on every Kehikot door it is given (see `doorConfig.ts`). A copy
       that cannot take `--mcp-config` — or no host answering — starts exactly as before. */
    const projectId = asked.projectId ?? projectIdAt(projectPath)
    let token: string | null = null
    let doors: SessionDoor[] = []
    let config: string | null = null
    if (!joined && (await this.program.supports(found.file)).configures) {
      token = (settled ? tokenFor(projectPath, settled, freshToken) : null) ?? freshToken()
      const kehikko = asked.place.kehikko && 'key' in asked.place.kehikko ? asked.place.kehikko.key : null
      const got = await (this.options.doors ?? hostDoors)({ projectPath, projectId, token, kehikko }).catch(() => null)
      if (got?.length) {
        try {
          config = writeConfig(got, this.options.configBase)
          doors = got
        } catch (error) {
          this.log(`claude: the session's doors could not be written — ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        this.log('claude: no host gave this session its doors; it starts with the agent’s own configuration')
      }
    }
    const args = joined
      ? this.program.attach(joined.handle!)
      : [
          ...(settled ? this.program.resume(settled, name || undefined) : this.program.fresh(id, name || undefined)),
          ...(tells ? this.program.reports(tellLine) : []),
          /* Last: the flag takes every word after it until the next flag. */
          ...(config ? ['--mcp-config', config] : []),
        ]
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
          ...(secret ? { [TELL_ENV.port]: String(port), [TELL_ENV.secret]: secret, [TELL_ENV.session]: id } : {}),
        },
      })
    } catch (error) {
      removeConfig(config)
      const why = error instanceof Error ? error.message : String(error)
      this.log(`claude: could not start ${found.file} in ${projectPath} — ${why}`)
      return { code: CLOSED.failed, why: `${this.program.name} could not be started on this machine.` }
    }

    const run: Run = {
      what: 'session',
      id,
      settled,
      projectPath,
      cwd: projectPath,
      projectId,
      restarting: false,
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
      background: 0,
      joined,
      copyOf,
      unchecked,
      rested: false,
      trackedAt: this.now(),
      idle: null,
      startedAt: this.now(),
      pty,
      screen,
      viewers: new Set(),
      joining: new Map(),
      looking: new Set(),
      ended: false,
      token,
      doors,
      config,
    }
    this.runs.set(id, run)
    /* A view of it now says it: the row listed for it while nobody had one goes. */
    if (settled && this.unviewed.delete(settled)) this.changed()
    /* What the program said the background session is doing when it was asked, a moment ago; asked again on a clock from here (`watch`). */
    if (joined?.state) run.state = joined.state
    this.keepWatching()
    this.log(`claude: ${found.file} ${args.slice(0, 2).join(' ')}${tells ? ', asked to report' : ''} in ${projectPath} (pid ${pty.pid})`)
    if (joined) this.log(`claude: ${settled} is running in the background (pid ${joined.pid ?? '?'}) — attached to it, and no second process was started`)
    if (copyOf) this.log(`claude: ${settled} is open in another process (pid ${copyOf.pid ?? '?'}) and a person chose to open a copy here`)
    if (unchecked) {
      this.log(`claude: ${settled} was resumed without asking whether it is running elsewhere — ${unchecked === 'too-old' ? 'this copy has no `agents --json` or no `attach`' : 'the asking failed'}`)
      /* Said where the person is looking, before anything the program prints. */
      run.screen.write(uncheckedLine(this.program.name, unchecked))
    }
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
    this.changed()
    if (!run.settled) return
    /* Opened here: listed here, and the last opened here. It does not become this place's — that
       is a person's say ("Make this the kehikko's own") — unless it belonged nowhere, when a person
       picking it at this place is the say. */
    const read = readPlaces(run.projectPath)
    const homeless = read.ok && !homeOf(read.value, run.settled)
    const written = homeless
      ? assign(run.projectPath, place, run.settled, { label: run.label, lastActive: this.now() })
      : attach(run.projectPath, place, run.settled, { label: run.label, lastActive: this.now() })
    if (!written.ok) this.log(`claude: ${written.error}`)
  }

  private follow(run: Run): void {
    let asked = 0
    run.pty.onData((chunk) => {
      run.stirredAt = this.now()
      run.printedAt = run.stirredAt
      run.screen.write(chunk)
      for (const viewer of run.viewers) viewer.output(chunk)
      for (const since of run.joining.values()) since.push(chunk)
      /* A new session exists once the program has written its record, which
         is when the person first says something. Asked when the program
         speaks rather than on a clock, and not more often than this. */
      if (run.what === 'session' && (!run.settled || (!run.label && run.asked < LABEL_TRIES)) && this.now() - asked >= SETTLE_EVERY) {
        asked = this.now()
        void this.settle(run)
      } else if (run.what === 'session' && run.settled && this.now() - run.trackedAt >= TRACK_EVERY) {
        /* Which conversation is on screen is asked while the program speaks, and not more often than this. */
        void this.track(run).catch(() => {})
      }
    })
    run.pty.onExit(({ exitCode }) => {
      run.ended = true
      removeConfig(run.config)
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
    const known = (await this.program.sessions(run.projectPath, [run.settled])).find((one) => one.id === run.settled)
    const label = known?.label ?? ''
    if (run.place) {
      /* Started here: it belongs here from its first moment, with its token. */
      const written = born(run.projectPath, run.place, run.settled, run.token, { label, lastActive: known?.lastActive })
      if (!written.ok) this.log(`claude: ${written.error}`)
      run.place = null
    } else {
      note(run.projectPath, run.settled, { label, lastActive: known?.lastActive })
    }
    if (label && label !== run.label) {
      run.label = label
      for (const viewer of run.viewers) viewer.say({ label, session: run.settled })
      this.changed()
    }
  }

  private async finish(run: Run, exitCode: number): Promise<void> {
    let code: number = run.restarting ? CLOSED.moved : run.rested ? CLOSED.rested : CLOSED.ended
    let why = run.restarting ? 'restarting in the new folder' : run.rested ? 'put away while it was quiet' : `the session ended (${exitCode})`
    if (run.what === 'install') {
      const found = this.program.find()
      const done = exitCode === 0 && found.file !== null
      code = done ? CLOSED.installed : CLOSED.notInstalled
      why = done ? `installed at ${found.file}` : exitCode === 0 ? 'the installer finished and no binary was found' : `the installer exited with ${exitCode}`
      this.log(`claude: the installer exited with ${exitCode}; ${found.file ?? 'no binary found'}`)
    } else if (run.joined) {
      /* What ended is the view. Whether the session did is the program's to
         say, so it is asked rather than assumed either way. */
      const still = run.rested ? null : this.others(await this.running(), run.id).background
      if (!run.rested) why = still ? 'this view closed; the session is still running in the background' : `the background session ended (${exitCode})`
      this.log(`claude: the view of background session ${run.id} closed (${exitCode})${still ? '; the session runs on' : ''}`)
    } else {
      await this.settle(run).catch(() => {})
      this.log(`claude: session ${run.settled ?? run.id} ended (${exitCode})`)
    }
    for (const viewer of [...run.viewers, ...run.joining.keys()]) viewer.close(code, why)
    run.viewers.clear()
    run.joining.clear()
    run.looking.clear()
    run.screen.dispose()
  }

  /**
   * Put a viewer on a run: the screen as it stands, then everything after.
   *
   * The screen is asked for from inside the emulator's own write queue, so
   * what is sent is everything the pty said up to this moment. What the pty
   * says between this call and the screen being taken is not in it — it is
   * queued behind the marker — so it is kept for this viewer (`joining`) and
   * sent right behind the screen, and only then does the viewer follow along:
   * nothing twice and nothing missed. A viewer that leaves before its screen
   * is taken is sent nothing and is never added. Then the pty is
   * told this viewer's size, which is also what makes a full-screen program
   * redraw itself for the window it is now in.
   */
  attach(run: Run, viewer: Viewer, cols: number, rows: number, how: 'new' | 'resumed' | 'attached' | 'background' | 'copy' | 'install'): void {
    if (run.idle) clearTimeout(run.idle)
    run.idle = null
    viewer.say({
      opened: how,
      session: run.what === 'session' ? (run.settled ?? run.id) : null,
      label: run.label,
      exists: Boolean(run.settled),
      state: run.state,
      since: run.stateSince,
      /* What this run is, for as long as it is on screen: a view of a session
         running in the background, a copy beside another process, or one
         resumed without the program having been asked. */
      ...(run.joined ? { background: elsewhereOf(run.joined) } : {}),
      ...(run.copyOf ? { copyOf: elsewhereOf(run.copyOf) } : {}),
      ...(run.unchecked ? { unchecked: run.unchecked } : {}),
      /* The project's folder was renamed while it ran: the program still has the old one. */
      ...(run.what === 'session' && movedWord(run).moved ? movedWord(run) : {}),
    })
    /* On screen until the page says otherwise: a view connects when it is shown. */
    run.looking.add(viewer)
    /* The same viewer attaching again replaces its own wait rather than adding a second. */
    run.viewers.delete(viewer)
    const since: string[] = []
    run.joining.set(viewer, since)
    run.screen.write('', () => {
      if (run.joining.get(viewer) !== since) return
      run.joining.delete(viewer)
      if (run.ended) return
      const screen = run.screen.serialize()
      if (screen) viewer.output(screen)
      for (const chunk of since) viewer.output(chunk)
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
  heard(session: string, secret: string | null, event: string, background: number | null = null): boolean {
    const run = this.runs.get(session)
    if (!run || run.what !== 'session' || run.ended || !run.secret || !sameTicket(secret, run.secret)) return false
    const state = this.program.signal(event)
    /* The count of background tasks still running, which only a turn's end carries (`Stop`): a whole
       number the hook script counted, bounded here again. Any other report leaves it as it was. */
    if (event === 'Stop' && state) run.background = background !== null && Number.isSafeInteger(background) && background > 0 ? Math.min(background, 999) : 0
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
      partIds: [...(at?.parts ?? [])],
      kehikkoKey: at?.kehikko && 'key' in at.kehikko ? at.kehikko.key : null,
      at: this.now(),
    })
  }

  /** Say a session's state to its viewers and to every page following. */
  private tell(run: Run): void {
    const stated: Stated = { session: run.settled ?? run.id, state: run.state, since: run.stateSince }
    for (const viewer of run.viewers) viewer.say({ ...stated })
    for (const follower of this.followers) follower.state(stated)
    this.changed()
  }

  /** The activity list, whole, to every follower — but only when it differs from the last one. */
  /** The record changed under the lists (a person assigned a conversation): the activity lists are said again. */
  recorded(): void {
    this.changed()
  }

  private changed(): void {
    for (const follower of this.followers) {
      const rows = this.activity(follower.project ?? null)
      const text = JSON.stringify(rows)
      if (text === this.activityIs.get(follower)) continue
      this.activityIs.set(follower, text)
      follower.activity?.(rows)
    }
  }

  /** The activity list as it stands — one project's, or every project's (for a test, and for a page that has just arrived). */
  activity(project: string | null = null): ActivityRow[] {
    const rows = activityRows(this.runs.values(), project, this.unviewed.values())
    const asking: ActivityRow[] = []
    for (const root of project !== null ? [project] : this.projects) {
      const read = readPlaces(root)
      if (read.ok) {
        const row = unassignedRow(read.value, root, this.now())
        if (row) asking.push(row)
      }
    }
    return [...asking, ...rows].slice(0, ACTIVITY_ITEMS)
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
    const rows = this.activity(follower.project ?? null)
    this.activityIs.set(follower, JSON.stringify(rows))
    follower.activity?.(rows)
    for (const run of this.sessions()) {
      if (run.state) follower.state({ session: run.settled ?? run.id, state: run.state, since: run.stateSince })
    }
    for (const one of this.unviewed.values()) {
      if (one.state) follower.state({ session: one.session, state: one.state, since: one.since })
    }
    const hand = () => {
      if (!this.followers.has(follower)) return
      for (const notice of this.held.splice(0)) {
        const run = this.find(notice.session)
        if (run ? run.state === notice.state && run.looking.size === 0 : this.unviewed.get(notice.session)?.state === notice.state) follower.notice(notice)
      }
    }
    if (follower.notices && this.held.length) {
      if (this.heldWait > 0) setTimeout(hand, this.heldWait).unref?.()
      else hand()
    }
    /* The background sessions of the places were not asked about while nobody followed. */
    if (follower.project) this.know(follower.project)
    if (this.followers.size === 1) this.kick()
    else this.keepWatching()
    return () => {
      this.followers.delete(follower)
      this.activityIs.delete(follower)
    }
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
      /* Not a view of a background session: the program is asked what that one is doing (`watch`). */
      if (run.state === 'working' && !run.joined && this.now() - run.printedAt >= this.stale) {
        this.log(`claude: ${run.settled ?? run.id} was working and has printed nothing for ${Math.round((this.now() - run.printedAt) / 60_000)} min — its state is no longer known`)
        this.become(run, null)
      }
      if (run.looking.size > 0 || run.state === 'working' || run.state === 'needs-you') continue
      /* A turn that ended with background work still running (a server, a watcher, a build) is not a
         session that is done: putting it away would kill that work. It goes on being kept until the
         program says otherwise — its next turn ends with the count — or a person ends it. */
      if (run.background > 0) continue
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
    run.joining.delete(viewer)
    if (run.looking.delete(viewer) && run.looking.size === 0) this.left(run)
    if (run.what !== 'session' || run.ended || run.viewers.size + run.joining.size > 0 || run.touched || run.settled || run.idle) return
    run.idle = setTimeout(() => {
      run.idle = null
      if (run.ended || run.viewers.size + run.joining.size > 0 || run.touched) return
      /* Asked once more: the program may have recorded it since. */
      void this.settle(run)
        .catch(() => {})
        .then(() => {
          if (run.ended || run.viewers.size + run.joining.size > 0 || run.touched || run.settled) return
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
      cwd: '',
      projectId: null,
      restarting: false,
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
      background: 0,
      joined: null,
      copyOf: null,
      unchecked: null,
      rested: false,
      trackedAt: this.now(),
      idle: null,
      startedAt: this.now(),
      pty,
      screen,
      viewers: new Set(),
      joining: new Map(),
      looking: new Set(),
      ended: false,
      token: null,
      doors: [],
      config: null,
    }
    this.runs.set(INSTALL, run)
    this.log(`claude: installing, on a press in the page — ${line}`)
    run.screen.write(`$ ${line}\r\n`)
    this.follow(run)
    this.attach(run, viewer, asked.cols, asked.rows, 'install')
    return run
  }

  /**
   * End a session because a person chose to. False when nothing by that id is
   * running. For a view of a background session what ends is the view: the
   * pty holds `claude attach`, and hanging that up leaves the session running.
   */
  end(id: string): boolean {
    const run = this.find(id)
    if (!run) return false
    kill(run.pty)
    return true
  }

  /** End everything: this process is stopping, and nothing it started may outlive it. */
  endAll(): void {
    for (const run of this.runs.values()) {
      kill(run.pty)
      /* This process is going: the session's doors file goes now, not when the pty says it exited. */
      removeConfig(run.config)
    }
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
