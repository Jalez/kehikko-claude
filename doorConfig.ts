import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { frameOrigins } from 'kehikot-module-protocol/serve'

import { ID } from './manifest.ts'
import { PLACE_TOKEN } from './record.ts'

/**
 * A session's Kehikot doors, each carrying its place (protocol 2.4.0).
 *
 * When this module starts or resumes a conversation it asks the host for the
 * doors the session should have — the host's own and those of the modules on
 * the place's kehikko — with the conversation's token on every URL
 * (`?kehikot-place=<token>`), and hands them to Claude Code for that one
 * process with `--mcp-config <file>`. Every door the session calls then knows
 * which conversation is calling, and answers from this module's record of it
 * (`/api/kehikot/place`), whatever the person has switched the screen to.
 *
 * ## Why a file, and why it is safe
 *
 * The token is not a credential — it names a record and grants nothing a call
 * could not do by naming the place — but it is not put on a command line,
 * which every process on the machine can list. The file is written 0600 in a
 * 0700 folder of this user's temporary directory, holds the doors and nothing
 * else, and is removed when the session's process ends.
 *
 * ## The names
 *
 * Each door goes under the name the person's agent config ALREADY uses for it
 * (the host reads that), so the session's entry replaces theirs by name — no
 * second copy of the same tools — and the person's other servers are kept:
 * `--strict-mcp-config` is never passed. A door the person never connected is
 * added under the name the container's plug would give it.
 */

export interface SessionDoor {
  module: string
  name: string
  url: string
  transport: 'http' | 'sse'
}

/** A token for a conversation: 32 random bytes, URL-safe. */
export const freshToken = (): string => randomBytes(32).toString('base64url')

/** The host's origins on this machine, in the order a host is asked. */
export function hostOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = []
  for (const origin of frameOrigins(env)) {
    try {
      const url = new URL(origin)
      if ((url.protocol === 'http:' || url.protocol === 'https:') && ['127.0.0.1', 'localhost'].includes(url.hostname)) out.push(url.origin)
    } catch {
      /* Not a URL. */
    }
  }
  return [...new Set(out)]
}

/** What the host is asked: this module issued `token` for a conversation in a project, on a kehikko. */
export interface DoorsAsked {
  projectPath: string
  projectId: string | null
  token: string
  /** The kehikko's key, or null. */
  kehikko: string | null
}

/**
 * One container on a session's kehikko, as the host lists it beside the doors (`modules` in the
 * answer to `POST /host/place`): its module, name, one line, the name of its door in the session's
 * config (null for none) and the skills it offers there. The words are the module's: text to read.
 */
export interface ModuleOn {
  module: string
  name: string
  summary: string
  door: string | null
  skills: string[]
}

/** What the host answers for a session's place: its doors, and the modules on its kehikko — null from a host too old to list them. */
export interface HostPlace {
  doors: SessionDoor[]
  modules: ModuleOn[] | null
}

/**
 * Ask the host for a session's doors and the modules on its kehikko (`POST /host/place`). Null
 * when no host answers or it refuses. Asked again with the same token, it is the kehikko as it is
 * now: what `context.ts` tells a running session changed.
 */
export async function hostPlace(asked: DoorsAsked, options: { env?: Record<string, string | undefined>; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<HostPlace | null> {
  if (!PLACE_TOKEN.test(asked.token)) return null
  for (const origin of hostOrigins(options.env)) {
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), options.timeoutMs ?? 1500)
    try {
      const response = await (options.fetch ?? fetch)(`${origin}/host/place`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ module: ID, token: asked.token, project: asked.projectPath, projectId: asked.projectId, kehikko: asked.kehikko }),
        signal: control.signal,
      })
      if (!response.ok) continue
      const said = (await response.json()) as { ok?: unknown; token?: unknown; doors?: unknown; modules?: unknown }
      if (said.ok !== true || said.token !== asked.token || !Array.isArray(said.doors)) continue
      return { doors: said.doors.filter(isDoor).slice(0, 64), modules: Array.isArray(said.modules) ? said.modules.flatMap(moduleOn).slice(0, 64) : null }
    } catch {
      /* Not this origin. */
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

/** Ask the host for a session's doors (`POST /host/place`). Null when no host answers or it refuses: the session then starts exactly as it did before. */
export async function hostDoors(asked: DoorsAsked, options: { env?: Record<string, string | undefined>; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<SessionDoor[] | null> {
  return (await hostPlace(asked, options))?.doors ?? null
}

/** One listed container, or nothing for anything that is not one. Every string is cut to one short line. */
function moduleOn(raw: unknown): ModuleOn[] {
  if (typeof raw !== 'object' || raw === null) return []
  const one = raw as Record<string, unknown>
  if (typeof one.module !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(one.module)) return []
  const line = (text: unknown, most: number) => (typeof text === 'string' ? text.replace(/[\s\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, most) : '')
  const door = typeof one.door === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(one.door) ? one.door : null
  const skills = Array.isArray(one.skills) ? one.skills.filter((name): name is string => typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)).slice(0, 16) : []
  return [{ module: one.module, name: line(one.name, 80) || one.module, summary: line(one.summary, 200), door, skills }]
}

function isDoor(raw: unknown): raw is SessionDoor {
  if (typeof raw !== 'object' || raw === null) return false
  const door = raw as Record<string, unknown>
  if (typeof door.module !== 'string' || typeof door.name !== 'string' || typeof door.url !== 'string') return false
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(door.name)) return false
  try {
    const url = new URL(door.url)
    return (url.protocol === 'http:' || url.protocol === 'https:') && ['127.0.0.1', 'localhost'].includes(url.hostname)
  } catch {
    return false
  }
}

/** The JSON Claude Code reads with `--mcp-config`: one server per door. */
export function mcpConfig(doors: readonly SessionDoor[]): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(doors.map((door) => [door.name, { type: door.transport === 'sse' ? 'sse' : 'http', url: door.url }])),
  })
}

