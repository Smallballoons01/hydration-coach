#!/usr/bin/env node
/**
 * water.mjs — the portable half of the hydration-coach skill.
 *
 * Agent Skills are instructions plus optional scripts; a skill cannot run a
 * background daemon, so this script is the state and the arithmetic that the
 * instructions lean on. It is deliberately dependency-free Node (the one
 * runtime every AI coding tool is guaranteed to have, since they all ship over
 * npm) so the same file works under Claude Code, Codex, Cursor, Gemini CLI and
 * anything else that can run a shell command.
 *
 * Commands
 *   status             today's intake and the pending reminder, for humans
 *   log [ml]           record a cup (defaults to the configured cup size)
 *   check              exit 0 and print the reminder when one is due, else exit 1
 *   remind             like check, but also raises the OS notification
 *   snooze [minutes]   defer the next reminder
 *   config             read or write the settings
 *   reset              clear runtime overrides, or all data with --all
 *   paths              print where config and state live
 *
 * The state is shared across every tool on the machine, so a cup logged from
 * Codex counts when Claude Code asks.
 *
 * @module hydration-coach/water
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Schema version of both persisted files. */
export const STATE_VERSION = 1

/** Hard floor for a reminder interval: below this, reminders nag. */
export const MIN_BAND_MINUTES = 5

/** Hard ceiling for a reminder interval: half a day. */
export const MAX_BAND_MINUTES = 720

/** Days of intake history kept on disk. */
export const KEEP_DAYS = 90

/** Reminder intervals are drawn from this band by default. */
export const DEFAULT_BAND = { min: 40, max: 60 }

/**
 * Directory holding `config.json` and `state.json`.
 * @param override - explicit `--home` value.
 * @returns the absolute directory.
 */
export function homeDir(override) {
  return override ?? process.env.HYDRATION_COACH_HOME ?? join(homedir(), '.hydration-coach')
}

/** Absolute path of the settings file. */
export function configPath(home) {
  return join(home, 'config.json')
}

/** Absolute path of the runtime state file. */
export function statePath(home) {
  return join(home, 'state.json')
}

const round = value => Math.round(value)

/**
 * Coerce a value into a finite integer inside `[min, max]`.
 * @param value - candidate value.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @param fallback - used when the candidate is not a finite number.
 * @returns the clamped integer.
 */
export function clampNumber(value, min, max, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, round(numeric)))
}

/**
 * Order and bound a reminder band.
 * @param minMinutes - requested lower bound.
 * @param maxMinutes - requested upper bound.
 * @returns `{ min, max }` with `min <= max`.
 */
export function normalizeBand(minMinutes, maxMinutes) {
  const lower = clampNumber(minMinutes, MIN_BAND_MINUTES, MAX_BAND_MINUTES, DEFAULT_BAND.min)
  const upper = clampNumber(maxMinutes, MIN_BAND_MINUTES, MAX_BAND_MINUTES, DEFAULT_BAND.max)
  return lower <= upper ? { min: lower, max: upper } : { min: upper, max: lower }
}

/**
 * Fill a partial configuration with defaults and clamp every numeric field.
 * @param raw - possibly partial configuration.
 * @returns a complete configuration object.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const quiet = input.quietHours !== null && typeof input.quietHours === 'object' ? input.quietHours : {}
  const band = normalizeBand(input.minMinutes, input.maxMinutes)
  return {
    enabled: input.enabled !== false,
    minMinutes: band.min,
    maxMinutes: band.max,
    goalMl: clampNumber(input.goalMl, 200, 20_000, 2000),
    cupMl: clampNumber(input.cupMl, 50, 2000, 250),
    snoozeMinutes: clampNumber(input.snoozeMinutes, 1, 720, 5),
    quietHours: {
      enabled: quiet.enabled === true,
      from: typeof quiet.from === 'string' ? quiet.from : '22:00',
      to: typeof quiet.to === 'string' ? quiet.to : '08:00',
    },
    notify: input.notify !== false,
  }
}

/** A fresh state record. */
export function createState() {
  return {
    version: STATE_VERSION,
    drinks: [],
    nextDueAt: null,
    lastReminderAt: null,
    lastCheckAt: null,
    stats: { reminders: 0, drinks: 0, snoozes: 0 },
  }
}

