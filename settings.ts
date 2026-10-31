import { ACT_ON_MESSAGES_SETTING, KEHIKOT_DIR, WAKE_ON_MESSAGES_SETTING, settingsDeclarationSchema, type SettingField } from 'kehikot-module-protocol'

/**
 * Claude's settings as a host shows them (protocol 2.15.0, `declares.settings`): the same
 * `.kehikot/claude/settings.json` the page's toggles write, in the same format. Resuming a
 * conversation a restart cut off starts Claude Code on the person's account, unasked, so it is the
 * person's (`personOnly`): an agent is refused. So is the status line a session started here is
 * given: it is the person's terminal. Pure; the door is in `doors.ts`.
 *
 * "Other folders sessions may work in" (`folders`, folders.ts) is the one that reaches past the
 * project: each folder becomes one more `--add-dir`, so a session reads there as it reads in its
 * project, without asking file by file. The person's own list, each folder checked (`folderIssue`).
 * Edits and commands there ask as the person's permission mode says.
 *
 * "Messages wake an idle session" and "Act on messages from other sessions" (protocol 2.43.0) are
 * the protocol's own declarations, the same in every agent module: the waker (`wakeSessions`,
 * `wake` in live.ts) and the words a session is told about messages (context.ts, doors.ts).
 */

export const SETTINGS_FILE = `${KEHIKOT_DIR}/claude/settings.json`

export const SETTINGS: SettingField[] = settingsDeclarationSchema.parse([
  {
    key: 'resumeCutOff',
    label: 'Resume conversations cut off by a restart',
    description: 'A conversation a restart stopped mid-turn is started again where it was, and told what happened. Off: it waits for you.',
    type: 'boolean',
    default: true,
    personOnly: true,
  },
  {
    key: 'statusLine',
    label: 'Status line in sessions',
    description: 'Sessions started here show context and your weekly usage on Claude Code’s status line when you have no status line of your own, and the footer’s usage meter works. Off: only a status line of yours is shown.',
    type: 'boolean',
    default: true,
    personOnly: true,
  },
  {
    key: 'folders',
    label: 'Other folders sessions may work in',
    description:
      'Folders outside this project that sessions here may read without asking file by file, one absolute path a line. Edits and commands there still ask as your permission mode says. Applies when a session starts or restarts.',
    type: 'list',
    default: [],
    personOnly: true,
  },
  WAKE_ON_MESSAGES_SETTING,
  ACT_ON_MESSAGES_SETTING,
])
