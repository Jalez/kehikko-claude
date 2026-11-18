import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { enable, hookCommand, repair, settingsFile } from '../hook.ts'

/** A Claude Code config folder of the test's own, with `settings` in it when given. */
function configWith(settings?: unknown): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'claude-hook-repair-'))
  mkdirSync(dir, { recursive: true })
  if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2))
  return { ...process.env, CLAUDE_CONFIG_DIR: dir }
}
const read = (env: NodeJS.ProcessEnv) => JSON.parse(readFileSync(settingsFile(env), 'utf8'))

describe('the session hook follows the folder this module runs from', () => {
  const registry = '/scratch/Kehikot/modules'
  const checkout = hookCommand('/Users/someone/Projects/kehikko-claude', registry)
  const installed = hookCommand('/Users/someone/Library/Application Support/Kehikot/installed/kehikot.claude', registry)

  test('an entry a press wrote from a checkout is pointed at the installed copy, and nothing else changes', () => {
    const theirs = { hooks: [{ type: 'command', command: '/usr/local/bin/their-own-hook' }] }
    const env = configWith({ model: 'opus', hooks: { SessionStart: [theirs, { hooks: [{ type: 'command', command: checkout, timeout: 5 }] }], Stop: [theirs] } })
    const done = repair(env, installed)
    expect(done).toMatchObject({ ok: true, repaired: 1 })
    const after = read(env)
    expect(after.model).toBe('opus')
    expect(after.hooks.Stop).toEqual([theirs])
    expect(after.hooks.SessionStart[0]).toEqual(theirs)
    expect(after.hooks.SessionStart[1]).toEqual({ hooks: [{ type: 'command', command: installed, timeout: 5 }] })
    expect(after.hooks.SessionStart[1].hooks[0].command).toContain('/installed/kehikot.claude/started.sh')
  })

  test('an entry already naming this folder is left alone and the file is not written', () => {
    const env = configWith({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: installed, timeout: 5 }] }] } })
    const before = readFileSync(settingsFile(env), 'utf8')
    expect(repair(env, installed)).toMatchObject({ ok: true, repaired: 0 })
    expect(readFileSync(settingsFile(env), 'utf8')).toBe(before)
  })

  test('nothing is added when nobody pressed for the hook, and no file is made', () => {
    const none = configWith()
    expect(repair(none, installed)).toMatchObject({ ok: true, repaired: 0 })
    const other = configWith({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/bin/echo hi' }] }] } })
    expect(repair(other, installed)).toMatchObject({ ok: true, repaired: 0 })
    expect(read(other).hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: '/bin/echo hi' }] }])
  })

  test('back to the checkout the same way, and enable then finds it in place', () => {
    const env = configWith()
    expect(enable(env, installed)).toMatchObject({ ok: true, already: false })
    expect(repair(env, checkout)).toMatchObject({ ok: true, repaired: 1 })
    expect(read(env).hooks.SessionStart[0].hooks[0].command).toBe(checkout)
    expect(enable(env, checkout)).toMatchObject({ ok: true, already: true })
  })

  test('a file that is not JSON is refused, not rewritten', () => {
    const env = configWith()
    writeFileSync(settingsFile(env), '{ not json')
    expect(repair(env, installed).ok).toBe(false)
    expect(readFileSync(settingsFile(env), 'utf8')).toBe('{ not json')
  })
})
