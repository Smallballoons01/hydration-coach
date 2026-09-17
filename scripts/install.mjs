#!/usr/bin/env node
/**
 * install.mjs — put the hydration-coach skill where every AI coding tool can
 * find it, and optionally wire the automatic reminder hook.
 *
 * Agent Skills are portable by design: one directory holding `SKILL.md` plus
 * optional `scripts/`. What is *not* portable is the discovery path, so this
 * installer knows each tool's root and links the single canonical directory
 * into all of them. That is the same trick a symlink-per-tool layout uses
 * everywhere; it means one edit updates every tool at once.
 *
 * Two safety rules the installer never breaks:
 *
 * 1. **A hook is only written into a config file that already exists.** The
 *    presence of `~/.claude/settings.json` (or `~/.codex/hooks.json`, …) is the
 *    evidence that the tool is installed *and* that its hook format is the one
 *    this installer knows. A missing file is reported, never created.
 * 2. **Every config edit is backed up first** and is idempotent — running twice
 *    does not add a second hook entry.
 *
 * @module hydration-coach/install
 */

import { access, cp, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { constants, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Kebab-case skill name; must equal the directory name per the spec. */
export const SKILL_NAME = 'hydration-coach'

/** Marker embedded in every hook command, used for idempotency and removal. */
export const HOOK_MARKER = 'hydration-coach'

/** Canonical skill directory (the folder containing this script's parent). */
export function canonicalDir() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/**
 * The tool registry: where each agent looks for skills, and its hook config.
 *
 * `skills` roots are created if missing (a tool that is not installed simply
 * ends up with an unused directory, which is harmless and makes the install
 * idempotent); `hooks.file` is only ever edited when it already exists.
 */
export function targets(home = homedir()) {
  const h = (...parts) => join(home, ...parts)
  return [
    {
      id: 'agents',
      label: '跨工具共享目录 (~/.agents)',
      skills: [h('.agents', 'skills')],
      note: 'Codex、Cursor 等多个工具共同扫描的约定目录',
    },
    {
      id: 'claude',
      label: 'Claude Code',
      skills: [h('.claude', 'skills')],
      hooks: {
        file: h('.claude', 'settings.json'),
        shape: 'nested',
        events: { UserPromptSubmit: 'claude', SessionStart: 'claude' },
      },
    },
    {
      id: 'codex',
      label: 'OpenAI Codex CLI',
      skills: [h('.codex', 'skills')],
      hooks: {
        file: h('.codex', 'hooks.json'),
        shape: 'nested',
        events: { UserPromptSubmit: 'codex', SessionStart: 'codex' },
      },
    },
    {
      id: 'cursor',
      label: 'Cursor',
      skills: [h('.cursor', 'skills')],
      hooks: {
        file: h('.cursor', 'hooks.json'),
        shape: 'flat',
        events: { beforeSubmitPrompt: 'cursor' },
      },
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      skills: [h('.gemini', 'skills')],
      hooks: {
        file: h('.gemini', 'settings.json'),
        shape: 'nested',
        timeoutMs: true,
        events: { BeforeAgent: 'gemini' },
      },
    },
    {
      id: 'workbuddy',
      label: 'WorkBuddy / CodeBuddy',
      skills: [h('.workbuddy', 'skills')],
      note: 'hook 配置未在本机出现时只装 skill',
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      skills: [h('.config', 'opencode', 'skills')],
    },
    {
      id: 'openclaw',
      label: 'OpenClaw',
      skills: [h('.openclaw', 'skills')],
    },
    {
      id: 'kimi',
      label: 'Kimi CLI',
      skills: [h('.kimi', 'skills')],
    },
  ]
}

/**
 * Project-scoped roots, used with `--project <dir>`.
 * @param projectRoot - the repository root.
 * @returns the project-scoped targets.
 */
export function projectTargets(projectRoot) {
  return [
    { id: 'project-agents', label: '.agents/skills（项目级，多工具共用）', skills: [join(projectRoot, '.agents', 'skills')] },
    { id: 'project-claude', label: '.claude/skills（项目级）', skills: [join(projectRoot, '.claude', 'skills')] },
    { id: 'project-codex', label: '.codex/skills（项目级）', skills: [join(projectRoot, '.codex', 'skills')] },
    { id: 'project-cursor', label: '.cursor/skills（项目级）', skills: [join(projectRoot, '.cursor', 'skills')] },
    { id: 'project-gemini', label: '.gemini/skills（项目级）', skills: [join(projectRoot, '.gemini', 'skills')] },
  ]
}

/** Whether a path exists. */
async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Quote a string as a POSIX shell single-quoted literal.
 *
 * A single quote is the one byte that cannot appear inside such a literal, so
 * close the literal, escape the quote, and reopen it. Without this, a checkout
 * path containing an apostrophe (`/Users/o'brien/…`) would break out of the
 * quoting in a command the host tool runs on every prompt.
 * @param text - the raw text.
 * @returns the quoted literal, safe to interpolate into `sh -c`.
 */
export function shellQuote(text) {
  return `'${String(text).split("'").join("'\\''")}'`
}

/** Tokens we allow to be interpolated into a hook command unquoted. */
const SAFE_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*$/

/**
 * The shell command a hook runs.
 *
 * It drains stdin first (hosts write the event JSON there and a closed pipe can
 * surface as an error), guards on the script existing, and always prints a
 * valid no-op object so a missing file can never break the host tool. The
 * trailing comment is the identity marker the installer looks for when it
 * de-duplicates or removes its own entries — the script path alone is not a
 * safe marker, since it follows whatever the containing folder is called.
 * @param script - absolute path of `water.mjs`.
 * @param format - the tool's stdout contract.
 * @param event - the hook event name.
 * @returns the command string.
 */
export function hookCommand(script, format, event) {
  // These come from this file's own registry, but a hook command is executed by
  // the host on every prompt: refuse anything that is not an identifier rather
  // than trusting a future edit to keep the values benign.
  if (!SAFE_TOKEN.test(format) || !SAFE_TOKEN.test(event)) {
    throw new Error(`refusing to build a hook command from format '${format}' / event '${event}'`)
  }
  const noop = format === 'cursor' ? '{"continue":true}' : '{}'
  const quoted = shellQuote(script)
  // Every piece is separated explicitly: a brace group must be terminated with
  // `;` before the next command, and a missing one turns the whole hook into a
  // syntax error that the host tool reports as a failed hook on every prompt.
  return [
    '{ command -p cat >/dev/null 2>&1 || :; };',
    `if [ -f ${quoted} ]; then`,
    `node ${quoted} remind --format=${format} --event=${event};`,
    `else printf '%s' ${shellQuote(noop)}; fi`,
    `# ${HOOK_MARKER}`,
  ].join(' ')
}

/** A timestamped backup path beside the original. */
function backupPath(file) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `${file}.bak-hydration-${stamp}`
}

/** Read JSON, or `undefined` when absent/unparseable. */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write JSON atomically. */
async function writeJson(file, value) {
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/**
 * Install the skill directory into one root.
 * @param options - `{ source, root, mode, dryRun }`.
 * @returns a result record.
 */
export async function installSkill(options) {
  const { source, root, mode = 'link', dryRun = false } = options
  const destination = join(root, SKILL_NAME)
  const existing = await lstat(destination).catch(() => undefined)

  if (existing !== undefined) {
    if (existing.isSymbolicLink()) {
      const current = resolve(dirname(destination), await readlink(destination))
      if (current === resolve(source)) return { path: destination, action: 'already-linked' }
      return { path: destination, action: 'conflict', detail: `指向 ${current}` }
    }
    return { path: destination, action: 'conflict', detail: '已存在同名真实目录' }
  }

  if (dryRun) return { path: destination, action: mode === 'copy' ? 'would-copy' : 'would-link' }
  await mkdir(root, { recursive: true })
  if (mode === 'copy') {
    await cp(source, destination, { recursive: true })
    return { path: destination, action: 'copied' }
  }
  try {
    // A relative link keeps working when the two trees move together (a moved
    // home directory, a relocated checkout), which an absolute link would not.
    await symlink(relative(dirname(destination), resolve(source)) || source, destination, 'dir')
    return { path: destination, action: 'linked' }
  } catch (error) {
    if (error?.code !== 'EXDEV' && error?.code !== 'EPERM') throw error
    await cp(source, destination, { recursive: true })
    return { path: destination, action: 'copied', detail: '符号链接不可用，已改为复制' }
  }
}

/**
 * Whether a real directory is a copy of this skill.
 *
 * The uninstaller deletes trees, so it needs positive evidence of ownership
 * before touching anything that is not a symlink back to the canonical
 * directory. `SKILL.md` naming this skill is that evidence; anything else is
 * reported as a conflict and left alone.
 * @param directory - the candidate directory.
 * @returns whether the directory is a copy of this skill.
 */
async function isOurSkillCopy(directory) {
  const markdown = await readFile(join(directory, 'SKILL.md'), 'utf8').catch(() => undefined)
  if (markdown === undefined) return false
  const name = /^name:\s*(\S+)\s*$/m.exec(markdown)
  return name !== null && name[1] === SKILL_NAME
}

/**
 * Remove a previously installed skill directory.
 *
 * Only removes what it can prove belongs to this skill: a symlink pointing at
 * the canonical directory, or a real directory whose `SKILL.md` names it. A
 * stray directory that merely shares the name is reported, not deleted — an
 * uninstaller that removes a stranger's folder is a data-loss bug.
 * @param options - `{ source, root, dryRun }`.
 * @returns a result record.
 */
export async function uninstallSkill(options) {
  const { source, root, dryRun = false } = options
  const destination = join(root, SKILL_NAME)
  const existing = await lstat(destination).catch(() => undefined)
  if (existing === undefined) return { path: destination, action: 'absent' }

  if (existing.isSymbolicLink()) {
    const current = resolve(dirname(destination), await readlink(destination))
    if (current !== resolve(source)) return { path: destination, action: 'conflict', detail: `指向 ${current}` }
  } else if (!existing.isDirectory()) {
    return { path: destination, action: 'conflict', detail: '既不是目录也不是符号链接' }
  } else if (!(await isOurSkillCopy(destination))) {
    return { path: destination, action: 'conflict', detail: '真实目录且其 SKILL.md 不是本 skill，拒绝删除' }
  }

  if (dryRun) return { path: destination, action: 'would-remove' }
  await rm(destination, { recursive: true, force: true })
  return { path: destination, action: 'removed' }
}

/**
 * Add or remove this plugin's hook entries in one tool's config file.
 * @param options - `{ target, script, dryRun, uninstall }`.
 * @returns a result record.
 */
export async function installHooks(options) {
  const { target, script, dryRun = false, uninstall = false } = options
  const hooks = target.hooks
  if (hooks === undefined) return { file: null, action: 'unsupported' }
  if (!(await exists(hooks.file))) return { file: hooks.file, action: 'absent' }

  const original = await readFile(hooks.file, 'utf8')
  const config = await readJson(hooks.file)
  if (config === null || typeof config !== 'object') return { file: hooks.file, action: 'unparseable' }

  const next = structuredClone(config)
  next.hooks ??= {}
  const timeout = hooks.timeoutMs === true ? 10_000 : 10
  let touched = 0

  for (const [event, format] of Object.entries(hooks.events)) {
    const entries = Array.isArray(next.hooks[event]) ? next.hooks[event] : []
    const stripped = entries
      .map(entry => {
        if (hooks.shape === 'flat') {
          if (typeof entry?.command === 'string' && entry.command.includes(HOOK_MARKER)) {
            touched += 1
            return undefined
          }
          return entry
        }
        const inner = Array.isArray(entry?.hooks) ? entry.hooks : []
        const kept = inner.filter(hook => !(typeof hook?.command === 'string' && hook.command.includes(HOOK_MARKER)))
        if (kept.length === inner.length) return entry
        touched += 1
        return kept.length === 0 ? undefined : { ...entry, hooks: kept }
      })
      .filter(entry => entry !== undefined)

    if (!uninstall) {
      const command = hookCommand(script, format, event)
      if (hooks.shape === 'flat') stripped.push({ command, timeout })
      else stripped.push({ hooks: [{ type: 'command', command, timeout }] })
      touched += 1
    }
    if (stripped.length === 0) delete next.hooks[event]
    else next.hooks[event] = stripped
  }

  // Re-running the installer must not churn the file (or leave a trail of
  // identical backups), so compare the composed result before writing.
  if (JSON.stringify(next) === JSON.stringify(config)) return { file: hooks.file, action: 'unchanged' }
  if (touched === 0) return { file: hooks.file, action: 'unchanged' }
  if (dryRun) return { file: hooks.file, action: uninstall ? 'would-remove-hook' : 'would-add-hook' }

  // The backup is the file's exact bytes, not a re-serialization of it.
  await writeFile(backupPath(hooks.file), original, 'utf8')
  await writeJson(hooks.file, next)
  return { file: hooks.file, action: uninstall ? 'removed-hook' : 'added-hook' }
}

const USAGE = `hydration-coach installer — install the skill for every AI coding tool

usage: node install.mjs [options]

  --dry-run          show what would change, write nothing
  --copy             copy instead of symlinking (for filesystems without links)
  --hooks            also install the automatic reminder hooks
  --uninstall        remove the skill links (and hooks with --hooks)
  --project <dir>    also install into <dir>'s project-scoped skill roots
  --only <ids>       comma-separated target ids, e.g. claude,cursor
  --json             machine-readable result
  --home <dir>       override the home directory the targets are resolved from

Without --hooks the installer only links the skill directory; nothing else on
the machine is touched. Hooks are only written into config files that already
exist, and every edit is backed up first.
`

/**
 * Run the installer.
 * @param argv - `process.argv.slice(2)`.
 * @param io - injectable `{ log, error, home }` for tests.
 * @returns the process exit code.
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? (text => process.stdout.write(`${text}\n`))
  const error = io.error ?? (text => process.stderr.write(`${text}\n`))
  const home = io.home ?? homedir()

  const flags = {}
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) { rest.push(token); continue }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; index += 1 }
    else flags[key] = true
  }

  if (flags.help === true) { log(USAGE); return 0 }

  const dryRun = flags['dry-run'] === true
  const copy = flags.copy === true
  const uninstall = flags.uninstall === true
  const withHooks = flags.hooks === true
  const source = canonicalDir()
  const script = join(source, 'scripts', 'water.mjs')

  let all = targets(flags.home ?? home)
  if (typeof flags.project === 'string') all = all.concat(projectTargets(resolve(flags.project)))
  if (typeof flags.only === 'string') {
    const wanted = new Set(flags.only.split(',').map(id => id.trim()))
    all = all.filter(target => wanted.has(target.id))
    if (all.length === 0) {
      error(`--only 没有匹配到任何目标：${flags.only}`)
      return 2
    }
  }

  const results = []
  for (const target of all) {
    for (const root of target.skills) {
      const result = uninstall
        ? await uninstallSkill({ source, root, dryRun })
        : await installSkill({ source, root, mode: copy ? 'copy' : 'link', dryRun })
      results.push({ target: target.id, label: target.label, kind: 'skill', ...result })
    }
    if (withHooks) {
      results.push({
        target: target.id,
        label: target.label,
        kind: 'hook',
        ...(await installHooks({ target, script, dryRun, uninstall })),
      })
    }
  }

  if (flags.json === true) {
    log(JSON.stringify({ source, dryRun, uninstall, withHooks, results }, null, 2))
  } else {
    const labels = { linked: '已链接', 'already-linked': '已就绪', copied: '已复制', 'would-link': '将链接', 'would-copy': '将复制', removed: '已移除', 'would-remove': '将移除', absent: '不存在', conflict: '冲突(跳过)', unchanged: '未变化', 'added-hook': '已装 hook', 'would-add-hook': '将装 hook', 'removed-hook': '已卸 hook', 'would-remove-hook': '将卸 hook', unsupported: '该工具无 hook 配置', unparseable: '配置无法解析(跳过)' }
    log(`hydration-coach → ${source}${dryRun ? '  [--dry-run]' : ''}`)
    for (const result of results) {
      const where = result.file ?? result.path
      const status = labels[result.action] ?? result.action
      const suffix = result.detail === undefined ? '' : `  (${result.detail})`
      log(`${status.padEnd(14)} ${result.label}${where === undefined ? '' : `  ${where}`}${suffix}`)
    }
    const conflicts = results.filter(result => result.action === 'conflict').length
    if (conflicts > 0) log(`\n${conflicts} 个目标已存在同名目录，未改动。如需接管请先手动删除。`)
    if (!withHooks && !uninstall) {
      log('\n提示：加 --hooks 可让 Claude Code / Codex / Cursor / Gemini CLI 每次提交提示词时自动检查（仅写入已存在的配置文件）。')
    }
  }
  return 0
}

/**
 * Whether this module was started as the program rather than imported.
 *
 * `import.meta.url` is the resolved real path while `process.argv[1]` is the
 * path as typed, so a plain string comparison fails whenever the script is
 * reached through a symlink — which is exactly how this skill is installed into
 * every tool's skills directory.
 * @returns whether to run the CLI.
 */
function isMain() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

/* c8 ignore start -- CLI entry: exercised through main() in tests. */
if (isMain()) {
  main()
    .then(code => { process.exitCode = code })
    .catch(error => {
      process.stderr.write(`hydration-coach installer: ${String(error?.message ?? error)}\n`)
      process.exitCode = 1
    })
}
/* c8 ignore stop */
