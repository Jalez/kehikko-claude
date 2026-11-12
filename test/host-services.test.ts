import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HOST_CALLER, SERVICE_CALLER_HEADER, SERVICE_PASS_HEADER, agentTasksSchema, conversationsFinderSchema, conversationsFindResult } from 'kehikot-module-protocol'
import { vouchHost } from 'kehikot-module-protocol/serve'

import { BRING_PATH, FIND_PATH, START_PATH, bringConversation, findConversations, hostDoor, readChangeUrl, readRef, startTask, type HostNeeds } from '../hostServices.ts'
import { NOWHERE, Runs, headless, type Pty } from '../live.ts'
import { MANIFEST } from '../manifest.ts'
import { placeKey } from '../place.ts'
import { PROGRAM, branchesIn, recordDirs, type Active, type Backgrounded, type Program, type Recorded } from '../program.ts'
import { assign, homeOf, ignore, isDetached, readPlaces, type NamedPlace } from '../record.ts'

/**
 * The services this module provides to the host (protocol 2.88.0, hostServices.ts): which
 * conversation worked on a change (`find`), filing one under a place as a compare-and-set (`bring`),
 * a new conversation fed a brief (`start`), and that only the host's own server is answered.
 * Transcripts are fixtures in the scratch Claude Code folder (test/setup.ts).
 */

const made: string[] = []
const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-claude-services-')))
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const WRITING: NamedPlace = { epic: 'thesis', parts: ['methods'], kehikko: { key: 'k1a2b3c4' }, kehikkoName: 'writing' }
const REVIEW: NamedPlace = { epic: 'thesis', parts: [], kehikko: { key: 'r9z8y7x6' }, kehikkoName: 'review' }
const AT_WRITING = { epic: 'thesis', parts: ['methods'], kehikko: 'k1a2b3c4' }
const AT_REVIEW = { epic: 'thesis', parts: [], kehikko: 'r9z8y7x6' }

const user = (content: string, more: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content }, ...more })

/** A transcript where Claude Code keeps session `id` of this project, last written at `at`. */
function transcript(dir: string, id: string, rows: string[], at = '2026-11-01T10:00:00Z'): void {
  const folder = recordDirs(dir)[0]!
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `${id}.jsonl`)
  writeFileSync(file, `${rows.join('\n')}\n`)
  utimesSync(file, new Date(at), new Date(at))
}

const read = (dir: string) => {
  const got = readPlaces(dir)
  if (!got.ok) throw new Error(got.error)
  return got.value
}

/** Claude Code that cannot be asked what runs, and a module holding the terminals in `held`. */
function needs(held: string[] = [], told: unknown[] = []): HostNeeds {
  return {
    program: { ...PROGRAM, find: () => ({ file: null, looked: [], usual: [] }) },
    holds: (id) => held.includes(id),
    told: (projectPath, assigned) => void told.push([projectPath, assigned]),
    start: async () => ({ ok: false, why: 'not here' }),
    vouch: async () => ({ ok: true }),
  }
}

describe('the descriptors', () => {
  test('the manifest provides both services, and each descriptor parses', () => {
    const services = MANIFEST.services as Record<string, unknown>
    expect(conversationsFinderSchema.parse(services['conversations.finder'])).toMatchObject({ program: 'Claude Code', find: FIND_PATH, bring: BRING_PATH })
    expect(agentTasksSchema.parse(services['agent.tasks'])).toMatchObject({ start: START_PATH, view: '/app?session={session}' })
  })
})

describe('reading a change', () => {
  test('a ref and an address say a number and a repository', () => {
    expect(readRef('Jalez/kehikko#345')).toEqual({ said: 'Jalez/kehikko#345', number: 345, repo: 'jalez/kehikko' })
    expect(readRef('!4721')).toEqual({ said: '!4721', number: 4721, repo: null })
    expect(readChangeUrl('https://github.com/Jalez/kehikko/pull/345')).toEqual({ repo: 'jalez/kehikko', number: 345 })
    expect(readChangeUrl('https://gitlab.example.com/group/sub/proj/-/merge_requests/12')).toEqual({ repo: 'group/sub/proj', number: 12 })
    expect(readChangeUrl('not a url')).toBeNull()
  })

  test('the branches a record’s rows were on, each once, and no detached HEAD', () => {
    const text = [user('a', { gitBranch: 'main' }), user('b', { gitBranch: 'feat/x' }), user('c', { gitBranch: 'HEAD' }), user('d', { gitBranch: 'main' })].join('\n')
    expect(branchesIn(text)).toEqual(['feat/x', 'main'])
  })
})