/**
 * Rebuild state from untrusted JSON, dropping what the schema does not know.
 * @param raw - parsed state file contents.
 * @returns a valid state record.
 */
export function normalizeState(raw) {
  const base = createState()
  if (raw === null || typeof raw !== 'object') return base
  const drinks = Array.isArray(raw.drinks)
    ? raw.drinks
      .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.at === 'string')
      .map(entry => ({
        at: entry.at,
        ml: clampNumber(entry.ml, 1, 5000, 250),
        ...(typeof entry.note === 'string' && entry.note !== '' ? { note: entry.note } : {}),
      }))
      .filter(entry => Number.isFinite(Date.parse(entry.at)))
    : []
  const stats = raw.stats !== null && typeof raw.stats === 'object' ? raw.stats : {}
  const instant = value => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null)
  return {
    version: STATE_VERSION,
    drinks,
    nextDueAt: instant(raw.nextDueAt),
    lastReminderAt: instant(raw.lastReminderAt),
    lastCheckAt: instant(raw.lastCheckAt),
    stats: {
      reminders: clampNumber(stats.reminders, 0, Number.MAX_SAFE_INTEGER, 0),
      drinks: clampNumber(stats.drinks, 0, Number.MAX_SAFE_INTEGER, 0),
      snoozes: clampNumber(stats.snoozes, 0, Number.MAX_SAFE_INTEGER, 0),
    },
  }
}

/**
 * Parse `HH:MM` into minutes since local midnight.
 * @param text - candidate clock string.
 * @returns minutes, or `undefined` when unparseable.
 */
