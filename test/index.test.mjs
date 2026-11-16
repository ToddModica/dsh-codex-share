import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'codex-share-apply-'))
}

function write(path, content) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

// The plugin drives a real `codex` binary; a shell shim keeps the test honest
// without touching the developer's Codex profile. Windows has no equivalent
// shim, so the integration path is exercised on POSIX only.
const enabled = process.platform !== 'win32'

function fakeCodexHome() {
  const home = tempDir()
  write(join(home, 'skills', 'from-codex', 'SKILL.md'),
    '---\nname: from-codex\ndescription: Installed through Codex.\n---\n\nUse it.\n')
  write(join(home, 'plugins', 'cache', 'mkt', 'plug', '1.0.0', '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'plug', skills: './skills/' }))
  write(join(home, 'plugins', 'cache', 'mkt', 'plug', '1.0.0', 'skills', 'plugin-skill', 'SKILL.md'),
    '---\nname: plugin-skill\ndescription: Comes with a plugin.\n---\n\nPlugin body.\n')
  write(join(home, 'events.json'), '')
  return home
}

function fakeCodexBin(home) {
  const bin = join(home, 'fake-codex')
  write(join(home, 'plugin-list.json'), JSON.stringify({
    installed: [{ marketplaceName: 'mkt', name: 'plug', version: '1.0.0', enabled: true }],
  }))
  write(join(home, 'mcp-list.json'), JSON.stringify([
    {
      name: 'shared-http',
      enabled: true,
      transport: {
        type: 'streamable_http',
        url: 'https://example.com/mcp',
        bearer_token_env_var: 'EXAMPLE_KEY',
      },
    },
    {
      name: 'shared-stdio',
      enabled: true,
      transport: { type: 'stdio', command: 'node', args: ['server.js'], env_vars: ['EXAMPLE_KEY'] },
    },
    {
      name: 'node_repl',
      enabled: true,
      transport: { type: 'stdio', command: 'node' },
    },
  ]))
  write(
    bin,
    [
      '#!/bin/sh',
      'case "$*" in',
      '  "plugin list --json") cat "$CODEX_HOME/plugin-list.json" ;;',
      '  "mcp list --json") cat "$CODEX_HOME/mcp-list.json" ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return bin
}

function fakeContext(config) {
  const state = { providers: [], servers: [], effects: 0, warnings: [], notes: [] }
  const skills = {
    registerProvider(create) {
      state.providers.push(create({ signal: new AbortController().signal, invalidate() {} }))
      return () => {}
    },
  }
  const mcpManager = {
    register(name, entry) {
      state.servers.push({ name, entry })
      return () => {}
    },
  }
  const ctx = {
    config,
    logger: {
      warn: message => state.warnings.push(message),
      info: message => state.notes.push(message),
    },
    // Cordis hides services from a plugin that did not inject them; failing
    // here keeps the plugin from regressing to a direct `ctx.skills` access.
    get skills() {
      throw new Error('cannot get property "skills" without inject')
    },
    get mcpManager() {
      throw new Error('cannot get property "mcpManager" without inject')
    },
    inject(names, callback) {
      const available = { skills, mcpManager }
      for (const name of names) {
        assert.ok(name in available, `unexpected injected service ${name}`)
      }
      callback(Object.fromEntries(names.map(name => [name, available[name]])))
    },
    effect(factory) {
      state.effects += 1
      factory()
    },
  }
  return { ctx, state }
}

test('apply shares Codex skills and MCP servers with the harness', { skip: !enabled && 'POSIX shell shim only' }, async () => {
  const home = fakeCodexHome()
  const bin = fakeCodexBin(home)
  process.env.CODEX_HOME = home
  process.env.CODEX_BIN = bin
  process.env.EXAMPLE_KEY = 'secret-value'
  try {
    const { ctx, state } = fakeContext({})
    apply(ctx, {})

    assert.equal(state.providers.length, 1)
    const provider = state.providers[0]
    assert.equal(provider.name, 'codex')

    const listed = await provider.list()
    assert.equal(listed.complete, true)
    assert.deepEqual(listed.candidates.map(candidate => candidate.name).sort(), ['from-codex', 'plugin-skill'])

    const definition = await provider.get(listed.candidates.find(candidate => candidate.name === 'from-codex'))
    assert.equal(definition.content, 'Use it.')

    assert.deepEqual(state.servers.map(server => server.name), ['shared-http', 'shared-stdio'])
    const http = state.servers[0].entry
    assert.equal(http.url, 'https://example.com/mcp')
    assert.deepEqual(http.headers, { Authorization: 'Bearer ${credential:EXAMPLE_KEY}' })
    assert.equal(http.expandTemplates, true)
    const stdio = state.servers[1].entry
    assert.deepEqual(stdio.env, { EXAMPLE_KEY: 'secret-value' })

    assert.ok(state.notes.some(note => note.includes('sharing 2 skills')))
    assert.ok(state.notes.some(note => note.includes('"node_repl" not shared')))
  } finally {
    delete process.env.CODEX_HOME
    delete process.env.CODEX_BIN
    delete process.env.EXAMPLE_KEY
  }
})

test('apply keeps DSH booting when Codex is unreadable', { skip: !enabled && 'POSIX shell shim only' }, () => {
  const home = tempDir()
  process.env.CODEX_HOME = home
  process.env.CODEX_BIN = join(home, 'missing-codex')
  try {
    const { ctx, state } = fakeContext({})
    apply(ctx, {})
    assert.equal(state.servers.length, 0)
    assert.ok(state.warnings.some(warning => warning.includes('cannot execute')))
  } finally {
    delete process.env.CODEX_HOME
    delete process.env.CODEX_BIN
  }
})