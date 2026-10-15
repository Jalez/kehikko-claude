import type { Listing, Row } from '../../doors.ts'
import type { Elsewhere, Notice } from '../../live.ts'
import { kehikkoOf, placeKey, type Place } from '../../place.ts'
import type { State } from '../../program.ts'

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
 *   - none recorded → a new session, at once — unless the project already
 *     has sessions, and then the person is offered them first (below);
 *   - exactly one → that one, at once;
 *   - more than one → ask, and open nothing until the person has chosen.
 *
 * ## A place with none, in a project that has some
 *
 * Starting a new conversation without a word was right only when there was
 * nothing else to carry on with. Work on an epic often begins in a plain
 * terminal, on another kehikko, or before the parts were picked this way —
 * and every combination of parts is its own place, so narrowing from the
 * whole epic to one part used to start an empty conversation beside the one
 * the person was just having. So: when the place has no session and Claude
 * Code holds others for the project's folder, the list is drawn before
 * anything is started (`offer`), "New session" first so that Enter is all a
 * person who wants a new one has to press. When the project has no other
 * session there is nothing to choose from, and a new one starts as before.
 *
 * It is asked once per place: choosing a session makes it the place's, and a
 * place with a session opens it directly.
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
  /** None belongs here, and the project has others: offer them, a new one first, before anything is started. */
  | { do: 'offer' }

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
  if (here.length === 0) return listing.others.length ? { do: 'offer' } : { do: 'open', session: null }
  if (here.length === 1) return { do: 'open', session: here[0]!.id }
  return { do: 'choose' }
}

