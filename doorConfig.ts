import { NOTES_MESSAGES_MOST, agentMessageSchema, agentChangesSchema, hostChangesSchema, type HostChanges, kehikkoSkillsSchema, placedGuardsSchema, type PlacedGuard, type AgentMessage, type KehikkoSkill, oneLine, type AbsentModule, type SessionModule } from 'kehikot-module-protocol'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { askedHosts, doorConfigProblems, doorUrl, keptFolderName, legacyKeptFolderName, stableDoors, startingHost, tokenOnDoor } from 'kehikot-module-protocol/serve'

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

/** The name this module's own door goes under in a session's config when the host did not hand it (`withOwnDoor`): the one the notes name. */
export const OWN_DOOR = 'kehikko-claude'

/**
 * A session's doors with this module's own among them, carrying the session's token (issue #80).
 *
 * The notes tell every session to end its turns, and to message, on this module's door. When the host
 * handed no doors (none answered at the start) or left this module's out, Claude Code connected the
 * person's own entry for it instead — which carries no token, so the door could not tell which
 * conversation called and listed no message tools, while the session's hooks (which do carry the
 * token) said it could message. So this module adds its own door when the host's list has none of
 * this module's: at its stable address on the host that started it (`doorUrl`, protocol 2.95.0),
 * never at its own port, which a restart onto a taken one moves. No starting host (run by hand) or a
 * token that is not one: the doors as they were.
 */
export function withOwnDoor(doors: readonly SessionDoor[] | null, host: string | null, token: string): SessionDoor[] | null {
  if (doors?.some((door) => door.module === ID)) return [...doors]
  if (!host || !PLACE_TOKEN.test(token)) return doors ? [...doors] : null
  const own: SessionDoor = { module: ID, name: OWN_DOOR, url: doorUrl(host, ID, token), transport: 'http' }
  /* A door of another module under this name would be one server in the config: this module's own wins, as its notes name it. */
  return [...(doors ?? []).filter((door) => door.name !== OWN_DOOR), own]
}

/**
 * The doors a session is written: every one on the stable address of the host that started this
 * module (`stableDoors`, protocol 2.95.0), whatever address it was handed with — another host's, a
 * module's own port — and the ones that name no module dropped. No starting host: as handed.
 */
export function onStartingHost(doors: readonly SessionDoor[], host: string | null, token: string): SessionDoor[] {
  return host ? stableDoors(doors, host, token) : [...doors]
}

/**
 * The doors a session was handed, as the protocol's `doorCarriesPlace` reads them: a kept doors file
 * names no module, so a door at this module's stable address (`/m/<id>/`) or at its own port is this
 * module's.
 */
export function handedDoors(doors: readonly SessionDoor[], port: number | null): { name: string; url: string; module?: string }[] {
  return doors.map((door) => {
    if (door.module) return { name: door.name, url: door.url, module: door.module }
    try {
      const url = new URL(door.url)
      const ours = url.pathname.startsWith(`/m/${ID}/`) || url.pathname.startsWith(`/m/${ID}@`) || (port !== null && url.port === String(port) && url.pathname === '/mcp')
      return { name: door.name, url: door.url, ...(ours ? { module: ID } : {}) }
    } catch {
      return { name: door.name, url: door.url }
    }
  })
}

/** A token for a conversation: 32 random bytes, URL-safe. */
export const freshToken = (): string => randomBytes(32).toString('base64url')

/** The hosts a session's place is asked of: the host that started this module alone, when it said so (`askedHosts`, protocol 2.95.0). */
export function hostOrigins(env: Record<string, string | undefined> = process.env): string[] {
  return askedHosts(env)
}

/** What the host is asked: this module issued `token` for a conversation in a project, on a kehikko. */
export interface DoorsAsked {
  projectPath: string
  projectId: string | null
  token: string
  /** The kehikko's key, or null. */
  kehikko: string | null
  /**
   * Whether the session's unread messages are asked for, and so counted delivered (protocol 2.41.0).
   * Absent: true. False for an ask that does not say them (a subagent's notes, a guard lookup).
   */
  messages?: boolean
}

/**
 * One container on a session's kehikko, as the host lists it beside the doors (`modules` in the
 * answer to `POST /host/place`, the protocol's `SessionModule`): its module, name, one line, what it
 * says to agents (`says`, protocol 2.36.0), the name of its door in the session's config (null for
 * none) and the skills it offers there. The words are the module's: text to read.
 */
export type ModuleOn = SessionModule

