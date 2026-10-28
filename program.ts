import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

import { personEnv } from 'kehikot-module-protocol/serve'

/**
 * The program this module opens, and everything that is specific to it.
 *
 * ## This is the only file that knows it is Claude Code
 *
 * The rest of the module is a terminal that holds one session per place: a
 * pty, a record of which session belongs where, a list to choose from. None
 * of it knows what the program is called. Everything that does is here, as
 * one value of one interface — `Program` — so a module for another agent
 * (Codex is the one that has been asked for) is this file written again plus
 * a manifest, and nothing else is forked.
 *
 * What a program has to answer, and it is the whole list:
 *
 *  1. **Where is the binary?** (`find`) The desktop app starts modules with a
 *     thin PATH, so PATH alone is not an answer.
 *  2. **Can this copy do what is asked of it?** (`supports`) Only if that is
 *     cheap to tell.
 *  3. **How is a new session started, and how is one resumed?** (`fresh`,
 *     `resume`) As argv, never as a shell line.
 *  4. **Does a session exist yet, and under which id?** (`settled`) A session
 *     that was started and never spoken to may have left nothing behind, and a
 *     program that does not take an id on its command line only reveals the
 *     one it chose afterwards.
 *  5. **Which sessions does it hold for a folder?** (`sessions`) With a label
 *     — the first thing the person said — and when each was last active.
 *  6. **How is it installed?** (`install`) The vendor's own command, as data.
 *  7. **Can it say what it is doing?** (`reports`, `signal`) Whether it is
 *     working, waiting for the person, or done with its turn — said by the
 *     program itself as it happens, never read off its screen. A program that
 *     cannot is still a program this module opens; its sessions simply have
 *     no state.
 *  8. **Is a session already running somewhere this module did not start
 *     it, and can that one be shown instead?** (`active`, `attach`) Resuming
 *     a conversation another process holds starts a second process on it, so
 *     the program is asked first, every time. One it runs in the background
 *     is opened by `attach` — a view of the process that is already there,
 *     not another one. A program that cannot be asked says so (`known:
 *     false`), which is not the same answer as "nothing is running".
 *
 * ## What is never here
 *
 * A prompt of anybody's but the person's: the person types. The one sentence
 * this module ever sends is its own, fixed, to a conversation a restart cut
 * off mid-turn, behind a setting the person can turn off (`RESUME_LINE` in
 * live.ts). And no flag
 * that widens what the program may do. `fresh` and `resume` name a session;
 * `reports` adds, for a copy that can take it, the one other thing on the
 * command line — the program's own hooks, pointed at this module, and its
 * status line (`statusLine`, which runs the person's own first) — and that
 * is the whole command. A session opened here has exactly the permissions
 * the same command would have in any terminal.
 *
 * ## Every command line this module ever runs, and it is the whole list
 *
 *     claude --help                                   once per binary: which flags and commands it has
 *     claude --session-id <uuid> [--name <place>] [--settings <json>] [--plugin-dir <plugin>] [--mcp-config <file>]  a new session
 *     claude --resume <uuid> [--name <place>] [--settings <json>] [--plugin-dir <plugin>] [--mcp-config <file>]      a session nothing else is running
 *     claude agents --json                            before every resume and every list: what is running. Reads; starts nothing
 *     claude attach <handle>                          a view of a session the program runs in the background
 *     claude --bg [--resume <uuid>] [<line>] [--name <place>] [--settings <json>] [--plugin-dir <plugin>] [--mcp-config <file>]
 *                                                     a conversation of a place's, started or resumed in the background
 *     claude stop <handle>                            a background session of this module's, ended by a person
 *     claude rm <handle>                              one this module started that nobody ever typed into
 *
 * `agents --json` and `attach` were added for the eighth question, deliberately.
 * Neither carries a prompt or a permission. `<uuid>` is an id this module minted or
 * the program holds a record for; `<handle>` is a word the program itself
 * printed in `agents --json` (or `--bg`) a moment before, checked to be one word that
 * cannot be read as a flag (`HANDLE`). Nothing a page sent is ever an
 * argument.
 *
 * ## The background, and why a conversation runs there (`--bg`)
 *
 * A conversation that was a child of this module's process died with it: an
 * update of the module, a restart of Kehikot, and every agent and background
 * shell in every conversation was cut off. So a conversation this module starts
 * or resumes runs as one of Claude Code's own BACKGROUND sessions (`--bg`), and
 * the terminal in the container is only `attach`ed to it. Detaching — the module
 * stopping, the app quitting, a page reloading — leaves it running, and the
 * next start attaches again. Measured on 2.1.306:
 *
 *  - `--bg` runs the session under Claude Code's own daemon (re-parented to
 *    launchd, its own process group), prints `backgrounded · <handle> · <name>`
 *    and returns. It ignores `--session-id` ("--bg manages the session id"), so
 *    the id is the program's choice, read back from `agents --json` by handle.
 *  - `--name`, `--plugin-dir` and `--mcp-config` reach the session, and are kept
 *    as its "saved options": the same files are read again when it is woken.
 *    `--resume <id>` with NO flags wakes a stopped one under the same id with
 *    those options; with flags, a background session's conversation is carried
 *    on as a copy under a new id (which `background` reports, and the record
 *    follows).
 *  - The environment of the caller does NOT reach the session (it is the
 *    daemon's), so a background session is never asked to report through
 *    `tell.sh`: what it is doing is asked of the program (`agents --json`).
 *    Its `--settings` hold its status line only (`statusLine`), which reports
 *    with the token in its plugin instead. Measured on 2.1.310: `--settings`
 *    is kept among the saved options ("woke session … with its saved options
 *    (--settings)"), and a background session runs its status line whether or
 *    not anybody is attached.
 *  - A folder not yet trusted is refused ("Workspace not trusted"); the
 *    conversation is then opened in the terminal as before, where the trust
 *    question is asked.
 *
 * `<line>` is one fixed sentence of this module's (`RESUME_LINE` in live.ts),
 * sent once to a conversation that a restart cut off mid-turn, behind a
 * setting the person can turn off. `stop` is only ever a person's "End" on a
 * conversation this module runs in the background; `rm` only one this module
 * started a moment ago that nobody typed a character into. Never `respawn`.
 */

export interface Found {
  /** The binary, absolute, or null when no candidate is an executable file. */
  file: string | null
  /** Every directory looked in, in the order it was looked in. */
  looked: string[]
  /** The ones among them that are not from PATH: the usual places an install lands. */
  usual: string[]
}

