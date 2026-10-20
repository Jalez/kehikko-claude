import type { HeaderItemInput } from 'kehikot-module-protocol'

/**
 * Which conversation is this place's OWN, said in the container's frame.
 *
 * A place has one conversation of its own (`own` in record.ts): the one it
 * was started with, or the one a person made its own. A person can view
 * another one here — jumping to it from the list — and that does not make it
 * this place's: the frame says so, plainly, in the header the host draws, and
 * offers the two ways out: make the one on screen the place's own (which
 * rewrites the record), or go back to the place's own.
 *
 * The project's conversations that belong to no place — started outside
 * Kehikot and reported by Claude Code, or running here with no record — are
 * listed in the same header with "Assign to this kehikko", and a last option
 * that opens every answer in the page (`view/unassigned.tsx`): another
 * kehikko, or "Not a Kehikot conversation". The page also says so in a line
 * of its own, because this is a Go item, and a trigger that says "Go" — a
 * compass under 300 pixels, a "⋯" under 220 — does not say something is
 * waiting in it.
 *
 * Everything is header items, which the host lays out: words, then icons
 * under 300 pixels, then one "⋯" under 220 (`modeFor` in the host). A label
 * is cut here to what reads in one line.
 */

export const MAKE_OWN = 'make-own'
export const BACK_OWN = 'back-own'
export const UNASSIGNED = 'unassigned'
/** The Not-yet-assigned menu's last option: opens the answers in the page (another kehikko, or not a Kehikot conversation). */
export const ANSWER = 'answer'

const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text)

export interface OwnSaid {
  /** The Sessions item's label, replacing the usual one when the view is not the place's own. Null keeps it. */
  label: string | null
  /** The header items to add after the Sessions item. */
  items: HeaderItemInput[]
  /** Whether the view shows a conversation that is not this place's own. */
  other: boolean
}

export function ownHeader(o: {
  /** The place's own, null for none, undefined when the server did not say (an older one): then nothing is claimed. */
  own: string | null | undefined
  /** The Sessions item's usual label, which says the one on screen. */
  usual?: string
  viewing: string | null
  title: (id: string) => string
  unassigned: readonly { id: string; label: string }[]
  working: boolean
}): OwnSaid {
  const items: HeaderItemInput[] = []
  const other = o.own !== undefined && o.viewing !== null && o.own !== o.viewing
  let label: string | null = null
  if (other) {
    const viewing = cut(o.title(o.viewing!) || 'this conversation', 24)
    label = o.own ? `Viewing ${viewing} — not this kehikko’s own (${cut(o.title(o.own) || 'untitled', 20)})` : `Viewing ${viewing} — this kehikko has no own yet`
    items.push({
      kind: 'run',
      id: MAKE_OWN,
      label: 'Make this the kehikko’s own',
      icon: 'check',
    } as HeaderItemInput)
    if (o.own) items.push({ kind: 'run', id: BACK_OWN, label: 'Back to its own', icon: 'undo' } as HeaderItemInput)
  } else if (o.viewing && o.own === o.viewing) {
    label = o.usual && o.usual !== 'Sessions' ? `${o.usual} · this kehikko’s own` : `Own: ${cut(o.title(o.own) || 'this conversation', 44)}`
  }
  if (o.unassigned.length) {
    items.push({
      kind: 'go',
      id: UNASSIGNED,
      label: `Not yet assigned (${o.unassigned.length})`,
      options: [
        ...o.unassigned.slice(0, 40).map((one) => ({ id: one.id, label: cut(`Assign to this kehikko: ${one.label || one.id.slice(0, 8)}`, 64) })),
        { id: ANSWER, label: 'Another kehikko, or not a Kehikot conversation…' },
      ],
    })
  }
  return { label: label ? cut(label, 72) : null, items, other }
}
