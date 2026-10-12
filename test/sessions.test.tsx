import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { resetServerStanding } from 'kehikot-module-protocol/client'
import { useEffect } from 'react'

import type { Listing, Row } from '../doors.ts'
import type { Api } from '../src/api.ts'
import { standing } from '../src/view/places.ts'
import type { Standing, Target } from '../src/view/terminal-view.tsx'

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
  say: (said: { session?: string | null; label?: string; exists?: boolean; typed?: boolean }) => void
}
const mounted: Mounted[] = []
const unmounted: Target[] = []
const which = (kehikko: Extract<Target, { what: 'session' }>['place']['kehikko']) => (kehikko === null ? '-' : 'key' in kehikko ? `key:${kehikko.key}` : kehikko.id)
const naming = (target: Target) => (target.what === 'install' ? 'install' : `${target.place.parts.join('+') || 'whole'}@${which(target.place.kehikko)}:${target.session ?? 'new'}`)

mock.module('../src/view/terminal-view.tsx', () => ({
  TerminalView: ({ target, shown, onStanding, onSaid }: { target: Target; shown: boolean; onStanding?: (s: Standing) => void; onSaid?: (s: object) => void }) => {
    useEffect(() => {
      const mine: Mounted = { target, tell: (next) => onStanding?.(next), say: (said) => onSaid?.(said) }
      mounted.push(mine)
      return () => {
        unmounted.push(target)
        mounted.splice(mounted.indexOf(mine), 1)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return <div data-terminal={naming(target)} data-shown={shown ? 'yes' : 'no'} />
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
  const state = { found: '/bin/claude' as string | null, lacks: null as string | null, running: [] as Listing['running'], most: 6, others: [] as Row[] }
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
        program: { name: 'Claude Code', found: state.found, foundAt: state.found, looked: ['/usr/bin', '/Users/someone/.local/bin'], where: 'PATH, ~/.local/bin', lacks: state.lacks, install: { line: 'curl -fsSL https://claude.ai/install.sh | bash', lands: '~/.local/bin/claude' } },
        sessions: held[key] ?? [],
        others: state.others,
        running: state.running,
        most: state.most,
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
  test('sits over the terminal with the session’s label, and costs no row', async () => {
    const s = server({ [KEY()]: [row('a', { label: 'tighten the methods section and everything after it' })] })
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    const control = container.querySelector('[data-sessions]') as HTMLElement
    expect(control.textContent).toBe('tighten the methods section… ▾')
    expect(control.className).toContain('absolute')
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

describe('at the bound', () => {
  test('a refused open ends nothing: the person is shown what is running, ends one, and the open goes ahead', async () => {
    const s = server()
    const { container } = render(<Sessions theme="dark" at={at()} api={s.api} />)
    await flush()
    s.state.most = 2
    s.state.running = [
      { id: 'x', label: 'the oldest', projectPath: P, place: null, here: false, startedAt: 1 },
      { id: 'y', label: 'another', projectPath: '/p/other', place: null, here: false, startedAt: 2 },
    ]
    act(() => view('whole@3:new').tell({ at: 'closed', code: 4429, why: '2 sessions are running' }))
    await flush()
    expect(container.querySelector('[data-chooser="full"]')?.textContent).toContain('2 sessions are running, which is as many as this module keeps')
    expect(mounted.length).toBe(0)
    expect(s.asked.filter((one) => one.startsWith('end'))).toEqual([])

    fireEvent.click(container.querySelectorAll('[data-row="running"] button')[0] as HTMLElement)
    await act(async () => void (await new Promise((done) => setTimeout(done, 250))))
    await flush()
    expect(s.asked).toContain('end x')
    expect(shown(container)).toEqual(['whole@3:new'])
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
