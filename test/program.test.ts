import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { PROGRAM, configDir, firstPrompt, home, recordDirs } from '../program.ts'
import { CONFIG, HOME } from './setup.ts'

/**
 * The adapter, against a stand-in `claude` and a scratch config folder.
 *
 * Nothing here runs the real program or reads a real record: `test/setup.ts`
 * has already pointed the home folder, `CLAUDE_CONFIG_DIR` and PATH at
 * scratch. What is pinned is what the rest of the module leans on — where the
 * binary is looked for, which arguments start and resume a session, and what
 * is read out of a record.
 */

const STAND_IN = join(import.meta.dir, 'stand-in', 'claude')
const made: string[] = []
const scratch = (name: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `kehikko-claude-${name}-`)))
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
  rmSync(join(HOME, '.local'), { recursive: true, force: true })
})

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

const row = (content: unknown, more: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content }, ...more })

describe('finding the binary', () => {
  test('the test’s machine is scratch: a home of its own and Claude Code’s config beside it', () => {
    expect(home()).toBe(HOME)
    expect(configDir()).toBe(CONFIG)
  })

  test('on PATH first', () => {
    const bin = scratch('bin')
    copyFileSync(STAND_IN, join(bin, 'claude'))
    chmodSync(join(bin, 'claude'), 0o755)
    const found = PROGRAM.find({ HOME, PATH: `/nowhere:${bin}` })
    expect(found.file).toBe(join(bin, 'claude'))
    expect(found.looked).toEqual(['/nowhere', bin])
    expect(found.usual[0]).toBe(join(HOME, '.local', 'bin'))
  })

  test('then the usual places a thin PATH leaves out — where the vendor’s installer puts it first', () => {
    const none = PROGRAM.find({ HOME, PATH: '/usr/bin:/bin' })
    expect(none.file).toBeNull()
    expect(none.looked.slice(0, 3)).toEqual(['/usr/bin', '/bin', join(HOME, '.local', 'bin')])
    expect(none.looked).toContain('/opt/homebrew/bin')

    mkdirSync(join(HOME, '.local', 'bin'), { recursive: true })
    copyFileSync(STAND_IN, join(HOME, '.local', 'bin', 'claude'))
    chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755)
    expect(PROGRAM.find({ HOME, PATH: '/usr/bin:/bin' }).file).toBe(join(HOME, '.local', 'bin', 'claude'))
    rmSync(join(HOME, '.local'), { recursive: true, force: true })
  })

  test('a file that cannot be run, and a folder of that name, are not the binary', () => {
    const bin = scratch('bin')
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o644 })
    expect(PROGRAM.find({ HOME, PATH: bin }).file).toBeNull()
    const other = scratch('bin')
    mkdirSync(join(other, 'claude'))
    expect(PROGRAM.find({ HOME, PATH: other }).file).toBeNull()
  })
})

