import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { skillPath, skillTextIssue, type ModuleSkill } from 'kehikot-module-protocol'
import { originFor, preferred } from 'kehikot-module-protocol/serve'

import { configDirOf } from './doorConfig.ts'
import { PREFERRED_PORT } from './manifest.ts'

/**
 * The Claude Code skills this module offers (protocol 2.5.0, `declares.skills`), in one list.
 *
 * Each is ONE file, a SKILL.md, kept in `plugin/skills/<name>/SKILL.md`. That file is a template:
 * it names no port. Where it says `{{origin}}` this module writes the origin it is really serving
 * on (`serveFrom`, from the port Vite ended up bound to), and where it says `{{version}}` the
 * skill's version. So a module that had to take another port than 8010 still gives out a skill
 * that reaches it, and a person can paste the skill's own version back to us.
 *
 *  - **A session this module starts** is given it for that one process: `--plugin-dir` on its
 *    command line, beside `--mcp-config` (see `start` in live.ts). The folder passed is a copy
 *    with the text filled in (`sessionPlugin`), in this user's temporary folder — never the
 *    template, and nothing is written into `~/.claude`. Measured on 2.1.304 with a scratch
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

/**
 * The plugin folder a session started here is given with `--plugin-dir`: `plugin.json` as kept,
 * and each skill filled in for `origin`. One folder per set of versions, in this user's own
 * temporary folder (beside the sessions' `--mcp-config` files), written once and then reused.
 */
export function sessionPlugin(origin = served, base = tmpdir()): string {
  const skills = skillDeclarations(origin)
  const dir = join(configDirOf(base), `plugin-${sha12(skills.map((one) => `${one.name}@${one.version}`).join(','))}`)
  const manifest = join(dir, '.claude-plugin', 'plugin.json')
  if (existsSync(manifest)) return dir
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true, mode: 0o700 })
  for (const one of skills) {
    mkdirSync(join(dir, 'skills', one.name), { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'skills', one.name, 'SKILL.md'), skillText(one.name, origin)!, { mode: 0o600 })
  }
  /* Last, so a folder with its plugin.json is a whole one. */
  writeFileSync(manifest, readFileSync(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json')), { mode: 0o600 })
  return dir
}
