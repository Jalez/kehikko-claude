import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { settingsDeclarationSchema } from 'kehikot-module-protocol'

import { MANIFEST, TICKET, answer, hostCheck } from '../doors.ts'
import { readSettings, writeSettings } from '../record.ts'
import { SETTINGS } from '../settings.ts'

/**
 * Claude's settings at its door for the host (protocol 2.15.0): "Resume conversations cut off by a
 * restart" declared and the person's; a read and a change round trip through the same
 * `.kehikot/claude/settings.json` in the same format the page's toggle writes; an agent refused; a
 * person's pass asked only of the origins the host started this module with.
 */

const made: string[] = []
afterAll(() => {
  for (const one of made) rmSync(one, { recursive: true, force: true })
})
let project: string
const realFetch = globalThis.fetch
const realHas = hostCheck.has
beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-claude-settings-')))
  made.push(project)
  hostCheck.has = async (folder) => folder === project
})
afterEach(() => {
  globalThis.fetch = realFetch
  hostCheck.has = realHas
})

const file = () => join(project, '.kehikot', 'claude', 'settings.json')
const PASS = 'q'.repeat(30)

async function get(at = project) {
  const reply = await answer('GET', '/api/kehikot/settings', new URLSearchParams({ project: at }), null, null)
  return reply!.body as { values: Record<string, unknown>; file?: string; problem?: string }
}
async function set(body: Record<string, unknown>, ticket: string | null = null) {
  const reply = await answer('POST', '/api/kehikot/settings', new URLSearchParams(), { project, ...body }, ticket)
  return reply!.body as { outcome: string; why: string; values?: Record<string, unknown> }
}
function host(person: boolean) {
  const asked: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input))
    return Response.json({ ok: true, person })
  }) as unknown as typeof fetch
  return asked
}

describe('the declaration', () => {
  test('is in the manifest, parses, is the person’s, and defaults to on as the file does', () => {
    expect(MANIFEST.declares.settings).toEqual(SETTINGS)
    expect(settingsDeclarationSchema.parse(SETTINGS)).toEqual(SETTINGS)
    expect(SETTINGS.map((one) => one.key)).toEqual(["resumeCutOff", "statusLine", "folders"])
    expect(SETTINGS[0]).toMatchObject({ key: 'resumeCutOff', type: 'boolean', default: true, scope: 'project', personOnly: true })
    expect(readSettings(project).resumeCutOff).toBe(SETTINGS[0]!.default as boolean)
    expect(SETTINGS[1]).toMatchObject({ key: 'statusLine', label: 'Status line in sessions', type: 'boolean', default: true, scope: 'project', personOnly: true })
    expect(readSettings(project).statusLine).toBe(SETTINGS[1]!.default as boolean)
  })
})

describe('read and change, round trip', () => {
  test('get reads the default with no file, then what the toggle wrote', async () => {
    expect(await get()).toEqual({ ok: true, values: { resumeCutOff: true, statusLine: true, folders: [] }, file: '.kehikot/claude/settings.json' } as never)
    writeSettings(project, { resumeCutOff: false })
    expect((await get()).values).toEqual({ resumeCutOff: false, statusLine: true, folders: [] })
    /* One key written keeps the other. */
    writeSettings(project, { statusLine: false })
    expect((await get()).values).toEqual({ resumeCutOff: false, statusLine: false, folders: [] })
  })

  test("the page's ticket is the person: saved, in the format the toggle writes", async () => {
    expect((await set({ key: 'resumeCutOff', value: false }, TICKET)).outcome).toBe('saved')
    expect(readFileSync(file(), 'utf8')).toBe(`${JSON.stringify({ resumeCutOff: false, statusLine: true, folders: [] }, null, 2)}\n`)
    expect(readSettings(project).resumeCutOff).toBe(false)
    expect((await set({ key: 'statusLine', value: false }, TICKET)).outcome).toBe('saved')
    expect(readSettings(project)).toEqual({ resumeCutOff: false, statusLine: false, folders: [] })
    /* And the page's own route still reads it, and changes one key at a time. */
    const page = await answer('GET', '/api/settings', new URLSearchParams({ projectPath: project }), null, TICKET)
    expect((page!.body as { settings: unknown }).settings).toEqual({ resumeCutOff: false, statusLine: false, folders: [] })
    const turned = await answer('POST', '/api/settings', new URLSearchParams(), { projectPath: project, statusLine: true }, TICKET)
    expect((turned!.body as { settings: unknown }).settings).toEqual({ resumeCutOff: false, statusLine: true, folders: [] })
    expect((await answer('POST', '/api/settings', new URLSearchParams(), { projectPath: project, statusLine: 'yes' }, TICKET))?.status).toBe(400)
    expect((await answer('POST', '/api/settings', new URLSearchParams(), { projectPath: project }, TICKET))?.status).toBe(400)
    expect((await set({ key: 'nope', value: false }, TICKET)).outcome).toBe('refused')
  })

  test('a folder the host does not hold is neither read nor written', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-claude-settings-other-')))
    made.push(other)
    expect((await get(other)).problem).toContain('not a project open in Kehikot')
    const said = await answer('POST', '/api/kehikot/settings', new URLSearchParams(), { project: other, key: 'resumeCutOff', value: false }, TICKET)
    expect((said!.body as { outcome: string }).outcome).toBe('refused')
    expect(existsSync(join(other, '.kehikot'))).toBe(false)
  })
})

