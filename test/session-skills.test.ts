import { afterAll, describe, expect, test } from 'bun:test'
import { WELL_KNOWN, skillPath } from 'kehikot-module-protocol'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, get, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionDoor } from '../doorConfig.ts'
import { removePlugin, sessionPlugin, skillDeclarations, skillText } from '../skills.ts'

const scratch: string[] = []
const dir = () => {
  const one = mkdtempSync(join(tmpdir(), 'kehikko-claude-skills-'))
  scratch.push(one)
  return one
}
const servers: Server[] = []
afterAll(() => {
  for (const one of servers) one.close()
  for (const one of scratch) rmSync(one, { recursive: true, force: true })
})

const text = (name: string, body = 'Do the thing.') => `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`

/** A stand-in module: a manifest declaring skills, and each one's text. */
function module(skills: Record<string, { text: string; version?: string; needs?: string[] }>) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname
    if (path === WELL_KNOWN) {
      response.setHeader('content-type', 'application/json')
      return void response.end(JSON.stringify({ declares: { skills: Object.entries(skills).map(([name, one]) => ({ name, summary: `${name}.`, version: one.version ?? '1', ...(one.needs ? { needs: one.needs } : {}) })) } }))
    }
    for (const [name, one] of Object.entries(skills)) if (path === skillPath(name)) return void response.end(one.text)
    response.statusCode = 404
    response.end('no')
  })
  server.listen(0, '127.0.0.1')
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/* The test document replaces `fetch` with one that applies a browser's origin rules; a module is asked from a server. */
const plain = ((url: string) =>
  new Promise((done, fail) => {
    get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => done({ status: response.statusCode, text: async () => body }))
    }).on('error', fail)
  })) as unknown as typeof fetch

const door = (module: string, origin: string): SessionDoor => ({ module, name: module.split('.').pop()!, url: `${origin}/mcp?kehikot-place=x`, transport: 'http' })
const names = (plugin: string) => readdirSync(join(plugin, 'skills')).sort()
const options = (extra: { log?: string[]; claudeDir?: string } = {}) => ({ base: dir(), claudeDir: extra.claudeDir ?? dir(), log: (line: string) => extra.log?.push(line), fetch: plain })

