import { KEHIKOT_DIR, settingsDeclarationSchema, type SettingField } from 'kehikot-module-protocol'

/**
 * Claude's settings as a host shows them (protocol 2.15.0, `declares.settings`): the same
 * `.kehikot/claude/settings.json` the page's toggles write, in the same format. Resuming a
 * conversation a restart cut off starts Claude Code on the person's account, unasked, so it is the
 * person's (`personOnly`): an agent is refused. So is the status line a session started here is
 * given: it is the person's terminal. Pure; the door is in `doors.ts`.
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
])