describe('find', () => {
  test('created, branch, mentioned and folder, strongest first, with where each is filed and nothing of the transcripts', async () => {
    const dir = project()
    const [made_, branched, mentioned, other, ignored, foreign] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    transcript(dir, made_, [user('open the pull request', { gitBranch: 'main' }), JSON.stringify({ type: 'pr-link', prNumber: '345', prUrl: 'https://github.com/Jalez/kehikko/pull/345' }), JSON.stringify({ type: 'ai-title', aiTitle: 'Rows keep their surface' })], '2026-11-01T10:00:00Z')
    transcript(dir, branched, [user('carry on', { gitBranch: 'rows-keep-surface' })], '2026-11-03T10:00:00Z')
    transcript(dir, mentioned, [user('look at #345 tomorrow', { gitBranch: 'main' }), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'the private reply' } })], '2026-11-02T10:00:00Z')
    transcript(dir, other, [user('fix #3456 instead', { gitBranch: 'main' })], '2026-11-04T10:00:00Z')
    transcript(dir, ignored, [user('a background job on #345')], '2026-11-04T10:00:00Z')
    /* The same number in another repository is not this change. */
    transcript(dir, foreign, [user('elsewhere'), JSON.stringify({ type: 'pr-link', prNumber: '345', prUrl: 'https://github.com/someone/else/pull/345' })], '2026-11-01T09:00:00Z')
    expect(assign(dir, WRITING, made_).ok).toBe(true)
    expect(ignore(dir, ignored).ok).toBe(true)

    const found = await findConversations({ project: dir, refs: ['Jalez/kehikko#345', '#345'], url: 'https://github.com/Jalez/kehikko/pull/345', branch: 'rows-keep-surface', repo: 'Jalez/kehikko' }, needs([branched]))
    expect(conversationsFindResult.safeParse({ conversations: found }).success).toBe(true)
    expect(found.map((one) => [one.session, one.match])).toEqual([
      [made_, 'created'],
      [branched, 'branch'],
      [mentioned, 'mentioned'],
      [other, 'folder'],
      [foreign, 'folder'],
    ])
    expect(found[0]).toMatchObject({ title: 'Rows keep their surface', folder: dir, reason: 'created Jalez/kehikko#345', place: AT_WRITING, running: false, lastActive: Date.parse('2026-11-01T10:00:00Z') })
    expect(found[1]).toMatchObject({ reason: 'worked on branch rows-keep-surface', place: null, running: true })
    expect(found[2]!.reason).toBe('mentioned #345')
    expect(found[3]!.reason).toBe('worked in this repository')
    expect(JSON.stringify(found)).not.toContain('private reply')
  })

  test('a conversation carried on under a new id is answered under that id', async () => {
    const dir = project()
    const [was, now] = [randomUUID(), randomUUID()]
    transcript(dir, was, [user('start'), JSON.stringify({ type: 'pr-link', prNumber: '7', prUrl: 'https://github.com/Jalez/kehikko/pull/7' }), JSON.stringify({ type: 'continued-in', continuedInSessionId: now })], '2026-11-01T10:00:00Z')
    transcript(dir, now, [user('go on')], '2026-11-02T10:00:00Z')
    const found = await findConversations({ project: dir, refs: ['#7'], repo: 'Jalez/kehikko' }, needs())
    expect(found.map((one) => [one.session, one.match])).toEqual([[now, 'created']])
  })

  test('a folder that is no project answers nothing', async () => {
    expect(await findConversations({ project: join(tmpdir(), 'no-such-folder-here'), refs: ['#1'] }, needs())).toEqual([])
  })
})