describe('the skills a session is given', () => {
  test('one folder, assembled from every module on the kehikko, and this module’s own', async () => {
    const one = module({ browse: { text: text('browse') }, 'read-page': { text: text('read-page') } })
    const two = module({ journey: { text: text('journey') } })
    const opts = options()
    const plugin = (await sessionPlugin([door('kehikot.browser', one), door('kehikot.journeys', two), door('kehikot.browser', one)], opts))!
    expect(plugin.startsWith(opts.base)).toBe(true)
    expect(names(plugin)).toEqual(['browse', 'journey', 'kehikot-here', 'read-page'])
    expect(readFileSync(join(plugin, 'skills', 'journey', 'SKILL.md'), 'utf8')).toBe(text('journey'))
    expect(readFileSync(join(plugin, 'skills', 'kehikot-here', 'SKILL.md'), 'utf8')).toBe(skillText('kehikot-here')!)
    expect(JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('kehikot')
    expect(statSync(plugin).mode & 0o777).toBe(0o700)
    expect(statSync(join(plugin, '..')).mode & 0o777).toBe(0o700)
    /* Another session, another folder. */
    expect(await sessionPlugin([], opts)).not.toBe(plugin)
  })

  test('a text the protocol refuses is left out with one line, the rest stay', async () => {
    const bad = module({ good: { text: text('good') }, nofront: { text: 'no front matter' }, wrong: { text: text('other') }, huge: { text: text('huge', 'x'.repeat(200_000)) } })
    const log: string[] = []
    const plugin = (await sessionPlugin([door('kehikot.bad', bad)], options({ log })))!
    expect(names(plugin)).toEqual(['good', 'kehikot-here'])
    expect(log.filter((line) => line.includes('refused'))).toHaveLength(3)
  })

  test('a module that is down is skipped with one line, and nothing waits on it', async () => {
    const up = module({ journey: { text: text('journey') } })
    const log: string[] = []
    const plugin = (await sessionPlugin([door('kehikot.gone', 'http://127.0.0.1:9'), door('kehikot.journeys', up)], options({ log })))!
    expect(names(plugin)).toEqual(['journey', 'kehikot-here'])
    expect(log.filter((line) => line.includes('kehikot.gone'))).toHaveLength(1)
  })

  test('a module that offers no skills, or is not a module, adds nothing and says nothing', async () => {
    const none = module({})
    const log: string[] = []
    const plugin = (await sessionPlugin([door('kehikot.plain', none)], options({ log })))!
    expect(names(plugin)).toEqual(['kehikot-here'])
    expect(log).toEqual([])
  })

  test('a skill the person installed through Kehikot at the same version is skipped; another version is replaced by the current one', async () => {
    const claudeDir = dir()
    const mark = (name: string, version: string) => {
      mkdirSync(join(claudeDir, 'skills', name), { recursive: true })
      writeFileSync(join(claudeDir, 'skills', name, '.kehikot-skill.json'), JSON.stringify({ version }))
    }
    mark('journey', '2')
    mark('browse', '1')
    mark('kehikot-here', skillDeclarations()[0]!.version)
    const up = module({ journey: { text: text('journey'), version: '2' }, browse: { text: text('browse', 'new'), version: '2' }, extra: { text: text('extra') } })
    const log: string[] = []
    const plugin = (await sessionPlugin([door('kehikot.m', up)], options({ log, claudeDir })))!
    expect(names(plugin)).toEqual(['browse', 'extra'])
    expect(readFileSync(join(plugin, 'skills', 'browse', 'SKILL.md'), 'utf8')).toContain('new')
    expect(log.filter((line) => line.includes('already installed'))).toHaveLength(2)
    /* Nothing was written to the person's folder. */
    expect(readdirSync(join(claudeDir, 'skills')).sort()).toEqual(['browse', 'journey', 'kehikot-here'])
  })

  test('a kehikko-bound skill is included only when every module it needs has a container on the kehikko', async () => {
    const factory = module({ factory: { text: text('factory') }, 'review-factory': { text: text('review-factory'), needs: ['kehikot.review'] } })
    const review = module({})
    /* Factory without Review: /factory, never /review-factory, and one line naming what is missing. */
    const log: string[] = []
    const alone = (await sessionPlugin([door('kehikot.factory', factory)], options({ log })))!
    expect(names(alone)).toEqual(['factory', 'kehikot-here'])
    expect(log).toEqual(['claude: skill review-factory from kehikot.factory left out — it needs kehikot.review on this kehikko'])
    /* Review and Factory on one kehikko: both. */
    const both = (await sessionPlugin([door('kehikot.factory', factory), door('kehikot.review', review)], options()))!
    expect(names(both)).toEqual(['factory', 'kehikot-here', 'review-factory'])
    expect(readFileSync(join(both, 'skills', 'review-factory', 'SKILL.md'), 'utf8')).toBe(text('review-factory'))
  })

  test('a skill that needs several modules is left out while any is missing', async () => {
    const m = module({ trio: { text: text('trio'), needs: ['kehikot.review', 'kehikot.browser'] } })
    const log: string[] = []
    const plugin = (await sessionPlugin([door('kehikot.factory', m), door('kehikot.browser', module({}))], options({ log })))!
    expect(names(plugin)).toEqual(['kehikot-here'])
    expect(log).toEqual(['claude: skill trio from kehikot.factory left out — it needs kehikot.review on this kehikko'])
  })

  test('with nothing to offer there is no folder; and removing one removes it', async () => {
    const claudeDir = dir()
    mkdirSync(join(claudeDir, 'skills', 'kehikot-here'), { recursive: true })
    writeFileSync(join(claudeDir, 'skills', 'kehikot-here', '.kehikot-skill.json'), JSON.stringify({ version: skillDeclarations()[0]!.version }))
    expect(await sessionPlugin([], options({ claudeDir }))).toBeNull()
    const plugin = (await sessionPlugin([], options()))!
    removePlugin(plugin)
    expect(existsSync(plugin)).toBe(false)
    removePlugin(null)
  })
})
