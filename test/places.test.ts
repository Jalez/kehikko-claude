import { describe, expect, test } from 'bun:test'

import type { Listing, Row } from '../doors.ts'
import { ago, brief, decide, placeId, standing, surplus, type View } from '../src/view/places.ts'

/**
 * What the page does when the canvas names a place. Pure, so the rule that
 * was asked for — none, one, more than one — is pinned without a browser.
 */

const row = (id: string, more: Partial<Row> = {}): Row => ({ id, label: '', lastActive: null, running: false, ...more })
const listing = (sessions: Row[], program: Partial<Listing['program']> = {}): Listing => ({
  ok: true,
  program: { name: 'Claude Code', found: '/bin/claude', foundAt: '/bin/claude', looked: [], where: 'PATH', lacks: null, install: { line: 'install', lands: '~/.local/bin/claude' }, ...program },
  sessions,
  others: [],
  running: [],
  most: 6,
})

describe('opening the module on a place', () => {
  test('no session recorded there: a new one, at once', () => {
    expect(decide(listing([]))).toEqual({ do: 'open', session: null })
  })

  test('exactly one: that one, at once', () => {
    expect(decide(listing([row('a')]))).toEqual({ do: 'open', session: 'a' })
  })

  test('more than one: ask, and open nothing', () => {
    expect(decide(listing([row('a'), row('b')]))).toEqual({ do: 'choose' })
    /* Not even the one that is running, and not the most recent: the owner wants to be asked. */
    expect(decide(listing([row('a', { running: true, lastActive: 9 }), row('b', { lastActive: 1 })]))).toEqual({ do: 'choose' })
  })

  test('what this page was showing for the place is shown again — while it still belongs there', () => {
    expect(decide(listing([row('a'), row('b')]), 'b')).toEqual({ do: 'open', session: 'b' })
    expect(decide(listing([row('a'), row('b')]), 'gone')).toEqual({ do: 'choose' })
    expect(decide(listing([]), 'gone')).toEqual({ do: 'open', session: null })
  })

  test('the program missing, or too old, comes before any session', () => {
    expect(decide(listing([row('a')], { found: null }))).toEqual({ do: 'install', update: false })
    expect(decide(listing([row('a')], { lacks: '--session-id' }), 'a')).toEqual({ do: 'install', update: true })
  })
})

describe('the place the canvas is about', () => {
  const host = {
    where: 'hosted' as const,
    projectPath: '/p/thesis',
    epic: 'thesis',
    parts: [
      { id: 'results', picked: true },
      { id: 'intro', picked: false },
      { id: 'methods', picked: true },
    ],
    kehikko: { id: 3, name: 'writing' },
  }

  test('is the project, the epic, the picked parts as a set, and the kehikko by its id', () => {
    expect(standing(host)).toEqual({
      projectPath: '/p/thesis',
      epic: 'thesis',
      parts: ['methods', 'results'],
      kehikko: 3,
      kehikkoName: 'writing',
      key: 'epic=thesis;parts=methods+results;kehikko=3',
    })
  })

  test('moves when the epic, the picked parts or the kehikko does, and not when a name does', () => {
    const here = standing(host)!.key
    expect(standing({ ...host, epic: 'other' })!.key).not.toBe(here)
    expect(standing({ ...host, parts: [{ id: 'methods', picked: true }] })!.key).not.toBe(here)
    expect(standing({ ...host, kehikko: { id: 4, name: 'writing' } })!.key).not.toBe(here)
    expect(standing({ ...host, kehikko: { id: 3, name: 'renamed' } })!.key).toBe(here)
    /* The same place in another project is another place. */
    expect(placeId(standing({ ...host, projectPath: '/p/other' })!)).not.toBe(placeId(standing(host)!))
  })

  test('with no project there is nothing to open — not a session somewhere else instead', () => {
    expect(standing({ ...host, projectPath: null })).toBeNull()
    expect(standing({ ...host, where: 'unhosted' })).toBeNull()
    expect(standing({ ...host, where: 'listening' })).toBeNull()
  })

  test('no epic, no parts and no kehikko is still a place', () => {
    expect(standing({ ...host, epic: null, parts: [], kehikko: null })!.key).toBe('epic=-;parts=-;kehikko=-')
  })
})

describe('the small words', () => {
  test('views are let go least recently shown first, and never the one on screen', () => {
    const at = standing({ where: 'hosted', projectPath: '/p', epic: null, parts: [], kehikko: null })!
    const views: View[] = [1, 2, 3, 4].map((n) => ({ n, at, session: null, shownAt: n, kept: true }))
    expect(surplus(views, 1, 2).map((one) => one.n)).toEqual([2, 3])
    expect(surplus(views, 4, 8)).toEqual([])
  })

  test('a label short enough for the corner, and a session with no prompt yet still has a name', () => {
    expect(brief('')).toBe('New session')
    expect(brief('tighten the methods section and then everything after it')).toBe('tighten the methods section…')
  })

  test('when something last happened', () => {
    const now = Date.parse('2026-10-12T12:00:00Z')
    expect(ago(null, now)).toBe('')
    expect(ago(now - 20_000, now)).toBe('just now')
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(ago(now - 2 * 86_400_000, now)).toBe('2 d ago')
    expect(ago(Date.parse('2026-07-01T00:00:00Z'), now)).toBe('2026-07-01')
  })
})
