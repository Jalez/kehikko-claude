import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { answer } from '../doors.ts'
import { RESUME_LINE, Runs, TICKET, headless, type Pty, type Run, type Viewer } from '../live.ts'
import { PROGRAM, recordDirs, type Active, type Backgrounded, type Program, type Recorded } from '../program.ts'
import { born, readPlaces, readSettings, writeSettings, type NamedPlace } from '../record.ts'
import { skillDeclarations } from '../skills.ts'
import { placeKey } from '../place.ts'
import { resumeToggle, statusLineToggle } from '../src/view/conversations.ts'
import { SHELL_CUT, AGENT_CUT, FAILED, asked as said, notified, turnEnded, typed } from './transcripts.ts'

/**
 * Conversations that outlive this module, and what a restart cut off anyway.
 *
 * The program is a stand-in, as in live.test.ts, with the background added: `--bg` "starts" a
 * session the stand-in then lists as running in the background, `stop` and `rm` are counted. The
 * transcripts are fixtures in the scratch Claude Code folder (test/setup.ts), in the shapes
 * cutoff.test.ts copies from real ones.
 */

/* Ids of this file's own: the scratch Claude Code folder is shared with the other tests, and a
   transcript is found by its id in any project's folder. */
let A = randomUUID()
let C = randomUUID()
beforeEach(() => {
  A = randomUUID()
  C = randomUUID()
})
const HERE: NamedPlace = { epic: 'thesis', parts: ['methods'], kehikko: { key: '4072c9e5' }, kehikkoName: 'writing' }

const made: string[] = []
const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-claude-restart-')))
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

class FakePty implements Pty {
  pid = 0
  killed = false
  private exited: (exit: { exitCode: number }) => void = () => {}
  constructor(readonly file: string, readonly args: string[]) {}
  onData() {}
  onExit(heard: (exit: { exitCode: number }) => void) {
    this.exited = heard
  }
  write() {}
  resize() {}
  kill() {
    if (this.killed) return
    this.killed = true
    this.exited({ exitCode: 129 })
  }
}

class Watcher implements Viewer {
  said: Record<string, unknown>[] = []
  closed: { code: number; reason: string } | null = null
  output() {}
  say(message: Record<string, unknown>) {
    this.said.push(message)
  }
  close(code: number, reason: string) {
    this.closed = { code, reason }
  }
}

const settle = () => new Promise((done) => setTimeout(done, 25))

/** The program's machine: what runs in the background survives every `Runs` (a module process) made over it. */
function machine() {
  const background = new Map<string, Active>()
  const held = new Map<string, Recorded[]>()
  const calls = { bg: [] as string[][], stop: [] as string[], rm: [] as string[] }
  const refuse = { now: '' }
  let minted = 0
  return {
    background,
    held,
    calls,
    refuse,
    records: (projectPath: string, id: string) => held.set(projectPath, [...(held.get(projectPath) ?? []).filter((one) => one.id !== id), { id, label: '', lastActive: Date.now(), next: [] }]),
    /** One process of this module: its own runs, the same machine under it. */
    module(options: { backgrounds?: boolean; grace?: number; plugins?: boolean; configBase?: string; tells?: boolean } = {}) {
      const ptys: FakePty[] = []
      const logged: string[] = []
      const program: Program = {
        ...PROGRAM,
        find: () => ({ file: '/fake/bin/claude', looked: [], usual: [] }),
        supports: async () => ({ ok: true, missing: null, tells: options.tells ?? false, lists: true, names: false, configures: options.plugins ?? false, plugins: options.plugins ?? false, backgrounds: options.backgrounds ?? true }),
        active: async () => ({ known: true, active: [...background.values()] }),
        settled: async (projectPath, id) => (held.get(projectPath)?.some((one) => one.id === id) ? id : null),
        sessions: async (projectPath) => held.get(projectPath) ?? [],
        environment: () => ({ PATH: '/bin' }),
        background: async (_file, args, cwd): Promise<Backgrounded> => {
          calls.bg.push(args)
          if (refuse.now) return { ok: false, why: refuse.now }
          const resume = args[0] === '--resume' ? args[1]! : null
          minted += 1
          const session = resume ?? `${String(minted).padStart(8, '0')}-0000-4000-8000-000000000000`
          const one: Active = { session, kind: 'background', called: 'background', handle: session.slice(0, 8), pid: 9000 + minted, cwd, startedAt: Date.now(), name: '', state: null }
          background.set(session, one)
          return { ok: true, handle: one.handle!, active: one }
        },
        stop: async (_file, handle) => {
          calls.stop.push(handle)
          for (const [id, one] of background) if (one.handle === handle) background.delete(id)
          return true
        },
        remove: async (_file, handle) => {
          calls.rm.push(handle)
          for (const [id, one] of background) if (one.handle === handle) background.delete(id)
          return true
        },
      }
      const runs = new Runs({
        program,
        grace: options.grace ?? 60_000,
        heldWait: 0,
        every: null,
        watchEvery: null,
        log: (line) => logged.push(line),
        ...(options.configBase ? { configBase: options.configBase, doors: async () => [], place: async () => null } : {}),
        screen: headless,
        spawn: (file, args) => {
          const pty = new FakePty(file, args)
          ptys.push(pty)
          return pty
        },
      })
      return { runs, ptys, logged }
    },
  }
}

