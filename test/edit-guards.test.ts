import { describe, expect, test } from 'bun:test'
import { placedGuardsSchema } from 'kehikot-module-protocol'

import { GUARD_MATCHER, guardAnswer, type EditFiles } from '../context.ts'

/**
 * Edit guards (protocol 2.78.0): a module on the kehikko refuses Claude Code's file edits in a main
 * checkout or under paths it names; the same hook as the Bash guards, matched on the edit tools too.
 */

const guards = placedGuardsSchema.parse([
  {
    module: 'kehikot.worktrees',
    name: 'Worktrees',
    guard: { id: 'main-checkout', tool: 'edit', match: { checkouts: ['main'], paths: ['~/Library/Application Support/Kehikot/installed/**'] }, action: 'deny', why: 'Work in a worktree: git worktree add ../<repo>-worktrees/<branch> -b <branch> origin/main' },
  },
])

const files: EditFiles = { home: '/Users/p', checkoutOf: (path) => (path.startsWith('/Users/p/Projects/app/') ? 'main' : path.startsWith('/Users/p/Projects/app-worktrees/') ? 'linked' : null) }

describe('edit guards', () => {
  test('the hook is matched on Bash and every edit tool', () => {
    expect(GUARD_MATCHER).toBe('Bash|Edit|Write|MultiEdit|NotebookEdit')
  })

  test('an edit in a main checkout is refused with the module’s words', () => {
    for (const tool_name of ['Edit', 'Write', 'MultiEdit']) {
      const answer = guardAnswer({ tool_name, tool_input: { file_path: '/Users/p/Projects/app/src/a.ts' } }, guards, false, files)
      expect(answer?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' })
      expect(JSON.stringify(answer)).toContain('git worktree add')
    }
    const notebook = guardAnswer({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/Users/p/Projects/app/n.ipynb' } }, guards, false, files)
    expect(notebook?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' })
  })

  test('a relative path is read against the session’s folder', () => {
    const answer = guardAnswer({ tool_name: 'Edit', cwd: '/Users/p/Projects/app', tool_input: { file_path: 'src/a.ts' } }, guards, false, files)
    expect(answer?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' })
  })

  test('an installed module’s folder is refused, a worktree and elsewhere pass', () => {
    expect(guardAnswer({ tool_name: 'Write', tool_input: { file_path: '/Users/p/Library/Application Support/Kehikot/installed/kehikot.queue/x.ts' } }, guards, false, files)).not.toBeNull()
    expect(guardAnswer({ tool_name: 'Edit', tool_input: { file_path: '/Users/p/Projects/app-worktrees/x/src/a.ts' } }, guards, false, files)).toBeNull()
    expect(guardAnswer({ tool_name: 'Write', tool_input: { file_path: '/tmp/note.md' } }, guards, false, files)).toBeNull()
  })

  test('KEHIKOT_DIRECT in the session passes, and no edit guard means nothing is asked', () => {
    expect(guardAnswer({ tool_name: 'Edit', tool_input: { file_path: '/Users/p/Projects/app/a.ts' } }, guards, true, files)).toBeNull()
    expect(guardAnswer({ tool_name: 'Edit', tool_input: { file_path: '/Users/p/Projects/app/a.ts' } }, [], false, { home: null, checkoutOf: () => { throw new Error('not asked') } })).toBeNull()
  })

  test('an edit guard never touches a Bash command', () => {
    expect(guardAnswer({ tool_name: 'Bash', tool_input: { command: 'echo x > /Users/p/Projects/app/a.ts' } }, guards, false, files)).toBeNull()
  })
})
