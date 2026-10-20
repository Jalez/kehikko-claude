import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { ActivityItem, HeaderItemInput } from 'kehikot-module-protocol'

import { ANSWER, BACK_OWN, MAKE_OWN, UNASSIGNED, ownHeader } from './view/own.ts'
import { Unassigned } from './view/unassigned.tsx'
import { held, probeServer, type PressAnswer } from 'kehikot-module-protocol/client'
import { Cover, coverFor, useFocus, useHost, useServerStanding, type CoverState } from 'kehikot-module-protocol/client/react'

import type { Listing } from '../doors.ts'
import type { Elsewhere } from '../live.ts'
import { ID, NOTICES } from '../manifest.ts'
import type { State } from '../program.ts'
import { api as realApi, type Api } from './api.ts'
import { Chooser } from './view/chooser.tsx'
import { ElsewhereQuestion } from './view/elsewhere.tsx'
import {
  MARKS,
  MOST_VIEWS,
  SETTLE_MS,
  brief,
  decide,
  named,
  noticeLine,
  placeId,
  projectOf,
  relinked,
  since,
  standing,
  standingWords,
  surplus,
  type Standing as Place,
  type View,
} from './view/places.ts'
import { TerminalView, type Said, type Standing } from './view/terminal-view.tsx'
import { Button } from '@/components/ui/button'

/** What the shared sentences call this module. */
const NAME = 'Claude'

/** The server's reasons for closing a socket that the page acts on (`CLOSED` in live.ts). */
const INSTALLED = 4010
const MISSING = 4404
/** Put away while it was quiet and nobody was looking. Not news: the view is let go and nothing is drawn. */
const RESTED = 4001
/** The session is open in another process that cannot be attached to. Nothing was started: the person is asked. */
const ELSEWHERE = 4409
/** Ended on the person's press to be resumed in the project's new folder: the view opens it again at once. */
const MOVED = 4002

/** Try again: ask whether this module's own server is there now. The standing it reports is what redraws. */
const knock = () => void probeServer()

/**
 * Which session this page was showing for a place, kept for as long as the
 * tab lives and no longer.
 *
 * Not a default — the owner asked to be asked, and a page opened afresh asks.
 * It is here for the reload nobody chose: the plumbing reloads a page that is
 * older than its server, Vite's client reloads one when its server returns,
 * and a person who answered "which one?" a minute ago should come back to
 * what was on screen. Scoped by project — its id when the host sends one, so
 * a renamed folder is the same project — and keyed by place, so a choice made
 * in one place cannot land in another.
 */
const remembered = held<string>('kehikot.claude.showing', (stored) => (typeof stored === 'string' && stored ? stored : null))

/** A press on one of this module's header items, as the page takes it. */
type Press = (press: { item: string; value?: string | boolean }) => PressAnswer

/**
 * What the page asks of a host beyond being told where it stands: carry a
 * notice, and draw the way to the sessions in the container's own menus.
 * Handed to `Sessions` whole, so that a test can stand one in and a page
 * nothing is framing has none.
 */
export interface Hosted {
  /** Send one extension payload through the host (`events.emit`). */
  emit(extension: string, payload: Record<string, unknown>): Promise<unknown>
  /**
   * Say what the sessions are doing, whole (`activity.set`, protocol 1.5.0). The client sends it
   * to a host that answers the method, drops a list identical to the last, and sends nothing to
   * one that does not. Absent from a host stand-in that predates it.
   */
  activity?: (items: ActivityItem[]) => void
  /**
   * The methods the host said it answers for this module (`hello.answers`), or null from a host
   * that did not say. A host that answers `activity.set` holds the activity list, and derives
   * the one-time notice from its transitions itself: this module then sends no `events.emit`.
   */
  answers?: readonly string[] | null
  /** Declare the header items, whole. */
  header(items: HeaderItemInput[]): void
  /** Where the page puts what takes a press. */
  presses: MutableRefObject<Press | null>
  /**
   * Whether a host has ever pressed one of the header items: such a host draws the header, and
   * the corner control — which is only for a page whose host draws none — is gone for good.
   */
  drawn?: boolean
}

const DRAWN_KEY = 'kehikot.claude.header-drawn'

/** Whether a host has ever pressed a header item on this page's origin. */
function headerDrawn(): boolean {
  try {
    return window.localStorage.getItem(DRAWN_KEY) === 'yes'
  } catch {
    return false
  }
}

/**
 * Whether the host draws this module's header, so that the module's own corner control is not needed
 * (protocol 1.4.0, docs/header.md). The greeting's `header` when the host said: `true` draws none,
 * `false` draws it, whatever an earlier press proved on this origin. From a host that did not say
 * (`null`), a press having arrived is the proof, as before.
 */
export function hostDrawsHeader(said: boolean | null, pressed: boolean): boolean {
  return said === null ? pressed : said
}

/** Whether the host's greeting says it takes `activity.set`, and so makes notices from it. */
export function holdsActivity(answers: readonly string[] | null | undefined): boolean {
  return Array.isArray(answers) && answers.includes('activity.set')
}

