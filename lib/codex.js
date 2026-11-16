/**
 * Everything this bundle knows about Codex: where it lives, which skills its
 * plugins ship, and which MCP servers its configuration exposes.
 *
 * The discovery is synchronous on purpose. DSH builds its tool catalog while
 * the profile loads, so the plugin has to finish reading Codex before `apply()`
 * returns.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, normalize } from 'node:path'

/**
 * Servers Codex ships for its own surfaces. They either drive Codex-only
 * features or need environment the harness does not have, so they stay out of
 * DSH unless a profile asks for them explicitly with `includeServers`.
 */
export const DEFAULT_EXCLUDED_SERVERS = ['codex_app', 'computer-use', 'cua_repl', 'node_repl', 'itasca-mcp']

/** Resolve the Codex home directory the same way the Codex CLI does. */
export function codexHomeOf(env = process.env) {
  const configured = String(env.CODEX_HOME ?? '').trim()
  return configured !== '' ? configured : join(homedir(), '.codex')
}

/** Resolve the DSH home directory. */
export function dshHomeOf(env = process.env) {
  const configured = String(env.DSH_HOME ?? '').trim()
  return configured !== '' ? configured : join(homedir(), '.dsh')
}

function isExecutableFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Locate the Codex CLI without relying on an inherited interactive shell.
 * Windows is the reason this exists: a DSH launched from Explorer has no
 * npm/`.cmd` shims on PATH, while the same user can still run `codex` in a
 * terminal.
 */
export function findCodex(env = process.env, platform = process.platform, home = homedir()) {
  const configured = String(env.CODEX_BIN ?? '').trim()
  if (configured !== '') return configured

  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex'] : ['codex']
  const directories = []
  if (platform === 'win32') {
    for (const key of ['APPDATA', 'LOCALAPPDATA']) {
      const base = String(env[key] ?? '').trim()
      if (base === '') continue
      directories.push(join(base, 'npm'), join(base, 'Programs', 'codex'))
    }
    const profile = String(env.USERPROFILE ?? '').trim()
    if (profile !== '') directories.push(join(profile, '.local', 'bin'), join(profile, '.codex', 'bin'))
  } else {
    directories.push(join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, '.npm-global', 'bin'))
    directories.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
  }
  for (const directory of String(env.PATH ?? '').split(delimiter)) {
    if (directory !== '') directories.push(directory)
  }

  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Run a Codex CLI subcommand that prints JSON and parse it.
 * Failures are values, not exceptions: a missing or broken Codex must never
 * stop DSH from starting.
 */
export function runCodexJson(bin, args, options = {}) {
  const env = options.env ?? process.env
  const timeout = options.timeoutMs ?? 20000
  // `execFileSync` cannot run a `.cmd` shim without a shell, and the quoting
  // below is what keeps a path with spaces working once a shell is involved.
  const script = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
  const command = script ? `"${bin}"` : bin
  try {
    const stdout = execFileSync(command, args, {
      encoding: 'utf8',
      env,
      maxBuffer: 16 * 1024 * 1024,
      shell: script,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      windowsHide: true,
    })
    return { ok: true, data: JSON.parse(stdout) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, error: `cannot execute ${bin}` }
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    return { ok: false, error: stderr !== '' ? stderr : String(error?.message ?? error).trim() }
  }
}

/**
 * Absolute directory of an installed Codex plugin.
 *
 * `source.path` is absolute only for plugins loaded from a local marketplace;
 * git and git-subdir plugins report a relative path or none at all, and their
 * files live in the plugin cache under the installed version.
 */
export function pluginBaseDir(entry, codexHome) {
  if (entry === null || typeof entry !== 'object') return undefined
  const source = entry.source ?? {}
  if (source.source === 'local' && typeof source.path === 'string' && isAbsolute(source.path)) return source.path
  const { marketplaceName, name, version } = entry
  if (typeof marketplaceName !== 'string' || typeof name !== 'string' || typeof version !== 'string') return undefined
  return join(codexHome, 'plugins', 'cache', marketplaceName, name, version)
}

function readManifest(base) {
  for (const candidate of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    const file = join(base, candidate)
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch {
      // A malformed manifest only costs us the manifest's skill path.
    }
  }
  return undefined
}

