#!/usr/bin/env bun
import { dirname } from 'node:path'

import { removeOwned, runUninstall } from 'kehikot-module-protocol/serve'

import { configDirOf } from './doorConfig.ts'
import { disable } from './hook.ts'
import { setupFile } from './setup.ts'

/**
 * What this module wrote outside its own folder, taken away when a person uninstalls it (protocol
 * 2.108.0, `uninstall.ts`). Kehikot runs this after the module is stopped and before its folder is
 * deleted, and says the report to the person.
 *
 *  - Its `SessionStart` hook entry in Claude Code's settings (`hook.ts`, written only on a press):
 *    our entries only; the person's own hooks and every other key of the file stay.
 *  - Its own file beside the module registry: the choice for setting up Claude Code (`setup.ts`).
 *  - Its folder in this user's temporary directory: the doors and places of its sessions
 *    (`doorConfig.ts`). Nothing runs there once the module is stopped.
 *
 * The tools entries and skills in Claude Code that the HOST set up are the host's to take away, and it
 * does. A conversation's own history (Claude Code's transcripts) is the person's and is never touched.
 */
await runUninstall([
  () => {
    const done = disable()
    if (!done.ok) return { left: [{ what: 'Its SessionStart hook in Claude Code’s settings', path: done.file, why: done.error }] }
    return done.removed ? { removed: [{ what: 'Its SessionStart hook in Claude Code’s settings', path: done.file }] } : {}
  },
  () => removeOwned(setupFile(), 'Its choice for setting up Claude Code', { parentToo: dirname(setupFile()) }),
  () => removeOwned(configDirOf(), 'Its session folders in the temporary directory'),
])
