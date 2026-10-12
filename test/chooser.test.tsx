import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'

import type { Listing, Row } from '../doors.ts'
import { Chooser } from '../src/view/chooser.tsx'

/**
 * The list a person chooses from, with the keyboard and with the pointer.
 */

afterEach(cleanup)

const NOW = Date.parse('2026-10-12T12:00:00Z')
const row = (id: string, more: Partial<Row> = {}): Row => ({ id, label: '', lastActive: null, running: false, ...more })
const listing = (more: Partial<Listing> = {}): Listing => ({
  ok: true,
  program: { name: 'Claude Code', found: '/bin/claude', foundAt: '/bin/claude', looked: [], where: 'PATH', lacks: null, install: { line: 'install', lands: '' } },
  sessions: [row('a', { label: 'tighten the methods section', lastActive: NOW - 3 * 3_600_000 }), row('b', { label: '', running: true, lastActive: NOW - 60_000 })],
  others: [row('c', { label: 'from another place', lastActive: NOW - 86_400_000 })],
  running: [],
  most: 6,
  ...more,
})

function drawn(props: Partial<Parameters<typeof Chooser>[0]> = {}) {
  const opened: (string | null)[] = []
  const ended: string[] = []
  const detached: string[] = []
  let closed = 0
  const view = render(
    <Chooser
      mode="ask"
      listing={listing()}
      now={NOW}
      onOpen={(session) => opened.push(session)}
      onEnd={(session) => ended.push(session)}
      onDetach={(session) => detached.push(session)}
      onClose={() => (closed += 1)}
      {...props}
    />,
  )
  const list = view.container.querySelector('[data-chooser]') as HTMLElement
  return { ...view, list, opened, ended, detached, closed: () => closed }
}

describe('the list of a place’s sessions', () => {
  test('says each session’s first prompt, when it was last active and whether it is running, and offers a new one', () => {
    const { list } = drawn()
    const rows = [...list.querySelectorAll('[data-row]')].map((one) => one.textContent?.replace(/\s+/g, ' ').trim())
    expect(rows[0]).toContain('tighten the methods section')
    expect(rows[0]).toContain('3 h ago')
    expect(rows[0]).not.toContain('running')
    expect(rows[1]).toContain('No prompt yet')
    expect(rows[1]).toContain('running')
    expect(rows[2]).toContain('New session')
    expect(rows[3]).toContain('Attach an existing session… (1)')
    expect(list.textContent).toContain('More than one session belongs here')
  })

  test('takes the keyboard as it appears', () => {
    const { list } = drawn()
    expect(document.activeElement).toBe(list)
  })

  test('by keyboard: the arrows move, Enter opens', () => {
    const { list, opened } = drawn()
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(list.querySelector('[aria-selected="true"]')?.getAttribute('data-session')).toBe('b')
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(opened).toEqual(['b'])
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(opened).toEqual(['b', 'a'])
  })

  test('by keyboard: a digit opens that row outright, and the row after the sessions is a new one', () => {
    const { list, opened } = drawn()
    fireEvent.keyDown(list, { key: '2' })
    fireEvent.keyDown(list, { key: '3' })
    fireEvent.keyDown(list, { key: '9' })
    expect(opened).toEqual(['b', null])
  })

  test('by pointer: pressing a row opens it, and pressing New session opens a new one', () => {
    const { getByText, opened } = drawn()
    fireEvent.click(getByText('tighten the methods section'))
    fireEvent.click(getByText('New session'))
    expect(opened).toEqual(['a', null])
  })

  test('attaching an existing session: the project’s others are one press away, and opening one attaches it', () => {
    const { list, getByText, opened } = drawn()
    expect(list.querySelector('[data-row="other"]')).toBeNull()
    fireEvent.click(getByText(/Attach an existing session/))
    expect(list.querySelector('[data-row="other"]')?.textContent).toContain('from another place')
    fireEvent.click(getByText('from another place'))
    expect(opened).toEqual(['c'])
  })

  test('with nothing else in the project there is nothing to attach, and it is not offered', () => {
    const { list } = drawn({ listing: listing({ others: [] }) })
    expect(list.querySelector('[data-row="attach"]')).toBeNull()
  })

  test('a running session can be ended and any session taken off the place, each by its own press', () => {
    const { list, ended, detached, opened } = drawn()
    const running = list.querySelector('[data-session="b"]') as HTMLElement
    fireEvent.click(running.querySelector('button:nth-of-type(2)') as HTMLElement)
    expect(ended).toEqual(['b'])
    fireEvent.click(list.querySelector('[data-session="a"] [aria-label="Remove from this place"]') as HTMLElement)
    expect(detached).toEqual(['a'])
    expect(opened).toEqual([])
    /* One that is not running has no End. */
    expect(list.querySelector('[data-session="a"]')?.textContent).not.toContain('End')
  })

  test('opened over a running terminal it marks the one on screen, and Escape goes back', () => {
    const { list, closed } = drawn({ mode: 'sessions', current: 'b' })
    expect(list.querySelector('[data-session="b"]')?.textContent).toContain('on screen')
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(closed()).toBe(1)
  })
})

describe('at the bound', () => {
  const full = listing({
    running: [
      { id: 'x', label: 'the oldest', projectPath: '/p/thesis', place: 'epic=thesis;parts=methods+results;kehikko=3', here: false, startedAt: 1 },
      { id: 'y', label: '', projectPath: '/p/other', place: 'epic=-;parts=-;kehikko=1', here: true, startedAt: 2 },
      { id: 'z', label: 'next door', projectPath: '/p/other', place: 'epic=paper;parts=-;kehikko=1', here: false, startedAt: 3 },
    ],
    most: 3,
  })

  test('says how many are running and lists them; nothing is offered but ending one', () => {
    const { list } = drawn({ mode: 'full', listing: full, project: '/p/other' })
    expect(list.textContent).toContain('3 sessions are running, which is as many as this module keeps — end one to open this one.')
    expect(list.querySelectorAll('[data-row="running"]').length).toBe(3)
    expect(list.querySelector('[data-row="new"]')).toBeNull()
    /* Where each one is: its project when it is another one, then the epic and the parts. */
    const rows = [...list.querySelectorAll('[data-row="running"]')].map((one) => one.textContent)
    expect(rows[0]).toContain('thesis · thesis · methods + results')
    expect(rows[1]).toContain('here')
    expect(rows[2]).toContain('paper · all parts')
    expect(rows[2]).not.toContain('other ·')
  })

  test('the one that is ended is the one the person chose', () => {
    const { list, ended, opened } = drawn({ mode: 'full', listing: full })
    fireEvent.click(list.querySelectorAll('[data-row="running"] button')[1] as HTMLElement)
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(ended).toEqual(['y', 'x'])
    expect(opened).toEqual([])
  })
})
