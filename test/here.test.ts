import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { skillPath, skillTextIssue } from 'kehikot-module-protocol'

import { MANIFEST, TICKET, answer, hostCheck, stream } from '../doors.ts'
import { SAID, here, readSay, type HereNeeds } from '../here.ts'
import { Runs, headless, theRuns } from '../live.ts'
import { placeKey } from '../place.ts'
import { PROGRAM, recordDirs, type Active, type Program } from '../program.ts'
import { assign, readPlaces } from '../record.ts'
import { PLUGIN_DIR, skillDeclarations, skillText } from '../skills.ts'
import { CONFIG, HOME } from './setup.ts'

/**
 * `/kehikot-here`: a conversation assigned from inside it. What the door believes (a conversation
 * Claude Code lists as running, in a project the host holds), what it assigns to (the place on
 * screen, never a guess), and what it says.
 */

const made: string[] = []
const dir = () => {
  const one = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-claude-here-')))
  made.push(one)
  return one
}
afterAll(() => {
  for (const one of made) rmSync(one, { recursive: true, force: true })
})

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const WRITING = { epic: 'thesis', parts: ['methods'], kehikko: { key: 'k1a2b3c4' }, kehikkoName: 'writing' }
const REVIEW = { epic: 'thesis', parts: [], kehikko: { key: 'r9z8y7x6' }, kehikkoName: 'review' }
const none = new URLSearchParams()

const read = (project: string) => {
  const got = readPlaces(project)
  if (!got.ok) throw new Error(got.error)
  return got.value
}

/** A machine: what Claude Code says is running, the projects the host holds, and pages of this module. */
function machine(options: { lists?: boolean } = {}) {
  const running: Active[] = []
  const held = new Set<string>()
  const known: string[] = []
  const program: Program = {
    ...PROGRAM,
    find: () => ({ file: '/fake/bin/claude', looked: ['/fake/bin'], usual: [] }),
    supports: async () => ({ ok: true, missing: null, tells: false, lists: options.lists ?? true, names: false, configures: false, plugins: false }),
    active: async () => (options.lists === false ? { known: false, why: 'too-old' } : { known: true, active: [...running] }),
  }
  const runs = new Runs({ program, spawn: () => { throw new Error('nothing is started here') }, screen: headless, every: null, watchEvery: null })
  const told: string[] = []
  const needs: HereNeeds = {
    program,
    showingIn: (project) => runs.showingIn(project),
    knownProjects: () => known,
    hostHas: async (folder) => held.has(folder),
    told: (project) => {
      told.push(project)
      runs.told(project)
    },
  }
  return {
    runs,
    needs,
    told,
    /** Claude Code runs conversation `id` in `cwd`, in a terminal of its own. */
    runsIn: (id: string, cwd: string) => running.push({ session: id, kind: 'interactive', called: 'interactive', handle: null, pid: 4242, cwd, startedAt: 1, name: '' }),
    hold: (project: string) => {
      held.add(project)
      known.push(project)
    },
    /** A page of this module, framed on `place` in `project`. */
    page: (page: string, project: string, place: typeof WRITING, onScreen = true) =>
      runs.show(page, { projectPath: project, key: placeKey(place), place, onScreen }),
  }
}

describe('what /kehikot-here may be told after it', () => {
  test('“own”, “kehikko: <key>”, both, or nothing — and no other words', () => {
    expect(readSay('')).toEqual({ own: false, kehikko: null })
    expect(readSay('own')).toEqual({ own: true, kehikko: null })
    expect(readSay('kehikko: r9z8y7x6 own')).toEqual({ own: true, kehikko: 'r9z8y7x6' })
    expect(readSay('kehikko:r9z8y7x6')).toEqual({ own: false, kehikko: 'r9z8y7x6' })
    expect(readSay('please')).toBeNull()
    expect(readSay('kehikko: ../etc')).toBeNull()
  })
})

