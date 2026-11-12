import { builtinModules } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/*
 * The page is built for a browser: nothing it imports, however far down, may pull in a node built-in,
 * a bun module or the protocol's server-side `/serve` (1.47.0 imported `node:fs` and `/serve` through
 * manifest.ts → settings.ts → setup.ts and the page build failed). A static walk of the import graph
 * from the page's entry, through this module's own files.
 */
const ROOT = join(import.meta.dir, '..')
const ENTRY = join(ROOT, 'src/main.tsx')
const NODE = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])
const isServerOnly = (spec: string) =>
  spec.startsWith('node:') || spec.startsWith('bun:') || NODE.has(spec) || spec === 'kehikot-module-protocol/serve' || spec.startsWith('kehikot-module-protocol/serve/')
const transpiler = new Bun.Transpiler({ loader: 'tsx' })

function walk(entry: string): { files: string[]; offences: string[] } {
  const seen = new Set<string>()
  const offences: string[] = []
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (isServerOnly(path)) {
        offences.push(`${file.slice(ROOT.length + 1)} imports ${path}`)
        continue
      }
      let resolved: string
      try {
        resolved = Bun.resolveSync(path, dirname(file))
      } catch {
        continue
      }
      if (resolved.includes('/node_modules/') || !resolved.startsWith(ROOT)) continue
      if (/\.(tsx?|jsx?)$/.test(resolved)) queue.push(resolved)
    }
  }
  return { files: [...seen], offences }
}

describe("the page's imports", () => {
  test('reach no node built-in, bun module or protocol /serve', () => {
    const { files, offences } = walk(ENTRY)
    expect(files.length).toBeGreaterThan(10)
    expect(offences).toEqual([])
  })

  test('the walk reaches manifest.ts and settings.ts', () => {
    const { files } = walk(ENTRY)
    expect(files.some((file) => file.endsWith('/manifest.ts'))).toBe(true)
    expect(files.some((file) => file.endsWith('/settings.ts'))).toBe(true)
  })
})