export interface Able {
  ok: boolean
  /** What this copy lacks, for the sentence on screen. Null when ok, or when nothing could be told. */
  missing: string | null
  /**
   * Whether this copy can be made to say what it is doing (`reports`). False
   * for one too old for it and for one whose help could not be read: the
   * session is opened exactly as it always was, and has no state.
   */
  tells: boolean
  /**
   * Whether this copy can be asked what is running (`active`) and can open a
   * background session (`attach`). False for one too old for either and for
   * one whose help could not be read: nothing is asked, a session is resumed
   * as it always was, and the person is told that it was not checked.
   */
  lists: boolean
  /** Whether this copy takes a display name for a session (`--name`). */
  names?: boolean
  /** Whether this copy takes MCP servers for one process (`--mcp-config`): how a session is given its place. */
  configures?: boolean
  /** Whether this copy loads a plugin for one process (`--plugin-dir`): how a session is given `/kehikot-here`. */
  plugins?: boolean
  /**
   * Whether this copy runs a session in the background and can stop one (`--bg`, `stop`, `rm`):
   * how a conversation outlives this module's process. Only with `lists`, since a background
   * session is opened by `attach`.
   */
  backgrounds?: boolean
}

/** A session started or woken in the background (`--bg`), or why not. */
export type Backgrounded =
  | {
      ok: true
      handle: string
      /** What `agents --json` says of it: its session id among the rest. */
      active: Active
    }
  | { ok: false; why: string }

/**
 * One session the program says is running now, in a process of its own.
 *
 * Read from `claude agents --json`, measured on 2.1.296 with one session open
 * in a terminal and one started with `--bg`:
 *
 *     { "pid": 82070, "cwd": "/…/project", "kind": "interactive", "startedAt": 1791893581186,
 *       "sessionId": "62bc0067-…", "name": "project-ea", "status": "idle" }
 *     { "pid": 82454, "id": "df6bd259", "cwd": "/…/project", "kind": "background", "startedAt": 1791893608110,
 *       "sessionId": "df6bd259-…", "name": "stand-in", "status": "idle", "state": "working" }
 *
 * Every folder's sessions are in the one list (it is not narrowed to the
 * directory it is asked from). A background entry may have no `pid`, `name`
 * or `status` (one that was just started). A stopped background session is
 * not in it at all — `--all` would add those, and is not passed.
 */
export interface Active {
  /** The session it holds, by the id its record is filed under. */
  session: string
  /** `background`: the program runs it with no terminal, and `attach` opens it. Anything else is a process with a terminal of its own. */
  kind: 'background' | 'interactive' | 'other'
  /** The word the program itself gave that kind. For the sentence a person reads. */
  called: string
  /**
   * What `attach` takes, for a background session: the `id` the program
   * printed — its short one. Measured: `attach` refuses the full session id
   * ("No job matching …"), and refuses the id of an interactive session the
   * same way. Null for anything that cannot be attached to.
   */
  handle: string | null
  pid: number | null
  cwd: string
  /** Milliseconds, or null when the program did not say. */
  startedAt: number | null
  name: string
  /**
   * What a background session is doing, as the program's `state` says it:
   * `working` is working, `blocked` is waiting for the person, `done` is a
   * turn that ended. Undocumented, so read by shape only: any other word, or
   * none (an interactive session has none), is null — nothing said.
   */
  state?: State | null
  /**
   * Where the session's process is, as the program's `status` says it — `idle` at its prompt,
   * `busy` on a turn, `waiting` on a question it put up, `shell` running a command the person
   * typed (the four words of Claude Code 2.1.310's session files). Unlike a background session's
   * `state`, which is the job's (a background session can be `working` at an `idle` prompt), this
   * is the process's own, and what Compact and Clear wait for. Null for any other word, or none.
   */
  status?: ActiveStatus | null
}

/** What a session's process is doing, by `agents --json`'s `status`. */
export type ActiveStatus = 'idle' | 'busy' | 'waiting' | 'shell'
const ACTIVE_STATUSES: readonly ActiveStatus[] = ['idle', 'busy', 'waiting', 'shell']

/** The program's word for a background session's state, as this module says it. */
const BACKGROUND_STATES: Record<string, State> = { working: 'working', blocked: 'needs-you', done: 'finished' }

/**
 * What the program said is running — or that it could not be asked, which is
 * a different answer from an empty list and must never be read as one.
 */
export type Running =
  | { known: true; active: Active[] }
  /** `too-old`: this copy has no `agents --json` or no `attach`. `failed`: it has, and the asking did not work. */
  | { known: false; why: 'too-old' | 'failed' }

/**
 * What a session is doing, as far as its program says.
 *
 *  - `working`: a turn is under way.
 *  - `needs-you`: the program has stopped to ask the person something and
 *    will not go on until it is answered.
 *  - `finished`: the turn is over and the program is at its prompt.
 */
export type State = 'working' | 'needs-you' | 'finished'
export const STATES: readonly State[] = ['working', 'needs-you', 'finished']

/** One session as the program's own records describe it. */
export interface Recorded {
  id: string
  /**
   * What the session is called: the name it was given (`--name`, `/rename`),
   * else the title Claude Code wrote for it, else the first thing the person
   * said. One line, cut short; `''` when nothing readable was found.
   */
  label: string
  /** The first thing the person said, one line, cut short. */
  firstPrompt?: string
  /** The last thing the person said, as Claude Code itself noted it. */
  lastPrompt?: string
  /** The pull requests the session opened or pushed to, newest last. */
  prs?: { number: number; url: string }[]
  /**
   * The sessions this conversation was carried on in, oldest first. Claude
   * Code resumes a conversation under a NEW id and writes `continued-in`
   * into the old record; the old id is then a step behind the conversation.
   */
  next?: string[]
  /** When the record last grew, in milliseconds. */
  lastActive: number
}

/** How the program is installed: the vendor's command, as data a page can show before it is run. */
export interface Install {
  /** Exactly what is run, as a person would type it. Shown before it runs. */
  line: string
  /** Where the installer puts the binary, for the sentence afterwards. */
  lands: string
  /** The page this command was read from, and the day it was read. */
  source: string
  checked: string
}

