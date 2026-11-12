import { useEffect, useState } from 'react'
import { useHost } from 'kehikot-module-protocol/client/react'

import { ID } from '../../manifest.ts'
import { api as realApi, type Api } from '../api.ts'
import { TerminalView, type Target } from './terminal-view.tsx'

/**
 * `agent.tasks`'s view (protocol 2.88.0): `/app?session=<id>`, one conversation and nothing else,
 * which the host frames in a dialog of its own while a task it started runs — with no greeting. The
 * conversation's project and place are asked of this module's server (`/api/task`), which knows
 * them from the run holding it; the terminal is the same view a place shows (`TerminalView`).
 * A greeting that does come still gives the page its theme and takes its `ready`.
 */

/** A Claude Code session id, as `program.ts` spells one. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The conversation a page address asks to show alone, or null for the usual page. */
export function taskSession(search: string): string | null {
  const id = new URLSearchParams(search).get('session')
  return id && SESSION_ID.test(id) ? id : null
}

export function TaskPage({ session, api = realApi }: { session: string; api?: Api }) {
  const host = useHost(ID)
  const [target, setTarget] = useState<Target | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  useEffect(() => {
    let left = false
    void (async () => {
      try {
        const at = await api.task?.(session)
        if (left) return
        if (!at) return setSaid('This conversation is not running here, and no task started it.')
        setTarget({ what: 'session', projectPath: at.projectPath, place: at.place, session })
      } catch (error) {
        if (!left) setSaid(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      left = true
    }
  }, [api, session])
  return (
    <div data-kehikot-page data-task={session} className="text-foreground relative flex h-dvh min-h-0 flex-col">
      {target ? (
        <div className="relative h-full min-w-0 flex-1">
          <TerminalView theme={host.theme} target={target} shown onDrawn={host.ready} />
        </div>
      ) : (
        <p className="text-muted-foreground p-4 text-sm" data-task-said>
          {said ?? 'Opening the conversation…'}
        </p>
      )}
    </div>
  )
}
