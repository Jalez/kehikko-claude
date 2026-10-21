import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { WELL_KNOWN, moduleSkillsSchema, skillPath, skillTextIssue, type ModuleSkill } from 'kehikot-module-protocol'
import { originFor, preferred } from 'kehikot-module-protocol/serve'

import { configDirOf, type SessionDoor } from './doorConfig.ts'
import { ID, PREFERRED_PORT } from './manifest.ts'
import { configDir } from './program.ts'

/**
 * The Claude Code skills this module offers (protocol 2.5.0, `declares.skills`), in one list.
 *
 * Each is ONE file, a SKILL.md, kept in `plugin/skills/<name>/SKILL.md`. That file is a template:
 * it names no port. Where it says `{{origin}}` this module writes the origin it is really serving
 * on (`serveFrom`, from the port Vite ended up bound to), and where it says `{{version}}` the
 * skill's version. So a module that had to take another port than 8010 still gives out a skill
 * that reaches it, and a person can paste the skill's own version back to us.
 *
 *  - **A session this module starts** is given it, with every other module's, for that one process:
 *    `--plugin-dir` on its command line, beside `--mcp-config` (see `start` in live.ts). The folder
 *    passed is assembled for the session (`sessionPlugin`), in this user's temporary folder and removed
 *    when it ends — never the template, and nothing is written into `~/.claude`. Measured on 2.1.304 with a scratch
 *    config: the plugin's skill is listed as `kehikot:kehikot-here`, and the bare
 *    `/kehikot-here` runs it.
 *  - **A host** asks for the text at `skillPath(name)` and shows it; a person presses Install
 *    there to put it in their own `~/.claude/skills/<name>/` for conversations started outside
 *    Kehikot. This module never installs anything.
 *
 * A skill's `version` is the first twelve hex digits of the sha256 of its text as served, with
 * the origin filled in and `{{version}}` still unfilled (the version cannot hash itself). Any
 * change to the template or to the origin changes it, and so does the text a host hashes: an
 * installed copy nobody edited is then "outdated", and the host's sync updates it.
 */

/** The plugin folder as kept here: the templates. A session is given `sessionPlugin()` instead. */
export const PLUGIN_DIR = join(import.meta.dirname, 'plugin')

/** What a template says where the origin goes, and where its version goes. */
export const ORIGIN_SLOT = '{{origin}}'
export const VERSION_SLOT = '{{version}}'

interface Offered {
  name: string
  /** One sentence for the person choosing, at most 200 characters. */
  summary: string
}

const OFFERED: readonly Offered[] = [
  {
    name: 'kehikot-here',
    summary: 'Type /kehikot-here in any Claude Code conversation to assign that conversation to the kehikko on screen in Kehikot.',
  },
]

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/

/** The origin this process serves on. Until it is listening, the port it will try first. */
let served = originFor(preferred(PREFERRED_PORT))

/** Say the origin this process is really on (`http://127.0.0.1:<port>`). Refuses anything else. */
export function serveFrom(origin: string): void {
  if (!LOOPBACK_ORIGIN.test(origin)) throw new Error(`not a loopback origin: ${JSON.stringify(origin)}`)
  served = origin
}

/** The origin the skills are written for now. */
export const servedOrigin = (): string => served

/** A skill's SKILL.md as kept here, unfilled. */
export function skillTemplate(name: string): string | null {
  if (!OFFERED.some((one) => one.name === name)) return null
  return readFileSync(join(PLUGIN_DIR, 'skills', name, 'SKILL.md'), 'utf8')
}

const sha12 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12)

/** A template filled in for one origin: the text as served, and its version. */
export function fill(template: string, origin: string): { text: string; version: string } {
  const placed = template.replaceAll(ORIGIN_SLOT, origin)
  const version = sha12(placed)
  return { text: placed.replaceAll(VERSION_SLOT, version), version }
}

/** A skill's SKILL.md as this module serves it, for `origin` (the one it is on, by default). */
export function skillText(name: string, origin = served): string | null {
  const template = skillTemplate(name)
  return template === null ? null : fill(template, origin).text
}

/** What the manifest declares: name, summary and version of each, for `origin`. */
export function skillDeclarations(origin = served): ModuleSkill[] {
  return OFFERED.map((one) => ({ name: one.name, summary: one.summary, version: fill(skillTemplate(one.name)!, origin).version }))
}

/** The skill a path asks for (`skillPath(name)`), or null for a path that is not one of ours. */
export function skillAt(path: string): { name: string; text: string } | null {
  for (const one of OFFERED) {
    if (skillPath(one.name) !== path) continue
    const text = skillText(one.name)
    if (text === null || skillTextIssue(text, one.name)) return null
    return { name: one.name, text }
  }
  return null
}

/** Whether a path is one this module serves a skill on: what `doors()` hands to `answer`. */
export const isSkillPath = (path: string): boolean => OFFERED.some((one) => skillPath(one.name) === path)

const MARKER = '.kehikot-skill.json'
const FETCH_MS = 1500

