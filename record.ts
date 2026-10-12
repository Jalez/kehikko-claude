import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { KEHIKOT_DIR, kehikotDir, moduleDir, moduleFile, within } from 'kehikot-module-protocol'

import { ID } from './manifest.ts'
import { placeKey, readPlaceKey, sortedParts, type Place } from './place.ts'

/**
 * Which session belongs to which place, kept inside the project it is about:
 * `<project>/.kehikot/claude/places.json`.
 *
 *     {
 *       "version": 1,
 *       "places": {
 *         "epic=thesis;parts=methods+results;kehikko=3": {
 *           "epic": "thesis",
 *           "parts": ["methods", "results"],
 *           "kehikko": { "id": 3, "name": "writing" },
 *           "sessions": ["6f0c…", "a41e…"]
 *         }
 *       },
 *       "sessions": {
 *         "6f0c…": { "added": "2026-10-12T14:03:11.000Z", "label": "tighten the methods…", "lastActive": "2026-10-12T15:40:02.000Z" }
 *       }
 *     }
 *
 * ## What is in it, and why each thing
 *
 * - **The key** is `placeKey`: ids only, parts sorted. It is what is looked up.
 * - **The names beside it** (`epic`, `parts`, the kehikko's `name`) are for a
 *   person reading the file and for the list an agent is given. Never compared.
 * - **A session's `label` and `lastActive`** are what Claude Code's own record
 *   said the last time this module looked, so the list can be drawn from this
 *   file alone — for a session whose transcript has since been cleaned away,
 *   and for an agent asking through the MCP door.
 *
 * A session may be listed under several places: attaching one to a second
 * place does not take it from the first.
 *
 * ## What is NOT in it
 *
 * A session that does not exist. An id is written here once the program has a
 * record for it and not before — a session that was opened, shown a sign-in
 * screen, and closed again was never a session, and a record of it would be a
 * row that can never be resumed. Until then it is held in memory by `live.ts`.
 * And nothing of a transcript beyond the one line used as a label.
 *
 * ## A part or a kehikko that is deleted
 *
 * Its key can no longer be reached, because the host will never name that
 * combination again. Nothing is deleted on that account: the entry stays in
 * the file, readable, and its sessions stay in Claude Code's own records for
 * the folder — which is where "attach an existing session" lists them from,
 * for every other place in the project. A rename changes nothing at all, since
 * a rename does not change an id.
 *
 * The same is true, less happily, when the HOST renumbers a kehikko: the id
 * in `context.kehikko` is the host's own number for it, which changes when a
 * project is forgotten and added again and differs on another machine. The
 * host keeps a stable `key` per kehikko in its own record; the protocol does
 * not carry it yet, and the day it does is the day this key should use it.
 *
 * ## One writer at a time, with nothing awaited in the middle
 *
 * Every change is read-modify-write, and every one of them is synchronous
 * from the read to the rename. That is the whole of the locking: this server
 * is one process on one thread, so two writes cannot interleave unless one of
 * them yields between reading the file and writing it back — and a write that
 * did would put back a copy missing whatever the other had added. So nothing
 * here is `async`, and the test that fires many writes at once is the one to
 * keep green if that ever changes.
 *
 * There is no default project. With no `projectPath` every read is empty and
 * every write refused: a guessed folder is one where work is written and
 * never seen again. Both sides are realpath'd before the containment check,
 * so a `.kehikot` that is a symlink out of the project is refused rather than
 * followed.
 */
export const FILE = 'places'
export const WHERE = `<project>/${KEHIKOT_DIR}/claude/${FILE}.json`

export interface PlaceEntry {
  epic: string | null
  parts: string[]
  kehikko: { id: number; name: string } | null
  sessions: string[]
}

export interface SessionEntry {
  /** When this module first recorded it. */
  added: string
  label: string
  lastActive: string | null
}

export interface Places {
  version: 1
  places: Record<string, PlaceEntry>
  sessions: Record<string, SessionEntry>
}

