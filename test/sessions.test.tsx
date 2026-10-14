import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { headerItemsSchema } from 'kehikot-module-protocol'
import { resetServerStanding } from 'kehikot-module-protocol/client'
import { useEffect, useRef } from 'react'

import type { Listing, Row } from '../doors.ts'
import type { Notice, Stated } from '../live.ts'
import { NOTICES } from '../manifest.ts'
import type { Api } from '../src/api.ts'
import { hostDrawsHeader, type Hosted } from '../src/app.tsx'
import { standing } from '../src/view/places.ts'
import type { Said, Standing, Target } from '../src/view/terminal-view.tsx'

/**
 * The component that keeps a session per place, rendered with a stand-in for
 * the terminal.
 *
 * The real `TerminalView` builds an xterm emulator and opens a socket;
 * neither exists in `happy-dom` and neither is the thing under test. What
 * matters here is what the parent DOES when the canvas speaks: what it opens,
 * what it asks before opening, and which views it leaves alone. So the
 * stand-in records every mount and unmount by what it was asked to open, and
 * hands the test the two callbacks the server would drive.
 *
 * `mock.module` has to run before `app.tsx` is imported, which is why the
 * import of `Sessions` is dynamic and below it.
 */

interface Mounted {
  target: Target
  tell: (standing: Standing) => void
  say: (said: Said) => void
}
const mounted: Mounted[] = []
const unmounted: Target[] = []
const which = (kehikko: Extract<Target, { what: 'session' }>['place']['kehikko']) => (kehikko === null ? '-' : 'key' in kehikko ? `key:${kehikko.key}` : kehikko.id)
const naming = (target: Target) => (target.what === 'install' ? 'install' : `${target.place.parts.join('+') || 'whole'}@${which(target.place.kehikko)}:${target.session ?? 'new'}`)

