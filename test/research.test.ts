import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declaredEvent, inboxEventsSchema } from 'kehikot-module-protocol'

import { RESEARCH_LINE } from '../context.ts'
import { MANIFEST } from '../manifest.ts'
import { EVENTS, isResearch, subagentMeta } from '../research.ts'

/** "Research complete" (protocol 2.31.0): the event this module declares, and when a subagent's finish is one. */

const scratch = mkdtempSync(join(tmpdir(), 'kehikko-claude-research-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('the event', () => {
  test('is declared in the manifest, as the protocol takes it, as a case of done', () => {
    expect(MANIFEST.events).toEqual([{ id: 'research-complete', says: 'Research complete', state: 'done', sound: 'answer' }])
    expect(inboxEventsSchema.safeParse(EVENTS).success).toBe(true)
    expect(declaredEvent(MANIFEST.events, { state: 'done', event: 'research-complete' })?.says).toBe('Research complete')
  })

  test('a session is told how to say it, for itself and its subagents', () => {
    expect(RESEARCH_LINE).toContain('tell_finished')
    expect(RESEARCH_LINE).toContain('research-complete')
    expect(RESEARCH_LINE).toContain('subagent')
  })

  test('and so is a person’s /kehikot-here', async () => {
    const skill = await Bun.file(join(import.meta.dir, '..', 'plugin', 'skills', 'kehikot-here', 'SKILL.md')).text()
    expect(skill).toContain('tell_finished({ event: "research-complete", label })')
  })
})

describe('isResearch, the one rule', () => {
  test('research words in the description, whatever the agent', () => {
    for (const description of ['Audit the protocol', 'Research Claude Code hooks', 'Investigate the flaky test', 'Compare the two parsers', 'Find out why it hangs', 'Look into the cache', 'Survey the modules', 'Review the PR for bugs', 'Analyze the logs']) {
      expect(isResearch({ agentType: 'some-custom-agent', description })).toBe(true)
    }
  })

  test('finding and tracing count for an agent that only reads', () => {
    expect(isResearch({ agentType: 'Explore', description: 'Find where chimes are played' })).toBe(true)
    expect(isResearch({ agentType: 'general-purpose', description: 'Trace the inbox report path' })).toBe(true)
    expect(isResearch({ agentType: 'statusline-setup', description: 'Find the status line' })).toBe(false)
  })

  test('other work is not research, and no description is not', () => {
    expect(isResearch({ agentType: 'general-purpose', description: 'Rename the config keys' })).toBe(false)
    expect(isResearch({ agentType: 'Explore', description: 'Write the migration' })).toBe(false)
    expect(isResearch({ agentType: 'Explore', description: '' })).toBe(false)
    expect(isResearch({ agentType: 'Explore', description: null })).toBe(false)
  })
})

describe('subagentMeta: the sidecar, and nothing else', () => {
  const session = '11111111-1111-4111-8111-111111111111'
  const record = join(scratch, `${session}.jsonl`)
  writeFileSync(record, '')
  const subagents = join(scratch, session, 'subagents')
  mkdirSync(join(subagents, 'team'), { recursive: true })
  writeFileSync(join(subagents, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: '  Audit   the protocol ', prompt: 'not read' }))
  writeFileSync(join(subagents, 'team', 'agent-a2.meta.json'), JSON.stringify({ agentType: 'Plan', description: 'Plan the move' }))
  writeFileSync(join(subagents, 'agent-a3.meta.json'), 'not json')

  test('reads the type and the description, beside the record or one folder down', () => {
    expect(subagentMeta(record, session, 'a1')).toEqual({ agentType: 'Explore', description: 'Audit the protocol' })
    expect(subagentMeta(record, session, 'a2')).toEqual({ agentType: 'Plan', description: 'Plan the move' })
  })

  test('nothing for one that is not there, not JSON, or not spelled as an id', () => {
    expect(subagentMeta(record, session, 'a3')).toBeNull()
    expect(subagentMeta(record, session, 'a9')).toBeNull()
    expect(subagentMeta(record, session, '../a1')).toBeNull()
    expect(subagentMeta(record, '../x', 'a1')).toBeNull()
  })
})