/** A place with the names a person knows it by. */
export interface NamedPlace extends Place {
  /** What the kehikko is called now. Stored for reading, never compared. */
  kehikkoName?: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const NO_PROJECT =
  'Nothing has said which project this is, so there is nowhere to keep anything. Open a project in the host, '
  + 'or send projectPath.'

const empty = (): Places => ({ version: 1, places: {}, sessions: {} })

/** Everything recorded for one project. Empty when nothing has been yet. */
export function readPlaces(projectPath: string | null | undefined): Result<Places> {
  const file = fileFor(projectPath, false)
  if (!file.ok) return file
  return load(file.value)
}

/** The sessions recorded for one place, in the order they were added. */
export function sessionsAt(places: Places, key: string): string[] {
  return Object.hasOwn(places.places, key) ? [...(places.places[key]?.sessions ?? [])] : []
}

/**
 * Record that a session belongs to a place. Adding one that is already there
 * changes nothing but the names beside the key, which are brought up to date.
 */
export function attach(
  projectPath: string | null | undefined,
  place: NamedPlace,
  id: string,
  about: { label?: string; lastActive?: number } = {},
  now = Date.now(),
): Result<Places> {
  return change(projectPath, (places) => {
    const key = placeKey(place)
    const was = Object.hasOwn(places.places, key) ? places.places[key] : undefined
    places.places[key] = {
      epic: place.epic,
      parts: sortedParts(place.parts),
      kehikko: place.kehikko === null ? null : { id: place.kehikko, name: place.kehikkoName ?? was?.kehikko?.name ?? '' },
      sessions: was?.sessions.includes(id) ? was.sessions : [...(was?.sessions ?? []), id],
    }
    describe(places, id, about, now)
  })
}

/** Take a session off a place. The session itself, and its entry here, are kept. */
export function detach(projectPath: string | null | undefined, key: string, id: string): Result<Places> {
  if (!readPlaceKey(key)) return { ok: false, error: 'That is not a place this module wrote.' }
  return change(projectPath, (places) => {
    if (!Object.hasOwn(places.places, key)) return
    const entry = places.places[key]!
    entry.sessions = entry.sessions.filter((one) => one !== id)
  })
}

/**
 * Bring what is known about a recorded session up to date. Does nothing —
 * and writes nothing — for a session no place lists, or when nothing differs.
 */
export function note(
  projectPath: string | null | undefined,
  id: string,
  about: { label?: string; lastActive?: number },
): Result<Places> {
  const read = readPlaces(projectPath)
  if (!read.ok) return read
  const was = Object.hasOwn(read.value.sessions, id) ? read.value.sessions[id] : undefined
  if (!was) return read
  const label = about.label || was.label
  const lastActive = about.lastActive ? new Date(about.lastActive).toISOString() : was.lastActive
  if (label === was.label && lastActive === was.lastActive) return read
  return change(projectPath, (places) => describe(places, id, about))
}

function describe(places: Places, id: string, about: { label?: string; lastActive?: number }, now = Date.now()): void {
  const was = Object.hasOwn(places.sessions, id) ? places.sessions[id] : undefined
  places.sessions[id] = {
    added: was?.added ?? new Date(now).toISOString(),
    label: about.label || was?.label || '',
    lastActive: about.lastActive ? new Date(about.lastActive).toISOString() : (was?.lastActive ?? null),
  }
}

/**
 * Read, change, write — with no `await` anywhere between, on purpose (see the
 * essay above). Written to a temporary file and renamed, so a crash never
 * leaves half a file.
 */
function change(projectPath: string | null | undefined, edit: (places: Places) => void): Result<Places> {
  const file = fileFor(projectPath, true)
  if (!file.ok) return file
  const read = load(file.value)
  if (!read.ok) return read
  edit(read.value)
  const temporary = `${file.value}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(read.value, null, 2)}\n`)
  renameSync(temporary, file.value)
  return read
}

