import { useEffect, useMemo, useRef, useState } from 'react'
import { held, probeServer } from 'kehikot-module-protocol/client'
import { Cover, coverFor, useFocus, useHost, useServerStanding, type CoverState } from 'kehikot-module-protocol/client/react'

import type { Listing } from '../doors.ts'
import { ID } from '../manifest.ts'
import { api as realApi, type Api } from './api.ts'
import { Chooser } from './view/chooser.tsx'
import { MOST_VIEWS, brief, decide, lookedIn, placeId, standing, surplus, type Standing as Place, type View } from './view/places.ts'
import { TerminalView, type Standing } from './view/terminal-view.tsx'
import { Button } from '@/components/ui/button'

/** What the shared sentences call this module. */
const NAME = 'Claude'

/** The server's reasons for closing a socket that the page acts on (`CLOSED` in live.ts). */
const INSTALLED = 4010
const MISSING = 4404
const FULL = 4429

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
 * what was on screen. Scoped by project and keyed by place, so a choice made
 * in one place cannot land in another.
 */
const remembered = held<string>('kehikot.claude.showing', (stored) => (typeof stored === 'string' && stored ? stored : null))

export function App() {
  const host = useHost(ID, {
    /* Answered at once and always no: a terminal holds a session, not a
       document with anchors, and silence would make every reference pointing
       here sit out the host's timeout first. */
    onGoto: (_goto, answer) => {
      answer(false, 'A terminal holds a session, not a document: there is nothing here to walk to.')
    },
  })
  /* The parts as one steady value: the same array until the list changes by
     value, so the place below moves when a part is picked and not every time
     the host speaks. */
  const { parts } = useFocus(host)
  const { where, projectPath, epic, kehikko } = host
  const at = useMemo(
    () => standing({ where, projectPath, epic, parts, kehikko }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [where, projectPath, epic, parts, kehikko?.id, kehikko?.name],
  )
  const server = useServerStanding()
  const cover = coverFor({ where, projectPath, server })
  return <Sessions theme={host.theme} at={at} cover={cover} />
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
 * ## What is drawn besides the terminal
 *
 * Nothing that costs a row while a session is running. The session's short
 * label and the way to the list sit in the terminal's own corner, over it.
 * A strip appears along the bottom only when there is nothing running to
 * take the space from: the session has ended, the install did not finish, or
 * this module's server has gone.
 */
export function Sessions({
  theme,
  at,
  cover = null,
  api = realApi,
}: {
  theme: 'light' | 'dark'
  /** The place the canvas is about, or null when there is nothing to open. */
  at: Place | null
  /** The shared not-ready state — waiting, unhosted, no project, server down, page stale — or none. */
  cover?: CoverState | null
  api?: Api
}) {
  const [views, setViews] = useState<View[]>([])
  /** Which view each place shows, by `placeId`. */
  const [shownBy, setShownBy] = useState<Record<string, number>>({})
  const [standings, setStandings] = useState<Record<number, Standing>>({})
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [listing, setListing] = useState<{ id: string; value: Listing } | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  /** The person opened the list over a running terminal. */
  const [asking, setAsking] = useState(false)
  /** An open was refused because as many sessions are running as are kept. */
  const [full, setFull] = useState(false)
  /** The installer's own view, while it runs and after it fails. */
  const [installing, setInstalling] = useState<{ n: number; failed: string | null } | null>(null)
  const [again, setAgain] = useState(0)
  const count = useRef(0)

  const id = at ? placeId(at) : null
  const here = listing && listing.id === id ? listing.value : null
  const view = id !== null ? (views.find((one) => one.n === shownBy[id]) ?? null) : null

  /* The canvas moved, or something changed that the list should reflect. */
  const project = at?.projectPath ?? null
  const key = at?.key ?? null
  useEffect(() => {
    if (!project || !key) return
    let live = true
    setRefusal(null)
    api
      .place(project, key)
      .then((value) => live && setListing({ id: placeId({ projectPath: project, key }), value }))
      .catch((error: unknown) => live && setRefusal(error instanceof Error ? error.message : String(error)))
    return () => {
      live = false
    }
  }, [project, key, again, api])

  /* Another place: the list that was open over the last one is not about this one. */
  useEffect(() => setAsking(false), [project, key])

  const drop = (n: number) => {
    setViews((all) => all.filter((one) => one.n !== n))
    setShownBy((all) => Object.fromEntries(Object.entries(all).filter(([, shown]) => shown !== n)))
    setStandings(({ [n]: _gone, ...rest }) => rest)
  }

  /** Put a session on screen for this place: null is a new one. */
  const open = (session: string | null) => {
    if (!at || id === null) return
    setAsking(false)
    const was = views.find((one) => one.n === shownBy[id])
    if (was && session && was.session === session && standings[was.n]?.at !== 'closed') return
    count.current += 1
    const next: View = { n: count.current, at, session, shownAt: Date.now() }
    const kept = [...views.filter((one) => one.n !== was?.n), next]
    const gone = surplus(kept, next.n, MOST_VIEWS).map((one) => one.n)
    setViews(kept.filter((one) => !gone.includes(one.n)))
    setShownBy((all) => ({ ...Object.fromEntries(Object.entries(all).filter(([, shown]) => !gone.includes(shown))), [id]: next.n }))
    if (session) remembered.at(at.projectPath).keep(at.key, session)
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
    if (!at || !here || view || installing || full) return
    const step = decide(here, remembered.at(at.projectPath).read(at.key))
    if (step.do === 'open') opened.current(step.session)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here, view === null, installing === null, full])

  /* Looked at again: this is the most recently shown, for when views are let go. */
  useEffect(() => {
    if (view) setViews((all) => all.map((one) => (one.n === view.n ? { ...one, shownAt: Date.now() } : one)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.n])

  const stood = (one: View, next: Standing) => {
    if (next.at === 'closed' && next.code === FULL) {
      /* Refused for room. Nothing was ended; the person is shown what is running. */
      drop(one.n)
      setFull(true)
      setListing(null)
      setAgain((n) => n + 1)
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

  const said = (one: View, heard: { session?: string | null; label?: string }) => {
    const session = heard.session
    if (session) {
      setViews((all) => all.map((each) => (each.n === one.n && each.session !== session ? { ...each, session } : each)))
      remembered.at(one.at.projectPath).keep(one.at.key, session)
      if (heard.label) setLabels((all) => ({ ...all, [session]: heard.label! }))
    }
  }

  const step = here && !view ? decide(here, null) : null
  const standingNow = view ? standings[view.n] : undefined
  const ended = standingNow?.at === 'closed' ? standingNow : null
  const fullNow = full && here !== null && here.running.length >= here.most
  useEffect(() => {
    if (full && here && here.running.length < here.most) setFull(false)
  }, [full, here])

  const choosing = Boolean(at && here && !installing && (fullNow || asking || (!view && step?.do === 'choose')))
  const wanting = Boolean(at && here && !installing && !view && !fullNow && step?.do === 'install')
  const terminal = Boolean(at && view && !choosing && !installing)
  const label = view ? brief((view.session && (labels[view.session] || here?.sessions.find((one) => one.id === view.session)?.label)) || '') : ''

  return (
    <div className="bg-background text-foreground relative flex h-dvh min-h-0 flex-col">
      {/* The shared cover, whole, only while there is no session to look at.
          Once one has been on screen its last screen stays there when this
          module's server stops, and the words go in the strip below. */}
      {cover && !(view || installing) && <Cover state={cover} name={NAME} onRetry={knock} />}

      {!cover && at && refusal && !view && (
        <Cover state="refused" name={NAME} detail={refusal} onRetry={() => setAgain((n) => n + 1)} />
      )}

      {wanting && here && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4" data-install={here.program.lacks ? 'update' : 'install'}>
          <div title={here.program.lacks ? (here.program.found ?? '') : here.program.looked.join('\n')}>
            <Cover state="empty" name={NAME}>
              {here.program.lacks
                ? `${here.program.name} at ${here.program.found} is too old for this: it has no ${here.program.lacks}.`
                : `${here.program.name} is not installed — looked in ${lookedIn(here.program.looked)}.`}
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
            mode={fullNow ? 'full' : view ? 'sessions' : 'ask'}
            listing={here}
            current={view?.session ?? null}
            onOpen={open}
            onClose={view ? () => setAsking(false) : undefined}
            onEnd={(session) => void api.end(session).finally(() => setTimeout(() => setAgain((n) => n + 1), 150))}
            onDetach={(session) => {
              if (!at) return
              if (remembered.at(at.projectPath).read(at.key) === session) remembered.at(at.projectPath).keep(at.key, null)
              void api.detach(at.projectPath, at.key, session).finally(() => setAgain((n) => n + 1))
            }}
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

      <div className="min-h-0 flex-1" hidden={!terminal}>
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
                  place: { epic: one.at.epic, parts: one.at.parts, kehikko: one.at.kehikko, kehikkoName: one.at.kehikkoName },
                  session: one.session,
                }}
                shown={shown}
                onStanding={(next) => stood(one, next)}
                onSaid={(heard) => said(one, heard)}
              />
            </div>
          )
        })}
      </div>

      {/* The one control, in the terminal's own corner: which session this is,
          and the way to the others. Over the terminal, so it costs no row. */}
      {terminal && !ended && (
        <button
          type="button"
          data-sessions
          aria-label={`Sessions — ${label}`}
          title="Sessions for this place"
          className="bg-background/70 text-muted-foreground hover:text-foreground hover:bg-background absolute top-1 right-4 z-10 max-w-[60%] truncate rounded border px-1.5 py-0.5 font-mono text-[10px] opacity-60 backdrop-blur-sm hover:opacity-100 focus-visible:opacity-100"
          onClick={() => {
            setAsking(true)
            setAgain((n) => n + 1)
          }}
        >
          {label} ▾
        </button>
      )}

      {cover && (view || installing) && <Cover strip state={cover} name={NAME} onRetry={knock} />}

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