/** The skill root a plugin exposes, or `undefined` when it ships no skills. */
export function pluginSkillsDir(entry, codexHome) {
  const base = pluginBaseDir(entry, codexHome)
  if (base === undefined || !existsSync(base)) return undefined
  const manifest = readManifest(base)
  const declared = typeof manifest?.skills === 'string' ? manifest.skills : 'skills'
  const relative = declared.replace(/^\.\//, '').replace(/[/\\]+$/, '')
  if (relative === '' || relative.includes('..')) return undefined
  const directory = join(base, relative)
  return existsSync(directory) ? directory : undefined
}

function cacheSkillDirs(codexHome) {
  const roots = []
  const cache = join(codexHome, 'plugins', 'cache')
  if (!existsSync(cache)) return roots
  for (const marketplace of safeReaddir(cache)) {
    const marketplaceDir = join(cache, marketplace)
    for (const plugin of safeReaddir(marketplaceDir)) {
      const pluginDir = join(marketplaceDir, plugin)
      for (const version of safeReaddir(pluginDir)) {
        const base = join(pluginDir, version)
        const manifest = readManifest(base)
        const declared = typeof manifest?.skills === 'string' ? manifest.skills : 'skills'
        const relative = declared.replace(/^\.\//, '').replace(/[/\\]+$/, '')
        if (relative === '' || relative.includes('..')) continue
        const directory = join(base, relative)
        if (existsSync(directory)) roots.push(directory)
      }
    }
  }
  return roots
}

function safeReaddir(directory) {
  try {
    return readdirSync(directory, { encoding: 'utf8' }).sort()
  } catch {
    return []
  }
}

/**
 * Skill roots, most specific first.
 *
 * The first global root is `$CODEX_HOME/skills`, which is where a user's own
 * skills live; plugin roots follow in marketplace/plugin order. The last entry
 * is the snapshot dsh-mini-sync can restore on machines that do not have Codex
 * installed, so those machines still get a shared catalog.
 */
export function skillRoots(plugins, options = {}) {
  const codexHome = options.codexHome ?? codexHomeOf()
  const dshHome = options.dshHome ?? dshHomeOf()
  const roots = []

  const globalRoot = join(codexHome, 'skills')
  if (existsSync(globalRoot)) roots.push(globalRoot)

  const installed = Array.isArray(plugins) ? plugins : cachePluginList(codexHome)
  const ordered = installed
    .filter(entry => entry?.enabled !== false)
    .slice()
    .sort((left, right) => {
      const leftKey = `${left.marketplaceName ?? ''}/${left.name ?? ''}`
      const rightKey = `${right.marketplaceName ?? ''}/${right.name ?? ''}`
      return leftKey.localeCompare(rightKey)
    })
  for (const entry of ordered) {
    const directory = pluginSkillsDir(entry, codexHome)
    if (directory !== undefined) roots.push(directory)
  }

  const snapshot = join(dshHome, 'codex-share', 'skills')
  if (existsSync(snapshot)) roots.push(snapshot)

  for (const extra of options.extraDirs ?? []) {
    if (typeof extra === 'string' && extra !== '' && existsSync(extra)) roots.push(extra)
  }

  return [...new Set(roots)]
}

/** Plugin entries derived from the cache, used when the CLI is unavailable. */
function cachePluginList(codexHome) {
  const entries = []
  const cache = join(codexHome, 'plugins', 'cache')
  for (const marketplaceName of safeReaddir(cache)) {
    for (const name of safeReaddir(join(cache, marketplaceName))) {
      const versions = safeReaddir(join(cache, marketplaceName, name))
      const version = versions.at(-1)
      if (version === undefined) continue
      entries.push({ marketplaceName, name, version, enabled: true })
    }
  }
  return entries
}

function numberFromSeconds(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : undefined
}

const CREDENTIAL_PREFIX = '${credential:'

/**
 * Translate one Codex transport description into a `dsh-mcp-client` entry.
 *
 * Two Codex-only concepts need translation:
 * - `env_vars` is "copy this from my environment"; dsh-mcp-client starts
 *   servers from a scrubbed environment, so the values are copied here.
 * - `bearer_token_env_var` / `env_http_headers` name an environment variable
 *   holding a secret. Those become `${credential:NAME}` templates, which DSH
 *   resolves from its own credential store, its `.env` files, or the launch
 *   environment.
 */
function commandNeedsBase(command) {
  return typeof command === 'string' && /[\\/]/.test(command) && !isAbsolute(command)
}

/**
 * Translate one Codex transport description into a `dsh-mcp-client` entry.
 *
 * Three Codex-only concepts need translation:
 * - `env_vars` is "copy this from my environment"; dsh-mcp-client starts
 *   servers from a scrubbed environment, so the values are copied here.
 * - `bearer_token_env_var` / `env_http_headers` name an environment variable
 *   holding a secret. Those become `${credential:NAME}` templates, which DSH
 *   resolves from its own credential store, its `.env` files, or the launch
 *   environment.
 * - A plugin may launch `./mcp/launch` relative to its own directory. Codex
 *   reports that directory as `cwd`, so the command is made absolute here.
 */
function mapTransport(transport, env = process.env) {
  if (transport === null || typeof transport !== 'object') return { problem: 'missing transport' }
  const type = transport.type
  const entry = {}

  if (type === 'stdio') {
    if (typeof transport.command !== 'string' || transport.command === '') return { problem: 'stdio transport without a command' }
    entry.transport = 'stdio'
    entry.command = transport.command
    entry.args = Array.isArray(transport.args) ? transport.args.filter(arg => typeof arg === 'string') : []

    let cwd = typeof transport.cwd === 'string' && transport.cwd !== '' ? transport.cwd : undefined
    if (cwd === '.') cwd = undefined
    if (commandNeedsBase(entry.command)) {
      if (cwd === undefined || !isAbsolute(cwd)) return { problem: `relative launcher "${entry.command}" without an absolute cwd` }
      entry.command = join(cwd, entry.command)
    }
    if (cwd !== undefined && isAbsolute(cwd)) entry.cwd = normalize(cwd)

    const childEnv = {}
    for (const [key, value] of Object.entries(transport.env ?? {})) {
      if (typeof value === 'string') childEnv[key] = value
    }
    for (const key of Array.isArray(transport.env_vars) ? transport.env_vars : []) {
      const value = env[key]
      if (typeof value === 'string') childEnv[key] = value
    }
    if (Object.keys(childEnv).length > 0) entry.env = childEnv
  } else if (type === 'streamable_http' || type === 'streamable-http' || type === 'http') {
    if (typeof transport.url !== 'string' || transport.url === '') return { problem: 'http transport without a url' }
    entry.transport = 'streamable-http'
    entry.url = transport.url

    const headers = {}
    for (const [key, value] of Object.entries(transport.http_headers ?? {})) {
      if (typeof value === 'string') headers[key] = value
    }
    let templated = false
    if (typeof transport.bearer_token_env_var === 'string' && transport.bearer_token_env_var !== '') {
      headers.Authorization = `Bearer ${CREDENTIAL_PREFIX}${transport.bearer_token_env_var}}`
      templated = true
    }
    for (const [header, variable] of Object.entries(transport.env_http_headers ?? {})) {
      if (typeof variable !== 'string' || variable === '') continue
      headers[header] = `${CREDENTIAL_PREFIX}${variable}}`
      templated = true
    }
    if (Object.keys(headers).length > 0) entry.headers = headers
    if (templated) entry.expandTemplates = true
  } else {
    return { problem: `unsupported transport "${String(type)}"` }
  }

  const startupTimeoutMs = numberFromSeconds(transport.startup_timeout_sec)
  if (startupTimeoutMs !== undefined) entry.startupTimeoutMs = startupTimeoutMs
  const toolCallTimeoutMs = numberFromSeconds(transport.tool_timeout_sec)
  if (toolCallTimeoutMs !== undefined) entry.toolCallTimeoutMs = toolCallTimeoutMs
  return { entry }
}

/** Translate one Codex transport, or `undefined` when DSH cannot mount it. */
export function toServerEntry(transport, env = process.env) {
  return mapTransport(transport, env).entry
}

/** Filter Codex's server list down to the servers DSH should mount. */
export function selectServers(servers, options = {}) {
  const excluded = new Set(options.excludeServers ?? DEFAULT_EXCLUDED_SERVERS)
  const allowed = Array.isArray(options.includeServers) && options.includeServers.length > 0
    ? new Set(options.includeServers)
    : undefined
  const env = options.env ?? process.env

  const selected = []
  const skipped = []
  for (const server of Array.isArray(servers) ? servers : []) {
    if (server === null || typeof server !== 'object' || typeof server.name !== 'string') continue
    if (server.enabled === false) {
      skipped.push({ name: server.name, reason: 'disabled in Codex' })
      continue
    }
    if (allowed === undefined ? excluded.has(server.name) : !allowed.has(server.name)) {
      skipped.push({ name: server.name, reason: 'excluded by dsh-codex-share' })
      continue
    }
    const mapped = mapTransport(server.transport ?? {}, env)
    if (mapped.entry === undefined) {
      skipped.push({ name: server.name, reason: mapped.problem ?? 'unsupported transport' })
      continue
    }
    selected.push({ name: server.name, entry: mapped.entry })
  }
  return { servers: selected, skipped }
}

/** Server entries declared by installed plugin manifests, the CLI-less fallback. */
function manifestServers(codexHome) {
  const servers = []
  const cache = join(codexHome, 'plugins', 'cache')
  for (const marketplace of safeReaddir(cache)) {
    for (const name of safeReaddir(join(cache, marketplace))) {
      for (const version of safeReaddir(join(cache, marketplace, name))) {
        const base = join(cache, marketplace, name, version)
        const manifest = readManifest(base)
        const declared = typeof manifest?.mcpServers === 'string' ? manifest.mcpServers : undefined
        const files = ['.mcp.json', 'codex.mcp.json', ...(declared === undefined ? [] : [declared])]
        for (const file of files) {
          const absolute = join(base, file)
          if (!existsSync(absolute)) continue
          try {
            const parsed = JSON.parse(readFileSync(absolute, 'utf8'))
            const map = parsed?.mcpServers ?? parsed
            for (const [serverName, value] of Object.entries(map ?? {})) {
              if (value === null || typeof value !== 'object') continue
              if (servers.some(existing => existing.name === serverName)) continue
              servers.push({ name: serverName, enabled: value.enabled !== false, transport: value })
            }
          } catch {
            // A malformed manifest is not worth failing the whole discovery.
          }
        }
      }
    }
  }
  return servers
}

/**
 * Read Codex and describe what DSH should mount.
 *
 * @param config - bundle config from `cordis.patch.yml`.
 * @param deps - injection points used by the tests.
 * @returns skill roots, MCP entries, and human-readable warnings.
 */
/**
 * Cheap change detector for the Codex side: the skill directories that
 * `discover()` would return depend on the global skills directory, the plugin
 * cache layout and the enabled-plugin table in `config.toml`. Reading those is
 * milliseconds; running the CLI is not, so the plugin polls this and only
 * re-discovers when it actually changed.
 */
export function codexFingerprint(env = process.env) {
  const home = codexHomeOf(env)
  const parts = []
  const list = (directory) => {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
    } catch {
      return []
    }
  }
  parts.push(`skills:${list(join(home, 'skills')).join(',')}`)
  for (const marketplace of list(join(home, 'plugins', 'cache'))) {
    for (const plugin of list(join(home, 'plugins', 'cache', marketplace))) {
      parts.push(`${marketplace}/${plugin}:${list(join(home, 'plugins', 'cache', marketplace, plugin)).join(',')}`)
    }
  }
  try {
    parts.push(`config:${statSync(join(home, 'config.toml')).mtimeMs}`)
  } catch {
    parts.push('config:-')
  }
  return parts.join('\n')
}

/** A blank string in a patch file means "unset", not "the empty path". */
function pathOption(value, fallback) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed === '' ? fallback : trimmed
}

