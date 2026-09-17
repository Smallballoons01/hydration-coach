/**
 * Spec-compliance tests for the skill package itself.
 *
 * Agent Skills is an open standard, so the packaging rules are not stylistic:
 * `name` must be kebab-case *and* equal the containing directory, `SKILL.md`
 * must be spelled exactly, and the description is the only text loaded up
 * front — which is what decides whether the skill ever fires. A stale path in
 * the body is the other failure mode that is invisible until someone follows
 * the instructions and finds nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Parse the YAML frontmatter of a SKILL.md into a flat map plus the body. */
function parseSkill(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(markdown)
  assert.notEqual(match, null, 'SKILL.md has no frontmatter block')
  const [, frontmatter, body] = match
  const fields = {}
  for (const line of frontmatter.split('\n')) {
    const field = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line)
    if (field !== null) fields[field[1]] = field[2]
  }
  return { fields, frontmatter, body }
}

test('the skill directory is named after the skill', async () => {
  const markdown = await readFile(join(root, 'SKILL.md'), 'utf8')
  const { fields } = parseSkill(markdown)
  const folder = basename(root)
  assert.equal(
    folder,
    'hydration-coach',
    // The spec makes the folder name part of the contract, and the failure is
    // easy to hit by accident: a git clone keeps the repository name, but a
    // GitHub ZIP download appends "-main", and an unpacked tarball may differ
    // again. Say what to do rather than just which string mismatched.
    `the Agent Skills spec requires the containing folder to be named after the skill, `
    + `and this folder is '${folder}'. Rename it to 'hydration-coach' (a ZIP download adds a '-main' suffix).`,
  )
  assert.equal(fields.name, basename(root), 'the spec requires name to equal the directory name')
})

test('the name satisfies the kebab-case grammar', async () => {
  const { fields } = parseSkill(await readFile(join(root, 'SKILL.md'), 'utf8'))
  assert.match(fields.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(fields.name.length <= 64, 'name is capped at 64 characters')
})

test('the description is present and within the documented cap', async () => {
  const { fields } = parseSkill(await readFile(join(root, 'SKILL.md'), 'utf8'))
  const description = fields.description
  assert.equal(typeof description, 'string')
  assert.ok(description.length > 40, 'a vague description is why skills never fire')
  assert.ok(description.length <= 1024, `description is ${description.length} chars, the cap is 1024`)
  // It must state when to use the skill, not only what it does.
  assert.match(description, /Use when/i)
})

test('the body stays inside the progressive-disclosure budget', async () => {
  const { body } = parseSkill(await readFile(join(root, 'SKILL.md'), 'utf8'))
  assert.ok(body.trim().length > 0)
  // ~5000 tokens is the spec's recommendation; chars are a cheap proxy.
  assert.ok(body.length < 20_000, `body is ${body.length} chars, keep it under ~5000 tokens`)
})

test('every path the skill points at exists', async () => {
  const { body } = parseSkill(await readFile(join(root, 'SKILL.md'), 'utf8'))
  for (const relativePath of ['scripts/water.mjs', 'scripts/install.mjs', 'references/tools.md']) {
    assert.ok(body.includes(relativePath), `SKILL.md never mentions ${relativePath}`)
    assert.equal((await stat(join(root, relativePath))).isFile(), true, `${relativePath} is missing`)
  }
})

test('the bundled scripts are executable by node', async () => {
  for (const script of ['scripts/water.mjs', 'scripts/install.mjs']) {
    const firstLine = (await readFile(join(root, script), 'utf8')).split('\n')[0]
    assert.equal(firstLine, '#!/usr/bin/env node', `${script} needs a shebang to run directly`)
  }
})

test('the canonical directory has no stray state files', async () => {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(root)
  for (const forbidden of ['state.json', 'config.json', 'node_modules']) {
    assert.equal(entries.includes(forbidden), false, `${forbidden} must not be committed inside the skill`)
  }
})
