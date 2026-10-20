import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answer, hostCheck } from '../doors.ts'
import { enable, enabled, hookCommand, settingsFile } from '../hook.ts'
import { placeKey } from '../place.ts'
import { assign, attach, born, byToken, detach, follow, homeOf, ignore, ownOf, readPlaces, sighted, unassigned } from '../record.ts'
import { assignable } from '../doors.ts'
import { ANSWER, BACK_OWN, MAKE_OWN, UNASSIGNED, ownHeader } from '../src/view/own.ts'

/**
 * Where a conversation belongs, and which is a place's own — the record the
 * Kehikot doors answer from (protocol 2.4.0), never a guess.
 */

const made: string[] = []
const dir = () => {
  const one = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-claude-own-')))
  made.push(one)
  return one
}
afterAll(() => {
  for (const one of made) rmSync(one, { recursive: true, force: true })
})

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const METHODS = { epic: 'thesis', parts: ['methods'], kehikko: { key: 'k1a2b3c4' }, kehikkoName: 'writing' }
const RESULTS = { epic: 'thesis', parts: ['results'], kehikko: { key: 'k1a2b3c4' }, kehikkoName: 'writing' }
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345'
const none = new URLSearchParams()

const read = (project: string) => {
  const got = readPlaces(project)
  if (!got.ok) throw new Error(got.error)
  return got.value
}

describe('the record', () => {
  test('a conversation started at a place belongs there, is its own, and keeps its token', () => {
    const p = dir()
    born(p, METHODS, A, TOKEN)
    const r = read(p)
    expect(homeOf(r, A)).toBe(placeKey(METHODS))
    expect(ownOf(r, placeKey(METHODS))).toBe(A)
    expect(byToken(r, TOKEN)).toEqual({ id: A, home: placeKey(METHODS) })
    /* A second one started there belongs there too; the place's own stays the first. */
    born(p, METHODS, B, null)
    expect(ownOf(read(p), placeKey(METHODS))).toBe(A)
    expect(homeOf(read(p), B)).toBe(placeKey(METHODS))
  })

  test('viewing a conversation at another place lists it there and moves nothing', () => {
    const p = dir()
    born(p, METHODS, A, TOKEN)
    attach(p, RESULTS, A)
    const r = read(p)
    expect(homeOf(r, A)).toBe(placeKey(METHODS))
    expect(r.places[placeKey(RESULTS)]?.sessions).toEqual([A])
    expect(r.places[placeKey(RESULTS)]?.own).toBeUndefined()
  })

  test('"Make this the kehikko’s own" rewrites where it belongs and the place’s own', () => {
    const p = dir()
    born(p, METHODS, A, TOKEN)
    born(p, RESULTS, B, null)
    assign(p, RESULTS, A, { own: true })
    const r = read(p)
    expect(homeOf(r, A)).toBe(placeKey(RESULTS))
    expect(ownOf(r, placeKey(RESULTS))).toBe(A)
    expect(byToken(r, TOKEN)?.home).toBe(placeKey(RESULTS))
  })

  test('a conversation carried on under a new id keeps where it belongs, its token and its place’s own', () => {
    const p = dir()
    born(p, METHODS, A, TOKEN)
    follow(p, A, C)
    const r = read(p)
    expect(homeOf(r, C)).toBe(placeKey(METHODS))
    expect(ownOf(r, placeKey(METHODS))).toBe(C)
    expect(byToken(r, TOKEN)?.id).toBe(C)
  })

  test('one reported started outside belongs nowhere until assigned; taken off its place, it belongs nowhere again', () => {
    const p = dir()
    sighted(p, A, 'hook')
    expect(unassigned(read(p))).toEqual([A])
    expect(homeOf(read(p), A)).toBeNull()
    assign(p, METHODS, A)
    expect(unassigned(read(p))).toEqual([])
    expect(homeOf(read(p), A)).toBe(placeKey(METHODS))
    detach(p, placeKey(METHODS), A)
    expect(homeOf(read(p), A)).toBeNull()
  })

  test('a file from before `home` says it only where it is a fact: one place lists it', () => {
    const p = dir()
    attach(p, METHODS, A)
    attach(p, RESULTS, B)
    attach(p, RESULTS, C)
    attach(p, METHODS, B)
    const r = read(p)
    expect(homeOf(r, A)).toBe(placeKey(METHODS))
    /* Listed at two places, and the last opened at one of them. */
    expect(homeOf(r, B)).toBe(placeKey(METHODS))
    attach(p, RESULTS, B)
    /* Last opened at both now: not a fact, so not assigned. */
    expect(homeOf(read(p), B)).toBeNull()
  })
})