export function discover(config = {}, deps = {}) {
  const env = deps.env ?? process.env
  const run = deps.run ?? runCodexJson
  // `??` is not enough here: the bundle ships codexHome/codexBin as empty
  // strings, and join('', 'skills') silently yields a relative path.
  const codexHome = pathOption(config.codexHome, codexHomeOf(env))
  const dshHome = pathOption(config.dshHome, dshHomeOf(env))
  const warnings = []

  const configuredBin = typeof config.codexBin === 'string' ? config.codexBin.trim() : ''
  const locate = deps.findCodex ?? (() => findCodex(env))
  const bin = configuredBin !== '' ? configuredBin : locate()
  let plugins
  let servers
  if (bin !== undefined) {
    const pluginList = run(bin, ['plugin', 'list', '--json'], { env })
    if (pluginList.ok && Array.isArray(pluginList.data?.installed)) {
      plugins = pluginList.data.installed
    } else {
      warnings.push(`codex plugin list failed (${pluginList.error ?? 'unexpected output'}); falling back to the plugin cache`)
    }
    const mcpList = run(bin, ['mcp', 'list', '--json'], { env })
    if (mcpList.ok && Array.isArray(mcpList.data)) {
      servers = mcpList.data
    } else {
      warnings.push(`codex mcp list failed (${mcpList.error ?? 'unexpected output'}); falling back to plugin manifests`)
    }
  } else {
    warnings.push('Codex CLI not found; reading skills and MCP servers from the Codex cache only')
  }

  const skillDirs = config.skills === false
    ? []
    : skillRoots(plugins, { codexHome, dshHome, extraDirs: config.skillDirs })

  const { servers: mounted, skipped } = config.mcp === false
    ? { servers: [], skipped: [] }
    : selectServers(servers ?? manifestServers(codexHome), {
      env,
      excludeServers: config.excludeServers,
      includeServers: config.includeServers,
    })

  return { codexHome, dshHome, bin, skillDirs, servers: mounted, skipped, warnings }
}