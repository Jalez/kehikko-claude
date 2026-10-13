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
 * A place with no session (#6), and rows running elsewhere (#5)
 * ------------------------------------------------------------------ */

describe('the list for a place with no session', () => {
  const job = { kind: 'background' as const, called: 'background', pid: 82454, cwd: '/p', since: NOW - 3 * 3_600_000, name: 'stand-in' }
  const terminal = { kind: 'interactive' as const, called: 'interactive', pid: 82070, cwd: '/p', since: NOW - 17 * 60_000, name: 'project-ea' }
  const offered = (more: Partial<Listing> = {}) =>
    drawn({
      mode: 'offer',
      onClose: undefined,
      listing: listing({
        sessions: [],
        others: [
          row('near', { label: 'the whole epic’s conversation', lastActive: NOW - 2 * 86_400_000, near: ['whole epic · writing'] }),
          row('recent', { label: 'started in a plain terminal', lastActive: NOW - 3_600_000 }),
          row('old', { label: 'another epic’s', lastActive: NOW - 9 * 86_400_000 }),
        ],
        ...more,
      }),
    })
  const words = (list: HTMLElement) => [...list.querySelectorAll('[data-row]')].map((one) => one.textContent?.replace(/\s+/g, ' ').trim() ?? '')

  test('"New session" is the first row, then the project’s sessions in the order they were given, each with its first prompt and when it was last active', () => {
    const { list } = offered()
    const rows = words(list)
    expect(rows.length).toBe(4)
    expect(rows[0]).toBe('1New session')
    expect(rows[1]).toContain('the whole epic’s conversation')
    expect(rows[1]).toContain('this epic')
    expect(rows[1]).toContain('2 d ago')
    expect(rows[2]).toContain('started in a plain terminal')
    expect(rows[2]).toContain('1 h ago')
    expect(rows[2]).not.toContain('this epic')
    expect(rows[3]).toContain('another epic’s')
    expect(list.querySelector('[data-near]')?.getAttribute('title')).toBe('Already the session of another place of this epic: whole epic · writing')
    /* Laid out, not folded behind a row that has to be pressed first. */
    expect(list.querySelector('[data-row="attach"]')).toBeNull()
    expect(list.textContent).toContain('No session here yet. Start a new one, or carry on with one this project already has.')
  })

  test('Enter takes the new one without moving: a person who always wants a new one presses one key', () => {
    const { list, opened } = offered()
    expect(list.querySelector('[aria-selected="true"]')?.getAttribute('data-row')).toBe('new')
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(opened).toEqual([null])
  })

  test('an existing one is chosen with the arrows, a digit or the pointer', () => {
    const { list, opened, getByText } = offered()
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'Enter' })
    fireEvent.keyDown(list, { key: '3' })
    fireEvent.click(getByText('another epic’s'))
    expect(opened).toEqual(['near', 'recent', 'old'])
  })

  test('there is no limit: every one of the project’s sessions is a row', () => {
    const many = Array.from({ length: 140 }, (_, index) => row(`s${index}`, { label: `conversation ${index}`, lastActive: NOW - index * 60_000 }))
    const { list } = offered({ others: many })
    expect(list.querySelectorAll('[data-row="other"]').length).toBe(140)
    expect(list.querySelectorAll('[data-row]').length).toBe(141)
  })

  test('a row says when its session is running: here with what it is doing, in the background, or open elsewhere', () => {
    const { list } = offered({
      others: [
        row('here', { label: 'running on this module', running: true, state: 'working', since: NOW }),
        row('bg', { label: 'a background job', elsewhere: job }),
        row('term', { label: 'left open in a terminal', elsewhere: terminal }),
        row('idle', { label: 'at rest' }),
      ],
    })
    expect(list.querySelector('[data-session="here"] [data-state]')?.textContent).toContain('working')
    const background = list.querySelector('[data-session="bg"] [data-elsewhere]') as HTMLElement
    expect(background.getAttribute('data-elsewhere')).toBe('background')
    expect(background.textContent).toBe('running in the background')
    expect(background.getAttribute('title')).toBe('Running as a background session, process 82454, in /p, started 3 h ago. Opening it here attaches to it: no second process is started.')
    const open = list.querySelector('[data-session="term"] [data-elsewhere]') as HTMLElement
    expect(open.textContent).toBe('open elsewhere')
    expect(open.getAttribute('title')).toContain('It cannot be attached to: opening it here asks before a copy is started.')
    expect(list.querySelector('[data-session="idle"] [data-elsewhere]')).toBeNull()
    expect(list.querySelector('[data-session="idle"]')?.textContent).not.toMatch(/running|elsewhere/)
    /* Nothing here ends a process this module did not start: only the one it runs has the button. */
    expect([...list.querySelectorAll('button')].filter((one) => one.textContent === 'End').length).toBe(1)
    expect(list.querySelector('[data-session="bg"]')?.textContent).not.toContain('End')
  })

  test('a session not on this computer stays unopenable, is listed last, and is not where Enter lands', () => {
    const { list, opened } = offered({ sessions: [row('away', { label: 'started on the laptop', missing: true })] })
    const rows = [...list.querySelectorAll('[data-row]')]
    expect(rows.at(-1)?.getAttribute('data-row')).toBe('missing')
    expect(rows.at(-1)?.textContent).toContain('not on this computer')
    fireEvent.keyDown(list, { key: '5' })
    expect(opened).toEqual([])
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(opened).toEqual([null])
  })

  test('it cannot be escaped into nothing: there is no session behind it to go back to', () => {
    const { list, opened, closed } = offered()
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(closed()).toBe(0)
    expect(opened).toEqual([])
  })
})

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