/** What a session's skills were gathered with. */
export interface GatherOptions {
  base?: string
  fetch?: typeof fetch
  log?: (line: string) => void
  /** Where the person's skills are kept; `CLAUDE_CONFIG_DIR` or `~/.claude` by default. Read, never written. */
  claudeDir?: string
  timeoutMs?: number
}

/** Whether the person already installed `name` at `version` through Kehikot (its marker says the same version). */
function installed(dir: string, name: string, version: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(dir, 'skills', name, MARKER), 'utf8')) as { version?: unknown }
    return marker.version === version
  } catch {
    return false
  }
}

async function getText(origin: string, path: string, options: GatherOptions): Promise<{ status: number; body: string } | null> {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), options.timeoutMs ?? FETCH_MS)
  try {
    const response = await (options.fetch ?? fetch)(`${origin}${path}`, { signal: control.signal, headers: { accept: 'application/json, text/markdown, text/plain' } })
    return { status: response.status, body: await response.text() }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The plugin folder a session started here is given with `--plugin-dir`: ONE plugin, `kehikot`,
 * holding the skills of every module on the session's kehikko (those whose door it was given) and
 * this module's own.
 *
 * Each module's manifest is read at its origin (the door's) and each skill it declares fetched at
 * `skillPath(name)`; a text the protocol's `skillTextIssue` refuses is left out with one log line.
 * A module that does not answer is skipped with one line, and the start goes on. A skill the person
 * installed through Kehikot at the same version (`~/.claude/skills/<name>/.kehikot-skill.json`) is
 * left out so it is not listed twice; at another version the session's copy, which is current, is
 * used. The first module to offer a name keeps it.
 *
 * The folder is new for each session, 0700, in this user's temporary folder, and the caller removes
 * it (`removePlugin`) when the session ends. Null when there is nothing to offer.
 */
export async function sessionPlugin(doors: readonly SessionDoor[], options: GatherOptions = {}): Promise<string | null> {
  const log = options.log ?? (() => {})
  const claudeDir = options.claudeDir ?? configDir()
  const found = new Map<string, string>()
  const take = (name: string, text: string, version: string, from: string) => {
    if (found.has(name)) return log(`claude: skill ${name} from ${from} left out — another module already offers one by that name`)
    if (installed(claudeDir, name, version)) return log(`claude: skill ${name} is already installed (${version}) — not listed twice`)
    found.set(name, text)
  }
  for (const one of skillDeclarations()) take(one.name, skillText(one.name)!, one.version, ID)

  const origins = new Map<string, string>()
  for (const door of doors) {
    if (door.module === ID) continue
    try {
      const origin = new URL(door.url).origin
      if (!origins.has(origin)) origins.set(origin, door.module)
    } catch {
      /* Not a URL: isDoor refused it already. */
    }
  }
  const gathered = await Promise.all(
    [...origins].map(async ([origin, module]) => {
      const said = await getText(origin, WELL_KNOWN, options)
      if (said === null) {
        log(`claude: ${module} did not answer at ${origin} — its skills are not loaded in this session`)
        return []
      }
      /* The host's own door, or a module that is not one: nothing to offer, and nothing to say. */
      if (said.status !== 200) return []
      let declared: ModuleSkill[] = []
      try {
        const parsed = moduleSkillsSchema.safeParse((JSON.parse(said.body) as { declares?: { skills?: unknown } }).declares?.skills ?? [])
        if (parsed.success) declared = parsed.data
        else log(`claude: ${module} declares skills that are not a valid list — none loaded`)
      } catch {
        return []
      }
      const texts = await Promise.all(declared.map((skill) => getText(origin, skillPath(skill.name), options)))
      return declared.flatMap((skill, i) => {
        const got = texts[i]!
        if (got.status !== 200) {
          log(`claude: ${module} did not give skill ${skill.name} (${got.status}) — left out`)
          return []
        }
        const issue = skillTextIssue(got.body, skill.name)
        if (issue) {
          log(`claude: skill ${skill.name} from ${module} refused — ${issue}`)
          return []
        }
        return [{ module, skill, text: got.body }]
      })
    }).map((one) => one.catch(() => [])),
  )
  for (const list of gathered) for (const one of list) take(one.skill.name, one.text, one.skill.version, one.module)
  if (found.size === 0) return null

  const base = configDirOf(options.base)
  mkdirSync(base, { recursive: true, mode: 0o700 })
  chmodSync(base, 0o700)
  const dir = mkdtempSync(join(base, 'plugin-'))
  chmodSync(dir, 0o700)
  mkdirSync(join(dir, '.claude-plugin'), { mode: 0o700 })
  for (const [name, text] of found) {
    mkdirSync(join(dir, 'skills', name), { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'skills', name, 'SKILL.md'), text, { mode: 0o600 })
  }
  /* Last, so a folder with its plugin.json is a whole one. */
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), readFileSync(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json')), { mode: 0o600 })
  return dir
}

/** Remove a session's plugin folder. Never throws. */
export function removePlugin(dir: string | null): void {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Gone already. */
  }
}