describe('bring', () => {
  test('a conversation filed under no place is brought, as /kehikot-here would, and told', async () => {
    const dir = project()
    const id = randomUUID()
    transcript(dir, id, [user('hello')])
    const told: unknown[] = []
    const said = await bringConversation({ project: dir, session: id, to: AT_WRITING, from: null }, needs([], told))
    expect(said).toMatchObject({ outcome: 'brought', place: AT_WRITING, resumed: false })
    const after = read(dir)
    expect(homeOf(after, id)).toBe(placeKey(WRITING))
    expect(after.places[placeKey(WRITING)]?.own).toBe(id)
    expect(after.sessions[id]?.token).toBeString()
    expect(told).toEqual([[dir, { key: placeKey(WRITING), session: id }]])
  })

  test('one filed under another place is never taken: elsewhere, with where it is, and the record untouched', async () => {
    const dir = project()
    const id = randomUUID()
    transcript(dir, id, [user('hello')])
    expect(assign(dir, REVIEW, id).ok).toBe(true)
    const before = JSON.stringify(read(dir))
    const said = await bringConversation({ project: dir, session: id, to: AT_WRITING, from: null }, needs())
    expect(said).toMatchObject({ outcome: 'elsewhere', place: AT_REVIEW })
    expect(JSON.stringify(read(dir))).toBe(before)
  })

  test('the undo takes it back to no place only while it is still where the host put it', async () => {
    const dir = project()
    const id = randomUUID()
    transcript(dir, id, [user('hello')])
    await bringConversation({ project: dir, session: id, to: AT_WRITING, from: null }, needs())
    const undone = await bringConversation({ project: dir, session: id, to: null, from: AT_WRITING }, needs())
    expect(undone).toMatchObject({ outcome: 'brought', place: null })
    expect(homeOf(read(dir), id)).toBeNull()
    expect(isDetached(read(dir), id)).toBe(true)
    /* Moved by somebody since: an undo never takes back their move. */
    expect(assign(dir, REVIEW, id).ok).toBe(true)
    expect(await bringConversation({ project: dir, session: id, to: null, from: AT_WRITING }, needs())).toMatchObject({ outcome: 'elsewhere', place: AT_REVIEW })
    expect(homeOf(read(dir), id)).toBe(placeKey(REVIEW))
  })

  test('a conversation whose terminal this module holds gains the place at once', async () => {
    const dir = project()
    const id = randomUUID()
    transcript(dir, id, [user('hello')])
    expect(await bringConversation({ project: dir, session: id, to: AT_WRITING, from: null }, needs([id]))).toMatchObject({ outcome: 'brought', resumed: true })
  })

  test('an id Claude Code has no conversation for is refused', async () => {
    const dir = project()
    expect((await bringConversation({ project: dir, session: randomUUID(), to: AT_WRITING, from: null }, needs())).outcome).toBe('no-such-session')
    expect((await bringConversation({ project: dir, session: 'not-an-id', to: AT_WRITING, from: null }, needs())).outcome).toBe('no-such-session')
  })
})

/* ------------------------------------------------------------------ start, with a stand-in program */

class FakePty implements Pty {
  pid = 0
  typed: string[] = []
  private exited: (exit: { exitCode: number }) => void = () => {}
  constructor(readonly file: string, readonly args: string[]) {}
  onData() {}
  onExit(heard: (exit: { exitCode: number }) => void) {
    this.exited = heard
  }
  write(data: string) {
    this.typed.push(data)
  }
  resize() {}
  kill() {
    this.exited({ exitCode: 129 })
  }
}

