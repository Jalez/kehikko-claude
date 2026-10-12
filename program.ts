import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

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
 *
 * ## What is never here
 *
 * A prompt. Nothing in this module sends one: the person types. And no flag
 * that widens what the program may do. `fresh` and `resume` name a session;
 * `reports` adds, for a copy that can take it, the one other thing on the
 * command line — the program's own hooks, pointed at this module — and that
 * is the whole command. A session opened here has exactly the permissions
 * the same command would have in any terminal.
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
}

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
  /** The first thing the person said, one line, cut short. `''` when nothing readable was found. */
  label: string
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
  /** The arguments that start a new session known by `id`. */
  fresh(id: string): string[]
  /** The arguments that reopen the session `id`. */
  resume(id: string): string[]
  /**
   * The id a started session is recorded under, or null while the program has
   * recorded nothing for it. `id` is what `fresh` was given and `since` when
   * it was started; a program that takes its id from the command line answers
   * `id` or null.
   */
  settled(projectPath: string, id: string, since: number): Promise<string | null>
  /** Every session the program holds for this folder, most recently active first. */
  sessions(projectPath: string): Promise<Recorded[]>
  install(env?: NodeJS.ProcessEnv): Install
  /** The environment a session is started in. */
  environment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  /**
   * The arguments that make the program say what it is doing: for each event
   * worth hearing, `command(event)` is the line it is to run when that
   * happens. Only ever given to a copy whose `supports()` said `tells`.
   */
  reports(command: (event: string) => string): string[]
  /** What an event the program reported says about the session, or null for one that says nothing. */
  signal(event: string): State | null
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

const able = new Map<string, Able>()

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
  const said = await new Promise<Able>((done) => {
    execFile(file, ['--help'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      /* Nothing was learned, so nothing extra is passed either: a flag this copy
         turned out not to have would stop it from starting at all. */
      if (error || !stdout) return done({ ok: true, missing: null, tells: false })
      const missing = NEEDS.find((flag) => !stdout.includes(flag)) ?? null
      done({ ok: missing === null, missing, tells: stdout.includes(TELLS) })
    })
  })
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

/** A first prompt never changes once written, so it is read once per record. */
const labels = new Map<string, string>()

async function labelOf(file: string): Promise<string> {
  const known = labels.get(file)
  if (known) return known
  let head = ''
  try {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(HEAD_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
      head = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
  const label = firstPrompt(head)
  /* Only a found label is kept: a session nobody has spoken to yet will have one later. */
  if (label) labels.set(file, label)
  return label
}

/** A session id as Claude Code spells one: a UUID, which is also what `--session-id` insists on. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

async function sessions(projectPath: string): Promise<Recorded[]> {
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
        const file = join(dir, name)
        try {
          const { mtimeMs } = await stat(file)
          found.set(id, { id, label: await labelOf(file), lastActive: mtimeMs })
        } catch {
          /* It went away between the listing and the read. */
        }
      }),
    )
  }
  return [...found.values()].sort((a, b) => b.lastActive - a.lastActive)
}

async function settled(projectPath: string, id: string): Promise<string | null> {
  for (const dir of recordDirs(projectPath)) {
    try {
      if ((await stat(join(dir, `${id}.jsonl`))).isFile()) return id
    } catch {
      /* Not in this spelling of the folder. */
    }
  }
  return null
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

function environment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env }
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

function reports(command: (event: string) => string): string[] {
  const hooks = Object.fromEntries(
    Object.keys(SIGNALS).map((event) => [event, [{ hooks: [{ type: 'command', command: command(event), timeout: 5 }] }]]),
  )
  return [TELLS, JSON.stringify({ hooks })]
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
  fresh: (id) => ['--session-id', id],
  resume: (id) => ['--resume', id],
  settled,
  sessions,
  install,
  environment,
  reports,
  signal: (event) => (Object.hasOwn(SIGNALS, event) ? SIGNALS[event]! : null),
}

