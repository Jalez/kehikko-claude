import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import { probeServer, ticket } from 'kehikot-module-protocol/client'

import { typedByPerson } from '../../input.ts'
import type { Kehikko } from '../../place.ts'

/**
 * One view of one run: xterm in the page, and a socket to the session the
 * server is holding.
 *
 * It is Terminal's `terminal-view.tsx` with one thing turned round. There,
 * the view OWNS the shell: unmounting it closes the socket and the pty dies.
 * Here the view is a viewer. The session belongs to the server (`live.ts`);
 * this attaches to it, is sent the screen as it stands, and follows along.
 * Unmounting closes the socket and nothing else — which is what lets a page
 * reload, a place switched away from, or a view let go to keep the page
 * light all leave an agent exactly where it was.
 *
 * What came over unchanged, each for the reason Terminal found the hard way
 * (its file has the essays): nothing is opened until the container has a real
 * width; a container with no size is not a container two columns wide; what
 * is typed before the socket opens is kept and flushed in order rather than
 * dropped; a keystroke can be what connects.
 *
 * ## Two kinds of frame, and why
 *
 * What the program prints arrives as BINARY and is written to the emulator
 * unread. What this module's server says to its own page — which session
 * this is, what it is called — arrives as TEXT. The kind of the frame is the
 * envelope, so nothing a program prints can be read as the second.
 */

/** xterm's palette, which does not follow the page's CSS: it paints with colours it was handed. */
function palette(theme: 'light' | 'dark') {
  return theme === 'dark'
    ? { background: '#0a0a0a', foreground: '#e5e5e5', cursor: '#e5e5e5', selectionBackground: '#333333' }
    : { background: '#ffffff', foreground: '#171717', cursor: '#171717', selectionBackground: '#d4d4d4' }
}

export type Standing =
  | { at: 'opening' }
  | { at: 'live' }
  /** `code` is the server's reason as a number (see `CLOSED` in live.ts); 0 when the socket simply went. */
  | { at: 'closed'; code: number; why: string }

/**
 * The server's own word about the run, and one of the page's: `typed` is said
 * here, the first time a PERSON types into this view. What the emulator
 * answers the program by itself comes out of the same event and is not that
 * (see `input.ts`): it is sent on, and says nothing about the view.
 */
export interface Said {
  session?: string | null
  label?: string
  opened?: string
  /** Whether the program has a record of the session yet. */
  exists?: boolean
  typed?: boolean
}

/** What this view asks the server to put it on. Fixed for the life of the view. */
export type Target =
  | { what: 'install' }
  | {
      what: 'session'
      projectPath: string
      place: { epic: string | null; parts: string[]; kehikko: Kehikko | null; kehikkoName: string; kehikkoId?: number }
      /** Null is a new session. */
      session: string | null
    }