/**
 * What the host answers for a session's place: its doors, the modules on its kehikko, and the
 * installed ones absent from it that say something there (protocol 2.36.0) — each null from a host
 * too old to say.
 */
export interface HostPlace {
  doors: SessionDoor[]
  modules: ModuleOn[] | null
  absent: AbsentModule[] | null
  /**
   * The session's unread messages from other agent sessions (protocol 2.41.0), handed for its notes and
   * now counted delivered; null from a host that keeps none — then the door offers no message tools.
   */
  messages: AgentMessage[] | null
  /** How many more unread wait; handed at the next ask. */
  messagesMore: number
  /**
   * The skills the person wrote for the session's kehikko (protocol 2.53.0), each with its SKILL.md:
   * loaded into the session's plugin at its start (`sessionPlugin`), said in its notes. Null from a host
   * too old to say, or a place with no kehikko.
   */
  kehikkoSkills?: KehikkoSkill[] | null
  /**
   * The guards of the modules placed on the session's kehikko (protocol 2.61.0): what its Bash
   * commands, and its subagents', are held to (`guard.sh`, guards.ts). Null from a host too old to say.
   */
  guards?: PlacedGuard[] | null
  /**
   * Kehikot's own changes for agents (protocol 2.62.0): said once to a session started before an
   * update, with each module's (`version`, `changes` on `modules`). Null from a host too old to say.
   */
  host?: HostChanges | null
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
        body: JSON.stringify({ module: ID, token: asked.token, project: asked.projectPath, projectId: asked.projectId, kehikko: asked.kehikko, messages: asked.messages !== false }),
        signal: control.signal,
      })
      if (!response.ok) continue
      const said = (await response.json()) as { ok?: unknown; token?: unknown; doors?: unknown; modules?: unknown; absent?: unknown; messages?: unknown; messagesMore?: unknown; kehikkoSkills?: unknown; guards?: unknown; host?: unknown }
      if (said.ok !== true || said.token !== asked.token || !Array.isArray(said.doors)) continue
      return {
        /* On the starting host's stable address, whatever this host handed (protocol 2.95.0). */
        doors: onStartingHost(said.doors.filter(isDoor).slice(0, 64), startingHost(options.env ?? process.env) ?? origin, asked.token),
        modules: Array.isArray(said.modules) ? said.modules.flatMap(moduleOn).slice(0, 64) : null,
        absent: Array.isArray(said.absent) ? said.absent.flatMap(absentOne).slice(0, 32) : null,
        messages: Array.isArray(said.messages) ? said.messages.flatMap((one) => { const read = agentMessageSchema.safeParse(one); return read.success ? [read.data] : [] }).slice(0, NOTES_MESSAGES_MOST) : null,
        messagesMore: typeof said.messagesMore === 'number' && Number.isInteger(said.messagesMore) && said.messagesMore > 0 ? said.messagesMore : 0,
        kehikkoSkills: kehikkoSkillsOf(said.kehikkoSkills),
        guards: said.guards === undefined ? null : placedGuardsSchema.parse(said.guards),
        host: hostChangesOf(said.host),
      }
    } catch {
      /* Not this origin. */
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

/** The kehikko's own skills in a host's answer (protocol 2.53.0): each that parses, or null when the host did not say. */
export function kehikkoSkillsOf(raw: unknown): KehikkoSkill[] | null {
  if (raw === undefined) return null
  const read = kehikkoSkillsSchema.safeParse(raw)
  return read.success ? read.data : null
}

/** Kehikot's own changes for agents in a host's answer (protocol 2.62.0), or null when it did not say or they do not parse. */
export function hostChangesOf(raw: unknown): HostChanges | null {
  if (raw === undefined) return null
  const read = hostChangesSchema.safeParse(raw)
  return read.success ? read.data : null
}

/** A listed module's version and its releases' lines for agents (protocol 2.62.0), when the host said them. */
function changesOf(one: Record<string, unknown>): Pick<ModuleOn, 'version' | 'changes'> {
  const version = typeof one.version === 'string' && /^\d+\.\d+\.\d+$/.test(one.version) ? one.version : null
  if (!version) return {}
  const changes = agentChangesSchema.safeParse(one.changes ?? [])
  return { version, changes: changes.success ? changes.data : [] }
}

/** Ask the host for a session's doors (`POST /host/place`). Null when no host answers or it refuses: the session then starts exactly as it did before. */
export async function hostDoors(asked: DoorsAsked, options: { env?: Record<string, string | undefined>; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<SessionDoor[] | null> {
  return (await hostPlace(asked, options))?.doors ?? null
}

const MODULE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** One listed container, or nothing for anything that is not one. Every string is cut to one short line of text. */
function moduleOn(raw: unknown): ModuleOn[] {
  if (typeof raw !== 'object' || raw === null) return []
  const one = raw as Record<string, unknown>
  if (typeof one.module !== 'string' || !MODULE.test(one.module)) return []
  const door = typeof one.door === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(one.door) ? one.door : null
  const skills = Array.isArray(one.skills) ? one.skills.filter((name): name is string => typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)).slice(0, 16) : []
  const says = oneLine(one.says)
  return [{ module: one.module, name: oneLine(one.name, 80) || one.module, summary: oneLine(one.summary), ...(says ? { says } : {}), door, skills, ...changesOf(one) }]
}

/** One installed module absent from the kehikko, with what it says there; nothing for anything else. */
function absentOne(raw: unknown): AbsentModule[] {
  if (typeof raw !== 'object' || raw === null) return []
  const one = raw as Record<string, unknown>
  const says = oneLine(one.says)
  if (typeof one.module !== 'string' || !MODULE.test(one.module) || !says) return []
  return [{ module: one.module, name: oneLine(one.name, 80) || one.module, says }]
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
export function keptDirOf(token: string, base = tmpdir(), host: string | null = startingHost()): string {
  const fresh = join(configDirOf(base), keptFolderName(token, host))
  if (!host) return fresh
  const legacy = join(configDirOf(base), legacyKeptFolderName(token))
  if (!existsSync(fresh) && existsSync(legacy) && keptOwner(legacy) === host) return legacy
  return fresh
}

/**
 * The folder a conversation started before 2.95.0 was kept in (named by its token alone), when it
 * is there. Its saved options name it: a woken conversation reads its files from there, so a
 * conversation this module holds keeps using it once it is claimed for this host (`claimKept`).
 */
export function legacyKeptDirOf(token: string, base = tmpdir()): string | null {
  const legacy = join(configDirOf(base), legacyKeptFolderName(token))
  return existsSync(legacy) ? legacy : null
}

/** The host a kept folder belongs to (`owner.json`), or null for one nobody claimed. */
export function keptOwner(dir: string): string | null {
  try {
    const said = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) as { host?: unknown }
    return typeof said.host === 'string' ? said.host : null
  } catch {
    return null
  }
}

/** Claim a kept folder for a host (`owner.json`, 0600). */
export function writeKeptOwner(dir: string, host: string): void {
  const file = join(dir, 'owner.json')
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ host }), { mode: 0o600 })
  renameSync(temporary, file)
}

