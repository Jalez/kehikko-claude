import { AGENT_SETUP_KEYS, agentSetupSettings, type SettingField } from 'kehikot-module-protocol'

/*
 * The agent-setup settings, apart from `setup.ts` on purpose: `settings.ts` is imported by `manifest.ts`,
 * which the PAGE imports, so this file may reach only browser-safe code. `setup.ts` holds the file and
 * the host call and imports node built-ins and the protocol's `/serve`.
 */
export const SETUP_FIELDS: SettingField[] = agentSetupSettings('Claude Code')
export const SETUP_KEYS = Object.values(AGENT_SETUP_KEYS) as string[]