export function parseClock(text) {
  if (typeof text !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/**
 * Normalize a quiet-hours window; an unusable or empty window is disabled.
 * @param quiet - `{ enabled, from, to }`.
 * @returns `{ enabled, from, to, fromMinutes, toMinutes }`.
 */
export function normalizeQuiet(quiet) {
  const fromMinutes = parseClock(quiet?.from)
  const toMinutes = parseClock(quiet?.to)
  return {
    enabled: quiet?.enabled === true && fromMinutes !== undefined && toMinutes !== undefined && fromMinutes !== toMinutes,
    from: quiet?.from ?? '22:00',
    to: quiet?.to ?? '08:00',
    fromMinutes: fromMinutes ?? 22 * 60,
    toMinutes: toMinutes ?? 8 * 60,
  }
}

/**
 * Minutes since local midnight for an instant.
 * @param date - the instant.
 * @returns minutes since midnight.
 */
export function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * Whether an instant falls inside the quiet window (which may wrap midnight).
 * @param date - the instant to test.
 * @param quiet - a normalized quiet setting.
 * @returns whether reminders are held back.
 */
export function inQuietHours(date, quiet) {
  if (!quiet.enabled) return false
  const now = minutesOfDay(date)
  const { fromMinutes, toMinutes } = quiet
  if (fromMinutes < toMinutes) return now >= fromMinutes && now < toMinutes
  return now >= fromMinutes || now < toMinutes
}

/**
 * The instant the quiet window ends at or after `date`.
 * @param date - reference instant.
 * @param quiet - a normalized quiet setting.
 * @returns the resume instant.
 */
export function quietResumeAt(date, quiet) {
  const resume = new Date(date.getTime())
  resume.setHours(Math.floor(quiet.toMinutes / 60), quiet.toMinutes % 60, 0, 0)
  if (resume.getTime() <= date.getTime()) resume.setDate(resume.getDate() + 1)
  return resume
}

/**
 * Inclusive random integer in `[min, max]`.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @param rng - random source in `[0, 1)`.
 * @returns the drawn integer.
 */
export function randomInt(min, max, rng = Math.random) {
  if (max <= min) return min
  const draw = Number(rng())
  // Clamp into `[0, 1)`, not `[0, 1]`: an rng that returns exactly 1 must still
  // land on `max`, never one past it.
  const unit = Number.isFinite(draw) ? Math.min(1 - Number.EPSILON, Math.max(0, draw)) : 0
  return min + Math.floor(unit * (max - min + 1))
}

/**
 * Draw the next reminder instant from the band, honouring quiet hours.
 * @param now - reference instant.
 * @param config - a normalized configuration.
 * @param rng - random source.
 * @returns the next reminder instant, strictly after `now`.
 */
export function drawNextFire(now, config, rng = Math.random) {
  const quiet = normalizeQuiet(config.quietHours)
  const minutes = randomInt(config.minMinutes, config.maxMinutes, rng)
  const candidate = new Date(now.getTime() + minutes * 60_000)
  return inQuietHours(candidate, quiet) ? quietResumeAt(candidate, quiet) : candidate
}

/**
 * The instant the current interval is measured from: whichever came last of the
 * previous reminder, the last drink, and the previous check.
 * @param state - the state record.
 * @param fallback - used when the state carries no history at all.
 * @returns the anchor instant.
 */
export function anchorAt(state, fallback = new Date()) {
  const candidates = [state.lastReminderAt, state.drinks.at(-1)?.at, state.lastCheckAt]
    .filter(value => typeof value === 'string')
    .map(value => Date.parse(value))
    .filter(value => Number.isFinite(value))
  return new Date(candidates.length === 0 ? fallback.getTime() : Math.max(...candidates))
}

/**
 * The instant the pending reminder should be armed for.
 *
 * Measured from the anchor, but never in the past: after quiet hours or a long
 * idle gap the anchor can be hours stale, and a due time already behind us
 * would fire the moment the user comes back. In that case the interval is
 * drawn again from `now`, so a fresh interval is always a full interval away.
 * @param state - the state record.
 * @param config - a normalized configuration.
 * @param now - reference instant.
 * @param rng - random source.
 * @returns the instant to arm for.
 */
export function armNextDue(state, config, now, rng = Math.random) {
  const due = drawNextFire(anchorAt(state, now), config, rng)
  return due.getTime() <= now.getTime() ? drawNextFire(now, config, rng) : due
}

/** Local calendar day key, `YYYY-MM-DD`. */
export function dayKey(date) {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Local `HH:MM` clock string. */
export function clockText(date) {
  return `${`${date.getHours()}`.padStart(2, '0')}:${`${date.getMinutes()}`.padStart(2, '0')}`
}

/** Drop intake entries older than the retention window. */
export function pruneDrinks(drinks, now, keepDays = KEEP_DAYS) {
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000
  return drinks.filter(entry => Date.parse(entry.at) >= cutoff)
}

/** Total intake for one local day. */
export function intakeOn(drinks, key) {
  return drinks.reduce((total, entry) => (dayKey(new Date(entry.at)) === key ? total + entry.ml : total), 0)
}

/**
 * Consecutive days, ending today or yesterday, on which the goal was met.
 * @param drinks - intake log.
 * @param now - reference instant.
 * @param goalMl - the daily goal.
 * @returns streak length in days.
 */
export function goalStreak(drinks, now, goalMl) {
  const cursor = new Date(now.getTime())
  if (intakeOn(drinks, dayKey(cursor)) < goalMl) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while (streak < KEEP_DAYS && intakeOn(drinks, dayKey(cursor)) >= goalMl) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

/** The rolling daily series, today last. */
export function dailySeries(drinks, now, days = 7) {
  const rows = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const cursor = new Date(now.getTime())
    cursor.setDate(cursor.getDate() - offset)
    const key = dayKey(cursor)
    rows.push({ key, ml: intakeOn(drinks, key) })
  }
  return rows
}

/**
 * Whether a reminder is due right now.
 * @param state - the state record.
 * @param config - a normalized configuration.
 * @param now - reference instant.
 * @returns `{ enabled, due, dueAt, inQuietHours }`.
 */
export function dueState(state, config, now) {
  const quiet = normalizeQuiet(config.quietHours)
  if (!config.enabled) return { enabled: false, due: false, dueAt: null, inQuietHours: false }
  if (inQuietHours(now, quiet)) return { enabled: true, due: false, dueAt: null, inQuietHours: true }
  const dueAt = state.nextDueAt === null ? null : new Date(state.nextDueAt)
  return {
    enabled: true,
    due: dueAt !== null && dueAt.getTime() <= now.getTime(),
    dueAt,
    inQuietHours: false,
  }
}

/**
 * The full snapshot every command renders.
 * @param state - the state record.
 * @param config - a normalized configuration.
 * @param now - reference instant.
 * @returns the status snapshot.
 */
export function summarize(state, config, now) {
  const today = dayKey(now)
  const todayMl = intakeOn(state.drinks, today)
  const last = state.drinks.at(-1)
  const due = dueState(state, config, now)
  const minutesUntilNext = due.dueAt === null ? null : Math.max(0, Math.ceil((due.dueAt.getTime() - now.getTime()) / 60_000))
  return {
    enabled: config.enabled,
    today,
    todayMl,
    goalMl: config.goalMl,
    percent: Math.min(100, Math.round((todayMl / config.goalMl) * 100)),
    cups: state.drinks.filter(entry => dayKey(new Date(entry.at)) === today).length,
    cupMl: config.cupMl,
    remainingMl: Math.max(0, config.goalMl - todayMl),
    streakDays: goalStreak(state.drinks, now, config.goalMl),
    band: { min: config.minMinutes, max: config.maxMinutes },
    nextDueAt: due.dueAt?.toISOString() ?? null,
    nextDueText: due.dueAt === null ? null : clockText(due.dueAt),
    minutesUntilNext,
    dueNow: due.due,
    inQuietHours: due.inQuietHours,
    lastDrinkText: last === undefined ? null : clockText(new Date(last.at)),
    lastReminderAt: state.lastReminderAt,
    stats: state.stats,
    week: dailySeries(state.drinks, now, 7),
  }
}

/**
 * The one-line reminder the agent says and the OS notification shows.
 * @param status - a {@link summarize} snapshot.
 * @returns the reminder sentence.
 */
export function reminderSentence(status) {
  if (status.remainingMl === 0) {
    return `今日目标已达成（${status.todayMl}ml）——再补一杯也无妨，接着干活吧。`
  }
  if (status.todayMl === 0) {
    return `该喝水了：今天还一口没喝，先来 ${status.cupMl}ml（今日目标 ${status.goalMl}ml）。`
  }
  return `该喝水了：今天已喝 ${status.todayMl}ml（${status.cups} 杯），还差 ${status.remainingMl}ml 到 ${status.goalMl}ml。`
}

// --- Notifications ---------------------------------------------------------

/** Escape a string for an AppleScript double-quoted literal. */
export function escapeAppleScript(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Escape a string for XML character data. */
export function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/**
 * Build the native-notification command for a platform.
 * @param platformId - `process.platform` value.
 * @param payload - `{ title, message }`.
 * @returns `{ argv }`, or `null` when the platform has no adapter.
 */
export function notificationCommand(platformId, payload) {
  if (platformId === 'darwin') {
    return {
      argv: [
        'osascript', '-e',
        `display notification "${escapeAppleScript(payload.message)}" with title "${escapeAppleScript(payload.title)}" sound name "Glass"`,
      ],
    }
  }
  if (platformId === 'linux') {
    return { argv: ['notify-send', '--app-name', 'hydration-coach', '--urgency', 'normal', payload.title, payload.message] }
  }
  if (platformId === 'win32') {
    const script = [
      'try {',
      '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
      `  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
      `  $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${escapeXml(payload.title)}</text><text>${escapeXml(payload.message)}</text></binding></visual></toast>')`,
      '  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
      "  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('hydration-coach').Show($toast)",
      '} catch { exit 1 }',
    ].join('\n')
    // -EncodedCommand avoids every quoting and encoding trap a .ps1 file hits.
    return { argv: ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] }
  }
  return null
}

/**
 * The stdout contract for one tool's hook.
 *
 * Only Claude Code's `additionalContext` shape is verified, so every other
 * tool gets its documented no-op object: the OS notification is the channel
 * that cannot be misread, and a wrong extra key could break the host tool.
 * `references/tools.md` records how to verify another tool's contract and
 * switch it to the `claude` shape once it is confirmed.
 * @param format - `plain`, `claude`, `codex`, `cursor`, or `gemini`.
 * @param sentence - the reminder, or `null` when nothing is due.
 * @param event - hook event name reported inside the Claude payload.
 * @returns the exact stdout payload.
 */
export function hookOutput(format, sentence, event = 'UserPromptSubmit') {
  if (format === 'plain') return sentence === null ? '' : sentence
  if (format === 'cursor') return '{"continue":true}'
  if (format === 'claude' && sentence !== null) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: `[hydration-coach] ${sentence} 用一句轻松的话提醒我喝水，然后继续当前任务。`,
      },
    })
  }
  return '{}'
}