mock.module('../src/view/terminal-view.tsx', () => ({
  TerminalView: ({ target, shown, watched, onStanding, onSaid }: { target: Target; shown: boolean; watched?: boolean; onStanding?: (s: Standing) => void; onSaid?: (s: object) => void }) => {
    /* The callbacks as they are NOW, as the real view holds them: it reads them from a ref on every call. */
    const latest = useRef({ onStanding, onSaid })
    latest.current = { onStanding, onSaid }
    useEffect(() => {
      const mine: Mounted = { target, tell: (next) => latest.current.onStanding?.(next), say: (said) => latest.current.onSaid?.(said) }
      mounted.push(mine)
      return () => {
        unmounted.push(target)
        mounted.splice(mounted.indexOf(mine), 1)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return <div data-terminal={naming(target)} data-shown={shown ? 'yes' : 'no'} data-watched={(watched ?? shown) ? 'yes' : 'no'} />
  },
}))

const { Sessions: Real } = await import('../src/app.tsx')
/* A new session waits for the canvas to stop moving; here it does not have to, except where that wait is the thing under test. */
const Sessions = (props: Parameters<typeof Real>[0]) => <Real settleMs={0} {...props} />

const P = '/Users/someone/Projects/thesis'
const row = (id: string, more: Partial<Row> = {}): Row => ({ id, label: '', lastActive: null, running: false, ...more })

/** A server in a variable: what each place holds, and what was asked of it. */
function server(start: Record<string, Row[]> = {}) {
  const held: Record<string, Row[]> = { ...start }
  const state = { found: '/bin/claude' as string | null, lacks: null as string | null, running: [] as Listing['running'], others: [] as Row[] }
  const asked: string[] = []
  /** What the page asked to have brought across to a kehikko's key, in order with the reads. */
  const order: string[] = []
  const api: Api = {
    rekey: async (_projectPath, kehikko) => {
      order.push(`rekey ${kehikko.key} ${kehikko.name} ${kehikko.id}`)
      await new Promise((done) => setTimeout(done, 1))
      order.push('rekeyed')
    },
    place: async (_projectPath, key) => {
      asked.push(key)
      order.push(`read ${key}`)
      return {
        ok: true,
        program: { name: 'Claude Code', found: state.found, foundAt: state.found, looked: ['/usr/bin', '/Users/someone/.local/bin'], where: 'PATH, ~/.local/bin', lacks: state.lacks, install: { line: 'curl -fsSL https://claude.ai/install.sh | bash', lands: '~/.local/bin/claude' }, asked: 'yes' },
        sessions: held[key] ?? [],
        others: state.others,
        running: state.running,
      }
    },
    end: async (session) => {
      asked.push(`end ${session}`)
      state.running = state.running.filter((one) => one.id !== session)
    },
    detach: async (_projectPath, key, session) => {
      asked.push(`detach ${session}`)
      held[key] = (held[key] ?? []).filter((one) => one.id !== session)
    },
  }
  return { api, held, state, asked, order }
}

const at = (parts: string[] = [], kehikko = 3, epic: string | null = 'thesis', projectPath = P) =>
  standing({ where: 'hosted', projectPath, epic, parts: parts.map((id) => ({ id, picked: true })), kehikko: { id: kehikko, name: `k${kehikko}` } })!
/** The same, from a host that names the kehikko by its key (protocol 1.1.0). */
const keyed = (parts: string[] = [], id = 3, key = '4072c9e5', name = 'writing') =>
  standing({ where: 'hosted', projectPath: P, epic: 'thesis', parts: parts.map((part) => ({ id: part, picked: true })), kehikko: { id, name, key } })!
const KEY = (parts: string[] = [], kehikko = 3) => at(parts, kehikko).key

/* Twice: what the server said is drawn when the first round ends, and a new session is started on a timer set by that drawing. */
const round = () => act(async () => void (await new Promise((done) => setTimeout(done, 5))))
const flush = async () => {
  await round()
  await round()
}
const shown = (container: HTMLElement) => [...container.querySelectorAll('[data-shown="yes"]')].map((one) => one.getAttribute('data-terminal'))
const all = (container: HTMLElement) => [...container.querySelectorAll('[data-terminal]')].map((one) => one.getAttribute('data-terminal'))
const view = (name: string) => mounted.find((one) => naming(one.target) === name)!

afterEach(() => {
  cleanup()
  mounted.length = 0
  unmounted.length = 0
  sessionStorage.clear()
  resetServerStanding()
})

describe('opening the module on a place', () => {
  test('no session there: a new one opens at once, with no question', async () => {
    const s = server()
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(shown(container)).toEqual(['whole@3:new'])
    expect(container.querySelector('[data-chooser]')).toBeNull()
  })

  test('exactly one: it opens at once', async () => {
    const s = server({ [KEY()]: [row('a')] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(shown(container)).toEqual(['whole@3:a'])
  })

  test('more than one: the list, in the terminal’s place, and nothing opened until one is chosen', async () => {
    const s = server({ [KEY()]: [row('a', { label: 'the first' }), row('b', { label: 'the second' })] })
    const { container, getByText } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(container.querySelector('[data-chooser="ask"]')).not.toBeNull()
    expect(all(container)).toEqual([])
    expect(mounted.length).toBe(0)

    fireEvent.click(getByText('the second'))
    await flush()
    expect(shown(container)).toEqual(['whole@3:b'])
    expect(container.querySelector('[data-chooser]')).toBeNull()
  })

  test('the list answers to the keyboard as well', async () => {
    const s = server({ [KEY()]: [row('a'), row('b')] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    fireEvent.keyDown(container.querySelector('[data-chooser]') as HTMLElement, { key: '3' })
    await flush()
    expect(shown(container)).toEqual(['whole@3:new'])
  })

  test('with no project there is one sentence and no session — not a session somewhere else', async () => {
    const s = server()
    const { container } = render(<Sessions theme="dark" at={null} cover="no-project" api={s.api} />)
    await flush()
    expect(container.textContent).toContain('No project is open')
    expect(mounted.length).toBe(0)
    expect(s.asked).toEqual([])
  })
})

describe('the kehikko by its key', () => {
  test('the host renumbering a kehikko moves nothing: the same place, the same session, nothing reopened', async () => {
    const s = server({ [keyed().key]: [row('a')] })
    const { container, rerender } = render(<Sessions theme="dark" at={keyed([], 2)} api={s.api} />)
    await flush()
    expect(shown(container)).toEqual(['whole@key:4072c9e5:a'])
    const before = view('whole@key:4072c9e5:a')
    /* Removed from the host and added again: 2, then 9, then 28. */
    rerender(<Sessions theme="dark" at={keyed([], 9)} api={s.api} />)
    await flush()
    rerender(<Sessions theme="dark" at={keyed([], 28)} api={s.api} />)
    await flush()
    expect(shown(container)).toEqual(['whole@key:4072c9e5:a'])
    expect(view('whole@key:4072c9e5:a')).toBe(before)
    expect(unmounted).toEqual([])
    /* The place was read once: the number is not part of it. */
    expect(s.asked).toEqual([keyed().key])
  })

  test('a page opened after the renumbering finds the session by itself, with nothing attached by hand', async () => {
    const s = server({ [keyed().key]: [row('a')] })
    const { container } = render(<Sessions theme="dark" at={keyed([], 28)} api={s.api} />)
    await flush()
    expect(shown(container)).toEqual(['whole@key:4072c9e5:a'])
    expect(container.querySelector('[data-chooser]')).toBeNull()
  })

  test('what an older release filed under the row number is asked to be brought across BEFORE the place is read, once per kehikko', async () => {
    const s = server({ [keyed().key]: [row('a')] })
    const { rerender } = render(<Sessions theme="dark" at={keyed([], 28)} api={s.api} />)
    await flush()
    expect(s.order).toEqual(['rekey 4072c9e5 writing 28', 'rekeyed', `read ${keyed().key}`])
    /* Another place on the same kehikko: read, and not asked again. */
    rerender(<Sessions theme="dark" at={keyed(['methods'], 28)} api={s.api} />)
    await flush()
    expect(s.order.filter((one) => one.startsWith('rekey ')).length).toBe(1)
    expect(s.order.at(-1)).toBe(`read ${keyed(['methods']).key}`)
    /* Another kehikko is asked about in its turn. */
    rerender(<Sessions theme="dark" at={keyed([], 4, 'review-2', 'review')} api={s.api} />)
    await flush()
    expect(s.order.filter((one) => one.startsWith('rekey '))).toEqual(['rekey 4072c9e5 writing 28', 'rekey review-2 review 4'])
  })

  test('a host that sends no key is not asked about one: the place is the row number, as before', async () => {
    const s = server({ [KEY()]: [row('a')] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(KEY()).toBe('epic=thesis;parts=-;kehikko=3')
    expect(shown(container)).toEqual(['whole@3:a'])
    expect(s.order).toEqual([`read ${KEY()}`])
  })

  test('if the bringing across is refused, nothing is read and nothing opened — a new session is not started beside the old ones', async () => {
    const s = server({ [keyed().key]: [] })
    s.api.rekey = async () => {
      throw new Error('places.json is not readable JSON.')
    }
    const { container } = render(<Sessions theme="dark" at={keyed()} api={s.api} />)
    await flush()
    expect(all(container)).toEqual([])
    expect(s.asked).toEqual([])
    expect(container.textContent).toContain('places.json is not readable JSON.')
  })
})

describe('a session from another computer', () => {
  test('the only one recorded here is somewhere else: a new session, at once, and no question', async () => {
    const s = server({ [KEY()]: [row('away', { label: 'started on the laptop', missing: true })] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(shown(container)).toEqual(['whole@3:new'])
    expect(container.querySelector('[data-chooser]')).toBeNull()
  })

  test('one here and one elsewhere: the one here opens, and the other is only a muted row in the list', async () => {
    const s = server({ [KEY()]: [row('away', { label: 'started on the laptop', missing: true }), row('a', { label: 'here' })] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(shown(container)).toEqual(['whole@3:a'])
    fireEvent.click(container.querySelector('[data-sessions]') as HTMLElement)
    await flush()
    const away = container.querySelector('[data-session="away"]') as HTMLElement
    expect(away.textContent).toContain('not on this computer')
    fireEvent.click(away)
    await flush()
    expect(all(container)).toEqual(['whole@3:a'])
  })
})

describe('moving between places', () => {
  test('picking a part is another place with a session of its own; the one left behind is not touched', async () => {
    const s = server()
    const { container, rerender } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    act(() => view('whole@3:new').say({ session: 'first', typed: true }))
    rerender(<Sessions theme="dark" at={at(['methods'])} api={s.api} />)
    await flush()
    expect(shown(container)).toEqual(['methods@3:new'])
    /* Still mounted, still attached: hidden is all that happened to it. */
    expect(all(container).length).toBe(2)
    expect(unmounted).toEqual([])
  })

  test('coming back shows the view that was there, as it was, without asking the server to open anything', async () => {
    const s = server()
    const { container, rerender } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    const first = view('whole@3:new')
    act(() => first.say({ session: 'first', exists: true }))
    rerender(<Sessions theme="dark" at={at(['methods'])} api={s.api} />)
    await flush()
    rerender(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(shown(container)).toEqual(['whole@3:first'])
    expect(mounted.includes(first)).toBe(true)
    expect(unmounted.map(naming)).toEqual(['methods@3:new'])
  })

  test('a new session nobody typed into is let go when the canvas moves on, so a walk through places leaves nothing behind', async () => {
    const s = server()
    const { container, rerender } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    rerender(<Sessions theme="dark" at={at(['methods'])} api={s.api} />)
    await flush()
    rerender(<Sessions theme="dark" at={at(['methods', 'results'])} api={s.api} />)
    await flush()
    expect(all(container)).toEqual(['methods+results@3:new'])
    expect(unmounted.map(naming)).toEqual(['whole@3:new', 'methods@3:new'])
  })

  test('a new session is not started for a place the canvas only passed through', async () => {
    const s = server({ [KEY(['results'])]: [row('r')] })
    const { container, rerender } = render(<Real theme="dark" at={at()} api={s.api} settleMs={40} />)
    await flush()
    rerender(<Real theme="dark" at={at(['methods'])} api={s.api} settleMs={40} />)
    await flush()
    expect(mounted.length).toBe(0)
    /* A session that exists does not wait: it is opened as soon as the place is known. */
    rerender(<Real theme="dark" at={at(['results'])} api={s.api} settleMs={40} />)
    await flush()
    expect(shown(container)).toEqual(['results@3:r'])
    act(() => view('results@3:r').say({ session: 'r', exists: true }))
    rerender(<Real theme="dark" at={at(['methods', 'results'])} api={s.api} settleMs={40} />)
    await flush()
    await act(async () => void (await new Promise((done) => setTimeout(done, 80))))
    expect(shown(container)).toEqual(['methods+results@3:new'])
    expect(mounted.map((one) => naming(one.target)).sort()).toEqual(['methods+results@3:new', 'results@3:r'])
  })

  test('another kehikko and another epic are other places too, and the order parts were picked in is not', async () => {
    const s = server()
    const { container, rerender } = render(<Sessions theme="dark" at={at(['methods', 'results'])} api={s.api} />)
    await flush()
    const first = view('methods+results@3:new')
    rerender(<Sessions theme="dark" at={at(['results', 'methods'])} api={s.api} />)
    await flush()
    expect(mounted).toEqual([first])
    act(() => first.say({ typed: true }))
    rerender(<Sessions theme="dark" at={at(['methods', 'results'], 4)} api={s.api} />)
    await flush()
    act(() => view('methods+results@4:new').say({ typed: true }))
    rerender(<Sessions theme="dark" at={at(['methods', 'results'], 4, 'other-epic')} api={s.api} />)
    await flush()
    expect(all(container).length).toBe(3)
  })

  test('a place with several sessions is asked about once per page: what was chosen is what is there on return', async () => {
    const s = server({ [KEY()]: [row('a', { label: 'the first' }), row('b', { label: 'the second' })] })
    const { container, rerender, getByText } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    fireEvent.click(getByText('the first'))
    await flush()
    rerender(<Sessions theme="dark" at={at(['methods'])} api={s.api} />)
    await flush()
    rerender(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(shown(container)).toEqual(['whole@3:a'])
    expect(container.querySelector('[data-chooser]')).toBeNull()
  })

  test('a page that reloads comes back to what it was showing; a page opened afresh asks', async () => {
    const s = server({ [KEY()]: [row('a', { label: 'the first' }), row('b', { label: 'the second' })] })
    const one = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    fireEvent.click(one.getByText('the second'))
    await flush()
    one.unmount()

    /* The same tab: its session storage is what `held` kept. */
    const again = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(shown(again.container)).toEqual(['whole@3:b'])
    again.unmount()

    sessionStorage.clear()
    const fresh = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(fresh.container.querySelector('[data-chooser="ask"]')).not.toBeNull()
    expect(shown(fresh.container)).toEqual([])
  })
})

describe('the one control, and what it leads to', () => {
  test('sits in a gutter beside the terminal with the session’s label: no row, and over none of what it prints', async () => {
    const s = server({ [KEY()]: [row('a', { label: 'tighten the methods section and everything after it' })] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    const control = container.querySelector('[data-sessions]') as HTMLElement
    expect(control.textContent).toBe('tighten the methods section… ▾')
    expect(control.className).not.toContain('absolute')
    expect(control.className).toContain('w-5')
    /* Nothing along the bottom while a session is running. */
    expect(container.querySelector('[data-ended]')).toBeNull()
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  test('the label follows what the server says the session is called', async () => {
    const s = server()
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(container.querySelector('[data-sessions]')?.textContent).toBe('New session ▾')
    act(() => view('whole@3:new').say({ session: 'x', label: 'what was first asked' }))
    expect(container.querySelector('[data-sessions]')?.textContent).toBe('what was first asked ▾')
  })

  test('opens the list over the terminal without closing it; choosing another session swaps the view', async () => {
    const s = server({ [KEY()]: [row('a', { label: 'the first' })] })
    s.state.others = [row('z', { label: 'from elsewhere' })]
    const { container, getByText } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    fireEvent.click(container.querySelector('[data-sessions]') as HTMLElement)
    await flush()
    expect(container.querySelector('[data-chooser="sessions"]')).not.toBeNull()
    expect(all(container)).toEqual(['whole@3:a'])
    expect(unmounted).toEqual([])

    fireEvent.keyDown(container.querySelector('[data-chooser]') as HTMLElement, { key: 'Escape' })
    expect(shown(container)).toEqual(['whole@3:a'])

    /* Attach an existing session: opening it here is what attaches it. */
    fireEvent.click(container.querySelector('[data-sessions]') as HTMLElement)
    await flush()
    fireEvent.click(getByText(/Attach an existing session/))
    fireEvent.click(getByText('from elsewhere'))
    await flush()
    expect(shown(container)).toEqual(['whole@3:z'])
  })

  test('a session that ended keeps its last screen, with Resume beside the reason', async () => {
    const s = server({ [KEY()]: [row('a')] })
    const { container, getByText } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    act(() => view('whole@3:a').tell({ at: 'closed', code: 4000, why: 'the session ended (0)' }))
    expect(container.querySelector('[data-ended]')?.textContent).toContain('the session ended (0)')
    expect(shown(container)).toEqual(['whole@3:a'])
    const before = view('whole@3:a')
    fireEvent.click(getByText('Resume'))
    await flush()
    expect(shown(container)).toEqual(['whole@3:a'])
    expect(view('whole@3:a')).not.toBe(before)
    expect(container.querySelector('[data-ended]')).toBeNull()
  })

  test('when this module’s server goes, the screen stays and the words go in a strip', async () => {
    const s = server({ [KEY()]: [row('a')] })
    const { container, rerender } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    rerender(<Sessions theme="dark" at={at()} cover="down" api={s.api} />)
    expect(shown(container)).toEqual(['whole@3:a'])
    expect(container.textContent).toContain('own server is not answering')
  })
})

describe('nothing stands between a place and its session', () => {
  const elsewhere = (n: number): Listing['running'] => Array.from({ length: n }, (_, k) => ({ id: `r${k}`, label: '', projectPath: '/p/other', place: null, here: false, startedAt: k }))

  test('however many are running, a place with one recorded session opens it, and one with none gets a new one', async () => {
    const s = server({ [KEY()]: [row('a')] })
    s.state.running = elsewhere(12)
    const { container, rerender } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(shown(container)).toEqual(['whole@3:a'])
    expect(container.querySelector('[data-chooser]')).toBeNull()
    rerender(<Sessions theme="dark" at={at(['methods'])} api={s.api} />)
    await flush()
    expect(shown(container)).toEqual(['methods@3:new'])
    expect(container.querySelector('[data-chooser]')).toBeNull()
    expect(container.textContent).not.toContain('as many as')
  })

  test('the server is told which view is on screen: the one of the place the canvas is on, and no other', async () => {
    const s = server({ [KEY()]: [row('a')], [KEY(['methods'])]: [row('b')] })
    const { container, rerender } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    act(() => view('whole@3:a').say({ session: 'a', exists: true }))
    rerender(<Sessions theme="dark" at={at(['methods'])} api={s.api} />)
    await flush()
    const watched = () => Object.fromEntries([...container.querySelectorAll('[data-terminal]')].map((one) => [one.getAttribute('data-terminal'), one.getAttribute('data-watched')]))
    expect(watched()).toEqual({ 'whole@3:a': 'no', 'methods@3:b': 'yes' })
    /* The list drawn over the terminal hides it and does not make it unwatched. */
    fireEvent.click(container.querySelector('[data-sessions]') as HTMLElement)
    await flush()
    expect(container.querySelector('[data-chooser="sessions"]')).not.toBeNull()
    expect(watched()).toEqual({ 'whole@3:a': 'no', 'methods@3:b': 'yes' })
  })

  test('a session put away behind another view is let go without a word, and its place resumes it', async () => {
    const s = server({ [KEY()]: [row('a')], [KEY(['methods'])]: [row('b')] })
    const { container, rerender } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    act(() => view('whole@3:a').say({ session: 'a', exists: true }))
    rerender(<Sessions theme="dark" at={at(['methods'])} api={s.api} />)
    await flush()
    expect(all(container)).toEqual(['whole@3:a', 'methods@3:b'])

    /* The server put the first one's process away (`CLOSED.rested`). */
    act(() => view('whole@3:a').tell({ at: 'closed', code: 4001, why: 'put away while it was quiet' }))
    await flush()
    expect(all(container)).toEqual(['methods@3:b'])
    expect(shown(container)).toEqual(['methods@3:b'])
    expect(container.querySelector('[data-ended]')).toBeNull()
    expect(container.querySelector('[data-chooser]')).toBeNull()
    expect(container.textContent).not.toContain('put away')

    /* Back to the place: the same session, asked for by its id, with no question. */
    rerender(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(shown(container)).toEqual(['whole@3:a'])
    expect(container.querySelector('[data-chooser]')).toBeNull()
    expect(container.querySelector('[data-ended]')).toBeNull()
  })

  test('were the one on screen ever put away, it is opened again at once and no strip is drawn', async () => {
    const s = server({ [KEY()]: [row('a')] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    const before = view('whole@3:a')
    act(() => before.tell({ at: 'closed', code: 4001, why: 'put away while it was quiet' }))
    await flush()
    expect(shown(container)).toEqual(['whole@3:a'])
    expect(view('whole@3:a')).not.toBe(before)
    expect(container.querySelector('[data-ended]')).toBeNull()
  })
})

describe('when the program is not installed', () => {
  test('one sentence saying what is missing and where it was looked for, and one press', async () => {
    const s = server()
    s.state.found = null
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(container.textContent).toContain('Claude Code is not installed — looked in PATH, ~/.local/bin.')
    expect([...container.querySelectorAll('button')].map((one) => one.textContent)).toEqual(['Install'])
    /* Nothing runs until the press. */
    expect(mounted.length).toBe(0)
  })

  test('the press runs the installer in a terminal here; found afterwards, the session opens without another press', async () => {
    const s = server()
    s.state.found = null
    const { container, getByText } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    fireEvent.click(getByText('Install'))
    await flush()
    expect(shown(container)).toEqual(['install'])

    s.state.found = '/Users/someone/.local/bin/claude'
    act(() => view('install').tell({ at: 'closed', code: 4010, why: 'installed at /Users/someone/.local/bin/claude' }))
    await flush()
    expect(shown(container)).toEqual(['whole@3:new'])
    expect(container.querySelector('[data-install]')).toBeNull()
  })

  test('an install that does not finish keeps its output on screen, and one sentence says what to run by hand', async () => {
    const s = server()
    s.state.found = null
    const { container, getByText } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    fireEvent.click(getByText('Install'))
    await flush()
    act(() => view('install').tell({ at: 'closed', code: 4011, why: 'the installer exited with 7' }))
    await flush()
    expect(shown(container)).toEqual(['install'])
    expect(container.querySelector('[data-install-failed]')?.textContent).toBe(
      'The install did not finish (the installer exited with 7) — run curl -fsSL https://claude.ai/install.sh | bash in a terminal, then try again.Try again',
    )
    fireEvent.click(getByText('Try again'))
    await flush()
    expect(container.textContent).toContain('is not installed')
  })

  test('a copy that is too old says so, and the press is Update', async () => {
    const s = server({ [KEY()]: [row('a')] })
    s.state.lacks = '--session-id'
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(container.textContent).toContain('Claude Code at /bin/claude is too old for this: it has no --session-id.')
    expect([...container.querySelectorAll('button')].map((one) => one.textContent)).toEqual(['Update'])
    expect(mounted.length).toBe(0)
  })

  test('a session refused because the program vanished falls back to the same sentence', async () => {
    const s = server()
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    s.state.found = null
    act(() => view('whole@3:new').tell({ at: 'closed', code: 4404, why: 'Claude Code is not installed.' }))
    await flush()
    expect(container.textContent).toContain('is not installed')
  })
})

/* ------------------------------------------------------------------ *
 * What a session is doing: the mark, the notice, the header
 * ------------------------------------------------------------------ */

/** A server whose feed the test drives, and a host that writes down what it is asked. */
function told(start: Record<string, Row[]> = {}) {
  const s = server(start)
  const feeds: { notices: boolean; heard: { state(stated: Stated): void; notice(notice: Notice): void }; stopped: boolean }[] = []
  s.api.feed = (notices, heard) => {
    const one = { notices, heard, stopped: false }
    feeds.push(one)
    return () => {
      one.stopped = true
    }
  }
  const emitted: { extension: string; payload: Record<string, unknown> }[] = []
  const headers: unknown[][] = []
  const hosted: Hosted = {
    emit: async (extension, payload) => void emitted.push({ extension, payload }),
    header: (items) => void headers.push(items),
    presses: { current: null },
  }
  return { ...s, feeds, emitted, headers, hosted }
}
const NOTICE: Notice = { seq: 1, session: 'far', state: 'finished', label: 'draft the results', projectPath: P, epic: 'thesis', parts: ['Results'], kehikko: 'writing', at: 1 }
const height = (container: HTMLElement) => [...(container.firstElementChild as HTMLElement).children].filter((one) => !(one as HTMLElement).className.includes('absolute')).length

describe('what the session on screen is doing', () => {
  test('is one glyph in the corner control, before the label, with the word as its title — and no row', async () => {
    const s = told({ [KEY()]: [row('a', { label: 'tighten the methods' })] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    const control = () => container.querySelector('[data-sessions]') as HTMLElement
    const rows = height(container)
    expect(control().textContent).toBe('tighten the methods ▾')
    expect(control().getAttribute('data-state')).toBeNull()

    act(() => view('whole@3:a').say({ session: 'a', state: 'needs-you', since: Date.now() }))
    expect(control().textContent).toBe('◆tighten the methods ▾')
    expect(control().getAttribute('data-state')).toBe('needs-you')
    expect(control().getAttribute('title')).toBe('Sessions for this place — this one: needs you')
    expect(control().getAttribute('aria-label')).toBe('Sessions — tighten the methods (needs you)')
    /* In a gutter of its own, and nothing was added beside it. */
    expect(control().className).not.toContain('absolute')
    expect(height(container)).toBe(rows)

    act(() => view('whole@3:a').say({ session: 'a', state: 'working', since: Date.now() }))
    expect(control().textContent).toBe('●tighten the methods ▾')
    act(() => view('whole@3:a').say({ session: 'a', state: 'finished', since: Date.now() }))
    expect(control().textContent).toBe('○tighten the methods ▾')
    /* Taken back: no mark, rather than a mark that says idle. */
    act(() => view('whole@3:a').say({ session: 'a', state: null }))
    expect(control().textContent).toBe('tighten the methods ▾')
    expect(height(container)).toBe(rows)
  })

  test('the list shows what the feed has said since it was read, for sessions this page has no view of', async () => {
    const s = told({ [KEY()]: [row('a', { label: 'one', running: true }), row('b', { label: 'two', running: true, state: 'working', since: 1 })] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(container.querySelector('[data-session="a"] [data-state]')).toBeNull()
    expect(container.querySelector('[data-session="b"] [data-state]')?.getAttribute('data-state')).toBe('working')
    act(() => s.feeds[0]!.heard.state({ session: 'a', state: 'needs-you', since: Date.now() }))
    act(() => s.feeds[0]!.heard.state({ session: 'b', state: 'finished', since: Date.now() }))
    expect(container.querySelector('[data-session="a"] [data-state]')?.getAttribute('data-state')).toBe('needs-you')
    expect(container.querySelector('[data-session="b"] [data-state]')?.getAttribute('data-state')).toBe('finished')
    act(() => s.feeds[0]!.heard.state({ session: 'b', state: null, since: Date.now() }))
    expect(container.querySelector('[data-session="b"] [data-state]')).toBeNull()
    expect(container.querySelector('[data-session="b"]')?.textContent).toContain('running')
  })
})

describe('a notice for a person who is not looking', () => {
  test('a framed page asks for notices and passes one to the host, in the protocol’s format, once', async () => {
    const s = told()
    render(<Sessions theme="dark" at={at()} api={s.api} hosted={s.hosted} canvasEpic="thesis" />)
    await flush()
    expect(s.feeds.map((one) => one.notices)).toEqual([true])
    act(() => s.feeds[0]!.heard.notice(NOTICE))
    await flush()
    expect(s.emitted).toEqual([{ extension: NOTICES, payload: { epic: 'thesis', level: 'done', message: 'Finished: “draft the results” — thesis · Results · writing', refs: [], place: { epic: 'thesis' } } }])
    act(() => s.feeds[0]!.heard.notice({ ...NOTICE, seq: 2, state: 'needs-you' }))
    expect(s.emitted[1]?.payload).toMatchObject({ level: 'attention', message: 'Waiting for you: “draft the results” — thesis · Results · writing' })
    expect(s.emitted.length).toBe(2)
  })

  test('nothing is drawn for it here: no banner, no row', async () => {
    const s = told({ [KEY()]: [row('a', { label: 'one' })] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} hosted={s.hosted} canvasEpic="thesis" />)
    await flush()
    const before = container.innerHTML
    act(() => s.feeds[0]!.heard.notice(NOTICE))
    await flush()
    expect(container.innerHTML).toBe(before)
  })

  test('a page nothing is framing follows the states and asks for no notices', async () => {
    const s = told()
    const { unmount } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(s.feeds.map((one) => one.notices)).toEqual([false])
    unmount()
    expect(s.feeds[0]!.stopped).toBe(true)
  })

  test('one about a place with no epic is filed under the canvas’s, and under nothing when there is none', async () => {
    const s = told()
    const { rerender } = render(<Sessions theme="dark" at={at()} api={s.api} hosted={s.hosted} canvasEpic="another" />)
    await flush()
    act(() => s.feeds[0]!.heard.notice({ ...NOTICE, epic: null }))
    expect(s.emitted[0]?.payload.epic).toBe('another')
    rerender(<Sessions theme="dark" at={at()} api={s.api} hosted={s.hosted} canvasEpic={null} />)
    act(() => s.feeds[0]!.heard.notice({ ...NOTICE, epic: null }))
    expect(s.emitted.length).toBe(1)
    /* The canvas moving does not open a second feed. */
    expect(s.feeds.length).toBe(1)
  })

  test('a host that will not carry it is not an error anybody sees', async () => {
    const s = told()
    s.hosted.emit = async () => {
      throw new Error('nothing on this canvas shows these')
    }
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} hosted={s.hosted} canvasEpic="thesis" />)
    await flush()
    /* It is said to the console, which is where whoever can act on it looks. */
    const info = console.info
    const said: unknown[][] = []
    console.info = (...words: unknown[]) => void said.push(words)
    try {
      act(() => s.feeds[0]!.heard.notice(NOTICE))
      await flush()
    } finally {
      console.info = info
    }
    expect(said.length).toBe(1)
    expect(container.querySelector('[data-terminal]')).not.toBeNull()
  })
})

describe('the sessions, declared for the container’s header', () => {
  const last = (s: ReturnType<typeof told>) => s.headers.at(-1) as { kind: string; id: string; label: string; agents?: boolean; options: { id: string; label: string }[] }[]

  test('a Go item: this place’s sessions with their marks, a new one, and the list', async () => {
    const s = told({ [KEY()]: [row('a', { label: 'tighten the methods', running: true, state: 'needs-you', since: 1 }), row('b', { label: 'draft the results' }), row('gone', { label: 'elsewhere', missing: true })] })
    render(<Sessions theme="dark" at={at()} api={s.api} hosted={s.hosted} />)
    await flush()
    const items = last(s)
    expect(items.length).toBe(1)
    expect(items[0]).toMatchObject({ kind: 'go', id: 'sessions', label: 'Sessions' })
    expect(items[0]!.options).toEqual([
      { id: 'a', label: '◆ tighten the methods' },
      { id: 'b', label: 'draft the results' },
      { id: 'new', label: 'New session' },
      { id: 'list', label: 'All sessions…' },
    ])
    /* Nothing says an agent may press it, so none may. */
    expect(items[0]!.agents).toBeUndefined()
    expect(headerItemsSchema.safeParse(items).success).toBe(true)
    /* And it follows the state as it changes. */
    act(() => s.feeds[0]!.heard.state({ session: 'a', state: 'finished', since: 2 }))
    expect(last(s)[0]!.options[0]).toEqual({ id: 'a', label: '○ tighten the methods' })
  })

  test('a new session that comes to exist is in the menu without anybody opening the list', async () => {
    const s = told()
    render(<Sessions theme="dark" at={at()} api={s.api} hosted={s.hosted} />)
    await flush()
    expect(last(s)[0]!.options.map((one) => one.id)).toEqual(['new', 'list'])
    const reads = s.asked.length
    /* The server's word that the program now has a record of it; by then the place lists it. */
    s.held[KEY()] = [row('x', { label: 'what was first asked', running: true })]
    act(() => view('whole@3:new').say({ session: 'x', exists: true }))
    await flush()
    expect(s.asked.length).toBe(reads + 1)
    expect(last(s)[0]!.options.map((one) => one.id)).toEqual(['x', 'new', 'list'])
    /* Said again, it is already there and nothing is read. */
    act(() => view('whole@3:new').say({ session: 'x', exists: true }))
    await flush()
    expect(s.asked.length).toBe(reads + 1)
  })

  test('a long label is cut to what the protocol takes', async () => {
    const s = told({ [KEY()]: [row('a', { label: 'x'.repeat(80) }), row('b', { label: 'two' })] })
    render(<Sessions theme="dark" at={at()} api={s.api} hosted={s.hosted} />)
    await flush()
    expect(last(s)[0]!.options[0]!.label.length).toBe(48)
    expect(headerItemsSchema.safeParse(last(s)).success).toBe(true)
  })

  test('the corner control is there until a host has pressed a header item, and gone for good after', async () => {
    const s = told({ [KEY()]: [row('a', { label: 'one' })] })
    const { container, rerender } = render(<Sessions theme="dark" at={at()} api={s.api} hosted={s.hosted} canvasEpic="thesis" />)
    await flush()
    expect(container.querySelector('[data-sessions]')).not.toBeNull()
    s.hosted.drawn = true
    rerender(<Sessions theme="dark" at={at()} api={s.api} hosted={{ ...s.hosted }} canvasEpic="thesis" />)
    await flush()
    expect(container.querySelector('[data-sessions]')).toBeNull()
  })

  test('a press opens that session, a new one, or the list — and refuses what is not this place’s', async () => {
    const s = told({ [KEY()]: [row('a', { label: 'one' }), row('b', { label: 'two' })] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} hosted={s.hosted} />)
    await flush()
    const press = (value: string | boolean, item = 'sessions') => {
      let answer: unknown
      act(() => {
        answer = s.hosted.presses.current?.({ item, value })
      })
      return answer
    }
    expect(press('b')).toBe(true)
    await flush()
    expect(shown(container)).toEqual(['whole@3:b'])
    expect(press('list')).toBe(true)
    await flush()
    expect(container.querySelector('[data-chooser]')?.getAttribute('data-chooser')).toBe('sessions')
    expect(press('new')).toBe(true)
    await flush()
    expect(shown(container)).toEqual(['whole@3:new'])
    expect(typeof press('zzz')).toBe('string')
    expect(typeof press(true)).toBe('string')
    expect(typeof press('a', 'other')).toBe('string')
  })

  test('with nothing to offer — no project, or the program missing — the header is withdrawn', async () => {
    const s = told()
    s.state.found = null
    render(<Sessions theme="dark" at={at()} api={s.api} hosted={s.hosted} />)
    await flush()
    expect(s.headers.at(-1)).toEqual([])
    const none = told()
    render(<Sessions theme="dark" at={null} cover="no-project" api={none.api} hosted={none.hosted} />)
    await flush()
    expect(none.headers.at(-1)).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * A place with no session in a project that has some (#6)
 * ------------------------------------------------------------------ */

describe('a place with no session, in a project that has others', () => {
  const others = [row('near', { label: 'the whole epic’s conversation', near: ['whole epic · writing'] }), row('far', { label: 'started in a plain terminal' })]

  test('the list is drawn before anything is started — "New session" first — and nothing is mounted for nothing', async () => {
    const s = server()
    s.state.others = others
    const { container } = render(<Sessions theme="dark" at={at(['methods'])} api={s.api} />)
    await flush()
    await flush()
    const list = container.querySelector('[data-chooser]') as HTMLElement
    expect(list.getAttribute('data-chooser')).toBe('offer')
    expect([...list.querySelectorAll('[data-row]')].map((one) => one.getAttribute('data-row'))).toEqual(['new', 'other', 'other'])
    expect(list.querySelector('[aria-selected="true"]')?.getAttribute('data-row')).toBe('new')
    /* No empty session was started to be dealt with afterwards. */
    expect(mounted.length).toBe(0)
    expect(all(container)).toEqual([])
    /* And no row or strip beside the list: it is all there is in the terminal's place. */
    expect(container.querySelector('[data-sessions]')).toBeNull()
    expect(container.querySelector('[data-ended]')).toBeNull()
  })

  test('Enter takes the new one, at once', async () => {
    const s = server()
    s.state.others = others
    const { container } = render(<Sessions theme="dark" at={at(['methods'])} api={s.api} />)
    await flush()
    fireEvent.keyDown(container.querySelector('[data-chooser]') as HTMLElement, { key: 'Enter' })
    await round()
    expect(shown(container)).toEqual(['methods@3:new'])
    expect(container.querySelector('[data-chooser]')).toBeNull()
  })

  test('choosing an existing one opens it here — which is what attaches it — and the next open of the place is direct', async () => {
    const s = server()
    s.state.others = others
    const first = render(<Sessions theme="dark" at={at(['methods'])} api={s.api} />)
    await flush()
    fireEvent.click(first.getByText('the whole epic’s conversation'))
    await flush()
    expect(shown(first.container)).toEqual(['methods@3:near'])
    const target = view('methods@3:near').target
    expect(target.what === 'session' && target.session).toBe('near')
    first.unmount()
    mounted.length = 0
    sessionStorage.clear()

    /* The server attached it when it opened it (live.ts): the place has a session now, and is not asked again. */
    s.held[KEY(['methods'])] = [row('near', { label: 'the whole epic’s conversation' })]
    s.state.others = [others[1]!]
    const again = render(<Sessions theme="dark" at={at(['methods'])} api={s.api} />)
    await flush()
    expect(again.container.querySelector('[data-chooser]')).toBeNull()
    expect(shown(again.container)).toEqual(['methods@3:near'])
  })

  test('a project with no other session starts a new one as before, with no list', async () => {
    const s = server()
    const { container } = render(<Sessions theme="dark" at={at(['methods'])} api={s.api} />)
    await flush()
    expect(container.querySelector('[data-chooser]')).toBeNull()
    expect(shown(container)).toEqual(['methods@3:new'])
  })

  test('walking on to another place leaves nothing behind: no session was started at the one that only asked', async () => {
    const s = server()
    s.state.others = others
    const { container, rerender } = render(<Sessions theme="dark" at={at(['methods'])} api={s.api} />)
    await flush()
    rerender(<Sessions theme="dark" at={at(['results'])} api={s.api} />)
    await flush()
    expect(container.querySelector('[data-chooser]')?.getAttribute('data-chooser')).toBe('offer')
    expect(mounted.length).toBe(0)
    expect(unmounted.length).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * A session that is running somewhere this module did not start it (#5)
 * ------------------------------------------------------------------ */

describe('a session that is already running somewhere else', () => {
  const terminal = { kind: 'interactive' as const, called: 'interactive', pid: 82070, cwd: '/Users/someone/Projects/thesis', since: Date.now() - 17 * 60_000, name: 'project-ea' }
  const job = { kind: 'background' as const, called: 'background', pid: 82454, cwd: '/Users/someone/Projects/thesis', since: Date.now() - 60 * 60_000, name: 'stand-in' }
  /** The server refuses to resume it: it says who has it, and closes. */
  const refuse = (name: string) => {
    const one = view(name)
    act(() => one.say({ elsewhere: terminal, session: 'a' }))
    act(() => one.tell({ at: 'closed', code: 4409, why: 'open in another process; nothing was started' }))
  }

  test('open in another terminal: the place says where and for how long, and offers the two choices in words — nothing is started by itself', async () => {
    const s = server({ [KEY()]: [row('a', { label: 'tighten the methods' })] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    expect(shown(container)).toEqual(['whole@3:a'])
    refuse('whole@3:a')
    await flush()
    await flush()
    /* The view is gone and nothing took its place: no second attempt, however often the list is read. */
    expect(all(container)).toEqual([])
    expect(mounted.length).toBe(0)
    const question = container.querySelector('[data-elsewhere-question]') as HTMLElement
    expect(question.getAttribute('data-elsewhere-question')).toBe('interactive')
    expect(question.textContent).toContain('“tighten the methods” is already open in another Claude Code process on this computer: an interactive session, in a terminal or an editor, process 82070, in /Users/someone/Projects/thesis, started 17 min ago.')
    expect(question.textContent).toContain('nothing has been started')
    const rows = [...question.querySelectorAll('[data-row]')]
    expect(rows.map((one) => one.getAttribute('data-row'))).toEqual(['leave', 'copy'])
    expect(rows[0]?.textContent).toContain('Leave it')
    expect(rows[1]?.textContent).toContain('Open a copy anyway')
    /* What a copy means is beside the word, before it is chosen. */
    expect(rows[1]?.textContent).toContain('Remote Control stays with the other one until /remote-control is run here, and the two do not see each other’s turns.')
    /* The keyboard starts on the answer that starts nothing. */
    expect(question.querySelector('[aria-selected="true"]')?.getAttribute('data-row')).toBe('leave')
    expect(document.activeElement).toBe(question)
  })

  test('"Open a copy anyway" opens it with the word for a copy, and the corner says it is one for as long as it is on screen', async () => {
    const s = server({ [KEY()]: [row('a', { label: 'tighten the methods' })] })
    const { container, getByText } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    const before = view('whole@3:a').target
    expect(before.what === 'session' && before.copy).toBeFalsy()
    refuse('whole@3:a')
    await flush()
    fireEvent.click(getByText('Open a copy anyway'))
    await flush()
    expect(shown(container)).toEqual(['whole@3:a'])
    const target = view('whole@3:a').target
    expect(target.what === 'session' && target.copy).toBe(true)
    expect(container.querySelector('[data-elsewhere-question]')).toBeNull()

    act(() => view('whole@3:a').say({ opened: 'copy', session: 'a', label: 'tighten the methods', exists: true, copyOf: terminal }))
    const control = container.querySelector('[data-sessions]') as HTMLElement
    expect(control.textContent).toBe('tighten the methods · copy ▾')
    expect(control.getAttribute('title')).toContain('A copy. This conversation is also open in another Claude Code process')
    expect(control.getAttribute('title')).toContain('Remote Control stays with the other one until /remote-control is run here, and the two do not see each other’s turns.')
  })

  test('"Leave it" starts nothing: the list is shown, and reading it again does not try the session again', async () => {
    const s = server({ [KEY()]: [row('a', { label: 'tighten the methods', elsewhere: terminal })] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    refuse('whole@3:a')
    await flush()
    fireEvent.keyDown(container.querySelector('[data-elsewhere-question]') as HTMLElement, { key: 'Enter' })
    await flush()
    await flush()
    expect(container.querySelector('[data-elsewhere-question]')).toBeNull()
    const list = container.querySelector('[data-chooser]') as HTMLElement
    expect(list).not.toBeNull()
    expect(list.querySelector('[data-session="a"]')?.textContent).toContain('open elsewhere')
    expect(mounted.length).toBe(0)
    expect(all(container)).toEqual([])
  })

  test('coming back to the place asks the program again: what was running is never remembered', async () => {
    const s = server({ [KEY()]: [row('a')] })
    const { container, rerender } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    refuse('whole@3:a')
    await flush()
    expect(container.querySelector('[data-elsewhere-question]')).not.toBeNull()
    rerender(<Sessions theme="dark" at={at(['results'])} api={s.api} />)
    await flush()
    rerender(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    /* A fresh view, which is a fresh socket and a fresh check on the server. */
    expect(container.querySelector('[data-elsewhere-question]')).toBeNull()
    expect(shown(container)).toEqual(['whole@3:a'])
  })

  test('a server that closes that way without saying who has it is still asked about, never retried silently', async () => {
    const s = server({ [KEY()]: [row('a')] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    act(() => view('whole@3:a').tell({ at: 'closed', code: 4409, why: 'open in another process; nothing was started' }))
    await flush()
    expect(container.querySelector('[data-elsewhere-question]')?.textContent).toContain('This conversation is already open in another Claude Code process on this computer.')
    expect(mounted.length).toBe(0)
  })

  test('running in the background: it is simply on screen, attached, and the corner says so without a row', async () => {
    const s = server({ [KEY()]: [row('a', { label: 'a background job' })] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    act(() => view('whole@3:a').say({ opened: 'background', session: 'a', label: 'a background job', exists: true, background: job }))
    expect(container.querySelector('[data-elsewhere-question]')).toBeNull()
    expect(shown(container)).toEqual(['whole@3:a'])
    const control = container.querySelector('[data-sessions]') as HTMLElement
    expect(control.textContent).toBe('a background job · background ▾')
    expect(control.getAttribute('data-how')).toBe('background')
    expect(control.getAttribute('title')).toContain('no second process was started')
  })

  test('resumed by a copy too old to be asked: the corner says it was not checked', async () => {
    const s = server({ [KEY()]: [row('a', { label: 'an old install' })] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    act(() => view('whole@3:a').say({ opened: 'resumed', session: 'a', label: 'an old install', exists: true, unchecked: 'too-old' }))
    const control = container.querySelector('[data-sessions]') as HTMLElement
    expect(control.textContent).toBe('an old install · unchecked ▾')
    expect(control.getAttribute('title')).toContain('this Claude Code is too old to say')
  })

  test('an ordinary session says none of it', async () => {
    const s = server({ [KEY()]: [row('a', { label: 'only here' })] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    act(() => view('whole@3:a').say({ opened: 'resumed', session: 'a', label: 'only here', exists: true }))
    expect(container.querySelector('[data-sessions]')?.textContent).toBe('only here ▾')
    expect(container.querySelector('[data-sessions]')?.hasAttribute('data-how')).toBe(false)
  })
})

describe('whether the corner control is drawn, by what the host said (protocol 1.4.0)', () => {
  test('true: none; false: drawn, even after an earlier press; null: as before, the press decides', () => {
    expect(hostDrawsHeader(true, false)).toBe(true)
    expect(hostDrawsHeader(false, true)).toBe(false)
    expect(hostDrawsHeader(null, false)).toBe(false)
    expect(hostDrawsHeader(null, true)).toBe(true)
  })

  test('with the host drawing the header, the Go item says which session is on screen, and no row is added', async () => {
    const s = told({ [KEY()]: [row('a', { label: 'tighten the methods' })] })
    s.hosted.drawn = true
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} hosted={s.hosted} canvasEpic="thesis" />)
    await flush()
    act(() => view('whole@3:a').say({ session: 'a', state: 'needs-you', since: Date.now() }))
    await flush()
    expect(container.querySelector('[data-sessions]')).toBeNull()
    const items = s.headers.at(-1) as { label: string }[]
    expect(items[0]!.label).toBe('Sessions · ◆ tighten the methods')
    expect(headerItemsSchema.safeParse(items).success).toBe(true)
  })
})
