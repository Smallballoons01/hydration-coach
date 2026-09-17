/**
 * Tests for `scripts/install.mjs`.
 *
 * Everything runs against a throwaway home directory. The important case is
 * `hookCommand`: a generated hook is executed by the host tool on every prompt,
 * so a syntax error there breaks the user's tool silently. These tests run the
 * generated string through `sh -n` and actually execute it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HOOK_MARKER,
  SKILL_NAME,
  canonicalDir,
  hookCommand,
  installHooks,
  installSkill,
  main,
  projectTargets,
  shellQuote,
  targets,
  uninstallSkill,
} from '../scripts/install.mjs'

const SCRIPT = join(canonicalDir(), 'scripts', 'water.mjs')

/** A throwaway home plus a capturing writer. */
async function sandbox(t) {
  const home = await mkdtemp(join(tmpdir(), 'install-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const out = []
  const err = []
  return { home, out, err, io: { home, log: text => out.push(text), error: text => err.push(text) } }
}

/** Write a config file, creating its parent directory. */
async function writeConfig(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

test('targets cover the mainstream tools and stay inside the given home', () => {
  const list = targets('/tmp/fake-home')
  const ids = list.map(target => target.id)
  for (const id of ['agents', 'claude', 'codex', 'cursor', 'gemini', 'workbuddy', 'opencode', 'openclaw', 'kimi']) {
    assert.ok(ids.includes(id), `missing target ${id}`)
  }
  for (const target of list) {
    assert.ok(target.skills.length > 0)
    for (const root of target.skills) assert.ok(root.startsWith('/tmp/fake-home'), `${target.id} escaped the home`)
    if (target.hooks !== undefined) {
      assert.ok(target.hooks.file.startsWith('/tmp/fake-home'))
      assert.ok(Object.keys(target.hooks.events).length > 0)
      assert.ok(['nested', 'flat'].includes(target.hooks.shape))
    }
  }
})

test('projectTargets gives one root per project-scoped convention', () => {
  const list = projectTargets('/tmp/repo')
  assert.deepEqual(
    list.flatMap(target => target.skills),
    ['/tmp/repo/.agents/skills', '/tmp/repo/.claude/skills', '/tmp/repo/.codex/skills', '/tmp/repo/.cursor/skills', '/tmp/repo/.gemini/skills'],
  )
})

test('the generated hook command is valid shell', () => {
  for (const format of ['claude', 'codex', 'cursor', 'gemini']) {
    const command = hookCommand(SCRIPT, format, 'UserPromptSubmit')
    const check = spawnSync('sh', ['-n'], { input: command, encoding: 'utf8' })
    assert.equal(check.status, 0, `sh -n rejected the ${format} hook: ${check.stderr}`)
    assert.ok(command.includes(HOOK_MARKER), 'the identity marker is missing')
    assert.ok(command.includes('cat >/dev/null'), 'stdin is not drained')
  }
})

test('the generated hook command keeps the tool safe when the script is missing', () => {
  for (const [format, noop] of [['claude', '{}'], ['codex', '{}'], ['gemini', '{}'], ['cursor', '{"continue":true}']]) {
    const command = hookCommand('/nonexistent/water.mjs', format, 'UserPromptSubmit')
    const run = spawnSync('sh', ['-c', command], { input: '{}', encoding: 'utf8' })
    assert.equal(run.status, 0, `the ${format} hook exited ${run.status}`)
    assert.equal(run.stdout.trim(), noop)
  }
})

test('the generated hook command survives a path containing an apostrophe', () => {
  const awkward = "/tmp/o'brien/scripts/water.mjs"
  const command = hookCommand(awkward, 'claude', 'UserPromptSubmit')
  const check = spawnSync('sh', ['-n'], { input: command, encoding: 'utf8' })
  assert.equal(check.status, 0, `sh -n rejected the quoted path: ${check.stderr}`)
  // The quoting must survive: the shell has to see the path as one argument.
  const seen = spawnSync('sh', ['-c', `set -- ${shellQuote(awkward)}; printf '%s' "$1"`], { encoding: 'utf8' })
  assert.equal(seen.stdout, awkward)
  assert.ok(command.includes("'\\''"), 'the apostrophe is not escaped the POSIX way')
})

test('shellQuote handles the characters a shell would otherwise act on', () => {
  assert.equal(shellQuote('plain'), "'plain'")
  assert.equal(shellQuote("a'b"), "'a'\\''b'")
  for (const hostile of ['$(whoami)', '`id`', 'a; rm -rf /', 'a b', 'a"b', '\\', 'a\nb']) {
    const seen = spawnSync('sh', ['-c', `set -- ${shellQuote(hostile)}; printf '%s' "$1"`], { encoding: 'utf8' })
    assert.equal(seen.stdout, hostile, `quoting failed for ${JSON.stringify(hostile)}`)
  }
})

test('hookCommand refuses anything that is not an identifier', () => {
  assert.throws(() => hookCommand('/tmp/x.mjs', 'claude; rm -rf /', 'UserPromptSubmit'), /refusing to build/)
  assert.throws(() => hookCommand('/tmp/x.mjs', 'claude', 'User)\n$(id'), /refusing to build/)
  assert.throws(() => hookCommand('/tmp/x.mjs', '', 'UserPromptSubmit'), /refusing to build/)
})

test('a generated hook command produces parseable JSON end to end', async (t) => {
  const { home } = await sandbox(t)
  // Silence the notifier so the suite never raises a real OS notification; the
  // hook command itself is generated exactly as the installer writes it.
  await writeConfig(join(home, 'config.json'), { notify: false })
  const command = hookCommand(SCRIPT, 'claude', 'UserPromptSubmit')
  const first = spawnSync('sh', ['-c', command], {
    input: '{"prompt":"hi"}',
    encoding: 'utf8',
    env: { ...process.env, HYDRATION_COACH_HOME: home },
  })
  assert.equal(first.status, 0)
  assert.doesNotThrow(() => JSON.parse(first.stdout))
  assert.deepEqual(JSON.parse(first.stdout), {}, 'nothing is due on the first run')

  // Force the reminder due, then the hook must inject context.
  const stateFile = join(home, 'state.json')
  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  state.nextDueAt = new Date(Date.now() - 60_000).toISOString()
  await writeFile(stateFile, JSON.stringify(state), 'utf8')

  const second = spawnSync('sh', ['-c', command], {
    input: '{}',
    encoding: 'utf8',
    env: { ...process.env, HYDRATION_COACH_HOME: home },
  })
  assert.equal(second.status, 0)
  const payload = JSON.parse(second.stdout)
  assert.equal(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(payload.hookSpecificOutput.additionalContext, /该喝水了/)
  // The reminder was recorded, so the state file carries the delivery.
  const delivered = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(delivered.stats.reminders, 1)
  assert.equal(delivered.nextDueAt, null)
})

test('installSkill links relatively, is idempotent, and refuses to clobber', async (t) => {
  const { home } = await sandbox(t)
  const root = join(home, 'tools', 'skills')

  const first = await installSkill({ source: canonicalDir(), root })
  assert.equal(first.action, 'linked')
  const stat = await lstat(join(root, SKILL_NAME))
  assert.equal(stat.isSymbolicLink(), true)

  const second = await installSkill({ source: canonicalDir(), root })
  assert.equal(second.action, 'already-linked')

  // A real directory in the way is reported, never overwritten.
  const otherRoot = join(home, 'other', 'skills')
  await mkdir(join(otherRoot, SKILL_NAME), { recursive: true })
  assert.equal((await installSkill({ source: canonicalDir(), root: otherRoot })).action, 'conflict')

  // A symlink pointing somewhere else is somebody else's install.
  const foreignRoot = join(home, 'foreign', 'skills')
  await mkdir(foreignRoot, { recursive: true })
  await symlink('/tmp', join(foreignRoot, SKILL_NAME), 'dir')
  assert.equal((await installSkill({ source: canonicalDir(), root: foreignRoot })).action, 'conflict')

  assert.equal((await uninstallSkill({ source: canonicalDir(), root })).action, 'removed')
  assert.equal((await uninstallSkill({ source: canonicalDir(), root })).action, 'absent')
  assert.equal((await uninstallSkill({ source: canonicalDir(), root: foreignRoot })).action, 'conflict')
})

test('uninstall refuses to delete a real directory that is not our skill', async (t) => {
  const { home } = await sandbox(t)
  const root = join(home, 'strangers', 'skills')
  // Somebody else's folder that happens to share the name.
  await mkdir(join(root, SKILL_NAME), { recursive: true })
  await writeFile(join(root, SKILL_NAME, 'SKILL.md'), '---\nname: somebody-elses-skill\n---\n\nhi\n', 'utf8')
  const refused = await uninstallSkill({ source: canonicalDir(), root })
  assert.equal(refused.action, 'conflict')
  assert.equal(await readFile(join(root, SKILL_NAME, 'SKILL.md'), 'utf8').then(() => true), true, 'the folder must survive')

  // A directory with no SKILL.md at all is equally not ours.
  const bare = join(home, 'bare', 'skills')
  await mkdir(join(bare, SKILL_NAME), { recursive: true })
  assert.equal((await uninstallSkill({ source: canonicalDir(), root: bare })).action, 'conflict')

  // A directory that *is* our copy is removed.
  const copied = join(home, 'copied', 'skills')
  assert.equal((await installSkill({ source: canonicalDir(), root: copied, mode: 'copy' })).action, 'copied')
  assert.equal((await uninstallSkill({ source: canonicalDir(), root: copied })).action, 'removed')
})

test('installSkill honours --dry-run and --copy', async (t) => {
  const { home } = await sandbox(t)
  const dryRoot = join(home, 'dry', 'skills')
  assert.equal((await installSkill({ source: canonicalDir(), root: dryRoot, dryRun: true })).action, 'would-link')
  assert.equal(await lstat(dryRoot).catch(() => undefined), undefined)

  const copyRoot = join(home, 'copy', 'skills')
  assert.equal((await installSkill({ source: canonicalDir(), root: copyRoot, mode: 'copy' })).action, 'copied')
  const copied = await lstat(join(copyRoot, SKILL_NAME))
  assert.equal(copied.isSymbolicLink(), false)
  assert.equal(await readFile(join(copyRoot, SKILL_NAME, 'SKILL.md'), 'utf8').then(text => text.length > 0), true)
})

test('a hook is never written into a config file that does not exist', async (t) => {
  const { home } = await sandbox(t)
  const target = targets(home).find(entry => entry.id === 'claude')
  const result = await installHooks({ target, script: SCRIPT })
  assert.equal(result.action, 'absent')
  assert.equal(await lstat(target.hooks.file).catch(() => undefined), undefined)
})

test('hooks are added in each tool shape and preserve existing entries', async (t) => {
  const { home } = await sandbox(t)
  const list = targets(home)

  const claude = list.find(entry => entry.id === 'claude')
  await writeConfig(claude.hooks.file, {
    language: 'zh-CN',
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine', timeout: 10 }] }] },
  })
  assert.equal((await installHooks({ target: claude, script: SCRIPT })).action, 'added-hook')

  const claudeConfig = JSON.parse(await readFile(claude.hooks.file, 'utf8'))
  assert.equal(claudeConfig.language, 'zh-CN', 'unrelated settings must survive')
  const userEntries = claudeConfig.hooks.UserPromptSubmit
  assert.equal(userEntries[0].hooks[0].command, 'echo mine', 'the user hook must stay first')
  assert.equal(userEntries.length, 2)
  assert.ok(userEntries[1].hooks[0].command.includes(HOOK_MARKER))
  assert.equal(userEntries[1].hooks[0].timeout, 10)
  assert.equal(claudeConfig.hooks.SessionStart.length, 1, 'both declared events are wired')

  const cursor = list.find(entry => entry.id === 'cursor')
  await writeConfig(cursor.hooks.file, { hooks: { beforeSubmitPrompt: [{ command: 'echo cursor', timeout: 5 }] } })
  assert.equal((await installHooks({ target: cursor, script: SCRIPT })).action, 'added-hook')
  const cursorConfig = JSON.parse(await readFile(cursor.hooks.file, 'utf8'))
  assert.equal(cursorConfig.hooks.beforeSubmitPrompt.length, 2)
  assert.equal(cursorConfig.hooks.beforeSubmitPrompt[1].command.includes(HOOK_MARKER), true)
  assert.equal('hooks' in cursorConfig.hooks.beforeSubmitPrompt[1], false, 'the flat shape stays flat')

  const gemini = list.find(entry => entry.id === 'gemini')
  await writeConfig(gemini.hooks.file, { theme: 'dark' })
  assert.equal((await installHooks({ target: gemini, script: SCRIPT })).action, 'added-hook')
  const geminiConfig = JSON.parse(await readFile(gemini.hooks.file, 'utf8'))
  assert.equal(geminiConfig.hooks.BeforeAgent[0].hooks[0].timeout, 10_000, 'Gemini takes milliseconds')

  const workbuddy = list.find(entry => entry.id === 'workbuddy')
  assert.equal((await installHooks({ target: workbuddy, script: SCRIPT })).action, 'unsupported')
})

test('re-running the hook install changes nothing and adds no second backup', async (t) => {
  const { home } = await sandbox(t)
  const claude = targets(home).find(entry => entry.id === 'claude')
  await writeConfig(claude.hooks.file, { hooks: {} })

  assert.equal((await installHooks({ target: claude, script: SCRIPT })).action, 'added-hook')
  const after = await readFile(claude.hooks.file, 'utf8')
  assert.equal((await installHooks({ target: claude, script: SCRIPT })).action, 'unchanged')
  assert.equal(await readFile(claude.hooks.file, 'utf8'), after)

  const backups = (await readdir(join(home, '.claude'))).filter(name => name.includes('bak-hydration'))
  assert.equal(backups.length, 1, 'exactly one backup for one real edit')
})

test('uninstalling hooks removes only our entries', async (t) => {
  const { home } = await sandbox(t)
  const claude = targets(home).find(entry => entry.id === 'claude')
  await writeConfig(claude.hooks.file, {
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine', timeout: 10 }] }] },
  })
  await installHooks({ target: claude, script: SCRIPT })
  assert.equal((await installHooks({ target: claude, script: SCRIPT, uninstall: true })).action, 'removed-hook')

  const config = JSON.parse(await readFile(claude.hooks.file, 'utf8'))
  assert.equal(config.hooks.SessionStart, undefined, 'an emptied event is dropped')
  assert.equal(config.hooks.UserPromptSubmit.length, 1)
  assert.equal(config.hooks.UserPromptSubmit[0].hooks[0].command, 'echo mine')
  assert.equal((await installHooks({ target: claude, script: SCRIPT, uninstall: true })).action, 'unchanged')
})

test('main links every target, reports JSON, and writes nothing on --dry-run', async (t) => {
  const { home, out, io } = await sandbox(t)

  assert.equal(await main(['--dry-run', '--json'], io), 0)
  const dry = JSON.parse(out.at(-1))
  assert.equal(dry.dryRun, true)
  assert.equal(dry.results.every(result => result.action.startsWith('would-')), true)
  assert.equal(await lstat(join(home, '.claude', 'skills')).catch(() => undefined), undefined)

  out.length = 0
  assert.equal(await main(['--json'], io), 0)
  const real = JSON.parse(out.at(-1))
  assert.equal(real.results.some(result => result.action === 'linked'), true)
  assert.equal(await lstat(join(home, '.claude', 'skills', SKILL_NAME)).then(stat => stat.isSymbolicLink()), true)

  out.length = 0
  assert.equal(await main(['--only', 'claude,cursor'], io), 0)
  assert.equal(out.some(line => line.includes('WorkBuddy')), false)

  assert.equal(await main(['--only', 'nope'], io), 2)
})

test('the scripts run when reached through a symlink', async (t) => {
  // Every install this tool performs is a symlink, so the scripts must behave
  // the same through the link as through the real path. A naive
  // `import.meta.url === 'file://' + process.argv[1]` check fails here: Node
  // resolves the module URL but not argv, so the CLI would exit 0 in silence.
  const { home } = await sandbox(t)
  const linked = join(home, 'linked-skill')
  await symlink(canonicalDir(), linked, 'dir')
  const stateHome = join(home, 'state')

  const status = spawnSync('node', [join(linked, 'scripts', 'water.mjs'), 'status', '--home', stateHome], { encoding: 'utf8' })
  assert.equal(status.status, 0, status.stderr)
  assert.match(status.stdout, /喝水提醒/, 'the CLI produced no output through the symlink')

  const armed = spawnSync('node', [join(linked, 'scripts', 'water.mjs'), 'check', '--home', stateHome], { encoding: 'utf8' })
  assert.equal(armed.status, 1)
  assert.match(armed.stdout, /下次提醒/)

  const installer = spawnSync('node', [join(linked, 'scripts', 'install.mjs'), '--dry-run', '--json', '--home', home], { encoding: 'utf8' })
  assert.equal(installer.status, 0, installer.stderr)
  assert.ok(JSON.parse(installer.stdout).results.length > 0, 'the installer produced no results through the symlink')
})

test('main understands --project and --hooks', async (t) => {
  const { home, io } = await sandbox(t)
  const repo = join(home, 'repo')
  await mkdir(repo, { recursive: true })
  await writeConfig(join(home, '.cursor', 'hooks.json'), { hooks: {} })

  assert.equal(await main(['--project', repo, '--hooks'], io), 0)
  assert.equal(await lstat(join(repo, '.cursor', 'skills', SKILL_NAME)).then(stat => stat.isSymbolicLink()), true)
  const cursorConfig = JSON.parse(await readFile(join(home, '.cursor', 'hooks.json'), 'utf8'))
  assert.equal(cursorConfig.hooks.beforeSubmitPrompt.length, 1)
})
