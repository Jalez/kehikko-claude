import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { spawnSync } from 'node:child_process'

import { PROGRAM, configDir, firstPrompt, headOf, home, readActive, recordDirs, recordFile, sessionName, tailOf, type Recorded } from '../program.ts'
import { CONFIG, HOME } from './setup.ts'

/**
 * The adapter, against a stand-in `claude` and a scratch config folder.
 *
 * Nothing here runs the real program or reads a real record: `test/setup.ts`
 * has already pointed the home folder, `CLAUDE_CONFIG_DIR` and PATH at
 * scratch. What is pinned is what the rest of the module leans on — where the
 * binary is looked for, which arguments start and resume a session, and what
 * is read out of a record.
 */

const STAND_IN = join(import.meta.dir, 'stand-in', 'claude')
const made: string[] = []
const scratch = (name: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `kehikko-claude-${name}-`)))
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
  rmSync(join(HOME, '.local'), { recursive: true, force: true })
})

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

const row = (content: unknown, more: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content }, ...more })

describe('finding the binary', () => {
  test('the test’s machine is scratch: a home of its own and Claude Code’s config beside it', () => {
    expect(home()).toBe(HOME)
    expect(configDir()).toBe(CONFIG)
  })

  test('on PATH first', () => {
    const bin = scratch('bin')
    copyFileSync(STAND_IN, join(bin, 'claude'))
    chmodSync(join(bin, 'claude'), 0o755)
    const found = PROGRAM.find({ HOME, PATH: `/nowhere:${bin}` })
    expect(found.file).toBe(join(bin, 'claude'))
    expect(found.looked).toEqual(['/nowhere', bin])
    expect(found.usual[0]).toBe(join(HOME, '.local', 'bin'))
  })

  test('then the usual places a thin PATH leaves out — where the vendor’s installer puts it first', () => {
    const none = PROGRAM.find({ HOME, PATH: '/usr/bin:/bin' })
    expect(none.file).toBeNull()
    expect(none.looked.slice(0, 3)).toEqual(['/usr/bin', '/bin', join(HOME, '.local', 'bin')])
    expect(none.looked).toContain('/opt/homebrew/bin')

    mkdirSync(join(HOME, '.local', 'bin'), { recursive: true })
    copyFileSync(STAND_IN, join(HOME, '.local', 'bin', 'claude'))
    chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755)
    expect(PROGRAM.find({ HOME, PATH: '/usr/bin:/bin' }).file).toBe(join(HOME, '.local', 'bin', 'claude'))
    rmSync(join(HOME, '.local'), { recursive: true, force: true })
  })

  test('a file that cannot be run, and a folder of that name, are not the binary', () => {
    const bin = scratch('bin')
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o644 })
    expect(PROGRAM.find({ HOME, PATH: bin }).file).toBeNull()
    const other = scratch('bin')
    mkdirSync(join(other, 'claude'))
    expect(PROGRAM.find({ HOME, PATH: other }).file).toBeNull()
  })
})

