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

- **no session there** — a new Claude Code session starts in the project's folder;
- **exactly one** — it is resumed at once;
- **more than one** — a short list, in the terminal's own space, before anything is opened: each
  session's first prompt, when it was last active and whether it is running, plus *New session* and
  *Attach an existing session*. Arrows (or `j`/`k`) and Enter, a digit, or the pointer.

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

- **At most 6 sessions run at once**, across every project (`KEHIKOT_CLAUDE_MOST_RUNNING` moves it).
  At the bound nothing is ended to make room: the open is refused, the page lists what is running, and
  you end the one you choose.
- **One thing is ended without being chosen, and it is not a session:** a new one that nobody has typed
  a character into, that Claude Code has recorded nothing for, and that nobody is looking at, twenty
  seconds after its last viewer left. A place is opened by looking at it, and without this a walk
  through the parts of an epic would leave a process at every stop. For the same reason a *new* session
  waits 0.6 s for the canvas to stop moving before it starts; an existing one is opened at once.

### What it never does

- It never sends a prompt. The person types.
- It never passes a flag that widens what Claude may do. A new session is `claude --session-id <uuid>`
  and a resumed one `claude --resume <uuid>`, in the project's folder, and that is the whole command.
- It never reads or shows a transcript beyond the first line of the first prompt, used as a label.

## Where its data lives

`<project>/.kehikot/claude/places.json`, and nowhere else:

```json
{
  "version": 1,
  "places": {
    "epic=thesis;parts=methods+results;kehikko=3": {
      "epic": "thesis",
      "parts": ["methods", "results"],
      "kehikko": { "id": 3, "name": "writing" },
      "sessions": ["6f0c2a1e-…"]
    }
  },
  "sessions": {
    "6f0c2a1e-…": { "added": "2026-10-12T14:03:11.000Z", "label": "tighten the methods…", "lastActive": "2026-10-12T15:40:02.000Z" }
  }
}
```

- The **key** holds ids only — sorted part ids, the kehikko by its id — so renaming a part or a kehikko
  moves nothing. The names beside it are for reading the file and are never compared.
- A session is written here **once it exists**: when Claude Code has a record for it, which is when the
  person first says something. A session that was opened, shown a sign-in screen and closed was never a
  session, and leaves no row.
- When a **part or a kehikko is deleted**, its key can no longer be reached. Nothing is deleted: the
  entry stays in the file, and its sessions are listed under *Attach an existing session* for every
  other place in the project.
- **The kehikko's id is the host's own number for it**, which is all `context.kehikko` carries
  (`{ id, name }`). The host renumbers a project's kehikot when the project is forgotten and added
  again, and numbers them afresh on another machine; after either, the old places are unreachable and
  their sessions are attachable rather than opened by themselves. The host does keep a stable `key` per
  kehikko in `.kehikot/kehikko/kehikot.json`; a protocol that carried it would close this.

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
| `POST /api/end` | end a running session, because a person chose that one. Ticketed |
| `POST /api/detach` | take a session off a place. Ticketed |
| `POST /mcp` | one tool, `sessions { projectPath, epic? }`: the places of a project and their sessions (`readOnlyHint: true`) |

There is no door that starts a session, types into one or installs anything, and no MCP tool that
does. A session is started by the socket's first frame, from this module's own page.

What the socket will start is narrower than Terminal's shell: this one program, in a folder that
exists, on a session id this module minted or Claude Code already holds for that folder. No argument
arrives over the wire. The fence is the same as Terminal's and has the same limit — it keeps other
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
session exists yet and under which id, which sessions the program holds for a folder, and how it is
installed. A module for another agent is that file again plus a manifest.

## Layout

| file | what is in it |
|---|---|
| `place.ts` | the key of a place. Pure; shared by the page and the server |
| `record.ts` | `places.json`: read-modify-write with nothing awaited in between |
| `program.ts` | the adapter: everything that knows it is Claude Code |
| `live.ts` | the running sessions, the headless emulators, the socket and its fence |
| `doors.ts` | the HTTP doors and the MCP tool |
| `src/view/places.ts` | what the page does when the canvas names a place. Pure |
| `src/view/chooser.tsx` | the list |
| `src/view/terminal-view.tsx` | xterm, and a viewer's socket |
| `src/app.tsx` | the state, and what is drawn |

## Checks

```bash
bun test                    # the key, the record, the adapter against a stand-in claude, the runs, the list, the page
bun run typecheck
bunx kehikot-check-parts .
```

The tests give themselves a machine of their own (`test/setup.ts`): a scratch home, a scratch
`CLAUDE_CONFIG_DIR`, a scratch registry and a bare PATH, so none of them can read real sessions, find
a real binary or write a registration. `test/stand-in/claude` is a script that takes the two flags,
echoes what is typed and keeps a record where Claude Code keeps one; `test/stand-in/install.sh` is the
installer's stand-in, named to a running server with `KEHIKOT_CLAUDE_INSTALL_LINE`. The pty itself is
not under `bun test` — `node-pty` does not run under bun — and is verified in a browser.

There is no build: the page is generated by `doors()`, and the server is Vite.
