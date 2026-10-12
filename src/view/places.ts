import type { Listing, Row } from '../../doors.ts'
import { kehikkoOf, placeKey, type Place } from '../../place.ts'

/**
 * What the page does when the canvas names a place, decided from what the
 * server says is there.
 *
 * ## The rule that was asked for
 *
 * "It should be the same session associated with this specific epic > parts >
 * kehikko, and if there are more than one session associated with it, then it
 * asks which one to open before it opens it."
 *
 *   - none recorded → a new session, at once;
 *   - exactly one → that one, at once;
 *   - more than one → ask, and open nothing until the person has chosen.
 *
 * Nothing is remembered as a default. The one thing that is remembered is
 * narrower and is not a default: which session THIS PAGE was showing for a
 * place, for as long as the page's tab lives (`held`, in `app.tsx`). A page
 * that reloads — which the plumbing does by itself when its server restarts —
 * comes back to what was on screen instead of asking a question the person
 * answered a minute ago. A page opened afresh asks.
 *
 * ## Why this file holds no socket, no emulator and no React
 *
 * As in Terminal's `sessions.ts`: everything here is a pure function of what
 * was said and what is held, so the tests can say "two sessions, so it asks"
 * without a browser or a pty in the room.
 */

export type Step =
  /** The program is missing, or too old: one sentence and one press. */
  | { do: 'install'; update: boolean }
  /** Open this session; null is a new one. */
  | { do: 'open'; session: string | null }
  /** More than one belongs here: ask. */
  | { do: 'choose' }

/**
 * `showing` is the session this page was showing for the place, if it was
 * showing one. It is honoured only while it is still one of the place's
 * sessions: one that was taken off the place in another container is not
 * reopened on the strength of a memory.
 *
 * Only sessions that are HERE count — the ones Claude Code has on this
 * computer. One the record lists and this computer does not have (`missing`:
 * it ran on another, or its transcript was cleaned away) cannot be opened,
 * so it is neither the one to open nor a reason to ask: a place whose only
 * recorded session is somewhere else gets a new one, and nothing is said.
 */
export function decide(listing: Listing, showing: string | null = null): Step {
  if (!listing.program.found) return { do: 'install', update: false }
  if (listing.program.lacks) return { do: 'install', update: true }
  const here = listing.sessions.filter((one) => !one.missing)
  if (showing && here.some((one) => one.id === showing)) return { do: 'open', session: showing }
  if (here.length === 0) return { do: 'open', session: null }
  if (here.length === 1) return { do: 'open', session: here[0]!.id }
  return { do: 'choose' }
}

/** A place as the page holds it: the project's folder with the key inside it. */
export interface Standing extends Place {
  projectPath: string
  kehikkoName: string
  /** The host's row number for the kehikko today: a note beside a key, and all there is without one. */
  kehikkoId: number | null
  key: string
}

/**
 * What the host said, as a place — or null when there is nothing to open:
 * the page has not been greeted, nothing is framing it, or no project is
 * open. A session with no project is a session in no folder, which nobody
 * asked for; Terminal falls back to a home shell there and this does not.
 *
 * The kehikko is named by its `key` whenever the host sends one (protocol
 * 1.1.0), because the key is the same after the project is removed and added
 * again and on another machine, and the `id` is a row number that is not. A
 * host that sends no key is an older one, and the place falls back to the id.
 */
export function standing(host: {
  where: 'listening' | 'unhosted' | 'hosted'
  projectPath: string | null
  epic: string | null
  parts: readonly { id: string; picked: boolean }[]
  kehikko: { id: number; name: string; key?: string } | null
}): Standing | null {
  if (host.where !== 'hosted' || !host.projectPath) return null
  const place: Place = {
    epic: host.epic,
    parts: host.parts.filter((part) => part.picked).map((part) => part.id).sort(),
    kehikko: kehikkoOf(host.kehikko),
  }
  return {
    ...place,
    projectPath: host.projectPath,
    kehikkoName: host.kehikko?.name ?? '',
    kehikkoId: host.kehikko?.id ?? null,
    key: placeKey(place),
  }
}

/** One string for a place across projects: what a view is filed under. */
export const placeId = (at: { projectPath: string; key: string }): string => `${at.projectPath}\n${at.key}`

/** How many terminal views the page keeps mounted. A view let go is only a viewer: its session runs on. */
export const MOST_VIEWS = 8

export interface View {
  /** This page's own number for it; a fresh one makes a fresh emulator and a fresh socket. */
  n: number
  at: Standing
  /** The session it is on. Null until the server has said which id a new one got. */
  session: string | null
  shownAt: number
  /**
   * Whether there is anything in it to keep: the program has a record of the
   * session, or somebody has typed into it. A view that is neither is let go
   * when the canvas moves on, and the server ends what was behind it.
   */
  kept: boolean
}

/**
 * How long a place has to be stood on before a NEW session is started for it.
 * Picking three parts is three places on the way to the fourth, and only the
 * last is wanted. Reopening a session that exists does not wait.
 */
export const SETTLE_MS = 600

/** The views to let go of, least recently shown first, never the one on screen. */
export function surplus(views: readonly View[], shown: number | null, most = MOST_VIEWS): View[] {
  const others = views.filter((view) => view.n !== shown).sort((a, b) => a.shownAt - b.shownAt)
  return others.slice(0, Math.max(0, views.length - most))
}

/** What a session is called where there is room for a few words. */
export function named(row: Pick<Row, 'label'> | null | undefined): string {
  return row?.label || 'No prompt yet'
}

/** The same, for the corner of the terminal: short enough to cost nothing. */
export function brief(label: string, most = 28): string {
  const text = label || 'New session'
  return text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text
}

/** When something last happened, in the fewest words that are still true. */
export function ago(at: number | null, now: number): string {
  if (at === null) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} d ago`
  return new Date(at).toISOString().slice(0, 10)
}