// --- Persistence -----------------------------------------------------------

/** Read and parse a JSON file, returning `undefined` when absent or corrupt. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write JSON through a temp file plus rename, so a crash cannot truncate it. */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

/**
 * Load config and state.
 * @param home - the hydration-coach home directory.
 * @returns `{ config, state, configFile, stateFile }`.
 */
export async function load(home) {
  const configFile = configPath(home)
  const stateFile = statePath(home)
  const [rawConfig, rawState] = await Promise.all([readJson(configFile), readJson(stateFile)])
  return {
    config: normalizeConfig(rawConfig),
    state: normalizeState(rawState),
    configFile,
    stateFile,
  }
}

/** Persist config and state. */
export async function save(home, config, state) {
  await writeJson(configPath(home), config)
  await writeJson(statePath(home), state)
}

// --- CLI -------------------------------------------------------------------

/**
 * Parse `--flag value` / `--flag=value` / boolean flags into an object.
 * @param argv - arguments after the command.
 * @returns the parsed flags.
 */
export function parseFlags(argv) {
  const flags = {}
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      rest.push(token)
      continue
    }
    const [rawKey, inline] = token.slice(2).split('=', 2)
    const next = argv[index + 1]
    if (inline !== undefined) flags[rawKey] = inline
    else if (next !== undefined && !next.startsWith('--')) {
      flags[rawKey] = next
      index += 1
    } else flags[rawKey] = true
  }
  return { flags, rest }
}