describe('which conversation the door believes', () => {
  test('an id Claude Code does not list as running is refused, and nothing is written', async () => {
    const m = machine()
    const p = dir()
    m.hold(p)
    m.page('page-aaaaaaaa', p, WRITING)
    const said = await here(A, '', m.needs)
    expect(said).toBe(`${SAID} Claude Code does not list this conversation as running, and no Kehikot project has its record, so nothing was assigned.`)
    expect(existsSync(join(p, '.kehikot', 'claude', 'places.json'))).toBe(false)
  })

  test('a string that is not an id is refused before anything is asked', async () => {
    const m = machine()
    expect(await here('not-an-id', '', m.needs)).toStartWith(`${SAID} That is not a Claude Code conversation’s id`)
  })

  test('a conversation running in a folder the host does not hold as a project is refused', async () => {
    const m = machine()
    const elsewhere = dir()
    m.runsIn(A, elsewhere)
    expect(await here(A, '', m.needs)).toBe(
      `${SAID} This conversation runs in ${elsewhere}, which is not a project in Kehikot, so nothing was assigned. Open that folder as a project, or type /kehikot-here in a conversation started in one.`,
    )
  })

  test('a conversation in one project is not assigned to a kehikko on screen in another', async () => {
    const m = machine()
    const mine = dir()
    const theirs = dir()
    m.hold(mine)
    m.hold(theirs)
    m.runsIn(A, mine)
    m.page('page-bbbbbbbb', theirs, WRITING)
    const said = await here(A, '', m.needs)
    expect(said).toStartWith(`${SAID} No kehikko with a Claude container is on screen in `)
    expect(existsSync(join(theirs, '.kehikot', 'claude', 'places.json'))).toBe(false)
    expect(existsSync(join(mine, '.kehikot', 'claude', 'places.json'))).toBe(false)
  })

  test('when Claude Code cannot be asked, its record in exactly one known project is the evidence', async () => {
    const m = machine({ lists: false })
    const p = dir()
    m.hold(p)
    m.page('page-cccccccc', p, WRITING)
    expect(await here(A, '', m.needs)).toStartWith(`${SAID} Claude Code does not list this conversation as running`)
    const [records] = recordDirs(p)
    mkdirSync(records!, { recursive: true })
    writeFileSync(join(records!, `${A}.jsonl`), '{}\n')
    expect(await here(A, '', m.needs)).toStartWith(`${SAID} Assigned to writing · thesis (methods).`)
  })
})

describe('what it assigns to', () => {
  test('the place on screen; it becomes that kehikko’s own when it had none, with a token', async () => {
    const m = machine()
    const p = dir()
    m.hold(p)
    m.runsIn(A, join(p))
    m.runs.show('page-dddddddd', { projectPath: p, key: placeKey(WRITING), place: { ...WRITING, partNames: ['Methods'] }, onScreen: true })
    expect(await here(A, '', m.needs)).toBe(`${SAID} Assigned to writing · thesis (Methods). It’s now this kehikko’s own (it had none).`)
    const record = read(p)
    expect(record.sessions[A]?.home).toBe(placeKey(WRITING))
    expect(record.places[placeKey(WRITING)]?.own).toBe(A)
    expect(record.sessions[A]?.token).toMatch(/^[A-Za-z0-9_-]{22,64}$/)
    /* The lists and the Inbox's count are said again. */
    expect(m.told).toEqual([p])
    expect(await here(A, '', m.needs)).toBe(`${SAID} This conversation is already this kehikko’s own (writing · thesis (Methods)). Nothing changed.`)
  })

  test('a kehikko with an own conversation keeps it; with “own” this one replaces it', async () => {
    const m = machine()
    const p = dir()
    m.hold(p)
    assign(p, WRITING, C, { own: true, label: 'tighten the methods' })
    m.page('page-eeeeeeee', p, WRITING)
    m.runsIn(A, p)
    m.runsIn(B, p)
    expect(await here(A, '', m.needs)).toBe(
      `${SAID} Assigned to writing · thesis (methods). “tighten the methods” stays this kehikko’s own conversation; type /kehikot-here own to make this one its own instead.`,
    )
    expect(read(p).places[placeKey(WRITING)]?.own).toBe(C)
    expect(read(p).sessions[A]?.home).toBe(placeKey(WRITING))
    expect(await here(B, 'own', m.needs)).toBe(`${SAID} Assigned to writing · thesis (methods), as this kehikko’s own: it replaced “tighten the methods”.`)
    expect(read(p).places[placeKey(WRITING)]?.own).toBe(B)
  })

  test('nothing on screen: nothing is written, and the kehikot it could go to are listed', async () => {
    const m = machine()
    const p = dir()
    m.hold(p)
    assign(p, REVIEW, C, { own: true })
    const before = readFileSync(join(p, '.kehikot', 'claude', 'places.json'), 'utf8')
    m.runsIn(A, p)
    const said = await here(A, '', m.needs)
    expect(said).toContain('No kehikko with a Claude container is on screen in')
    expect(said).toContain('/kehikot-here kehikko: r9z8y7x6  (review)')
    expect(readFileSync(join(p, '.kehikot', 'claude', 'places.json'), 'utf8')).toBe(before)
    /* Named, it goes there. */
    expect(await here(A, 'kehikko: r9z8y7x6', m.needs)).toStartWith(`${SAID} Assigned to review · thesis (whole epic).`)
  })

  test('a framed page whose open kehikko has no Claude container is not “on screen”', async () => {
    const m = machine()
    const p = dir()
    m.hold(p)
    m.runsIn(A, p)
    m.page('page-ffffffff', p, WRITING, false)
    expect(await here(A, '', m.needs)).toContain('No kehikko with a Claude container is on screen in')
  })

  test('two kehikot on screen: it asks which, and “kehikko: <key>” answers', async () => {
    const m = machine()
    const p = dir()
    m.hold(p)
    m.runsIn(A, p)
    m.page('page-gggggggg', p, WRITING)
    m.page('page-hhhhhhhh', p, REVIEW)
    const said = await here(A, '', m.needs)
    expect(said).toStartWith(`${SAID} 2 kehikot with a Claude container are on screen in`)
    expect(said).toContain('/kehikot-here kehikko: k1a2b3c4  (writing · thesis (methods), on screen)')
    expect(said).toContain('/kehikot-here kehikko: r9z8y7x6  (review · thesis (whole epic), on screen)')
    expect(existsSync(join(p, '.kehikot', 'claude', 'places.json'))).toBe(false)
    expect(await here(A, 'kehikko: k1a2b3c4 own', m.needs)).toStartWith(`${SAID} Assigned to writing · thesis (methods).`)
    /* A page that stops following is forgotten. */
    m.runs.unshow('page-gggggggg')
    expect(m.runs.showingIn(p).map((one) => one.key)).toEqual([placeKey(REVIEW)])
  })
})