const open = (projectPath: string, session: string | null) => ({ what: 'session' as const, projectPath, place: HERE, session, cols: 100, rows: 30 })
const isRun = (opened: unknown): opened is Run => typeof opened === 'object' && opened !== null && 'pty' in opened
const entryOf = (dir: string, id: string) => {
  const read = readPlaces(dir)
  if (!read.ok) throw new Error(read.error)
  return read.value.sessions[id]
}

/** A transcript, where Claude Code keeps the one of session `id` for this project. */
function transcript(dir: string, id: string, rows: string[]): string {
  const folder = recordDirs(dir)[0]!
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `${id}.jsonl`)
  writeFileSync(file, `${rows.join('\n')}\n`)
  return file
}

describe('a conversation runs in the background, and the terminal is a view of it', () => {
  test('a new one is started with --bg and attached to; it is this module’s own, not "running elsewhere"', async () => {
    const m = machine()
    const dir = project()
    const one = m.module()
    const viewer = new Watcher()
    const run = await one.runs.open(open(dir, null), viewer)
    expect(isRun(run)).toBe(true)
    expect(m.calls.bg).toEqual([[]])
    expect(one.ptys[0]!.args).toEqual(['attach', '00000001'])
    expect(viewer.said[0]).toMatchObject({ opened: 'new', session: '00000001-0000-4000-8000-000000000000' })
    expect(viewer.said[0]).not.toHaveProperty('background')
    expect((run as Run).owned).toBe(true)
  })

  test('the module stopping ends only the views: the conversation runs on, and the next start attaches to it again', async () => {
    const m = machine()
    const dir = project()
    m.records(dir, A)
    born(dir, HERE, A, null)
    const first = m.module()
    await first.runs.open(open(dir, A), new Watcher())
    /* A recorded conversation not yet run in the background is given its options. */
    expect(m.calls.bg).toEqual([['--resume', A]])
    expect(entryOf(dir, A)?.background).toBe(true)

    first.runs.endAll()
    await settle()
    expect(first.ptys[0]!.killed).toBe(true)
    expect(m.calls.stop).toEqual([])
    expect(m.background.has(A)).toBe(true)

    /* The module again, as after an update: the page opens the conversation, and it is attached to. */
    const second = m.module()
    const viewer = new Watcher()
    const run = await second.runs.open(open(dir, A), viewer)
    expect(m.calls.bg.length).toBe(1)
    expect(second.ptys[0]!.args).toEqual(['attach', A.slice(0, 8)])
    expect((run as Run).owned).toBe(true)
    expect(viewer.said[0]).toMatchObject({ opened: 'resumed', session: A })
    expect(viewer.said[0]).not.toHaveProperty('background')
  })

  test('one this module ran in the background before is woken with no flags: its saved options are its own', async () => {
    const m = machine()
    const dir = project()
    m.records(dir, A)
    born(dir, HERE, A, null)
    const first = m.module()
    await first.runs.open(open(dir, A), new Watcher())
    /* Stopped (by the person, or the computer restarting), then opened again. */
    m.background.clear()
    first.runs.endAll()
    const second = m.module()
    await second.runs.open(open(dir, A), new Watcher())
    expect(m.calls.bg).toEqual([['--resume', A], ['--resume', A]])
  })

  test('a folder not trusted yet, or a copy without --bg: opened in the terminal, as before', async () => {
    const m = machine()
    const dir = project()
    m.refuse.now = 'Workspace not trusted.'
    const one = m.module()
    await one.runs.open(open(dir, null), new Watcher())
    expect(one.ptys[0]!.args[0]).toBe('--session-id')
    expect(one.logged.some((line) => line.includes('Workspace not trusted'))).toBe(true)

    const old = machine()
    const two = old.module({ backgrounds: false })
    await two.runs.open(open(project(), null), new Watcher())
    expect(old.calls.bg).toEqual([])
    expect(two.ptys[0]!.args[0]).toBe('--session-id')
  })

  test('a person’s End stops it; one nobody ever typed into goes with its view', async () => {
    const m = machine()
    const dir = project()
    m.records(dir, A)
    born(dir, HERE, A, null)
    const one = m.module({ grace: 1 })
    await one.runs.open(open(dir, A), new Watcher())
    expect(one.runs.end(A)).toBe(true)
    await settle()
    expect(m.calls.stop).toEqual([A.slice(0, 8)])

    const viewer = new Watcher()
    const run = (await one.runs.open(open(dir, null), viewer)) as Run
    one.runs.detach(run, viewer)
    await new Promise((done) => setTimeout(done, 80))
    expect(m.calls.rm).toEqual(['00000002'])
  })
})

