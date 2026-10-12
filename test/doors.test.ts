import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WELL_KNOWN } from 'kehikot-module-protocol'

import { MANIFEST, TICKET, answer, listing, lookedIn, type Listing } from '../doors.ts'
import { Runs, headless } from '../live.ts'
import { ID } from '../manifest.ts'
import { placeKey } from '../place.ts'
import { recordDirs } from '../program.ts'
import { attach, readPlaces } from '../record.ts'

const project = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-claude-doors-')))
const bin = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-claude-bin-')))
afterAll(() => {
  rmSync(project, { recursive: true, force: true })
  rmSync(bin, { recursive: true, force: true })
})

const none = new URLSearchParams()
const METHODS = { epic: 'thesis', parts: ['methods'], kehikko: { id: 3 }, kehikkoName: 'writing' }
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

/** What Claude Code would have written for a session, where this module reads it from. */
function recorded(id: string, said: string) {
  const [dir] = recordDirs(project)
  mkdirSync(dir!, { recursive: true })
  writeFileSync(join(dir!, `${id}.jsonl`), `${JSON.stringify({ type: 'user', message: { content: said } })}\n`)
}

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const reply = await answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method, params }, null)
  return reply?.body as { result?: { tools?: { name: string; annotations?: Record<string, unknown> }[]; content?: { text: string }[]; isError?: boolean } }
}

describe('the doors', () => {
  test('the health check says which module this is', async () => {
    const reply = await answer('GET', '/healthz', none, null, null)
    expect(reply?.status).toBe(200)
    expect((reply?.body as { id: string }).id).toBe(ID)
  })

  test('the manifest is served at the well-known path by the config, and is this module’s', () => {
    expect(WELL_KNOWN.startsWith('/')).toBe(true)
    expect(MANIFEST.id).toBe(ID)
  })

  test('a path that is not ours is left to Vite', async () => {
    expect(await answer('GET', '/src/main.tsx', none, null, null)).toBeNull()
  })

  test('every door under /api needs this page’s ticket — the read as well, since it says what somebody worked on', async () => {
    const query = new URLSearchParams({ projectPath: project, key: placeKey(METHODS) })
    expect((await answer('GET', '/api/place', query, null, null))?.status).toBe(403)
    /* Marked, so the page's `ask()` knows it is older than this server and reloads. */
    expect(((await answer('GET', '/api/place', query, null, 'old'))?.body as { refused?: string }).refused).toBe('ticket')
    expect((await answer('POST', '/api/end', none, { session: A }, null))?.status).toBe(403)
    expect((await answer('POST', '/api/detach', none, { session: A }, 'x'))?.status).toBe(403)
    expect((await answer('GET', '/api/place', query, null, TICKET))?.status).toBe(200)
    expect((await answer('GET', '/api/nothing', none, null, TICKET))?.status).toBe(404)
  })

  test('there is no door that starts a session, types into one or installs anything', async () => {
    for (const path of ['/api/start', '/api/open', '/api/sessions', '/api/install', '/api/type', '/api/prompt']) {
      expect((await answer('POST', path, none, { projectPath: project }, TICKET))?.status).toBe(404)
    }
  })
})

