---
name: hydration-coach
description: Hydration coach for people who forget to drink water while deep in work. Use when the user mentions water, drinking, hydration, cups, or 喝水, when they ask how much they have drunk today, or at the start of a work session to check whether a break reminder is due. Logs cups, tracks the daily goal and streak, and retunes a randomized 40-60 minute reminder rhythm. Works in any agent that can run a shell command; state is shared across every AI coding tool on the machine.
license: MIT
compatibility: Requires Node.js 18+ to run scripts/water.mjs. Reminder delivery uses the host OS notifier (macOS osascript, Linux notify-send, Windows PowerShell toast). Without Node the skill still works, but only as advice with no persisted state.
metadata:
  version: "1.0.0"
  date: "2026-09-17"
---

# Hydration coach

You keep a developer hydrated. The rule that matters: **remind in one line, record accurately, never lecture.**

`scripts/water.mjs` beside this file owns the state and the arithmetic. You own the conversation. The state file is shared by every AI coding tool on the machine, so a cup logged from Codex counts when Claude Code asks.

## Run this first

Let `SCRIPT` be `<directory containing this SKILL.md>/scripts/water.mjs`.

At the start of a work session, and whenever the user brings up water, run:

```bash
node "$SCRIPT" check
```

- **exit 0** and a reminder line → a reminder is due. Say that line in one short sentence at the start or end of your reply, then continue with the actual task.
- **exit 1** and no reminder line → nothing is due. Do not mention water at all.
- If a hook is installed, this already runs on every prompt and you will instead see an injected `[hydration-coach]` line; react to it the same way and never run `check` twice in one turn.

If `node` is unavailable, tell the user once and continue as a plain coach without state.

## Commands

```bash
node "$SCRIPT" status                 # today's intake, remaining, streak, next reminder
node "$SCRIPT" check                  # is a reminder due? exit 0 = yes
node "$SCRIPT" remind                 # like check, but also raises the OS notification
node "$SCRIPT" log [ml] [--note txt]  # record a cup (default = the configured cup size)
node "$SCRIPT" snooze [minutes]       # defer the next reminder
node "$SCRIPT" config --min 50 --max 80 --goal 1800 --cup 300 --quiet 22:00-08:00 --enabled on
node "$SCRIPT" reset [--all]          # clear runtime state (--all wipes the log too)
```

Add `--json` to `status`, `log`, `check`, or `snooze` for machine-readable output.

## When to call what

| The user says | Do this |
| --- | --- |
| "喝了" / "干了一杯" / "just drank" | `log` — with `ml` only if they gave a number |
| "今天喝了多少" / "how much today" | `status`, then answer with one line |
| "等会儿" / "not now" / clearly mid-task | `snooze` |
| "别提醒了" / "太吵了" | `config --enabled off`, and stop mentioning water afterwards |
| "40 分钟太频繁" / "太慢了" | `config --min 60 --max 90` (keep the band, never a fixed interval) |
| "我要减脂/健身，目标多少" | estimate 30 ml × body weight (kg) and propose it, then `config --goal` |

## Rules

- **One line, then move on.** A reminder must never derail the task or become a health lecture.
- **Never invent numbers.** Read them from `status`; do not sum in your head.
- **Never make the interval regular.** The band is randomized on purpose: a predictable timer is the one people learn to ignore. Widen the band rather than fixing it.
- **Log the truth.** Coffee and tea count as fluid; sugar drinks do not unless the user says so. The log is append-only — do not merge or de-duplicate entries.
- **Respect "stop".** Once the user disables reminders, do not raise hydration again in that session.
- **No medical claims.** If the user mentions swelling, abnormal urine output, or dizziness, suggest seeing a doctor; do not diagnose. Do not push water targets on someone who says a clinician limited their fluid intake.

## Configuration

Settings live in `config.json` next to the state file (`node "$SCRIPT" paths` prints both). Defaults: 40–60 minute band, 2000 ml daily goal, 250 ml cup, quiet hours off.

- Quiet hours hold a reminder back and release it when the window ends (the window may wrap past midnight).
- Logging a cup resets the interval, so the next reminder counts from that drink.
- Nothing runs in the background on its own: outside a hook, the reminder only surfaces when you run `check`/`remind`. For real proactive reminders independent of any agent, install an OS-level scheduler — see `references/tools.md`.

## Reference

`references/tools.md` lists where each AI coding tool discovers skills, how to install this one everywhere with `scripts/install.mjs`, and how to verify a tool's hook contract.