describe('a conversation a restart cut off mid-turn', () => {
  test('is woken in the background, told once, and said in the Inbox once', async () => {
    const m = machine()
    const dir = project()
    m.records(dir, A)
    born(dir, HERE, A, null, { label: 'tighten the methods' })
    /* Seen working by the module, and then the module (and the session with it) went away. */
    const first = m.module()
    await first.runs.open(open(dir, A), new Watcher())
    m.background.get(A)!.state = 'working'
    await first.runs.watch()
    expect(entryOf(dir, A)?.working).toBeString()
    m.background.clear()

    const second = m.module()
    second.runs.know(dir)
    await second.runs.recovered(dir)
    expect(m.calls.bg.at(-1)).toEqual(['--resume', A, RESUME_LINE])
    expect(entryOf(dir, A)?.working).toBeUndefined()
    expect(entryOf(dir, A)?.resumed?.at).toBeString()
    const row = second.runs.activity(dir).find((one) => one.id === `resumed:${A}`)
    expect(row).toMatchObject({ state: 'done', label: 'tighten the methods: resumed after Kehikot restarted', place: { epic: 'thesis', parts: ['methods'], kehikko: '4072c9e5' } })

    /* Once per interruption: the next start does not wake it again. */
    m.background.clear()
    const third = m.module()
    third.runs.know(dir)
    await third.runs.recovered(dir)
    expect(m.calls.bg.filter((args) => args.includes(RESUME_LINE)).length).toBe(1)

    /* The person has it on screen: the line goes. */
    await third.runs.open(open(dir, A), new Watcher())
    expect(third.runs.activity(dir).some((one) => one.id === `resumed:${A}`)).toBe(false)
  })

  test('not when the person turned the setting off: the mark goes, nothing is woken', async () => {
    const m = machine()
    const dir = project()
    m.records(dir, A)
    born(dir, HERE, A, null)
    const first = m.module()
    await first.runs.open(open(dir, A), new Watcher())
    m.background.get(A)!.state = 'working'
    await first.runs.watch()
    m.background.clear()
    writeSettings(dir, { resumeCutOff: false })
    const second = m.module()
    second.runs.know(dir)
    await second.runs.recovered(dir)
    expect(m.calls.bg.length).toBe(1)
    expect(entryOf(dir, A)?.working).toBeUndefined()
  })

  test('never one the person ended', async () => {
    const m = machine()
    const dir = project()
    m.records(dir, A)
    born(dir, HERE, A, null)
    const first = m.module()
    await first.runs.open(open(dir, A), new Watcher())
    m.background.get(A)!.state = 'working'
    await first.runs.watch()
    first.runs.end(A)
    await settle()
    const second = m.module()
    second.runs.know(dir)
    await second.runs.recovered(dir)
    expect(m.calls.bg.length).toBe(1)
  })

  test('one recorded before this release is judged by its transcript: a turn under way is woken, an ended one is not', async () => {
    const m = machine()
    const dir = project()
    m.records(dir, A)
    m.records(dir, C)
    born(dir, HERE, A, null)
    born(dir, HERE, C, null)
    const now = Date.now()
    transcript(dir, A, [typed(now - 60_000), said(now - 50_000, 'tool_use')])
    transcript(dir, C, [typed(now - 60_000), said(now - 50_000, 'end_turn'), turnEnded(now - 49_000)])
    const one = m.module()
    one.runs.know(dir)
    await one.runs.recovered(dir)
    expect(m.calls.bg).toEqual([['--resume', A, RESUME_LINE]])
  })
})

