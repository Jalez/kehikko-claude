import { answered, ask, follow, ticket } from 'kehikot-module-protocol/client'

import type { Listing } from '../doors.ts'
import type { ActivityRow, Notice, Stated } from '../live.ts'

/**
 * This module's own `/api`, as the page calls it. `ask` carries the ticket —
 * on the read as well, since the read says what somebody has been working on
 * (see doors.ts) — and turns every failure into one sentence.
 */
export interface Api {
  /** What this place holds: its sessions, the project's others, what is running, and whether the program is there. */
  place(projectPath: string, key: string, projectId?: string | null): Promise<Listing>
  /**
   * Bring what an older release filed under a kehikko's row number across to
   * its key. Asked once per kehikko, before the first read of a place on it.
   */
  rekey(projectPath: string, kehikko: { key: string; name: string; id?: number }): Promise<void>
  /** End a running session, because a person chose that one. */
  end(session: string): Promise<void>
  /**
   * Resume a running session in its project's new folder, because a person pressed that after the
   * folder was renamed: the server ends it and its views open it again. Refused while it is working.
   */
  restart?(session: string, why?: 'moved' | 'doors'): Promise<void>
  /**
   * A person's say about where a conversation belongs: assign one that belongs nowhere to this
   * place, or — `own` — make the one on screen this place's own. Rewrites the record.
   */
  assign?(projectPath: string, key: string, session: string, own: boolean, kehikkoName?: string): Promise<void>
  /** Which doors a running session would be given now that it was not; null when not known. */
  doors?(session: string): Promise<{ added: string[]; removed: string[] } | null>
  /** Install Claude Code's SessionStart hook that reports sessions started outside Kehikot; says the file written. */
  enableHook?(): Promise<{ file: string; already: boolean }>
  /** Take a session off a place. The session itself is kept. */
  detach(projectPath: string, key: string, session: string): Promise<void>
  /**
   * Follow what changes while the page is open: every running session's
   * state, and — when `notices` says a host is there to pass them to — the
   * notices raised for a person who is not looking, and the whole activity
   * list (on arrival and on every change). Returns the function that
   * stops following.
   */
  feed?(notices: boolean, heard: { state(stated: Stated): void; notice(notice: Notice): void; activity?(items: ActivityRow[]): void; sessions?(): void }, project?: string | null): () => void
}

export const api: Api = {
  async place(projectPath, key, projectId) {
    return answered(await ask<Listing>('./api/place', { query: { projectPath, key, ...(projectId ? { projectId } : {}) }, ticket: true }))
  },
  async rekey(projectPath, kehikko) {
    answered(await ask('./api/rekey', { body: { projectPath, kehikko } }))
  },
  async end(session) {
    answered(await ask('./api/end', { body: { session } }))
  },
  async restart(session, why = 'moved') {
    answered(await ask('./api/restart', { body: { session, why } }))
  },
  async assign(projectPath, key, session, own, kehikkoName) {
    answered(await ask('./api/assign', { body: { projectPath, key, session, own, ...(kehikkoName ? { names: { kehikko: kehikkoName } } : {}) } }))
  },
  async doors(session) {
    return answered(await ask<{ ok: true; changed: { added: string[]; removed: string[] } | null }>('./api/doors', { query: { session }, ticket: true })).changed
  },
  async enableHook() {
    const said = answered(await ask<{ ok: true; file: string; already: boolean }>('./api/hook', { body: {} }))
    return { file: said.file, already: said.already }
  },
  async detach(projectPath, key, session) {
    answered(await ask('./api/detach', { body: { projectPath, key, session } }))
  },
  feed(notices, heard, project) {
    return follow<Stated | Notice | { items: ActivityRow[] }>(
      './api/feed',
      (event, name) => name === 'notice'
          ? heard.notice(event as Notice)
          : name === 'activity'
            ? heard.activity?.((event as { items: ActivityRow[] }).items)
            : name === 'sessions'
              ? heard.sessions?.()
              : heard.state(event as Stated),
      /* An EventSource sends no header, so the ticket rides the query (see `stream` in doors.ts). */
      /* The activity list is of the project the page is framed in only: a host files it under that one. */
      { query: { ticket: ticket() ?? '', notices: notices ? '1' : '0', ...(project ? { project } : {}) }, events: ['notice', 'activity', 'sessions'] },
    )
  },
}
