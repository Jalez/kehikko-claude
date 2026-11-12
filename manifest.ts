import { MANIFEST_KIND, PROTOCOL, manifestSchema, type Manifest } from 'kehikot-module-protocol'
import pkg from './package.json'
import { SETTINGS } from './settings.ts'
import { EVENTS } from './events.ts'
/* This module's introduction (protocol 2.57.0): slides the host shows in its introduction dialog. Also
   read as a file from the repository, so a person can watch it before the module runs or is installed. */
import intro from './intro.json'

/** "How to use" (protocol 2.52.0). Each string one line of plain text. */
export const HELP = {
  summary: 'A terminal holding the Claude Code session that belongs to the place you are on: this project, its epic, the parts you picked and this kehikko.',
  sections: [
    {
      title: 'What it shows',
      points: [
        'Claude Code itself, in a terminal, for the place on screen: the project, its epic, the parts picked in the bar and this kehikko.',
        'The footer says what the conversation is doing (Working, Needs you or Finished), how full its context is, and holds Compact and Clear.',
        'In a container too small for a terminal, a tile: a ring for what the session is doing, and its title. Press it to see the session large; Answer replies to a waiting question with its choices.',
        'A new conversation it starts for a place becomes that place’s own by itself once you say something in it, at any size, the tile included. A bar says so while nothing is connected yet.',
      ],
    },
    {
      title: 'How to use it',
      points: [
        'Type in the session as you would anywhere. Pick other parts, another epic or another kehikko, and the session kept for that place opens.',
        'The Conversation chooser in the View menu lists this kehikko’s own conversation and the others here, with what each is doing; choose one to resume it, or New conversation, or Disconnect this conversation.',
        'Type /kehikot-here only in a conversation started elsewhere (a terminal, a background job) to connect it to the kehikko on screen. Copy /kehikot-here, in the footer, copies it for you.',
        'A question a session asks you, or a turn that ended, waits in Kehikot’s Inbox. Answer it there and the answer is typed into the session as yours.',
        'The module’s settings in Kehikot hold its choices, such as resuming conversations that a restart cut off.',
      ],
    },
    {
      title: 'What agents can do',
      points: [
        'sessions lists which sessions belong to which place, and whether each is working, waiting for you or finished.',
        'tell_finished says how a turn ended: done, research, or a decision for you with its choices, which then waits in the Inbox.',
        'send_message and read_messages let the sessions in a project write to each other. A message is typed into the receiving session, quoted as its sender’s.',
      ],
    },
    {
      title: 'Rules',
      points: [
        'The session is yours. No agent can type into it as you, start one or end one; another session’s message is typed in marked as theirs.',
        'A message is never typed into a session waiting for your answer, or with something typed and not sent: it waits.',
        'Claude Code keeps its own conversations. Which place each belongs to is kept in the project’s .kehikot folder.',
        'When you adopt a pull request into an epic, Kehikot itself may ask which conversation worked on it, file that one under the epic if it belongs to no other place, and start a new one with a brief for a task you started. No agent or other module can.',
      ],
    },
  ],
}

export const ID = 'kehikot.claude'
/** The module's version: package.json's, the one place it is written. A release is tagged with it. */
export const VERSION: string = pkg.version

/**
 * The format a notice is sent in: the protocol's own, by its name. Whatever
 * on the canvas says it shows these is who hears — this module does not know
 * what that is, and names no module.
 */
export const NOTICES = 'kehikot.notifications@1'

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
 * - **`scope: 'kehikko'`** (protocol 2.29.0). A session is kept for a place — this kehikko, the open
 *   epic and its picked parts — and the kehikko is the outermost of those a person sees: another
 *   kehikko on the same epic keeps sessions of its own. Told which epic is open on every switch.
 * - **`uses: ['activity:report']`** (protocol 1.5.0): the whole list of its sessions' states, said
 *   again on every change, for the host to mark epics, parts and kehikot. A host without the
 *   method is told nothing (the client checks the greeting), and a 1.4.0 host accepts the word.
 * - **`uses: ['agents:message']`** (protocol 2.41.0): `send_message` and `read_messages` on its door, a
 *   thin adapter over the host's messages between agent sessions, and a session's unread ones in its
 *   notes. A host before 2.41.0 keeps none: the door lists neither tool and the notes say nothing.
 * - **`uses: ['view:expand']`** (protocol 2.58.0): in a container too small for a terminal the page
 *   is a tile, and pressing it asks the host to show the container large over the canvas. A host
 *   that does not answer the method is not asked: the tile shows the conversation in place.
 * - **`uses: ['state:keep']`** (protocol 2.70.0): the client keeps the container's view with the host
 *   (`keepView`); every header switch and toggle here is excepted, so it is the document's scroll.
 * - **`uses: ['services:read']`** (protocol 2.81.0): `services.find` for `work.queue`, so what a session
 *   is told about handing heavy work to a queue (after a restart, when its guards went unasked) is the
 *   providing module's own words from its descriptor. With none provided, no queue is mentioned.
 * - **`uses: ['events:emit']`, `emits: [NOTICES]`.** The one thing it asks a
 *   host: to carry a line saying that a session a person is not looking at
 *   has finished, or has stopped to wait for them. Reading the context is not
 *   a capability, and it asks for nothing else.
 * - **`mcp.as: 'kehikko-claude'`.** What an agent host registers the door
 *   under. The id would derive `claude`, which is the name of the program an
 *   agent is most likely to be, and a door called that reads as the agent's
 *   own.
 * - **`prompt: false`.** Nothing here sends a prompt to anything. The person
 *   types.
 * - **`storage: true`.** The page opens a WebSocket to its own origin, and
 *   the thing behind it runs a program as the person. Without an origin of
 *   its own the page would be opaque and the socket cross-origin, and the
 *   only fix for that is the permissive header that must never appear here.
 * - **An MCP door with a tool that reads, and one that tags.** Which sessions
 *   belong to which place (`sessions`), and `tell_finished`, with which a
 *   session's own agent says its finished work was research. No tool starts,
 *   stops, installs or types into anything: an agent that could type into a
 *   person's session would be the inversion of what this module is for.
 * - **`events`** (protocol 2.31.0): "Research complete", a case of a finished
 *   item (research.ts).
 * - **`skills`** (protocol 2.5.0): `/kehikot-here`, which a person types in a Claude Code
 *   conversation to assign it to the kehikko on screen (see skills.ts and `here.ts`). Offered, not
 *   installed: a host shows it and installs it on the person's press. Added to this manifest
 *   where it is served (`MANIFEST` in doors.ts), because the version is read from a file and this
 *   one is imported by the page too.
 */
