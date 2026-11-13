import { afterAll, test } from 'bun:test'
import { copyFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { expectAgentConformance } from 'kehikot-module-protocol/testing'

import { answer } from '../doors.ts'
import { HOST_DOOR, START_PATH } from '../hostServices.ts'
import { freshToken } from '../doorConfig.ts'
import { here, type HereNeeds } from '../here.ts'
import { Runs, headless } from '../live.ts'
import { ID, MANIFEST } from '../manifest.ts'
import { placeKey } from '../place.ts'
import { PROGRAM, type Active, type Program } from '../program.ts'
import { assign, tokenFor } from '../record.ts'

/**
 * The shared agent-module conformance (protocol 2.96.0): messaging is the host's, and this module
 * proves which conversation is calling, delivers, and places a conversation started outside Kehikot
 * (`/kehikot-here`) with a key it can message with.
 *
 * And (protocol 2.99.0) the END-TO-END proof of `agent.tasks`, with no fake provider anywhere on the
 * module's side: the host's request goes through this module's real door (`HOST_DOOR`: the vouch round
 * trip to the stand-in host, the body, `startTask`), the real `Runs` and the real `program.ts`, which
 * runs a stand-in `claude` (test/stand-in/claude) whose `--bg` takes 20 s to boot. `start` must answer
 * within a second, accepting; a stand-in that fails must reach the host as `tasks.report` failed, with
 * why; one that boots must reach it as started, naming the conversation `agents --json` listed. Every
 * adopt that failed with "did not answer within 8 s" fails here first.
 */

const made: string[] = []
const dir = () => {
  const one = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-claude-conformance-')))
  made.push(one)
  return one
}
afterAll(() => {
  for (const one of made) rmSync(one, { recursive: true, force: true })
})

/**
 * The stand-in `claude` on PATH for a start, in a folder of its own (a new path, so `supports` asks
 * it afresh), able to run a session in the background and taking `bootMs` to boot it. The undo puts
 * the environment back and ends every background process the stand-in left.
 */
function standIn(behaviour: { bootMs: number; fails?: boolean }): () => void {
  const bin = dir()
  copyFileSync(join(import.meta.dir, 'stand-in', 'claude'), join(bin, 'claude'))
  chmodSync(join(bin, 'claude'), 0o755)
  const had = { PATH: process.env.PATH, STANDIN_BG: process.env.STANDIN_BG, STANDIN_BOOT_MS: process.env.STANDIN_BOOT_MS, STANDIN_BOOT_FAILS: process.env.STANDIN_BOOT_FAILS }
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
  process.env.STANDIN_BG = '1'
  process.env.STANDIN_BOOT_MS = String(behaviour.bootMs)
  if (behaviour.fails) process.env.STANDIN_BOOT_FAILS = '1'
  else delete process.env.STANDIN_BOOT_FAILS
  return () => {
    for (const [name, value] of Object.entries(had)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    /* The background sessions the stand-in started: their processes, by the pid files it keeps. */
    const sessions = join(process.env.CLAUDE_CONFIG_DIR ?? '', 'sessions')
    if (existsSync(sessions)) {
      for (const file of readdirSync(sessions)) {
        const pid = Number(file.replace(/\.json$/, ''))
        try {
          if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid)
        } catch {
          /* Gone already. */
        }
      }
    }
  }
}

/** A request from the host to `start`, through this module's real door. */
async function startThroughTheDoor(body: unknown, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const url = new URL(`http://127.0.0.1:1${START_PATH}`)
  const said = await HOST_DOOR(new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }), { url } as never)
  if (!said) return { status: 404, body: null }
  return { status: said.status, body: await said.json().catch(() => null) }
}

const OUTSIDE = '44444444-4444-4444-8444-444444444444'
const LAUNCHED = '55555555-5555-4555-8555-555555555555'
const WRITING = { epic: 'thesis', parts: [], kehikko: { key: 'k1a2b3c4' }, kehikkoName: 'writing' }

test('meets the agent-module conformance', async () => {
  const project = dir()
  const running: Active[] = [{ session: OUTSIDE, kind: 'interactive', called: 'interactive', handle: null, pid: 4242, cwd: project, startedAt: 1, name: '' }]
  const program: Program = {
    ...PROGRAM,
    find: () => ({ file: '/fake/bin/claude', looked: ['/fake/bin'], usual: [] }),
    supports: async () => ({ ok: true, missing: null, tells: false, lists: true, names: false, configures: false, plugins: false }),
    active: async () => ({ known: true, active: running }),
  }
  const runs = new Runs({ program, spawn: () => { throw new Error('nothing is started here') }, screen: headless, every: null, watchEvery: null })
  runs.feeds('page-conformance')
  runs.show('page-conformance', { projectPath: project, key: placeKey(WRITING), place: WRITING, onScreen: true })
  const needs: HereNeeds = {
    program,
    showingIn: (path) => runs.showingIn(path),
    knownProjects: () => [project],
    hostHas: async (folder) => folder === project,
    told: (path, assigned) => runs.told(path, assigned),
  }
  await expectAgentConformance({
    manifest: MANIFEST,
    door: (method, path, query, body) => answer(method, path, query, body, null),
    project,
    adopt: async () => ({ said: await here(OUTSIDE, '', needs), conversation: OUTSIDE }),
    launched: async (host) => {
      assign(project, WRITING, LAUNCHED, { own: false })
      const token = tokenFor(project, LAUNCHED, freshToken)!
      host.issued.set(token, { module: ID, project })
      return { token }
    },
    tasks: {
      start: startThroughTheDoor,
      program: async (behaviour) => standIn(behaviour),
    },
  })
}, 60_000)
