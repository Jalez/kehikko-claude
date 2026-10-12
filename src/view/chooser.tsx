import { useEffect, useMemo, useRef, useState } from 'react'

import type { Listing, Row } from '../../doors.ts'
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
 */

type Item =
  | { kind: 'session'; row: Row; attach: boolean }
  | { kind: 'new' }
  | { kind: 'attach' }
  | { kind: 'running'; id: string; label: string; projectPath: string; here: boolean }

export function Chooser({
  mode,
  listing,
  current = null,
  now = Date.now(),
  onOpen,
  onEnd,
  onDetach,
  onClose,
}: {
  mode: 'ask' | 'sessions' | 'full'
  listing: Listing
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
  const [at, setAt] = useState(0)
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
    if (item.kind === 'session') onOpen(item.row.id)
    else if (item.kind === 'new') onOpen(null)
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
                {item.here ? 'here' : item.projectPath.split('/').pop()}
              </span>
              <button type="button" className="hover:bg-background shrink-0 rounded border px-1.5" onClick={() => onEnd(item.id)}>
                End
              </button>
            </div>
          )
        }

        const { row } = item
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