/**
 * Whether a kept folder from before 2.95.0 is this host's conversation, to be claimed: claimed for
 * this host already; or claimed by nobody and either started in this very project (its `place.json`)
 * or naming doors only on hosts that are gone (`answers` says no for every one), which is a folder
 * another host's copy of this module wrote over and left. A folder claimed by another host that
 * still answers is that host's, and is left.
 */
export async function claimable(dir: string, projectPath: string, host: string, answers: (origin: string) => Promise<boolean>): Promise<boolean> {
  const owner = keptOwner(dir)
  if (owner === host) return true
  if (owner) return !(await answers(owner))
  if (keptPlace(dir)?.projectPath === projectPath) return true
  const origins = [...new Set(keptDoors(dir).flatMap((door) => { try { return [new URL(door.url).origin] } catch { return [] } }))].filter((origin) => origin !== host)
  if (!origins.length) return false
  for (const origin of origins) if (await answers(origin)) return false
  return true
}

/** Whether anything answers at an origin, within a moment: a host that is gone refuses the connection. */
export async function answersAt(origin: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<boolean> {
  try {
    await (options.fetch ?? fetch)(`${origin}/`, { method: 'HEAD', signal: AbortSignal.timeout(options.timeoutMs ?? 700) })
    return true
  } catch {
    return false
  }
}

/** What in a kept doors file is not on the starting host's stable address (`doorConfigProblems`, protocol 2.95.0); empty when it all is, or there is none. */
export function keptProblems(dir: string, host: string): string[] {
  try {
    return doorConfigProblems(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')), host)
  } catch {
    return []
  }
}

/** The place token a kept doors file carries, or null. */
export function keptToken(dir: string): string | null {
  for (const door of keptDoors(dir)) {
    const token = tokenOnDoor(door.url)
    if (token && PLACE_TOKEN.test(token)) return token
  }
  return null
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
