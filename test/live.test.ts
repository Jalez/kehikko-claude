import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLOSED, Runs, fenced, headless, opening, readPlace, sayable, type Opening, type Pty, type Run, type Viewer } from '../live.ts'
import { placeKey } from '../place.ts'
import { PROGRAM, type Program, type Recorded } from '../program.ts'
import { readPlaces, sessionsAt } from '../record.ts'

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
const HERE = { epic: 'thesis', parts: ['methods'], kehikko: 3, kehikkoName: 'writing' }

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
    expect(typeof opening(frame({ place: { epic: 'Thesis', parts: [], kehikko: 3 } }), 'T')).toBe('string')
    expect(typeof opening(frame({ place: { epic: 'thesis', parts: ['a;b'], kehikko: 3 } }), 'T')).toBe('string')
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
    expect(readPlace({ epic: 'thesis', parts: ['results', 'methods', 'results'], kehikko: 3 })?.parts).toEqual(['methods', 'results'])
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

function world(options: { most?: number; found?: string | null; able?: boolean; line?: string } = {}) {
  const ptys: FakePty[] = []
  /* What the stand-in program holds a record for, by folder. */
  const held = new Map<string, Recorded[]>()
  let clock = 1_000_000
  let found: string | null = options.found === undefined ? '/fake/bin/claude' : options.found
  const program: Program = {
    ...PROGRAM,
    find: () => ({ file: found, looked: ['/fake/bin'] }),
    supports: async () => ({ ok: options.able ?? true, missing: options.able === false ? '--session-id' : null }),
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
    most: options.most ?? 6,
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

const ask = (projectPath: string, session: string | null, place = HERE): Extract<Opening, { what: 'session' }> => ({ what: 'session', projectPath, place, session, cols: 100, rows: 30 })
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

  test('one the program holds a record for is resumed; one it does not is started under the same id', async () => {
    const dir = project()
    const w = world()
    w.records(dir, A, 'an earlier conversation')
    const viewer = new Watcher()
    await w.runs.open(ask(dir, A), viewer)
    expect(w.ptys[0]!.args).toEqual(['--resume', A])
    expect(viewer.said[0]).toMatchObject({ opened: 'resumed', session: A })
    /* Opening it here is what attaches it here: it is on this place's list now. */
    expect(listed(dir)).toEqual([A])

    /* Recorded for a place, and the program's own record has since gone: the same id, started fresh. */
    const other = project()
    const w2 = world()
    w2.records(other, A)
    await w2.runs.open(ask(other, A), new Watcher())
    w2.ptys[0]!.ends(0)
    await settle()
    const w3 = world()
    await w3.runs.open(ask(other, A), new Watcher())
    expect(w3.ptys[0]!.args).toEqual(['--session-id', A])
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
    await w.runs.open(ask(dir, A, { epic: 'thesis', parts: [], kehikko: 3, kehikkoName: 'writing' }), two)
    await settle()
    w.ptys[0]!.says('to both\r\n')
    await settle()
    expect(one.out).toContain('to both')
    expect(two.out).toContain('to both')
    expect(w.ptys.length).toBe(1)
    /* Attaching is recorded for the second place too. */
    expect(listed(dir, { epic: 'thesis', parts: [], kehikko: 3, kehikkoName: 'writing' })).toEqual([A])
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

describe('the bound on how many run at once', () => {
  test('at the bound an open is refused and nothing is ended to make room', async () => {
    const dir = project()
    const w = world({ most: 2 })
    await w.runs.open(ask(dir, null), new Watcher())
    await w.runs.open(ask(dir, null, { ...HERE, parts: [] }), new Watcher())
    const refused = await w.runs.open(ask(dir, null, { ...HERE, parts: ['results'] }), new Watcher())
    expect(refused).toMatchObject({ code: CLOSED.full })
    expect(w.ptys.length).toBe(2)
    expect(w.ptys.every((pty) => !pty.killed)).toBe(true)
    expect(w.runs.sessions().length).toBe(2)
  })

  test('coming back to one that is running is never refused for room', async () => {
    const dir = project()
    const w = world({ most: 1 })
    await w.runs.open(ask(dir, null), new Watcher())
    expect(isRun(await w.runs.open(ask(dir, B), new Watcher()))).toBe(true)
  })

  test('the person ends the one they choose, and then there is room', async () => {
    const dir = project()
    const w = world({ most: 1 })
    const viewer = new Watcher()
    await w.runs.open(ask(dir, null), viewer)
    await settle()
    expect(w.runs.end('99999999-9999-4999-8999-999999999999')).toBe(false)
    expect(w.runs.end(B)).toBe(true)
    await settle()
    expect(w.ptys[0]!.killed).toBe(true)
    expect(viewer.closed?.code).toBe(CLOSED.ended)
    expect(isRun(await w.runs.open(ask(dir, null, { ...HERE, parts: [] }), new Watcher()))).toBe(true)
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
    /* It is not a session: it does not count against the bound, and nothing is recorded. */
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
