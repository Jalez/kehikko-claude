import { answered, ask } from 'kehikot-module-protocol/client'

import type { Listing } from '../doors.ts'

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
}