describe('what a place holds', () => {
  const runs = new Runs({ spawn: () => { throw new Error('nothing is started by reading') }, screen: headless })

  test('its own sessions, the project’s others, and whether the program is there', async () => {
    recorded(A, 'tighten the methods section')
    recorded(B, 'draft the results')
    recorded(C, 'never attached anywhere')
    attach(project, METHODS, A)
    attach(project, { ...METHODS, parts: [] }, B)

    const said = (await listing(project, placeKey(METHODS), runs)) as Listing
    expect(said.ok).toBe(true)
    expect(said.sessions.map((one) => [one.id, one.label, one.running])).toEqual([[A, 'tighten the methods section', false]])
    /* Belongs to another place, and to none: both can be attached here. */
    expect(said.others.map((one) => one.id).sort()).toEqual([B, C])
    expect(typeof said.sessions[0]?.lastActive).toBe('number')
    expect(said.program.found).toBeNull()
    expect(said.program.looked.length).toBeGreaterThan(2)
    /* For the one sentence: PATH as one word, then where an install usually lands, the home folder as ~. */
    expect(said.program.where).toBe('PATH, ~/.local/bin, ~/.claude/local, /opt/homebrew/bin')
    expect(lookedIn(['/Users/someone/.local/bin', '/opt/homebrew/bin'], '/Users/someone')).toBe('PATH, ~/.local/bin, /opt/homebrew/bin')
    expect(said.program.install.line).toContain('install.sh')
    expect(said.running).toEqual([])
  })

  test('a session Claude Code has no record of on this computer is listed from what was kept beside it, and marked as not here', async () => {
    /* The record came with the project; the session ran on another computer, or its transcript was cleaned away. */
    const gone = '44444444-4444-4444-8444-444444444444'
    attach(project, METHODS, gone, { label: 'kept in the record', lastActive: Date.parse('2026-10-01T00:00:00Z') })
    const said = (await listing(project, placeKey(METHODS), runs)) as Listing
    expect(said.sessions.find((one) => one.id === gone)).toEqual({ id: gone, label: 'kept in the record', lastActive: Date.parse('2026-10-01T00:00:00Z'), running: false, missing: true })
    /* The ones that are here are not marked at all. */
    expect(said.sessions.find((one) => one.id === A)).not.toHaveProperty('missing')
    /* Not offered for attaching either: that list is what Claude Code holds here. */
    expect(said.others.some((one) => one.id === gone)).toBe(false)
    /* And nothing was taken out of the record on that account. */
    const kept = readPlaces(project)
    expect(kept.ok && kept.value.places[placeKey(METHODS)]?.sessions).toContain(gone)
    expect(kept.ok && kept.value.sessions[gone]?.label).toBe('kept in the record')

    const called = await rpc('tools/call', { name: 'sessions', arguments: { projectPath: project } })
    const places = JSON.parse(called.result?.content?.[0]?.text ?? '[]') as { place: string; sessions: { id: string; missing?: boolean }[] }[]
    const methods = places.find((one) => one.place === placeKey(METHODS))
    expect(methods?.sessions.find((one) => one.id === gone)?.missing).toBe(true)
    expect(methods?.sessions.find((one) => one.id === A)?.missing).toBeUndefined()
  })

  test('says when the program is found', async () => {
    copyFileSync(join(import.meta.dir, 'stand-in', 'claude'), join(bin, 'claude'))
    chmodSync(join(bin, 'claude'), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      const said = (await listing(project, placeKey(METHODS), runs)) as Listing
      expect(said.program.found).toBe(join(bin, 'claude'))
      expect(said.program.lacks).toBeNull()
    } finally {
      process.env.PATH = path
    }
  })

  test('refuses a place that is not one and a project that is not there', async () => {
    expect((await listing(project, 'constructor', runs)).ok).toBe(false)
    expect((await listing('/no/such/folder', placeKey(METHODS), runs)).ok).toBe(false)
  })

  test('taking a session off a place is a door; it goes back among the others', async () => {
    const reply = await answer('POST', '/api/detach', none, { projectPath: project, key: placeKey(METHODS), session: A }, TICKET)
    expect(reply?.status).toBe(200)
    const said = (await listing(project, placeKey(METHODS), runs)) as Listing
    expect(said.sessions.some((one) => one.id === A)).toBe(false)
    expect(said.others.some((one) => one.id === A)).toBe(true)
    expect((await answer('POST', '/api/detach', none, { projectPath: project, key: placeKey(METHODS), session: 'nope' }, TICKET))?.status).toBe(400)
  })

  test('bringing an older file across to a kehikko’s key is a door of its own, ticketed, and the read never does it', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-claude-rekey-')))
    try {
      attach(dir, { epic: 'thesis', parts: [], kehikko: { id: 3 }, kehikkoName: 'writing' }, A)
      const old = 'epic=thesis;parts=-;kehikko=3'
      const keyed = 'epic=thesis;parts=-;kehikko=key:4072c9e5'
      const file = join(dir, '.kehikot', 'claude', 'places.json')
      const before = readFileSync(file, 'utf8')

      /* Reading the keyed place finds nothing, and moves nothing. */
      expect(((await listing(dir, keyed, runs)) as Listing).sessions).toEqual([])
      expect(readFileSync(file, 'utf8')).toBe(before)

      const body = { projectPath: dir, kehikko: { key: '4072c9e5', name: 'writing', id: 28 } }
      expect((await answer('POST', '/api/rekey', none, body, null))?.status).toBe(403)
      expect((await answer('POST', '/api/rekey', none, { projectPath: dir, kehikko: { key: 'Not A Key', name: 'writing' } }, TICKET))?.status).toBe(400)
      expect((await answer('POST', '/api/rekey', none, { projectPath: dir }, TICKET))?.status).toBe(400)
      expect(readFileSync(file, 'utf8')).toBe(before)

      expect((await answer('POST', '/api/rekey', none, body, TICKET))?.body).toEqual({ ok: true, moved: 1 })
      const read = readPlaces(dir)
      expect(read.ok && Object.keys(read.value.places)).toEqual([keyed])
      expect(read.ok && read.value.places[keyed]).toEqual({ epic: 'thesis', parts: [], kehikko: { key: '4072c9e5', id: 28, name: 'writing' }, sessions: [A] })
      expect(read.ok && Object.hasOwn(read.value.places, old)).toBe(false)
      /* Asked again, there is nothing left to do. */
      expect((await answer('POST', '/api/rekey', none, body, TICKET))?.body).toEqual({ ok: true, moved: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('ending something that is not running says so and ends nothing', async () => {
    const reply = await answer('POST', '/api/end', none, { session: A }, TICKET)
    expect(reply?.body).toEqual({ ok: true, ended: false })
    expect((await answer('POST', '/api/end', none, { session: '--all' }, TICKET))?.status).toBe(400)
  })
})

describe('the MCP door', () => {
  test('offers one tool, and says it only reads', async () => {
    expect((await answer('GET', '/mcp', none, null, null))?.status).toBe(405)
    const tools = (await rpc('tools/list')).result?.tools ?? []
    expect(tools.map((one) => one.name)).toEqual(['sessions'])
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
  })

  test('lists the places of a project and their sessions', async () => {
    const called = await rpc('tools/call', { name: 'sessions', arguments: { projectPath: project } })
    expect(called.result?.isError).toBeUndefined()
    const places = JSON.parse(called.result?.content?.[0]?.text ?? '[]') as { place: string; sessions: { id: string; firstPrompt: string }[] }[]
    const whole = places.find((one) => one.place === 'epic=thesis;parts=-;kehikko=3')
    expect(whole?.sessions).toMatchObject([{ id: B, firstPrompt: 'draft the results', running: false }])

    const other = await rpc('tools/call', { name: 'sessions', arguments: { projectPath: project, epic: 'another' } })
    expect(other.result?.content?.[0]?.text).toContain('No session is recorded')
  })

  test('refuses in words an agent can read: no project, and a tool that is not here', async () => {
    expect((await rpc('tools/call', { name: 'sessions', arguments: {} })).result?.isError).toBe(true)
    for (const name of ['start', 'open', 'type', 'install', 'end']) {
      expect((await rpc('tools/call', { name, arguments: { projectPath: project } })).result?.isError).toBe(true)
    }
  })
})
