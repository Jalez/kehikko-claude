import { useState } from 'react'

import type { Assignable, OwnConversation } from '../../doors.ts'
import { ago } from './places.ts'
import { Button } from '@/components/ui/button'

/**
 * The project's conversations that belong to no place, and the person's
 * answer to each — drawn in this container's own page, at any width.
 *
 * Claude Code sessions started outside Kehikot (in a terminal, as a
 * background job, by an agent) are reported here and belong nowhere until
 * somebody says. The Inbox counts them in one quiet item per project, and
 * opening that item reveals this container; the answers are here, not only
 * under the header's Go menu, because a menu called "Go" — or a compass, or a
 * "⋯", at the widths a container usually has — does not say that something is
 * waiting in it.
 *
 * One line while closed: how many, and "Answer". Open, a row per
 * conversation with three answers:
 *
 *  - **Assign here** — to the place this container stands on.
 *  - **Assign to…** — another place the record knows, grouped by kehikko,
 *    each kehikko's most recently used place first.
 *  - **Not a Kehikot conversation** — recorded like an assignment (`ignored`
 *    in record.ts), so it is never listed or counted again.
 *
 * Each press is a person's say and rewrites the record; the list is read
 * again after, which is what takes the row away.
 */

export interface UnassignedRow {
  id: string
  label: string
}

export const NOT_KEHIKOT = 'Not a Kehikot conversation'

const titled = (own: OwnConversation) => own.title || 'untitled'

/** What a place's own conversation is, said at every assign target: its title and when it was last active, or that it has none. */
export function ownLine(own: OwnConversation | null | undefined, now: number): string {
  if (!own) return 'No conversation of its own yet'
  const when = ago(own.lastActive, now)
  return `Own conversation: ${titled(own)}${when ? ` · last active ${when}` : ''}`
}

/**
 * The choices at one target. With an own conversation there are two: file it
 * and keep that one, or make it the own and leave that one listed there.
 * Without one there is a single choice, and it becomes the own.
 */
export function assignChoices(own: OwnConversation | null | undefined): { own: boolean; label: string }[] {
  if (!own) return [{ own: false, label: 'Assign here (becomes this kehikko’s own)' }]
  return [
    { own: false, label: `Assign here (keeps ${titled(own)} as this kehikko’s own)` },
    { own: true, label: `Assign and make it this kehikko’s own (replaces ${titled(own)})` },
  ]
}

export function unassignedLine(n: number): string {
  const said = n === 1 ? 'A Claude Code session in this project isn’t assigned to a kehikko.' : `${n} Claude Code sessions in this project aren’t assigned to a kehikko.`
  /* The other way to answer, from inside the conversation itself (see here.ts). */
  return `${said} Answer here, or type /kehikot-here in that conversation.`
}

