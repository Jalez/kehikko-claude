import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readUninstallReport } from 'kehikot-module-protocol'

import { disable, hookCommand, settingsFile } from '../hook.ts'

const ROOT = join(import.meta.dirname, '..')

/** A scratch HOME, Claude Code config, registry and temporary folder: nothing of the machine's. */
function scratch(settings?: unknown) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'claude-uninstall-')))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(base, 'home'),
    CLAUDE_CONFIG_DIR: join(base, 'claude'),
    KEHIKOT_MODULES_DIR: join(base, 'Kehikot', 'modules'),
    TMPDIR: join(base, 'tmp'),
  }
  for (const dir of [env.HOME!, env.CLAUDE_CONFIG_DIR!, env.KEHIKOT_MODULES_DIR!, env.TMPDIR!]) mkdirSync(dir, { recursive: true })
  if (settings !== undefined) writeFileSync(join(env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify(settings, null, 2))
  return { base, env }
}
const read = (env: NodeJS.ProcessEnv) => JSON.parse(readFileSync(settingsFile(env), 'utf8'))

describe('Uninstall takes away what this module wrote outside its folder', () => {
  const ours = hookCommand('/Users/someone/Library/Application Support/Kehikot/installed/kehikot.claude', '/scratch/Kehikot/modules')
  const theirs = { hooks: [{ type: 'command', command: '/usr/local/bin/their-own-hook' }] }

  test('disable removes only our SessionStart hook; the person’s own and every other key stay', () => {
    const { env } = scratch({ model: 'opus', hooks: { SessionStart: [theirs, { hooks: [{ type: 'command', command: ours, timeout: 5 }] }], Stop: [theirs] } })
    expect(disable(env)).toMatchObject({ ok: true, removed: 1 })
    expect(read(env)).toEqual({ model: 'opus', hooks: { SessionStart: [theirs], Stop: [theirs] } })
  })

  test('SessionStart goes when nothing is left in it; nothing of ours is nothing written', () => {
    const { env } = scratch({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: ours, timeout: 5 }] }] } })
    expect(disable(env)).toMatchObject({ ok: true, removed: 1 })
    expect(read(env)).toEqual({ hooks: {} })
    const before = readFileSync(settingsFile(env), 'utf8')
    expect(disable(env)).toMatchObject({ ok: true, removed: 0 })
    expect(readFileSync(settingsFile(env), 'utf8')).toBe(before)
  })

  test('a settings file that is not JSON is left, and said', () => {
    const { env } = scratch()
    writeFileSync(settingsFile(env), '{ not json')
    expect(disable(env)).toMatchObject({ ok: false })
    expect(readFileSync(settingsFile(env), 'utf8')).toBe('{ not json')
  })

  test('uninstall.ts, run as Kehikot runs it: the hook, its setup file and its temporary folder go, and the report says so', () => {
    const { env } = scratch({ hooks: { SessionStart: [theirs, { hooks: [{ type: 'command', command: ours, timeout: 5 }] }] } })
    const setup = join(env.KEHIKOT_MODULES_DIR!, '..', 'claude', 'setup.json')
    mkdirSync(join(setup, '..'), { recursive: true })
    writeFileSync(setup, '{}')
    const sessions = join(env.TMPDIR!, `kehikot-claude-${process.getuid?.() ?? 'user'}`)
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'x.json'), '{}')
    const out = execFileSync(process.execPath, ['uninstall.ts'], { cwd: ROOT, env, encoding: 'utf8' })
    const report = readUninstallReport(out)
    expect(report?.removed.map((one) => one.what)).toEqual([
      'Its SessionStart hook in Claude Code’s settings',
      'Its choice for setting up Claude Code',
      'Its session folders in the temporary directory',
    ])
    expect(report?.left).toEqual([])
    expect(read(env).hooks.SessionStart).toEqual([theirs])
    expect(existsSync(setup)).toBe(false)
    expect(existsSync(join(setup, '..'))).toBe(false)
    expect(existsSync(sessions)).toBe(false)
    /* Run again: nothing left to remove is not an error. */
    expect(readUninstallReport(execFileSync(process.execPath, ['uninstall.ts'], { cwd: ROOT, env, encoding: 'utf8' }))).toEqual({ removed: [], left: [] })
  })
})
