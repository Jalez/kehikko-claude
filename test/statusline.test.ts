import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PROGRAM, ownStatusLine } from '../program.ts'
import { sessionPlugin, statusScriptIn, writeComposer, writeOwnStatusLine } from '../skills.ts'
import { compose } from '../statusline-line.mjs'

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

async function plugin(own: string | null, runtime: string | null = null): Promise<string> {
  const base = mkdtempSync(join(scratch, 'base-'))
  const dir = (await sessionPlugin([], { base, claudeDir: base, token: TOKEN, registration: join(scratch, 'none.json') }))!
  writeFileSync(join(dir, 'kehikot', 'origin'), origin)
  expect(writeOwnStatusLine(dir, own)).toBe(true)
  expect(writeComposer(dir, runtime)).toBe(true)
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

  test('with none of the person’s and the module’s own line wanted, it prints that line, one line, and still reports', async () => {
    const dir = await plugin(null, process.execPath)
    heard.length = 0
    const got = await ran(['/bin/sh', statusScriptIn(dir)], scratch, { COLUMNS: '200', NO_COLOR: '1' })
    expect(got).toMatchObject({ code: 0 })
    expect(got.err.toString()).toBe('')
    expect(got.out.toString()).toBe('ctx 15% · Opus 5.5\n')
    expect(got.ms).toBeLessThan(1500)
    await until(() => heard.length > 0)
    expect(heard).toHaveLength(1)
    expect(heard[0]!.url).toBe(`/api/status?session=${SESSION}`)
    expect(heard[0]!.body).toBe(JSON_IN)
  })

  test('the person’s own line wins over the module’s, and a runtime that is not there prints nothing', async () => {
    let dir = await plugin('printf mine', process.execPath)
    expect((await ran(['/bin/sh', statusScriptIn(dir)], scratch)).out.toString()).toBe('mine')
    dir = await plugin(null, join(scratch, 'no-such-runtime'))
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
    /* The setting on or off, theirs is theirs. */
    expect(PROGRAM.statusLine!(project, '/kept/plugin/statusline.sh', env, true)).toEqual(made)
  })

  test('none of theirs: none is added; one this module cannot run as Claude Code would is left alone', () => {
    let { project, env } = home({ 'config/settings.json': { theme: 'dark' }, 'project/.claude/settings.json': 'not json' })
    expect(ownStatusLine(project, env)).toBe('none')
    /* None of theirs and "Status line in sessions" off: none is added. */
    expect(PROGRAM.statusLine!(project, '/s.sh', env)).toBeNull()
    expect(PROGRAM.statusLine!(project, '/s.sh', env, false)).toBeNull()
    /* On: the module's own, with no command of theirs to run first. */
    expect(PROGRAM.statusLine!(project, '/s.sh', env, true)).toEqual({ settings: { statusLine: { type: 'command', command: `/bin/sh '/s.sh'`, padding: 0 } }, own: null })
    ;({ project, env } = home({ 'config/settings.json': { statusLine: null } }))
    expect(PROGRAM.statusLine!(project, '/s.sh', env)).toBeNull()
    for (const odd of [{ type: 'command', command: 'node', args: ['x.js'] }, { type: 'command', command: 'x', shell: 'powershell' }, { type: 'other' }, 'echo hi']) {
      ;({ project, env } = home({ 'config/settings.json': { statusLine: odd } }))
      expect(ownStatusLine(project, env)).toBe('other')
      expect(PROGRAM.statusLine!(project, '/s.sh', env)).toBeNull()
      /* Theirs, even one this module cannot run, is never replaced by the module's. */
      expect(PROGRAM.statusLine!(project, '/s.sh', env, true)).toBeNull()
    }
  })

  test('a path with a quote in it is still one word', () => {
    const { project, env } = home({ 'config/settings.json': { statusLine: { type: 'command', command: 'mine.sh' } } })
    const made = PROGRAM.statusLine!(project, "/tmp/it's here/statusline.sh", env)!
    expect((made.settings.statusLine as { command: string }).command).toBe(`/bin/sh '/tmp/it'\\''s here/statusline.sh'`)
    expect(readFileSync(statusScriptIn(join(import.meta.dirname, '..')), 'utf8')).toContain('exit $said')
  })
})