/** Where the files are kept: this user's temporary folder, readable by this user alone. */
export function configDirOf(base = tmpdir()): string {
  return join(base, `kehikot-claude-${process.getuid?.() ?? 'user'}`)
}

/** Write a session's config, 0600, and say where. */
export function writeConfig(doors: readonly SessionDoor[], base = tmpdir()): string {
  const dir = configDirOf(base)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const file = join(dir, `${randomBytes(9).toString('base64url')}.json`)
  writeFileSync(file, mcpConfig(doors), { mode: 0o600, flag: 'wx' })
  return file
}

/**
 * The folder a BACKGROUND conversation's files are kept in — its doors file and its plugin folder —
 * for as long as it may be woken: Claude Code keeps the paths it was started with as the session's
 * saved options and reads them again whenever the session is woken (see "The background" in
 * program.ts), so they are at the same place every time. Named after the conversation's token,
 * hashed, so the folder's name says nothing a door would take. Rewritten before every start or
 * wake, so what it holds is the doors of now; never removed while the conversation can be woken —
 * only by `sweepKept`, long after it was last written.
 */
export function keptDirOf(token: string, base = tmpdir()): string {
  return join(configDirOf(base), `session-${createHash('sha256').update(token).digest('hex').slice(0, 24)}`)
}

/** Write a background conversation's doors file in its kept folder, replacing what was there. */
export function writeKeptConfig(doors: readonly SessionDoor[], dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const file = join(dir, 'mcp.json')
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, mcpConfig(doors), { mode: 0o600 })
  renameSync(temporary, file)
  return file
}

/** The doors a background conversation was last given, as its kept doors file says; empty when there is none. */
export function keptDoors(dir: string): SessionDoor[] {
  try {
    const said = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { mcpServers?: Record<string, { type?: unknown; url?: unknown }> }
    return Object.entries(said.mcpServers ?? {}).flatMap(([name, one]) =>
      typeof one?.url === 'string' ? [{ module: '', name, url: one.url, transport: one.type === 'sse' ? ('sse' as const) : ('http' as const) }] : [],
    )
  } catch {
    return []
  }
}

/** How long a kept folder nothing has written to is left: two weeks. */
export const KEPT_FOR = 14 * 24 * 60 * 60_000

/** Remove the kept folders nothing has written to for `olderThan`. Never throws. */
export function sweepKept(base = tmpdir(), olderThan = KEPT_FOR, now = Date.now()): number {
  const root = configDirOf(base)
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch {
    return 0
  }
  let swept = 0
  for (const name of names) {
    if (!/^session-[0-9a-f]{24}$/.test(name)) continue
    try {
      if (now - statSync(join(root, name)).mtimeMs < olderThan) continue
      rmSync(join(root, name), { recursive: true, force: true })
      swept += 1
    } catch {
      /* Gone already. */
    }
  }
  return swept
}

export function removeConfig(file: string | null): void {
  if (!file) return
  try {
    rmSync(file, { force: true })
  } catch {
    /* Gone already. */
  }
}

/**
 * Where a conversation was started, kept beside its doors (`place.json` in its kept folder): what
 * `context.ts` reads to know which place a session's hook speaks from when this process did not
 * start it — a background conversation outlives the process that started it. The place by its
 * key, with the names a person knows it by.
 */
export interface KeptPlace {
  projectPath: string
  projectId: string | null
  key: string
  kehikkoName?: string
  partNames?: string[]
}

/** Write where a conversation was started into its kept folder, 0600. */
export function writeKeptPlace(dir: string, kept: KeptPlace): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const file = join(dir, 'place.json')
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(kept), { mode: 0o600 })
  renameSync(temporary, file)
}

/** Where a conversation was started, as its kept folder says; null when it says nothing readable. */
export function keptPlace(dir: string): KeptPlace | null {
  try {
    const said = JSON.parse(readFileSync(join(dir, 'place.json'), 'utf8')) as Partial<KeptPlace>
    if (typeof said.projectPath !== 'string' || typeof said.key !== 'string') return null
    return {
      projectPath: said.projectPath,
      projectId: typeof said.projectId === 'string' ? said.projectId : null,
      key: said.key,
      ...(typeof said.kehikkoName === 'string' ? { kehikkoName: said.kehikkoName.slice(0, 120) } : {}),
      ...(Array.isArray(said.partNames) ? { partNames: said.partNames.filter((one): one is string => typeof one === 'string').map((one) => one.slice(0, 120)) } : {}),
    }
  } catch {
    return null
  }
}