export interface Program {
  /** What a person calls it. */
  name: string
  /** The file it is looked for under. */
  binary: string
  find(env?: NodeJS.ProcessEnv): Found
  supports(file: string): Promise<Able>
  /** An id for a session that does not exist yet. */
  newId(): string
  /** Whether a string is spelled like one of this program's session ids. What arrives over the wire is checked with it. */
  isId(id: string): boolean
  /** The arguments that start a new session known by `id`, called `name` where the copy can take one. */
  fresh(id: string, name?: string): string[]
  /** The arguments that reopen the session `id`, called `name` where the copy can take one. */
  resume(id: string, name?: string): string[]
  /**
   * The id a started session is recorded under, or null while the program has
   * recorded nothing for it. `id` is what `fresh` was given and `since` when
   * it was started; a program that takes its id from the command line answers
   * `id` or null.
   */
  settled(projectPath: string, id: string, since: number): Promise<string | null>
  /**
   * Every session the program holds for this folder, most recently active
   * first — and, of `also`, the ones it holds anywhere else (a project whose
   * folder was renamed has its earlier sessions under the old name), with
   * the sessions they were carried on in.
   */
  sessions(projectPath: string, also?: readonly string[]): Promise<Recorded[]>
  install(env?: NodeJS.ProcessEnv): Install
  /** The environment a session is started in. */
  environment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  /**
   * The arguments that make the program say what it is doing: for each event
   * worth hearing, `command(event)` is the line it is to run when that
   * happens. Only ever given to a copy whose `supports()` said `tells`.
   */
  reports(command: (event: string) => string, more?: Record<string, unknown>): string[]
  /**
   * The settings that make a session started here run `script` as its status line, with the
   * person's own status line command (`own`) for it to run first and print unchanged — or null
   * when they have none, or one that cannot be run that way, and the session is then started
   * without (its context is read from its transcript).
   * Only for a copy whose `supports()` said `tells` (`--settings`).
   */
  statusLine?(projectPath: string, script: string, env?: NodeJS.ProcessEnv): { settings: Record<string, unknown>; own: string | null } | null
  /** `--settings` and its JSON, for settings and nothing else: what a background session is given (it reports through no hook). */
  settingsArgs?(settings: Record<string, unknown>): string[]
  /** What an event the program reported says about the session, or null for one that says nothing. */
  signal(event: string): State | null
  /**
   * Every session the program is running now, in any folder, in any process
   * — this module's own among them. Asked afresh every time: a session can
   * start or stop between two opens, so nothing here remembers an answer.
   * Only ever asked of a copy whose `supports()` said `lists`.
   */
  active(file: string, env?: NodeJS.ProcessEnv): Promise<Running>
  /** The arguments that open a view of a background session, by the handle `active` gave for it. */
  attach(handle: string): string[]
  /**
   * The arguments, after `--bg`, that start a conversation in the background (`resume` null) or wake
   * one. `saved`: it is a background session this module started, whose saved options are already
   * its own, so no other flag may be given (a flag would carry it on as a copy). `line` is a sentence
   * of this module's own to send it, or nothing.
   */
  backgroundArgs?(resume: string | null, name: string | undefined, saved: boolean, line?: string): string[]
  /** Start or wake a session in the background, in `cwd`: `claude --bg <args>`. Only for a copy whose `supports()` said `backgrounds`. */
  background?(file: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<Backgrounded>
  /** Stop a background session by its handle; its conversation is kept. False when the program did not say it did. */
  stop?(file: string, handle: string, env?: NodeJS.ProcessEnv): Promise<boolean>
  /** Remove a background session by its handle, conversation and all. Only ever one this module started that nobody typed into. */
  remove?(file: string, handle: string, env?: NodeJS.ProcessEnv): Promise<boolean>
}

/* ------------------------------------------------------------------------ *
 * Claude Code
 * ------------------------------------------------------------------------ */

const BINARY = 'claude'

/**
 * Where Claude Code keeps what it knows: `~/.claude`, or wherever
 * `CLAUDE_CONFIG_DIR` says — the variable the program itself honours, which
 * is also how a test points this at a scratch folder. Read, never written.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(home(env), '.claude')
}

/** The home folder as the environment names it, which is what the program itself and its installer go by. */
export function home(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || homedir()
}

/**
 * The places an install usually lands that a thin PATH leaves out.
 *
 * `~/.local/bin` first: it is where the vendor's own installer puts the
 * launcher (see `INSTALL` below), so it is the one that must be here for
 * "install, then carry on" to work under the desktop app.
 */
function usualDirs(env: NodeJS.ProcessEnv): string[] {
  const at = home(env)
  return [
    join(at, '.local', 'bin'),
    join(at, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(at, '.npm-global', 'bin'),
    join(at, '.bun', 'bin'),
  ]
}

function runnable(file: string): boolean {
  try {
    /* `statSync` follows a link, so a launcher that is a symlink to a version
       that has been deleted is not a binary. */
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function find(env: NodeJS.ProcessEnv = process.env): Found {
  const looked: string[] = []
  const usual = usualDirs(env)
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), ...usual]
  for (const dir of dirs) {
    if (looked.includes(dir)) continue
    looked.push(dir)
    const file = join(dir, BINARY)
    if (runnable(file)) return { file, looked, usual }
  }
  return { file: null, looked, usual }
}

/**
 * The two flags this module cannot work without. Checked against the
 * installed 2.1.296 with `claude --help`, not written from memory:
 *
 *     --session-id <uuid>   Use a specific session ID for the conversation (must be a valid UUID)
 *     -r, --resume [value]  Resume a conversation by session ID, or open interactive picker …
 */
const NEEDS = ['--session-id', '--resume']

/**
 * The flag state is told through. Not needed: a copy without it is opened as
 * before and has no state. From the same help text:
 *
 *     --settings <file-or-json>  Path to a settings JSON file or a JSON string to load additional settings from
 */
const TELLS = '--settings'

/**
 * The two commands the eighth question is asked with. Not needed either: a
 * copy without them resumes a session as before, and says it did not check.
 * From the same help text, under "Commands:" —
 *
 *     agents [options]   Manage background agents
 *     attach <id|name>   Open a background session in this terminal. <id> is the short id that
 *                        `claude --bg` prints and `claude agents` lists. …
 *
 * and from `claude agents --help`:
 *
 *     --json   Print active sessions (interactive and background) as a JSON array and exit
 *              (for scripting; does not require a TTY)
 *
 * Looked for as COMMANDS — a word at the start of a help line — because
 * `--agents <json-or-file>` is an older, unrelated option whose name contains
 * the first one.
 */
const LISTS = [/^\s*agents\b/m, /^\s*attach\b/m]

/**
 * The flag a session is named with, so that Claude Code's own lists (its
 * agents view, `/resume`, Remote Control) call it after its place. From the
 * help of 2.1.303:
 *
 *     -n, --name <name>   Set a display name for this session
 */
const NAMES = '--name <'

/**
 * The flag a session is given its Kehikot doors with, each carrying the
 * session's place token. From the help of 2.1.304:
 *
 *     --mcp-config <configs...>   Load MCP servers from JSON files or strings (space-separated)
 *
 * Measured on 2.1.304 with a scratch config: a server in the file under a
 * name the person's own config also has REPLACES theirs for this process, and
 * their other servers are kept (no `--strict-mcp-config`).
 */
const CONFIGURES = '--mcp-config <'

/**
 * The flag a session is given this module's skills with, for that one process (see skills.ts).
 * From the help of 2.1.304:
 *
 *     --plugin-dir <path>   Load a plugin from a directory or .zip for this session only
 *
 * Measured on 2.1.304 with a scratch config: the plugin's skill is listed as
 * `kehikot:kehikot-here`, typing `/kehikot-here` runs it, and nothing is written for it.
 */
const PLUGINS = '--plugin-dir <'

/**
 * What a copy that runs sessions in the background has: the flag, and the commands that stop and
 * remove one. From the help of 2.1.306:
 *
 *     --bg, --background   Start the session in the background and return immediately. Prints the id that
 *                          `claude attach`, `logs`, `stop` and `rm` take; …
 *     rm <id>              Delete a background session, …
 *     stop|kill <id>       Stop a background session. Its conversation is kept: …
 */
const BACKGROUNDS = [/--bg\b/, /^\s*stop\b/m, /^\s*rm\b/m]

const able = new Map<string, Able>()

/**
 * What the program prints for a command that only answers — `--help`,
 * `agents --json` — read through a real pipe.
 *
 * Measured on 2.1.296: read directly by this process, `claude --help` arrives
 * as its first 8190 bytes of 22116. Node hands a child a socket for its
 * standard output, the program exits without waiting for one to drain, and
 * the rest is lost — silently, and with exit code 0. The "Commands:" section
 * is at the end of the help, and a list of thirty running sessions is longer
 * than that too, so both answers this module depends on would be cut short
 * and read as "has no such command" and "not a list".
 *
 * So the program writes into a pipe the shell made, and `cat` passes it on:
 * all 22116 bytes arrive. The line given to `sh` is a constant; the binary
 * and its arguments are positional parameters and are never part of it.
 * Nothing is typed into the program (its standard input is closed), and what
 * comes back is `''` for anything that went wrong.
 */
function answered(file: string, args: readonly string[], env?: NodeJS.ProcessEnv, more: { cwd?: string; timeout?: number; errors?: boolean } = {}): Promise<string> {
  /* `errors`: what the program says on its standard error is part of the answer (`--bg` refusing). */
  const line = more.errors ? '"$0" "$@" </dev/null 2>&1 | /bin/cat' : '"$0" "$@" </dev/null | /bin/cat'
  return new Promise((done) => {
    const child = execFile('/bin/sh', ['-c', line, file, ...args], { timeout: more.timeout ?? 8000, maxBuffer: 16 * 1024 * 1024, ...(env ? { env } : {}), ...(more.cwd ? { cwd: more.cwd } : {}) }, (error, stdout) =>
      done(error && !more.errors ? '' : String(stdout ?? '')),
    )
    child.on('error', () => done(''))
  })
}

/**
 * Whether this copy has the flags above, asked once per binary per build.
 *
 * `--help` starts no session and reads no project. It is asked rather than a
 * version compared because the flag is the dependency: a version number is a
 * guess about which release grew it. A copy whose help cannot be read at all
 * is NOT called too old — nothing was learned, and "update" would be advice
 * about a thing nobody looked at.
 */
async function supports(file: string): Promise<Able> {
  let stamp = file
  try {
    stamp = `${file}@${statSync(file).mtimeMs}`
  } catch {
    /* Gone between being found and being asked. Unknown, like any other failure below. */
  }
  const known = able.get(stamp)
  if (known) return known
  const stdout = await answered(file, ['--help'])
  /* Nothing was learned, so nothing extra is passed either: a flag this copy
     turned out not to have would stop it from starting at all. */
  const said: Able = !stdout
    ? { ok: true, missing: null, tells: false, lists: false, names: false, configures: false, plugins: false, backgrounds: false }
    : (() => {
        const missing = NEEDS.find((flag) => !stdout.includes(flag)) ?? null
        const lists = LISTS.every((command) => command.test(stdout))
        return { ok: missing === null, missing, tells: stdout.includes(TELLS), lists, names: stdout.includes(NAMES), configures: stdout.includes(CONFIGURES), plugins: stdout.includes(PLUGINS), backgrounds: lists && BACKGROUNDS.every((one) => one.test(stdout)) }
      })()
  able.set(stamp, said)
  return said
}

/**
 * The folder Claude Code keeps one project's sessions in.
 *
 * `<config>/projects/<the folder's path with everything but letters and
 * digits turned into dashes>/<session id>.jsonl`. The naming is Claude Code's
 * business and not a contract, so both spellings of the folder are tried —
 * as the host said it, and resolved, since the program names the folder
 * after the directory it finds itself in and `/tmp` is `/private/tmp` there.
 */
export function recordDirs(projectPath: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const spellings = [projectPath]
  try {
    const real = realpathSync(projectPath)
    if (real !== projectPath) spellings.push(real)
  } catch {
    /* Not there. The spelling given is the only one there is. */
  }
  return spellings.map((one) => join(configDir(env), 'projects', one.replace(/[^a-zA-Z0-9]/g, '-')))
}

/** Enough of the head of a record to hold the first prompt, whatever is written above it. */
const HEAD_BYTES = 256 * 1024
/** How much of a first prompt is a label. */
export const LABEL_CHARS = 80

/**
 * The first line of the first thing a person said, out of the head of a record.
 *
 * This is the ONLY content of a transcript this module ever reads, and it is
 * read to tell one session from another in a list. Rows that are not a
 * person's words are stepped over: sidechains, meta rows, and the wrapped
 * rows a slash command leaves (`<command-name>…`, `<local-command-stdout>…`).
 */
export function firstPrompt(head: string): string {
  for (const line of head.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let row: { type?: string; isSidechain?: boolean; isMeta?: boolean; message?: { content?: unknown } }
    try {
      row = JSON.parse(trimmed)
    } catch {
      /* The slice ended mid-line. */
      continue
    }
    if (row.type !== 'user' || row.isSidechain || row.isMeta) continue
    const content = row.message?.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((block: unknown) =>
                typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'
                  ? String((block as { text?: unknown }).text ?? '')
                  : '',
              )
              .find((one) => one.trim() && !one.trimStart().startsWith('<')) ?? ''
          : ''
    const first = text.split('\n').map((one) => one.trim()).find(Boolean) ?? ''
    if (!first || first.startsWith('<')) continue
    return first.length > LABEL_CHARS ? `${first.slice(0, LABEL_CHARS - 1).trimEnd()}…` : first
  }
  return ''
}

/** How much of the end of a record is read for what Claude Code keeps appending: titles, the last prompt, PRs, continuations. */
const TAIL_BYTES = 1024 * 1024
/** How much of a title or a last prompt is kept. */
const TITLE_CHARS = 120

/** One line, cut short. */
const line = (text: unknown, most: number): string => {
  const first = typeof text === 'string' ? (text.split('\n').map((one) => one.trim()).find(Boolean) ?? '') : ''
  return first.length > most ? `${first.slice(0, most - 1).trimEnd()}…` : first
}

export interface Tail {
  /** The name given with `--name` or `/rename`, the latest. */
  name: string
  /** The title Claude Code wrote, the latest. */
  title: string
  lastPrompt: string
  prs: { number: number; url: string }[]
  next: string[]
}

/**
 * What Claude Code appends to a record as the conversation goes on, read out
 * of the end of one. Each of these rows is written again and again, so the
 * last of each kind is the one that holds. Only these kinds are parsed, and
 * nothing of the conversation itself is read:
 *
 *     { "type": "agent-name",   "agentName": "…" }
 *     { "type": "custom-title", "customTitle": "…" }
 *     { "type": "ai-title",     "aiTitle": "…" }
 *     { "type": "last-prompt",  "lastPrompt": "…" }
 *     { "type": "pr-link",      "prNumber": "3411", "prUrl": "https://github.com/…/pull/3411" }
 *     { "type": "continued-in", "continuedInSessionId": "<uuid>" }
 *
 * Measured on 2.1.303: a resumed conversation is carried on under a new id,
 * and the old record gets `continued-in` naming it — once per resume, so a
 * conversation resumed three times from its old id has three.
 */
export function tailOf(text: string): Tail {
  const out: Tail = { name: '', title: '', lastPrompt: '', prs: [], next: [] }
  let custom = ''
  for (const raw of text.split('\n')) {
    if (!raw.includes('"type":"') || !/"type":"(agent-name|custom-title|ai-title|last-prompt|pr-link|continued-in)"/.test(raw)) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(raw.trim())
    } catch {
      /* The slice began mid-line. */
      continue
    }
    if (row.type === 'agent-name' && line(row.agentName, TITLE_CHARS)) out.name = line(row.agentName, TITLE_CHARS)
    else if (row.type === 'custom-title' && line(row.customTitle, TITLE_CHARS)) custom = line(row.customTitle, TITLE_CHARS)
    else if (row.type === 'ai-title' && line(row.aiTitle, TITLE_CHARS)) out.title = line(row.aiTitle, TITLE_CHARS)
    else if (row.type === 'last-prompt' && line(row.lastPrompt, TITLE_CHARS)) out.lastPrompt = line(row.lastPrompt, TITLE_CHARS)
    else if (row.type === 'pr-link') {
      const number = Number(row.prNumber)
      const url = typeof row.prUrl === 'string' && /^https:\/\/[^\s"]+$/.test(row.prUrl) ? row.prUrl.slice(0, 300) : ''
      if (Number.isSafeInteger(number) && number > 0 && url) out.prs = [...out.prs.filter((one) => one.url !== url), { number, url }]
    } else if (row.type === 'continued-in' && typeof row.continuedInSessionId === 'string' && SESSION_ID.test(row.continuedInSessionId)) {
      out.next = [...out.next.filter((one) => one !== row.continuedInSessionId), row.continuedInSessionId]
    }
  }
  out.name ||= custom
  out.prs = out.prs.slice(-5)
  return out
}

/** What one record says, read once per version of it (its size and when it last changed). */
const read = new Map<string, { stamp: string; first: string; tail: Tail }>()

async function described(file: string, size: number, mtimeMs: number): Promise<{ first: string; tail: Tail }> {
  const stamp = `${size}@${mtimeMs}`
  const known = read.get(file)
  if (known?.stamp === stamp) return known
  let head = ''
  let end = ''
  try {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(HEAD_BYTES, size))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      head = buffer.subarray(0, bytesRead).toString('utf8')
      const from = Math.max(0, size - TAIL_BYTES)
      const tail = Buffer.alloc(size - from)
      const got = await handle.read(tail, 0, tail.length, from)
      end = tail.subarray(0, got.bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return { first: '', tail: tailOf('') }
  }
  /* The first prompt never changes once written, so one found is kept across versions. */
  const first = known?.first || firstPrompt(head)
  const said = { stamp, first, tail: tailOf(end) }
  read.set(file, said)
  return said
}

/** A session id as Claude Code spells one: a UUID, which is also what `--session-id` insists on. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

/** One session's record, described, or null when it went away between being found and being read. */
async function recorded(id: string, file: string): Promise<Recorded | null> {
  try {
    const { mtimeMs, size } = await stat(file)
    const { first, tail } = await described(file, size, mtimeMs)
    return {
      id,
      label: tail.name || tail.title || first,
      firstPrompt: first,
      lastPrompt: tail.lastPrompt,
      prs: tail.prs,
      next: tail.next.filter((one) => one !== id),
      lastActive: mtimeMs,
    }
  } catch {
    return null
  }
}

async function sessions(projectPath: string, also: readonly string[] = []): Promise<Recorded[]> {
  const found = new Map<string, Recorded>()
  for (const dir of recordDirs(projectPath)) {
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    await Promise.all(
      names.map(async (name) => {
        const id = SESSION_FILE.exec(name)?.[1]
        if (!id || found.has(id)) return
        const said = await recorded(id, join(dir, name))
        if (said) found.set(id, said)
      }),
    )
  }
  /* The ids the project's own record names that are not in its folder: a
     project whose folder was renamed or moved has its sessions under the
     folder Claude Code named after the old path. Found by id alone, with
     what they were carried on in (`next`), and nothing else of that folder. */
  const queue = also.filter((id) => SESSION_ID.test(id) && !found.has(id))
  const asked = new Set<string>(queue)
  while (queue.length && asked.size <= ELSEWHERE_MOST) {
    const id = queue.shift()!
    const file = await recordFile(projectPath, id)
    if (!file) continue
    const said = await recorded(id, file)
    if (!said) continue
    found.set(id, said)
    for (const next of said.next ?? []) {
      if (found.has(next) || asked.has(next)) continue
      asked.add(next)
      queue.push(next)
    }
  }
  return [...found.values()].sort((a, b) => b.lastActive - a.lastActive)
}

/** How many ids one listing looks for outside the project's own folder. */
const ELSEWHERE_MOST = 256

/**
 * Where Claude Code keeps the record of session `id` for this project:
 * in the project's own folder (`recordDirs`), and failing that in whichever
 * other folder under `<config>/projects/` holds `<id>.jsonl`.
 *
 * ## A project whose folder was renamed
 *
 * Claude Code names a project's folder after the project's path, so renaming
 * the project leaves every earlier session under the old name, and the
 * project's own folder (the new name) has none of them. The session ids are
 * still the project's — its `.kehikot/claude/places.json` came along with it —
 * so a session is looked for by its id, in every project folder, by FILE
 * NAME only: one listing of `<config>/projects/` and one `stat` per folder,
 * and no transcript is opened to look. A session id is a random UUID, so the
 * file it names is that session's wherever it is.
 *
 * `claude --resume <id>` finds such a record from the new folder too
 * (checked against Claude Code 2.1.303 with a scratch `CLAUDE_CONFIG_DIR`):
 * it loads the conversation and goes on writing it in the old folder, which
 * is why the lookup keeps finding it there.
 *
 * Kept: where an id was found (until that file is gone), and for a short
 * while that it was not found anywhere, so a list with a dozen missing ids
 * does not sweep the folder a dozen times a second.
 */
export async function recordFile(projectPath: string, id: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!SESSION_ID.test(id)) return null
  for (const dir of recordDirs(projectPath, env)) {
    const file = join(dir, `${id}.jsonl`)
    if (await isFile(file)) return file
  }
  return elsewhere(id, env)
}

/** How long "no record of that id anywhere" is believed before the folders are looked through again. */
const NOWHERE_MS = 10_000
const whereFound = new Map<string, string>()
const nowhere = new Map<string, number>()

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

async function elsewhere(id: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const root = join(configDir(env), 'projects')
  const key = `${root}\0${id}`
  const known = whereFound.get(key)
  if (known && (await isFile(known))) return known
  whereFound.delete(key)
  const missed = nowhere.get(key)
  if (missed !== undefined && Date.now() - missed < NOWHERE_MS) return null
  let folders: string[] = []
  try {
    folders = await readdir(root)
  } catch {
    folders = []
  }
  for (const folder of folders) {
    const file = join(root, folder, `${id}.jsonl`)
    if (await isFile(file)) {
      whereFound.set(key, file)
      nowhere.delete(key)
      return file
    }
  }
  nowhere.set(key, Date.now())
  return null
}

/**
 * Where a conversation is now, from an id it was once under.
 *
 * Every session `id` was carried on in, and theirs, is a candidate (`next`,
 * followed until it ends). Of those, one a process is holding right now
 * (`live`) is where the conversation is; otherwise the one that last grew.
 * An id that was never carried on anywhere is its own answer. Only sessions
 * this computer has a record of are followed to.
 */
export function headOf(id: string, held: ReadonlyMap<string, Recorded>, live: ReadonlySet<string> = new Set()): string {
  const seen = new Set<string>([id])
  const queue = [id]
  while (queue.length && seen.size < 256) {
    for (const next of held.get(queue.shift()!)?.next ?? []) {
      if (seen.has(next) || !held.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  if (seen.size === 1) return id
  const all = [...seen].filter((one) => held.has(one))
  const running = all.filter((one) => live.has(one))
  const among = running.length ? running : all
  return among.reduce((best, one) => ((held.get(one)?.lastActive ?? 0) > (held.get(best)?.lastActive ?? 0) ? one : best), among[0] ?? id)
}

/**
 * A place's name as Claude Code is given it: one line, no control characters,
 * never starting with a dash (it is the value after `--name`, and must not
 * read as a flag), and short.
 */
export function sessionName(words: readonly (string | null | undefined)[]): string {
  const said = words.map((one) => (one ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ')
  return said.replace(/^-+\s*/, '').slice(0, 120)
}

async function settled(projectPath: string, id: string): Promise<string | null> {
  return (await recordFile(projectPath, id)) ? id : null
}

/**
 * How Claude Code is installed, from the vendor's own page.
 *
 *   Source: https://code.claude.com/docs/en/setup — "Install Claude Code",
 *   tab "Native Install (Recommended)", "macOS, Linux, WSL". Read 2026-10-12.
 *
 * The same page says the native installer "manages the launcher at
 * `~/.local/bin/claude` as a symlink into `~/.local/share/claude/versions/`",
 * which is the first of `usualDirs()` above, and that native installs update
 * themselves — so the same command is what "Update" runs. Windows is another
 * command on that page (`irm https://claude.ai/install.ps1 | iex`); this
 * module opens a pty and has only been run on macOS.
 *
 * It is DATA. Nothing in this file runs it: `live.ts` does, in a pty the
 * person is looking at, and only after a press in the page.
 */
const INSTALL: Install = {
  line: 'curl -fsSL https://claude.ai/install.sh | bash',
  lands: '~/.local/bin/claude',
  source: 'https://code.claude.com/docs/en/setup',
  checked: '2026-10-12',
}

/**
 * The install command, or the stand-in a test names.
 *
 * `KEHIKOT_CLAUDE_INSTALL_LINE` is a seam for tests and for walking the flow
 * without touching a real install. It comes from the environment of whoever
 * started this server — the same place PATH comes from — and never from a
 * project or a request, and whatever it says is what the page shows before
 * anything runs.
 */
function install(env: NodeJS.ProcessEnv = process.env): Install {
  const line = env.KEHIKOT_CLAUDE_INSTALL_LINE
  return line ? { ...INSTALL, line } : INSTALL
}

/**
 * The variables a Claude Code session exports to what it starts. A module
 * started from inside one (somebody ran `./run.sh` in a Claude Code terminal)
 * would hand them on, and the session opened here would believe it was a
 * child of that one.
 */
const NESTED = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_AGENT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_JOB_DIR',
  'CLAUDE_EFFORT',
]

/**
 * A session's environment: the person's (`personEnv`, without the host's own `bun` this module was
 * started with first on its PATH and `BUN_BE_BUN`), without the variables that say it is nested.
 * A session given the host's `bun` without `BUN_BE_BUN` boots the host on every `bun` it calls.
 *
 * A background session's environment is the daemon's, not this one: the daemon started by a
 * `--bg` from here gets it, one already running keeps what it was started with.
 */
function environment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = personEnv(env)
  for (const name of NESTED) delete out[name]
  return out
}

/**
 * What Claude Code is asked to report, and what each report means.
 *
 * ## How it is asked
 *
 * Claude Code runs a command of the caller's choosing when certain things
 * happen — its hooks. They are normally written in a settings file; this
 * module writes in nobody's. `--settings <json>` hands the program ADDITIONAL
 * settings for this one process, as a string on its command line: nothing is
 * put in the person's `~/.claude`, nothing in the project, and no file exists
 * anywhere. Checked on 2.1.296 with a hook of the person's own on the same
 * event: both ran. It adds; it does not replace.
 *
 * ## Which events, measured on 2.1.296 against a stand-in for the model
 *
 *     the person sends a prompt           UserPromptSubmit
 *     a tool is about to run              PreToolUse          (before any question about it)
 *     a permission question is on screen  PermissionRequest   (at once; and for the question tool, which asks through the same dialog)
 *     … six seconds later                 Notification        permission_prompt
 *     the tool has run                    PostToolUse
 *     the turn is over                    Stop
 *     … sixty seconds later               Notification        idle_prompt
 *     the turn died on an API error       StopFailure         (instead of Stop, once its retries are spent: three minutes on a refused key)
 *
 * Read as: a prompt sent or a tool finished is `working`; a question on
 * screen is `needs-you`; `Stop` is `finished`. A turn that ended on an error
 * is `needs-you` as well — nothing is finished, and nothing further happens
 * until a person looks.
 *
 * ## What cannot be told, and it is said rather than guessed at
 *
 *  - **A question asked in prose.** "Shall I go on?" as the last line of a
 *    turn is a turn that ended: `Stop`, like any other. Only what the program
 *    itself puts up as a question — a permission dialog, the question tool,
 *    an MCP server's form — is `needs-you`.
 *  - **A question being answered.** Nothing is reported when a person says
 *    yes; the next report is the tool finishing, which may be a long while.
 *    `live.ts` covers that from its own side: a person typing into a session
 *    that was waiting for them has answered it.
 *  - **An interrupt.** Esc during a turn reports nothing at all — no `Stop`,
 *    and no idle notification after it. `live.ts` covers that too, from what
 *    was measured: a working session prints several times a second, focused
 *    or not, tool running or not, so one that has printed nothing for minutes
 *    is not working, and its state goes back to unknown.
 *
 * `Elicitation` and `ElicitationResult` — an MCP server's form going up and
 * being answered — are in this copy's list of events and were not seen
 * happen: nothing here could make a server ask.
 *
 * `PreToolUse` and both `Notification`s are left alone on purpose. The first
 * says nothing the others do not, and would run a process before every tool.
 * The second arrives seconds after the fact, so a late "needs you" could land
 * on a session that has already been answered and gone on.
 */
const SIGNALS: Record<string, State> = {
  UserPromptSubmit: 'working',
  PostToolUse: 'working',
  PostToolUseFailure: 'working',
  ElicitationResult: 'working',
  PermissionRequest: 'needs-you',
  Elicitation: 'needs-you',
  StopFailure: 'needs-you',
  Stop: 'finished',
}

/**
 * The subagent events, heard beside the state signals and saying nothing of the session's state:
 * a subagent started, and one finished (research.ts). `tell.sh` carries the agent's id and type
 * from them and nothing else. Measured on 2.1.312: `SubagentStart` gives `agent_id` and
 * `agent_type`; `SubagentStop` gives those, the subagent's transcript path and its last answer.
 */
export const SUBAGENT_EVENTS = ['SubagentStart', 'SubagentStop'] as const

function reports(command: (event: string) => string, more: Record<string, unknown> = {}): string[] {
  const hooks = Object.fromEntries(
    [...Object.keys(SIGNALS), ...SUBAGENT_EVENTS].map((event) => [event, [{ hooks: [{ type: 'command', command: command(event), timeout: 5 }] }]]),
  )
  return [TELLS, JSON.stringify({ ...more, hooks })]
}

/**
 * The person's own status line, as Claude Code would run it for a session in `projectPath`: the
 * first of the project's local settings, its shared settings and the person's own
 * (`<config>/settings.json`) that names one — the order Claude Code reads them in, highest first.
 * `--settings`, above all three, is where this module's goes. Read, never written. Policy
 * (managed) settings outrank `--settings` and are not read: a status line set there replaces this
 * module's too, and the meter then reads the transcript alone.
 *
 * `none` when none names one; `other` for one this module cannot run the way Claude Code would
 * (another `type`, an `args` list, a `shell` that is not bash), which is then left alone.
 */
export function ownStatusLine(projectPath: string, env: NodeJS.ProcessEnv = process.env): { line: Record<string, unknown>; command: string } | 'none' | 'other' {
  const files = [join(projectPath, '.claude', 'settings.local.json'), join(projectPath, '.claude', 'settings.json'), join(configDir(env), 'settings.json')]
  for (const file of files) {
    let said: unknown
    try {
      said = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!said || typeof said !== 'object' || Array.isArray(said) || !Object.hasOwn(said, 'statusLine')) continue
    const line = (said as { statusLine?: unknown }).statusLine
    if (line === null || line === undefined) return 'none'
    if (typeof line !== 'object' || Array.isArray(line)) return 'other'
    const one = line as Record<string, unknown>
    if (one.type !== 'command' || typeof one.command !== 'string' || !one.command.trim() || one.args !== undefined) return 'other'
    if (one.shell !== undefined && one.shell !== 'bash') return 'other'
    return { line: one, command: one.command }
  }
  return 'none'
}

/** A word for `/bin/sh`, in single quotes. */
const shellWord = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/**
 * The status line a session started here is given (`statusline.sh`, copied into its plugin):
 * the person's own settings for it kept — padding, refresh — with the command this module's,
 * which runs theirs first. Only when they have one: null when they have none, or one that cannot
 * be run that way.
 */
function statusLine(projectPath: string, script: string, env: NodeJS.ProcessEnv = process.env): { settings: Record<string, unknown>; own: string | null } | null {
  const own = ownStatusLine(projectPath, env)
  /* None of theirs: none is added. An empty status line still costs a row under Claude Code's
     prompt (measured on 2.1.310), a change to their terminal for nothing they asked for; the
     context is then read from the transcript alone. One that cannot be run as Claude Code would is left alone. */
  if (own === 'none' || own === 'other') return null
  const kept = Object.fromEntries(Object.entries(own.line).filter(([key]) => key !== 'command' && key !== 'shell' && key !== 'type'))
  return { settings: { statusLine: { ...kept, type: 'command', command: `/bin/sh ${shellWord(script)}` } }, own: own.command }
}

/**
 * A background session's handle, as `attach` is given it: one word of
 * letters, digits, dashes and underscores that does not start with a dash,
 * so that whatever the program printed it can never be read as a flag. (What
 * 2.1.296 prints is eight hex characters, the head of the session id.)
 */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** One entry of `agents --json`, or null for anything that is not one. Nothing in it is trusted beyond its shape. */
export function readActive(raw: unknown): Active | null {
  if (typeof raw !== 'object' || raw === null) return null
  const said = raw as { sessionId?: unknown; kind?: unknown; id?: unknown; pid?: unknown; cwd?: unknown; startedAt?: unknown; name?: unknown; state?: unknown; status?: unknown }
  if (typeof said.sessionId !== 'string' || !SESSION_ID.test(said.sessionId)) return null
  const called = typeof said.kind === 'string' ? said.kind.slice(0, 40) : ''
  const kind = called === 'background' ? 'background' : called === 'interactive' ? 'interactive' : 'other'
  return {
    session: said.sessionId,
    kind,
    called,
    handle: kind === 'background' && typeof said.id === 'string' && HANDLE.test(said.id) ? said.id : null,
    pid: typeof said.pid === 'number' && Number.isSafeInteger(said.pid) && said.pid > 1 ? said.pid : null,
    cwd: typeof said.cwd === 'string' ? said.cwd.slice(0, 400) : '',
    startedAt: typeof said.startedAt === 'number' && Number.isFinite(said.startedAt) && said.startedAt > 0 ? said.startedAt : null,
    name: typeof said.name === 'string' ? said.name.slice(0, 120) : '',
    state: typeof said.state === 'string' && Object.hasOwn(BACKGROUND_STATES, said.state) ? BACKGROUND_STATES[said.state]! : null,
    status: typeof said.status === 'string' && (ACTIVE_STATUSES as readonly string[]).includes(said.status) ? (said.status as ActiveStatus) : null,
  }
}

/**
 * What is running, asked of the program itself: `claude agents --json`.
 *
 * It needs no terminal, starts no session and reads no project; measured at
 * a tenth of a second. It is asked in the environment a session would be
 * started in, so that it is the same Claude Code — the same config folder —
 * whose sessions are listed.
 *
 * Anything but a JSON array is `failed`, never an empty list: a copy that
 * answered with an error, a timeout, or something else entirely has not said
 * that nothing is running.
 */
async function active(file: string, env: NodeJS.ProcessEnv = process.env): Promise<Running> {
  let parsed: unknown
  try {
    /* Through a real pipe, whole (see `answered`): a list cut short is not a list. */
    parsed = JSON.parse(await answered(file, ['agents', '--json'], environment(env)))
  } catch {
    return { known: false, why: 'failed' }
  }
  if (!Array.isArray(parsed)) return { known: false, why: 'failed' }
  return { known: true, active: parsed.map(readActive).filter((one): one is Active => one !== null) }
}

/** What `--bg` prints when the session is under way: `backgrounded · <handle> · <name>`. */
const BACKGROUNDED = /backgrounded\s*·\s*([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?![A-Za-z0-9_-])/

/** The first line of what the program said, short, for a log line and a sentence. */
const saidFirst = (text: string): string => line(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), 200)

/**
 * `claude --bg <args>` in `cwd`, and the session it started, as `agents --json` lists it a moment
 * later (the handle it printed is the short id; the session id is read from the list). Never throws.
 */
async function background(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<Backgrounded> {
  const said = await answered(file, ['--bg', ...args], environment(env), { cwd, timeout: 60_000, errors: true })
  const handle = BACKGROUNDED.exec(said)?.[1] ?? null
  if (!handle || !HANDLE.test(handle)) return { ok: false, why: saidFirst(said) || `${BINARY} --bg said nothing` }
  for (let tries = 0; tries < 10; tries += 1) {
    const running = await active(file, env)
    const found = running.known ? running.active.find((one) => one.kind === 'background' && one.handle === handle) : undefined
    if (found) return { ok: true, handle, active: found }
    await new Promise((done) => setTimeout(done, 300))
  }
  return { ok: false, why: `${handle} was started in the background and is not in \`agents --json\`` }
}

/** `claude stop|rm <handle>`: whether the program said it did. */
async function command(word: 'stop' | 'rm', file: string, handle: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!HANDLE.test(handle)) return false
  const said = await answered(file, [word, handle], environment(env), { timeout: 20_000, errors: true })
  return new RegExp(`\\b(stopped|removed)\\s+${handle}\\b`).test(said)
}

/** `--name` and the name, or nothing. Only a name `sessionName` would give is passed. */
const named = (name: string | undefined): string[] => {
  const clean = name ? sessionName([name]) : ''
  return clean ? ['--name', clean] : []
}

export const PROGRAM: Program = {
  name: 'Claude Code',
  binary: BINARY,
  find,
  supports,
  newId: () => randomUUID(),
  isId: (id) => SESSION_ID.test(id),
  /* A session id and nothing else. No prompt, and no flag about permissions:
     see "What is never here" at the top. `reports` is added by whoever starts it. */
  fresh: (id, name) => ['--session-id', id, ...named(name)],
  resume: (id, name) => ['--resume', id, ...named(name)],
  settled,
  sessions,
  install,
  environment,
  reports,
  statusLine,
  settingsArgs: (settings) => (Object.keys(settings).length ? [TELLS, JSON.stringify(settings)] : []),
  signal: (event) => (Object.hasOwn(SIGNALS, event) ? SIGNALS[event]! : null),
  active,
  /* The handle and nothing else, and only one `readActive` let through. No
     `--settings`: the process that holds the session was started elsewhere,
     and its hooks are not this module's to add. */
  attach: (handle) => {
    if (!HANDLE.test(handle)) throw new Error('that is not a background session’s handle')
    return ['attach', handle]
  },
  /* No `--session-id`: `--bg` chooses the id. A line of this module's own goes right after the id,
     before any flag: `--mcp-config` takes every word after it. */
  backgroundArgs: (resume, name, saved, said) => {
    if (resume !== null && !SESSION_ID.test(resume)) throw new Error('that is not a session id')
    const words = said && !said.startsWith('-') ? [said] : []
    if (resume === null) return [...words, ...named(name)]
    return saved ? ['--resume', resume, ...words] : ['--resume', resume, ...words, ...named(name)]
  },
  background,
  stop: (file, handle, env) => command('stop', file, handle, env),
  remove: (file, handle, env) => command('rm', file, handle, env),
}