describe('the frame says which conversation is the kehikko’s own', () => {
  const title = (id: string) => ({ [A]: 'tighten the methods', [B]: 'draft results' })[id] ?? ''

  test('viewing its own: said beside the usual label, nothing to press', () => {
    const said = ownHeader({ own: A, viewing: A, usual: 'Sessions · tighten the methods', title, unassigned: [], working: false })
    expect(said.other).toBe(false)
    expect(said.label).toBe('Sessions · tighten the methods · this kehikko’s own')
    expect(said.items).toEqual([])
  })

  test('viewing another: said, with make-own and back-to-own', () => {
    const said = ownHeader({ own: A, viewing: B, title, unassigned: [], working: false })
    expect(said.other).toBe(true)
    expect(said.label).toBe('Viewing draft results — not this kehikko’s own (tighten the methods)')
    expect(said.items.map((one) => one.id)).toEqual([MAKE_OWN, BACK_OWN])
  })

  test('unassigned conversations are offered to assign here', () => {
    const said = ownHeader({ own: null, viewing: null, title, unassigned: [{ id: C, label: 'started in a terminal' }], working: false })
    expect(said.items).toEqual([
      {
        kind: 'go',
        id: UNASSIGNED,
        label: 'Not yet assigned (1)',
        options: [
          { id: C, label: 'Assign to this kehikko: started in a terminal' },
          { id: ANSWER, label: 'Another kehikko, or not a Kehikot conversation…' },
        ],
      },
    ])
  })

  test('where the place has an own conversation, the header option says the choice is made in the page', () => {
    const said = ownHeader({ own: A, viewing: A, title, unassigned: [{ id: C, label: 'started in a terminal' }], hasOwn: true, working: false })
    const item = said.items.find((one) => one.id === UNASSIGNED) as { options: { id: string; label: string }[] }
    expect(item.options.map((one) => one.label)).toEqual(['Assign to this kehikko…: started in a terminal', 'Another kehikko, or not a Kehikot conversation…'])
    /* One item and one option per conversation: nothing the header's width rules have to fit twice. */
    expect(said.items.length).toBe(1)
    expect(item.options.every((one) => one.label.length <= 48)).toBe(true)
  })

  test('the header item is the same at every width: what it says does not depend on how the host lays it out', () => {
    /* The host folds a module's menus into icons under 300 px and one "⋯" under 220, and a folded
       menu keeps every item; nothing here is width-dependent, and the page says it in a line of its own. */
    const said = ownHeader({ own: A, viewing: A, title, unassigned: [{ id: C, label: '' }], working: false })
    expect(said.items.find((one) => one.id === UNASSIGNED)).toMatchObject({ kind: 'go', label: 'Not yet assigned (1)' })
  })

  test('a server that does not say a place’s own claims nothing', () => {
    expect(ownHeader({ own: undefined, viewing: B, title, unassigned: [], working: false })).toEqual({ label: null, items: [], other: false })
  })
})

describe('not a Kehikot conversation', () => {
  test('ignored is a record: never listed again, not by a later report, and it survives a re-read', () => {
    const p = dir()
    sighted(p, A, 'agents', 1_000, 'kehikko modules issue triage')
    sighted(p, B, 'hook')
    expect(unassigned(read(p))).toEqual([A, B])
    expect(read(p).sessions[A]?.label).toBe('kehikko modules issue triage')
    expect(ignore(p, A, 2_000).ok).toBe(true)
    expect(unassigned(read(p))).toEqual([B])
    /* Reported again — by the hook or the agents list — it stays ignored. */
    sighted(p, A, 'hook')
    sighted(p, A, 'agents')
    expect(unassigned(read(p))).toEqual([B])
    /* What is on disk is what a restarted server reads. */
    const onDisk = JSON.parse(readFileSync(join(p, '.kehikot', 'claude', 'places.json'), 'utf8'))
    expect(onDisk.sessions[A].ignored).toEqual({ at: new Date(2_000).toISOString() })
  })

  test('a conversation that belongs to a place is not ignored; assigning an ignored one takes it back', () => {
    const p = dir()
    born(p, METHODS, A, null)
    expect(ignore(p, A).ok).toBe(false)
    sighted(p, B, 'hook')
    ignore(p, B)
    assign(p, RESULTS, B)
    expect(read(p).sessions[B]?.ignored).toBeUndefined()
    expect(homeOf(read(p), B)).toBe(placeKey(RESULTS))
  })

  test('the places to assign to: every other place on a kehikko, by kehikko, the most recently used first', () => {
    const p = dir()
    const OTHER = { epic: 'paper', parts: [], kehikko: { key: 'f00dcafe' }, kehikkoName: 'reviews' }
    born(p, METHODS, A, null, { lastActive: 1_000 })
    born(p, RESULTS, B, null, { label: 'draft results', lastActive: 3_000 })
    born(p, OTHER, C, null, { label: 'reply to reviewer 2', lastActive: 2_000 })
    expect(assignable(read(p), placeKey(METHODS))).toEqual([
      { key: placeKey(RESULTS), kehikko: 'writing', label: 'thesis · results', own: { id: B, title: 'draft results', lastActive: 3_000 } },
      { key: placeKey(OTHER), kehikko: 'reviews', label: 'paper · whole epic', own: { id: C, title: 'reply to reviewer 2', lastActive: 2_000 } },
    ])
  })
})

