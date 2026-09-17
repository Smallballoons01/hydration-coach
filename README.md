# hydration-coach — one water reminder for every AI coding tool

A hydration reminder skill that works in **all mainstream AI coding tools** — Claude Code, Codex,
Cursor, Gemini CLI, WorkBuddy, and anything else that reads [Agent Skills](https://agentskills.io).
The format is a standard, so only the *discovery path* differs between tools. This repo solves that
with one trick: **a single canonical directory, symlinked into every tool's skills root.**

```
~/.agents/skills/hydration-coach      ─┐
~/.claude/skills/hydration-coach       │
~/.codex/skills/hydration-coach        │
~/.cursor/skills/hydration-coach       ├─→ one directory, linked everywhere
~/.gemini/skills/hydration-coach       │
~/.workbuddy/skills/hydration-coach    │
~/.config/opencode/skills/hydration-coach ─┘
```

Edit once, every tool follows.

## How the reminder actually reaches you

A skill is instructions; Agent Skills **cannot run a background daemon** — that is the standard's
boundary, not a shortcut here. So delivery has four layers, and any one of them is enough:

| Layer | Fires when | Covers | Reliability |
| --- | --- | --- | --- |
| **Hook** (recommended) | you submit any prompt / start a session | Claude Code, Codex, Cursor, Gemini CLI | high — genuinely automatic |
| **In-session instruction** | the agent runs `check` because the skill says to | every tool | medium — depends on the model |
| **Manual** | you run `npm run status` / `check` | every tool | certain |
| **OS scheduler** | launchd / cron / Task Scheduler | independent of any agent | highest — no tool needed |

With hooks installed you get the **native OS notification** at the due time, plus — on Claude Code —
one short line from the agent in the conversation.

## Install

```bash
node scripts/install.mjs --dry-run     # see exactly what would change, write nothing
node scripts/install.mjs --hooks       # link the skill + wire the automatic reminder
```

Optional:

```bash
node scripts/install.mjs --project ~/my-repo   # also install project-scoped roots (commit them to share)
node scripts/install.mjs --copy                # copy instead of symlink (filesystems without links)
node scripts/install.mjs --uninstall --hooks   # remove links and hooks
npm run status                                  # what have I drunk today
```

**Two safety guarantees** the installer enforces — keep them if you edit it:

1. **A hook is only written into a config file that already exists.** That file's presence proves the
   tool is installed *and* that its hook format is the one this installer knows. A missing file is
   reported, never created.
2. **Every config edit is backed up first** (`<file>.bak-hydration-<timestamp>`, exact bytes) and is
   idempotent — a second run changes nothing and leaves no second backup.

## Commands

```bash
node scripts/water.mjs status                  # today, remaining, streak, next reminder
node scripts/water.mjs check                   # due? exit 0 = yes
node scripts/water.mjs remind                  # like check, plus the OS notification
node scripts/water.mjs log [ml] [--note coffee]
node scripts/water.mjs snooze [minutes]
node scripts/water.mjs config --goal 1800 --min 50 --max 80 --quiet 22:00-08:00
node scripts/water.mjs reset [--all]
node scripts/water.mjs paths                   # where config and state live
```

`status`, `log`, `check`, and `snooze` all take `--json`.

## Configuration

`~/.hydration-coach/config.json`, with state beside it in `state.json` (`paths` prints both). The
files are **shared across tools** — a cup logged in Codex counts when Claude Code asks.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | run the reminder loop |
| `minMinutes` / `maxMinutes` | `40` / `60` | the random interval band, redrawn every time |
| `goalMl` | `2000` | daily goal |
| `cupMl` | `250` | size of one cup |
| `snoozeMinutes` | `5` | default deferral |
| `quietHours` | off, `22:00-08:00` | a draw inside the window resumes when it ends |
| `notify` | `true` | raise OS notifications |

The band is clamped to `[5, 720]` minutes and the goal to `[200, 20000]` ml. `config.json` is also
fine to edit by hand.

## Why the interval must be random

A predictable timer is the one people learn to ignore — which is why "drink water on the hour" apps
get switched off. Every reminder redraws from the band. If it feels like too much, **widen the band**
(`--min 60 --max 90`) rather than fixing it to a round number.

## Behaviour that is verified, not assumed

- Logging a cup **resets the interval**: the next reminder counts from that drink.
- **A stale anchor cannot fire immediately** — after quiet hours or a long idle gap the next reminder
  is still a full 40–60 minutes away, instead of firing the moment you come back.
- Quiet hours **wrap past midnight** correctly (`22:00-08:00`).
- A corrupt state file degrades to a fresh state instead of failing.
- The hook command **always exits 0** and prints a valid no-op object when the script is missing — it
  can never break your tool.
- State is written through a temp file plus rename, so a crash cannot truncate it.

## Known limitations, stated plainly

- **Without a hook or an OS scheduler, no reminder appears on its own.** `check` only counts when
  something calls it; that is the skill mechanism's boundary.
- **Only Claude Code's in-conversation injection is documented-verified.** For Codex, Cursor, and
  Gemini CLI I could not find an authoritative output contract, so they get the OS notification and a
  safe no-op object (`{}` / `{"continue":true}`) and **no** injected text. To upgrade one: confirm its
  documented output shape, change its `events` value in `scripts/install.mjs` to `claude`, and re-run
  `--hooks`. Details in `references/tools.md`.
- **Hook commands are POSIX `sh`**, with no Windows branch; the skill itself (including the state
  script) works on Windows.
- **Node 18+ required.** Every one of these tools ships over npm, so Node is always present.
- Notifications need `osascript` / `notify-send` / PowerShell; without one the reminder is only
  logged, never an error.

## Relationship to the DeepSeek Harness plugin

A separate project, `dsh-water-reminder`, is the **DeepSeek Harness plugin**: richer, with a sidebar
countdown panel, a settings page, four native tools, and an embedded skill. It lives in its own
repository — nothing here depends on it, and nothing there depends on this.

Both share the same domain rules (random band, quiet hours, streaks, drink-resets-interval) while
keeping separate state: the plugin uses `~/.dsh/water-reminder.json`, this skill uses
`~/.hydration-coach/`.

## Tests

Keep the folder named `hydration-coach`. The Agent Skills spec makes the folder name part of the
contract (`name` in the frontmatter must equal it), so a git clone — which keeps the repository name
— is fine, but a GitHub ZIP download arrives as `hydration-coach-main` and needs renaming back. One
test checks exactly that and says so if it fails.

```bash
npm test        # 54 tests, no dependencies to install
```

| File | Coverage |
| --- | --- |
| `test/water.test.js` | Pure logic (band, quiet hours, stats, streaks) plus CLI exit codes, state persistence, corrupt-file degradation |
| `test/install.test.js` | Per-tool hook shapes, preserving the user's existing hooks, idempotency, backups, uninstall ownership checks, `--dry-run` — and it feeds every generated hook command through `sh -n` and then actually executes it |
| `test/skill.test.js` | Agent Skills compliance: `name` equals the directory and is kebab-case, description within 1024 chars and containing "Use when", body size, and that every path the body references really exists |

The `install.test.js` shell tests have a history: the first generated command was `{ ...; } if [...]` —
**one missing separator**, a syntax error that would have made every hook fail silently, and the
symlink test exists because the CLI briefly exited 0 in silence when reached through the very links
the installer creates. Both only surfaced by executing the real thing, so both became regression
tests.

## License

MIT — see [LICENSE](./LICENSE).
