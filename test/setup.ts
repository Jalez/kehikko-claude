import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GlobalRegistrator } from '@happy-dom/global-registrator'

/**
 * A document, for the tests that render one — and a machine of their own.
 *
 * Everything this module reads outside a project is pointed at a scratch
 * folder HERE, before any test file is imported, so that no test can read
 * somebody's real Claude Code sessions, find their real binary, or write a
 * registration into their real host: the home folder, Claude Code's config
 * folder, the module registry and PATH are all the test's own. A test that
 * wants a `claude` puts the stand-in (`test/stand-in/claude`) on its PATH.
 */
export const SCRATCH = mkdtempSync(join(tmpdir(), 'kehikko-claude-test-'))
export const HOME = join(SCRATCH, 'home')
export const CONFIG = join(SCRATCH, 'claude-config')
mkdirSync(HOME, { recursive: true })
mkdirSync(CONFIG, { recursive: true })
process.env.HOME = HOME
process.env.CLAUDE_CONFIG_DIR = CONFIG
process.env.KEHIKOT_MODULES_DIR = join(SCRATCH, 'modules')
process.env.PATH = '/usr/bin:/bin'
delete process.env.KEHIKOT_CLAUDE_INSTALL_LINE
delete process.env.KEHIKOT_CLAUDE_QUIET_MS

GlobalRegistrator.register()
