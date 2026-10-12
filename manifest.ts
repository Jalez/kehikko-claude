import { MANIFEST_KIND, PROTOCOL, manifestSchema, type Manifest } from 'kehikot-module-protocol'

export const ID = 'kehikot.claude'
export const VERSION = '0.1.0'

/**
 * Where this module would like to answer. Said once, here, and read by
 * `vite.config.ts` and `register.ts`. Modules on this machine sit ten apart
 * (7820 to 8000 are taken), so a drift up from one never lands on a
 * neighbour's number. 8020 is left for the Codex module that is to follow.
 *
 * A preference and not a promise: `live.ts` checks a handshake's `Origin` and
 * `Host` against the port this server actually bound, which `vite.config.ts`
 * reads off the listening socket rather than from here.
 */
export const PREFERRED_PORT = 8010

/**
 * What this app says about itself when a host asks.
 *
 * ## What it is
 *
 * A terminal with one program in it: the Claude Code session that belongs to
 * the place the person is looking at. Terminal (`kehikot.terminal`) is a
 * shell, where `claude` is one of the things you can type; this is what was
 * asked for in its place when the typing was always the same — "the same
 * session associated with this specific epic > parts > kehikko".
 *
 * It is a module of its own and not a mode of Terminal, because the two keep
 * opposite promises. A shell belongs to a folder and ignores the epic on
 * purpose (`kehikko-terminal/src/view/sessions.ts`); a session here belongs
 * to the epic, the parts picked out of it and the kehikko, and moves when any
 * of them does.
 *
 * ## What is declared
 *
 * - **`reacts: ['parts']`.** The picked parts are part of what a place IS:
 *   picking Methods moves this module to the session for Methods. Nothing is
 *   narrowed and nothing left out, so there is no sentence about what is
 *   outside the focus — the session on screen is the whole answer.
 * - **`scope: 'epic'`.** Told which epic is open and told again on every
 *   switch, which is the other half of a place.
 * - **`uses: []`.** It asks the host for nothing. Reading the context is not
 *   a capability.
 * - **`prompt: false`.** Nothing here sends a prompt to anything. The person
 *   types.
 * - **`storage: true`.** The page opens a WebSocket to its own origin, and
 *   the thing behind it runs a program as the person. Without an origin of
 *   its own the page would be opaque and the socket cross-origin, and the
 *   only fix for that is the permissive header that must never appear here.
 * - **An MCP door with one tool that reads.** Which sessions belong to which
 *   place. No tool starts, stops, installs or types into anything: an agent
 *   that could type into a person's session would be the inversion of what
 *   this module is for.
 */
export const MANIFEST: Manifest = manifestSchema.parse({
  kind: MANIFEST_KIND,
  protocol: PROTOCOL,
  id: ID,
  name: 'Claude',
  version: VERSION,
  /* The format of `.kehikot/claude/places.json`. Raise it only in the release
     that first writes data an older release cannot read. */
  dataVersion: 1,
  summary: 'A terminal holding the Claude Code session that belongs to this epic, these parts and this kehikko.',
  tags: ['agents', 'code'],
  guidance:
    'A person on this canvas has a Claude Code session open in a terminal, kept for exactly the epic, the picked '
    + 'parts and the kehikko in front of them. It is theirs: they type in it, and nothing here lets you type into it, '
    + 'start one or end one. Call `sessions` with the project path to see which sessions belong to which place — '
    + 'their first prompt and when each was last active — before starting work that one of them may already hold.',
  entry: '/app',
  modes: [{ id: 'claude', label: 'Claude', scope: 'epic' }],
  mcp: {
    url: '/mcp',
    transport: 'http',
    about:
      'Read which Claude Code sessions a person keeps for which place (epic, picked parts, kehikko) in a project. '
      + 'Read-only: nothing here starts, ends or types into a session.',
  },
  extensions: { emits: [], consumes: [] },
  reacts: ['parts'],
  declares: {
    protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`,
    uses: [],
    storage: true,
    prompt: false,
  },
  health: '/healthz',
})