describe('whether a copy can do what is asked of it', () => {
  test('one with both flags can', async () => {
    expect(await PROGRAM.supports(STAND_IN)).toEqual({ ok: true, missing: null })
  })

  test('one whose help has no --session-id is too old, and the flag is named', async () => {
    const bin = scratch('old')
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nSTANDIN_OLD=1 exec "${STAND_IN}" "$@"\n`, { mode: 0o755 })
    expect(await PROGRAM.supports(join(bin, 'claude'))).toEqual({ ok: false, missing: '--session-id' })
  })

  test('one whose help cannot be read is not called too old: nothing was learned', async () => {
    const bin = scratch('broken')
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    expect((await PROGRAM.supports(join(bin, 'claude'))).ok).toBe(true)
  })
})

describe('starting and resuming', () => {
  test('a new session is given its id, a resumed one is named by it, and neither is given anything else', () => {
    expect(PROGRAM.fresh(A)).toEqual(['--session-id', A])
    expect(PROGRAM.resume(A)).toEqual(['--resume', A])
  })

  test('no flag that widens what the program may do, and no prompt', () => {
    for (const args of [PROGRAM.fresh(A), PROGRAM.resume(A)]) {
      expect(args.join(' ')).not.toMatch(/dangerously|skip-permissions|permission-mode|allowed-?tools|add-dir|bare|-p\b|--print/i)
      expect(args.length).toBe(2)
    }
  })

  test('an id it mints is one it accepts, and what is not an id is refused', () => {
    expect(PROGRAM.isId(PROGRAM.newId())).toBe(true)
    expect(PROGRAM.newId()).not.toBe(PROGRAM.newId())
    for (const not of ['', 'x', '../../etc', `${A}.jsonl`, `--resume ${A}`, 'AAAAAAAA-1111-4111-8111-111111111111']) expect(PROGRAM.isId(not)).toBe(false)
  })

  test('the session’s environment does not say it is inside another session', () => {
    const env = PROGRAM.environment({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CONFIG_DIR: '/kept', ANTHROPIC_API_KEY: 'kept' })
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/kept', ANTHROPIC_API_KEY: 'kept' })
  })
})

describe('reading a project’s sessions', () => {
  test('the label is the first line of the first thing a person said, and nothing else is read', () => {
    const head = [
      JSON.stringify({ type: 'mode', mode: 'x' }),
      JSON.stringify({ type: 'attachment', attachment: {} }),
      row('<command-name>/clear</command-name>'),
      row('side', { isSidechain: true }),
      row('meta', { isMeta: true }),
      row([{ type: 'tool_result', content: 'not prose' }]),
      row('  tighten the methods section\nand then the rest of a long prompt'),
      row('a later prompt'),
      '{"type":"user","message":{"content":"cut mid-li',
    ].join('\n')
    expect(firstPrompt(head)).toBe('tighten the methods section')
    expect(firstPrompt(row([{ type: 'text', text: 'said in blocks' }]))).toBe('said in blocks')
    expect(firstPrompt('')).toBe('')
    expect(firstPrompt(row('x'.repeat(200))).length).toBe(80)
    expect(firstPrompt(row('x'.repeat(200))).endsWith('…')).toBe(true)
  })

  test('a folder’s sessions, most recently active first, with their labels', async () => {
    const project = scratch('project')
    const [dir] = recordDirs(project)
    expect(dir).toBe(join(CONFIG, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-')))
    mkdirSync(dir!, { recursive: true })
    writeFileSync(join(dir!, `${A}.jsonl`), `${row('the older one')}\n`)
    writeFileSync(join(dir!, `${B}.jsonl`), `${row('the newer one')}\n`)
    writeFileSync(join(dir!, 'notes.txt'), 'not a session')
    writeFileSync(join(dir!, 'not-an-id.jsonl'), `${row('nor this')}\n`)
    utimesSync(join(dir!, `${A}.jsonl`), new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:00:00Z'))
    utimesSync(join(dir!, `${B}.jsonl`), new Date('2026-10-02T10:00:00Z'), new Date('2026-10-02T10:00:00Z'))

    const held = await PROGRAM.sessions(project)
    expect(held.map((one) => [one.id, one.label])).toEqual([
      [B, 'the newer one'],
      [A, 'the older one'],
    ])
    expect(held[1]?.lastActive).toBe(Date.parse('2026-10-01T10:00:00Z'))
  })

  test('a folder with no record has no sessions, and a neighbouring folder’s are not its own', async () => {
    const project = scratch('project')
    const neighbour = `${project}-notes`
    mkdirSync(recordDirs(neighbour)[0]!, { recursive: true })
    writeFileSync(join(recordDirs(neighbour)[0]!, `${A}.jsonl`), `${row('next door')}\n`)
    expect(await PROGRAM.sessions(project)).toEqual([])
  })

  test('a session exists once the program has a record for it, and not before', async () => {
    const project = scratch('project')
    expect(await PROGRAM.settled(project, A, 0)).toBeNull()
    const [dir] = recordDirs(project)
    mkdirSync(dir!, { recursive: true })
    writeFileSync(join(dir!, `${A}.jsonl`), `${row('hello')}\n`)
    expect(await PROGRAM.settled(project, A, 0)).toBe(A)
    expect(await PROGRAM.settled(project, B, 0)).toBeNull()
  })
})

describe('installing', () => {
  test('is the vendor’s own command, with where it was read and when', () => {
    const install = PROGRAM.install({})
    expect(install.line).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(install.source).toBe('https://code.claude.com/docs/en/setup')
    expect(install.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    /* Where the installer puts the launcher is the first place looked in after PATH. */
    expect(install.lands).toBe('~/.local/bin/claude')
    expect(dirname(install.lands.replace('~', HOME))).toBe(PROGRAM.find({ HOME, PATH: '' }).looked[0]!)
  })

  test('a stand-in can be named by whoever started the server, for walking the flow without a real install', () => {
    expect(PROGRAM.install({ KEHIKOT_CLAUDE_INSTALL_LINE: '/tmp/stand-in.sh' }).line).toBe('/tmp/stand-in.sh')
  })
})
