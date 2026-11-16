import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_EXCLUDED_SERVERS,
  discover,
  findCodex,
  pluginSkillsDir,
  selectServers,
  skillRoots,
  toServerEntry,
} from '../lib/codex.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'codex-share-'))
}

function write(path, content) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function fakeCodexHome() {
  const home = tempDir()
  write(join(home, 'skills', 'global-one', 'SKILL.md'), '---\nname: global-one\ndescription: global\n---\n\nBody.\n')
  write(join(home, 'plugins', 'cache', 'mkt', 'alpha', '1.0.0', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'alpha', skills: './my-skills/' }))
  write(join(home, 'plugins', 'cache', 'mkt', 'alpha', '1.0.0', 'my-skills', 'alpha-skill', 'SKILL.md'), '---\nname: alpha-skill\ndescription: alpha\n---\n\nAlpha.\n')
  write(join(home, 'plugins', 'cache', 'mkt', 'beta', '2.0.0', 'skills', 'beta-skill', 'SKILL.md'), '---\nname: beta-skill\ndescription: beta\n---\n\nBeta.\n')
  return home
}

test('skillRoots follows the global root, then marketplaces in order, then the snapshot', () => {
  const codexHome = fakeCodexHome()
  const dshHome = tempDir()
  write(join(dshHome, 'codex-share', 'skills', 'snapshot-skill', 'SKILL.md'), '---\nname: snapshot-skill\ndescription: snapshot\n---\n')

  const plugins = [
    { marketplaceName: 'mkt', name: 'beta', version: '2.0.0', enabled: true },
    { marketplaceName: 'mkt', name: 'alpha', version: '1.0.0', enabled: true },
  ]
  const roots = skillRoots(plugins, { codexHome, dshHome })

  assert.deepEqual(roots, [
    join(codexHome, 'skills'),
    join(codexHome, 'plugins', 'cache', 'mkt', 'alpha', '1.0.0', 'my-skills'),
    join(codexHome, 'plugins', 'cache', 'mkt', 'beta', '2.0.0', 'skills'),
    join(dshHome, 'codex-share', 'skills'),
  ])
})

test('skillRoots skips disabled plugins and resolves manifests without a skills field', () => {
  const codexHome = fakeCodexHome()
  const dshHome = tempDir()
  const plugins = [
    { marketplaceName: 'mkt', name: 'alpha', version: '1.0.0', enabled: false },
    { marketplaceName: 'mkt', name: 'beta', version: '2.0.0', enabled: true },
  ]
  assert.deepEqual(skillRoots(plugins, { codexHome, dshHome }), [
    join(codexHome, 'skills'),
    join(codexHome, 'plugins', 'cache', 'mkt', 'beta', '2.0.0', 'skills'),
  ])
})

test('pluginSkillsDir resolves a git plugin from the versioned cache', () => {
  const codexHome = fakeCodexHome()
  const entry = { marketplaceName: 'mkt', name: 'beta', version: '2.0.0', source: { source: 'git', url: 'https://example.com/beta.git' } }
  assert.equal(pluginSkillsDir(entry, codexHome), join(codexHome, 'plugins', 'cache', 'mkt', 'beta', '2.0.0', 'skills'))
})

test('toServerEntry copies declared environment variables and drops a relative cwd', () => {
  const entry = toServerEntry({
    type: 'stdio',
    command: 'uvx',
    args: ['server', 42],
    cwd: '.',
    env: { FIXED: 'yes' },
    env_vars: ['FROM_PARENT', 'MISSING'],
  }, { FROM_PARENT: 'parent-value' })

  assert.deepEqual(entry, {
    transport: 'stdio',
    command: 'uvx',
    args: ['server'],
    env: { FIXED: 'yes', FROM_PARENT: 'parent-value' },
  })
})

test('toServerEntry keeps an absolute cwd and converts timeouts', () => {
  const entry = toServerEntry({
    type: 'stdio',
    command: 'node',
    cwd: '/tmp/work',
    startup_timeout_sec: 30,
    tool_timeout_sec: 1800,
  }, {})
  assert.equal(entry.cwd, '/tmp/work')
  assert.equal(entry.startupTimeoutMs, 30000)
  assert.equal(entry.toolCallTimeoutMs, 1800000)
})

test('toServerEntry turns Codex header secrets into credential templates', () => {
  const bearer = toServerEntry({
    type: 'streamable_http',
    url: 'https://api.example.com/mcp',
    bearer_token_env_var: 'EXAMPLE_API_KEY',
  }, {})
  assert.deepEqual(bearer, {
    transport: 'streamable-http',
    url: 'https://api.example.com/mcp',
    headers: { Authorization: 'Bearer ${credential:EXAMPLE_API_KEY}' },
    expandTemplates: true,
  })

  const header = toServerEntry({
    type: 'streamable_http',
    url: 'https://mcp.example.com/mcp',
    env_http_headers: { 'x-api-key': 'OTHER_KEY' },
    http_headers: { 'x-static': 'plain' },
  }, {})
  assert.deepEqual(header.headers, { 'x-static': 'plain', 'x-api-key': '${credential:OTHER_KEY}' })
  assert.equal(header.expandTemplates, true)
})

