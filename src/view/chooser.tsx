import { useEffect, useMemo, useRef, useState } from 'react'

import type { Listing, Row } from '../../doors.ts'
import { readPlaceKey } from '../../place.ts'
import { ago, named } from './places.ts'

/**
 * The list a person chooses a session from, drawn where the terminal would be.
 *
 * Three occasions, one list:
 *
 *  - **`ask`**: the place has more than one session, and nothing is opened
 *    until one is chosen. There is no way out of it but choosing.
 *  - **`sessions`**: the person pressed the control in the corner of a
 *    running terminal. The same list with the one on screen marked; Escape
 *    goes back to it.
 *  - **`full`**: as many sessions are running as this module keeps. Nothing
 *    is ended to make room — the list is of what is running, and the person
 *    ends the one they choose.
 *
 * Every row is a button, so the pointer and Tab both reach all of it. On top
 * of that the list itself takes the keyboard: the arrows (or j and k) move,
 * Enter opens, and a digit opens that row outright.
 *
 * ## A session that is not on this computer
 *
 * The record is in the project and may arrive on another computer; the
 * sessions do not (see `record.ts`). A row the record lists and Claude Code
 * has nothing for here is still drawn — the list should agree with the file,
 * and its first prompt says what it was — but muted, with the reason in a
 * few words where "running" would be, and it does not open: there is nothing
 * here to resume, and starting the program under its id would be a different
 * conversation. It can still be taken off the place. No row is added to say
 * any of this.
 */

/** Why a row cannot be opened, in the fewest words that are true of both ways it happens. */
export const NOT_HERE = 'not on this computer'
const NOT_HERE_WHY =
  'Claude Code has no record of this session on this computer: it was started on another one, or its transcript has '
  + 'since been cleaned away. It stays in the record, and opens where it exists.'

type Item =
  | { kind: 'session'; row: Row; attach: boolean }
  | { kind: 'new' }
  | { kind: 'attach' }
  | { kind: 'running'; id: string; label: string; projectPath: string; place: string | null; here: boolean }

/** Where a running session is, in the words a person would use: its project when it is another one, then the epic and the parts. */
function whereabouts(item: { projectPath: string; place: string | null; here: boolean }, sameProject: boolean): string {
  if (item.here) return 'here'
  const place = item.place ? readPlaceKey(item.place) : null
  const words = place ? [place.epic ?? 'no epic', place.parts.length ? place.parts.join(' + ') : 'all parts'].join(' · ') : ''
  return sameProject ? words : [item.projectPath.split('/').pop(), words].filter(Boolean).join(' · ')
}

