/**
 * A place: where a person is standing when they open this module.
 *
 * The exact combination of the epic, the SET of parts picked out of it, and
 * the kehikko — inside one project. The project is not in the key because the
 * record that holds the keys is kept inside the project
 * (`<project>/.kehikot/claude/places.json`): a key read out of that file is
 * already about that folder.
 *
 * ## What makes two places the same place
 *
 * - The parts are a set. Methods then Results and Results then Methods are
 *   one place, so the ids are sorted before they are spelled.
 * - Methods alone and Methods with Results are different places, and nothing
 *   picked is a place too: the whole epic.
 * - A part is named by its id and a kehikko by its id. Both can be renamed —
 *   a heading is prose, a kehikko's name is a label — and a rename must not
 *   move anybody's session. The names are kept BESIDE the key in the record
 *   so the file can be read by a person; they are never compared.
 *
 * ## The spelling
 *
 *     epic=thesis;parts=methods+results;kehikko=3
 *     epic=thesis;parts=-;kehikko=3
 *     epic=-;parts=-;kehikko=-
 *
 * Readable in the file, and unambiguous: an epic slug and a part id are
 * lowercase letters, digits and dashes (`EPIC_SLUG`, `PART_ID`), so neither
 * can hold `;`, `=` or `+`, and a lone `-` — which no slug derivation
 * produces, since dashes at the ends are trimmed — stands for "none".
 *
 * Shared by the page and the server, so it imports nothing.
 */

export interface Place {
  /** The open epic's slug, or null when none is open. */
  epic: string | null
  /** The ids of the parts picked out. Empty is the whole epic. */
  parts: string[]
  /** The kehikko's id, or null when the host has no canvases. */
  kehikko: number | null
}

const NONE = '-'
const SLUG = /^[a-z0-9-]{1,80}$/

/** The parts as a set: no duplicates, sorted, so picking order never matters. */
export function sortedParts(parts: readonly string[]): string[] {
  return [...new Set(parts)].sort()
}

/** The one spelling of a place. Stable: these strings are written in people's files. */
export function placeKey(place: Place): string {
  const parts = sortedParts(place.parts)
  return [
    `epic=${place.epic ?? NONE}`,
    `parts=${parts.length ? parts.join('+') : NONE}`,
    `kehikko=${place.kehikko ?? NONE}`,
  ].join(';')
}

/**
 * A key read back into a place, or null for anything `placeKey` did not write.
 *
 * Strict on purpose. A key arrives over the wire as well as out of the file,
 * and it is used as a property name: one that does not round-trip is refused
 * rather than stored under a spelling nothing will ever ask for again.
 */
export function readPlaceKey(key: string): Place | null {
  const found = /^epic=([^;]+);parts=([^;]+);kehikko=([^;]+)$/.exec(key)
  if (!found) return null
  const [, epic = '', parts = '', kehikko = ''] = found
  if (epic !== NONE && !SLUG.test(epic)) return null
  const ids = parts === NONE ? [] : parts.split('+')
  if (ids.some((id) => !SLUG.test(id))) return null
  if (kehikko !== NONE && !/^-?\d{1,15}$/.test(kehikko)) return null
  const place: Place = {
    epic: epic === NONE ? null : epic,
    parts: ids,
    kehikko: kehikko === NONE ? null : Number(kehikko),
  }
  /* Sorted, deduplicated and spelled the one way, or it is not a key. */
  return placeKey(place) === key ? place : null
}
