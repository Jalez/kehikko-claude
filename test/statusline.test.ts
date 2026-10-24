import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PROGRAM, ownStatusLine } from '../program.ts'
import { sessionPlugin, statusScriptIn, writeOwnStatusLine } from '../skills.ts'

/**
 * `statusline.sh`, run for real from a session's plugin: the person's own status line comes out
 * exactly as their command alone would print it, and the JSON reaches this module beside it.
 */

const SESSION = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'T0kenT0kenT0kenT0kenT0kenT0kenT0ken_-x'
/* Claude Code 2.1.310's status line JSON, cut down, with a prompt-like string in it that must not be mistaken for the id. */
const JSON_IN = `${JSON.stringify({
  session_id: SESSION,
  transcript_path: '/x.jsonl',
  cwd: '/p',
  session_name: 'say "session_id":"99999999-9999-4999-8999-999999999999"',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  cost: { total_cost_usd: 0.04488 },
  context_window: { context_window_size: 1000000, current_usage: { input_tokens: 40, output_tokens: 20, cache_creation_input_tokens: 1200, cache_read_input_tokens: 150000 }, used_percentage: 15 },
})}\n`

interface Heard {
  url: string
  ticket: string | undefined
  type: string | undefined
  body: string
}
const heard: Heard[] = []
let server: Server
let origin = ''
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-claude-status-')))

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      heard.push({ url: request.url ?? '', ticket: request.headers['x-module-ticket'] as string | undefined, type: request.headers['content-type'] as string | undefined, body })
      response.writeHead(204).end()
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.close()
  rmSync(scratch, { recursive: true, force: true })
})

async function plugin(own: string | null): Promise<string> {
  const base = mkdtempSync(join(scratch, 'base-'))
  const dir = (await sessionPlugin([], { base, claudeDir: base, token: TOKEN, registration: join(scratch, 'none.json') }))!
  writeFileSync(join(dir, 'kehikot', 'origin'), origin)
  expect(writeOwnStatusLine(dir, own)).toBe(true)
  return dir
}

/** Run a command line as Claude Code would (bash, the JSON on stdin), and what came out, as bytes. */
function ran(argv: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: Buffer; err: Buffer; ms: number }> {
  const started = Date.now()
  return new Promise((done) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { PATH: '/usr/bin:/bin', ...env } })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('close', (code) => done({ code, out: Buffer.concat(out), err: Buffer.concat(err), ms: Date.now() - started }))
    child.stdin.end(JSON_IN)
  })
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((done) => setTimeout(done, 20))
}

describe('statusline.sh, from a session’s plugin', () => {
  test('prints the person’s own status line byte for byte — colours, spaces, no final newline, exit status and all', async () => {
    const work = mkdtempSync(join(scratch, 'work-'))
    /* A status line of the usual kind: reads the JSON, colours, a trailing space, two lines, the folder, an environment variable. */
    const theirs = `input=$(cat); m=$(printf '%s' "$input" | sed -n 's/.*"display_name":"\\([^"]*\\)".*/\\1/p'); printf '\\033[1;36m%s\\033[0m  %s \\n%s|%s' "$m" "$(basename "$PWD")" "$MINE" "$(printf '%s' "$input" | wc -c | tr -d ' ')"`
    const dir = await plugin(theirs)
    heard.length = 0
    const alone = await ran(['/bin/bash', '-c', theirs], work, { MINE: 'é ✓' })
    const wrapped = await ran(['/bin/sh', statusScriptIn(dir)], work, { MINE: 'é ✓' })
    expect(alone.out.length).toBeGreaterThan(10)
    expect(wrapped.out.equals(alone.out)).toBe(true)
    expect(wrapped.err.equals(alone.err)).toBe(true)
    expect(wrapped.code).toBe(alone.code)
    expect(wrapped.ms).toBeLessThan(1500)
    /* And the JSON went to this module, whole, with the token in a header, under the real session id. */
    await until(() => heard.length > 0)
    expect(heard).toHaveLength(1)
    expect(heard[0]!.url).toBe(`/api/status?session=${SESSION}`)
    expect(heard[0]!.ticket).toBe(TOKEN)
    expect(heard[0]!.type).toBe('application/json')
    expect(heard[0]!.body).toBe(JSON_IN)
  })

  test('a status line that fails fails the same way, and one that prints nothing prints nothing', async () => {
    const work = mkdtempSync(join(scratch, 'work-'))
    for (const theirs of ['echo partial; exit 3', 'cat >/dev/null; true', 'echo to-stderr >&2']) {
      const dir = await plugin(theirs)
      const alone = await ran(['/bin/bash', '-c', theirs], work)
      const wrapped = await ran(['/bin/sh', statusScriptIn(dir)], work)
      expect({ code: wrapped.code, out: wrapped.out.toString('latin1'), err: wrapped.err.toString('latin1') }).toEqual({ code: alone.code, out: alone.out.toString('latin1'), err: alone.err.toString('latin1') })
    }
  })

  test('with no status line of the person’s, it prints nothing and still reports', async () => {
    const dir = await plugin(null)
    heard.length = 0
    const got = await ran(['/bin/sh', statusScriptIn(dir)], scratch)
    expect(got).toMatchObject({ code: 0 })
    expect(got.out.length).toBe(0)
    await until(() => heard.length > 0)
    expect(heard[0]?.body).toBe(JSON_IN)
  })

  test('a module that is not there is silence, and the person’s line is still printed at once', async () => {
    const dir = await plugin('printf mine')
    writeFileSync(join(dir, 'kehikot', 'origin'), 'http://127.0.0.1:9')
    const got = await ran(['/bin/sh', statusScriptIn(dir)], scratch)
    expect(got.out.toString()).toBe('mine')
    expect(got.code).toBe(0)
    /* Somewhere that is not this computer is never asked. */
    writeFileSync(join(dir, 'kehikot', 'origin'), 'http://example.com')
    heard.length = 0
    expect((await ran(['/bin/sh', statusScriptIn(dir)], scratch)).out.toString()).toBe('mine')
    await new Promise((done) => setTimeout(done, 300))
    expect(heard).toHaveLength(0)
  })
})