function machine(options: { backgrounds: boolean }) {
  const ptys: FakePty[] = []
  const bg: string[][] = []
  const background = new Map<string, Active>()
  const held = new Map<string, Recorded[]>()
  const minted = randomUUID()
  const program: Program = {
    ...PROGRAM,
    find: () => ({ file: '/fake/bin/claude', looked: [], usual: [] }),
    supports: async () => ({ ok: true, missing: null, tells: false, lists: true, names: false, configures: false, plugins: false, backgrounds: options.backgrounds }),
    active: async () => ({ known: true, active: [...background.values()] }),
    newId: () => minted,
    settled: async (projectPath, id) => (held.get(projectPath)?.some((one) => one.id === id) ? id : null),
    sessions: async (projectPath) => held.get(projectPath) ?? [],
    environment: () => ({ PATH: '/bin' }),
    background: async (_file, args, cwd): Promise<Backgrounded> => {
      bg.push(args)
      const one: Active = { session: minted, kind: 'background', called: 'background', handle: minted.slice(0, 8), pid: 9001, cwd, startedAt: Date.now(), name: '', state: null }
      background.set(minted, one)
      return { ok: true, handle: one.handle!, active: one }
    },
  }
  const runs = new Runs({
    program,
    heldWait: 0,
    every: null,
    watchEvery: null,
    screen: headless,
    spawn: (file, args) => {
      const pty = new FakePty(file, args)
      ptys.push(pty)
      return pty
    },
  })
  return { runs, ptys, bg, minted }
}

describe('start', () => {
  test('a new conversation in the background, the brief its first prompt, filed under the place with its title', async () => {
    const dir = project()
    const m = machine({ backgrounds: true })
    const said = await startTask({ project: dir, brief: 'Review !4721 and say what is missing.', place: AT_WRITING, title: 'Review !4721' }, { start: (p, place, brief, title) => m.runs.startTask(p, place, brief, title) })
    expect(said).toEqual({ outcome: 'started', session: m.minted, why: '' })
    expect(m.bg).toHaveLength(1)
    expect(m.bg[0]![0]).toBe('Review !4721 and say what is missing.')
    /* Nothing was typed: the brief went on launch. */
    expect(m.ptys.every((pty) => pty.typed.length === 0)).toBe(true)
    const after = read(dir)
    expect(homeOf(after, m.minted)).toBe(placeKey(WRITING))
    expect(after.sessions[m.minted]?.label).toBe('Review !4721')
    /* The view finds it by its id. */
    expect(m.runs.taskAt(m.minted)).toMatchObject({ projectPath: dir })
    for (const run of m.runs.sessions()) m.runs.end(run.id)
  })

  test('at the project itself (no place): filed under no epic, no parts and no kehikko', async () => {
    const dir = project()
    const m = machine({ backgrounds: true })
    const said = await startTask({ project: dir, brief: 'Look around.', place: null, title: 'Look around' }, { start: (p, place, brief, title) => m.runs.startTask(p, place, brief, title) })
    expect(said.outcome).toBe('started')
    expect(homeOf(read(dir), m.minted)).toBe(placeKey(NOWHERE))
    for (const run of m.runs.sessions()) m.runs.end(run.id)
  })

  test('a copy that cannot run in the background starts it in a terminal of this module, under the id it minted', async () => {
    const dir = project()
    const m = machine({ backgrounds: false })
    const said = await startTask({ project: dir, brief: 'Do the thing.', place: AT_WRITING, title: 'Thing' }, { start: (p, place, brief, title) => m.runs.startTask(p, place, brief, title) })
    expect(said).toEqual({ outcome: 'started', session: m.minted, why: '' })
    expect(m.ptys[0]!.args).toEqual(['--session-id', m.minted])
    expect(homeOf(read(dir), m.minted)).toBe(placeKey(WRITING))
    for (const run of m.runs.sessions()) m.runs.end(run.id)
  })

  test('a folder that is no project is declined', async () => {
    const m = machine({ backgrounds: true })
    expect(await startTask({ project: join(tmpdir(), 'no-such-folder-here'), brief: 'x', place: null, title: 'x' }, { start: (p, place, brief, title) => m.runs.startTask(p, place, brief, title) })).toMatchObject({ outcome: 'declined', session: null })
  })
})

/* ------------------------------------------------------------------ only the host */

