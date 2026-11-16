import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readSkillDefinition, scanSkillRoots } from '../lib/skills.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'codex-share-skills-'))
}

function write(path, content) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function skill(root, directory, frontmatter, body = 'Instructions.\n') {
  write(join(root, directory, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`)
}

test('scanSkillRoots reads name, description and routing guidance', () => {
  const root = tempDir()
  skill(root, 'alpha', 'name: alpha\ndescription: First skill.\nwhenToUse: When alpha is needed.')

  const { candidates, duplicates } = scanSkillRoots([root], { provider: 'codex' })
  assert.equal(candidates.length, 1)
  assert.deepEqual(duplicates, [])
  assert.equal(candidates[0].name, 'alpha')
  assert.equal(candidates[0].description, 'First skill.')
  assert.equal(candidates[0].whenToUse, 'When alpha is needed.')
  assert.deepEqual(candidates[0].invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(candidates[0].rank, 300)
  assert.equal(candidates[0].source, 'custom')
  assert.equal(candidates[0].provider, 'codex')
  assert.equal(candidates[0].locator.path, join(root, 'alpha', 'SKILL.md'))
  assert.deepEqual(candidates[0].resourceBase, { kind: 'directory', path: join(root, 'alpha') })
})

test('scanSkillRoots honours the invocation flags', () => {
  const root = tempDir()
  skill(root, 'internal', 'name: internal\ndescription: Internal only.\ndisable-model-invocation: true\nuser-invocable: false')

  const [candidate] = scanSkillRoots([root]).candidates
  assert.deepEqual(candidate.invocation, { modelInvocable: false, userInvocable: false })
})

test('scanSkillRoots skips files without frontmatter, without a name, and with an invalid name', () => {
  const root = tempDir()
  write(join(root, 'no-frontmatter', 'SKILL.md'), 'Just a body.\n')
  skill(root, 'no-name', 'description: Missing a name.')
  skill(root, 'Bad_Name', 'name: Bad_Name\ndescription: Not kebab case.')
  skill(root, 'good', 'name: good\ndescription: Fine.')

  const { candidates } = scanSkillRoots([root])
  assert.deepEqual(candidates.map(candidate => candidate.name), ['good'])
})

test('scanSkillRoots keeps the first root that claims a name and reports the shadowed one', () => {
  const first = tempDir()
  const second = tempDir()
  skill(first, 'pdf', 'name: pdf\ndescription: PDF from the first root.')
  skill(first, 'only-first', 'name: only-first\ndescription: Unique to the first root.')
  skill(second, 'pdf', 'name: pdf\ndescription: PDF from the second root.')
  skill(second, 'only-second', 'name: only-second\ndescription: Unique to the second root.')

  const { candidates, duplicates } = scanSkillRoots([first, second])
  assert.deepEqual(candidates.map(candidate => candidate.name), ['only-first', 'pdf', 'only-second'])
  assert.deepEqual(duplicates, [{ name: 'pdf', root: second }])
  assert.equal(candidates.find(candidate => candidate.name === 'pdf').description, 'PDF from the first root.')
})

test('scanSkillRoots supports a flat .md skill and ignores hidden entries', () => {
  const root = tempDir()
  write(join(root, 'flat.md'), '---\nname: flat\ndescription: Flat skill.\n---\n\nBody.\n')
  skill(join(root, '.system'), 'hidden', 'name: hidden\ndescription: Hidden.')

  const { candidates } = scanSkillRoots([root])
  assert.deepEqual(candidates.map(candidate => candidate.name), ['flat'])
  assert.deepEqual(candidates[0].resourceBase, { kind: 'directory', path: root })
})

test('scanSkillRoots tolerates a missing root', () => {
  assert.deepEqual(scanSkillRoots([join(tempDir(), 'nope')]), { candidates: [], duplicates: [] })
})

test('readSkillDefinition strips the frontmatter and keeps the body', () => {
  const root = tempDir()
  skill(root, 'alpha', 'name: alpha\ndescription: First skill.', 'Line one.\n\nLine two.\n')
  const [candidate] = scanSkillRoots([root]).candidates

  const definition = readSkillDefinition(candidate)
  assert.equal(definition.name, 'alpha')
  assert.equal(definition.description, 'First skill.')
  assert.equal(definition.content, 'Line one.\n\nLine two.')
  assert.equal(definition.provider, 'codex')
  assert.equal(definition.source, 'custom')
})

test('readSkillDefinition returns undefined when the file disappeared', () => {
  const root = tempDir()
  skill(root, 'alpha', 'name: alpha\ndescription: First skill.')
  const [candidate] = scanSkillRoots([root]).candidates
  candidate.locator.path = join(root, 'gone', 'SKILL.md')
  assert.equal(readSkillDefinition(candidate), undefined)
})