describe('the person’s own status line, as the settings say it', () => {
  const home = (files: Record<string, unknown>) => {
    const root = mkdtempSync(join(scratch, 'settings-'))
    const project = join(root, 'project')
    const config = join(root, 'config')
    mkdirSync(join(project, '.claude'), { recursive: true })
    mkdirSync(config, { recursive: true })
    for (const [where, said] of Object.entries(files)) writeFileSync(join(root, where), typeof said === 'string' ? said : JSON.stringify(said))
    return { project, env: { CLAUDE_CONFIG_DIR: config } as NodeJS.ProcessEnv }
  }

  test('the project’s local settings, then its shared ones, then the person’s own; their padding kept, their command run by this module’s', () => {
    const user = { statusLine: { type: 'command', command: 'mine.sh', padding: 1 } }
    let { project, env } = home({ 'config/settings.json': user })
    expect(ownStatusLine(project, env)).toEqual({ line: user.statusLine, command: 'mine.sh' })
    ;({ project, env } = home({ 'config/settings.json': user, 'project/.claude/settings.json': { statusLine: { type: 'command', command: 'shared.sh' } } }))
    expect(ownStatusLine(project, env)).toMatchObject({ command: 'shared.sh' })
    ;({ project, env } = home({ 'config/settings.json': user, 'project/.claude/settings.json': { statusLine: { type: 'command', command: 'shared.sh' } }, 'project/.claude/settings.local.json': { statusLine: { type: 'command', command: 'local.sh' } } }))
    expect(ownStatusLine(project, env)).toMatchObject({ command: 'local.sh' })
    ;({ project, env } = home({ 'config/settings.json': user }))
    const made = PROGRAM.statusLine!(project, '/kept/plugin/statusline.sh', env)!
    expect(made).toEqual({ settings: { statusLine: { padding: 1, type: 'command', command: `/bin/sh '/kept/plugin/statusline.sh'` } }, own: 'mine.sh' })
  })

  test('none is none; one this module cannot run as Claude Code would is left alone', () => {
    let { project, env } = home({ 'config/settings.json': { theme: 'dark' }, 'project/.claude/settings.json': 'not json' })
    expect(ownStatusLine(project, env)).toBe('none')
    expect(PROGRAM.statusLine!(project, '/s.sh', env)).toEqual({ settings: { statusLine: { type: 'command', command: `/bin/sh '/s.sh'` } }, own: null })
    for (const odd of [{ type: 'command', command: 'node', args: ['x.js'] }, { type: 'command', command: 'x', shell: 'powershell' }, { type: 'other' }, 'echo hi']) {
      ;({ project, env } = home({ 'config/settings.json': { statusLine: odd } }))
      expect(ownStatusLine(project, env)).toBe('other')
      expect(PROGRAM.statusLine!(project, '/s.sh', env)).toBeNull()
    }
  })

  test('a path with a quote in it is still one word', () => {
    const { project, env } = home({})
    const made = PROGRAM.statusLine!(project, "/tmp/it's here/statusline.sh", env)!
    expect((made.settings.statusLine as { command: string }).command).toBe(`/bin/sh '/tmp/it'\\''s here/statusline.sh'`)
    expect(readFileSync(statusScriptIn(join(import.meta.dirname, '..')), 'utf8')).toContain('exit $said')
  })
})
