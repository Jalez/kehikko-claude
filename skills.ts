import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { skillPath, skillTextIssue, type ModuleSkill } from 'kehikot-module-protocol'

/**
 * The Claude Code skills this module offers (protocol 2.5.0, `declares.skills`), in one list.
 *
 * Each is ONE file, a SKILL.md, kept in `plugin/skills/<name>/SKILL.md`. That folder is a Claude
 * Code plugin (`plugin/.claude-plugin/plugin.json`), and two things read it:
 *
 *  - **A session this module starts** is given it for that one process: `--plugin-dir <plugin>`
 *    on its command line, beside `--mcp-config` (see `start` in live.ts). Nothing is written into
 *    `~/.claude`. Measured on 2.1.304 with a scratch config: the skill is listed as
 *    `kehikot:kehikot-here`, and typing the bare `/kehikot-here` runs it.
 *  - **A host** asks for the text at `skillPath(name)` and shows it; a person presses Install
 *    there to put it in their own `~/.claude/skills/<name>/` for conversations started outside
 *    Kehikot. This module never installs anything.
 *
 * A skill's `version` is the first twelve hex digits of the sha256 of its text, so a host can
 * tell an installed copy that is out of date by comparing the two words.
 */

/** The plugin folder a session started here is given. */
export const PLUGIN_DIR = join(import.meta.dirname, 'plugin')

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

/** A skill's SKILL.md as this module ships it. */
export function skillText(name: string): string | null {
  if (!OFFERED.some((one) => one.name === name)) return null
  return readFileSync(join(PLUGIN_DIR, 'skills', name, 'SKILL.md'), 'utf8')
}

const versionOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12)

/** What the manifest declares: name, summary and version of each. */
export function skillDeclarations(): ModuleSkill[] {
  return OFFERED.map((one) => ({ name: one.name, summary: one.summary, version: versionOf(skillText(one.name)!) }))
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
