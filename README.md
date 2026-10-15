# Claude

A terminal holding the Claude Code session that belongs to the place you are looking at.

Port **8010**. `kehikot.claude`.

```bash
bun install
bun run register     # tell a host on this machine where this answers
./run.sh             # or: PORT=8010 ./run.sh
```

Then put it on a kehikko. Opened on its own (<http://127.0.0.1:8010/app>) it says nothing is framing it:
a session belongs to a project, and only a host says which.

---

## What this is

Terminal (`kehikot.terminal`) is a shell, and `claude` is one of the things you can type in it. This is
what was asked for when the typing was always the same: *"a variant of terminal module for claude code
that automatically opens claude code session in the terminal. It should be the same session associated
with this specific epic > parts > kehikko, and if there are more than one session associated with it,
then it asks which one to open before it opens it."*

It is a module of its own and not a mode of Terminal, because the two keep opposite promises. A shell
belongs to a folder and ignores the epic on purpose; a session here belongs to the epic, the parts
picked out of it and the kehikko, and moves when any of them does.

### A place

A **place** is the exact combination *project + epic + the set of picked parts + kehikko*. Methods alone
and Methods with Results are different places; nothing picked is a place too (the whole epic); the
order parts were picked in does not matter.

Opening the module on a place:

- **no session there, and none anywhere in the project** — a new Claude Code session starts in the
  project's folder;
- **no session there, and the project has others** — the list, before anything is started (see
  [A place with no session](#a-place-with-no-session-in-a-project-that-has-some));
- **exactly one** — it is opened at once: resumed, or — when Claude Code is already running it somewhere
  else — attached to or asked about (see [A session that is already
  running](#a-session-that-is-already-running-somewhere-else));
- **more than one** — a short list, in the terminal's own space, before anything is opened: each
  session's first prompt, when it was last active and whether it is running, plus *New session* and
  *Attach an existing session*. Arrows (or `j`/`k`) and Enter, a digit, or the pointer.

Only sessions that are on this computer count towards that (see [What is shared between
computers](#what-is-shared-between-computers-and-what-is-not)).

### A place with no session, in a project that has some

Work on an epic often starts in a plain terminal, on another kehikko, or before the parts were picked
this way — and every combination of parts is a place of its own, so narrowing from the whole epic to
one part used to start an empty conversation beside the one the person was just having. So a place
with no session asks first, when Claude Code holds other sessions for the project's folder:

> No session here yet. Start a new one, or carry on with one this project already has.

- **New session** is the first row and where the keyboard starts: Enter, and a person who always wants
  a new one has pressed one key.
- Under it, laid out and not folded away, **every** session of the project — there is no number at
  which the list stops — most likely wanted first: the ones another place of the *same epic* already
  holds (other parts, another kehikko; marked *this epic*, with those places as the `title`), then the
  rest by when each was last active. Each with its first prompt and when it was last active.
- A row says when its session is running: on this module with what it is doing, *running in the
  background*, or *open elsewhere* (next section). One the record lists and this computer does not
  have is last, muted and unopenable, as everywhere.
- **Choosing one makes it this place's session** and takes it from nowhere: a session may belong to
  several places.
- **Asked once per place.** A place that has a session opens it directly from then on.
- **Nothing is started before the answer.** No empty session exists to be dealt with afterwards, and
  walking on to another place leaves nothing behind.
- The list is drawn where the terminal would be, which is empty at that moment. It adds no row and no
  banner to anything.

When the project has no other session there is nothing to choose from, and a new one starts as before.

### A session that is already running somewhere else

A session this module started is found among its own and gets a second viewer. One it did **not**
start — a Claude Code background session, one left open in another terminal or in an editor — used to
be `claude --resume`d regardless: a second process on the same conversation, with Remote Control left
behind on the first, both appending to one history and neither seeing the other's turns, and not a
word about it.

Now Claude Code is asked what is running **before every resume** (`claude agents --json`), and the
answer is never kept: a session can start or stop between two opens.

| Claude Code says the session is… | what opening it here does |
|---|---|
| not running | `claude --resume <id>`, exactly as before |
| running in the **background** | `claude attach <handle>` in this module's terminal: a view of the process that is already there. No second process, and Remote Control stays where it is. The corner says *background* |
| open in **another process** with a terminal of its own | nothing is started. The place says where and since when, and puts two answers in words |
| *(cannot be asked)* | `claude --resume <id>` as before — and it is said |

**The question**, drawn where the terminal would be:

> “tighten the methods” is already open in another Claude Code process on this computer: an
> interactive session, in a terminal or an editor, process 82070, in /Users/…/thesis, started 17 min
> ago. It cannot be shown here — only a background session can be attached to — and nothing has been
> started.
>
> 1 **Leave it** — Nothing is started here, and the other process is not touched.
> 2 **Open a copy anyway** — A second process on the same conversation. Remote Control stays with the
> other one until /remote-control is run here, and the two do not see each other's turns.

*Leave it* is first and where Enter lands: a question somebody did not expect should start nothing. It
goes to the list. What a copy means is beside the word **before** it is chosen, and stays in the
corner control afterwards (*copy*, with the sentence as its `title`). Coming back to the place asks
Claude Code again.

**Nothing here stops, signals or takes over a process this module did not start** — it may be
mid-task. A view of a background session is this module's to close (*Close* on its row; also what
happens when it is put away for being quiet, and when this server stops) and the session runs on: the
strip then says *this view closed; the session is still running in the background*, and **Resume**
attaches again.

**A Claude Code too old for `agents --json` or `attach`** is told apart from "nothing is running".
Such a copy resumes a session as it always did, and says so on the terminal's first line —

> This Claude Code is too old to say whether a conversation is already running somewhere else (it has
> no `agents --json` or no `attach`), so this one was resumed without checking. Update Claude Code to
> have that checked.

— and in the corner (*unchecked*). The same when a copy that has the commands could not be asked.

Measured on the real 2.1.296, with a scratch config folder and a stand-in for the model API:

- `claude agents --json` prints a JSON array, `[]` when nothing runs, in a tenth of a second and
  without a terminal. Every folder's sessions are in it. An interactive one is `{ pid, cwd, kind:
  "interactive", startedAt, sessionId, name, status }`; a background one has `kind: "background"`,
  its short `id` and a `state` as well, and may lack `pid`, `name` and `status` just after it starts.
  A stopped background session is not listed (`--all` would add it, and is not passed).
- `claude attach` takes the short `id`. Given the full session id it answers `No job matching '…'`
  and exits 1; given the id of an interactive session, the same. So an interactive session cannot be
  attached to, and the handle passed is the one Claude Code itself printed.
- While attached, one process holds the conversation: the `attach` client is not in the list. Hanging
  the client up (which is all this module ever does to it) left the session's own process running.
  Ctrl+Z in an attached session ends the client with exit 0; `←` at an empty prompt shows Claude
  Code's own agents view, as it does in any terminal.
- `claude --bg --resume <id>` of a running session starts a copy and says so (`note: session … is
  open in another Claude Code process, so this started a copy as …`). This module never runs it: it
  would start something in the background, which nobody asked a terminal on a canvas to do.
- **Read by this server directly, the program's answers arrive cut short**: `claude --help` came as
  its first 8190 bytes of 22116 — the program exits without waiting for a socket to drain, and Node
  hands a child a socket. The "Commands:" section is last in the help, and thirty running sessions
  are longer than that. So both are read through a real pipe (`answered` in `program.ts`), whole.

Nothing is remembered as a default. One narrower thing is: which session *this page* was showing for a
place, for as long as its tab lives — so a page that reloads (the plumbing does that by itself when its
server restarts) comes back to what was on screen. A page opened afresh asks.

With no project open there is one sentence and no session. Terminal falls back to a home shell there;
a Claude session in no folder is not what was asked for.

### What is on screen

The terminal, and nothing that costs a row while a session is running. The session's short label and
the way to the list sit in the terminal's own top-right corner, over it. A strip appears along the
bottom only when nothing is running to take the space from: the session ended (**Resume**,
**Sessions**), the install did not finish, or this module's server has gone.

What a session is doing is one glyph, with the word as its `title`: before the label in the corner
control for the session on screen, and on each running row of the list, where the word "running" was.
`●` working, `◆` needs you, `○` finished — three shapes, so it does not rest on colour. A session that
has not said what it is doing has no mark. It adds no row, no line and no height (measured in WebKit:
the terminal the same 40 rows and the corner control the same 21 px tall, with and without it).

A host that draws headers (protocol 1.1.0) also offers the place's sessions in the container's own
**Go** menu — each with its mark, then *New session* and *All sessions…* — in the header row the host
already draws. The corner control stays as well: a page cannot tell whether its host draws headers.

From the list a session can be opened, a running one **End**ed, and one taken off the place (`×`): the
session and its transcript are kept, and it goes back among the ones that can be attached.

### A session outlives the page

In Terminal a shell lives exactly as long as its socket. Here a session belongs to this module's
**server**: a page reload, a place switched away from, or a view let go leaves it running, and the
viewer that comes back is sent the screen as it stands, from a second, headless emulator the server
feeds (`@xterm/headless`). Ending an agent mid-work because a page reloaded would be costly, and it
does not happen.

When the server itself stops, its sessions stop with it — nothing is left running with no owner — and
the next open of each place **resumes** its session by id.

### No limit, and nothing to tidy

A place has its session, and going to the place opens it — every time, however many others are
running. No open is ever refused for what else is running, and the page never asks anybody to end
something. (There used to be a bound of six, at which every open was refused and a list was shown to
end one from. Nobody had asked for it, and it locked a person out of their own work.)

What keeps the number of processes down happens by itself, and neither thing loses anything:

- **What was never a session is ended a moment after nobody is looking:** a new one that nobody has
  typed a character into and that Claude Code has recorded nothing for, twenty seconds after its last
  viewer left. A place is opened by looking at it, and without this a walk through the parts of an
  epic would leave a process at every stop. For the same reason a *new* session waits 0.6 s for the
  canvas to stop moving before it starts; an existing one is opened at once.
- **A finished session nobody is looking at has its process put away:** one that is on no screen, whose
  turn is over, and that has been left alone for thirty minutes since (`KEHIKOT_CLAUDE_QUIET_MS` moves
  it) — counted from the turn ending, the last thing a person typed into it, or the last person looking
  away, whichever is latest. The session is not ended — it is Claude Code's record, and the next visit
  to the place resumes it by id, with no question and no message. One line in this server's log says
  when it happens.

  **Never one that is working, and never one that is waiting for an answer** — not after an hour and
  not after a day. And never one that is on screen.

  What does not come back with a resumed session is what lived only in the process: a line typed at
  the prompt and not sent, and anything the agent had left running in the background after its turn
  ended.

  A session that has not said what it is doing — a copy of Claude Code too old to, or one whose
  reports do not arrive — falls under the rule there was before: thirty minutes in which the program
  prints nothing at all. That rule cannot tell a question on screen from a prompt, which is why it is
  only the fallback.

"Typed" means by a person. A program asks its terminal questions, and the emulator in the page
answers them on the channel the keyboard uses: Claude Code is told what kind of terminal it is in a
third of a second after it starts, hears of the page giving its terminal the keyboard, and — having
asked for the pointer — of the mouse crossing it. None of that is typing (`input.ts` is the list), and
all of it still reaches the program.

### Working, needs you, finished

Each running session is in one of three states, or in none:

| | means | Claude Code said |
|---|---|---|
| `working` | a turn is under way | `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `ElicitationResult` |
| `needs-you` | it has stopped at a question and will not go on until it is answered | `PermissionRequest`, `Elicitation`, `StopFailure` |
| `finished` | its turn is over and it is at its prompt | `Stop` |

**Told, not read.** Claude Code runs a command of the caller's choosing when those things happen — its
hooks. This module attaches them to the sessions it starts, and to nothing else, by adding one thing to
the command line: `--settings '<json>'`, which hands Claude Code *additional* settings for that one
process. Nothing is written into `~/.claude`, into the project, or anywhere: there is no file. The
person's own hooks still run (checked on 2.1.296 with one of each on `Stop`: both ran).

The command each hook runs is `/bin/sh '<this module>/tell.sh' <Event>`. `tell.sh` posts one request
to this module's own server on loopback — the event's name and the session's id, with a secret in a
header — and exits 0 whatever happens, within two seconds, printing nothing. It never reads what a
hook is handed (the prompt, a tool's input, the last answer).

- **The secret is per run**: minted when the pty is started and handed to it in the environment
  (`KEHIKOT_TELL_SECRET`, with `KEHIKOT_TELL_PORT` and `KEHIKOT_TELL_SESSION`) — never on a command
  line, never in a file. A report is believed only when it carries the secret of the session it names.
- **What a project could do with it.** Everything Claude Code starts inherits that environment, so
  the agent itself, and any hook a project ships, can read the secret. The most it is good for is
  misstating the state of the one session it came from: a dot, a rationed handful of notices
  about that session (four, then one every fifteen seconds), and its own process not being put away. It names no other session, opens no
  other door (it is not the page's ticket), and nothing a report carries is stored, shown or logged —
  only an event's name out of a fixed list is acted on. A project's settings can set variables for
  the program, so `tell.sh` takes no address from the environment, only a port number, and speaks to
  `127.0.0.1` and nowhere else, by `/usr/bin/curl` and through no proxy.
- **A copy too old for `--settings`** is started with the two words it always was, and its sessions
  have no state. Everything else works as before.

Measured against the real 2.1.296, with a stand-in for the model API so that it could hold a whole
conversation with nobody's account:

- **What can be told apart:** a question Claude Code itself puts up — a permission dialog, the
  question tool (which asks through the same dialog), an MCP server's form — from a turn that ended.
  Each is reported the moment it is on screen.
- **What cannot:** a question asked in prose. "Shall I go on?" as the last line of a turn is a turn
  that ended, and is `finished` like any other.
- **Nothing is reported when a question is answered**; the next report is the tool finishing, which
  may be twenty minutes later. So a person typing into a session that was waiting for them is taken
  as the answer, and it is `working` from then (a lone Esc is not: that dismisses the question).
- **Nothing is reported when a turn is interrupted** with Esc — no `Stop`, and no idle notification
  afterwards. A working session prints several times a second (2834 bytes in ten seconds mid-turn; the
  same unfocused, and while a tool runs), so one called `working` that has printed nothing for two
  minutes is called nothing again, and falls under the silence rule above.
- A turn with **background work still running** when it ends is `finished`, and is put away with the
  rest after thirty minutes on no screen.

### Being told when you are not looking

When a session that is on nobody's screen comes to need its person, or finishes, the host is handed
one line for whatever on the canvas shows such lines — the protocol's `kehikot.notifications@1`, level
`attention` or `done`:

> Waiting for you: “tighten the methods…” — thesis · Methods · writing

It says which of the two it is, the session by its first prompt, and the place in words: the epic,
the picked parts by their headings, the kehikko by its name. Once per change, never for a session
somebody has on screen, and nothing is drawn in this module about it. A change that happens while no
page of this module is framed is held and said when one is, if it is still true.

Pressing the line goes nowhere, and cannot from here: the format carries an epic and no place (no
parts, no kehikko), a line on another module's panel is not this module's to make pressable, and the
one way a module can ask a host to move (`view.goto`) moves to an epic and cannot pick parts or
switch kehikko. A line filed under the session's epic is the most that exists.

### What it never does

- It never sends a prompt. The person types.
- It never passes a flag that widens what Claude may do. A new session is `claude --session-id <uuid>`
  and a resumed one `claude --resume <uuid>`, in the project's folder — followed, for a copy that can
  take it, by `--settings` and the hooks above, which is the whole command. The settings hold hooks and
  nothing else: nothing about permissions, models or tools. The only other command lines there are:
  `claude --help`, once per binary; `claude agents --json`, which reads; and `claude attach <handle>`,
  with the handle Claude Code itself printed, checked to be one word that cannot be a flag.
- It never stops, deletes, restarts or backgrounds anything: no `stop`, `rm`, `respawn` or `--bg`.
- It never reads or shows a transcript beyond the first line of the first prompt, used as a label.
- It never reads the screen to decide anything, and never reads what a hook is handed.

## Where its data lives

`<project>/.kehikot/claude/places.json`, and nowhere else:

```json
{
  "version": 1,
  "places": {
    "epic=thesis;parts=methods+results;kehikko=key:4072c9e5": {
      "epic": "thesis",
      "parts": ["methods", "results"],
      "kehikko": { "key": "4072c9e5", "id": 3, "name": "writing" },
      "sessions": ["6f0c2a1e-…"]
    }
  },
  "sessions": {
    "6f0c2a1e-…": { "added": "2026-10-12T14:03:11.000Z", "label": "tighten the methods…", "lastActive": "2026-10-12T15:40:02.000Z" }
  }
}
```

- The **key** holds ids only — sorted part ids, the kehikko by its stable key — so renaming a part or a
  kehikko moves nothing. The names beside it are for reading the file and are never compared.
- A session is written here **once it exists**: when Claude Code has a record for it, which is when the
  person first says something. A session that was opened, shown a sign-in screen and closed was never a
  session, and leaves no row.
- When a **part or a kehikko is deleted**, its key can no longer be reached. Nothing is deleted: the
  entry stays in the file, and its sessions are listed under *Attach an existing session* for every
  other place in the project.
- **The kehikko is named by its `key`, not its number.** `context.kehikko` carries both
  (`{ id, name, key }`, protocol 1.1.0). The `key` is the one the host writes in the project's own
  `.kehikot/kehikko/kehikot.json`: the same after a rename, after the project is removed from the host
  and added again, and on another computer. The `id` is a row in one host's database — one kehikko was
  2, then 9, then 28 without anybody touching it — so it is written beside the key as a note
  (`"id": 3`, the number it last went by) and never compared or looked up.
- **In the key a kehikko's key is always spelled `kehikko=key:<key>`**, and a bare `kehikko=3` is a row
  number and nothing else. The two are told apart by which field they came from and never by how they
  look: a key may be all digits, and `kehikko=key:12345678` and `kehikko=12345678` are different places.
- **A host that sends no `key`** (one from before protocol 1.1.0) leaves this module the number, and the place is
  filed as `kehikko=3`, as it always was — and is exactly as fragile as it always was: when that host
  renumbers the kehikko, the place is unreachable and its sessions are attachable rather than opened
  by themselves.

### Files written before the key

A `places.json` from before this — every place filed under `kehikko=<number>` — still reads. The first
time a host names the kehikko you are standing on by key, the page asks the server, once, to bring
that kehikko's entries across (`POST /api/rekey`, before the place is read):

- an entry still filed under a number is moved when the kehikko **name** stored beside it equals the
  open kehikko's name. It becomes `kehikko=key:<key>`; its epic and parts do not change;
- **never by the number.** Numbers are handed out again, so `kehikko=3` in an old file says nothing
  about which kehikko is 3 today. The name is the only thing in an old entry that still means what it
  meant — which also brings back together a kehikko that renumbering had split across 2, 9 and 28;
- where the key already has an entry for that epic and those parts, the two session lists are merged
  as a set;
- if an entry filed under a key already carries that name, the name is taken — the migration has run,
  or another kehikko is called the same — and entries under numbers are left alone rather than guessed
  at. So it happens once per kehikko;
- an entry that matches nothing stays exactly as it is. It is not deleted, and its sessions are under
  *Attach an existing session* at every place. When nothing matches, the file is not written.

Reading never migrates: `GET /api/place` and the MCP tool return what the file says. A kehikko that
was renamed between the old file being written and the first open with a key is not matched; attach
its sessions by hand, or rename it back for one open.

### What is shared between computers, and what is not

| | where it is | travels with the project? |
|---|---|---|
| the epic, its parts, the kehikko and its `key` | the project (`.kehikot/…`), written by the host | yes, so a place is the same place everywhere |
| which session belongs to which place | `<project>/.kehikot/claude/places.json` | **not by default** — see below |
| the sessions themselves | Claude Code's folder on the computer where they ran (`~/.claude/projects/…`) | **no, never** |

A session is a transcript on one computer. Nothing here copies one, and Claude Code has no way to
resume a session another computer holds. So even with `places.json` shared, a second computer gets the
*names* of the first one's sessions and not the sessions.

**`places.json` is ignored by git by default.** The first time this module writes the record it puts a
`.gitignore` beside it, in its own `.kehikot/claude/` folder, naming `places.json` — the way the host
does for its tracker reading in `.kehikot/kehikko/`. The reasons: the list means little where the
sessions are not, and it holds the first line of what was asked in each session, which is not
something to publish into a repository's history without being asked. The `.gitignore` is written only
when there is none, so to share the record anyway, delete the rule lines and keep the file; this
module will not put them back. (A `places.json` that is *already* committed stays tracked — an ignore
rule does not untrack a file. `git rm --cached .kehikot/claude/places.json` does.) A project whose own
`.gitignore` covers `.kehikot/` was never sharing it.

**When the record does arrive somewhere its sessions are not** — shared on purpose, a folder synced
between computers, or simply this computer after Claude Code cleaned an old transcript away — a
recorded session that Claude Code has nothing for here is:

- **shown, not hidden**: in the list it is a muted row with its first prompt, *not on this computer*
  where "running" would be, and when it was last active. No extra row or notice says so. (Hiding it
  was the other choice. It was not taken because the list would then disagree with the file, and a
  person who remembers the conversation would have no way to learn why it is not offered.)
- **not openable**: the row does not open, by pointer, Enter or digit. It can be taken off the place
  (`×`), which is the person's choice and removes it from that place only.
- **not counted**: a place whose only recorded session is elsewhere opens a new one at once, as an
  empty place does, and one session here plus one elsewhere opens the one here without asking.
- **never started under its old id**: the server refuses to open an id Claude Code has no record of
  on this computer. `claude --session-id <that id>` would be a new, empty conversation wearing the old
  one's id, and would collide with the real one if the two computers' records ever met.
- **never deleted from the record**: the other computer still has it, and there it opens as before.

The words are *not on this computer* rather than *from another computer* because the module cannot
tell the two causes apart, and the second would be false for a transcript that was cleaned away here.
The MCP tool marks the same sessions `missing: true`.

Read, never written: Claude Code's own records for the folder,
`~/.claude/projects/<folder>/<session id>.jsonl` (or under `CLAUDE_CONFIG_DIR`, which Claude Code
itself honours) — the list of a project's sessions, their first prompt, and when each last grew.

## Its doors

| door | what it is |
|---|---|
| `GET /.well-known/kehikot-module.json` | the manifest |
| `GET /app` | the page, with the ticket and this process's build printed into it |
| `GET /healthz` | which module, which build |
| `WS /session` | the terminal. Origin and Host are checked on the upgrade; the ticket rides the first frame; nothing starts before it is read |
| `GET /api/place?projectPath&key` | what a place holds: its sessions, the project's others, what is running, whether the program is installed. **Ticketed**, since it says what somebody worked on |
| `POST /api/rekey` | bring the entries an older release filed under a kehikko's row number across to its key. Ticketed; the only thing that migrates |
| `POST /api/end` | end a running session, because a person chose that one. Ticketed |
| `POST /api/detach` | take a session off a place. Ticketed |
| `GET /api/feed` | server-sent events: each running session's state as it changes, the notices for a framed page to pass on, and the whole activity list (`activity`: on arrival and on every change) that the page hands the host as `activity.set` (protocol 1.5.0; `activity:report`). Sent only to a host whose greeting says it answers the method. Colours match the host's dots: needs you yellow, finished green, working grey. Ticketed (in the query: an `EventSource` sends no header) |
| `POST /api/state?event&session` | a session's own program saying what it is doing. Not the page's: it must carry that session's secret, reads no body, and answers 204 or one 403 that does not say why |
| `POST /mcp` | one tool, `sessions { projectPath, epic?, place? }`: the places of a project and their sessions, `missing: true` on one that is not on this computer, `state` and `since` on a running one that has said what it is doing, and `runningElsewhere` on one Claude Code runs in a process this module did not start. With `place: { epic, parts, kehikko }` it answers in words what opening the module there does — for a place with no session: *this place has no session yet*, and the project's sessions in the order they are offered (`readOnlyHint: true`). The door asks to be registered as `kehikko-claude` (`mcp.as`) |

An agent host that reads `mcp.as` (protocol 1.3.0) names the server `kehikko-claude`, so the tool is
`mcp__kehikko-claude__sessions`; the id alone would have derived `claude`.

There is no door that starts a session, types into one or installs anything, and no MCP tool that
does. A session is started by the socket's first frame, from this module's own page.

What the socket will start is narrower than Terminal's shell: this one program, in a folder that
exists, on a session id this module minted just now or Claude Code already holds for that folder on
this computer. No argument arrives over the wire. The fence is the same as Terminal's and has the same limit — it keeps other
pages out, and does not keep out a program already running as you.

## When Claude Code is not installed

One sentence saying so and where it was looked for — PATH, then `~/.local/bin`, `~/.claude/local`,
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`, `~/.bun/bin`, since the desktop app starts
modules with a thin PATH — and one press, **Install**.

The press runs the vendor's own installer **in the terminal here**, with the command on the first line
and everything it prints after it:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

That is the "Native Install (Recommended)" command for macOS, Linux and WSL from
<https://code.claude.com/docs/en/setup>, read 2026-10-12; it puts the launcher at `~/.local/bin/claude`,
the first place looked in after PATH. (Windows is another command on that page,
`irm https://claude.ai/install.ps1 | iex`; this module opens a pty and has only been run on macOS.)

When it exits the binary is looked for again. Found: the session for the place opens, without another
press. Not found, or a non-zero exit: the output stays on screen and one sentence says what to run by
hand. Signing in is Claude Code's own first screen, in the same terminal.

An installed copy whose `--help` has no `--session-id` or `--resume` is said to be too old, and the
press is **Update** — the same command, since the native installer installs the current release.

Nothing installs by itself: not at server start, not from the MCP door, not because a project asks. A
project can ship with a module, so an automatic install would be a way for a cloned project to run
things. The socket refuses the installer outright while a usable copy is installed.

## One adapter

Everything that is specific to Claude Code is `program.ts`, one value of one interface: where the
binary is, whether a copy is usable, the arguments that start and resume a session, whether a started
session exists yet and under which id, which sessions the program holds for a folder, how it is
installed, how it is made to say what it is doing and what each thing it says means, and what it is
already running elsewhere and how one of those is opened without starting another. A module for another agent is that file again plus a manifest.

## Layout

| file | what is in it |
|---|---|
| `place.ts` | the key of a place, and a kehikko as a key or a row number. Pure; shared by the page and the server |
| `record.ts` | `places.json`: read-modify-write with nothing awaited in between, the migration to keys, and the `.gitignore` beside it |
| `program.ts` | the adapter: everything that knows it is Claude Code |
| `input.ts` | which of what a page's emulator sends is a person typing, and which is the emulator answering the program. Pure; shared by the page and the server |
| `live.ts` | the running sessions and what each is doing, the headless emulators, the socket and its fence, the notices, and the two things ended without anybody choosing |
| `tell.sh` | what a session's program runs to say what it is doing: one request to this server, and nothing else |
| `doors.ts` | the HTTP doors and the MCP tool |
| `src/view/places.ts` | what the page does when the canvas names a place. Pure |
| `src/view/chooser.tsx` | the list |
| `src/view/elsewhere.tsx` | the question, when a session is open in another process |
| `src/view/terminal-view.tsx` | xterm, and a viewer's socket |
| `src/app.tsx` | the state, and what is drawn |

## Checks

```bash
bun test                    # the key, the record, the adapter against a stand-in claude, the runs and their states, the report, the list, the page
bun run typecheck
bunx kehikot-check-parts .
```

The tests give themselves a machine of their own (`test/setup.ts`): a scratch home, a scratch
`CLAUDE_CONFIG_DIR`, a scratch registry and a bare PATH, so none of them can read real sessions, find
a real binary or write a registration. `test/stand-in/claude` is a script that takes the flags,
echoes what is typed, keeps a record where Claude Code keeps one, runs the hooks it is given in the
order the real program was measured to (`/ask`, `/later`, `/work`, `/interrupt`, `/fail`), and says
what is running as the real one was measured to (`agents --json`, `--bg --resume`, `attach` by the
short id only; `STANDIN_NOAGENTS=1` is a copy from before those); `test/stand-in/install.sh` is the
installer's stand-in, named to a running server with `KEHIKOT_CLAUDE_INSTALL_LINE`. The pty itself is
not under `bun test` — `node-pty` does not run under bun — and is verified in a browser.

There is no build: the page is generated by `doors()`, and the server is Vite.