describe('the door answers only the host', () => {
  const PASS = 'p'.repeat(40)
  /** The host at its origin, which minted `PASS` and nothing else. */
  const vouch = (headers: Headers) =>
    vouchHost(headers, {
      env: { KEHIKOT_ORIGINS: 'http://127.0.0.1:4170' },
      fetch: (async (url: string) => Response.json({ ok: true, minted: new URL(url).searchParams.get('pass') === PASS })) as unknown as typeof fetch,
    })
  const door = (dir: string) => {
    const started: string[] = []
    const fn = hostDoor(() => ({ ...needs(), vouch, start: async (_p, _place, brief) => (started.push(brief), { ok: true, session: randomUUID() }) }))
    return { fn, started, dir }
  }
  const post = (path: string, body: unknown, headers: Record<string, string> = { [SERVICE_CALLER_HEADER]: HOST_CALLER, [SERVICE_PASS_HEADER]: PASS }) => {
    const request = new Request(`http://127.0.0.1:8010${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { request, info: { asker: 'program' as const, url: new URL(request.url), ticket: null } }
  }

  test('find, bring and start each answer the host', async () => {
    const dir = project()
    const id = randomUUID()
    transcript(dir, id, [user('hello', { gitBranch: 'feat/x' })])
    const d = door(dir)
    const find = post(FIND_PATH, { project: dir, refs: ['#9'], branch: 'feat/x' })
    const found = await d.fn(find.request, find.info)
    expect(found!.status).toBe(200)
    expect(((await found!.json()) as { conversations: { session: string; match: string }[] }).conversations).toEqual([expect.objectContaining({ session: id, match: 'branch' })])
    const bring = post(BRING_PATH, { project: dir, session: id, to: AT_WRITING, from: null })
    expect(await (await d.fn(bring.request, bring.info))!.json()).toMatchObject({ outcome: 'brought' })
    const start = post(START_PATH, { project: dir, brief: 'the brief', place: null, title: 'A task' })
    expect(await (await d.fn(start.request, start.info))!.json()).toMatchObject({ outcome: 'started' })
    expect(d.started).toEqual(['the brief'])
  })

  test('no caller, another caller, a pass the host did not mint: 403, and nothing done', async () => {
    const dir = project()
    const id = randomUUID()
    transcript(dir, id, [user('hello')])
    const d = door(dir)
    const refused: Record<string, string>[] = [{}, { [SERVICE_CALLER_HEADER]: 'kehikot.queue', [SERVICE_PASS_HEADER]: PASS }, { [SERVICE_CALLER_HEADER]: HOST_CALLER, [SERVICE_PASS_HEADER]: 'q'.repeat(40) }]
    for (const headers of refused) {
      for (const [path, body] of [
        [FIND_PATH, { project: dir, refs: ['#9'] }],
        [BRING_PATH, { project: dir, session: id, to: AT_WRITING, from: null }],
        [START_PATH, { project: dir, brief: 'b', place: null, title: 't' }],
      ] as const) {
        const asked = post(path, body, headers)
        const said = await d.fn(asked.request, asked.info)
        expect(said!.status).toBe(403)
      }
    }
    expect(homeOf(read(dir), id)).toBeNull()
    expect(d.started).toEqual([])
  })

  test('other paths are not this door’s, and a GET is refused', async () => {
    const d = door(project())
    const other = post('/api/place', {})
    expect(await d.fn(other.request, other.info)).toBeUndefined()
    const request = new Request(`http://127.0.0.1:8010${FIND_PATH}`)
    expect((await d.fn(request, { asker: 'program', url: new URL(request.url), ticket: null }))!.status).toBe(405)
  })

  test('a body that is not the service’s shape is a 400', async () => {
    const d = door(project())
    const asked = post(BRING_PATH, { project: '/x', session: 'a' })
    expect((await d.fn(asked.request, asked.info))!.status).toBe(400)
  })
})

describe('the view', () => {
  test('/app?session=<id> asks for that one conversation; anything else is the usual page', async () => {
    const { taskSession } = await import('../src/view/task.tsx')
    const id = randomUUID()
    expect(taskSession(`?session=${id}`)).toBe(id)
    expect(taskSession('?session=nope')).toBeNull()
    expect(taskSession('')).toBeNull()
  })

  test('/api/task says where a task’s conversation is, through the page’s ticket only', async () => {
    const { answer, TICKET } = await import('../doors.ts')
    const q = new URLSearchParams({ session: randomUUID() })
    expect((await answer('GET', '/api/task', q, null, null))!.status).toBe(403)
    expect(await answer('GET', '/api/task', q, null, TICKET)).toMatchObject({ status: 200, body: { ok: true, at: null } })
  })
})
