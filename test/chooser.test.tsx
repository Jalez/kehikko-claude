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
  program: { name: 'Claude Code', found: '/bin/claude', foundAt: '/bin/claude', looked: [], where: 'PATH', lacks: null, install: { line: 'install', lands: '' }, asked: 'yes' },
  sessions: [row('a', { label: 'tighten the methods section', lastActive: NOW - 3 * 3_600_000 }), row('b', { label: '', running: true, lastActive: NOW - 60_000 })],
  others: [row('c', { label: 'from another place', lastActive: NOW - 86_400_000 })],
  running: [],
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

  test('a session that is not on this computer is listed, muted, and cannot be opened — by pointer, by Enter or by its digit', () => {
    const away = row('away', { label: 'started on the laptop', lastActive: NOW - 2 * 86_400_000, missing: true })
    const { list, opened, detached } = drawn({ listing: listing({ sessions: [away, row('a', { label: 'the one that is here' })] }) })
    const there = list.querySelector('[data-session="away"]') as HTMLElement
    expect(there.getAttribute('data-row')).toBe('missing')
    expect(there.textContent).toContain('started on the laptop')
    expect(there.textContent).toContain('not on this computer')
    expect(there.textContent).toContain('2 d ago')
    expect(there.getAttribute('aria-disabled')).toBe('true')
    /* No notice row: the rows are the two sessions, New session and the way to attach. */
    expect([...list.querySelectorAll('[data-row]')].map((one) => one.getAttribute('data-row'))).toEqual(['missing', 'session', 'new', 'attach'])

    /* The keyboard starts on the first row that can be opened, not on this one. */
    expect(list.querySelector('[aria-selected="true"]')?.getAttribute('data-session')).toBe('a')
    fireEvent.click(there)
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    expect(list.querySelector('[aria-selected="true"]')?.getAttribute('data-session')).toBe('away')
    fireEvent.keyDown(list, { key: 'Enter' })
    fireEvent.keyDown(list, { key: '1' })
    expect(opened).toEqual([])
    /* The one press it has: off this place. The record keeps the session. */
    expect(there.querySelectorAll('button').length).toBe(1)
    fireEvent.click(there.querySelector('[aria-label="Remove from this place"]') as HTMLElement)
    expect(detached).toEqual(['away'])
    /* And the one that is here opens as ever. */
    fireEvent.keyDown(list, { key: '2' })
    expect(opened).toEqual(['a'])
  })

  test('opened over a running terminal it marks the one on screen, and Escape goes back', () => {
    const { list, closed } = drawn({ mode: 'sessions', current: 'b' })
    expect(list.querySelector('[data-session="b"]')?.textContent).toContain('on screen')
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(closed()).toBe(1)
  })
})

describe('never in the way', () => {
  /* Twelve running, here and elsewhere: there is no number at which the list becomes a demand. */
  const busy = listing({
    running: Array.from({ length: 12 }, (_, n) => ({ id: `r${n}`, label: '', projectPath: '/p/other', place: null, here: false, startedAt: n })),
  })

  test('however many are running, the list is this place’s sessions and never a request to end one', () => {
    for (const mode of ['ask', 'sessions'] as const) {
      const { list } = drawn({ mode, listing: busy })
      expect(list.textContent).not.toContain('as many as')
      expect(list.textContent).not.toContain('end one')
      expect(list.querySelector('[data-row="running"]')).toBeNull()
      expect(list.querySelector('[data-row="new"]')).not.toBeNull()
      expect(list.querySelectorAll('[data-row="session"]').length).toBe(2)
      cleanup()
    }
  })

  test('End stays where it was, on a running session’s own row, for whoever wants it', () => {
    const { list, ended, opened } = drawn({ mode: 'sessions', listing: busy })
    const buttons = [...list.querySelectorAll('[data-session="b"] button')].filter((one) => one.textContent === 'End')
    expect(buttons.length).toBe(1)
    expect([...list.querySelectorAll('[data-session="a"] button')].some((one) => one.textContent === 'End')).toBe(false)
    fireEvent.click(buttons[0] as HTMLElement)
    expect(ended).toEqual(['b'])
    expect(opened).toEqual([])
  })
})

describe('what a running session is doing, in the list', () => {
  const doing = (state: Row['state'], since = NOW - 5 * 60_000) =>
    drawn({ listing: listing({ sessions: [row('a', { label: 'one', running: true, state, since }), row('b', { label: 'two', running: true }), row('c', { label: 'three' })] }) })

  test('is said where "running" was: a glyph of its own shape, the word, and since when as the title', () => {
    for (const [state, glyph, word] of [
      ['working', '●', 'working'],
      ['needs-you', '◆', 'needs you'],
      ['finished', '○', 'finished'],
    ] as const) {
      const { list } = doing(state)
      const mark = list.querySelector('[data-session="a"] [data-state]') as HTMLElement
      expect(mark.getAttribute('data-state')).toBe(state)
      expect(mark.textContent).toBe(`${glyph}${word}`)
      expect(mark.getAttribute('title')).toBe(`${word} · 5 min ago`)
      /* In place of the word, not beside it. */
      expect(list.querySelector('[data-session="a"]')?.textContent).not.toContain('running')
      cleanup()
    }
  })

  test('one that has not said still says running, and one that is not running says nothing', () => {
    const { list } = doing('working')
    expect(list.querySelector('[data-session="b"] [data-state]')).toBeNull()
    expect(list.querySelector('[data-session="b"]')?.textContent).toContain('running')
    expect(list.querySelector('[data-session="c"] [data-state]')).toBeNull()
    expect(list.querySelector('[data-session="c"]')?.textContent).not.toContain('running')
  })

  test('adds no row and no line: the same rows, each still one line', () => {
    const plain = drawn({ listing: listing({ sessions: [row('a', { label: 'one', running: true }), row('b', { label: 'two', running: true })] }) })
    const before = plain.list.querySelectorAll('[data-row]').length
    const children = plain.list.children.length
    cleanup()
    const marked = drawn({ listing: listing({ sessions: [row('a', { label: 'one', running: true, state: 'needs-you', since: NOW }), row('b', { label: 'two', running: true, state: 'finished', since: NOW })] }) })
    expect(marked.list.querySelectorAll('[data-row]').length).toBe(before)
    expect(marked.list.children.length).toBe(children)
  })
})

/* ------------------------------------------------------------------ *
 * Rows for sessions running elsewhere (#5)
 * ------------------------------------------------------------------ */

describe('rows for sessions this module runs as a view or a copy', () => {
  test('a view of a background session says so, and its button closes the view — it does not end the session', () => {
    const { list, ended } = drawn({ mode: 'sessions', listing: listing({ sessions: [row('a', { label: 'a background job', running: true, as: 'background' })], others: [] }) })
    expect(list.querySelector('[data-session="a"] [data-as]')?.textContent).toBe('background')
    const button = [...list.querySelectorAll('[data-session="a"] button')].find((one) => one.textContent === 'Close') as HTMLElement
    expect(button.getAttribute('title')).toBe('Close this view. The session keeps running in the background.')
    fireEvent.click(button)
    expect(ended).toEqual(['a'])
  })

  test('a copy says it is one', () => {
    const { list } = drawn({ mode: 'sessions', listing: listing({ sessions: [row('a', { label: 'x', running: true, as: 'copy' })], others: [] }) })
    expect(list.querySelector('[data-session="a"] [data-as]')?.textContent).toBe('copy')
  })
})