describe('its doors', () => {
  test('/api/here takes no ticket, answers in plain text, and takes only POST', async () => {
    const reply = await answer('POST', '/api/here', new URLSearchParams({ session: 'nope', say: '' }), null, null)
    expect(reply?.status).toBe(200)
    expect(reply?.raw?.type).toStartWith('text/plain')
    expect(String(reply?.raw?.bytes)).toStartWith(SAID)
    expect((await answer('GET', '/api/here', none, null, null))?.status).toBe(405)
  })

  test('/api/here through the module’s own Runs: on screen, running, held → assigned', async () => {
    const p = dir()
    const was = hostCheck.has
    hostCheck.has = async (folder) => folder === p
    try {
      expect((await answer('POST', '/api/showing', none, { page: 'page-iiiiiiii', projectPath: p, key: placeKey(WRITING), kehikkoName: 'writing', onScreen: true }, null))?.status).toBe(403)
      expect((await answer('POST', '/api/showing', none, { page: 'page-iiiiiiii', projectPath: p, key: placeKey(WRITING), kehikkoName: 'writing', partNames: ['Methods'], onScreen: true }, TICKET))?.body).toEqual({ ok: true, showing: true })
      expect(theRuns().showingIn(p)).toHaveLength(1)
      /* The page's feed closing forgets what it had on screen. */
      const opened = stream('GET', '/api/feed', new URLSearchParams({ ticket: TICKET, page: 'page-iiiiiiii' }), () => {}, null)
      expect(opened && 'close' in opened).toBe(true)
      ;(opened as { close: () => void }).close()
      expect(theRuns().showingIn(p)).toHaveLength(0)
    } finally {
      hostCheck.has = was
    }
  })

  test('the skill is served as text, declared with its version, and says what it must', async () => {
    const reply = await answer('GET', skillPath('kehikot-here'), none, null, null)
    expect(reply?.status).toBe(200)
    expect(reply?.raw?.type).toBe('text/markdown; charset=utf-8')
    const text = String(reply?.raw?.bytes)
    expect(text).toBe(skillText('kehikot-here')!)
    expect(skillTextIssue(text, 'kehikot-here')).toBeNull()
    expect(MANIFEST.declares?.skills).toEqual(skillDeclarations())
    expect(MANIFEST.declares?.skills?.[0]).toMatchObject({ name: 'kehikot-here', version: expect.stringMatching(/^[0-9a-f]{12}$/) })
    /* Only a person's slash command runs it; the conversation's own id is written in by Claude Code. */
    expect(text).toContain('\ndisable-model-invocation: true\n')
    expect(text).toContain('session=${CLAUDE_SESSION_ID}')
    expect(text).toContain('http://127.0.0.1:8010/api/here')
    expect((await answer('POST', skillPath('kehikot-here'), none, null, null))?.status).toBe(405)
    expect(await answer('GET', '/kehikot/skills/other.md', none, null, null)).toBeNull()
    /* The plugin a session started here is given is the same file. */
    expect(readFileSync(join(PLUGIN_DIR, 'skills', 'kehikot-here', 'SKILL.md'), 'utf8')).toBe(text)
    expect(JSON.parse(readFileSync(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('kehikot')
  })

  test('nothing here installs a skill: no door, no tool, and nothing written to the person’s Claude config', async () => {
    for (const path of ['/api/skills', '/api/skill', '/api/install-skill', '/api/skills/install']) {
      expect((await answer('POST', path, none, { name: 'kehikot-here' }, TICKET))?.status).toBe(404)
    }
    const listed = (await answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, null))?.body as { result: { tools: { name: string }[] } }
    expect(listed.result.tools.map((one) => one.name).filter((name) => /skill|install|assign/.test(name))).toEqual([])
    expect(existsSync(join(CONFIG, 'skills'))).toBe(false)
    expect(existsSync(join(HOME, '.claude', 'skills'))).toBe(false)
  })
})
