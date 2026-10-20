import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { registryDir } from 'kehikot-module-protocol/serve'

import { ID } from './manifest.ts'
import { configDir } from './program.ts'

/**
 * Hearing of a Claude Code session the moment it starts, wherever it was
 * started — a terminal, an editor — so that it is never a conversation
 * Kehikot does not know of for longer than it takes to be assigned.
 *
 * ## The fact it rests on
 *
 * Claude Code runs a `SessionStart` hook when a session starts, resumes, is
 * cleared or compacted, and hands it `session_id` and `cwd` (measured on
 * 2.1.304). An MCP server is told neither: no header, no `initialize` field,
 * and `${CLAUDE_CODE_SESSION_ID}` in an MCP config is not expanded to the
 * session's own id. So the hook is the one place a conversation that this
 * module did not start says what it is and where.
 *
 * ## What is written, and only on a press
 *
 * One entry in the person's Claude Code settings — `<CLAUDE_CONFIG_DIR or
 * ~/.claude>/settings.json`, `hooks.SessionStart` — added beside whatever is
 * there, never replacing it:
 *
 *     { "hooks": [{ "type": "command", "timeout": 5,
 *                   "command": "/bin/sh '<this module>/started.sh' '<registry>/kehikot.claude.json'" }] }
 *
 * `started.sh` passes the hook's input to this module's server
 * (`POST /api/sessions/started`), found through its registration so a moved
 * port is followed, and exits 0 whatever happens. Written when a person
 * presses "Report sessions started outside Kehikot", and at no other time;
 * the press says what it writes first. The rest of the file is kept as it is.
 * `enabled` reads it; nothing here removes it (the person deletes the entry).
 */

/** The settings file the entry goes in. */
export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'settings.json')
}

/** The command the entry runs. */
export function hookCommand(root = import.meta.dirname, registry = registryDir()): string {
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
  return `/bin/sh ${quote(join(root, 'started.sh'))} ${quote(join(registry, `${ID}.json`))}`
}

type Settings = { hooks?: Record<string, unknown> } & Record<string, unknown>

function read(file: string): { ok: true; settings: Settings } | { ok: false; error: string } {
  if (!existsSync(file)) return { ok: true, settings: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, error: `${file} is not a JSON object; nothing was written.` }
    return { ok: true, settings: parsed as Settings }
  } catch {
    return { ok: false, error: `${file} is not readable JSON; nothing was written.` }
  }
}

/** Whether a SessionStart entry runs this module's `started.sh`. */
function ours(entries: unknown): boolean {
  return Array.isArray(entries) && JSON.stringify(entries).includes('started.sh') && JSON.stringify(entries).includes(`${ID}.json`)
}

export function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const got = read(settingsFile(env))
  return got.ok && ours(got.settings.hooks?.SessionStart)
}

/** Add the entry, keeping everything else. `already` when it was there. */
export function enable(env: NodeJS.ProcessEnv = process.env, command = hookCommand()): { ok: true; already: boolean; file: string } | { ok: false; error: string } {
  const file = settingsFile(env)
  const got = read(file)
  if (!got.ok) return got
  const settings = got.settings
  const hooks = (typeof settings.hooks === 'object' && settings.hooks !== null && !Array.isArray(settings.hooks) ? settings.hooks : {}) as Record<string, unknown>
  const start = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : []
  if (ours(start)) return { ok: true, already: true, file }
  const next = { ...settings, hooks: { ...hooks, SessionStart: [...start, { hooks: [{ type: 'command', command, timeout: 5 }] }] } }
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(temporary, file)
  return { ok: true, already: false, file }
}
