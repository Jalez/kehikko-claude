import { useEffect, useMemo, useRef, useState } from 'react'

import type { Listing, Row } from '../../doors.ts'
import { MARKS, ago, named, since } from './places.ts'

/**
 * The list a person chooses a session from, drawn where the terminal would be.
 *
 * Two occasions, one list:
 *
 *  - **`ask`**: the place has more than one session, and nothing is opened
 *    until one is chosen. There is no way out of it but choosing.
 *  - **`sessions`**: the person pressed the control in the corner of a
 *    running terminal. The same list with the one on screen marked; Escape
 *    goes back to it.
 *
 * It is never drawn to stand in the way. There was a third occasion — as
 * many sessions running as the module would keep, and a list to end one from
 * — and it is gone with the limit it belonged to (see live.ts). `End` is on a
 * running session's own row for a person who wants it, and nobody is asked
 * to press it.
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
 *
 * ## What a running session is doing
 *
 * Where a running row said "running" it says what the session's program
 * last said it is doing — working, needs you, finished — as a glyph and the
 * word, in the same place on the same line. One that has not said (a copy
 * too old to, or a session nobody has spoken to) still says "running".
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
  mode: 'ask' | 'sessions'
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
  /* Where the keyboard starts: the first row that can be opened. A session that is not on this
     computer is listed where it was added, which may be first, and Enter on it would do nothing. */
  const [at, setAt] = useState(() => {
    const first = listing.sessions.findIndex((row) => !row.missing)
    return first === -1 ? listing.sessions.length : first
  })
  const list = useRef<HTMLDivElement>(null)

  const items = useMemo<Item[]>(() => {
    return [
      ...listing.sessions.map((row): Item => ({ kind: 'session', row, attach: false })),
      { kind: 'new' },
      ...(listing.others.length ? [{ kind: 'attach' } as Item] : []),
      ...(others ? listing.others.map((row): Item => ({ kind: 'session', row, attach: true })) : []),
    ]
  }, [listing, others])

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
    else setOthers((open) => !open)
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

  const said = mode === 'ask' ? 'More than one session belongs here. Which one?' : 'Sessions here'

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
                row.state ? (
                  /* What its program says it is doing, where "running" was: a glyph and the word, in the same place. */
                  <span className="flex shrink-0 items-center gap-1" data-state={row.state} title={since(row.state, row.since, now)}>
                    <span className={MARKS[row.state].colour} aria-hidden>
                      {MARKS[row.state].glyph}
                    </span>
                    {MARKS[row.state].word}
                  </span>
                ) : (
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="bg-running size-1.5 rounded-full" aria-hidden />
                    running
                  </span>
                )
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