/** A place as the page holds it: the project's folder with the key inside it. */
export interface Standing extends Place {
  projectPath: string
  kehikkoName: string
  /** What a person calls each picked part, by id. For a notice's words; never compared. */
  partNames: Record<string, string>
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
  parts: readonly { id: string; picked: boolean; heading?: string }[]
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
    partNames: Object.fromEntries(host.parts.filter((part) => part.picked && part.heading).map((part) => [part.id, part.heading!])),
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
  /** A person, told the session is open in another process, chose to open a copy of it here anyway. */
  copy?: boolean
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

/**
 * A session's state as a mark: one glyph, the word for it, and a colour.
 *
 * Three shapes and not three colours of one dot, because a colour is a claim
 * a person with any kind of colour blindness cannot read; and a glyph in the
 * text it sits in, because it then costs the width of a character and no
 * height at all. The word is the `title`, and is written out wherever there
 * is room for a word.
 *
 * Colours follow the host's own dots (protocol 1.5.0, docs/activity.md): needs you is yellow,
 * finished is green, working is grey.
 *
 * Nothing known is no mark: a session that has not said what it is doing is
 * not drawn as idle.
 */
export const MARKS: Record<State, { glyph: string; word: string; colour: string }> = {
  working: { glyph: '●', word: 'working', colour: 'text-muted-foreground' },
  'needs-you': { glyph: '◆', word: 'needs you', colour: 'text-needs-you' },
  finished: { glyph: '○', word: 'finished', colour: 'text-done' },
}

/** The mark's `title`: the word, and since when. */
export function since(state: State, at: number | null | undefined, now: number): string {
  const when = at ? ago(at, now) : ''
  return when && when !== 'just now' ? `${MARKS[state].word} · ${when}` : MARKS[state].word
}

/** A place in a person's words: the epic, the picked parts, the kehikko — whichever of them there are. */
export function placeWords(at: Pick<Notice, 'epic' | 'parts' | 'kehikko'>): string {
  return [at.epic, at.parts.join(' + '), at.kehikko].filter(Boolean).join(' · ')
}

/**
 * A notice as the line a panel draws and the level it draws it at, in the
 * protocol's own format. Null when it cannot be filed: the format files
 * every line under an epic, and a session in a place with no epic, noticed
 * while the canvas is on none, has nothing true to be filed under.
 *
 * It says which of the two it is first, then which session, then where —
 * and nothing about who is speaking: the panel says that itself.
 */
export function noticeLine(
  notice: Pick<Notice, 'state' | 'label' | 'epic' | 'parts' | 'kehikko' | 'partIds' | 'kehikkoKey'>,
  canvasEpic: string | null,
): { epic: string; message: string; level: 'attention' | 'done'; place?: { epic: string; parts?: string[]; kehikko?: string } } | null {
  const epic = notice.epic ?? canvasEpic
  if (!epic) return null
  const what = notice.state === 'finished' ? 'Finished' : 'Waiting for you'
  const which = notice.label ? `“${notice.label}”` : 'a session with no prompt yet'
  const where = placeWords(notice)
  return {
    epic,
    message: `${what}: ${which}${where ? ` — ${where}` : ''}`,
    level: notice.state === 'finished' ? 'done' : 'attention',
    /* Where a press on this line goes (protocol 1.4.0): the session's own epic, the parts' ids and the
       kehikko's key. Only for a session that has an epic of its own; more parts than a place may hold
       are left out, so that a press goes to the epic rather than to a cut-down selection. */
    ...(notice.epic
      ? {
          place: {
            epic: notice.epic,
            ...(notice.partIds?.length && notice.partIds.length <= 16 ? { parts: notice.partIds } : {}),
            ...(notice.kehikkoKey ? { kehikko: notice.kehikkoKey } : {}),
          },
        }
      : {}),
  }
}

/* ------------------------------------------------------------------------ *
 * A session that is running somewhere this module did not start it
 * ------------------------------------------------------------------------ */

/** What kind of process has it, in a person's words. The program's own word is kept when it is not one of the two known. */
export function kindWords(there: Pick<Elsewhere, 'kind' | 'called'>): string {
  if (there.kind === 'background') return 'a background session'
  if (there.kind === 'interactive') return 'an interactive session, in a terminal or an editor'
  return there.called ? `a “${there.called}” session` : 'a session of another kind'
}

/** Where it is running and for how long: the kind, the process, the folder, since when — whichever of them the program said. */
export function whereWords(there: Elsewhere, now: number): string {
  return [kindWords(there), there.pid ? `process ${there.pid}` : '', there.cwd ? `in ${there.cwd}` : '', there.since ? `started ${ago(there.since, now)}` : ''].filter(Boolean).join(', ')
}

/**
 * The question, when a session cannot be shown because another process has
 * it open: what is true, and that nothing has been done about it.
 */
export function elsewhereSaid(program: string, label: string, there: Elsewhere | null, now: number): string {
  const which = label ? `“${label}”` : 'This conversation'
  const where = there ? `: ${whereWords(there, now)}` : ''
  return `${which} is already open in another ${program} process on this computer${where}. It cannot be shown here — only a background session can be attached to — and nothing has been started.`
}

/** The two answers, and what each means. Said before the choice is made, not after. */
export const LEAVE = { word: 'Leave it', means: 'Nothing is started here, and the other process is not touched.' }
export const COPY = {
  word: 'Open a copy anyway',
  means: 'A second process on the same conversation. Remote Control stays with the other one until /remote-control is run here, and the two do not see each other’s turns.',
}

/**
 * What a session on screen is, when it is not simply this module's own: the
 * word beside its label in the corner, and the sentence behind it.
 */
export function standingWords(
  how: { background?: Elsewhere; copyOf?: Elsewhere; unchecked?: 'too-old' | 'failed' } | undefined,
  program: string,
  now: number,
): { word: string; means: string } | null {
  if (how?.background) {
    return { word: 'background', means: `Attached to ${whereWords(how.background, now)}: no second process was started, and Remote Control is where it was. Closing this view leaves the session running.` }
  }
  if (how?.copyOf) {
    return { word: 'copy', means: `A copy. This conversation is also open in another ${program} process (${whereWords(how.copyOf, now)}). ${COPY.means.slice(COPY.means.indexOf('Remote Control'))}` }
  }
  if (how?.unchecked) {
    return {
      word: 'unchecked',
      means:
        how.unchecked === 'too-old'
          ? `Resumed without checking whether it is already running somewhere else: this ${program} is too old to say. Update it to have that checked.`
          : `Resumed without checking whether it is already running somewhere else: ${program} could not be asked.`,
    }
  }
  return null
}

/** The same for a row of the list, where "running" would be: the words, and the sentence behind them. Null when nothing else has it. */
export function elsewhereRow(there: Elsewhere | undefined, now: number): { word: string; means: string } | null {
  if (!there) return null
  return there.kind === 'background'
    ? { word: 'running in the background', means: `Running as ${whereWords(there, now)}. Opening it here attaches to it: no second process is started.` }
    : { word: 'open elsewhere', means: `Open as ${whereWords(there, now)}. It cannot be attached to: opening it here asks before a copy is started.` }
}