describe('whether a copy can do what is asked of it', () => {
  test('one with both flags can', async () => {
    expect(await PROGRAM.supports(STAND_IN)).toEqual({ ok: true, missing: null, tells: true, lists: true, names: false, configures: true, plugins: true, backgrounds: false })
  })

  test('one whose help has no --session-id is too old, and the flag is named', async () => {
    const bin = scratch('old')
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nSTANDIN_OLD=1 exec "${STAND_IN}" "$@"\n`, { mode: 0o755 })
    expect(await PROGRAM.supports(join(bin, 'claude'))).toEqual({ ok: false, missing: '--session-id', tells: false, lists: false, names: false, configures: false, plugins: false, backgrounds: false })
  })

  test('one whose help cannot be read is not called too old: nothing was learned', async () => {
    const bin = scratch('broken')
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    expect((await PROGRAM.supports(join(bin, 'claude'))).ok).toBe(true)
  })
})

describe('starting and resuming', () => {
  test('a new session is given its id, a resumed one is named by it, and neither is given anything else', () => {
    expect(PROGRAM.fresh(A)).toEqual(['--session-id', A])
    expect(PROGRAM.resume(A)).toEqual(['--resume', A])
  })

  test('no flag that widens what the program may do, and no prompt', () => {
    for (const args of [PROGRAM.fresh(A), PROGRAM.resume(A)]) {
      expect(args.join(' ')).not.toMatch(/dangerously|skip-permissions|permission-mode|allowed-?tools|add-dir|bare|-p\b|--print/i)
      expect(args.length).toBe(2)
    }
  })

  test('an id it mints is one it accepts, and what is not an id is refused', () => {
    expect(PROGRAM.isId(PROGRAM.newId())).toBe(true)
    expect(PROGRAM.newId()).not.toBe(PROGRAM.newId())
    for (const not of ['', 'x', '../../etc', `${A}.jsonl`, `--resume ${A}`, 'AAAAAAAA-1111-4111-8111-111111111111']) expect(PROGRAM.isId(not)).toBe(false)
  })

  test('the session’s environment does not say it is inside another session', () => {
    const env = PROGRAM.environment({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CONFIG_DIR: '/kept', ANTHROPIC_API_KEY: 'kept' })
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/kept', ANTHROPIC_API_KEY: 'kept' })
  })
})

describe('reading a project’s sessions', () => {
  test('the label is the first line of the first thing a person said, and nothing else is read', () => {
    const head = [
      JSON.stringify({ type: 'mode', mode: 'x' }),
      JSON.stringify({ type: 'attachment', attachment: {} }),
      row('<command-name>/clear</command-name>'),
      row('side', { isSidechain: true }),
      row('meta', { isMeta: true }),
      row([{ type: 'tool_result', content: 'not prose' }]),
      row('  tighten the methods section\nand then the rest of a long prompt'),
      row('a later prompt'),
      '{"type":"user","message":{"content":"cut mid-li',
    ].join('\n')
    expect(firstPrompt(head)).toBe('tighten the methods section')
    expect(firstPrompt(row([{ type: 'text', text: 'said in blocks' }]))).toBe('said in blocks')
    expect(firstPrompt('')).toBe('')
    expect(firstPrompt(row('x'.repeat(200))).length).toBe(80)
    expect(firstPrompt(row('x'.repeat(200))).endsWith('…')).toBe(true)
  })

  test('a folder’s sessions, most recently active first, with their labels', async () => {
    const project = scratch('project')
    const [dir] = recordDirs(project)
    expect(dir).toBe(join(CONFIG, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-')))
    mkdirSync(dir!, { recursive: true })
    writeFileSync(join(dir!, `${A}.jsonl`), `${row('the older one')}\n`)
    writeFileSync(join(dir!, `${B}.jsonl`), `${row('the newer one')}\n`)
    writeFileSync(join(dir!, 'notes.txt'), 'not a session')
    writeFileSync(join(dir!, 'not-an-id.jsonl'), `${row('nor this')}\n`)
    utimesSync(join(dir!, `${A}.jsonl`), new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:00:00Z'))
    utimesSync(join(dir!, `${B}.jsonl`), new Date('2026-10-02T10:00:00Z'), new Date('2026-10-02T10:00:00Z'))

    const held = await PROGRAM.sessions(project)
    expect(held.map((one) => [one.id, one.label])).toEqual([
      [B, 'the newer one'],
      [A, 'the older one'],
    ])
    expect(held[1]?.lastActive).toBe(Date.parse('2026-10-01T10:00:00Z'))
  })

  test('a folder with no record has no sessions, and a neighbouring folder’s are not its own', async () => {
    const project = scratch('project')
    const neighbour = `${project}-notes`
    mkdirSync(recordDirs(neighbour)[0]!, { recursive: true })
    writeFileSync(join(recordDirs(neighbour)[0]!, `${A}.jsonl`), `${row('next door')}\n`)
    expect(await PROGRAM.sessions(project)).toEqual([])
  })

  test('a session exists once the program has a record for it, and not before', async () => {
    /* Ids of their own: a record is found by its id in any project's folder (a renamed project). */
    const S = 'b0000001-0000-4000-8000-00000000b001'
    const T = 'b0000001-0000-4000-8000-00000000b002'
    const project = scratch('project')
    expect(await PROGRAM.settled(project, S, 0)).toBeNull()
    const [dir] = recordDirs(project)
    mkdirSync(dir!, { recursive: true })
    writeFileSync(join(dir!, `${S}.jsonl`), `${row('hello')}\n`)
    expect(await PROGRAM.settled(project, S, 0)).toBe(S)
    expect(await PROGRAM.settled(project, T, 0)).toBeNull()
  })
})

describe('a project whose folder was renamed', () => {
  const C = 'c0000001-0000-4000-8000-00000000c001'
  const D = 'c0000001-0000-4000-8000-00000000c002'
  const E = 'c0000001-0000-4000-8000-00000000c003'
  /** The project as it was, with Claude Code's records under the old name, and as it is now. */
  const moved = () => {
    const parent = scratch('moved')
    const was = join(parent, 'thesis-old')
    const now = join(parent, 'thesis')
    const [old] = recordDirs(was)
    mkdirSync(old!, { recursive: true })
    return { was, now, old: old! }
  }

  test('a session is found by its id under the folder’s old name, and settles', async () => {
    const { now, old } = moved()
    writeFileSync(join(old, `${C}.jsonl`), `${row('from before the rename')}\n`)
    expect(await recordFile(now, C)).toBe(join(old, `${C}.jsonl`))
    expect(await PROGRAM.settled(now, C, 0)).toBe(C)
  })

  test('its own folder is looked in first', async () => {
    const { now, old } = moved()
    const [mine] = recordDirs(now)
    mkdirSync(mine!, { recursive: true })
    writeFileSync(join(old, `${D}.jsonl`), `${row('old copy')}\n`)
    writeFileSync(join(mine!, `${D}.jsonl`), `${row('here')}\n`)
    expect(await recordFile(now, D)).toBe(join(mine!, `${D}.jsonl`))
  })

  test('listed when the record names it, with what it was carried on in, and nothing else of the old folder', async () => {
    const { now, old } = moved()
    const id = 'c0000001-0000-4000-8000-00000000c004'
    const next = 'c0000001-0000-4000-8000-00000000c005'
    const other = 'c0000001-0000-4000-8000-00000000c006'
    writeFileSync(join(old, `${id}.jsonl`), `${row('named in the record')}\n${JSON.stringify({ type: 'continued-in', continuedInSessionId: next })}\n`)
    writeFileSync(join(old, `${next}.jsonl`), `${row('carried on')}\n`)
    writeFileSync(join(old, `${other}.jsonl`), `${row('not named')}\n`)
    expect(await PROGRAM.sessions(now)).toEqual([])
    const held = await PROGRAM.sessions(now, [id])
    expect(held.map((one) => one.id).sort()).toEqual([id, next].sort())
    expect(held.find((one) => one.id === id)?.label).toBe('named in the record')
    expect(held.some((one) => one.id === other)).toBe(false)
  })

  test('an id there is no record of anywhere is not found, and a bad id is not looked for', async () => {
    const { now } = moved()
    expect(await recordFile(now, E)).toBeNull()
    expect(await PROGRAM.settled(now, E, 0)).toBeNull()
    expect(await recordFile(now, '../../etc/passwd')).toBeNull()
    expect(await PROGRAM.sessions(now, [E, 'nonsense'])).toEqual([])
  })

  test('where it was found is forgotten when the file goes', async () => {
    const { now, old } = moved()
    const id = 'c0000001-0000-4000-8000-00000000c007'
    writeFileSync(join(old, `${id}.jsonl`), `${row('soon gone')}\n`)
    expect(await recordFile(now, id)).toBe(join(old, `${id}.jsonl`))
    rmSync(join(old, `${id}.jsonl`))
    expect(await recordFile(now, id)).toBeNull()
  })
})

describe('installing', () => {
  test('is the vendor’s own command, with where it was read and when', () => {
    const install = PROGRAM.install({})
    expect(install.line).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(install.source).toBe('https://code.claude.com/docs/en/setup')
    expect(install.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    /* Where the installer puts the launcher is the first place looked in after PATH. */
    expect(install.lands).toBe('~/.local/bin/claude')
    expect(dirname(install.lands.replace('~', HOME))).toBe(PROGRAM.find({ HOME, PATH: '' }).looked[0]!)
  })

  test('a stand-in can be named by whoever started the server, for walking the flow without a real install', () => {
    expect(PROGRAM.install({ KEHIKOT_CLAUDE_INSTALL_LINE: '/tmp/stand-in.sh' }).line).toBe('/tmp/stand-in.sh')
  })
})

/* ------------------------------------------------------------------ *
 * What is already running, and the view of a background session (#5)
 * ------------------------------------------------------------------ */

describe('asking what is running', () => {
  const wrapped = (name: string, env: string) => {
    const bin = scratch(name)
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\n${env} exec "${STAND_IN}" "$@"\n`, { mode: 0o755 })
    return join(bin, 'claude')
  }
  const entry = (more: Record<string, unknown>) => ({ pid: process.pid, cwd: '/p', kind: 'interactive', startedAt: 1791893581186, sessionId: A, name: 'project-ea', status: 'idle', ...more })

  test('a copy with `agents` and `attach` in its help can be asked; one without either cannot, and is not called too old to use', async () => {
    expect((await PROGRAM.supports(STAND_IN)).lists).toBe(true)
    expect(await PROGRAM.supports(wrapped('noagents', 'STANDIN_NOAGENTS=1'))).toEqual({ ok: true, missing: null, tells: true, lists: false, names: false, configures: true, plugins: true, backgrounds: false })
  })

  test('the option `--agents` in an older help is not the command `agents`', async () => {
    const bin = scratch('older')
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "  --agents <json>  JSON object defining custom agents"\necho "  -r, --resume [value]"\necho "  --session-id <uuid>"\n', { mode: 0o755 })
    expect((await PROGRAM.supports(join(bin, 'claude'))).lists).toBe(false)
  })

  test('nothing running is an empty list, and it is KNOWN to be empty', async () => {
    rmSync(join(CONFIG, 'sessions'), { recursive: true, force: true })
    expect(await PROGRAM.active(STAND_IN)).toEqual({ known: true, active: [] })
  })

  test('an interactive session and a background one are read as the real program prints them', async () => {
    mkdirSync(join(CONFIG, 'sessions'), { recursive: true })
    /* The stand-in lists the files of processes that are alive: this test's own process stands for one. */
    writeFileSync(join(CONFIG, 'sessions', `${process.pid}.json`), JSON.stringify(entry({})))
    try {
      expect(await PROGRAM.active(STAND_IN)).toEqual({
        known: true,
        active: [{ session: A, kind: 'interactive', called: 'interactive', handle: null, pid: process.pid, cwd: '/p', startedAt: 1791893581186, name: 'project-ea', state: null }],
      })
      writeFileSync(join(CONFIG, 'sessions', `${process.pid}.json`), JSON.stringify(entry({ kind: 'background', id: 'df6bd259', sessionId: B, state: 'working' })))
      const said = await PROGRAM.active(STAND_IN)
      expect(said.known && said.active[0]).toMatchObject({ session: B, kind: 'background', handle: 'df6bd259', state: 'working' })
    } finally {
      rmSync(join(CONFIG, 'sessions'), { recursive: true, force: true })
    }
  })

  test('a session whose process has gone is not listed', async () => {
    mkdirSync(join(CONFIG, 'sessions'), { recursive: true })
    writeFileSync(join(CONFIG, 'sessions', '999999.json'), JSON.stringify(entry({ pid: 999999 })))
    try {
      expect(await PROGRAM.active(STAND_IN)).toEqual({ known: true, active: [] })
    } finally {
      rmSync(join(CONFIG, 'sessions'), { recursive: true, force: true })
    }
  })

  test('a copy that cannot answer has not said "nothing is running": an error, and anything that is not a JSON array, are `failed`', async () => {
    expect(await PROGRAM.active(wrapped('refuses', 'STANDIN_NOAGENTS=1'))).toEqual({ known: false, why: 'failed' })
    for (const [name, prints] of [['prose', 'echo "no sessions"'], ['object', 'echo "{}"'], ['nothing', 'true']] as const) {
      const bin = scratch(name)
      writeFileSync(join(bin, 'claude'), `#!/bin/sh\n${prints}\n`, { mode: 0o755 })
      expect(await PROGRAM.active(join(bin, 'claude'))).toEqual({ known: false, why: 'failed' })
    }
    expect(await PROGRAM.active('/no/such/claude')).toEqual({ known: false, why: 'failed' })
  })

  test('an entry is taken for its shape and nothing more: no session id, no entry; a handle only for a background one, and only one word', () => {
    expect(readActive(entry({ sessionId: 'not-an-id' }))).toBeNull()
    expect(readActive(null)).toBeNull()
    expect(readActive('x')).toBeNull()
    /* A background entry that was just started has no pid, name or status yet. */
    expect(readActive({ id: '5e2cbccb', cwd: '/p', kind: 'background', startedAt: 1, sessionId: B, state: 'blocked' })).toEqual({ session: B, kind: 'background', called: 'background', handle: '5e2cbccb', pid: null, cwd: '/p', startedAt: 1, name: '', state: 'needs-you' })
    /* An interactive session has no handle even if it claims one: it cannot be attached to. */
    expect(readActive(entry({ id: 'abcd1234' }))?.handle).toBeNull()
    for (const not of ['--dangerously-skip-permissions', '-x', 'two words', 'a;b', '', 'x'.repeat(65), 7]) {
      expect(readActive(entry({ kind: 'background', id: not }))?.handle).toBeNull()
    }
    expect(readActive(entry({ kind: 'sdk' }))).toMatchObject({ kind: 'other', called: 'sdk', handle: null })
  })

  test('a background session’s `state` is read by shape: working, blocked (needs you) and done (finished); any other word, or none, says nothing', () => {
    const bg = (state: unknown) => readActive({ id: '5e2cbccb', cwd: '/p', kind: 'background', startedAt: 1, sessionId: B, state })?.state
    expect(bg('working')).toBe('working')
    expect(bg('blocked')).toBe('needs-you')
    expect(bg('done')).toBe('finished')
    for (const not of ['idle', 'Working', 'toString', '__proto__', '', 3, null, undefined, { working: true }]) expect(bg(not)).toBeNull()
  })

  test('a view of a background session is `attach <handle>` and nothing else — no settings, no prompt, and never a flag', () => {
    expect(PROGRAM.attach('df6bd259')).toEqual(['attach', 'df6bd259'])
    for (const not of ['--resume', '-h', 'a b', '']) expect(() => PROGRAM.attach(not)).toThrow()
  })

  test('the stand-in keeps a background session as the real program does: listed, attached to by its short id only, and one process throughout', async () => {
    const project = scratch('bgproject')
    const [dir] = recordDirs(project)
    mkdirSync(dir!, { recursive: true })
    writeFileSync(join(dir!, `${A}.jsonl`), `${row('started in the background')}\n`)
    const run = (args: string[], input = '') => spawnSync(STAND_IN, args, { cwd: project, env: { ...process.env }, input, encoding: 'utf8' })
    try {
      expect(run(['--bg', '--resume', A]).stdout).toContain('backgrounded · 11111111')
      const listed = await PROGRAM.active(STAND_IN)
      const one = listed.known ? listed.active.find((each) => each.session === A) : undefined
      expect(one).toMatchObject({ kind: 'background', handle: '11111111', cwd: project, state: 'working' })
      /* As measured on 2.1.296: the full session id is not a job, and says so. */
      const full = run(['attach', A])
      expect(full.status).toBe(1)
      expect(full.stdout).toContain(`No job matching '${A}'`)
      /* By its handle it opens, what is typed is the same conversation, and the view ending leaves the session listed under the same pid. */
      const view = run(PROGRAM.attach(one!.handle!), 'a second turn\n')
      expect(view.stdout).toContain('ATTACHED to background session 11111111')
      expect(view.stdout).toContain('you said: a second turn')
      const after = await PROGRAM.active(STAND_IN)
      expect(after.known && after.active.filter((each) => each.session === A).map((each) => each.pid)).toEqual([one!.pid])
    } finally {
      run(['stop', '11111111'])
    }
    const gone = await PROGRAM.active(STAND_IN)
    expect(gone.known && gone.active.some((each) => each.session === A)).toBe(false)
  })
})

