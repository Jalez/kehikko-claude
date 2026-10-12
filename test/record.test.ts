import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { moduleFile } from 'kehikot-module-protocol'

import { ID } from '../manifest.ts'
import { placeKey } from '../place.ts'
import { attach, detach, note, readPlaces, sessionsAt } from '../record.ts'

const made: string[] = []
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'kehikko-claude-record-'))
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const METHODS = { epic: 'thesis', parts: ['methods'], kehikko: 3, kehikkoName: 'writing' }
const BOTH = { epic: 'thesis', parts: ['results', 'methods'], kehikko: 3, kehikkoName: 'writing' }
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

const places = (dir: string) => {
  const read = readPlaces(dir)
  if (!read.ok) throw new Error(read.error)
  return read.value
}

describe('the record of which session belongs where', () => {
  test('is kept inside the project, under this module’s own folder, and nowhere else', () => {
    const dir = project()
    expect(places(dir)).toEqual({ version: 1, places: {}, sessions: {} })
    attach(dir, METHODS, A)
    const file = moduleFile(dir, ID, 'places')!
    expect(file.endsWith('/.kehikot/claude/places.json')).toBe(true)
    expect(existsSync(file)).toBe(true)
  })

  test('a place keeps its sessions in the order they were added, and each place its own', () => {
    const dir = project()
    attach(dir, METHODS, A)
    attach(dir, METHODS, B)
    attach(dir, BOTH, B)
    const read = places(dir)
    expect(sessionsAt(read, placeKey(METHODS))).toEqual([A, B])
    expect(sessionsAt(read, placeKey(BOTH))).toEqual([B])
    expect(sessionsAt(read, placeKey({ epic: 'thesis', parts: [], kehikko: 3 }))).toEqual([])
  })

  test('the file can be read by a person: the key, and beside it the names', () => {
    const dir = project()
    attach(dir, BOTH, A, { label: 'tighten the methods section', lastActive: Date.parse('2026-10-12T15:40:02.000Z') }, Date.parse('2026-10-12T14:00:00.000Z'))
    const written = JSON.parse(readFileSync(moduleFile(dir, ID, 'places')!, 'utf8'))
    expect(written).toEqual({
      version: 1,
      places: {
        'epic=thesis;parts=methods+results;kehikko=3': {
          epic: 'thesis',
          parts: ['methods', 'results'],
          kehikko: { id: 3, name: 'writing' },
          sessions: [A],
        },
      },
      sessions: {
        [A]: { added: '2026-10-12T14:00:00.000Z', label: 'tighten the methods section', lastActive: '2026-10-12T15:40:02.000Z' },
      },
    })
  })

  test('attaching twice lists a session once; a renamed kehikko is the same place under its new name', () => {
    const dir = project()
    attach(dir, METHODS, A)
    attach(dir, { ...METHODS, kehikkoName: 'drafting' }, A)
    const read = places(dir)
    expect(Object.keys(read.places)).toEqual([placeKey(METHODS)])
    expect(read.places[placeKey(METHODS)]?.sessions).toEqual([A])
    expect(read.places[placeKey(METHODS)]?.kehikko).toEqual({ id: 3, name: 'drafting' })
  })

  test('taking a session off a place keeps the session, and leaves it on its other places', () => {
    const dir = project()
    attach(dir, METHODS, A, { label: 'first' })
    attach(dir, BOTH, A)
    detach(dir, placeKey(METHODS), A)
    const read = places(dir)
    expect(sessionsAt(read, placeKey(METHODS))).toEqual([])
    expect(sessionsAt(read, placeKey(BOTH))).toEqual([A])
    expect(read.sessions[A]?.label).toBe('first')
    expect(detach(dir, 'not a key', A).ok).toBe(false)
  })

  test('what is known about a session is brought up to date, and an unknown one is not invented', () => {
    const dir = project()
    attach(dir, METHODS, A)
    note(dir, A, { label: 'what it was first asked', lastActive: Date.parse('2026-10-12T16:00:00.000Z') })
    note(dir, B, { label: 'nobody listed this one' })
    const read = places(dir)
    expect(read.sessions[A]?.label).toBe('what it was first asked')
    expect(read.sessions[A]?.lastActive).toBe('2026-10-12T16:00:00.000Z')
    expect(read.sessions[B]).toBeUndefined()
  })

  /*
   * The lost update. Every change is read-modify-write, and the only thing
   * that keeps two of them from interleaving is that nothing is awaited
   * between the read and the write. Forty writers released together, each to
   * its own place and all to one: every one of them must be in the file.
   */
  test('many writes at once lose none of them', async () => {
    const dir = project()
    const ids = Array.from({ length: 40 }, (_, n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`)
    await Promise.all(
      ids.map(async (id, n) => {
        await Promise.resolve()
        attach(dir, { epic: 'thesis', parts: [`part-${n}`], kehikko: 1 }, id)
        await Promise.resolve()
        attach(dir, METHODS, id)
        note(dir, id, { label: `session ${n}` })
      }),
    )
    const read = places(dir)
    expect(sessionsAt(read, placeKey(METHODS)).sort()).toEqual([...ids].sort())
    expect(Object.keys(read.places).length).toBe(41)
    expect(Object.keys(read.sessions).length).toBe(40)
    expect(read.sessions[ids[7]!]?.label).toBe('session 7')
  })

  test('with no project nothing is read from a guess and nothing is written', () => {
    expect(readPlaces(null).ok).toBe(false)
    expect(attach('', METHODS, A).ok).toBe(false)
    expect(attach('relative/path', METHODS, A).ok).toBe(false)
    expect(attach(join(tmpdir(), 'kehikko-claude-no-such-folder'), METHODS, A).ok).toBe(false)
  })

  test('a file that is not JSON is refused rather than written over', () => {
    const dir = project()
    attach(dir, METHODS, A)
    const file = moduleFile(dir, ID, 'places')!
    writeFileSync(file, '{ not json')
    expect(readPlaces(dir).ok).toBe(false)
    expect(attach(dir, METHODS, B).ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })

  test('what a hand or another release put in the file is left out rather than trusted', () => {
    const dir = project()
    attach(dir, METHODS, A)
    const file = moduleFile(dir, ID, 'places')!
    const written = JSON.parse(readFileSync(file, 'utf8'))
    written.places.constructor = { sessions: ['x'] }
    written.places['epic=thesis;parts=b+a;kehikko=1'] = { sessions: ['x'] }
    written.places[placeKey(METHODS)].sessions.push(7, A)
    writeFileSync(file, JSON.stringify(written))
    const read = places(dir)
    expect(Object.keys(read.places)).toEqual([placeKey(METHODS)])
    expect(read.places[placeKey(METHODS)]?.sessions).toEqual([A])
  })

  test('a .kehikot that is a link out of the project is refused rather than followed', () => {
    const dir = project()
    const elsewhere = project()
    symlinkSync(elsewhere, join(dir, '.kehikot'))
    const written = attach(dir, METHODS, A)
    expect(written.ok).toBe(false)
    expect(existsSync(join(elsewhere, 'claude'))).toBe(false)
    mkdirSync(join(elsewhere, 'claude'), { recursive: true })
    expect(readPlaces(dir).ok).toBe(false)
  })
})