const USAGE = `hydration-coach — portable water reminder

usage: node water.mjs <command> [options]

  status                  today's intake and the pending reminder
  log [ml]                record a cup (default: the configured cup size)
  check                   exit 0 + print the reminder when due, else exit 1
  remind                  like check, but also raises the OS notification
  snooze [minutes]        defer the next reminder
  config                  show settings; with flags, update them
  reset [--all]           clear runtime overrides (--all wipes the intake log)
  paths                   print the config and state file locations

options
  --json                  machine-readable output
  --format <name>         reminder stdout contract: plain (default) | claude |
                          codex | cursor | gemini — see references/tools.md
  --event <name>          hook event name reported inside the claude payload
  --home <dir>            override the hydration-coach home directory
  --min / --max <n>       reminder interval band, in minutes
  --goal <n>              daily goal, in ml
  --cup <n>               cup size, in ml
  --snooze <n>            default snooze, in minutes
  --quiet <from-to|off>   quiet hours, e.g. 22:00-08:00
  --enabled <on|off>      run or pause the reminder loop
  --notify <on|off>       raise OS notifications
  --note <text>           note stored with a logged drink
  --dry-run               with reset/config: show what would change

examples
  node water.mjs check
  node water.mjs log 300 --note coffee
  node water.mjs config --min 50 --max 80 --goal 1800
`

const bool = value => value === true || value === 'on' || value === 'true' || value === 'yes'