describe('reading what the program prints', () => {
  test('whole, however long: the commands at the end of a long help are found, and a long list of sessions is still a list', async () => {
    /* The real program's help is 22 KB with "Commands:" last, and read over a socket it arrived as its first 8190 bytes. */
    const bin = scratch('long')
    const padding = Array.from({ length: 400 }, (_, index) => `echo "  --option-${index} <value>        a line of help that takes up room, as the real one's do"`).join('\n')
    writeFileSync(
      join(bin, 'claude'),
      `#!/bin/sh\nif [ "$1" = "--help" ]; then\necho "  -r, --resume [value]"\necho "  --session-id <uuid>"\n${padding}\necho "Commands:"\necho "  agents [options]   Manage background agents"\necho "  attach <id|name>   Open a background session in this terminal"\nexit 0\nfi\n`
        + `printf '['\ni=0\nwhile [ $i -lt 200 ]; do printf '{"pid":%s,"cwd":"/a/long/enough/path/to/a/project/folder","kind":"interactive","startedAt":1,"sessionId":"${A}","name":"n","status":"idle"},' $((i + 2)); i=$((i + 1)); done\nprintf '{"pid":9,"cwd":"/p","kind":"interactive","startedAt":1,"sessionId":"${B}"}]'\n`,
      { mode: 0o755 },
    )
    expect((await PROGRAM.supports(join(bin, 'claude'))).lists).toBe(true)
    const said = await PROGRAM.active(join(bin, 'claude'))
    expect(said.known && said.active.length).toBe(201)
    expect(said.known && said.active.at(-1)?.session).toBe(B)
  })
})

