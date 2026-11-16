/**
 * dsh-codex-share
 *
 * One source of truth: Codex. This bundle adds the skills Codex installs and
 * the MCP servers Codex configures to the harness, without copies, symlinks or
 * hardlinks, so the same profile works on macOS and Windows and a synced
 * profile keeps working on a different machine.
 */
import { codexFingerprint, discover } from './lib/codex.js'
import { readSkillDefinition, scanSkillRoots } from './lib/skills.js'
import { existsSync, writeFileSync } from 'node:fs'

export const name = 'codex-share'

/** Provider name shown in skill listings. */
export const PROVIDER = 'codex'

function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`codex-share: ${message}`)
  } catch {
    // A missing logger must not break plugin loading.
  }
}

function note(ctx, message) {
  try {
    ctx.logger?.info?.(`codex-share: ${message}`)
  } catch {
    // Same as above.
  }
}

export function apply(ctx, config) {
  // Cordis hands the row's `config` in as the second argument; reading
  // ctx.config here would need `inject: ['config']` and fails activation.
  const options = config ?? {}

  let share
  try {
    share = discover(options)
  } catch (error) {
    warn(ctx, `cannot read Codex (${error?.message ?? error}); no skills or MCP servers are shared`)
    share = { skillDirs: [], servers: [], skipped: [], warnings: [] }
  }
  for (const message of share.warnings) warn(ctx, message)

  if (existsSync('/tmp/codex-share-debug.on')) {
    try {
      writeFileSync('/tmp/codex-share-debug.json', JSON.stringify({ env: process.env, share }, null, 2))
    } catch {
      // Debug output is best effort.
    }
  }

  mountSkills(ctx, share, options)
  mountServers(ctx, share)
}

function mountSkills(ctx, share, options) {
  if (!Array.isArray(share.skillDirs) || share.skillDirs.length === 0) {
    note(ctx, 'Codex exposes no skill directories')
    return
  }
  let current = share
  let control
  const provider = {
    name: PROVIDER,
    async list() {
      const { candidates } = scanSkillRoots(current.skillDirs, { provider: PROVIDER })
      // Complete: the registry may cache this catalog. `watchCodex` below
      // invalidates it when Codex installs or removes a plugin, so a stale
      // versioned directory never outlives the plugin it came from.
      return { candidates, complete: true }
    },
    async get(candidate) {
      return readSkillDefinition(candidate)
    },
  }

  const { candidates, duplicates } = scanSkillRoots(share.skillDirs, { provider: PROVIDER })

  let dispose
  // Cordis only exposes a service through `inject`; touching `ctx.skills`
  // directly throws "cannot get property ... without inject" and would abort
  // activation.
  ctx.inject(['skills'], (scoped) => {
    const skills = scoped.skills
    if (typeof skills?.registerProvider !== 'function') {
      warn(ctx, 'the skills service is not available; Codex skills are not shared')
      return
    }
    dispose?.()
    try {
      dispose = skills.registerProvider((serviceControl) => {
        control = serviceControl
        return provider
      })
    } catch (error) {
      warn(ctx, `cannot register the Codex skill provider (${error?.message ?? error})`)
      return
    }
    note(ctx, `sharing ${candidates.length} skills from ${share.skillDirs.length} Codex directories`)
    for (const duplicate of duplicates) {
      note(ctx, `skill "${duplicate.name}" in ${duplicate.root} is shadowed by an earlier Codex directory`)
    }
  })

  watchCodex(ctx, options, (refreshed) => {
    current = refreshed
    control?.invalidate()
  })
}

/**
 * Codex rewrites plugin directories when it updates a marketplace, and a
 * refreshed plugin lives under a new version directory. Poll the cheap
 * filesystem fingerprint and re-discover only when it moved, then drop the
 * registry cache so the catalog reflects the new directories.
 */
function watchCodex(ctx, options, apply) {
  const tick = () => {
    let fingerprint
    try {
      fingerprint = codexFingerprint()
    } catch {
      return
    }
    if (fingerprint === last) return
    last = fingerprint
    try {
      const refreshed = discover(options)
      if (refreshed.skillDirs.length > 0) {
        apply(refreshed)
        note(ctx, `Codex skills changed; sharing ${refreshed.skillDirs.length} directories`)
      }
    } catch (error) {
      warn(ctx, `cannot refresh Codex skills (${error?.message ?? error})`)
    }
  }
  let last = (() => {
    try {
      return codexFingerprint()
    } catch {
      return ''
    }
  })()
  const interval = Math.max(5, Number(options?.watchIntervalSeconds ?? 30)) * 1000
  ctx.effect(() => {
    const timer = setInterval(tick, interval)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'codex-share.watch')
}

function mountServers(ctx, share) {
  const servers = Array.isArray(share.servers) ? share.servers : []
  if (servers.length === 0) {
    note(ctx, 'Codex exposes no shareable MCP servers')
    return
  }
  ctx.inject(['mcpManager'], (scoped) => {
    const manager = scoped.mcpManager
    if (typeof manager?.register !== 'function') {
      warn(ctx, 'mcpManager is not available; MCP servers are not shared')
      return
    }
    for (const server of servers) {
      // A server Codex shares but DSH already configures (or another plugin
      // registers) is not an error worth failing the boot over: keep DSH's own
      // entry and say so.
      ctx.effect(() => {
        try {
          return manager.register(server.name, server.entry)
        } catch (error) {
          warn(ctx, `cannot share MCP server "${server.name}" (${error?.message ?? error})`)
          return () => {}
        }
      }, `codex-share.register(${server.name})`)
      note(ctx, `sharing MCP server "${server.name}" from Codex`)
    }
  })
  for (const skipped of share.skipped ?? []) {
    note(ctx, `MCP server "${skipped.name}" not shared (${skipped.reason})`)
  }
}