describe('background work cut off or failed: a "needs you" line in the Inbox', () => {
  const setUp = (rows: string[]) => {
    const m = machine()
    const dir = project()
    m.records(dir, A)
    born(dir, HERE, A, null, { label: 'tighten the methods' })
    const file = transcript(dir, A, rows)
    return { m, dir, file }
  }
  const now = Date.now()

  test('read on start, so what happened while the module was down is said: label, detail and place', async () => {
    const { m, dir } = setUp([typed(now - 120_000), notified(now - 60_000, 'stopped', SHELL_CUT), notified(now - 59_000, 'stopped', AGENT_CUT.replace(/"/g, '&quot;'))])
    const one = m.module()
    one.runs.know(dir)
    await one.runs.recovered(dir)
    const row = one.runs.activity(dir).find((item) => item.id === `cut-off:${A}`)
    expect(row).toMatchObject({
      state: 'attention',
      label: "tighten the methods: 2 background tasks didn't finish before the session ended",
      place: { epic: 'thesis', parts: ['methods'], kehikko: '4072c9e5' },
      since: Date.parse(new Date(now - 59_000).toISOString()),
      project: dir,
    })
    expect(row!.detail).toContain(SHELL_CUT)
    expect(row!.detail).toContain('Background agent "Claude: Inbox alert for interrupted work"')
    /* Attention is first in the list. */
    expect(one.runs.activity(dir)[0]!.id).toBe(`cut-off:${A}`)
  })

  test('a failed command (exit 1) is said; a success is not', async () => {
    const { m, dir } = setUp([notified(now - 60_000, 'completed', 'Background command "x" completed (exit code 0)'), notified(now - 50_000, 'failed', FAILED.replace(/"/g, '&quot;'))])
    const one = m.module()
    one.runs.know(dir)
    await one.runs.recovered(dir)
    const row = one.runs.activity(dir).find((item) => item.id === `cut-off:${A}`)
    expect(row?.label).toBe('tighten the methods: 1 background task failed')
    expect(row?.detail).toBe(FAILED)
  })

  test('only successes: nothing is said', async () => {
    const { m, dir } = setUp([notified(now - 60_000, 'completed', 'Agent "x" finished')])
    const one = m.module()
    one.runs.know(dir)
    await one.runs.recovered(dir)
    expect(one.runs.activity(dir).some((item) => item.id.startsWith('cut-off:'))).toBe(false)
  })

  test('each is said once: read again, or by the next start, it is the same line, not another', async () => {
    const { m, dir, file } = setUp([notified(now - 60_000, 'stopped', SHELL_CUT)])
    const one = m.module()
    one.runs.know(dir)
    await one.runs.recovered(dir)
    const first = one.runs.activity(dir).find((item) => item.id === `cut-off:${A}`)!
    appendFileSync(file, `${said(now - 1000, 'end_turn')}\n`)
    await one.runs.readCutOffs(dir, true)
    const again = m.module()
    again.runs.know(dir)
    await again.runs.recovered(dir)
    const second = again.runs.activity(dir).find((item) => item.id === `cut-off:${A}`)!
    expect(second).toEqual(first)
    expect(entryOf(dir, A)?.cutOff?.open.length).toBe(1)
  })

  test('it goes when the person moves the conversation on, and only a NEW one brings it back', async () => {
    const { m, dir, file } = setUp([notified(now - 60_000, 'stopped', SHELL_CUT)])
    const one = m.module()
    one.runs.know(dir)
    await one.runs.recovered(dir)
    expect(one.runs.activity(dir).some((item) => item.id === `cut-off:${A}`)).toBe(true)
    /* The module's own line is not the person moving on. */
    appendFileSync(file, `${typed(now - 30_000, RESUME_LINE)}\n`)
    await one.runs.readCutOffs(dir, true)
    expect(one.runs.activity(dir).some((item) => item.id === `cut-off:${A}`)).toBe(true)
    appendFileSync(file, `${typed(now - 20_000)}\n`)
    await one.runs.readCutOffs(dir, true)
    expect(one.runs.activity(dir).some((item) => item.id === `cut-off:${A}`)).toBe(false)
    /* The old one is never said again. */
    const restarted = m.module()
    restarted.runs.know(dir)
    await restarted.runs.recovered(dir)
    expect(restarted.runs.activity(dir).some((item) => item.id === `cut-off:${A}`)).toBe(false)
    appendFileSync(file, `${notified(now - 10_000, 'failed', FAILED)}\n`)
    await restarted.runs.readCutOffs(dir, true)
    const back = restarted.runs.activity(dir).find((item) => item.id === `cut-off:${A}`)
    expect(back?.label).toBe('tighten the methods: 1 background task failed')
  })

  test('a conversation that belongs to no place has no line: there is nowhere to send the person', async () => {
    const m = machine()
    const dir = project()
    transcript(dir, A, [notified(now - 60_000, 'stopped', SHELL_CUT)])
    const one = m.module()
    one.runs.know(dir)
    await one.runs.recovered(dir)
    expect(one.runs.activity(dir)).toEqual([])
  })
})

describe('the setting "Resume conversations cut off by a restart"', () => {
  test('on unless a person turned it off, and drawn as a toggle no agent can press', () => {
    const dir = project()
    expect(readSettings(dir)).toEqual({ resumeCutOff: true, statusLine: true })
    writeSettings(dir, { resumeCutOff: false })
    expect(readSettings(dir)).toEqual({ resumeCutOff: false, statusLine: true })
    expect(resumeToggle(false)).toEqual([{ kind: 'toggle', id: 'resume-cut-off', label: 'Resume conversations cut off by a restart', icon: 'refresh', checked: false }])
    expect(resumeToggle(true)[0]).not.toHaveProperty('agents')
    expect(resumeToggle(null)).toEqual([])
  })

  test('“Status line in sessions” sits beside it: on unless turned off, a toggle no agent can press', () => {
    const dir = project()
    expect(readSettings(dir).statusLine).toBe(true)
    writeSettings(dir, { statusLine: false })
    expect(readSettings(dir)).toEqual({ resumeCutOff: true, statusLine: false })
    expect(statusLineToggle(false)).toEqual([{ kind: 'toggle', id: 'status-line', label: 'Status line in sessions', checked: false }])
    expect(statusLineToggle(true)[0]).not.toHaveProperty('agents')
    expect(statusLineToggle(null)).toEqual([])
  })

  test('its door is the page’s: without the ticket nothing is read or changed', async () => {
    const dir = project()
    const query = new URLSearchParams({ projectPath: dir })
    expect((await answer('GET', '/api/settings', query, null, null))?.status).toBe(403)
    expect((await answer('POST', '/api/settings', new URLSearchParams(), { projectPath: dir, resumeCutOff: false }, null))?.status).toBe(403)
    expect(readSettings(dir).resumeCutOff).toBe(true)
    const changed = await answer('POST', '/api/settings', new URLSearchParams(), { projectPath: dir, resumeCutOff: false }, TICKET)
    expect(changed?.body).toMatchObject({ ok: true, settings: { resumeCutOff: false } })
    expect((await answer('GET', '/api/settings', query, null, TICKET))?.body).toMatchObject({ ok: true, settings: { resumeCutOff: false } })
    expect((await answer('POST', '/api/settings', new URLSearchParams(), { projectPath: dir, resumeCutOff: 'no' }, TICKET))?.status).toBe(400)
  })
})

describe('the command lines, as Claude Code 2.1.306 takes and answers them', () => {
  test('--bg: a new one by name, a woken one with no flag when its options are saved, the line before any flag', () => {
    const B = '22222222-2222-4222-8222-222222222222'
    expect(PROGRAM.backgroundArgs!(null, 'proj · thesis', false)).toEqual(['--name', 'proj · thesis'])
    expect(PROGRAM.backgroundArgs!(B, 'proj · thesis', false)).toEqual(['--resume', B, '--name', 'proj · thesis'])
    expect(PROGRAM.backgroundArgs!(B, 'proj · thesis', true, RESUME_LINE)).toEqual(['--resume', B, RESUME_LINE])
    expect(() => PROGRAM.backgroundArgs!('--dangerously-skip-permissions', undefined, true)).toThrow()
  })

  test('what --bg prints is read for the handle, and the session for it from `agents --json`', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'kehikko-claude-bg-'))
    made.push(bin)
    const file = join(bin, 'claude')
    /* What 2.1.306 printed, measured with a scratch CLAUDE_CONFIG_DIR. */
    writeFileSync(
      file,
      `#!/bin/sh
case "$1" in
  --bg) printf 'Starting background service…\\nbackgrounded · 44e0eb81 · scratch-test (idle — send a prompt to start)\\n  claude agents             list sessions\\n  claude attach 44e0eb81    open in this terminal\\n' ;;
  agents) printf '[{"pid":58552,"id":"44e0eb81","cwd":"/p","kind":"background","startedAt":1,"sessionId":"44e0eb81-bbea-4822-a670-f5071ed22ac9","name":"scratch-test","status":"idle","state":"blocked"}]' ;;
  stop) echo "stopped $2" ;;
  rm) echo "removed $2" ;;
esac
`,
      { mode: 0o755 },
    )
    const woke = await PROGRAM.background!(file, ['--name', 'scratch-test'], bin)
    expect(woke).toMatchObject({ ok: true, handle: '44e0eb81', active: { session: '44e0eb81-bbea-4822-a670-f5071ed22ac9', kind: 'background', state: 'needs-you' } })
    expect(await PROGRAM.stop!(file, '44e0eb81')).toBe(true)
    expect(await PROGRAM.remove!(file, '44e0eb81')).toBe(true)
    writeFileSync(file, `#!/bin/sh\necho 'Workspace not trusted. Run \`claude\` in /p once and accept the trust prompt, then retry.' >&2\n`, { mode: 0o755 })
    expect(await PROGRAM.background!(file, [], bin)).toEqual({ ok: false, why: 'Workspace not trusted. Run `claude` in /p once and accept the trust prompt, then retry.' })
  })
})

/**
 * The person's machine as their log showed it: every skill this module offers is one they installed
 * through Kehikot (`~/.claude/skills/<name>/.kehikot-skill.json`), so a session had no skill of its
 * own to be given — and was given no plugin at all, so neither its hooks nor its status line ran,
 * and nothing told it its place. Each way a conversation is started here must still give it the
 * plugin and its hooks, and its first prompt must file it.
 */
describe('with every skill already installed in the person’s own config', () => {
  const config = process.env.CLAUDE_CONFIG_DIR!
  /* The scratch config is shared with every other test, which expects no `skills` folder in it: made here, and taken away again. */
  let had = false
  const installed = () => {
    had = existsSync(join(config, 'skills'))
    for (const one of skillDeclarations()) {
      mkdirSync(join(config, 'skills', one.name), { recursive: true })
      writeFileSync(join(config, 'skills', one.name, '.kehikot-skill.json'), JSON.stringify({ version: one.version }))
    }
  }
  const uninstalled = () => {
    for (const one of skillDeclarations()) rmSync(join(config, 'skills', one.name), { recursive: true, force: true })
    if (!had) rmSync(join(config, 'skills'), { recursive: true, force: true })
  }
  const pluginOf = (args: string[]) => (args.includes('--plugin-dir') ? args[args.indexOf('--plugin-dir') + 1]! : null)
  const hooked = (plugin: string | null) => {
    expect(plugin).not.toBeNull()
    expect(Object.keys(JSON.parse(readFileSync(join(plugin!, 'hooks', 'hooks.json'), 'utf8')).hooks)).toEqual(['SessionStart', 'UserPromptSubmit'])
    expect(existsSync(join(plugin!, 'context.sh'))).toBe(true)
    return readFileSync(join(plugin!, 'kehikot', 'token'), 'utf8')
  }

  test('a new conversation in the background is given its plugin, and its first prompt files it as the kehikko’s own', async () => {
    installed()
    try {
      const m = machine()
      const dir = project()
      const one = m.module({ plugins: true, configBase: project() })
      const run = (await one.runs.open(open(dir, null), new Watcher())) as Run
      expect(isRun(run)).toBe(true)
      const token = hooked(pluginOf(m.calls.bg[0]!))
      expect(token).toBe(run.token!)
      /* What context.sh posts at the first prompt, once Claude Code holds a record of it. */
      m.records(dir, run.id)
      const answer = await one.runs.context('UserPromptSubmit', run.id, token)
      expect(answer?.hookSpecificOutput.additionalContext).toContain('belongs to project')
      expect(entryOf(dir, run.id)).toMatchObject({ home: placeKey(HERE), token })
      expect(one.logged.some((line) => line.includes('filed under the place it was started at, as its kehikko’s own (it had none) — no /kehikot-here needed'))).toBe(true)
    } finally {
      uninstalled()
    }
  })

  test('a recorded conversation resumed into the background is given its plugin too', async () => {
    installed()
    try {
      const m = machine()
      const dir = project()
      m.records(dir, A)
      const one = m.module({ plugins: true, configBase: project() })
      await one.runs.open(open(dir, A), new Watcher())
      expect(m.calls.bg[0]!.slice(0, 2)).toEqual(['--resume', A])
      const token = hooked(pluginOf(m.calls.bg[0]!))
      await one.runs.context('SessionStart', A, token)
      expect(entryOf(dir, A)?.home).toBe(placeKey(HERE))
    } finally {
      uninstalled()
    }
  })

  test('woken from its saved options, the plugin folder those options name is written again', async () => {
    installed()
    try {
      const m = machine()
      const dir = project()
      const base = project()
      m.records(dir, A)
      const first = m.module({ plugins: true, configBase: base })
      await first.runs.open(open(dir, A), new Watcher())
      const plugin = pluginOf(m.calls.bg[0]!)
      first.runs.endAll()
      await settle()
      /* Stopped (a restart of the computer): woken with no flags, and the folder it names is whole. */
      m.background.clear()
      rmSync(plugin!, { recursive: true, force: true })
      const second = m.module({ plugins: true, configBase: base })
      await second.runs.open(open(dir, A), new Watcher())
      expect(m.calls.bg[1]).toEqual(['--resume', A])
      hooked(plugin)
    } finally {
      uninstalled()
    }
  })

  test('a background session started here is given the module’s own status line, and each wake follows the setting as it is then', async () => {
    installed()
    try {
      const m = machine()
      const dir = project()
      const base = project()
      m.records(dir, A)
      const first = m.module({ plugins: true, configBase: base, tells: true })
      await first.runs.open(open(dir, A), new Watcher())
      const args = m.calls.bg[0]!
      const plugin = pluginOf(args)!
      /* Its --settings are its status line only, at no padding; the person has none of their own. */
      expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({ statusLine: { type: 'command', command: `/bin/sh '${plugin}/statusline.sh'`, padding: 0 } })
      expect(readFileSync(join(plugin, 'kehikot', 'compose'), 'utf8')).toBe(process.execPath)
      expect(existsSync(join(plugin, 'kehikot', 'statusline'))).toBe(false)
      expect(existsSync(join(plugin, 'statusline-line.mjs'))).toBe(true)
      first.runs.endAll()
      await settle()
      /* Stopped; the person turns the setting off; woken from its saved options, its script prints nothing of the module's. */
      m.background.clear()
      writeSettings(dir, { statusLine: false })
      const second = m.module({ plugins: true, configBase: base, tells: true })
      await second.runs.open(open(dir, A), new Watcher())
      expect(m.calls.bg[1]).toEqual(['--resume', A])
      expect(existsSync(join(plugin, 'kehikot', 'compose'))).toBe(false)
      /* And one started new with the setting off is given no --settings at all, as before. */
      const other = project()
      writeSettings(other, { statusLine: false })
      await second.runs.open(open(other, null), new Watcher())
      expect(m.calls.bg[2]!).not.toContain('--settings')
    } finally {
      uninstalled()
    }
  })

  test('one opened in this terminal (no background) is given its plugin too', async () => {
    installed()
    try {
      const m = machine()
      const dir = project()
      const one = m.module({ backgrounds: false, plugins: true, configBase: project() })
      await one.runs.open(open(dir, null), new Watcher())
      hooked(pluginOf(one.ptys[0]!.args))
    } finally {
      uninstalled()
    }
  })
})

/* ------------------------------------------------------------------ *
 * "Needs you": the program asked something, and the person has not seen it
 * ------------------------------------------------------------------ */

describe('needs you only for a question the person has not seen', () => {
  /** A follower, as a framed page is: the activity list and the notices. */
  function page(runs: Runs) {
    const lists: ReturnType<Runs['activity']>[] = []
    const got: { state: string }[] = []
    runs.subscribe({ notices: true, state: () => {}, notice: (notice) => got.push(notice), activity: (rows) => lists.push(rows) })
    const attention = () => (lists.at(-1) ?? []).filter((row) => row.state === 'attention')
    return { lists, got, attention }
  }
  /** What `claude agents --json` says the background job is doing now. */
  const says = (m: ReturnType<typeof machine>, id: string, state: Active['state']) => m.background.set(id, { ...m.background.get(id)!, state })

  /** A new conversation, run in the background as this module runs one, at its empty prompt and on nobody's screen. */
  async function fresh() {
    const m = machine()
    const dir = project()
    const one = m.module()
    const viewer = new Watcher()
    const run = (await one.runs.open(open(dir, null), viewer)) as Run
    one.runs.look(run, viewer, false)
    const id = run.id
    return { m, dir, one, viewer, run, id, ...page(one.runs) }
  }
  /** The person sent a prompt: the program recorded the conversation, and it is filed at its place. */
  async function prompted(f: Awaited<ReturnType<typeof fresh>>) {
    f.m.records(f.dir, f.id)
    await f.one.runs.settle(f.run)
    expect(f.run.settled).toBe(f.id)
    says(f.m, f.id, 'working')
    await f.one.runs.watch()
  }

  test('an empty new session needs nobody, even when its program calls it blocked at its prompt', async () => {
    const f = await fresh()
    expect(f.attention()).toEqual([])
    /* Claude Code says a job is blocked before any turn — on a new project MCP server to approve, say. */
    says(f.m, f.id, 'needs-you')
    await f.one.runs.watch()
    expect(f.run.state).toBeNull()
    expect(f.attention()).toEqual([])
    expect(f.got).toEqual([])
  })

  test('after its first real question it does, once, in the Inbox and as a notice', async () => {
    const f = await fresh()
    await prompted(f)
    says(f.m, f.id, 'needs-you')
    await f.one.runs.watch()
    expect(f.attention()).toMatchObject([{ id: f.id, state: 'attention' }])
    expect(f.got.map((one) => one.state)).toEqual(['needs-you'])
  })

  test('a question asked before the record was read is taken once it is: the next asking', async () => {
    const f = await fresh()
    says(f.m, f.id, 'needs-you')
    await f.one.runs.watch()
    expect(f.attention()).toEqual([])
    f.m.records(f.dir, f.id)
    await f.one.runs.settle(f.run)
    await f.one.runs.watch()
    expect(f.attention()).toHaveLength(1)
  })

  test('answering it withdraws it', async () => {
    const f = await fresh()
    await prompted(f)
    says(f.m, f.id, 'needs-you')
    await f.one.runs.watch()
    expect(f.attention()).toHaveLength(1)
    f.one.runs.type(f.run, 'y')
    expect(f.run.state).toBe('working')
    expect(f.attention()).toEqual([])
  })

  test('opening it withdraws it, and looking away again does not bring it back', async () => {
    const f = await fresh()
    await prompted(f)
    says(f.m, f.id, 'needs-you')
    await f.one.runs.watch()
    expect(f.attention()).toHaveLength(1)
    f.one.runs.look(f.run, f.viewer, true)
    expect(f.attention()).toEqual([])
    f.one.runs.look(f.run, f.viewer, false)
    await f.one.runs.watch()
    expect(f.attention()).toEqual([])
    expect(f.run.state).toBe('needs-you')
    expect(entryOf(f.dir, f.id)?.looked).toBeDefined()
    /* It moves on and asks again, on nobody's screen: news again, and the mark is gone. */
    says(f.m, f.id, 'working')
    await f.one.runs.watch()
    expect(entryOf(f.dir, f.id)?.looked).toBeUndefined()
    says(f.m, f.id, 'needs-you')
    await f.one.runs.watch()
    expect(f.attention()).toHaveLength(1)
  })

  test('a session that ends withdraws it', async () => {
    const f = await fresh()
    await prompted(f)
    says(f.m, f.id, 'needs-you')
    await f.one.runs.watch()
    expect(f.attention()).toHaveLength(1)
    f.one.runs.end(f.id)
    await settle()
    expect(f.lists.at(-1)).toEqual([])
  })

  test('a restart does not bring back a question the person saw — and does not hide one they did not', async () => {
    const f = await fresh()
    await prompted(f)
    says(f.m, f.id, 'needs-you')
    await f.one.runs.watch()
    f.one.runs.look(f.run, f.viewer, true)
    f.one.runs.look(f.run, f.viewer, false)
    expect(f.attention()).toEqual([])
    /* The module restarts; the background conversation is still waiting. */
    f.one.runs.endAll()
    await settle()
    const second = f.m.module()
    const p = page(second.runs)
    second.runs.know(f.dir)
    await second.runs.watch()
    expect(second.runs.activity(f.dir).filter((row) => row.state === 'attention')).toEqual([])
    expect(p.got).toEqual([])
    /* Its view again, behind another on the page: still nothing. */
    const viewer = new Watcher()
    const again = (await second.runs.open(open(f.dir, f.id), viewer)) as Run
    second.runs.look(again, viewer, false)
    await second.runs.watch()
    expect(again.state).toBe('needs-you')
    expect(second.runs.activity(f.dir).filter((row) => row.state === 'attention')).toEqual([])

    /* One nobody saw before the restart is still said after it. */
    const g = await fresh()
    await prompted(g)
    says(g.m, g.id, 'needs-you')
    await g.one.runs.watch()
    g.one.runs.endAll()
    await settle()
    const third = g.m.module()
    third.runs.know(g.dir)
    await third.runs.watch()
    expect(third.runs.activity(g.dir).filter((row) => row.state === 'attention').map((row) => row.id)).toEqual([g.id])
  })
})
