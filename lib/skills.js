/**
 * Read Codex skill directories with the same rules DSH's filesystem provider
 * uses: one level of directories (or flat `.md` files), YAML frontmatter with
 * `name` and `description`, and the canonical invocation flags.
 *
 * DSH cannot mount `@deepseek-ai/dsh-skill-filesystem` a second time with a
 * machine-independent configuration, because the Codex roots are spread over
 * versioned plugin directories. Discovering them here keeps the shared catalog
 * a single source of truth without copying or linking any file.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as YAML from 'js-yaml'

/** Same pattern as `@deepseek-ai/dsh-skill`. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Rank shared with DSH's custom roots: they win over `$DSH_HOME/skills`. */
export const CUSTOM_RANK = 300

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/
const loadYaml = typeof YAML.load === 'function' ? YAML.load : YAML.default?.load

function parseFrontmatter(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const match = FRONTMATTER.exec(source)
  if (match === null) return undefined
  let data
  try {
    data = loadYaml(match[1])
  } catch {
    return undefined
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  return { data, body: source.slice(match[0].length) }
}

function stringField(data, key) {
  const value = data[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function invocationFrom(data) {
  // `frontmatterBoolean`-compatible: accept booleans, 1/0 and "1"/"0".
  const bool = (key) => {
    if (!Object.hasOwn(data, key)) return undefined
    const value = data[key]
    if (typeof value === 'boolean') return value
    if (value === 1 || value === '1') return true
    if (value === 0 || value === '0') return false
    return undefined
  }
  return {
    modelInvocable: bool('disable-model-invocation') !== true,
    userInvocable: bool('user-invocable') !== false,
  }
}

function readSkillText(path) {
  const resolved = realpathSync(path)
  return { path: resolved, text: readFileSync(resolved, 'utf8') }
}

function parseSkill(path) {
  let raw
  try {
    raw = readSkillText(path)
  } catch {
    return undefined
  }
  const parsed = parseFrontmatter(raw.text)
  if (parsed === undefined) return undefined
  const name = stringField(parsed.data, 'name')
  const description = stringField(parsed.data, 'description')
  if (name === undefined || description === undefined || !SKILL_NAME.test(name)) return undefined
  const whenToUse = stringField(parsed.data, 'whenToUse')
  const metadata = parsed.data.metadata
  return {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    invocation: invocationFrom(parsed.data),
    body: parsed.body.trim(),
    path: raw.path,
    ...(metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata) ? { metadata } : {}),
  }
}

function rootEntries(root) {
  try {
    return readdirSync(root, { withFileTypes: true, encoding: 'utf8' }).sort((left, right) => left.name.localeCompare(right.name))
  } catch {
    return []
  }
}

function entryKind(entry, directory) {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  if (entry.isSymbolicLink()) {
    try {
      return statSync(directory).isDirectory() ? 'directory' : 'file'
    } catch {
      return 'other'
    }
  }
  return 'other'
}

/**
 * Enumerate every skill Codex would see across `roots`.
 *
 * A name claimed by an earlier root wins, mirroring DSH's rank ordering, and
 * the loser is reported instead of silently ignored.
 */
export function scanSkillRoots(roots, options = {}) {
  const provider = options.provider ?? 'codex'
  const rank = options.rank ?? CUSTOM_RANK
  const candidates = []
  const duplicates = []
  const seen = new Set()

  for (const root of roots) {
    for (const entry of rootEntries(root)) {
      if (entry.name.startsWith('.')) continue
      const path = join(root, entry.name)
      const kind = entryKind(entry, path)
      const file = kind === 'directory'
        ? join(path, 'SKILL.md')
        : kind === 'file' && entry.name.toLowerCase().endsWith('.md')
          ? path
          : undefined
      if (file === undefined || !existsSync(file)) continue

      const parsed = parseSkill(file)
      if (parsed === undefined) continue
      if (seen.has(parsed.name)) {
        duplicates.push({ name: parsed.name, root })
        continue
      }
      seen.add(parsed.name)
      candidates.push({
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        invocation: parsed.invocation,
        provider,
        source: 'custom',
        rank,
        locator: { path: file, directory: kind === 'directory' ? path : root },
        resourceBase: { kind: 'directory', path: kind === 'directory' ? path : root },
        path: parsed.path,
        ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
      })
    }
  }

  return { candidates, duplicates }
}

/** Load the body of a candidate returned by {@link scanSkillRoots}. */
export function readSkillDefinition(candidate) {
  const path = candidate?.locator?.path
  if (typeof path !== 'string') return undefined
  const parsed = parseSkill(path)
  if (parsed === undefined) return undefined
  return {
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
    invocation: parsed.invocation,
    provider: candidate.provider,
    source: candidate.source,
    content: parsed.body,
    path: parsed.path,
    resourceBase: candidate.resourceBase,
    ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
  }
}