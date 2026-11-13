import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { doorConfigProblems, isStableDoor, keptFolderName, legacyKeptFolderName } from 'kehikot-module-protocol/serve'

import { configDirOf, hostPlace, keptDirOf, keptOwner, withOwnDoor, writeKeptPlace, type SessionDoor } from '../doorConfig.ts'
import { Runs } from '../live.ts'
import { ID } from '../manifest.ts'
import { attach, markSession, tokenFor } from '../record.ts'

/**
 * Protocol 2.95.0: every door a session is written names the stable address of the host that
 * STARTED this module, never a module's own port and never another host — a scratch host an agent
 * ran over a copy of a project once wrote its doors into the person's sessions' kept files, and
 * Claude Code reconnects only to what it read at launch.
 */

const HOST = 'http://127.0.0.1:4170'
const SCRATCH = 'http://127.0.0.1:47700'
const TOKEN = 'c'.repeat(43)
const made: string[] = []
const scratch = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

describe('the door URL comes from the start environment', () => {
  test('the starting host alone is asked, and its answer is written on its stable address — whatever another origin says', async () => {
    const asked: string[] = []
    const answer = (origin: string) =>
      Response.json({
        ok: true,
        token: TOKEN,
        doors: [
          { module: 'kehikko', name: 'kehikko', url: `${origin}/mcp?kehikot-place=${TOKEN}`, transport: 'http' },
          { module: 'kehikot.paper', name: 'paper', url: `http://127.0.0.1:7870/mcp?kehikot-place=${TOKEN}`, transport: 'http' },
        ],
      })
    const fetch = (async (url: string) => {
      asked.push(new URL(url).origin)
      return answer(new URL(url).origin === HOST ? HOST : SCRATCH)
    }) as unknown as typeof globalThis.fetch
    const got = await hostPlace(
      { projectPath: '/p', projectId: null, token: TOKEN, kehikko: null },
      { env: { KEHIKOT_HOST: HOST, KEHIKOT_ORIGINS: `${SCRATCH} http://127.0.0.1:4181` }, fetch },
    )
    expect(asked).toEqual([HOST])
    expect(got!.doors.map((door) => door.url)).toEqual([`${HOST}/mcp?kehikot-place=${TOKEN}`, `${HOST}/m/kehikot.paper/mcp?kehikot-place=${TOKEN}`])
  })

  test('a foreign-origin host is never asked: when the starting host does not answer, there are no doors', async () => {
    const asked: string[] = []
    const fetch = (async (url: string) => {
      asked.push(new URL(url).origin)
      throw new Error('refused')
    }) as unknown as typeof globalThis.fetch
    expect(await hostPlace({ projectPath: '/p', projectId: null, token: TOKEN, kehikko: null }, { env: { KEHIKOT_HOST: HOST, KEHIKOT_ORIGINS: SCRATCH }, fetch })).toBeNull()
    expect(asked).toEqual([HOST])
  })
})

describe('a raw-port entry is never written', () => {
  test('this module’s own door is on the starting host’s stable address', () => {
    const doors = withOwnDoor(null, HOST, TOKEN)!
    expect(doors).toEqual([{ module: ID, name: 'kehikko-claude', url: `${HOST}/m/${ID}/mcp?kehikot-place=${TOKEN}`, transport: 'http' }])
    expect(doorConfigProblems({ mcpServers: { [doors[0]!.name]: { url: doors[0]!.url } } }, HOST)).toEqual([])
  })
})