describe('what Claude Code appends to a record', () => {
  const X = 'a2ffb976-52bd-4914-b278-9e58b762be9d'
  const Y = '73785a82-9d3e-4ea9-b726-8f0b2c964a17'
  const Z = '709bdfd1-e77e-46e3-b317-4fc23ab766b7'
  /* The shapes as 2.1.303 wrote them, field for field. */
  const rows = [
    { type: 'ai-title', aiTitle: 'sign status toggle', sessionId: X },
    { type: 'ai-title', aiTitle: 'sign status toggle permissions', sessionId: X },
    { type: 'last-prompt', lastPrompt: 'Couple of questions: User cant switch the sign status\nsecond line', sessionId: X },
    { type: 'pr-link', sessionId: X, prNumber: '3411', prUrl: 'https://github.com/Jalez/kollekti/pull/3411', prRepository: 'Jalez/kollekti' },
    { type: 'pr-link', sessionId: X, prNumber: '3411', prUrl: 'https://github.com/Jalez/kollekti/pull/3411', prRepository: 'Jalez/kollekti' },
    { type: 'continued-in', sessionId: X, continuedInSessionId: Y },
    { type: 'user', message: { content: 'nothing of this is read' } },
    { type: 'continued-in', sessionId: X, continuedInSessionId: Z },
  ]

  test('the latest title, the last prompt, each PR once, and every continuation in order', () => {
    const tail = tailOf(`ut half a line"}\n${rows.map((one) => JSON.stringify(one)).join('\n')}\n`)
    expect(tail).toEqual({
      name: '',
      title: 'sign status toggle permissions',
      lastPrompt: 'Couple of questions: User cant switch the sign status',
      prs: [{ number: 3411, url: 'https://github.com/Jalez/kollekti/pull/3411' }],
      next: [Y, Z],
    })
  })

  test('a name the session was given wins over the title Claude Code wrote', () => {
    const tail = tailOf([{ type: 'ai-title', aiTitle: 'a title' }, { type: 'agent-name', agentName: 'MAKE MINUTES CUSTOM' }].map((one) => JSON.stringify(one)).join('\n'))
    expect(tail.name).toBe('MAKE MINUTES CUSTOM')
  })

  test('a conversation is where a process holds it now, else where it last grew', () => {
    const at = (id: string, lastActive: number, next: string[] = []): [string, Recorded] => [id, { id, label: '', lastActive, next }]
    const held = new Map([at(X, 1, [Y, Z]), at(Y, 30), at(Z, 20)])
    expect(headOf(X, held)).toBe(Y)
    expect(headOf(X, held, new Set([Z]))).toBe(Z)
    /* Never to a session this computer has no record of; and an id carried on nowhere is its own. */
    expect(headOf(X, new Map([at(X, 1, [Y])]))).toBe(X)
    expect(headOf(Y, held)).toBe(Y)
    /* Followed through more than one step, and a loop does not hang it. */
    expect(headOf(X, new Map([at(X, 1, [Y]), at(Y, 2, [Z]), at(Z, 3, [X])]))).toBe(Z)
  })

  test('a place’s name is one line, never a flag', () => {
    expect(sessionName(['hippos-portal', 'kiosk-info-reel', '', 'main'])).toBe('hippos-portal · kiosk-info-reel · main')
    expect(sessionName(['--yolo\n', 'x'])).toBe('yolo · x')
  })
})
