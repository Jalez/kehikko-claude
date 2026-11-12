import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'

import { AGENT_SETUP, AGENT_SETUP_CARRIED_PATH, AGENT_SETUP_KEYS, agentSetupSchema, settingsValues } from 'kehikot-module-protocol'

import { MANIFEST, TICKET, answer } from '../doors.ts'
import { SETTINGS } from '../settings.ts'
import { readSetup, setupFile, SETUP_FIELDS } from '../setup.ts'

/*
 * "Use every module's tools and skills in Claude Code outside Kehikot too" (protocol 2.91.0): this
 * module provides `agent.setup`, holds the choice as four machine settings, shows and saves them at its
 * settings door with no project, and carries the host's earlier choice over once.
 */

const realFetch = globalThis.fetch
beforeEach(() => rmSync(setupFile(), { force: true }))
afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(setupFile(), { force: true })
})

/** A stand-in host: what it answers at the carried path, and every URL it was asked. */
function host(carried: Response | (() => Response), person = true) {
  const asked: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    asked.push(url)
    if (url.includes(AGENT_SETUP_CARRIED_PATH)) return typeof carried === 'function' ? carried() : carried.clone()
    return Response.json({ ok: true, person })
  }) as unknown as typeof fetch
  return asked
}

const get = async () => (await answer('GET', '/api/kehikot/settings', new URLSearchParams(), null, null))!.body as { values: Record<string, unknown>; problem?: string }
const set = async (key: string, value: unknown, ticket: string | null = TICKET) =>
  (await answer('POST', '/api/kehikot/settings', new URLSearchParams(), { key, value }, ticket))!.body as { outcome: string; why: string; values?: Record<string, unknown> }

describe('agent.setup', () => {
  test('provided, worded for Claude Code, and the four settings declared as machine and the person’s', () => {
    const descriptor = (MANIFEST.services as Record<string, unknown>)[AGENT_SETUP]
    expect(agentSetupSchema.parse(descriptor)).toEqual({ name: 'Claude', program: 'Claude Code', cli: 'claude' })
    for (const field of SETUP_FIELDS) {
      expect(SETTINGS.find((one) => one.key === field.key)).toMatchObject({ scope: 'machine', personOnly: true })
    }
    expect(SETUP_FIELDS[0]!.label).toBe('Use every module’s tools in Claude Code outside Kehikot too')
  })

  test('the host’s earlier choice is carried over once, then the module’s own is what is read', async () => {
    const earlier = { [AGENT_SETUP_KEYS.tools]: true, [AGENT_SETUP_KEYS.toolsExcept]: ['kehikot.notes'], [AGENT_SETUP_KEYS.skills]: false, [AGENT_SETUP_KEYS.skillsExcept]: [] }
    const asked = host(Response.json({ ok: true, values: earlier }))
    expect((await get()).values).toMatchObject(earlier)
    expect(JSON.parse(readFileSync(setupFile(), 'utf8'))).toEqual(earlier)
    const carried = asked.length
    expect((await get()).values).toMatchObject(earlier)
    expect(asked.length).toBe(carried)
  })

  test('a host that held none leaves the defaults (off); one that does not answer is said, not taken for off', async () => {
    host(new Response('{}', { status: 404 }))
    const none = await get()
    expect(none.problem).toBeUndefined()
    expect(none.values[AGENT_SETUP_KEYS.tools]).toBe(false)
    expect(existsSync(setupFile())).toBe(false)
    globalThis.fetch = (async () => {
      throw new Error('refused')
    }) as unknown as typeof fetch
    expect((await readSetup()).problem).toContain('could not be carried over')
  })

  test('shown and saved with no project: the person’s change is kept, an agent’s refused', async () => {
    host(new Response('{}', { status: 404 }))
    expect((await set(AGENT_SETUP_KEYS.tools, true)).outcome).toBe('saved')
    expect((await set(AGENT_SETUP_KEYS.skillsExcept, ['kehikot.paper'])).outcome).toBe('saved')
    expect(settingsValues(SETUP_FIELDS, (await get()).values)).toEqual({
      [AGENT_SETUP_KEYS.tools]: true,
      [AGENT_SETUP_KEYS.toolsExcept]: [],
      [AGENT_SETUP_KEYS.skills]: false,
      [AGENT_SETUP_KEYS.skillsExcept]: ['kehikot.paper'],
    })
    expect((await set(AGENT_SETUP_KEYS.tools, false, null)).outcome).toBe('refused')
    expect((await get()).values[AGENT_SETUP_KEYS.tools]).toBe(true)
    expect((await set(AGENT_SETUP_KEYS.tools, 'yes')).outcome).toBe('refused')
  })
})