describe('the module’s own line (statusline-line.mjs), from Claude Code’s status line JSON', () => {
  /* A Monday, 14:00 local time; the week resets on Thursday at 09:00, the five hours at 17:30 today. */
  const NOW = new Date(2026, 9, 26, 14, 0).getTime()
  const at = (date: Date) => date.getTime() / 1000
  const THURSDAY = at(new Date(2026, 9, 29, 9, 0))
  const TODAY = at(new Date(2026, 9, 26, 17, 30))
  const payload = (week: number | null, hours: number | null, ctx: number | null = 42) => ({
    session_id: SESSION,
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    context_window: { context_window_size: 200000, used_percentage: ctx },
    ...(week === null && hours === null
      ? {}
      : { rate_limits: { ...(week === null ? {} : { seven_day: { used_percentage: week, resets_at: THURSDAY } }), ...(hours === null ? {} : { five_hour: { used_percentage: hours, resets_at: TODAY } }) } }),
  })
  const line = (json: unknown, columns: number | null, colour = false) => compose(json, { columns, now: NOW, colour })

  test('wide: context, the week with its reset, the five hours, the model', () => {
    expect(line(payload(62.4, 18), 200)).toBe('ctx 42% · week 62% (resets Thu 09:00) · 5h 18% · Opus 5.5')
    /* No width said: a wide terminal is assumed. */
    expect(line(payload(62.4, 18), null)).toBe('ctx 42% · week 62% (resets Thu 09:00) · 5h 18% · Opus 5.5')
  })

  test('narrower: the model goes first, then the reset, then whole parts from the right; never wider than the row', () => {
    const json = payload(62, 18)
    const widths = [80, 60, 40, 30, 14]
    const said = widths.map((columns) => line(json, columns))
    expect(said).toEqual([
      'ctx 42% · week 62% (resets Thu 09:00) · 5h 18% · Opus 5.5',
      'ctx 42% · week 62% (resets Thu 09:00) · 5h 18%',
      'ctx 42% · week 62% · 5h 18%',
      'ctx 42% · week 62%',
      'ctx 42%',
    ])
    for (const [i, one] of said.entries()) {
      expect(one.includes('\n')).toBe(false)
      expect([...one].length).toBeLessThanOrEqual(widths[i]! - 4)
    }
    /* Narrower than anything: the first part, for Claude Code to cut. */
    expect(line(json, 5)).toBe('ctx 42%')
  })

  test('near and at the limit: said in words, and coloured only beside them', () => {
    expect(line(payload(85, 18), 200)).toBe('ctx 42% · week 85% near limit (resets Thu 09:00) · 5h 18% · Opus 5.5')
    /* The five hours near its limit says when it resets too. */
    expect(line(payload(62, 97), 200)).toBe('ctx 42% · week 62% (resets Thu 09:00) · 5h 97% at limit (resets 17:30) · Opus 5.5')
    expect(line(payload(62, 97), 60)).toBe('ctx 42% · week 62% · 5h 97% at limit')
    expect(line(payload(100, 18), 40)).toBe('ctx 42% · week 100% limit reached')
    const coloured = line(payload(85, 18), 200, true)
    expect(coloured).toBe('ctx 42% · \u001b[33mweek 85% near limit (resets Thu 09:00)\u001b[39m · 5h 18% · Opus 5.5')
    expect(line(payload(62, 18), 200, true)).not.toContain('\u001b')
    expect(line(payload(62, 99), 200, true)).toContain('\u001b[31m5h 99% at limit')
  })

  test('missing windows: what is there is said, and nothing of the rest', () => {
    /* An API-key login: no rate_limits at all. */
    expect(line(payload(null, null), 200)).toBe('ctx 42% · Opus 5.5')
    /* Only one window. */
    expect(line(payload(null, 30), 200)).toBe('ctx 42% · 5h 30% · Opus 5.5')
    expect(line(payload(70, null), 200)).toBe('ctx 42% · week 70% (resets Thu 09:00) · Opus 5.5')
    /* A window that has reset says nothing. */
    expect(line({ ...payload(null, null), rate_limits: { seven_day: { used_percentage: 99, resets_at: NOW / 1000 - 60 } } }, 200)).toBe('ctx 42% · Opus 5.5')
    /* Nothing sent yet: no context share. */
    expect(line(payload(62, null, null), 200)).toBe('week 62% (resets Thu 09:00) · Opus 5.5')
    /* Nothing at all: nothing printed. */
    expect(line({}, 200)).toBe('')
    expect(line(null, 200)).toBe('')
    expect(line({ model: { display_name: 'Bad\u001b[2Jname\nhere' } }, 200)).toBe('Bad [2Jname here')
  })
})
