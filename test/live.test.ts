import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLOSED, Runs, TELL_ENV, TICKET, fenced, headless, opening, quoted, readPlace, sayable, tellLine, type Follower, type Notice, type Opening, type Pty, type Run, type Stated, type Viewer } from '../live.ts'
import { placeKey } from '../place.ts'
import { PROGRAM, type Active, type Program, type Recorded } from '../program.ts'
import { readPlaces, sessionsAt, type NamedPlace } from '../record.ts'

/**
 * The fence, and the runs behind it, without a socket or a real pty.
 *
 * `live.ts` keeps the deciding apart from the plumbing so that this can be
 * tested with a stand-in pty: what is left untested here is `on`, `send` and
 * `close`, and node-pty itself, which the walk in a browser covers. The
 * second emulator IS the real one — `@xterm/headless` — because what a
 * returning viewer is sent is exactly the thing worth being sure of.
 */

const PORT = 8010
const OK = { origin: `http://127.0.0.1:${PORT}`, host: `127.0.0.1:${PORT}` }
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const HERE = { epic: 'thesis', parts: ['methods'], kehikko: { id: 3 }, kehikkoName: 'writing' }

const made: string[] = []
const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-claude-live-')))
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

describe('who may open a session', () => {
  test('this module’s own page, on either spelling of loopback', () => {
    expect(fenced(OK, PORT).ok).toBe(true)
    expect(fenced({ origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` }, PORT).ok).toBe(true)
  })

  test('another origin, no origin, a rebound host and another port are all refused', () => {
    expect(fenced({ origin: 'https://evil.example', host: OK.host }, PORT).ok).toBe(false)
    expect(fenced({ host: OK.host }, PORT).ok).toBe(false)
    expect(fenced({ origin: OK.origin, host: 'evil.example' }, PORT).ok).toBe(false)
    expect(fenced({ origin: 'http://127.0.0.1:7920', host: OK.host }, PORT).ok).toBe(false)
  })

  test('a close reason is cut by bytes, on a character boundary', () => {
    const long = 'That did not carry this module’s ticket — '.repeat(6)
    expect(Buffer.byteLength(sayable(long))).toBeLessThanOrEqual(123)
    expect(sayable(long)).not.toContain('�')
    expect(sayable('short')).toBe('short')
  })
})

describe('the opening frame', () => {
  const frame = (more: Record<string, unknown>) => JSON.stringify({ ticket: 'T', projectPath: '/p', place: HERE, session: null, cols: 100, rows: 30, ...more })

  test('names a project, a place and a session, and carries the ticket', () => {
    expect(opening(frame({}), 'T')).toEqual({ what: 'session', projectPath: '/p', place: HERE, session: null, cols: 100, rows: 30 })
    expect(opening(frame({ session: A }), 'T')).toMatchObject({ session: A })
  })

  test('without this process’s ticket nothing else is looked at', () => {
    expect(typeof opening(frame({ ticket: 'other' }), 'T')).toBe('string')
    expect(typeof opening(frame({ ticket: undefined }), 'T')).toBe('string')
    expect(typeof opening('{"r":{"cols":80,"rows":24}}', 'T')).toBe('string')
    expect(typeof opening('not json', 'T')).toBe('string')
    expect(typeof opening(7, 'T')).toBe('string')
  })

  test('a session id that is not one, a place that is not one and a missing project are refused', () => {
    expect(typeof opening(frame({ session: '--dangerously-skip-permissions' }), 'T')).toBe('string')
    expect(typeof opening(frame({ session: '../x' }), 'T')).toBe('string')
    expect(typeof opening(frame({ place: { epic: 'Thesis', parts: [], kehikko: { id: 3 } } }), 'T')).toBe('string')
    expect(typeof opening(frame({ place: { epic: 'thesis', parts: ['a;b'], kehikko: { id: 3 } } }), 'T')).toBe('string')
    expect(typeof opening(frame({ place: null }), 'T')).toBe('string')
    expect(typeof opening(frame({ projectPath: '' }), 'T')).toBe('string')
  })

  test('carries no argument: there is no field a flag or a prompt could ride in on', () => {
    const said = opening(frame({ args: ['--dangerously-skip-permissions'], prompt: 'do it', command: 'rm' }), 'T')
    expect(Object.keys(said as object).sort()).toEqual(['cols', 'place', 'projectPath', 'rows', 'session', 'what'])
  })

  test('sizes are clamped rather than trusted, and the parts arrive as a set', () => {
    expect(opening(frame({ cols: 1, rows: 100000 }), 'T')).toMatchObject({ cols: 20, rows: 200 })
    expect(opening(frame({ cols: 'x', rows: null }), 'T')).toMatchObject({ cols: 80, rows: 24 })
    expect(readPlace({ epic: 'thesis', parts: ['results', 'methods', 'results'], kehikko: { id: 3 } })?.parts).toEqual(['methods', 'results'])
  })

  test('the kehikko arrives by its key or by its row number, told apart by the field and never by its looks', () => {
    const place = (kehikko: unknown, more: Record<string, unknown> = {}) => readPlace({ epic: 'thesis', parts: [], kehikko, ...more })
    expect(place({ key: '4072c9e5' })?.kehikko).toEqual({ key: '4072c9e5' })
    expect(place({ id: 3 })?.kehikko).toEqual({ id: 3 })
    /* As a page older than the key sent it. */
    expect(place(3)?.kehikko).toEqual({ id: 3 })
    expect(place(null)?.kehikko).toBeNull()
    /* An all-digit key is a key; a string is never read as a number. */
    expect(place({ key: '12345678' })?.kehikko).toEqual({ key: '12345678' })
    expect(placeKey(place({ key: '12345678' })!)).toBe('epic=thesis;parts=-;kehikko=key:12345678')
    expect(placeKey(place(12345678)!)).toBe('epic=thesis;parts=-;kehikko=12345678')
    for (const not of ['4072c9e5', '3', 3.5, Number.MAX_SAFE_INTEGER + 1, {}, { key: 'Not A Key' }, { key: 'a' }, { key: 3 }, { id: '3' }, { key: '4072c9e5', id: 3 }, { key: 'x;kehikko=1' }, []]) {
      expect(place(not)).toBeNull()
    }
    /* The row number rides beside a key as a note, and only beside a key. */
    expect(place({ key: '4072c9e5' }, { kehikkoId: 28, kehikkoName: 'writing' })).toEqual({ epic: 'thesis', parts: [], kehikko: { key: '4072c9e5' }, kehikkoName: 'writing', kehikkoId: 28 })
    expect(place({ id: 3 }, { kehikkoId: 28 })).not.toHaveProperty('kehikkoId')
    expect(place({ key: '4072c9e5' }, { kehikkoId: '28' })).not.toHaveProperty('kehikkoId')
    expect(opening(frame({ place: { epic: 'thesis', parts: ['methods'], kehikko: { key: '4072c9e5' }, kehikkoName: 'writing' } }), 'T')).toMatchObject({
      place: { kehikko: { key: '4072c9e5' } },
    })
  })

  test('the installer is asked for by one word, and still needs the ticket', () => {
    expect(opening(JSON.stringify({ ticket: 'T', install: true, cols: 90, rows: 20 }), 'T')).toEqual({ what: 'install', cols: 90, rows: 20 })
    expect(typeof opening(JSON.stringify({ install: true }), 'T')).toBe('string')
  })
})

/* ------------------------------------------------------------------ *
 * The runs, with a stand-in pty
 * ------------------------------------------------------------------ */

class FakePty implements Pty {
  pid = 0
  typed: string[] = []
  sizes: [number, number][] = []
  killed = false
  private heard: (chunk: string) => void = () => {}
  private exited: (exit: { exitCode: number }) => void = () => {}
  constructor(readonly file: string, readonly args: string[], readonly options: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }) {}
  onData(heard: (chunk: string) => void) {
    this.heard = heard
  }
  onExit(heard: (exit: { exitCode: number }) => void) {
    this.exited = heard
  }
  write(data: string) {
    this.typed.push(data)
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows])
  }
  kill() {
    if (this.killed) return
    this.killed = true
    this.exited({ exitCode: 129 })
  }
  /** The program prints. */
  says(text: string) {
    this.heard(text)
  }
  /** The program exits by itself. */
  ends(exitCode: number) {
    this.exited({ exitCode })
  }
}

class Watcher implements Viewer {
  out = ''
  said: Record<string, unknown>[] = []
  closed: { code: number; reason: string } | null = null
  output(data: string) {
    this.out += data
  }
  say(message: Record<string, unknown>) {
    this.said.push(message)
  }
  close(code: number, reason: string) {
    this.closed = { code, reason }
  }
}

/** Long enough for the emulator's write queue and the promises behind an open to have run. */
const settle = () => new Promise((done) => setTimeout(done, 25))

function world(options: { found?: string | null; able?: boolean; tells?: boolean; lists?: boolean; asking?: 'fails'; port?: number | null; line?: string; grace?: number; quiet?: number; stale?: number; heldWait?: number } = {}) {
  const logged: string[] = []
  const ptys: FakePty[] = []
  /* What the stand-in program holds a record for, by folder. */
  const held = new Map<string, Recorded[]>()
  let clock = 1_000_000
  /** What is running in processes this module did not start, as the program would list it. */
  const elsewhere: Active[] = []
  const asked = { count: 0 }
  let found: string | null = options.found === undefined ? '/fake/bin/claude' : options.found
  const program: Program = {
    ...PROGRAM,
    find: () => ({ file: found, looked: ['/fake/bin'], usual: [] }),
    supports: async () => ({ ok: options.able ?? true, missing: options.able === false ? '--session-id' : null, tells: options.tells ?? false, lists: options.lists ?? true }),
    /* What the stand-in program says is running, asked every time: a test changes `elsewhere` between two opens. */
    active: async () => {
      asked.count += 1
      return options.asking === 'fails' ? { known: false, why: 'failed' } : { known: true, active: [...elsewhere] }
    },
    newId: (() => {
      const ids = [B, '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555']
      return () => ids.shift() ?? PROGRAM.newId()
    })(),
    settled: async (projectPath, id) => (held.get(projectPath)?.some((one) => one.id === id) ? id : null),
    sessions: async (projectPath) => held.get(projectPath) ?? [],
    install: () => ({ ...PROGRAM.install({}), line: options.line ?? 'stand-in-installer' }),
    environment: () => ({ PATH: '/bin' }),
  }
  const runs = new Runs({
    program,
    grace: options.grace ?? 60_000,
    quiet: options.quiet ?? 30 * 60_000,
    stale: options.stale,
    heldWait: options.heldWait ?? 0,
    port: () => options.port ?? null,
    /* No clock of its own: a test moves the time and calls `rest`. */
    every: null,
    log: (line) => logged.push(line),
    now: () => clock,
    screen: headless,
    spawn: (file, args, opts) => {
      const pty = new FakePty(file, args, opts)
      ptys.push(pty)
      return pty
    },
  })
  return {
    runs,
    ptys,
    logged,
    elsewhere,
    asked,
    /** The program writes its record: from here on the session exists. */
    records: (projectPath: string, id: string, label = '') => held.set(projectPath, [...(held.get(projectPath) ?? []).filter((one) => one.id !== id), { id, label, lastActive: clock }]),
    later: (ms: number) => {
      clock += ms
    },
    install: (file: string | null) => {
      found = file
    },
  }
}

const ask = (projectPath: string, session: string | null, place: NamedPlace = HERE): Extract<Opening, { what: 'session' }> => ({ what: 'session', projectPath, place, session, cols: 100, rows: 30 })
const isRun = (opened: unknown): opened is Run => typeof opened === 'object' && opened !== null && 'pty' in opened
const listed = (dir: string, place = HERE) => {
  const read = readPlaces(dir)
  if (!read.ok) throw new Error(read.error)
  return sessionsAt(read.value, placeKey(place))
}

describe('opening a session', () => {
  test('a new one is started in the project’s folder with an id of this module’s choosing, and nothing else', async () => {
    const dir = project()
    const w = world()
    const viewer = new Watcher()
    const run = await w.runs.open(ask(dir, null), viewer)
    expect(isRun(run)).toBe(true)
    expect(w.ptys.length).toBe(1)
    expect(w.ptys[0]!.file).toBe('/fake/bin/claude')
    expect(w.ptys[0]!.args).toEqual(['--session-id', B])
    expect(w.ptys[0]!.options.cwd).toBe(dir)
    expect(viewer.said[0]).toMatchObject({ opened: 'new', session: B })
    /* Never a prompt: nothing was typed into it. */
    expect(w.ptys[0]!.typed).toEqual([])
  })

  test('a session is recorded for its place only once it exists', async () => {
    const dir = project()
    const w = world()
    await w.runs.open(ask(dir, null), new Watcher())
    w.ptys[0]!.says('Welcome. Sign in to continue.\r\n')
    await settle()
    /* Shown a sign-in screen and nothing typed: there is no session, and no row that could never be resumed. */
    expect(listed(dir)).toEqual([])

    w.records(dir, B, 'tighten the methods section')
    w.later(5_000)
    w.ptys[0]!.says('working…\r\n')
    await settle()
    expect(listed(dir)).toEqual([B])
    const read = readPlaces(dir)
    expect(read.ok && read.value.sessions[B]?.label).toBe('tighten the methods section')
  })

  test('one that ends without ever existing leaves no record, and is not called a failure', async () => {
    const dir = project()
    const w = world()
    const viewer = new Watcher()
    await w.runs.open(ask(dir, null), viewer)
    await settle()
    w.ptys[0]!.ends(0)
    await settle()
    expect(viewer.closed).toEqual({ code: CLOSED.ended, reason: 'the session ended (0)' })
    expect(listed(dir)).toEqual([])
    expect(w.runs.sessions()).toEqual([])
  })

  test('one the program holds a record for is resumed', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A, 'an earlier conversation')
    const viewer = new Watcher()
    await w.runs.open(ask(dir, A), viewer)
    expect(w.ptys[0]!.args).toEqual(['--resume', A])
    expect(viewer.said[0]).toMatchObject({ opened: 'resumed', session: A })
    /* Opening it here is what attaches it here: it is on this place's list now. */
    expect(listed(dir)).toEqual([A])

  })

  test('one the record lists and the program has nothing for on this computer is refused — never started under the old id', async () => {
    /* places.json came with the project, from the computer where the session ran. */
    const dir = project()
    const w = world()
    w.records(dir, A, 'started on the other computer')
    await w.runs.open(ask(dir, A), new Watcher())
    w.ptys[0]!.ends(0)
    await settle()
    expect(listed(dir)).toEqual([A])

    /* The same project folder, on a machine whose Claude Code has never heard of A. */
    const elsewhere = world()
    const viewer = new Watcher()
    const refused = await elsewhere.runs.open(ask(dir, A), viewer)
    expect(refused).toMatchObject({ code: CLOSED.refused })
    expect((refused as { why: string }).why).toContain('on this computer')
    /* Nothing started: not `--resume`, which the program would refuse, and not `--session-id`, which would be another conversation. */
    expect(elsewhere.ptys.length).toBe(0)
    /* And it is still in the record, for the computer that has it. */
    expect(listed(dir)).toEqual([A])
    const read = readPlaces(dir)
    expect(read.ok && read.value.sessions[A]?.label).toBe('started on the other computer')
  })

  test('a place named by its kehikko’s key is recorded under the key, with the row number beside it as a note', async () => {
    const dir = project()
    const keyed = { epic: 'thesis', parts: ['methods'], kehikko: { key: '4072c9e5' }, kehikkoName: 'writing', kehikkoId: 3 }
    const w = world()
    w.records(dir, A)
    await w.runs.open(ask(dir, A, keyed), new Watcher())
    const read = readPlaces(dir)
    expect(read.ok && read.value.places).toEqual({
      'epic=thesis;parts=methods;kehikko=key:4072c9e5': { epic: 'thesis', parts: ['methods'], kehikko: { key: '4072c9e5', id: 3, name: 'writing' }, sessions: [A] },
    })
    /* The host renumbers it: the same place, the same session, and only the note changes. */
    w.ptys[0]!.ends(0)
    await settle()
    const again = world()
    again.records(dir, A)
    await again.runs.open(ask(dir, A, { ...keyed, kehikkoId: 28 }), new Watcher())
    expect(again.ptys[0]!.args).toEqual(['--resume', A])
    const after = readPlaces(dir)
    expect(after.ok && Object.keys(after.value.places)).toEqual(['epic=thesis;parts=methods;kehikko=key:4072c9e5'])
    expect(after.ok && after.value.places['epic=thesis;parts=methods;kehikko=key:4072c9e5']?.kehikko).toEqual({ key: '4072c9e5', id: 28, name: 'writing' })
  })

  test('an id nothing knows — not running, not recorded, not the program’s — is refused, and nothing is started', async () => {
    const w = world()
    const refused = await w.runs.open(ask(project(), A), new Watcher())
    expect(refused).toMatchObject({ code: CLOSED.refused })
    expect(w.ptys.length).toBe(0)
  })

  test('a folder that is not there is refused, and so is the program being missing', async () => {
    const w = world({ found: null })
    expect(await w.runs.open(ask('/no/such/folder', null), new Watcher())).toMatchObject({ code: CLOSED.refused })
    expect(await w.runs.open(ask(project(), null), new Watcher())).toMatchObject({ code: CLOSED.missing })
    expect(w.ptys.length).toBe(0)
  })

  test('two viewers arriving together for one session get one process, not two', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A)
    const [one, two] = await Promise.all([w.runs.open(ask(dir, A), new Watcher()), w.runs.open(ask(dir, A), new Watcher())])
    expect(w.ptys.length).toBe(1)
    expect(one).toBe(two)
  })
})

describe('a session outlives whoever is looking at it', () => {
  test('a viewer that leaves ends nothing, and one that comes back is sent the screen as it stands', async () => {
    const dir = project()
    const w = world()
    const first = new Watcher()
    const run = (await w.runs.open(ask(dir, null), first)) as Run
    await settle()
    w.ptys[0]!.says('line one\r\n\x1b[32mline two in green\x1b[0m\r\n')
    await settle()
    expect(first.out).toContain('line one')

    /* The page reloads: its socket goes. */
    w.runs.detach(run, first)
    w.ptys[0]!.says('said while nobody was looking\r\n')
    await settle()
    expect(w.ptys[0]!.killed).toBe(false)
    expect(w.runs.sessions().length).toBe(1)
    expect(first.out).not.toContain('nobody was looking')

    /* It comes back, by the id it was told. */
    const second = new Watcher()
    const again = await w.runs.open(ask(dir, B), second)
    await settle()
    expect(again).toBe(run)
    expect(w.ptys.length).toBe(1)
    expect(second.said[0]).toMatchObject({ opened: 'attached', session: B })
    expect(second.out).toContain('line one')
    expect(second.out).toContain('line two in green')
    expect(second.out).toContain('said while nobody was looking')
    /* The colour came back with the words: it is the screen, not a log of text. */
    expect(second.out).toContain('\x1b[32m')

    /* And from here it follows along, once. */
    w.ptys[0]!.says('after\r\n')
    await settle()
    expect(second.out.split('after').length).toBe(2)
  })

  test('what a returning viewer is sent is bounded by the scrollback, not by how long the session has run', async () => {
    const dir = project()
    const w = world()
    const run = (await w.runs.open(ask(dir, null), new Watcher())) as Run
    for (let n = 0; n < 9000; n += 1) w.ptys[0]!.says(`row ${n}\r\n`)
    await settle()
    const back = new Watcher()
    w.runs.attach(run, back, 100, 30, 'attached')
    await new Promise((done) => setTimeout(done, 400))
    expect(back.out).toContain('row 8999')
    expect(back.out).not.toContain('row 100\r')
    expect(back.out.split('\n').length).toBeLessThan(5200)
  })

  test('the pty is told the size of the viewer that arrives, and typing reaches it', async () => {
    const dir = project()
    const w = world()
    const run = (await w.runs.open(ask(dir, null), new Watcher())) as Run
    await settle()
    expect(w.ptys[0]!.sizes.at(-1)).toEqual([100, 30])
    w.runs.resize(run, 140, 40)
    w.runs.type(run, 'hello\r')
    expect(w.ptys[0]!.sizes.at(-1)).toEqual([140, 40])
    expect(w.ptys[0]!.typed).toEqual(['hello\r'])
  })

  test('two places may show one session: both viewers follow it', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A)
    const one = new Watcher()
    const two = new Watcher()
    await w.runs.open(ask(dir, A), one)
    await w.runs.open(ask(dir, A, { epic: 'thesis', parts: [], kehikko: { id: 3 }, kehikkoName: 'writing' }), two)
    await settle()
    w.ptys[0]!.says('to both\r\n')
    await settle()
    expect(one.out).toContain('to both')
    expect(two.out).toContain('to both')
    expect(w.ptys.length).toBe(1)
    /* Attaching is recorded for the second place too. */
    expect(listed(dir, { epic: 'thesis', parts: [], kehikko: { id: 3 }, kehikkoName: 'writing' })).toEqual([A])
  })

  test('when the program exits, everyone watching is told, and it is no longer running', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A)
    const viewer = new Watcher()
    await w.runs.open(ask(dir, A), viewer)
    await settle()
    w.ptys[0]!.ends(0)
    await settle()
    expect(viewer.closed?.code).toBe(CLOSED.ended)
    expect(w.runs.find(A)).toBeNull()
  })
})

describe('a session that was never one', () => {
  test('opened, never typed into, never recorded, and nobody looking: it is ended, after a moment', async () => {
    const dir = project()
    const w = world({ grace: 30 })
    const viewer = new Watcher()
    const run = (await w.runs.open(ask(dir, null), viewer)) as Run
    await settle()
    w.runs.detach(run, viewer)
    expect(w.ptys[0]!.killed).toBe(false)
    await new Promise((done) => setTimeout(done, 80))
    expect(w.ptys[0]!.killed).toBe(true)
    expect(w.runs.sessions()).toEqual([])
  })

  test('a viewer that comes back inside the moment — a page reload — finds it', async () => {
    const dir = project()
    const w = world({ grace: 60 })
    const viewer = new Watcher()
    const run = (await w.runs.open(ask(dir, null), viewer)) as Run
    await settle()
    w.runs.detach(run, viewer)
    expect(await w.runs.open(ask(dir, B), new Watcher())).toBe(run)
    await new Promise((done) => setTimeout(done, 120))
    expect(w.ptys[0]!.killed).toBe(false)
  })

  test('one somebody has typed a character into is kept, and so is one the program has recorded', async () => {
    const dir = project()
    const typed = world({ grace: 20 })
    const one = new Watcher()
    const run = (await typed.runs.open(ask(dir, null), one)) as Run
    await settle()
    typed.runs.type(run, 'h')
    typed.runs.detach(run, one)

    const other = project()
    const existing = world({ grace: 20 })
    existing.records(other, A)
    const two = new Watcher()
    const resumed = (await existing.runs.open(ask(other, A), two)) as Run
    await settle()
    existing.runs.detach(resumed, two)

    await new Promise((done) => setTimeout(done, 80))
    expect(typed.ptys[0]!.killed).toBe(false)
    expect(existing.ptys[0]!.killed).toBe(false)
  })
})

describe('what counts as typing', () => {
  /* What xterm answered Claude Code 2.1.296 before any key, the focus the page gives its terminal, and a pointer crossing it. */
  const REPLIES = ['\x1b[?1;2c', '\x1b[I', '\x1b[O', '\x1b[<35;40;12M', '\x1b[<0;40;12M\x1b[<0;40;12m', '\x1b[12;1R', '\x1b]11;rgb:0a0a/0a0a/0a0a\x1b\\', '\x1bP>|xterm.js(6.0.0)\x1b\\', '\x1b[?0u', '\x1b[?2026;2$y', '\x1b[?997;1n']

  test('the emulator’s own replies reach the program and are not typing: the run is still ended after the moment', async () => {
    const dir = project()
    const w = world({ grace: 30 })
    const viewer = new Watcher()
    const run = (await w.runs.open(ask(dir, null), viewer)) as Run
    await settle()
    for (const reply of REPLIES) w.runs.type(run, reply)
    /* Every one was handed on: the program asked, and has to be answered. */
    expect(w.ptys[0]!.typed).toEqual(REPLIES)
    expect(run.touched).toBe(false)
    w.runs.detach(run, viewer)
    await new Promise((done) => setTimeout(done, 80))
    expect(w.ptys[0]!.killed).toBe(true)
  })

  test('a key, a key a full-screen program is sent, and a paste are each typing, and keep it', async () => {
    for (const typed of ['h', '\r', '\x1b[A', '\x1bOP', '\x1b[97;5u', '\x03', '\x1b[200~pasted text\x1b[201~', '\x1b[?1;2ch']) {
      const dir = project()
      const w = world({ grace: 20 })
      const viewer = new Watcher()
      const run = (await w.runs.open(ask(dir, null), viewer)) as Run
      await settle()
      w.runs.type(run, '\x1b[?1;2c')
      w.runs.type(run, typed)
      expect(run.touched).toBe(true)
      w.runs.detach(run, viewer)
      await new Promise((done) => setTimeout(done, 60))
      expect(w.ptys[0]!.killed).toBe(false)
    }
  })
})

describe('there is no limit on how many run', () => {
  test('an open is never refused for what else is running: a new one, and one resumed', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A, 'an earlier conversation')
    for (let n = 0; n < 12; n += 1) {
      expect(isRun(await w.runs.open(ask(dir, null, { ...HERE, parts: [`part-${n}`] }), new Watcher()))).toBe(true)
    }
    const viewer = new Watcher()
    expect(isRun(await w.runs.open(ask(dir, A), viewer))).toBe(true)
    expect(viewer.said[0]).toMatchObject({ opened: 'resumed', session: A })
    expect(w.ptys.length).toBe(13)
    expect(w.ptys.every((pty) => !pty.killed)).toBe(true)
    expect(w.runs.sessions().length).toBe(13)
    expect(Object.values(CLOSED)).not.toContain(4429)
  })

  test('a person may still end the one they choose', async () => {
    const dir = project()
    const w = world()
    const viewer = new Watcher()
    await w.runs.open(ask(dir, null), viewer)
    await settle()
    expect(w.runs.end('99999999-9999-4999-8999-999999999999')).toBe(false)
    expect(w.runs.end(B)).toBe(true)
    await settle()
    expect(w.ptys[0]!.killed).toBe(true)
    expect(viewer.closed?.code).toBe(CLOSED.ended)
  })

  test('when this process stops, nothing it started is left running', async () => {
    const dir = project()
    const w = world()
    await w.runs.open(ask(dir, null), new Watcher())
    await w.runs.open(ask(dir, null, { ...HERE, parts: [] }), new Watcher())
    w.runs.endAll()
    expect(w.ptys.every((pty) => pty.killed)).toBe(true)
  })
})

describe('a waiting session nobody is looking at is put away, and resumed', () => {
  const QUIET = 30 * 60_000
  const THERE = { ...HERE, parts: ['results'] }

  /** A recorded session, opened and typed into, with its one viewer. */
  async function working(w: ReturnType<typeof world>, dir: string, id: string, place: NamedPlace = HERE) {
    w.records(dir, id, 'a conversation')
    const viewer = new Watcher()
    const run = (await w.runs.open(ask(dir, id, place), viewer)) as Run
    await settle()
    w.runs.type(run, 'hello\r')
    return { run, viewer, pty: w.ptys.at(-1)! }
  }

  test('quiet for the whole time with nobody looking: its process is ended, one line is logged, and nothing is said of an ending', async () => {
    const dir = project()
    const w = world({ quiet: QUIET })
    const { run, viewer, pty } = await working(w, dir, A)
    /* The canvas moves on: the view stays mounted behind another, socket open, and says it is not on screen. */
    w.runs.look(run, viewer, false)
    w.later(QUIET - 1)
    expect(w.runs.rest()).toEqual([])
    expect(pty.killed).toBe(false)
    w.later(1)
    expect(w.runs.rest()).toEqual([run])
    await settle()
    expect(pty.killed).toBe(true)
    expect(w.runs.find(A)).toBeNull()
    expect(viewer.closed?.code).toBe(CLOSED.rested)
    expect(w.logged.filter((line) => line.includes('put away'))).toEqual([`claude: put away ${A}, which nobody was looking at and which had printed nothing for 30 min — its place resumes it`])
    /* The record is untouched: the place still has its session. */
    expect(listed(dir)).toEqual([A])
  })

  test('the place resumes it by its id on the next visit: the same session, started again', async () => {
    const dir = project()
    const w = world({ quiet: QUIET })
    const { run, viewer } = await working(w, dir, A)
    w.runs.detach(run, viewer)
    w.later(QUIET)
    w.runs.rest()
    await settle()
    expect(w.runs.sessions()).toEqual([])

    const back = new Watcher()
    const again = await w.runs.open(ask(dir, A), back)
    expect(isRun(again)).toBe(true)
    expect(again).not.toBe(run)
    expect(w.ptys.length).toBe(2)
    expect(w.ptys[1]!.args).toEqual(['--resume', A])
    expect(back.said[0]).toMatchObject({ opened: 'resumed', session: A, exists: true })
    expect(listed(dir)).toEqual([A])
  })

  test('one somebody has on screen is never put away, however long it is quiet', async () => {
    const dir = project()
    const w = world({ quiet: QUIET })
    const { pty } = await working(w, dir, A)
    w.later(QUIET * 20)
    expect(w.runs.rest()).toEqual([])
    expect(pty.killed).toBe(false)
  })

  test('one that is printing is never put away, however long nobody has looked', async () => {
    const dir = project()
    const w = world({ quiet: QUIET })
    const { run, viewer, pty } = await working(w, dir, A)
    w.runs.detach(run, viewer)
    /* Three hours of an agent at work: a spinner frame every so often, never a silence as long as the time. */
    for (let n = 0; n < 36; n += 1) {
      w.later(5 * 60_000)
      pty.says('\r⠋ working…')
      expect(w.runs.rest()).toEqual([])
    }
    expect(pty.killed).toBe(false)
    /* It finishes and waits. Only then does the time start. */
    w.later(QUIET - 1)
    expect(w.runs.rest()).toEqual([])
    w.later(1)
    expect(w.runs.rest()).toEqual([run])
  })

  test('the time starts when the last person looks away, not when the program last printed', async () => {
    const dir = project()
    const w = world({ quiet: QUIET })
    const { run, viewer, pty } = await working(w, dir, A)
    /* Read for two hours, nothing printed. */
    w.later(4 * QUIET)
    w.runs.look(run, viewer, false)
    expect(w.runs.rest()).toEqual([])
    w.later(QUIET - 1)
    expect(w.runs.rest()).toEqual([])
    /* Looked at again, and away again: the whole time once more. */
    w.runs.look(run, viewer, true)
    w.later(QUIET)
    expect(w.runs.rest()).toEqual([])
    w.runs.look(run, viewer, false)
    w.later(QUIET - 1)
    expect(w.runs.rest()).toEqual([])
    expect(pty.killed).toBe(false)
    w.later(1)
    expect(w.runs.rest()).toEqual([run])
  })

  test('of several, only the quiet unwatched ones go: the watched one and the working one stay', async () => {
    const dir = project()
    const w = world({ quiet: QUIET })
    const quiet = await working(w, dir, A)
    const watched = await working(w, dir, '66666666-6666-4666-8666-666666666666', THERE)
    const busy = await working(w, dir, '77777777-7777-4777-8777-777777777777', { ...HERE, parts: [] })
    w.runs.look(quiet.run, quiet.viewer, false)
    w.runs.look(busy.run, busy.viewer, false)
    w.later(QUIET)
    busy.pty.says('still at it\r\n')
    expect(w.runs.rest()).toEqual([quiet.run])
    expect([quiet.pty.killed, watched.pty.killed, busy.pty.killed]).toEqual([true, false, false])
  })

  test('the installer is not a session and is never put away', async () => {
    const w = world({ found: null, quiet: QUIET })
    const viewer = new Watcher()
    const run = (await w.runs.install({ what: 'install', cols: 100, rows: 30 }, viewer)) as Run
    await settle()
    w.runs.detach(run, viewer)
    w.later(QUIET * 4)
    expect(w.runs.rest()).toEqual([])
    expect(w.ptys[0]!.killed).toBe(false)
  })
})

describe('installing, which only a press in the page can ask for', () => {
  const press: Extract<Opening, { what: 'install' }> = { what: 'install', cols: 100, rows: 30 }

  test('runs the adapter’s command in a pty, and says the command first', async () => {
    const w = world({ found: null, line: 'curl -fsSL https://example.invalid/install.sh | bash' })
    const viewer = new Watcher()
    await w.runs.install(press, viewer)
    await settle()
    expect(w.ptys[0]!.file).toBe('/bin/sh')
    expect(w.ptys[0]!.args).toEqual(['-c', 'curl -fsSL https://example.invalid/install.sh | bash'])
    expect(viewer.said[0]).toMatchObject({ opened: 'install' })
    w.ptys[0]!.says('downloading…\r\n')
    await settle()
    expect(viewer.out.indexOf('$ curl -fsSL https://example.invalid/install.sh | bash')).toBe(0)
    expect(viewer.out).toContain('downloading…')
    /* It is not a session, and nothing is recorded. */
    expect(w.runs.sessions()).toEqual([])
  })

  test('when it exits and the binary is there, the page is told it is installed', async () => {
    const w = world({ found: null })
    const viewer = new Watcher()
    await w.runs.install(press, viewer)
    await settle()
    w.install('/scratch/home/.local/bin/claude')
    w.ptys[0]!.ends(0)
    await settle()
    expect(viewer.closed).toEqual({ code: CLOSED.installed, reason: 'installed at /scratch/home/.local/bin/claude' })
  })

  test('a non-zero exit, and an exit that left no binary, are both said as not installed', async () => {
    const failed = world({ found: null })
    const one = new Watcher()
    await failed.runs.install(press, one)
    await settle()
    failed.ptys[0]!.ends(7)
    await settle()
    expect(one.closed).toEqual({ code: CLOSED.notInstalled, reason: 'the installer exited with 7' })

    const nothing = world({ found: null })
    const two = new Watcher()
    await nothing.runs.install(press, two)
    await settle()
    nothing.ptys[0]!.ends(0)
    await settle()
    expect(two.closed?.code).toBe(CLOSED.notInstalled)
  })

  test('is refused while a usable copy is installed, so the socket cannot run it at will', async () => {
    const w = world()
    const said = await w.runs.install(press, new Watcher())
    expect(said).toMatchObject({ code: CLOSED.installed })
    expect(w.ptys.length).toBe(0)
  })

  test('a copy that is too old may be updated by the same press', async () => {
    const w = world({ able: false })
    await w.runs.install(press, new Watcher())
    expect(w.ptys.length).toBe(1)
  })

  test('a second press while it runs watches the same installer rather than starting another', async () => {
    const w = world({ found: null })
    await w.runs.install(press, new Watcher())
    await w.runs.install(press, new Watcher())
    expect(w.ptys.length).toBe(1)
  })
})

/* ------------------------------------------------------------------ *
 * What a session is doing: told by its program, never read off a screen
 * ------------------------------------------------------------------ */

const TELL_PORT = 9590
const TOLD = { tells: true, port: TELL_PORT }
const NAMED: NamedPlace = { epic: 'thesis', parts: ['methods', 'results'], kehikko: { key: '4072c9e5' }, kehikkoName: 'writing', partNames: ['Methods', 'Results'] }
const secretOf = (pty: FakePty) => String(pty.options.env[TELL_ENV.secret])

/** Something following along, as a page's feed is. */
function follower(notices = true) {
  const states: Stated[] = []
  const got: Notice[] = []
  const one: Follower = { notices, state: (stated) => states.push(stated), notice: (notice) => got.push(notice) }
  return { one, states, got }
}

describe('asking the program to say what it is doing', () => {
  test('a copy that can is given its hooks on the command line and a secret in the environment, and nothing else', async () => {
    const dir = project()
    const w = world(TOLD)
    await w.runs.open(ask(dir, null), new Watcher())
    const pty = w.ptys[0]!
    expect(pty.args.slice(0, 2)).toEqual(['--session-id', B])
    expect(pty.args[2]).toBe('--settings')
    expect(pty.args.length).toBe(4)
    const settings = JSON.parse(pty.args[3]!) as { hooks: Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]> }
    /* Hooks, and no other setting: nothing about permissions, models or tools. */
    expect(Object.keys(settings)).toEqual(['hooks'])
    for (const [event, entries] of Object.entries(settings.hooks)) {
      expect(PROGRAM.signal(event)).not.toBeNull()
      expect(entries).toEqual([{ hooks: [{ type: 'command', command: tellLine(event), timeout: 5 }] }])
      /* This module's own script, by its whole path, and the event's name: nothing else is on the line. */
      expect(entries[0]!.hooks[0]!.command).toMatch(/^\/bin\/sh '[^']+\/tell\.sh' [A-Za-z]+$/)
    }
    expect(Object.keys(settings.hooks).sort()).toEqual(['Elicitation', 'ElicitationResult', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'UserPromptSubmit'])

    const secret = secretOf(pty)
    expect(secret).toMatch(/^[0-9a-f]{48}$/)
    expect(pty.options.env[TELL_ENV.port]).toBe(String(TELL_PORT))
    expect(pty.options.env[TELL_ENV.session]).toBe(B)
    /* Never where another process on the machine could list it, and never in the log. */
    expect(pty.args.join(' ')).not.toContain(secret)
    expect(w.logged.join('\n')).not.toContain(secret)
  })

  test('each run has a secret of its own', async () => {
    const dir = project()
    const w = world(TOLD)
    await w.runs.open(ask(dir, null), new Watcher())
    await w.runs.open(ask(dir, null, { ...HERE, parts: ['results'] }), new Watcher())
    expect(secretOf(w.ptys[0]!)).not.toBe(secretOf(w.ptys[1]!))
  })

  test('a resumed session is asked the same way, under the id it is resumed by', async () => {
    const dir = project()
    const w = world(TOLD)
    w.records(dir, A)
    await w.runs.open(ask(dir, A), new Watcher())
    expect(w.ptys[0]!.args.slice(0, 3)).toEqual(['--resume', A, '--settings'])
    expect(w.ptys[0]!.options.env[TELL_ENV.session]).toBe(A)
  })

  test('a copy too old for it is started exactly as before, and has no state', async () => {
    const dir = project()
    const w = world({ tells: false, port: TELL_PORT })
    const run = (await w.runs.open(ask(dir, null), new Watcher())) as Run
    expect(w.ptys[0]!.args).toEqual(['--session-id', B])
    expect(Object.keys(w.ptys[0]!.options.env).filter((name) => name.startsWith('KEHIKOT_TELL'))).toEqual([])
    expect(run.state).toBeNull()
    /* And nothing can be said about it: there is no secret to say it with. */
    expect(w.runs.heard(B, '', 'Stop')).toBe(false)
    expect(w.runs.heard(B, null, 'Stop')).toBe(false)
  })

  test('with nowhere to report to, nothing is asked', async () => {
    const dir = project()
    const w = world({ tells: true, port: null })
    await w.runs.open(ask(dir, null), new Watcher())
    expect(w.ptys[0]!.args).toEqual(['--session-id', B])
  })

  test('a path with a quote in it is still one word to the shell', () => {
    expect(quoted("/Users/o'brien/mod/tell.sh")).toBe(`'/Users/o'\\''brien/mod/tell.sh'`)
    expect(tellLine('Stop', '/a b/tell.sh')).toBe(`/bin/sh '/a b/tell.sh' Stop`)
  })
})

describe('what the program says', () => {
  async function told() {
    const dir = project()
    const w = world(TOLD)
    const viewer = new Watcher()
    const run = (await w.runs.open(ask(dir, null, NAMED), viewer)) as Run
    await settle()
    const secret = secretOf(w.ptys[0]!)
    return { dir, w, viewer, run, secret, hear: (event: string) => w.runs.heard(B, secret, event) }
  }

  test('nothing is known until it says something', async () => {
    const { run, viewer } = await told()
    expect(run.state).toBeNull()
    expect(viewer.said[0]).toMatchObject({ opened: 'new', state: null })
  })

  test('every change, in the order the real program reports them', async () => {
    const { run, viewer, hear, w } = await told()
    const seen: unknown[] = []
    for (const [event, state] of [
      ['UserPromptSubmit', 'working'],
      ['PermissionRequest', 'needs-you'],
      ['PostToolUse', 'working'],
      ['Stop', 'finished'],
      ['UserPromptSubmit', 'working'],
      ['StopFailure', 'needs-you'],
      ['UserPromptSubmit', 'working'],
      ['Elicitation', 'needs-you'],
      ['ElicitationResult', 'working'],
      ['PostToolUseFailure', 'working'],
    ] as const) {
      w.later(1000)
      expect(hear(event)).toBe(true)
      expect(run.state).toBe(state)
      seen.push(run.state)
    }
    /* The viewer is told each CHANGE, with since when — the last report changed nothing and said nothing. */
    const changes = viewer.said.filter((one) => 'since' in one && !('opened' in one))
    expect(changes.map((one) => one.state)).toEqual(['working', 'needs-you', 'working', 'finished', 'working', 'needs-you', 'working', 'needs-you', 'working'])
    expect(changes.every((one) => one.session === B && typeof one.since === 'number')).toBe(true)
  })

  test('the same thing said twice is one change: since when does not move', async () => {
    const { run, hear, w } = await told()
    hear('Stop')
    const since = run.stateSince
    w.later(5000)
    hear('Stop')
    expect(run.stateSince).toBe(since)
  })

  test('an event this program does not use is heard and changes nothing', async () => {
    const { run, hear } = await told()
    hear('UserPromptSubmit')
    for (const event of ['PreToolUse', 'Notification', 'SessionStart', 'constructor', '__proto__', '', 'stop']) {
      expect(hear(event)).toBe(true)
      expect(run.state).toBe('working')
    }
  })

  test('a report is believed only with that session’s own secret', async () => {
    const { dir, run, secret, w } = await told()
    const other = (await w.runs.open(ask(dir, null, { ...HERE, parts: ['results'] }), new Watcher())) as Run
    for (const wrong of [null, '', 'x', secret.slice(1), `${secret}0`, secretOf(w.ptys[1]!), TICKET]) {
      expect(w.runs.heard(B, wrong, 'Stop')).toBe(false)
    }
    expect(run.state).toBeNull()
    /* The right secret under another session's id is no better, and a session that is not running has none. */
    expect(w.runs.heard(other.id, secret, 'Stop')).toBe(false)
    expect(w.runs.heard(A, secret, 'Stop')).toBe(false)
    expect(w.runs.heard('install', secret, 'Stop')).toBe(false)
    expect(other.state).toBeNull()
    expect(w.runs.heard(B, secret, 'Stop')).toBe(true)
    expect(run.state).toBe('finished')
  })

  test('once it has ended nothing more is believed about it, and what was said is taken back', async () => {
    const { run, viewer, hear, w } = await told()
    hear('UserPromptSubmit')
    const feed = follower()
    w.runs.subscribe(feed.one)
    w.ptys[0]!.ends(0)
    await settle()
    expect(hear('Stop')).toBe(false)
    expect(run.state).toBeNull()
    expect(feed.states.at(-1)).toMatchObject({ session: B, state: null })
    expect(viewer.closed?.code).toBe(CLOSED.ended)
  })

  test('a person typing into a session that was waiting for them has answered it; a lone Esc and the emulator’s own replies have not', async () => {
    const { run, hear, w } = await told()
    hear('UserPromptSubmit')
    hear('PermissionRequest')
    w.runs.type(run, '\x1b[?1;2c')
    w.runs.type(run, '\x1b[I')
    expect(run.state).toBe('needs-you')
    /* Esc puts the question away without answering it. */
    w.runs.type(run, '\x1b')
    expect(run.state).toBe('needs-you')
    w.runs.type(run, '1')
    expect(run.state).toBe('working')
    /* And typing into one that is finished, or working, says nothing about its state. */
    hear('Stop')
    w.runs.type(run, 'next')
    expect(run.state).toBe('finished')
  })

  test('a turn that ended with background work still running is not put away, however long; one that ended with none is', async () => {
    const { run, viewer, w, secret } = await told()
    w.runs.look(run, viewer, false)
    w.runs.heard(B, secret, 'UserPromptSubmit')
    w.runs.heard(B, secret, 'Stop', 2)
    expect(run.state).toBe('finished')
    expect(run.background).toBe(2)
    w.later(60 * 60_000)
    expect(w.runs.rest()).toEqual([])
    w.later(24 * 60 * 60_000)
    expect(w.runs.rest()).toEqual([])
    /* A later turn that ends with none says so, and the clock runs as it always did. */
    w.runs.heard(B, secret, 'UserPromptSubmit')
    w.runs.heard(B, secret, 'Stop', 0)
    expect(run.background).toBe(0)
    w.later(31 * 60_000)
    expect(w.runs.rest()).toEqual([run])
  })

  test('a count is a number from this program’s own hook and nothing else: out of range or absent is none', async () => {
    const { run, w, secret } = await told()
    w.runs.heard(B, secret, 'Stop', 5)
    expect(run.background).toBe(5)
    w.runs.heard(B, secret, 'Stop', 100_000)
    expect(run.background).toBe(999)
    w.runs.heard(B, secret, 'Stop', -3)
    expect(run.background).toBe(0)
    w.runs.heard(B, secret, 'Stop', 4)
    w.runs.heard(B, secret, 'Stop')
    expect(run.background).toBe(0)
    /* Another event does not carry one, and leaves what was known alone. */
    w.runs.heard(B, secret, 'Stop', 3)
    w.runs.heard(B, secret, 'PostToolUse', 9)
    expect(run.background).toBe(3)
  })

  test('working, and nothing printed for two minutes: the turn ended without a word, and nothing is known again', async () => {
    const { run, hear, w } = await told()
    w.ptys[0]!.says('thinking\r\n')
    hear('UserPromptSubmit')
    w.later(119_000)
    w.runs.rest()
    expect(run.state).toBe('working')
    /* Still printing: still working, however long. */
    w.ptys[0]!.says('.')
    w.later(119_000)
    w.runs.rest()
    expect(run.state).toBe('working')
    w.later(2_000)
    w.runs.rest()
    expect(run.state).toBeNull()
    expect(w.logged.some((line) => line.includes('its state is no longer known'))).toBe(true)
    /* Only `working` is taken back this way: a question on screen is silent by nature. */
    hear('PermissionRequest')
    w.later(60 * 60_000)
    w.runs.rest()
    expect(run.state).toBe('needs-you')
  })
})

describe('telling a person who is not looking', () => {
  async function unwatched(place: NamedPlace = NAMED) {
    const dir = project()
    const w = world(TOLD)
    const viewer = new Watcher()
    const run = (await w.runs.open(ask(dir, null, place), viewer)) as Run
    await settle()
    w.records(dir, B, 'tighten the methods section')
    await w.runs.settle(run)
    const secret = secretOf(w.ptys[0]!)
    const feed = follower()
    w.runs.subscribe(feed.one)
    return { dir, w, viewer, run, feed, hear: (event: string) => w.runs.heard(B, secret, event) }
  }

  test('a session on nobody’s screen that finishes is noticed once, by name and by place', async () => {
    const { w, viewer, run, feed, hear, dir } = await unwatched()
    hear('UserPromptSubmit')
    w.runs.look(run, viewer, false)
    expect(feed.got).toEqual([])
    w.later(60_000)
    hear('Stop')
    expect(feed.got).toEqual([
      { seq: 1, session: B, state: 'finished', label: 'tighten the methods section', projectPath: dir, epic: 'thesis', parts: ['Methods', 'Results'], kehikko: 'writing', partIds: ['methods', 'results'], kehikkoKey: '4072c9e5', at: run.stateSince },
    ])
    /* Reported again, as a program that retries a hook would: not a change, and not said again. */
    hear('Stop')
    expect(feed.got.length).toBe(1)
  })

  test('one that stops to ask is the other kind', async () => {
    const { w, viewer, run, feed, hear } = await unwatched()
    w.runs.look(run, viewer, false)
    hear('UserPromptSubmit')
    hear('PermissionRequest')
    expect(feed.got.map((one) => one.state)).toEqual(['needs-you'])
  })

  test('never for the one on screen, and looking away afterwards does not raise it late', async () => {
    const { w, viewer, run, feed, hear } = await unwatched()
    hear('UserPromptSubmit')
    hear('PermissionRequest')
    hear('PostToolUse')
    hear('Stop')
    expect(feed.got).toEqual([])
    w.runs.look(run, viewer, false)
    w.later(60_000)
    w.runs.rest()
    expect(feed.got).toEqual([])
    /* A view mounted behind another is not somebody looking: with a second viewer that is, still nothing. */
    const second = new Watcher()
    w.runs.attach(run, second, 100, 30, 'attached')
    hear('UserPromptSubmit')
    hear('Stop')
    expect(feed.got).toEqual([])
  })

  test('working is not news', async () => {
    const { w, viewer, run, feed, hear } = await unwatched()
    w.runs.look(run, viewer, false)
    hear('UserPromptSubmit')
    hear('PostToolUse')
    expect(feed.got).toEqual([])
  })

  test('finishing and then stopping to ask a moment later are two things, and both are said', async () => {
    const { w, viewer, run, feed, hear } = await unwatched()
    w.runs.look(run, viewer, false)
    hear('UserPromptSubmit')
    hear('Stop')
    /* The prompt queued behind it starts at once, and asks. */
    w.later(3_000)
    hear('UserPromptSubmit')
    hear('PermissionRequest')
    expect(feed.got.map((one) => one.state)).toEqual(['finished', 'needs-you'])
  })

  test('a session that reports in a loop cannot fill a panel: four, then one every quarter of a minute', async () => {
    const { w, viewer, run, feed, hear } = await unwatched()
    w.runs.look(run, viewer, false)
    for (let n = 0; n < 200; n += 1) {
      hear('UserPromptSubmit')
      hear('Stop')
      w.later(10)
    }
    expect(feed.got.length).toBe(4)
    w.later(15_000)
    for (let n = 0; n < 50; n += 1) {
      hear('UserPromptSubmit')
      hear('Stop')
    }
    expect(feed.got.length).toBe(5)
    /* Left alone, it has its whole ration again, and no more than that. */
    w.later(60 * 60_000)
    for (let n = 0; n < 50; n += 1) {
      hear('UserPromptSubmit')
      hear('Stop')
    }
    expect(feed.got.length).toBe(9)
  })

  test('parts with no name are named by their ids, and a place with nothing picked names none', async () => {
    const { w, viewer, run, feed, hear } = await unwatched({ epic: 'thesis', parts: [], kehikko: { id: 3 }, kehikkoName: 'writing' })
    w.runs.look(run, viewer, false)
    hear('Stop')
    expect(feed.got[0]).toMatchObject({ epic: 'thesis', parts: [], kehikko: 'writing' })
    expect(readPlace({ epic: 'thesis', parts: ['b', 'a'], kehikko: { id: 3 }, partNames: { a: 'Alpha', zzz: 'not a part', b: 7 } })?.partNames).toEqual(['Alpha', ''])
    expect(readPlace({ epic: 'thesis', parts: ['a'], kehikko: { id: 3 }, partNames: ['Alpha'] })).not.toHaveProperty('partNames')
    expect(readPlace({ epic: 'thesis', parts: ['a'], kehikko: { id: 3 }, partNames: { a: 'x'.repeat(500) } })?.partNames?.[0]?.length).toBe(120)
  })

  test('exactly one page is handed a notice, and only one that can pass it on', async () => {
    const { w, viewer, run, feed, hear } = await unwatched()
    const unframed = follower(false)
    const later = follower()
    w.runs.subscribe(unframed.one)
    const stop = w.runs.subscribe(later.one)
    w.runs.look(run, viewer, false)
    hear('Stop')
    expect([feed.got.length, unframed.got.length, later.got.length]).toEqual([0, 0, 1])
    /* Every one of them is told the state. */
    expect([feed.states.at(-1)?.state, unframed.states.at(-1)?.state, later.states.at(-1)?.state]).toEqual(['finished', 'finished', 'finished'])
    stop()
    w.later(6_000)
    hear('UserPromptSubmit')
    hear('PermissionRequest')
    expect([feed.got.length, unframed.got.length, later.got.length]).toEqual([1, 0, 1])
  })

  test('with no page to take it, a notice waits — and is handed over only while it is still true', async () => {
    const dir = project()
    const w = world(TOLD)
    const viewer = new Watcher()
    const run = (await w.runs.open(ask(dir, null, NAMED), viewer)) as Run
    await settle()
    const secret = secretOf(w.ptys[0]!)
    w.runs.look(run, viewer, false)
    w.runs.heard(B, secret, 'Stop')
    /* A page nothing is framing cannot pass it on, and is not given it. */
    const unframed = follower(false)
    w.runs.subscribe(unframed.one)
    expect(unframed.got).toEqual([])
    expect(unframed.states).toEqual([{ session: B, state: 'finished', since: run.stateSince }])
    const framed = follower()
    w.runs.subscribe(framed.one)
    expect(framed.got.map((one) => [one.session, one.state])).toEqual([[B, 'finished']])
    /* Handed over once. */
    const again = follower()
    w.runs.subscribe(again.one)
    expect(again.got).toEqual([])

    /* One that is no longer true by the time somebody arrives is dropped: the person went and looked. */
    const fresh = world(TOLD)
    const other = new Watcher()
    const second = (await fresh.runs.open(ask(project(), null, NAMED), other)) as Run
    await settle()
    fresh.runs.look(second, other, false)
    fresh.runs.heard(B, secretOf(fresh.ptys[0]!), 'PermissionRequest')
    fresh.runs.look(second, other, true)
    const late = follower()
    fresh.runs.subscribe(late.one)
    expect(late.got).toEqual([])
  })
})

describe('a page that has just arrived', () => {
  test('is not told that the session it is about to show has finished: what was held waits a moment, and is checked again', async () => {
    const dir = project()
    const w = world({ ...TOLD, heldWait: 40 })
    const viewer = new Watcher()
    const run = (await w.runs.open(ask(dir, null, NAMED), viewer)) as Run
    await settle()
    w.runs.detach(run, viewer)
    w.runs.heard(B, secretOf(w.ptys[0]!), 'Stop')
    /* The page loads and begins following… */
    const page = follower()
    w.runs.subscribe(page.one)
    expect(page.got).toEqual([])
    /* …and a moment later has the session on screen. */
    w.runs.attach(run, new Watcher(), 100, 30, 'attached')
    await new Promise((done) => setTimeout(done, 80))
    expect(page.got).toEqual([])

    /* One that is still on nobody's screen when the moment is up is said. */
    const other = world({ ...TOLD, heldWait: 40 })
    const second = new Watcher()
    const away = (await other.runs.open(ask(project(), null, NAMED), second)) as Run
    await settle()
    other.runs.detach(away, second)
    other.runs.heard(B, secretOf(other.ptys[0]!), 'Stop')
    const late = follower()
    const stop = other.runs.subscribe(late.one)
    await new Promise((done) => setTimeout(done, 80))
    expect(late.got.map((one) => one.state)).toEqual(['finished'])
    stop()
  })
})

describe('putting away only what is finished', () => {
  const QUIET = 30 * 60_000
  async function left(event: string | null) {
    const dir = project()
    const w = world({ ...TOLD, stale: 365 * 24 * 60 * 60_000 })
    const viewer = new Watcher()
    const run = (await w.runs.open(ask(dir, null), viewer)) as Run
    await settle()
    w.runs.type(run, 'do the thing\r')
    const secret = secretOf(w.ptys[0]!)
    if (event) w.runs.heard(B, secret, event)
    w.runs.look(run, viewer, false)
    return { w, run, viewer, pty: w.ptys[0]!, hear: (said: string) => w.runs.heard(B, secret, said) }
  }

  test('a working session is never put away, however quiet and however long', async () => {
    const { w, pty } = await left('UserPromptSubmit')
    w.later(24 * 60 * 60_000)
    expect(w.runs.rest()).toEqual([])
    expect(pty.killed).toBe(false)
  })

  test('neither is one waiting for an answer: the question exists nowhere else', async () => {
    const { w, pty } = await left('PermissionRequest')
    w.later(24 * 60 * 60_000)
    expect(w.runs.rest()).toEqual([])
    expect(pty.killed).toBe(false)
  })

  test('a finished one is, once it has been finished and left alone for the whole time', async () => {
    const { w, run, pty, viewer } = await left('Stop')
    w.later(QUIET - 1)
    expect(w.runs.rest()).toEqual([])
    w.later(1)
    expect(w.runs.rest()).toEqual([run])
    expect(pty.killed).toBe(true)
    await settle()
    expect(viewer.closed?.code).toBe(CLOSED.rested)
    expect(w.logged.some((line) => line.includes('had been finished for 30 min'))).toBe(true)
  })

  test('counted from when it finished, not from when it was left', async () => {
    const { w, hear } = await left('UserPromptSubmit')
    w.later(QUIET * 2)
    hear('Stop')
    expect(w.runs.rest()).toEqual([])
    w.later(QUIET - 1)
    expect(w.runs.rest()).toEqual([])
    w.later(1)
    expect(w.runs.rest().length).toBe(1)
  })

  test('what a finished session prints at its prompt does not start the clock again; somebody looking does', async () => {
    const { w, run, viewer, pty } = await left('Stop')
    w.later(QUIET - 60_000)
    pty.says('\x07')
    w.later(60_000)
    expect(w.runs.rest().length).toBe(1)

    const again = await left('Stop')
    again.w.later(QUIET - 60_000)
    again.w.runs.look(again.run, again.viewer, true)
    again.w.later(QUIET)
    /* On screen: not put away at all. */
    expect(again.w.runs.rest()).toEqual([])
    again.w.runs.look(again.run, again.viewer, false)
    again.w.later(QUIET - 1)
    expect(again.w.runs.rest()).toEqual([])
    again.w.later(1)
    expect(again.w.runs.rest().length).toBe(1)
    void run
    void viewer
  })

  test('one that has said nothing falls under the rule there was before: silence for the whole time', async () => {
    const { w, pty } = await left(null)
    w.later(QUIET - 60_000)
    pty.says('.')
    w.later(60_000)
    expect(w.runs.rest()).toEqual([])
    w.later(QUIET)
    expect(w.runs.rest().length).toBe(1)
    expect(w.logged.some((line) => line.includes('had printed nothing for 31 min'))).toBe(true)
  })

  test('a copy too old to say anything is under that rule too', async () => {
    const dir = project()
    const w = world({ tells: false, port: TELL_PORT })
    const viewer = new Watcher()
    const run = (await w.runs.open(ask(dir, null), viewer)) as Run
    await settle()
    w.runs.type(run, 'x')
    w.runs.look(run, viewer, false)
    w.later(QUIET)
    expect(w.runs.rest()).toEqual([run])
  })

  test('a working session whose turn ended without a word goes back under the silence rule, and no sooner', async () => {
    const dir = project()
    const w = world(TOLD)
    const viewer = new Watcher()
    const run = (await w.runs.open(ask(dir, null), viewer)) as Run
    await settle()
    w.runs.type(run, 'do the thing\r')
    w.runs.heard(B, secretOf(w.ptys[0]!), 'UserPromptSubmit')
    w.runs.look(run, viewer, false)
    w.later(10 * 60_000)
    expect(w.runs.rest()).toEqual([])
    expect(run.state).toBeNull()
    w.later(20 * 60_000)
    expect(w.runs.rest()).toEqual([run])
  })
})

/* ------------------------------------------------------------------ *
 * A conversation that is already running somewhere this module did not start it (#5)
 * ------------------------------------------------------------------ */

describe('a session that is already running somewhere else', () => {
  const since = 900_000
  const background = (session = A): Active => ({ session, kind: 'background', called: 'background', handle: session.slice(0, 8), pid: 4242, cwd: '/somewhere/project', startedAt: since, name: 'stand-in' })
  const interactive = (session = A): Active => ({ session, kind: 'interactive', called: 'interactive', handle: null, pid: 5151, cwd: '/somewhere/project', startedAt: since, name: 'project-ea' })

  test('the program is asked before every resume, and the answer is never kept: what starts or stops between two opens is seen', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A, 'an earlier conversation')
    /* Nothing else has it: resumed, exactly as before. */
    const first = new Watcher()
    await w.runs.open(ask(dir, A), first)
    expect(w.asked.count).toBe(1)
    expect(w.ptys[0]!.args).toEqual(['--resume', A])
    expect(first.said[0]).toMatchObject({ opened: 'resumed' })
    w.ptys[0]!.ends(0)
    await settle()

    /* It was started in the background since. The second open asks again, and attaches. */
    w.elsewhere.push(background())
    await w.runs.open(ask(dir, A), new Watcher())
    expect(w.asked.count).toBeGreaterThanOrEqual(2)
    expect(w.ptys[1]!.args).toEqual(['attach', '11111111'])
    w.ptys[1]!.ends(0)
    await settle()

    /* And stopped since. The third asks again, and resumes. */
    const before = w.asked.count
    w.elsewhere.length = 0
    await w.runs.open(ask(dir, A), new Watcher())
    expect(w.asked.count).toBeGreaterThan(before)
    expect(w.ptys[2]!.args).toEqual(['--resume', A])
  })

  test('a new session is not asked about: nothing else can have an id minted a moment ago', async () => {
    const w = world()
    await w.runs.open(ask(project(), null), new Watcher())
    expect(w.asked.count).toBe(0)
    expect(w.ptys[0]!.args).toEqual(['--session-id', B])
  })

  test('one running in the background is attached to: `attach` by the handle the program gave, one process, and no hooks of this module’s', async () => {
    const dir = project()
    const w = world({ tells: true, port: 9590 })
    w.records(dir, A, 'started as a background job')
    w.elsewhere.push(background())
    const viewer = new Watcher()
    const run = (await w.runs.open(ask(dir, A), viewer)) as Run
    expect(isRun(run)).toBe(true)
    /* One pty, and what is in it is a view: not `--resume`, and not the full session id, which `attach` refuses. */
    expect(w.ptys.length).toBe(1)
    expect(w.ptys[0]!.args).toEqual(['attach', '11111111'])
    expect(w.ptys[0]!.args.join(' ')).not.toMatch(/--resume|--settings|--session-id/)
    /* The process that holds the session was started elsewhere: nothing of this module's is put in its environment. */
    expect(w.ptys[0]!.options.env[TELL_ENV.secret]).toBeUndefined()
    expect(run.secret).toBeNull()
    expect(viewer.said[0]).toMatchObject({ opened: 'background', session: A, background: { kind: 'background', pid: 4242, cwd: '/somewhere/project', since } })
    /* It is this place's session all the same. */
    expect(listed(dir)).toEqual([A])
    expect(w.logged.some((line) => line.includes('attached to it, and no second process was started'))).toBe(true)

    /* A second viewer is put on the same run: still one process. */
    const second = new Watcher()
    await w.runs.open(ask(dir, A), second)
    expect(w.ptys.length).toBe(1)
    expect(second.said[0]).toMatchObject({ opened: 'attached', background: { pid: 4242 } })
  })

  test('closing the view of a background session ends the view and nothing else, and says which of the two ended', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A)
    w.elsewhere.push(background())
    const viewer = new Watcher()
    await w.runs.open(ask(dir, A), viewer)
    await settle()
    /* A person pressed Close on its row. What is hung up is this module's own pty — the only thing it has. */
    expect(w.runs.end(A)).toBe(true)
    await settle()
    expect(w.ptys[0]!.killed).toBe(true)
    expect(viewer.closed).toEqual({ code: CLOSED.ended, reason: 'this view closed; the session is still running in the background' })
    /* The program still lists it: this module stopped nothing. */
    expect(w.elsewhere.length).toBe(1)

    /* When the session itself has gone, that is what is said. */
    const later = new Watcher()
    await w.runs.open(ask(dir, A), later)
    await settle()
    w.elsewhere.length = 0
    w.ptys[1]!.ends(0)
    await settle()
    expect(later.closed).toEqual({ code: CLOSED.ended, reason: 'the background session ended (0)' })
  })

  test('one open in another terminal is not resumed: nothing is started, and the page is told where it is running and since when', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A, 'left open in a terminal')
    w.elsewhere.push(interactive())
    const viewer = new Watcher()
    const refused = await w.runs.open(ask(dir, A), viewer)
    expect(refused).toMatchObject({ code: CLOSED.elsewhere })
    expect(w.ptys.length).toBe(0)
    expect(w.runs.sessions()).toEqual([])
    expect(viewer.said).toEqual([{ elsewhere: { kind: 'interactive', called: 'interactive', pid: 5151, cwd: '/somewhere/project', since, name: 'project-ea' }, session: A }])
    /* Not attached to the place by an open that opened nothing. */
    expect(listed(dir)).toEqual([])
    /* Asked again, it is asked about again: never silently. */
    expect(await w.runs.open(ask(dir, A), new Watcher())).toMatchObject({ code: CLOSED.elsewhere })
    expect(w.ptys.length).toBe(0)
  })

  test('a copy is started only when a person said so, and the run says what it is a copy of for as long as it is on screen', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A)
    w.elsewhere.push(interactive())
    const viewer = new Watcher()
    const run = (await w.runs.open({ ...ask(dir, A), copy: true }, viewer)) as Run
    expect(isRun(run)).toBe(true)
    expect(w.ptys[0]!.args).toEqual(['--resume', A])
    expect(viewer.said[0]).toMatchObject({ opened: 'copy', copyOf: { kind: 'interactive', pid: 5151 } })
    expect(w.logged.some((line) => line.includes('a person chose to open a copy here'))).toBe(true)
    /* A viewer that arrives later is told the same. */
    const second = new Watcher()
    await w.runs.open(ask(dir, A), second)
    expect(second.said[0]).toMatchObject({ opened: 'attached', copyOf: { pid: 5151 } })
    expect(w.ptys.length).toBe(1)
  })

  test('the word for a copy is a word: it rides the opening frame as `copy: true` and nothing else, and never without a session', () => {
    const frame = (more: Record<string, unknown>) => JSON.stringify({ ticket: 'T', projectPath: '/p', place: HERE, session: A, cols: 100, rows: 30, ...more })
    expect(opening(frame({ copy: true }), 'T')).toMatchObject({ session: A, copy: true })
    for (const not of ['yes', 1, 'true', { force: true }, ['--fork-session']]) expect(opening(frame({ copy: not }), 'T')).not.toHaveProperty('copy')
    expect(opening(frame({ copy: true, session: null }), 'T')).not.toHaveProperty('copy')
  })

  test('with both a background session and another process on it, the background one is attached to — that starts nothing', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A)
    w.elsewhere.push(interactive(), background())
    await w.runs.open(ask(dir, A), new Watcher())
    expect(w.ptys[0]!.args).toEqual(['attach', '11111111'])
  })

  test('another conversation running elsewhere is nothing to this one', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A)
    w.elsewhere.push(interactive(B), background('33333333-3333-4333-8333-333333333333'))
    await w.runs.open(ask(dir, A), new Watcher())
    expect(w.ptys[0]!.args).toEqual(['--resume', A])
  })

  test('nothing here stops or signals the other process: the only thing ever started or ended is this module’s own pty', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A)
    w.elsewhere.push(background(), interactive())
    const killed: number[] = []
    const real = process.kill
    process.kill = ((pid: number) => {
      killed.push(pid)
      return true
    }) as typeof process.kill
    try {
      await w.runs.open(ask(dir, A), new Watcher())
      await settle()
      w.runs.end(A)
      w.runs.endAll()
      await settle()
    } finally {
      process.kill = real
    }
    /* A stand-in pty has no pid to signal, and neither of the other processes' pids was ever given to `kill`. */
    expect(killed.filter((pid) => Math.abs(pid) === 4242 || Math.abs(pid) === 5151)).toEqual([])
    for (const pty of w.ptys) expect(pty.args.join(' ')).not.toMatch(/\b(stop|kill|rm|respawn)\b|--bg/)
  })

  test('a copy too old to be asked is told apart from "nothing is running": resumed as before, and it is said — on the terminal’s first line, to the page and in the log', async () => {
    const dir = project()
    const w = world({ lists: false })
    w.records(dir, A)
    /* Even with something running elsewhere, an old copy cannot say so. */
    w.elsewhere.push(interactive())
    const viewer = new Watcher()
    const run = (await w.runs.open(ask(dir, A), viewer)) as Run
    await settle()
    expect(w.asked.count).toBe(0)
    expect(w.ptys[0]!.args).toEqual(['--resume', A])
    expect(run.unchecked).toBe('too-old')
    expect(viewer.said[0]).toMatchObject({ opened: 'resumed', unchecked: 'too-old' })
    expect(viewer.out).toContain('too old to say whether a conversation is already running somewhere else')
    expect(viewer.out).toContain('resumed without checking')
    expect(w.logged.some((line) => line.includes('resumed without asking whether it is running elsewhere'))).toBe(true)
    expect(await w.runs.running('/fake/bin/claude')).toEqual({ known: false, why: 'too-old' })
  })

  test('a copy that has the commands and could not be asked is the same: resumed, and said to be unchecked', async () => {
    const dir = project()
    const w = world({ asking: 'fails' })
    w.records(dir, A)
    const viewer = new Watcher()
    await w.runs.open(ask(dir, A), viewer)
    await settle()
    expect(w.ptys[0]!.args).toEqual(['--resume', A])
    expect(viewer.said[0]).toMatchObject({ opened: 'resumed', unchecked: 'failed' })
    expect(viewer.out).toContain('could not be asked whether this conversation is already running somewhere else')
  })

  test('a session that WAS asked about says nothing of the kind', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A)
    const viewer = new Watcher()
    await w.runs.open(ask(dir, A), viewer)
    await settle()
    expect(viewer.said[0]).not.toHaveProperty('unchecked')
    expect(viewer.out).not.toContain('without checking')
  })

  test('this module’s own process, as the program lists it, is not "somewhere else"', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A)
    await w.runs.open(ask(dir, A), new Watcher())
    w.ptys[0]!.pid = 7777
    const mine: Active = { ...interactive(), pid: 7777 }
    expect(w.runs.others({ known: true, active: [mine] }, A)).toEqual({ background: null, open: null })
    expect(w.runs.others({ known: true, active: [mine, interactive()] }, A).open?.pid).toBe(5151)
    expect(w.runs.others({ known: false, why: 'too-old' }, A)).toEqual({ background: null, open: null })
  })
})