export function Unassigned({
  rows,
  hereSaid,
  hereOwn,
  elsewhere,
  open,
  onOpen,
  onAssign,
  onIgnore,
}: {
  rows: readonly UnassignedRow[]
  /** This container's place in a few words, for the "Assign here" button's title. */
  hereSaid: string
  /** This container's place's own conversation, null when it has none. */
  hereOwn: OwnConversation | null
  elsewhere: readonly Assignable[]
  open: boolean
  onOpen: (open: boolean) => void
  /** `key` null: here. Otherwise one of `elsewhere`. `own`: make it that place's own, replacing the one it has. */
  onAssign: (session: string, key: string | null, own: boolean) => Promise<unknown>
  onIgnore: (session: string) => Promise<unknown>
}) {
  /* The place picked from "Assign to…" for a row: its choices are shown before anything is filed. */
  const [picked, setPicked] = useState<Readonly<Record<string, string>>>({})
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  if (!rows.length) return null
  /* One answer at a time per row; the row comes back if the answer was not taken. */
  const pressed = (session: string, act: () => Promise<unknown>) => {
    setBusy((was) => new Set(was).add(session))
    void act()
      .catch(() => {})
      .finally(() =>
        setBusy((was) => {
          const next = new Set(was)
          next.delete(session)
          return next
        }),
      )
  }
  const now = Date.now()
  const kehikot = [...new Set(elsewhere.map((one) => one.kehikko))]

  return (
    <div className="border-b px-2 py-1 text-[11px]" role="region" aria-label="Unassigned Claude Code sessions" data-unassigned>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground min-w-0">{unassignedLine(rows.length)}</span>
        <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" aria-expanded={open} onClick={() => onOpen(!open)}>
          {open ? 'Later' : 'Answer'}
        </Button>
      </div>
      {open && (
        <ul className="mt-1 flex max-h-56 flex-col gap-1 overflow-auto" data-unassigned-list>
          {rows.map((row) => {
            const name = row.label || `Session ${row.id.slice(0, 8)}`
            const waiting = busy.has(row.id)
            return (
              <li key={row.id} className="flex flex-col gap-1 rounded-sm border px-1.5 py-1" data-unassigned-row={row.id}>
                <span className="truncate text-xs" title={`${name} (${row.id})`}>
                  {name}
                </span>
                <span className="text-muted-foreground" data-own-here>
                  This kehikko · {ownLine(hereOwn, now)}
                </span>
                <span role="group" aria-label={`answers for ${name}`} className="flex flex-wrap items-center gap-1">
                  {assignChoices(hereOwn).map((choice) => (
                    <Button
                      key={String(choice.own)}
                      size="sm"
                      variant="outline"
                      className="h-auto min-h-6 px-2 py-0.5 text-left text-[11px] whitespace-normal"
                      disabled={waiting}
                      title={`Assign it to this kehikko: ${hereSaid}`}
                      onClick={() => pressed(row.id, () => onAssign(row.id, null, choice.own))}
                    >
                      {choice.label}
                    </Button>
                  ))}
                  {elsewhere.length > 0 && (
                    <select
                      aria-label={`Assign ${name} to another place`}
                      className="bg-background h-6 max-w-48 rounded-md border px-1 text-[11px]"
                      disabled={waiting}
                      value=""
                      onChange={(event) => {
                        const key = event.target.value
                        if (key) setPicked((was) => ({ ...was, [row.id]: key }))
                      }}
                    >
                      <option value="">Assign to…</option>
                      {kehikot.map((kehikko) => (
                        <optgroup key={kehikko} label={kehikko}>
                          {elsewhere
                            .filter((one) => one.kehikko === kehikko)
                            .map((one) => (
                              <option key={one.key} value={one.key}>
                                {`${kehikko} · ${one.label} — ${one.own ? `own: ${titled(one.own)}` : 'no own yet'}`}
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    disabled={waiting}
                    title="Never ask about it again: a background job, an agent's run, or anything not meant for a kehikko"
                    onClick={() => pressed(row.id, () => onIgnore(row.id))}
                  >
                    {NOT_KEHIKOT}
                  </Button>
                </span>
                {(() => {
                  const there = elsewhere.find((one) => one.key === picked[row.id])
                  if (!there) return null
                  return (
                    <span role="group" aria-label={`choices at ${there.kehikko} · ${there.label}`} className="flex flex-col gap-1 rounded-sm border px-1.5 py-1" data-assign-there={there.key}>
                      <span className="text-muted-foreground">
                        {there.kehikko} · {there.label} · {ownLine(there.own, now)}
                      </span>
                      <span className="flex flex-wrap items-center gap-1">
                        {assignChoices(there.own).map((choice) => (
                          <Button
                            key={String(choice.own)}
                            size="sm"
                            variant="outline"
                            className="h-auto min-h-6 px-2 py-0.5 text-left text-[11px] whitespace-normal"
                            disabled={waiting}
                            onClick={() => pressed(row.id, () => onAssign(row.id, there.key, choice.own))}
                          >
                            {choice.label}
                          </Button>
                        ))}
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setPicked((was) => ({ ...was, [row.id]: '' }))}>
                          Cancel
                        </Button>
                      </span>
                    </span>
                  )
                })()}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
