/**
 * Unit and CLI tests for `scripts/water.mjs`.
 *
 * The CLI is exercised through `main(argv, io)` with an injected clock, rng and
 * writer, so the tests are deterministic and never touch the real
 * `~/.hydration-coach` directory or raise a real notification.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  anchorAt,
  armNextDue,
  clampNumber,
  clockText,
  createState,
  dailySeries,
  dayKey,
  drawNextFire,
  dueState,
  goalStreak,
  hookOutput,
  inQuietHours,
  intakeOn,
  load,
  main,
  normalizeBand,
  normalizeConfig,
  normalizeQuiet,
  normalizeState,
  notificationCommand,
  parseClock,
  parseFlags,
  pruneDrinks,
  quietResumeAt,
  randomInt,
  reminderSentence,
  summarize,
} from '../scripts/water.mjs'

const at = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute, 0, 0)

/** A temp home plus a capturing writer, torn down with the test. */
async function sandbox(t) {
  const home = await mkdtemp(join(tmpdir(), 'hydration-coach-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const out = []
  const err = []
  const io = {
    home,
    log: text => out.push(text),
    error: text => err.push(text),
    spawn: false,
    notify: false,
    platformId: 'test',
  }
  return { home, out, err, io }
}

test('clampNumber rounds, clamps, and falls back', () => {
  assert.equal(clampNumber(42.4, 0, 100, 10), 42)
  assert.equal(clampNumber(150, 0, 100, 10), 100)
  assert.equal(clampNumber(undefined, 0, 100, 10), 10)
  assert.equal(clampNumber('60', 0, 100, 10), 60)
})

test('normalizeBand orders the endpoints and applies the 40-60 default', () => {
  assert.deepEqual(normalizeBand(undefined, undefined), { min: 40, max: 60 })
  assert.deepEqual(normalizeBand(80, 60), { min: 60, max: 80 })
  assert.deepEqual(normalizeBand(1, 2), { min: 5, max: 5 })
  assert.deepEqual(normalizeBand(0, 9999), { min: 5, max: 720 })
})

test('normalizeConfig completes a partial configuration', () => {
  const base = normalizeConfig({})
  assert.equal(base.enabled, true)
  assert.equal(base.minMinutes, 40)
  assert.equal(base.maxMinutes, 60)
  assert.equal(base.goalMl, 2000)
  assert.equal(base.cupMl, 250)
  assert.equal(base.snoozeMinutes, 5)
  assert.equal(base.notify, true)
  assert.deepEqual(base.quietHours, { enabled: false, from: '22:00', to: '08:00' })

  const custom = normalizeConfig({ enabled: false, minMinutes: 50, maxMinutes: 80, goalMl: 1800, quietHours: { enabled: true, from: '23:00', to: '07:30' } })
  assert.equal(custom.enabled, false)
  assert.equal(custom.goalMl, 1800)
  assert.equal(custom.quietHours.from, '23:00')
  assert.equal(custom.quietHours.enabled, true)
})

test('parseClock and normalizeQuiet reject unusable windows', () => {
  assert.equal(parseClock('22:00'), 1320)
  assert.equal(parseClock('8:05'), 485)
  assert.equal(parseClock('24:00'), undefined)
  assert.equal(normalizeQuiet({ enabled: true, from: 'oops', to: '07:00' }).enabled, false)
  assert.equal(normalizeQuiet({ enabled: true, from: '09:00', to: '09:00' }).enabled, false)
  assert.equal(normalizeQuiet({ enabled: true, from: '23:00', to: '07:00' }).enabled, true)
})

test('inQuietHours handles a window that wraps past midnight', () => {
  const quiet = normalizeQuiet({ enabled: true, from: '22:00', to: '08:00' })
  assert.equal(inQuietHours(at(2026, 9, 17, 23, 30), quiet), true)
  assert.equal(inQuietHours(at(2026, 9, 17, 7, 59), quiet), true)
  assert.equal(inQuietHours(at(2026, 9, 17, 8, 0), quiet), false)
  assert.equal(inQuietHours(at(2026, 9, 17, 12, 0), quiet), false)
})

test('quietResumeAt returns the next window end', () => {
  const quiet = normalizeQuiet({ enabled: true, from: '22:00', to: '08:00' })
  assert.deepEqual(quietResumeAt(at(2026, 9, 17, 23, 30), quiet), at(2026, 9, 18, 8, 0))
  assert.deepEqual(quietResumeAt(at(2026, 9, 17, 3, 0), quiet), at(2026, 9, 17, 8, 0))
})

test('randomInt stays inside its bounds even for a hostile rng', () => {
  assert.equal(randomInt(40, 60, () => 0), 40)
  assert.equal(randomInt(40, 60, () => 0.999999), 60)
  assert.equal(randomInt(40, 60, () => 1), 60)
  assert.equal(randomInt(40, 60, () => 7), 60)
  assert.equal(randomInt(9, 9, () => 0.5), 9)
})

test('drawNextFire draws from the band and clears the quiet window', () => {
  const config = normalizeConfig({ minMinutes: 40, maxMinutes: 40 })
  const now = at(2026, 9, 17, 10, 0)
  assert.deepEqual(drawNextFire(now, config, () => 0), at(2026, 9, 17, 10, 40))

  const quiet = normalizeConfig({ minMinutes: 40, maxMinutes: 40, quietHours: { enabled: true, from: '22:00', to: '08:00' } })
  assert.deepEqual(drawNextFire(at(2026, 9, 17, 21, 40), quiet, () => 0), at(2026, 9, 18, 8, 0))
})

test('anchorAt falls back to the supplied instant when there is no history', () => {
  assert.deepEqual(anchorAt(createState(), at(2026, 9, 17, 8, 0)), at(2026, 9, 17, 8, 0))
})

test('armNextDue never arms a time in the past', () => {
  const config = normalizeConfig({ minMinutes: 40, maxMinutes: 40 })
  const morning = at(2026, 9, 18, 9, 0)
  // The previous check was last night, so the stale anchor would land behind us.
  const stale = { ...createState(), lastCheckAt: at(2026, 9, 17, 23, 0).toISOString() }
  assert.deepEqual(armNextDue(stale, config, morning, () => 0), at(2026, 9, 18, 9, 40))
})

test('anchorAt measures from the latest of reminder, drink, and previous check', () => {
  const state = {
    ...createState(),
    lastCheckAt: at(2026, 9, 17, 9, 0).toISOString(),
    lastReminderAt: at(2026, 9, 17, 10, 0).toISOString(),
    drinks: [{ at: at(2026, 9, 17, 9, 30).toISOString(), ml: 250 }],
  }
  assert.deepEqual(anchorAt(state), at(2026, 9, 17, 10, 0))

  const drank = { ...state, drinks: [{ at: at(2026, 9, 17, 11, 0).toISOString(), ml: 250 }] }
  assert.deepEqual(anchorAt(drank), at(2026, 9, 17, 11, 0))
})

test('dayKey and clockText use the local calendar', () => {
  assert.equal(dayKey(at(2026, 9, 7, 6, 5)), '2026-09-07')
  assert.equal(clockText(at(2026, 9, 7, 6, 5)), '06:05')
})

test('normalizeState drops unknown input and keeps valid history', () => {
  assert.deepEqual(normalizeState(undefined).drinks, [])
  const restored = normalizeState({
    drinks: [
      { at: '2026-09-17T02:00:00.000Z', ml: 300 },
      { at: '2026-09-17T03:00:00.000Z', ml: 250, note: 'coffee' },
      { at: 'nope', ml: 250 },
    ],
    nextDueAt: 'not-a-date',
    stats: { reminders: 3 },
  })
  assert.equal(restored.drinks.length, 2)
  assert.equal(restored.drinks[1].note, 'coffee')
  assert.equal(restored.nextDueAt, null)
  assert.equal(restored.stats.reminders, 3)
  assert.equal(restored.stats.drinks, 0)
})

test('the intake helpers agree with each other', () => {
  const drinks = [
    { at: at(2026, 9, 17, 9, 0).toISOString(), ml: 250 },
    { at: at(2026, 9, 17, 14, 0).toISOString(), ml: 300 },
    { at: at(2026, 9, 16, 14, 0).toISOString(), ml: 2000 },
  ]
  assert.equal(intakeOn(drinks, '2026-09-17'), 550)
  assert.equal(goalStreak(drinks, at(2026, 9, 17, 20, 0), 2000), 1)
  const week = dailySeries(drinks, at(2026, 9, 17, 20, 0), 7)
  assert.equal(week.length, 7)
  assert.equal(week.at(-1).key, '2026-09-17')
  assert.equal(week.at(-1).ml, 550)

  const stale = [{ at: at(2025, 1, 1, 0, 0).toISOString(), ml: 250 }]
  assert.deepEqual(pruneDrinks(stale, at(2026, 9, 17, 0, 0)), [])
})

test('dueState covers disabled, quiet, unscheduled, and due', () => {
  const config = normalizeConfig({})
  const now = at(2026, 9, 17, 12, 0)
  assert.equal(dueState(createState(), config, now).due, false)
  assert.equal(dueState(createState(), normalizeConfig({ enabled: false }), now).enabled, false)

  const quietConfig = normalizeConfig({ quietHours: { enabled: true, from: '11:00', to: '13:00' } })
  const quiet = dueState({ ...createState(), nextDueAt: at(2026, 9, 17, 11, 30).toISOString() }, quietConfig, now)
  assert.equal(quiet.inQuietHours, true)
  assert.equal(quiet.due, false)

  const due = dueState({ ...createState(), nextDueAt: at(2026, 9, 17, 11, 59).toISOString() }, config, now)
  assert.equal(due.due, true)
  const pending = dueState({ ...createState(), nextDueAt: at(2026, 9, 17, 12, 30).toISOString() }, config, now)
  assert.equal(pending.due, false)
})

test('summarize caps the percentage and floors the remainder', () => {
  const config = normalizeConfig({ goalMl: 1000, cupMl: 250 })
  const now = at(2026, 9, 17, 15, 30)
  const state = {
    ...createState(),
    drinks: [
      { at: at(2026, 9, 17, 9, 0).toISOString(), ml: 600 },
      { at: at(2026, 9, 17, 14, 0).toISOString(), ml: 700 },
    ],
    nextDueAt: at(2026, 9, 17, 16, 5).toISOString(),
  }
  const status = summarize(state, config, now)
  assert.equal(status.todayMl, 1300)
  assert.equal(status.percent, 100)
  assert.equal(status.remainingMl, 0)
  assert.equal(status.cups, 2)
  assert.equal(status.nextDueText, '16:05')
  assert.equal(status.minutesUntilNext, 35)
  assert.equal(status.lastDrinkText, '14:00')
})

test('reminderSentence reflects how much is left', () => {
  const config = normalizeConfig({ goalMl: 2000, cupMl: 250 })
  const now = at(2026, 9, 17, 15, 0)
  assert.match(reminderSentence(summarize(createState(), config, now)), /今天还一口没喝/)
  const partial = { ...createState(), drinks: [{ at: at(2026, 9, 17, 9, 0).toISOString(), ml: 750 }] }
  assert.match(reminderSentence(summarize(partial, config, now)), /已喝 750ml/)
  const done = { ...createState(), drinks: [{ at: at(2026, 9, 17, 9, 0).toISOString(), ml: 2000 }] }
  assert.match(reminderSentence(summarize(done, config, now)), /目标已达成/)
})

test('notificationCommand escapes text and covers the three platforms', () => {
  const darwin = notificationCommand('darwin', { title: 't', message: 'say "hi"' })
  assert.equal(darwin.argv[0], 'osascript')
  assert.equal(darwin.argv[2], 'display notification "say \\"hi\\"" with title "t" sound name "Glass"')

  const linux = notificationCommand('linux', { title: 't', message: 'm' })
  assert.deepEqual(linux.argv.slice(0, 4), ['notify-send', '--app-name', 'hydration-coach', '--urgency'])

  const windows = notificationCommand('win32', { title: 'T & <b>', message: 'm' })
  assert.equal(windows.argv[3], '-EncodedCommand')
  const script = Buffer.from(windows.argv[4], 'base64').toString('utf16le')
  assert.match(script, /T &amp; &lt;b&gt;/)
  assert.match(script, /ToastNotificationManager/)

  assert.equal(notificationCommand('aix', { title: 't', message: 'm' }), null)
})

test('hookOutput keeps every unverified format at its safe no-op', () => {
  assert.equal(hookOutput('plain', null), '')
  assert.equal(hookOutput('plain', 'drink up'), 'drink up')
  assert.equal(hookOutput('cursor', 'drink up'), '{"continue":true}')
  assert.equal(hookOutput('codex', 'drink up'), '{}')
  assert.equal(hookOutput('gemini', 'drink up'), '{}')
  assert.equal(hookOutput('claude', null), '{}')

  const payload = JSON.parse(hookOutput('claude', 'drink up', 'SessionStart'))
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.match(payload.hookSpecificOutput.additionalContext, /drink up/)
})

test('parseFlags accepts inline, spaced, and boolean forms', () => {
  const { flags, rest } = parseFlags(['log', '300', '--note', 'coffee', '--json', '--min=50'])
  assert.deepEqual(rest, ['log', '300'])
  assert.equal(flags.note, 'coffee')
  assert.equal(flags.json, true)
  assert.equal(flags.min, '50')
})

test('status, log, snooze, and config round-trip through the state files', async (t) => {
  const { home, io, out } = await sandbox(t)

  assert.equal(await main(['status', '--home', home], io), 0)
  assert.match(out.at(-1), /今日：0ml \/ 2000ml/)

  assert.equal(await main(['log', '300', '--note', 'coffee', '--home', home], io), 0)
  assert.match(out.at(-1), /记下 300ml/)

  const { state } = await load(home)
  assert.equal(state.drinks.length, 1)
  assert.equal(state.drinks[0].note, 'coffee')
  assert.equal(state.nextDueAt, null)

  assert.equal(await main(['snooze', '10', '--home', home], io), 0)
  assert.match(out.at(-1), /顺延 10 分钟/)
  assert.equal((await load(home)).state.stats.snoozes, 1)

  assert.equal(await main(['config', '--goal', '1800', '--min', '80', '--max', '50', '--quiet', '22:00-08:00', '--home', home], io), 0)
  const { config } = await load(home)
  assert.equal(config.goalMl, 1800)
  assert.deepEqual({ min: config.minMinutes, max: config.maxMinutes }, { min: 50, max: 80 })
  assert.equal(config.quietHours.enabled, true)

  assert.equal(await main(['config', '--quiet', 'off', '--home', home], io), 0)
  assert.equal((await load(home)).config.quietHours.enabled, false)

  assert.equal(await main(['config', '--quiet', 'nonsense', '--home', home], io), 2)
})

test('check arms the timer once, then reports due on the next elapse', async (t) => {
  const { home, io, out } = await sandbox(t)
  const at40 = { ...io, rng: () => 0 }

  // First check arms the timer: not due yet.
  assert.equal(await main(['check', '--home', home], { ...at40, now: at(2026, 9, 17, 10, 0) }), 1)
  const armed = (await load(home)).state
  assert.equal(armed.nextDueAt, at(2026, 9, 17, 10, 40).toISOString())

  // A later check that is still early must not reshuffle the due time.
  assert.equal(await main(['check', '--home', home], { ...at40, now: at(2026, 9, 17, 10, 20) }), 1)
  assert.equal((await load(home)).state.nextDueAt, armed.nextDueAt)

  // Past the due time it fires, and the next check re-arms from the reminder.
  assert.equal(await main(['check', '--home', home], { ...at40, now: at(2026, 9, 17, 11, 0) }), 0)
  assert.match(out.at(-1), /该喝水了/)
  const fired = (await load(home)).state
  assert.equal(fired.nextDueAt, null)
  assert.equal(fired.stats.reminders, 1)
  assert.equal(fired.lastReminderAt, at(2026, 9, 17, 11, 0).toISOString())

  assert.equal(await main(['check', '--home', home], { ...at40, now: at(2026, 9, 17, 11, 1) }), 1)
  assert.equal((await load(home)).state.nextDueAt, at(2026, 9, 17, 11, 40).toISOString())
})

test('check stays quiet inside quiet hours and resumes after the window', async (t) => {
  const { home, io } = await sandbox(t)
  await main(['config', '--quiet', '22:00-08:00', '--home', home], io)
  const night = { ...io, now: at(2026, 9, 17, 23, 0), rng: () => 0 }
  assert.equal(await main(['check', '--home', home], night), 1)
  assert.equal((await load(home)).state.nextDueAt, null)

  const morning = { ...io, now: at(2026, 9, 18, 9, 0), rng: () => 0 }
  assert.equal(await main(['check', '--home', home], morning), 1)
  assert.equal((await load(home)).state.nextDueAt, at(2026, 9, 18, 9, 40).toISOString())
})

test('remind always exits 0 so a host hook can never break', async (t) => {
  const { home, io } = await sandbox(t)
  assert.equal(await main(['remind', '--format=claude', '--home', home], { ...io, now: at(2026, 9, 17, 10, 0), rng: () => 0 }), 0)
  assert.equal(await main(['remind', '--format=cursor', '--home', home], { ...io, now: at(2026, 9, 17, 10, 5) }), 0)
  assert.equal(await main(['remind', '--format=claude', '--home', home], { ...io, now: at(2026, 9, 17, 11, 0) }), 0)
})

test('reset clears runtime state, and --all wipes the log too', async (t) => {
  const { home, io } = await sandbox(t)
  await main(['log', '250', '--home', home], io)
  await main(['snooze', '5', '--home', home], io)

  assert.equal(await main(['reset', '--home', home], io), 0)
  const partial = await load(home)
  assert.equal(partial.state.drinks.length, 1)
  assert.equal(partial.state.nextDueAt, null)

  assert.equal(await main(['reset', '--all', '--home', home], io), 0)
  const wiped = await load(home)
  assert.deepEqual(wiped.state.drinks, [])
  assert.equal(wiped.config.goalMl, 2000)
})

test('paths prints both file locations, and unknown input fails loudly', async (t) => {
  const { home, io, out, err } = await sandbox(t)
  assert.equal(await main(['paths', '--json', '--home', home], io), 0)
  const paths = JSON.parse(out.at(-1))
  assert.equal(paths.configFile, join(home, 'config.json'))
  assert.equal(paths.stateFile, join(home, 'state.json'))

  assert.equal(await main(['nonsense', '--home', home], io), 2)
  assert.match(err.at(-1), /未知命令/)

  assert.equal(await main(['help'], io), 0)
  assert.match(out.at(-1), /hydration-coach — portable water reminder/)
})

test('a corrupt state file degrades to a fresh state', async (t) => {
  const { home, io, out } = await sandbox(t)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(home, 'state.json'), '{ not json', 'utf8')
  assert.equal(await main(['status', '--home', home], io), 0)
  assert.match(out.at(-1), /今日：0ml/)
  assert.equal((await load(home)).state.drinks.length, 0)
})

test('the JSON output of status is machine-readable', async (t) => {
  const { home, io, out } = await sandbox(t)
  await main(['log', '250', '--home', home], io)
  assert.equal(await main(['status', '--json', '--home', home], io), 0)
  const status = JSON.parse(out.at(-1))
  assert.equal(status.todayMl, 250)
  assert.equal(status.goalMl, 2000)
  assert.equal(status.week.length, 7)
})

test('the state file keeps its documented shape', async (t) => {
  const { home, io } = await sandbox(t)
  await main(['log', '250', '--home', home], io)
  const raw = JSON.parse(await readFile(join(home, 'state.json'), 'utf8'))
  assert.deepEqual(Object.keys(raw).sort(), ['drinks', 'lastCheckAt', 'lastReminderAt', 'nextDueAt', 'stats', 'version'])
  assert.deepEqual(Object.keys(raw.stats).sort(), ['drinks', 'reminders', 'snoozes'])
})
