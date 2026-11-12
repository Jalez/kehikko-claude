import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { AGENT_SETUP_CARRIED_PATH, settingValueIssue } from 'kehikot-module-protocol'
import { frameOrigins, registryDir } from 'kehikot-module-protocol/serve'

import { SETUP_FIELDS, SETUP_KEYS } from './setupFields.ts'

export { SETUP_FIELDS }

/**
 * "Use every module's tools and skills in Claude Code outside Kehikot too" (protocol 2.91.0,
 * `agent.setup`): this module's own choice, four `machine` settings (`AGENT_SETUP_KEYS`), shown in its
 * settings and in the host's Settings › Modules like the others. The HOST keeps Claude Code's user-wide
 * configuration in step with it (it runs while this module sleeps); this module only holds the choice.
 *
 * Kept once for this computer, beside the module registry: `<Kehikot's machine folder>/claude/setup.json`
 * (`setupFile`, which follows `KEHIKOT_MODULES_DIR`, so a test's scratch registry moves it too).
 *
 * ## Carried over once
 *
 * Before 2.91.0 the host held this choice in its own Settings › Agents. Until this module has a choice
 * of its own (no file yet), it asks the host for that earlier choice (`AGENT_SETUP_CARRIED_PATH`) and
 * keeps the answer as its own, so nothing the person set up changes. A host that never held one (404)
 * leaves the defaults (off), and is asked again next time; a host that could not be reached is said as
 * the read's `problem`, so a host never takes the defaults for the person's choice.
 */

const KEYS = SETUP_KEYS

export const isSetupKey = (key: string): boolean => KEYS.includes(key)

type Env = Record<string, string | undefined>

export function setupFile(env: Env = process.env): string {
  return join(dirname(registryDir(env)), 'claude', 'setup.json')
}

function readFile(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeFile(file: string, values: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(values, null, 2)}\n`)
  renameSync(temp, file)
}

const only = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([key]) => KEYS.includes(key)))

export interface SetupOptions {
  env?: Env
  fetch?: typeof fetch
  timeoutMs?: number
}

/** The choice as kept, carried over from the host first when there is none yet. */
export async function readSetup(options: SetupOptions = {}): Promise<{ values: Record<string, unknown>; problem?: string }> {
  const env = options.env ?? process.env
  const file = setupFile(env)
  const kept = readFile(file)
  if (kept) return { values: only(kept) }
  const asked = options.fetch ?? fetch
  let reached = false
  for (const origin of frameOrigins(env)) {
    let url: URL
    try {
      url = new URL(AGENT_SETUP_CARRIED_PATH, origin)
    } catch {
      continue
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) continue
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), options.timeoutMs ?? 3000)
    try {
      const response = await asked(url.href, { signal: control.signal })
      reached = true
      if (response.status === 404) continue
      if (!response.ok) continue
      const body = (await response.json()) as { ok?: unknown; values?: unknown }
      if (body.ok !== true || !body.values || typeof body.values !== 'object') continue
      const values = Object.fromEntries(
        Object.entries(only(body.values as Record<string, unknown>)).filter(([key, value]) => {
          const field = SETUP_FIELDS.find((one) => one.key === key)
          return field !== undefined && settingValueIssue(field, value) === null
        }),
      )
      writeFile(file, values)
      return { values }
    } catch {
      /* Not this origin. */
    } finally {
      clearTimeout(timer)
    }
  }
  return reached ? { values: {} } : { values: {}, problem: 'Kehikot did not answer, so your earlier choice could not be carried over yet.' }
}

/** One checked change, written as the person made it. Null when written, else a sentence. */
export async function writeSetup(key: string, value: unknown, options: SetupOptions = {}): Promise<string | null> {
  if (!isSetupKey(key)) return `Claude has no setting called "${key.slice(0, 64)}".`
  const now = await readSetup(options)
  if (now.problem) return now.problem
  try {
    writeFile(setupFile(options.env ?? process.env), { ...now.values, [key]: value })
    return null
  } catch (error) {
    return `The choice could not be kept: ${error instanceof Error ? error.message : String(error)}`
  }
}