export function App() {
  const presses = useRef<Press | null>(null)
  const [drawn, setDrawn] = useState(headerDrawn)
  const host = useHost(ID, {
    /* Answered at once and always no: a terminal holds a session, not a
       document with anchors, and silence would make every reference pointing
       here sit out the host's timeout first. */
    onGoto: (_goto, answer) => {
      answer(false, 'A terminal holds a session, not a document: there is nothing here to walk to.')
    },
    onPress: (press) => {
      /* Only a host that draws the header sends a press, so from the first one on the corner control is not needed. */
      try {
        window.localStorage.setItem(DRAWN_KEY, 'yes')
      } catch {
        /* Gone for this page's life all the same. */
      }
      setDrawn(true)
      return presses.current ? presses.current(press) : 'There is no session here to go to yet.'
    },
  })
  /* The parts as one steady value: the same array until the list changes by
     value, so the place below moves when a part is picked and not every time
     the host speaks. */
  const { parts } = useFocus(host)
  const { where, projectPath, projectId, epic, kehikko } = host
  /* The kehikko by its `key` when the host sends one, and by its `id` when it
     does not (see `standing`). All three are dependencies: the key is what the
     place is, and the id and the name are written beside it. */
  const at = useMemo(
    () => standing({ where, projectPath, projectId, epic, parts, kehikko }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [where, projectPath, projectId, epic, parts, kehikko?.key, kehikko?.id, kehikko?.name],
  )
  const server = useServerStanding()
  const cover = coverFor({ where, projectPath, server })
  const { request, header, drawsHeader, activity, answers } = host
  /* The greeting's word when there is one (protocol 1.4.0): true draws no control of our own, false does.
     From a host that did not say, the first press proves it draws the header, as before. */
  const hostDraws = hostDrawsHeader(drawsHeader, drawn)
  const hosted = useMemo<Hosted | null>(
    () => (where === 'hosted' ? { emit: (extension, payload) => request('events.emit', { extension, payload }), activity, answers, header, presses, drawn: hostDraws } : null),
    [where, request, header, activity, answers, hostDraws],
  )
  /* The modules on this kehikko, as one steady string: a change is what offers "Restart to load …". */
  const containers = host.containers.map((one) => one.module).sort().join(',')
  return <Sessions theme={host.theme} at={at} cover={cover} hosted={hosted} canvasEpic={epic} containers={containers} />
}

/**
 * The session for the place the canvas is about, on screen.
 *
 * Separate from `App` so that it can be rendered in a test with the canvas's
 * answer handed in as a prop. What it decides is in `view/places.ts`; this
 * holds the state and draws it.
 *
 * ## Every view stays mounted, and it matters less than it does in Terminal
 *
 * Views not on screen are `hidden`, so coming back to a place is instant and
 * its scrollback is exactly as it was. But a view here is only a viewer: the
 * session is the server's. Letting one go — to keep the page to `MOST_VIEWS`
 * emulators, or because the page reloaded — ends nothing, and the next view
 * of that session is sent its screen.
 *
 * ## A place opens its session, and nothing stands in the way
 *
 * There is no number of running sessions at which a place is refused, and
 * so no list a person is made to end something from. A session left waiting
 * behind another view for a long time has its process put away by the server
 * (`QUIET_REST` in live.ts); its view here is told so, is let go without a
 * word, and coming back to the place resumes the same session.
 *
 * ## A place with no session, and a session that is running elsewhere
 *
 * Two questions are put before anything is started, both in the terminal's
 * own space, which is empty when they are asked:
 *
 *  - a place with no session, in a project that has others, is offered them
 *    (`offer` in view/places.ts) with *New session* first;
 *  - a session another Claude Code process has open, and that cannot be
 *    attached to, is not resumed: the server says who has it and closes the
 *    socket (`ELSEWHERE`), and the person chooses between leaving it and
 *    opening a copy, with what a copy means beside the word. While that
 *    stands for a place, nothing is opened there by itself (`blocked`).
 *
 * A session Claude Code runs in the background needs no question: the server
 * attaches to it, and the corner says so.
 *
 * ## What is drawn besides the terminal
 *
 * Nothing that costs a row while a session is running. The session's short
 * label and the way to the list sit in the terminal's own corner, over it.
 * A strip appears along the bottom only when there is nothing running to
 * take the space from: the session has ended, the install did not finish, or
 * this module's server has gone.
 *
 * ## What a session is doing, and what is done about it
 *
 * Its program says — working, needs you, finished (`State` in program.ts) —
 * and the page is told as it changes, on the view's own socket and, for the
 * sessions it has no view of, on one feed (`api.feed`). It is drawn as one
 * glyph: in the corner control, before the label, for the session on screen;
 * and on each running row of the list, where the word "running" was. Neither
 * adds a row, a line or a pixel of height.
 *
 * When a session nobody has on screen comes to need its person, or finishes,
 * the server raises a notice and ONE framed page passes it to the host, in
 * the protocol's own format, for whatever on the canvas shows such lines.
 * The line names the session and its place in words. Pressing it goes
 * nowhere: the format carries an epic and no place, and a line on somebody
 * else's panel is not this module's to make pressable.
 *
 * The same sessions are declared as a Go item for the container's header, so
 * a host that draws headers offers them in its own menu. The corner control
 * stays until a host has pressed one of those items — a page cannot tell
 * whether its host draws headers, and without it a host that does not would
 * leave no way to the list — and is then gone for good (`headerDrawn`).
 */
export function Sessions({
  theme,
  at,
  cover = null,
  api = realApi,
  settleMs = SETTLE_MS,
  hosted = null,
  canvasEpic = null,
  containers = '',
}: {
  theme: 'light' | 'dark'
  /** The place the canvas is about, or null when there is nothing to open. */
  at: Place | null
  /** The shared not-ready state — waiting, unhosted, no project, server down, page stale — or none. */
  cover?: CoverState | null
  api?: Api
  /** How long a place is stood on before a new session is started for it. */
  settleMs?: number
  /** The host, for the two things asked of it; null when nothing is framing the page. */
  hosted?: Hosted | null
  /** The epic the canvas is on, which is not always the epic of the session a notice is about. */
  canvasEpic?: string | null
  /** The modules on this kehikko, sorted and joined: when it changes, a running session may lack a door. */
  containers?: string
}) {
  const [views, setViews] = useState<View[]>([])
  /** Which view each place shows, by `placeId`. */
  const [shownBy, setShownBy] = useState<Record<string, number>>({})
  const [standings, setStandings] = useState<Record<number, Standing>>({})
  const [labels, setLabels] = useState<Record<string, string>>({})
  /** What each running session's program last said it is doing. Null is "said, and taken back". */
  const [states, setStates] = useState<Record<string, { state: State | null; since: number }>>({})
  const [listing, setListing] = useState<{ id: string; value: Listing } | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  /** The person opened the list over a running terminal. */
  const [asking, setAsking] = useState(false)
  /** Whether the answers for the project's unassigned conversations are open (`view/unassigned.tsx`). */
  const [answering, setAnswering] = useState(false)
  /**
   * The session this place would open is open in another process, and nothing
   * was started: who has it, and whether the person has said to leave it.
   * Kept only while the canvas stays on the place — coming back asks the
   * program again, since what is running is never remembered.
   */
  const [blocked, setBlocked] = useState<{ place: string; session: string; there: Elsewhere | null; left: boolean } | null>(null)
  /** What each view turned out to be: a view of a background session, a copy, or one resumed unchecked. */
  const [hows, setHows] = useState<Record<number, { background?: Elsewhere; copyOf?: Elsewhere; unchecked?: 'too-old' | 'failed' }>>({})
  /**
   * Views whose session runs in a folder the project has since left (renamed or moved): where the
   * project is now, as the server said it, by view number. And the ones the person dismissed the
   * line for, by the folder it was about, so a second rename says so again.
   */
  const [moves, setMoves] = useState<Record<number, string | null>>({})
  const [dismissed, setDismissed] = useState<Record<number, string>>({})
  /** What the server said when a restart in the new folder was not done. */
  const [notMoved, setNotMoved] = useState<string | null>(null)
  /** The installer's own view, while it runs and after it fails. */
  const [installing, setInstalling] = useState<{ n: number; failed: string | null } | null>(null)
  const [again, setAgain] = useState(0)
  const count = useRef(0)
  /** The kehikot whose older entries this page has already asked the server to bring across to their key. */
  const brought = useRef(new Map<string, Promise<void>>())
  const standingOn = useRef(at)
  standingOn.current = at

  const id = at ? placeId(at) : null
  const read = listing && listing.id === id ? listing.value : null
  /* The list as it was read, with what has been said since laid over it: a
     state changes far more often than the list is asked for. */
  const here = useMemo<Listing | null>(() => {
    if (!read) return null
    const now = (row: Listing['sessions'][number]) => {
      const said = Object.hasOwn(states, row.id) ? states[row.id] : undefined
      if (!said || !row.running) return row
      const { state: _was, since: _when, ...rest } = row
      return said.state ? { ...rest, state: said.state, since: said.since } : rest
    }
    return { ...read, sessions: read.sessions.map(now), others: read.others.map(now) }
  }, [read, states])
  const view = id !== null ? (views.find((one) => one.n === shownBy[id]) ?? null) : null

  /* The canvas moved, or something changed that the list should reflect. */
  const project = at?.projectPath ?? null
  const projectId = at?.projectId ?? null
  const key = at?.key ?? null
  useEffect(() => {
    if (!project || !key) return
    let live = true
    setRefusal(null)
    /*
     * A host that names the kehikko by key: before the first read of a place
     * on it, what an older release filed under its row number is brought
     * across (`rekey` in record.ts). Asked once per kehikko and name for the
     * life of the page, and BEFORE the read, so that the place is not found
     * empty — and a new session started in it — a moment before its own
     * sessions arrive.
     */
    const on = standingOn.current
    const keyed = on?.kehikko && 'key' in on.kehikko ? on.kehikko.key : null
    let ready: Promise<void> = Promise.resolve()
    if (on && keyed) {
      const which = `${project}\n${keyed}\n${on.kehikkoName}`
      const asked = brought.current.get(which) ?? api.rekey(project, { key: keyed, name: on.kehikkoName, ...(on.kehikkoId === null ? {} : { id: on.kehikkoId }) })
      if (!brought.current.has(which)) {
        brought.current.set(which, asked)
        asked.catch(() => brought.current.delete(which))
      }
      ready = asked
    }
    ready
      .then(() => api.place(project, key, projectId))
      .then((value) => live && setListing({ id: placeId({ projectPath: project, projectId, key }), value }))
      .catch((error: unknown) => live && setRefusal(error instanceof Error ? error.message : String(error)))
    return () => {
      live = false
    }
  }, [project, projectId, key, again, api])

  /*
   * The same project at a new folder: renamed or moved while its sessions ran. Nothing is let go and
   * nothing is reopened — the views are told the new folder, so that one which connects from now on
   * says it, and the server follows the run there when the list above is read.
   */
  useEffect(() => {
    setViews((all) => relinked(all, at) ?? all)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, projectId])

  /*
   * Another place. The list that was open over the last one is not about
   * this one; and a view left behind with nothing in it — a new session
   * nobody typed into — is let go rather than kept, so that walking through
   * places does not leave a process at each. The server ends what was behind
   * it a little later, unless somebody comes back first.
   */
  useEffect(() => {
    setAsking(false)
    setBlocked(null)
    setNotMoved(null)
    const gone = views.filter((one) => !one.kept && placeId(one.at) !== id).map((one) => one.n)
    if (!gone.length) return
    setViews((all) => all.filter((one) => !gone.includes(one.n)))
    setShownBy((all) => Object.fromEntries(Object.entries(all).filter(([, shown]) => !gone.includes(shown))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const drop = (n: number) => {
    setViews((all) => all.filter((one) => one.n !== n))
    setShownBy((all) => Object.fromEntries(Object.entries(all).filter(([, shown]) => shown !== n)))
    setStandings(({ [n]: _gone, ...rest }) => rest)
    setHows(({ [n]: _was, ...rest }) => rest)
    setMoves(({ [n]: _moved, ...rest }) => rest)
  }

  /*
   * A view whose session the server ended on the person's press, to resume it in the project's new
   * folder: replaced in place by a fresh view of the same session, which connects with the folder
   * the project is in now. Not a new choice of session and not a question: the same one, again.
   */
  const reopen = (one: View) => {
    count.current += 1
    const now = standingOn.current
    const next: View = { ...one, n: count.current, at: now && placeId(now) === placeId(one.at) ? now : one.at, shownAt: Date.now() }
    setViews((all) => all.map((each) => (each.n === one.n ? next : each)))
    setShownBy((all) => Object.fromEntries(Object.entries(all).map(([place, shown]) => [place, shown === one.n ? next.n : shown])))
    setStandings(({ [one.n]: _gone, ...rest }) => rest)
    setHows(({ [one.n]: _was, ...rest }) => rest)
    setMoves(({ [one.n]: _moved, ...rest }) => rest)
  }

  /** Put a session on screen for this place: null is a new one. `copy` is a person's answer to "it is open elsewhere". */
  const open = (session: string | null, copy = false) => {
    if (!at || id === null) return
    setAsking(false)
    setBlocked(null)
    const was = views.find((one) => one.n === shownBy[id])
    if (was && session && was.session === session && standings[was.n]?.at !== 'closed') return
    count.current += 1
    const next: View = { n: count.current, at, session, shownAt: Date.now(), kept: false, ...(copy && session ? { copy: true } : {}) }
    const kept = [...views.filter((one) => one.n !== was?.n), next]
    const gone = surplus(kept, next.n, MOST_VIEWS).map((one) => one.n)
    setViews(kept.filter((one) => !gone.includes(one.n)))
    setShownBy((all) => ({ ...Object.fromEntries(Object.entries(all).filter(([, shown]) => !gone.includes(shown))), [id]: next.n }))
    if (session) remembered.at(projectOf(at)).keep(at.key, session)
  }

  /*
   * What this place holds has arrived: decide, once, what to do about it.
   *
   * Only when nothing is on screen for the place. A view that is already
   * there — the person was here before, and its session has been running
   * since — is shown as it is, and the list is only what the corner control
   * will draw.
   */
  const opened = useRef(open)
  opened.current = open
  useEffect(() => {
    if (!at || !here || view || installing) return
    /* Asked about, and not answered with "open it": nothing opens here by itself. */
    if (blocked && blocked.place === id) return
    const step = decide(here, remembered.at(projectOf(at)).read(at.key))
    if (step.do !== 'open') return
    if (step.session) return opened.current(step.session)
    /* A new session waits a moment for the canvas to stop moving. */
    const waited = setTimeout(() => opened.current(null), settleMs)
    return () => clearTimeout(waited)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here, view === null, installing === null, blocked === null])

  /* Looked at again: this is the most recently shown, for when views are let go. */
  useEffect(() => {
    if (view) setViews((all) => all.map((one) => (one.n === view.n ? { ...one, shownAt: Date.now() } : one)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.n])

  const stood = (one: View, next: Standing) => {
    if (next.at === 'closed' && next.code === MOVED) {
      reopen(one)
      return
    }
    if (next.at === 'closed' && next.code === RESTED) {
      /* The server put a waiting process away behind this view. Nothing is
         drawn about it: the view is let go, and the place opens its session
         again — resumed — when it is next stood on. */
      drop(one.n)
      return
    }
    if (next.at === 'closed' && next.code === ELSEWHERE) {
      /* Nothing was started. The view is let go, and the question stands in its place — set by
         what the server said just before it closed, or here if it said nothing. */
      const session = one.session
      if (session) setBlocked((was) => was ?? { place: placeId(one.at), session, there: null, left: false })
      drop(one.n)
      return
    }
    if (next.at === 'closed' && next.code === MISSING) {
      /* What was known about this place said the program was there. It is
         asked again before anything is decided from it. */
      drop(one.n)
      setListing(null)
      setAgain((n) => n + 1)
      return
    }
    setStandings((all) => ({ ...all, [one.n]: next }))
  }

  const said = (one: View, heard: Said) => {
    if (heard.elsewhere) {
      const session = heard.session ?? one.session
      if (session) setBlocked({ place: placeId(one.at), session, there: heard.elsewhere, left: false })
      return
    }
    if (heard.moved !== undefined) setMoves((all) => ({ ...all, [one.n]: heard.moved ?? null }))
    if (heard.opened) setHows((all) => ({ ...all, [one.n]: { background: heard.background, copyOf: heard.copyOf, unchecked: heard.unchecked } }))
    if (heard.typed || heard.exists) setViews((all) => all.map((each) => (each.n === one.n && !each.kept ? { ...each, kept: true } : each)))
    const session = heard.session
    if (session) {
      setViews((all) => all.map((each) => (each.n === one.n && each.session !== session ? { ...each, session } : each)))
      remembered.at(projectOf(one.at)).keep(one.at.key, session)
      if (heard.label) setLabels((all) => ({ ...all, [session]: heard.label! }))
      if (heard.state !== undefined) setStates((all) => ({ ...all, [session]: { state: heard.state ?? null, since: heard.since ?? Date.now() } }))
      /* A session that has come to exist since the list was read — a new one somebody has now spoken
         to — is not in it. Read again, so that the list and the header's menu have it without a press. */
      if (heard.exists && placeId(one.at) === id && read && !read.sessions.some((row) => row.id === session)) setAgain((n) => n + 1)
    }
  }

  /*
   * The feed: every running session's state as it changes, and — only for a
   * page a host is framing, which is the only kind that can pass one on —
   * the notices raised for a person who is not looking. The server hands a
   * notice to one page, so what arrives here is said once.
   */
  const told = useRef({ hosted, canvasEpic })
  told.current = { hosted, canvasEpic }
  const framed = hosted !== null
  useEffect(() => {
    if (!api.feed) return
    return api.feed(framed, {
      state: (stated) => setStates((all) => ({ ...all, [stated.session]: { state: stated.state, since: stated.since } })),
      /* The server writes the whole list and says it again on every change and on arrival; this only
         passes it on. The client drops an identical one and sends nothing to a host without the method. */
      activity: (items) => told.current.hosted?.activity?.(items),
      /* A session was reported started somewhere in this project: the list is read again. */
      sessions: () => setAgain((n) => n + 1),
      notice: (notice) => {
        /* One report: a host that holds the activity list makes the notice from it. Sending this
           one too would give the person every notice twice. Only a host that did not say it
           answers `activity.set` (before 1.5.0, or silent) is sent the notice. */
        if (holdsActivity(told.current.hosted?.answers)) return
        const line = noticeLine(notice, told.current.canvasEpic)
        if (!line) return console.info('A session changed while no epic was open, and a notice is filed under one. Nothing was sent.')
        void told.current.hosted
          ?.emit(NOTICES, { ...line, refs: [] })
          /* The host's word, and worth reading: it is where it says nothing on the canvas shows these. */
          .catch((error: unknown) => console.info('The host did not carry a notice.', error))
      },
    })
  }, [api, framed])

  const step = here && !view ? decide(here, null) : null
  const standingNow = view ? standings[view.n] : undefined
  const ended = standingNow?.at === 'closed' ? standingNow : null

  /* The question about a session that is open elsewhere, for this place, until it is answered. */
  const stuck = blocked && blocked.place === id && !view ? blocked : null
  const questioning = Boolean(at && here && !installing && stuck && !stuck.left && !asking)
  const choosing = Boolean(at && here && !installing && !questioning && (asking || (!view && (step?.do === 'choose' || step?.do === 'offer')) || stuck?.left))
  const wanting = Boolean(at && here && !installing && !view && step?.do === 'install')
  const terminal = Boolean(at && view && !choosing && !installing)
  const label = view ? brief((view.session && (labels[view.session] || here?.sessions.find((one) => one.id === view.session)?.label)) || '') : ''
  /* What the session on screen is besides this module's own: a view of a background one, a copy, or unchecked. */
  const how = view ? standingWords(hows[view.n], here?.program.name ?? 'Claude Code', Date.now()) : null
  const doing = (view?.session && Object.hasOwn(states, view.session) ? states[view.session] : undefined) ?? null
  const mark = doing?.state ? MARKS[doing.state] : null
  /* The session on screen runs in a folder its project has left: the line saying so, until dismissed. */
  const movedTo = view && at && moves[view.n] && dismissed[view.n] !== moves[view.n] ? at.projectPath : null
  const working = doing?.state === 'working'
  /* The kehikko gained or lost a module since the session on screen was started: its doors are not
     the kehikko's any more. Asked when the containers change, and said in one line with a restart. */
  const [doorsNow, setDoorsNow] = useState<{ session: string; added: string[]; removed: string[] } | null>(null)
  const viewed = view?.session ?? null
  const seenContainers = useRef(containers)
  useEffect(() => {
    if (seenContainers.current === containers) return
    seenContainers.current = containers
    if (!viewed || !api.doors) return
    let live = true
    void api
      .doors(viewed)
      .then((changed) => {
        if (live) setDoorsNow(changed && (changed.added.length || changed.removed.length) ? { session: viewed, ...changed } : null)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [containers, viewed, api])
  const doorsLine = doorsNow && doorsNow.session === viewed ? doorsNow : null
  const restartForDoors = () => {
    if (!viewed || !api.restart || working) return
    setDoorsNow(null)
    void api.restart(viewed, 'doors').catch(() => {})
  }
  const restartHere = () => {
    const session = view?.session
    if (!session || !api.restart || working) return
    setNotMoved(null)
    void api.restart(session).catch((error: unknown) => setNotMoved(error instanceof Error ? error.message : String(error)))
  }

  /*
   * The same way to the sessions, declared for the container's header: a Go
   * item with this place's sessions, a new one, and the list. Person-only —
   * it says nothing about agents, so none can open a session through it.
   */
  const offered = at && here && here.program.found && !here.program.lacks && !installing ? here.sessions.filter((one) => !one.missing).slice(0, 60) : null
  const here_label = (() => {
    if (!view || !label) return 'Sessions'
    const text = `Sessions · ${mark ? `${mark.glyph} ` : ''}${label}${how ? ` · ${how.word}` : ''}`
    return text.length > 56 ? `${text.slice(0, 55).trimEnd()}…` : text
  })()
  /* Which conversation is this place's own, and whether the one on screen is it. */
  const titleOf = (session: string) => labels[session] || [...(here?.sessions ?? []), ...(here?.unassigned ?? [])].find((one) => one.id === session)?.label || ''
  const ownSaid = ownHeader({
    own: here ? here.own : undefined,
    usual: here_label,
    viewing: view?.session ?? null,
    title: titleOf,
    unassigned: (here?.unassigned ?? []).map((one) => ({ id: one.id, label: one.label })),
    hasOwn: Boolean(here?.ownNow),
    working,
  })
  /* Nothing left to answer: the answers close, so the next one to arrive is a line again. */
  const waitingCount = here?.unassigned?.length ?? 0
  useEffect(() => {
    if (waitingCount === 0) setAnswering(false)
  }, [waitingCount])
  const items = useMemo<HeaderItemInput[]>(() => {
    if (!offered) return []
    const worded = (row: (typeof offered)[number]) => {
      const text = `${row.state ? `${MARKS[row.state].glyph} ` : ''}${labels[row.id] || named(row)}`
      return text.length > 48 ? `${text.slice(0, 47).trimEnd()}…` : text
    }
    return [
      {
        kind: 'go',
        id: 'sessions',
        /* The corner control's job when the host draws the header and ours is gone: which session is on screen. */
        label: ownSaid.label ?? here_label,
        options: [...offered.map((row) => ({ id: row.id, label: worded(row) })), { id: 'new', label: 'New session' }, { id: 'list', label: 'All sessions…' }],
      },
      ...ownSaid.items,
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(offered?.map((row) => [row.id, row.label, row.state ?? ''])), labels, here_label, JSON.stringify(ownSaid)])
  useEffect(() => {
    hosted?.header(items)
  }, [hosted, items])
  if (hosted) {
    hosted.presses.current = ({ item, value }) => {
      if (item === MAKE_OWN) {
        const session = view?.session
        if (!session || !at || !api.assign) return 'There is no conversation on screen to make this kehikko’s own.'
        void api.assign(at.projectPath, at.key, session, true, at.kehikkoName).finally(() => setAgain((n) => n + 1))
        return true
      }
      if (item === BACK_OWN) {
        const own = here?.own
        if (!own) return 'This kehikko has no conversation of its own.'
        open(own)
        return true
      }
      if (item === UNASSIGNED) {
        if (value === ANSWER) {
          if (!here?.unassigned?.length) return 'No conversation is waiting to be assigned any more.'
          setAnswering(true)
          return true
        }
        if (typeof value !== 'string' || !at || !api.assign || !here?.unassigned?.some((one) => one.id === value)) return 'That conversation is not waiting to be assigned any more.'
        /* A place with an own conversation has two ways to assign, and they are the page's to show:
           the header's press opens them rather than choosing one. With none, it becomes the own. */
        if (here.ownNow) {
          setAnswering(true)
          return true
        }
        void api.assign(at.projectPath, at.key, value, false, at.kehikkoName).finally(() => setAgain((n) => n + 1))
        return true
      }
      if (item !== 'sessions' || typeof value !== 'string') return 'That is not something here to go to.'
      if (value === 'list') {
        setAsking(true)
        setAgain((n) => n + 1)
      } else if (value === 'new') open(null)
      else if (offered?.some((one) => one.id === value)) open(value)
      else return 'That session is no longer one of this place’s.'
      return true
    }
  }

  return (
    <div className="bg-background text-foreground relative flex h-dvh min-h-0 flex-col">
      {/* The shared cover, whole, only while there is no session to look at.
          Once one has been on screen its last screen stays there when this
          module's server stops, and the words go in the strip below. */}
      {cover && !(view || installing) && <Cover state={cover} name={NAME} onRetry={knock} />}

      {!cover && at && refusal && !view && (
        <Cover state="refused" name={NAME} detail={refusal} onRetry={() => setAgain((n) => n + 1)} />
      )}

      {/* The project's conversations that belong to no place, and the answers to each: a line of
          their own at any width, which the Inbox's item reveals. */}
      {!cover && at && here && !installing && (
        <Unassigned
          rows={(here.unassigned ?? []).map((one) => ({ id: one.id, label: one.label }))}
          hereSaid={[at.kehikkoName, at.epic ?? 'no epic'].filter(Boolean).join(' · ')}
          hereOwn={here.ownNow ?? null}
          elsewhere={here.assignable ?? []}
          open={answering}
          onOpen={setAnswering}
          onAssign={async (session, key, own) => {
            if (!api.assign) return
            const there = key === null ? null : (here.assignable ?? []).find((one) => one.key === key)
            if (key !== null && !there) return
            try {
              await api.assign(at.projectPath, there ? there.key : at.key, session, own, there ? there.kehikko : at.kehikkoName)
            } finally {
              setAgain((n) => n + 1)
            }
          }}
          onIgnore={async (session) => {
            if (!api.ignore) return
            try {
              await api.ignore(at.projectPath, session)
            } finally {
              setAgain((n) => n + 1)
            }
          }}
        />
      )}

      {wanting && here && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4" data-install={here.program.lacks ? 'update' : 'install'}>
          <div title={here.program.lacks ? (here.program.found ?? '') : here.program.looked.join('\n')}>
            <Cover state="empty" name={NAME}>
              {here.program.lacks
                ? `${here.program.name} at ${here.program.foundAt} is too old for this: it has no ${here.program.lacks}.`
                : `${here.program.name} is not installed — looked in ${here.program.where}.`}
            </Cover>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-3 text-xs"
            title={`Runs, in a terminal here: ${here.program.install.line}`}
            onClick={() => {
              count.current += 1
              setInstalling({ n: count.current, failed: null })
            }}
          >
            {here.program.lacks ? 'Update' : 'Install'}
          </Button>
        </div>
      )}

      {choosing && here && (
        <div className="min-h-0 flex-1">
          <Chooser
            /* Remounted when the occasion changes: where the keyboard starts depends on it. */
            key={view ? 'sessions' : (step?.do ?? 'sessions')}
            mode={view ? 'sessions' : step?.do === 'offer' ? 'offer' : step?.do === 'choose' ? 'ask' : 'sessions'}
            listing={here}
            current={view?.session ?? null}
            onOpen={open}
            onClose={view ? () => setAsking(false) : undefined}
            onEnd={(session) => void api.end(session).finally(() => setTimeout(() => setAgain((n) => n + 1), 150))}
            onEnableHook={api.enableHook ? () => void api.enableHook!().finally(() => setAgain((n) => n + 1)) : undefined}
            onDetach={(session) => {
              if (!at) return
              if (remembered.at(projectOf(at)).read(at.key) === session) remembered.at(projectOf(at)).keep(at.key, null)
              void api.detach(at.projectPath, at.key, session).finally(() => setAgain((n) => n + 1))
            }}
          />
        </div>
      )}

      {/* A session another process has open: nothing was started, and the two answers are put in
          words where the terminal would be. */}
      {questioning && here && stuck && (
        <div className="min-h-0 flex-1">
          <ElsewhereQuestion
            program={here.program.name}
            label={labels[stuck.session] || [...here.sessions, ...here.others].find((one) => one.id === stuck.session)?.label || ''}
            there={stuck.there}
            onLeave={() => {
              setBlocked((was) => (was ? { ...was, left: true } : was))
              setAgain((n) => n + 1)
            }}
            onCopy={() => open(stuck.session, true)}
          />
        </div>
      )}

      {/* The installer, in a terminal of its own: the command on its first
          line, then everything it prints. Reached only by the press above. */}
      {installing && (
        <div className="min-h-0 flex-1" data-installing>
          <TerminalView
            key={installing.n}
            theme={theme}
            target={{ what: 'install' }}
            shown
            onStanding={(next) => {
              if (next.at !== 'closed') return
              if (next.code === INSTALLED) {
                /* Found. Carry on to the session for this place, without another press. */
                setInstalling(null)
                setAgain((n) => n + 1)
              } else {
                setInstalling((was) => (was ? { ...was, failed: next.why } : was))
              }
            }}
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1" hidden={!terminal}>
        <div className="relative h-full min-w-0 flex-1">
        {views.map((one) => {
          const shown = terminal && one.n === view?.n
          return (
            /* `hidden` rather than unmounted: the wrapper carries the attribute
               so the view's own holder keeps its size the moment it is shown. */
            <div key={one.n} hidden={!shown} className="h-full w-full" data-view={one.session ?? 'new'} data-place={one.at.key}>
              <TerminalView
                theme={theme}
                target={{
                  what: 'session',
                  projectPath: one.at.projectPath,
                  ...(one.at.projectId ? { projectId: one.at.projectId } : {}),
                  place: {
                    epic: one.at.epic,
                    parts: one.at.parts,
                    kehikko: one.at.kehikko,
                    kehikkoName: one.at.kehikkoName,
                    ...(one.at.kehikkoId === null ? {} : { kehikkoId: one.at.kehikkoId }),
                    ...(Object.keys(one.at.partNames).length ? { partNames: one.at.partNames } : {}),
                  },
                  session: one.session,
                  ...(one.copy ? { copy: true } : {}),
                }}
                shown={shown}
                watched={one.n === view?.n}
                onStanding={(next) => stood(one, next)}
                onSaid={(heard) => said(one, heard)}
              />
            </div>
          )
        })}
        </div>
        {/* The one control, in a gutter of its own beside the terminal: it takes columns and no row, and
            covers none of what the terminal prints. Which session this is is its title; the state is its
            glyph. Drawn only when the host does not draw the header (`drawsHeader`). */}
        {terminal && !ended && !hosted?.drawn && (
          <button
            type="button"
            data-sessions
            aria-label={`Sessions — ${label}${mark ? ` (${mark.word})` : ''}${how ? ` (${how.word})` : ''}`}
            title={`${doing?.state ? `Sessions for this place — this one: ${since(doing.state, doing.since, Date.now())}` : 'Sessions for this place'}${how ? `. ${how.means}` : ''}`}
            data-state={doing?.state ?? undefined}
            data-how={how?.word}
            className="text-muted-foreground hover:text-foreground hover:bg-accent flex w-5 shrink-0 flex-col items-center gap-1 border-l pt-1 font-mono text-[10px] opacity-70 hover:opacity-100 focus-visible:opacity-100"
            onClick={() => {
              setAsking(true)
              setAgain((n) => n + 1)
            }}
          >
            {mark ? (
              <span className={mark.colour} aria-hidden>
                {mark.glyph}
              </span>
            ) : null}
            <span className="max-h-[70%] min-h-0 truncate [writing-mode:vertical-rl]">
              {label}
              {how ? ` · ${how.word}` : ''}
              {' ▾'}
            </span>
          </button>
        )}
      </div>

      {cover && (view || installing) && <Cover strip state={cover} name={NAME} onRetry={knock} />}

      {/* The project's folder was renamed while this session ran. It goes on working there, under the
          old name; restarting it in the new folder is the person's to press, never done by itself. */}
      {terminal && view && movedTo && !ended && !cover && (
        <div className="flex items-center justify-between gap-2 border-t px-2 py-1" role="status" data-moved={movedTo}>
          <span className="text-muted-foreground min-w-0 text-[11px]">
            This folder was renamed to {movedTo}. Claude still uses the old path; restart in the new folder when it's idle.
            {notMoved ? ` ${notMoved}` : ''}
          </span>
          <span className="flex shrink-0 gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              disabled={working || !view.session || !api.restart}
              title={working ? 'It is working. Restart it when it is idle.' : 'Ends this session and resumes it in the new folder'}
              onClick={restartHere}
            >
              Restart in the new folder
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => {
                const was = moves[view.n]
                if (was) setDismissed((all) => ({ ...all, [view.n]: was }))
              }}
            >
              Dismiss
            </Button>
          </span>
        </div>
      )}

      {/* The kehikko's modules changed while this session ran: its tools are the old ones until it restarts. */}
      {terminal && view && doorsLine && !ended && !cover && (
        <div className="flex items-center justify-between gap-2 border-t px-2 py-1" role="status" data-doors>
          <span className="text-muted-foreground min-w-0 text-[11px]">
            {doorsLine.added.length ? `Restart to load ${doorsLine.added.join(', ')}’s tools.` : ''}
            {doorsLine.removed.length ? ` ${doorsLine.removed.join(', ')} left this kehikko; its tools stay until a restart.` : ''}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 px-2 text-xs"
            disabled={working}
            title={working ? 'It is working. Restart it when it is idle.' : 'Ends this session and resumes it with the doors of this kehikko now'}
            onClick={restartForDoors}
          >
            Restart
          </Button>
        </div>
      )}

      {terminal && ended && !cover && view && (
        <div className="flex items-center justify-between gap-2 border-t px-2 py-1" data-ended>
          <span className="text-muted-foreground truncate text-[11px]">{ended.why}</span>
          <span className="flex shrink-0 gap-1">
            <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => open(view.session)}>
              Resume
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              onClick={() => {
                setAsking(true)
                setAgain((n) => n + 1)
              }}
            >
              Sessions
            </Button>
          </span>
        </div>
      )}

      {installing?.failed && !cover && here && (
        <div className="flex items-center justify-between gap-2 border-t px-2 py-1" data-install-failed>
          <span className="text-muted-foreground min-w-0 text-[11px]">
            The install did not finish ({installing.failed}) — run <code className="text-foreground">{here.program.install.line}</code> in a terminal, then try again.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={() => {
              setInstalling(null)
              setAgain((n) => n + 1)
            }}
          >
            Try again
          </Button>
        </div>
      )}
    </div>
  )
}