export const MANIFEST: Manifest = manifestSchema.parse({
  kind: MANIFEST_KIND,
  protocol: PROTOCOL,
  id: ID,
  name: 'Claude',
  /* The icon a host draws beside the name: a key of the protocol's module icons, never a path
     or URL. The mark of the tool this module fronts, which identifies that tool and nothing
     else; the same key Kehikot's official list gives it. */
  icon: 'brand:claude',
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
    + 'their first prompt, when each was last active, and whether a running one is working, waiting for its person '
    + 'or finished — before starting work that one of them may already hold. Placing this module on a kehikko '
    + 'starts nothing by itself: a place with no session asks its person which of the project’s sessions to carry '
    + 'on with (or a new one) when the project has any, and a session already open in another process is asked '
    + 'about rather than copied. Call `sessions` with `place` to be told in words what a place holds.',
  /* "How to use" (protocol 2.52.0), and the introduction (protocol 2.57.0). */
  help: HELP,
  intro,
  entry: '/app',
  /* What its content belongs to (protocol 2.29.0): one mode per scope, the default first. */
  modes: [
    { id: 'claude', label: 'Claude', scope: 'kehikko', scopeSays: 'the Claude sessions kept for this kehikko, at the open epic and its picked parts' },
  ],
  mcp: {
    url: '/mcp',
    transport: 'http',
    as: 'kehikko-claude',
    about:
      'Which Claude Code sessions a person keeps for which place, and whether one is working, waiting or finished;'
      + ' tell_finished says how a turn ends: done, a decision, or research.',
  },
  extensions: { emits: [NOTICES], consumes: [] },
  reacts: ['parts'],
  /* Another module may ask for one of a place's conversations to be shown (`view.goto { show }`,
     protocol 2.28.0): a work queue, going to the session that queued a run. See `showStep`. */
  shows: ['agent-session'],
  /* "Research complete" (protocol 2.31.0): a finished turn or subagent that was research names it,
     and the host may give it a sound of its own. A case of `done`; an older host ignores it. See research.ts. */
  events: EVENTS,
  /* Its sessions run in its own process, so a restart of it ends them (protocol 2.33.0): a host does
     not restart it on its own account — an automatic update waits for them to end. */
  holds: ['live-sessions'],
  /* A terminal must not be resized by a hover (protocol 2.42.0): a resize is a SIGWINCH and Claude
     redraws its whole screen. The host's focus-mode header and footer come OVER the page instead, and
     the view keeps its last line above them (`src/view/keep-last.ts`). An older host ignores this. */
  reveal: 'over',
  declares: {
    protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`,
    uses: ['events:emit', 'activity:report', 'agents:message', 'view:expand', 'state:keep', 'services:read'],
    /* This module runs Claude Code sessions and loads the kehikko-bound skills of the modules on a
       session's kehikko into them (protocol 2.21.0). A host routes those skills to a module that
       says so; one built with 2.21.0 that says nothing is not treated as a skill loader. */
    agentSessions: { loadsSkills: true },
    storage: true,
    prompt: false,
    /* "Resume conversations cut off by a restart", in the host's Settings too (protocol 2.15.0). See `settings.ts`. */
    settings: SETTINGS,
  },
  /* What it provides to the HOST (protocol 2.88.0, hostServices.ts): which conversation worked on a
     change and filing it under a place, and a new conversation fed a brief. Only the host's own
     server is answered (`vouchHost`). */
  services: {
    'conversations.finder': { name: 'Claude', program: 'Claude Code', find: '/api/conversations/find', bring: '/api/conversations/bring' },
    'agent.tasks': { name: 'Claude', program: 'Claude Code', start: '/api/tasks/start', view: '/app?session={session}' },
  },
  health: '/healthz',
})