export function Chooser({
  mode,
  listing,
  project = null,
  current = null,
  now = Date.now(),
  onOpen,
  onEnd,
  onDetach,
  onClose,
}: {
  mode: 'ask' | 'sessions' | 'full'
  listing: Listing
  /** The open project's folder, so a session running in another one can say so. */
  project?: string | null
  /** The session on screen behind this list, if there is one. */
  current?: string | null
  now?: number
  /** Open this session here; null is a new one. Attaching one from elsewhere is the same act. */
  onOpen: (session: string | null) => void
  onEnd: (session: string) => void
  onDetach: (session: string) => void
  onClose?: () => void
}) {
  const [others, setOthers] = useState(false)
  /* Where the keyboard starts: the first row that can be opened. A session that is not on this
     computer is listed where it was added, which may be first, and Enter on it would do nothing. */
  const [at, setAt] = useState(() => {
    if (mode === 'full') return 0
    const first = listing.sessions.findIndex((row) => !row.missing)
    return first === -1 ? listing.sessions.length : first
  })
  const list = useRef<HTMLDivElement>(null)

  const items = useMemo<Item[]>(() => {
    if (mode === 'full') return listing.running.map((run) => ({ kind: 'running', ...run }))
    return [
      ...listing.sessions.map((row): Item => ({ kind: 'session', row, attach: false })),
      { kind: 'new' },
      ...(listing.others.length ? [{ kind: 'attach' } as Item] : []),
      ...(others ? listing.others.map((row): Item => ({ kind: 'session', row, attach: true })) : []),
    ]
  }, [mode, listing, others])

  /* The list takes the keyboard as it appears: a person who was typing in a
     terminal a moment ago should not have to reach for the pointer. */
  useEffect(() => {
    list.current?.focus()
  }, [mode])

  const reach = Math.min(at, Math.max(0, items.length - 1))

  const act = (item: Item | undefined) => {
    if (!item) return
    if (item.kind === 'session') {
      if (!item.row.missing) onOpen(item.row.id)
    } else if (item.kind === 'new') onOpen(null)
    else if (item.kind === 'attach') setOthers((open) => !open)
    else onEnd(item.id)
  }

  const key = (event: React.KeyboardEvent) => {
    /* A press on a button inside the list is that button's, not the list's. */
    if (event.target !== event.currentTarget && (event.key === 'Enter' || event.key === ' ')) return
    if (event.key === 'ArrowDown' || event.key === 'j') setAt(Math.min(items.length - 1, reach + 1))
    else if (event.key === 'ArrowUp' || event.key === 'k') setAt(Math.max(0, reach - 1))
    else if (event.key === 'Enter' || event.key === ' ') act(items[reach])
    else if (event.key === 'Escape') onClose?.()
    else if (/^[1-9]$/.test(event.key) && Number(event.key) <= items.length) act(items[Number(event.key) - 1])
    else return
    event.preventDefault()
  }

  const said =
    mode === 'full'
      ? `${listing.running.length} sessions are running, which is as many as this module keeps — end one to open this one.`
      : mode === 'ask'
        ? 'More than one session belongs here. Which one?'
        : 'Sessions here'

  return (
    <div
      ref={list}
      tabIndex={0}
      role="listbox"
      aria-label={said}
      data-chooser={mode}
      onKeyDown={key}
      className="flex h-full min-h-0 flex-col gap-0.5 overflow-auto p-2 font-mono text-xs outline-none"
    >
      <p className="text-muted-foreground px-2 pb-1">{said}</p>
      {items.map((item, index) => {
        const on = index === reach
        const shell = `flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left ${on ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'}`
        const number = <span className="text-muted-foreground w-3 shrink-0 text-right">{index < 9 ? index + 1 : ''}</span>

        if (item.kind === 'new' || item.kind === 'attach') {
          return (
            <button key={item.kind} type="button" role="option" aria-selected={on} data-row={item.kind} className={shell} onClick={() => act(item)} onMouseMove={() => setAt(index)}>
              {number}
              <span>{item.kind === 'new' ? 'New session' : others ? 'Attach an existing session ▾' : `Attach an existing session… (${listing.others.length})`}</span>
            </button>
          )
        }

        if (item.kind === 'running') {
          return (
            <div key={item.id} role="option" aria-selected={on} data-row="running" className={shell} onMouseMove={() => setAt(index)}>
              {number}
              <span className="min-w-0 flex-1 truncate">{item.label || 'No prompt yet'}</span>
              <span className="text-muted-foreground min-w-0 shrink truncate" title={item.projectPath}>
                {whereabouts(item, item.projectPath === project)}
              </span>
              <button type="button" className="hover:bg-background shrink-0 rounded border px-1.5" onClick={() => onEnd(item.id)}>
                End
              </button>
            </div>
          )
        }

        const { row } = item
        if (row.missing) {
          return (
            <div key={row.id} role="option" aria-selected={on} aria-disabled data-row="missing" data-session={row.id} className={shell} onMouseMove={() => setAt(index)}>
              {number}
              <span className="text-muted-foreground flex min-w-0 flex-1 items-center gap-2" title={NOT_HERE_WHY}>
                <span className="min-w-0 flex-1 truncate">{named(row)}</span>
                <span className="shrink-0">{NOT_HERE}</span>
                <span className="shrink-0">{ago(row.lastActive, now)}</span>
              </span>
              <button
                type="button"
                className="hover:bg-background text-muted-foreground shrink-0 rounded border px-1.5"
                title="Take this session off this place. It stays in the record’s list of sessions, and can be attached again where it exists."
                aria-label="Remove from this place"
                onClick={() => onDetach(row.id)}
              >
                ×
              </button>
            </div>
          )
        }
        return (
          <div key={row.id} role="option" aria-selected={on} data-row={item.attach ? 'other' : 'session'} data-session={row.id} className={shell} onMouseMove={() => setAt(index)}>
            {number}
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onOpen(row.id)} title={row.id}>
              <span className="min-w-0 flex-1 truncate">{named(row)}</span>
              {row.id === current ? <span className="text-muted-foreground shrink-0">on screen</span> : null}
              {row.running ? (
                <span className="flex shrink-0 items-center gap-1">
                  <span className="bg-running size-1.5 rounded-full" aria-hidden />
                  running
                </span>
              ) : null}
              <span className="text-muted-foreground shrink-0">{ago(row.lastActive, now)}</span>
            </button>
            {row.running ? (
              <button type="button" className="hover:bg-background shrink-0 rounded border px-1.5" title="End this session’s process. It can be resumed." onClick={() => onEnd(row.id)}>
                End
              </button>
            ) : null}
            {!item.attach ? (
              <button
                type="button"
                className="hover:bg-background text-muted-foreground shrink-0 rounded border px-1.5"
                title="Take this session off this place. The session is kept and can be attached again."
                aria-label="Remove from this place"
                onClick={() => onDetach(row.id)}
              >
                ×
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