/**
 * Run the CLI.
 * @param argv - `process.argv.slice(2)`.
 * @param io - injectable `{ log, error, rng, now, platformId, notify }` for tests.
 * @returns the process exit code.
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? (text => process.stdout.write(text === '' ? '' : `${text}\n`))
  const error = io.error ?? (text => process.stderr.write(`${text}\n`))
  const now = io.now ?? new Date()
  const rng = io.rng ?? Math.random
  const { flags, rest } = parseFlags(argv)
  const command = rest[0]
  const positional = rest.slice(1)
  const home = homeDir(typeof flags.home === 'string' ? flags.home : undefined)

  if (command === undefined || command === 'help' || flags.help === true) {
    log(USAGE)
    return 0
  }
  if (command === 'paths') {
    const { configFile, stateFile } = await load(home)
    log(flags.json === true ? JSON.stringify({ home, configFile, stateFile }) : `config: ${configFile}\nstate:  ${stateFile}`)
    return 0
  }

  const { config, state } = await load(home)

  if (command === 'status') {
    const status = summarize(state, config, now)
    if (flags.json === true) {
      log(JSON.stringify(status))
      return 0
    }
    log([
      `喝水提醒：${status.enabled ? '开启' : '已暂停'}`,
      `今日：${status.todayMl}ml / ${status.goalMl}ml（${status.percent}%，${status.cups} 杯 @${status.cupMl}ml），还差 ${status.remainingMl}ml`,
      `连续达标：${status.streakDays} 天 · 区间 ${status.band.min}-${status.band.max} 分钟`,
      status.nextDueText === null
        ? (status.inQuietHours ? '下次提醒：安静时段内，顺延到窗口结束' : '下次提醒：未排程')
        : `下次提醒：${status.nextDueText}（约 ${status.minutesUntilNext} 分钟后）`,
      status.lastDrinkText === null ? '最近一次饮水：无记录' : `最近一次饮水：${status.lastDrinkText}`,
      `近 7 天（ml）：${status.week.map(row => `${row.key.slice(5)}:${row.ml}`).join(' ')}`,
    ].join('\n'))
    return 0
  }

  if (command === 'log') {
    const ml = clampNumber(positional[0] ?? flags.ml ?? config.cupMl, 1, 5000, config.cupMl)
    const entry = { at: now.toISOString(), ml, ...(typeof flags.note === 'string' ? { note: flags.note } : {}) }
    const next = {
      ...state,
      drinks: pruneDrinks([...state.drinks, entry], now),
      // A cup resets the rhythm: the next reminder counts from this drink.
      nextDueAt: null,
      stats: { ...state.stats, drinks: state.stats.drinks + 1 },
    }
    await save(home, config, next)
    const status = summarize(next, config, now)
    if (flags.json === true) log(JSON.stringify({ ml, ...status }))
    else log(`记下 ${ml}ml —— 今日 ${status.todayMl}ml / ${status.goalMl}ml（${status.cups} 杯）${status.remainingMl === 0 ? '，目标达成 🎉' : `，还差 ${status.remainingMl}ml`}`)
    return 0
  }

  if (command === 'snooze') {
    const minutes = clampNumber(positional[0] ?? flags.minutes ?? config.snoozeMinutes, 1, 720, config.snoozeMinutes)
    const due = new Date(now.getTime() + minutes * 60_000)
    const next = { ...state, nextDueAt: due.toISOString(), stats: { ...state.stats, snoozes: state.stats.snoozes + 1 } }
    await save(home, config, next)
    log(flags.json === true ? JSON.stringify({ minutes, nextDueAt: due.toISOString(), nextDueText: clockText(due) }) : `顺延 ${minutes} 分钟，下次提醒 ${clockText(due)}`)
    return 0
  }

  if (command === 'config') {
    const next = structuredClone(config)
    if (flags.min !== undefined || flags.max !== undefined) {
      const band = normalizeBand(flags.min ?? config.minMinutes, flags.max ?? config.maxMinutes)
      next.minMinutes = band.min
      next.maxMinutes = band.max
    }
    if (flags.goal !== undefined) next.goalMl = clampNumber(flags.goal, 200, 20_000, config.goalMl)
    if (flags.cup !== undefined) next.cupMl = clampNumber(flags.cup, 50, 2000, config.cupMl)
    if (flags.snooze !== undefined) next.snoozeMinutes = clampNumber(flags.snooze, 1, 720, config.snoozeMinutes)
    if (flags.enabled !== undefined) next.enabled = bool(flags.enabled)
    if (flags.notify !== undefined) next.notify = bool(flags.notify)
    if (typeof flags.quiet === 'string') {
      if (flags.quiet === 'off') next.quietHours = { ...next.quietHours, enabled: false }
      else {
        const [from, to] = flags.quiet.split('-')
        const usable = parseClock(from) !== undefined && parseClock(to) !== undefined
        if (!usable) {
          error(`无法解析安静时段 '${flags.quiet}'，需要 from-to 形式，例如 22:00-08:00`)
          return 2
        }
        next.quietHours = { enabled: true, from: from.trim(), to: to.trim() }
      }
    }
    const changed = JSON.stringify(next) !== JSON.stringify(config)
    if (flags['dry-run'] !== true) await save(home, next, state)
    log(JSON.stringify(next, null, 2))
    if (changed && flags['dry-run'] === true) log('（--dry-run：未写入）')
    return 0
  }

  if (command === 'reset') {
    const nextState = flags.all === true ? createState() : { ...state, nextDueAt: null, lastReminderAt: null, lastCheckAt: null }
    const nextConfig = flags.all === true ? normalizeConfig({}) : config
    await save(home, nextConfig, nextState)
    log(flags.all === true ? '已清空全部数据（饮水日志与统计）' : '已清除运行状态（保留饮水日志与配置）')
    return 0
  }

  if (command === 'check' || command === 'remind') {
    const format = typeof flags.format === 'string' ? flags.format : 'plain'
    const event = typeof flags.event === 'string' ? flags.event : 'UserPromptSubmit'
    const isRemind = command === 'remind'
    const current = dueState(state, config, now)

    // Arm the timer on the first check of an interval; the draw is persisted so
    // repeated checks do not reshuffle the due time.
    if (current.enabled && !current.inQuietHours && current.dueAt === null) {
      const due = armNextDue(state, config, now, rng)
      const armed = { ...state, nextDueAt: due.toISOString(), lastCheckAt: now.toISOString() }
      await save(home, config, armed)
      if (isRemind) log(hookOutput(format, null, event))
      else if (flags.json === true) log(JSON.stringify({ due: false, armed: due.toISOString(), nextDueText: clockText(due) }))
      else log(`未到时间；下次提醒 ${clockText(due)}`)
      return isRemind ? 0 : 1
    }

    if (!current.due) {
      const tone = { ...state, lastCheckAt: now.toISOString() }
      await save(home, config, tone)
      if (isRemind) log(hookOutput(format, null, event))
      else if (flags.json === true) log(JSON.stringify({ due: false, nextDueAt: current.dueAt?.toISOString() ?? null }))
      else if (current.inQuietHours) log('安静时段内，不提醒')
      else log(`还没到点；下次提醒 ${current.dueAt === null ? '未排程' : clockText(current.dueAt)}`)
      return isRemind ? 0 : 1
    }

    const before = summarize(state, config, now)
    const sentence = reminderSentence(before)
    const delivered = {
      ...state,
      nextDueAt: null,
      lastReminderAt: now.toISOString(),
      lastCheckAt: now.toISOString(),
      stats: { ...state.stats, reminders: state.stats.reminders + 1 },
    }
    await save(home, config, delivered)

    if (isRemind && config.notify && (io.notify ?? true)) {
      const command = notificationCommand(io.platformId ?? platform(), {
        title: `喝水提醒 · ${before.todayMl}/${before.goalMl}ml`,
        message: sentence,
      })
      if (command !== null && io.spawn !== false) {
        try {
          const { spawnSync } = await import('node:child_process')
          spawnSync(command.argv[0], command.argv.slice(1), { stdio: 'ignore', timeout: 5000 })
        } catch {
          // A failed notification must never break the calling tool's hook.
        }
      }
    }

    if (isRemind) log(hookOutput(format, sentence, event))
    else if (flags.json === true) log(JSON.stringify({ due: true, sentence, ...before }))
    else log(sentence)
    return 0
  }

  error(`未知命令 '${command}'`)
  log(USAGE)
  return 2
}

/**
 * Whether this module was started as the program rather than imported.
 *
 * `import.meta.url` is the resolved real path while `process.argv[1]` is the
 * path as typed, so a plain string comparison fails whenever the script is
 * reached through a symlink — which is exactly how this skill is installed into
 * every tool's skills directory. Comparing real paths keeps
 * `<tool>/skills/hydration-coach/scripts/water.mjs` working.
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
  main().then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write(`hydration-coach: ${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}
/* c8 ignore stop */