describe('kept folders are the starting host’s, and stale ones are rewritten', () => {
  const place = { epic: 'thesis', parts: [], kehikko: { key: 'k1a2b3c4' }, kehikkoName: 'writing' }
  const SESSION = '33333333-3333-4333-8333-333333333333'

  /** A project whose record holds a background conversation, and the folder its kept files were in before 2.95.0. */
  function conversation(doors: Record<string, string>, placePath?: string) {
    const project = scratch('kehikko-claude-stable-')
    const base = scratch('kehikko-claude-base-')
    attach(project, place, SESSION)
    markSession(project, SESSION, (one) => ((one.background = true), true))
    const token = tokenFor(project, SESSION, () => TOKEN)!
    const legacy = join(configDirOf(base), legacyKeptFolderName(token))
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'mcp.json'), JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(doors).map(([name, url]) => [name, { type: 'http', url: `${url}?kehikot-place=${token}` }])) }))
    writeKeptPlace(legacy, { projectPath: placePath ?? project, projectId: null, key: 'epic=thesis;parts=-;kehikko=key:k1a2b3c4' })
    return { project, base, token, legacy }
  }

  const runs = (base: string, answers: (origin: string) => Promise<boolean>, doors: SessionDoor[] | null = null) =>
    new Runs({ spawn: (() => { throw new Error('nothing is spawned here') }) as never, screen: (() => { throw new Error('no screen') }) as never, every: null, watchEvery: null, meterEvery: null, configBase: base, host: HOST, answers, doors: async () => doors })

  test('a session another host wrote over (doors on a host that is gone, place in its copy) is claimed and put back on the stable doors', async () => {
    const { project, base, token, legacy } = conversation({ kehikko: `${SCRATCH}/mcp`, paper: `${SCRATCH}/m/kehikot.paper/mcp`, notes: 'http://127.0.0.1:7940/mcp' }, '/elsewhere/s2/proj/CS-DEGREE')
    const r = runs(base, async () => false)
    expect(await r.repairKept(project)).toBe(1)
    expect(keptOwner(legacy)).toBe(HOST)
    expect(keptDirOf(token, base, HOST)).toBe(legacy)
    const config = JSON.parse(readFileSync(join(legacy, 'mcp.json'), 'utf8'))
    expect(doorConfigProblems(config, HOST)).toEqual([])
    expect(Object.keys(config.mcpServers).sort()).toEqual(['kehikko', 'kehikko-claude', 'paper'])
    for (const one of Object.values(config.mcpServers) as { url: string }[]) expect(isStableDoor(one.url, HOST)).toBe(true)
    /* Its place is this project again. */
    expect(JSON.parse(readFileSync(join(legacy, 'place.json'), 'utf8')).projectPath).toBe(project)
    /* Asked again: nothing left to do. */
    expect(await r.repairKept(project)).toBe(0)
  })

  test('the host’s own answer is what is written when it answers', async () => {
    const { project, base, token, legacy } = conversation({ kehikko: `${SCRATCH}/mcp` })
    const r = runs(base, async () => false, [{ module: 'kehikot.notes', name: 'notes', url: `http://127.0.0.1:7940/mcp?kehikot-place=${token}`, transport: 'http' }])
    expect(await r.repairKept(project)).toBe(1)
    const config = JSON.parse(readFileSync(join(legacy, 'mcp.json'), 'utf8'))
    expect(config.mcpServers.notes.url).toBe(`${HOST}/m/kehikot.notes/mcp?kehikot-place=${token}`)
  })

  test('a folder another host that still answers has claimed is left to it; this host’s copy keeps its own', async () => {
    const { project, base, token, legacy } = conversation({ kehikko: `${SCRATCH}/mcp` }, '/elsewhere/copy')
    writeFileSync(join(legacy, 'owner.json'), JSON.stringify({ host: SCRATCH }))
    const before = readFileSync(join(legacy, 'mcp.json'), 'utf8')
    const r = runs(base, async () => true)
    await r.repairKept(project)
    expect(readFileSync(join(legacy, 'mcp.json'), 'utf8')).toBe(before)
    expect(keptDirOf(token, base, HOST)).toBe(join(configDirOf(base), keptFolderName(token, HOST)))
    expect(existsSync(join(configDirOf(base), keptFolderName(token, HOST)))).toBe(false)
  })

  test('the same token under a scratch host names another folder than the person’s', () => {
    const base = scratch('kehikko-claude-base-')
    expect(keptDirOf(TOKEN, base, SCRATCH)).not.toBe(keptDirOf(TOKEN, base, HOST))
  })
})
