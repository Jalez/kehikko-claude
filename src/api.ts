import { answered, ask, follow, ticket } from 'kehikot-module-protocol/client'

import type { Listing } from '../doors.ts'
import type { Notice, Stated } from '../live.ts'

/**
 * This module's own `/api`, as the page calls it. `ask` carries the ticket —
 * on the read as well, since the read says what somebody has been working on
 * (see doors.ts) — and turns every failure into one sentence.
 */
export interface Api {
  /** What this place holds: its sessions, the project's others, what is running, and whether the program is there. */
  place(projectPath: string, key: string): Promise<Listing>
  /**
   * Bring what an older release filed under a kehikko's row number across to
   * its key. Asked once per kehikko, before the first read of a place on it.
   */
  rekey(projectPath: string, kehikko: { key: string; name: string; id?: number }): Promise<void>
  /** End a running session, because a person chose that one. */
  end(session: string): Promise<void>
  /** Take a session off a place. The session itself is kept. */
  detach(projectPath: string, key: string, session: string): Promise<void>
  /**
   * Follow what changes while the page is open: every running session's
   * state, and — when `notices` says a host is there to pass them to — the
   * notices raised for a person who is not looking. Returns the function that
   * stops following.
   */
  feed?(notices: boolean, heard: { state(stated: Stated): void; notice(notice: Notice): void }): () => void
}

export const api: Api = {
  async place(projectPath, key) {
    return answered(await ask<Listing>('./api/place', { query: { projectPath, key }, ticket: true }))
  },
  async rekey(projectPath, kehikko) {
    answered(await ask('./api/rekey', { body: { projectPath, kehikko } }))
  },
  async end(session) {
    answered(await ask('./api/end', { body: { session } }))
  },
  async detach(projectPath, key, session) {
    answered(await ask('./api/detach', { body: { projectPath, key, session } }))
  },
  feed(notices, heard) {
    return follow<Stated | Notice>(
      './api/feed',
      (event, name) => (name === 'notice' ? heard.notice(event as Notice) : heard.state(event as Stated)),
      /* An EventSource sends no header, so the ticket rides the query (see `stream` in doors.ts). */
      { query: { ticket: ticket() ?? '', notices: notices ? '1' : '0' }, events: ['notice'] },
    )
  },
}