test('toServerEntry resolves a relative launcher against an absolute cwd', () => {
  const entry = toServerEntry({
    type: 'stdio',
    command: './mcp/launch',
    args: ['./mcp/server.py'],
    cwd: '/plugins/tavotto/0.21.2/.',
    env_vars: ['HOME'],
  }, { HOME: '/home/me' })

  assert.equal(entry.command, '/plugins/tavotto/0.21.2/mcp/launch')
  assert.equal(entry.cwd, '/plugins/tavotto/0.21.2')
  assert.deepEqual(entry.args, ['./mcp/server.py'])
  assert.deepEqual(entry.env, { HOME: '/home/me' })

  assert.equal(toServerEntry({ type: 'stdio', command: './mcp/launch', cwd: '.' }), undefined)
  assert.equal(toServerEntry({ type: 'stdio', command: 'uvx' }).command, 'uvx')
})

test('toServerEntry rejects transports and payloads it cannot map', () => {
  assert.equal(toServerEntry({ type: 'stdio' }), undefined)
  assert.equal(toServerEntry({ type: 'streamable_http' }), undefined)
  assert.equal(toServerEntry({ type: 'websocket', url: 'wss://example.com' }), undefined)
})

test('selectServers drops Codex-only and disabled servers, and honours an allow list', () => {
  const servers = [
    { name: 'anysearch', enabled: true, transport: { type: 'streamable_http', url: 'https://api.anysearch.com/mcp' } },
    { name: 'node_repl', enabled: true, transport: { type: 'stdio', command: 'node' } },
    { name: 'computer-use', enabled: false, transport: { type: 'stdio', command: './app' } },
    { name: 'my-server', enabled: true, transport: { type: 'stdio', command: 'my-server' } },
  ]

  const byDefault = selectServers(servers, { env: {} })
  assert.deepEqual(byDefault.servers.map(server => server.name), ['anysearch', 'my-server'])
  assert.deepEqual(byDefault.skipped.map(entry => entry.name), ['node_repl', 'computer-use'])
  assert.ok(DEFAULT_EXCLUDED_SERVERS.includes('itasca-mcp'))

  const allowList = selectServers(servers, { includeServers: ['my-server'] })
  assert.deepEqual(allowList.servers.map(server => server.name), ['my-server'])
})

test('discover reads the Codex CLI once and reports what it found', () => {
  const codexHome = fakeCodexHome()
  const calls = []
  const run = (bin, args) => {
    calls.push([bin, ...args].join(' '))
    if (args[1] === 'list' && args[0] === 'plugin') {
      return {
        ok: true,
        data: {
          installed: [
            { marketplaceName: 'mkt', name: 'alpha', version: '1.0.0', enabled: true },
          ],
        },
      }
    }
    return {
      ok: true,
      data: [
        { name: 'anysearch', enabled: true, transport: { type: 'streamable_http', url: 'https://api.anysearch.com/mcp' } },
        { name: 'itasca-mcp', enabled: true, transport: { type: 'stdio', command: 'uvx' } },
      ],
    }
  }

  const share = discover({ codexHome, dshHome: tempDir(), codexBin: 'codex' }, { env: {}, run })
  assert.deepEqual(calls, ['codex plugin list --json', 'codex mcp list --json'])
  assert.deepEqual(share.skillDirs, [
    join(codexHome, 'skills'),
    join(codexHome, 'plugins', 'cache', 'mkt', 'alpha', '1.0.0', 'my-skills'),
  ])
  assert.deepEqual(share.servers.map(server => server.name), ['anysearch'])
  assert.deepEqual(share.warnings, [])
})

test('discover falls back to the cache when the Codex CLI is unavailable', () => {
  const codexHome = fakeCodexHome()
  write(join(codexHome, 'plugins', 'cache', 'mkt', 'alpha', '1.0.0', 'codex.mcp.json'), JSON.stringify({
    mcpServers: { 'from-manifest': { type: 'stdio', command: 'run-me' } },
  }))

  const share = discover({ codexHome, dshHome: tempDir() }, { env: {}, findCodex: () => undefined })
  assert.equal(share.bin, undefined)
  assert.ok(share.warnings.some(warning => warning.includes('Codex CLI not found')))
  assert.ok(share.skillDirs.some(directory => directory.includes(join('plugins', 'cache', 'mkt', 'alpha'))))
  assert.deepEqual(share.servers.map(server => server.name), ['from-manifest'])
})

test('findCodex honours CODEX_BIN, PATH and the usual install locations', () => {
  const directory = tempDir()
  const executable = join(directory, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  write(executable, '#!/bin/sh\n')
  const home = tempDir()

  assert.equal(findCodex({ PATH: directory }, process.platform, home), executable)
  assert.equal(findCodex({ CODEX_BIN: '/custom/codex', PATH: directory }, process.platform, home), '/custom/codex')

  const installed = join(home, '.local', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
  write(installed, '#!/bin/sh\n')
  assert.equal(findCodex({ PATH: '' }, process.platform, home), installed)
})