function load(file: string): Result<Places> {
  if (!existsSync(file)) return { ok: true, value: empty() }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, error: `${file} is not readable JSON. Nothing was changed; fix or remove the file.` }
  }
  return { ok: true, value: tidy(parsed) }
}

/**
 * What was read, in the shape this file promises. Anything that is not that
 * shape is left out rather than trusted: the file is in somebody's project
 * and may have been edited by hand, or by a release that wrote more.
 */
function tidy(raw: unknown): Places {
  const out = empty()
  if (typeof raw !== 'object' || raw === null) return out
  const { places, sessions } = raw as { places?: unknown; sessions?: unknown }
  if (typeof places === 'object' && places !== null) {
    for (const [key, value] of Object.entries(places)) {
      const place = readPlaceKey(key)
      if (!place || typeof value !== 'object' || value === null) continue
      const entry = value as { kehikko?: { name?: unknown } | null; sessions?: unknown }
      out.places[key] = {
        epic: place.epic,
        parts: place.parts,
        kehikko: place.kehikko === null ? null : { id: place.kehikko, name: typeof entry.kehikko?.name === 'string' ? entry.kehikko.name : '' },
        sessions: Array.isArray(entry.sessions) ? [...new Set(entry.sessions.filter((one): one is string => typeof one === 'string' && one.length > 0 && one.length <= 128))] : [],
      }
    }
  }
  if (typeof sessions === 'object' && sessions !== null) {
    for (const [id, value] of Object.entries(sessions)) {
      if (!id || id.length > 128 || typeof value !== 'object' || value === null) continue
      const entry = value as { added?: unknown; label?: unknown; lastActive?: unknown }
      out.sessions[id] = {
        added: typeof entry.added === 'string' ? entry.added : '',
        label: typeof entry.label === 'string' ? entry.label.slice(0, 200) : '',
        lastActive: typeof entry.lastActive === 'string' ? entry.lastActive : null,
      }
    }
  }
  return out
}

/** The record's path, checked to resolve inside the project. `make` creates the folder first. */
function fileFor(projectPath: string | null | undefined, make: boolean): Result<string> {
  const root = projectRoot(projectPath)
  if (!root.ok) return root

  const dir = moduleDir(root.value, ID)!
  const levels = [kehikotDir(root.value)!, dir]
  /* Checked before making anything, so a folder that escapes is never written
     into, and again after, for what mkdir just made. */
  const escaped = escapesAny(root.value, levels)
  if (escaped) return { ok: false, error: escaped }
  if (make) {
    mkdirSync(dir, { recursive: true })
    const after = escapesAny(root.value, levels)
    if (after) return { ok: false, error: after }
  }
  const file = moduleFile(root.value, ID, FILE)!
  if (existsSync(file)) {
    const out = escapes(root.value, file)
    if (out) return { ok: false, error: out }
  }
  return { ok: true, value: file }
}

/** The project's folder, resolved, or the sentence saying why it is not one. */
export function projectRoot(projectPath: string | null | undefined): Result<string> {
  const raw = typeof projectPath === 'string' ? projectPath.trim() : ''
  if (!raw) return { ok: false, error: NO_PROJECT }
  if (!isAbsolute(raw)) return { ok: false, error: `"${raw}" is not an absolute path.` }
  try {
    const real = realpathSync(raw)
    if (!statSync(real).isDirectory()) return { ok: false, error: `"${raw}" is not a folder.` }
    return { ok: true, value: real }
  } catch {
    return { ok: false, error: `there is no folder at "${raw}" on this machine.` }
  }
}

function escapesAny(root: string, paths: string[]): string | null {
  for (const path of paths) {
    if (!existsSync(path)) continue
    const escaped = escapes(root, path)
    if (escaped) return escaped
  }
  return null
}

function escapes(root: string, child: string): string | null {
  let real: string
  try {
    real = realpathSync(child)
  } catch {
    return `${child} could not be resolved, so nothing is read or written through it.`
  }
  return within(root, real) ? null : `${child} resolves to ${real}, outside the project. Refused rather than followed.`
}