export function TerminalView({
  theme,
  target,
  shown,
  watched = shown,
  onStanding,
  onSaid,
}: {
  theme: 'light' | 'dark'
  target: Target
  /** Whether this is the view on screen. The others are hidden by the parent and keep following. */
  shown: boolean
  /**
   * Whether this is the view of the place the canvas is on — which it still
   * is while a list is drawn over it. The server is told, because a view
   * mounted behind another keeps its socket and is not somebody looking: a
   * session nobody is looking at, waiting at its prompt, is put away after a
   * long while and resumed when its place is opened (`QUIET_REST` in live.ts).
   */
  watched?: boolean
  onStanding?: (standing: Standing) => void
  /** The server's own word: which session this turned out to be, and what it is called. */
  onSaid?: (said: Said) => void
}) {
  /* Read inside the effect below, which runs once. A view is never re-pointed:
     the parent mounts another for another session. */
  const start = useRef(target)
  const holder = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const line = useRef<WebSocket | null>(null)
  const looking = useRef(watched)
  looking.current = watched

  /* Held in refs and read inside the effect rather than listed as
     dependencies: a parent that re-created a callback on every render would
     otherwise tear the socket down with it. */
  const told = useRef(onStanding)
  told.current = onStanding
  const said = useRef(onSaid)
  said.current = onSaid

  useEffect(() => {
    const node = holder.current
    if (!node) return

    const terminal = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      scrollback: 5000,
      cursorBlink: true,
      theme: palette(theme),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(node)
    term.current = terminal

    /* A hidden view measures zero on both axes, so this is also what keeps a
       view mounted behind another from opening until it is shown. */
    const usable = () => node.clientWidth > 40 && node.clientHeight > 40

    let socket: WebSocket | null = null
    const waiting: string[] = []
    /* Set by this effect's cleanup. A socket closed BY the cleanup still
       reports its close, a tick later, and that is not news about the run:
       React mounts every view twice in development, and the first one's
       closing socket was being read as "the connection could not be made". */
    let left = false

    const connect = () => {
      if (socket) return
      try {
        fit.fit()
      } catch {
        return
      }
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
      const live = new WebSocket(`${scheme}://${location.host}/session`)
      live.binaryType = 'arraybuffer'
      socket = live
      line.current = live

      live.onopen = () => {
        if (left) return live.close()
        const asked = start.current
        live.send(
          JSON.stringify(
            asked.what === 'install'
              ? { ticket: ticket(), install: true, cols: terminal.cols, rows: terminal.rows }
              : {
                  ticket: ticket(),
                  projectPath: asked.projectPath,
                  place: asked.place,
                  session: asked.session,
                  cols: terminal.cols,
                  rows: terminal.rows,
                },
          ),
        )
        told.current?.({ at: 'live' })
        if (visible.current) terminal.focus()
        /* Whatever was typed while this was opening, in order, after the opening frame. */
        for (const data of waiting.splice(0)) live.send(JSON.stringify({ d: data }))
        /* Taken for on screen unless said otherwise: it usually is, having just been shown. */
        if (!looking.current) live.send(JSON.stringify({ w: false }))
      }

      let ended = false
      live.onmessage = (event: MessageEvent) => {
        if (left) return
        if (typeof event.data !== 'string') {
          /* The program's bytes, straight through and never parsed. */
          terminal.write(new Uint8Array(event.data as ArrayBuffer))
          return
        }
        try {
          const heard: unknown = JSON.parse(event.data)
          if (typeof heard === 'object' && heard !== null) said.current?.(heard as Said)
        } catch {
          /* Not this module's word. Dropped, not drawn. */
        }
      }
      const closed = (code: number, why: string) => {
        if (ended || left) return
        ended = true
        /* A session that ended and a server that stopped both end the socket.
           Ask which, so a page whose server has gone says that. */
        if (code < 4000) void probeServer()
        told.current?.({ at: 'closed', code, why })
      }
      live.onclose = (event: CloseEvent) => closed(event.code >= 4000 ? event.code : 0, event.reason || 'the connection ended')
      live.onerror = () => closed(0, 'the connection could not be made')
    }

    let typed = false
    const typing = terminal.onData((data: string) => {
      /* Everything is sent on: the program's questions have to be answered.
         Only what a person typed says the view holds something. */
      if (!typed && typedByPerson(data)) {
        typed = true
        said.current?.({ typed: true })
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ d: data }))
        return
      }
      /* Bounded, oldest first out: what survives is what was most recently meant. */
      waiting.push(data)
      if (waiting.length > 512) waiting.shift()
      if (!socket && usable()) connect()
    })

    const resized = new ResizeObserver(() => {
      if (!socket) {
        if (usable()) connect()
        return
      }
      /* An absent measurement is not a small one: do nothing at all. */
      if (!usable()) return
      try {
        fit.fit()
      } catch {
        return
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ r: { cols: terminal.cols, rows: terminal.rows } }))
      }
    })
    resized.observe(node)

    /* Already laid out when this mounted: it has its size now and should not
       wait for an observation that may not come. */
    if (usable()) connect()

    return () => {
      left = true
      resized.disconnect()
      typing.dispose()
      /* The viewer leaves. The session, on the server, is not touched. */
      socket?.close()
      line.current = null
      terminal.dispose()
      term.current = null
    }
    /* The theme is deliberately not a dependency: a theme change must not
       reconnect anything. It is applied to the live emulator below. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (term.current) term.current.options.theme = palette(theme)
  }, [theme])

  /* On screen, or behind another view: said to the server as it changes. */
  useEffect(() => {
    const live = line.current
    if (live && live.readyState === WebSocket.OPEN) live.send(JSON.stringify({ w: watched }))
  }, [watched])

  /* This became the view on screen: take the keyboard. */
  const visible = useRef(shown)
  visible.current = shown
  useEffect(() => {
    if (shown) term.current?.focus()
  }, [shown])

  return <div ref={holder} className="h-full w-full" />
}