describe('who may change it', () => {
  test('an agent is refused, with or without saying "person", and nothing is written', async () => {
    const asked = host(true)
    for (const body of [{ key: 'resumeCutOff', value: false }, { key: 'resumeCutOff', value: false, by: 'person' }]) {
      const said = await set(body)
      expect(said.outcome).toBe('refused')
      expect(said.why).toContain('An agent cannot change it')
    }
    expect(asked).toEqual([])
    expect(existsSync(file())).toBe(false)
  })

  test("a person's pass is asked only of the host's own origins, never of an address the request names", async () => {
    const asked = host(true)
    const said = await set({ key: 'resumeCutOff', value: false, by: 'person', pass: PASS, host: 'http://evil.example' })
    expect(said.outcome).toBe('saved')
    expect(asked).toHaveLength(1)
    expect(asked[0]!.startsWith(`${process.env.KEHIKOT_ORIGINS}/host/settings-pass?`)).toBe(true)
    expect(asked[0]).toContain('module=kehikot.claude')
    expect(asked[0]).toContain('key=resumeCutOff')
  })

  test('a pass the host does not vouch for is refused', async () => {
    host(false)
    expect((await set({ key: 'resumeCutOff', value: false, by: 'person', pass: PASS })).outcome).toBe('refused')
    expect(readSettings(project).resumeCutOff).toBe(true)
  })
})

describe('other folders sessions may work in', () => {
  const folder = (name: string) => {
    const at = join(realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-claude-folder-'))), name)
    mkdirSync(at, { recursive: true })
    made.push(at)
    return at
  }

  test('is declared as a list of the person’s, empty by default', () => {
    expect(SETTINGS.find((one) => one.key === 'folders')).toMatchObject({ type: 'list', default: [], scope: 'project', personOnly: true, label: 'Other folders sessions may work in' })
    expect(readSettings(project).folders).toEqual([])
  })

  test('a person saves it, per project, in the same file; a bad folder and an agent are refused and nothing changes', async () => {
    const one = folder('one')
    const two = folder('two')
    expect((await set({ key: 'folders', value: [one, `${two}/`, one] }, TICKET)).outcome).toBe('saved')
    expect(readSettings(project).folders).toEqual([one, two])
    expect(JSON.parse(readFileSync(file(), 'utf8')).folders).toEqual([one, two])
    expect((await get()).values.folders).toEqual([one, two])
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-claude-settings-other-')))
    made.push(other)
    expect(readSettings(other).folders).toEqual([])
    const refused = await set({ key: 'folders', value: [process.env.HOME!] }, TICKET)
    expect(refused.outcome).toBe('refused')
    expect(refused.why).toContain('home folder')
    expect((await set({ key: 'folders', value: [] })).outcome).toBe('refused')
    expect(readSettings(project).folders).toEqual([one, two])
    /* The switches are kept as they were. */
    expect(readSettings(project)).toMatchObject({ resumeCutOff: true, statusLine: true })
  })

  test('the page’s own route takes it with the same checks', async () => {
    const one = folder('page')
    const saved = await answer('POST', '/api/settings', new URLSearchParams(), { projectPath: project, folders: [one] }, TICKET)
    expect((saved!.body as { settings: { folders: string[] } }).settings.folders).toEqual([one])
    const refused = await answer('POST', '/api/settings', new URLSearchParams(), { projectPath: project, folders: ['/'] }, TICKET)
    expect(refused!.status).toBe(400)
    expect(readSettings(project).folders).toEqual([one])
  })
})