describe('the doors', () => {
  test('/api/kehikot/place answers the host from the record, for a program', async () => {
    const p = dir()
    born(p, METHODS, A, TOKEN)
    const reply = await answer('GET', '/api/kehikot/place', new URLSearchParams({ 'kehikot-place': TOKEN, project: p }), null, null)
    expect(reply?.body).toEqual({ ok: true, place: { conversation: A, epic: 'thesis', parts: ['methods'], kehikko: 'k1a2b3c4' } })
    const unknown = await answer('GET', '/api/kehikot/place', new URLSearchParams({ 'kehikot-place': 'z'.repeat(32), project: p }), null, null)
    expect(unknown?.body).toEqual({ ok: true, place: null })
  })

  test('/api/sessions/started lists a session in a project the host holds, and nothing anywhere else', async () => {
    const p = dir()
    const was = hostCheck.has
    try {
      hostCheck.has = async (folder) => folder === p
      expect((await answer('POST', '/api/sessions/started', none, { session_id: A, cwd: p, source: 'startup' }, null))?.body).toEqual({ ok: true, listed: true })
      expect(unassigned(read(p))).toEqual([A])
      expect((await answer('POST', '/api/sessions/started', none, { session_id: B, cwd: dir(), source: 'startup' }, null))?.body).toEqual({ ok: true, listed: false })
      expect((await answer('POST', '/api/sessions/started', none, { session_id: 'not-an-id', cwd: p }, null))?.status).toBe(400)
    } finally {
      hostCheck.has = was
    }
  })

  test('/api/assign is the page’s: ticketed, and it writes the record', async () => {
    const p = dir()
    sighted(p, A, 'hook')
    const body = { projectPath: p, key: placeKey(METHODS), session: A, own: true }
    expect((await answer('POST', '/api/assign', none, body, null))?.status).toBe(403)
    expect((await answer('POST', '/api/assign', none, body, TICKET))?.status).toBe(200)
    expect(homeOf(read(p), A)).toBe(placeKey(METHODS))
    expect(ownOf(read(p), placeKey(METHODS))).toBe(A)
  })

  test('/api/ignore is the page’s: ticketed, and it writes the decision', async () => {
    const p = dir()
    sighted(p, A, 'hook')
    const body = { projectPath: p, session: A }
    expect((await answer('POST', '/api/ignore', none, body, null))?.status).toBe(403)
    expect((await answer('POST', '/api/ignore', none, body, TICKET))?.status).toBe(200)
    expect(unassigned(read(p))).toEqual([])
    expect((await answer('POST', '/api/ignore', none, { projectPath: p, session: 'nope' }, TICKET))?.status).toBe(400)
  })
})

describe('the SessionStart hook', () => {
  test('enable adds one entry beside what is there, once, and writes nothing else', () => {
    const file = settingsFile()
    writeFileSync(file, JSON.stringify({ model: 'opus', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }], Stop: [] } }))
    expect(enabled()).toBe(false)
    const done = enable()
    expect(done).toMatchObject({ ok: true, already: false })
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(after.model).toBe('opus')
    expect(after.hooks.Stop).toEqual([])
    expect(after.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'echo theirs' }] },
      { hooks: [{ type: 'command', command: hookCommand(), timeout: 5 }] },
    ])
    expect(enabled()).toBe(true)
    expect(enable()).toMatchObject({ ok: true, already: true })
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.SessionStart).toHaveLength(2)
    rmSync(file)
  })

  test('a settings file that is not JSON is left alone', () => {
    const file = settingsFile()
    writeFileSync(file, '{ not json')
    expect(enable()).toMatchObject({ ok: false })
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
    rmSync(file)
  })
})
