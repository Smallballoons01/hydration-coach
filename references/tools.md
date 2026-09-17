# Cross-tool reference: where each AI coding tool looks for skills

Agent Skills is an open standard (published by Anthropic on 2025-12-18, governed at
`agentskills.io`) and by mid-2026 more than 40 agent products read the same files. What the standard
fixes is the **format** — a directory holding `SKILL.md` with `name` and `description` frontmatter,
plus optional `scripts/`, `references/`, and `assets/` — not the **discovery path**, which every tool
still picks for itself.

That single gap is the whole portability problem. The fix used here is the one the ecosystem
converged on: keep one canonical directory and symlink it into every tool's root.

## Format rules that actually break things

| Rule | Why it bites |
| --- | --- |
| `name` must be kebab-case and **match the parent directory name** | `hydration_coach` as a folder name fails validation; the folder must be `hydration-coach` |
| `SKILL.md` is case-sensitive on some hosts (Gemini CLI is strict) | `skill.md` silently disappears |
| `description` is capped (spec says 1024 chars; the model-facing catalog may truncate to 500) | the description is the *only* thing loaded up front — it is what decides whether the skill ever fires |
| Body should stay under roughly 5000 tokens | longer bodies should push detail into `references/` |
| `allowed-tools` is marked experimental | do not rely on it; support varies per tool |

## Discovery paths

| Tool | Personal skills | Project skills | Hook config | Prompt hook event |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/skills/` | `.claude/skills/` | `~/.claude/settings.json` | `UserPromptSubmit`, `SessionStart` |
| OpenAI Codex CLI | `~/.codex/skills/` | `.codex/skills/` | `~/.codex/hooks.json` | `UserPromptSubmit`, `SessionStart` |
| Cursor | `~/.cursor/skills/` | `.cursor/skills/` | `~/.cursor/hooks.json` | `beforeSubmitPrompt` |
| Gemini CLI | `~/.gemini/skills/` | `.gemini/skills/` | `~/.gemini/settings.json` | `BeforeAgent` |
| WorkBuddy / CodeBuddy | `~/.workbuddy/skills/` | `.workbuddy/skills/` | not present on the inspected machine | — |
| Cross-tool convention | `~/.agents/skills/` | `.agents/skills/` | — | — |
| OpenCode | `~/.config/opencode/skills/` | `.opencode/skills/` | — | — |
| OpenClaw | `~/.openclaw/skills/` | `.openclaw/skills/` | — | — |

Notes:

- Cursor also scans `~/.claude/skills/` and `~/.codex/skills/` as legacy paths, and `~/.agents/skills/`.
- `~/.agents/skills/` is the cross-tool convention several agents now read, so it is the best single
  place to install. The installer writes there *and* into each tool's own root, which costs nothing
  because they are links to one directory.
- Cursor's own built-in skills live in `~/.cursor/skills-cursor/`. That directory is reserved for
  Cursor; never install into it.
- Statements about which path a tool scans come from vendor docs and from inspecting this machine.
  Where a vendor has moved (Codex in particular has been reported to read both `~/.codex/skills/`
  and `~/.agents/skills/`), install into both — a link is cheap and a missed path is invisible.

## Installing everywhere

```bash
node scripts/install.mjs --dry-run              # show every target and what would happen
node scripts/install.mjs                        # link the skill into every tool root
node scripts/install.mjs --hooks                # also wire the automatic reminder
node scripts/install.mjs --project ~/my-repo    # also install project-scoped roots
node scripts/install.mjs --uninstall --hooks    # remove links and hooks
```

Two safety rules the installer enforces, and you should keep if you edit it:

1. **A hook is only ever written into a config file that already exists.** That file's presence is
   the evidence that the tool is installed *and* that its hook format is the one the installer
   knows. A missing file is reported, never created.
2. **Every config edit is backed up first** (`<file>.bak-hydration-<timestamp>`, exact bytes) and is
   idempotent — a second run changes nothing and writes no second backup.

`--copy` exists for filesystems where symlinks are unavailable (some Windows setups); it copies
instead of linking, so later edits to the canonical directory no longer propagate.

## Hook output contracts

A hook receives the event as JSON on **stdin** and its **stdout** is parsed by the host. Getting this
wrong can break the host tool on every prompt, so the generated commands are defensive: drain stdin,
guard on the script existing, and always print a valid no-op object.

| Format | When a reminder is due | Otherwise | Verified |
| --- | --- | --- | --- |
| `claude` | `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"…"}}` | `{}` | yes — Claude Code documents `additionalContext` for `UserPromptSubmit` and `SessionStart` |
| `cursor` | `{"continue":true}` | `{"continue":true}` | shape taken from a working Cursor config on this machine |
| `codex` | `{}` | `{}` | contract not verified — notification only |
| `gemini` | `{}` | `{}` | contract not verified — notification only |
| `plain` | the sentence as text | nothing | for manual and scheduler use |

Unverified formats deliberately emit only the tool's no-op object: the OS notification is the channel
that cannot be misread, and an unexpected key is a risk not worth taking. To upgrade one, confirm the
documented output shape in that tool's hook reference, then change its `events` entry in
`scripts/install.mjs` to `claude` (most tools that cloned Claude's hook events also cloned its
output contract) and re-run `--hooks`.

## Proactive reminders without an agent

A skill cannot run a background daemon, and a hook only fires when you actually use the tool. For a
reminder that arrives whatever you are doing, schedule `remind` with the OS:

```bash
# macOS — a LaunchAgent that checks every 5 minutes
#   ~/Library/LaunchAgents/com.hydration-coach.plist, then:
#   launchctl load -w ~/Library/LaunchAgents/com.hydration-coach.plist
# ProgramArguments: /usr/bin/env node /path/to/scripts/water.mjs remind --format=plain --home ~/.hydration-coach
# StartInterval: 300

# Linux — crontab -e
*/5 * * * * /usr/bin/env node /path/to/scripts/water.mjs remind --format=plain >/dev/null 2>&1

# Windows — Task Scheduler, repeat every 5 minutes:
#   powershell -NoProfile -Command "node 'C:\path\to\scripts\water.mjs' remind --format=plain"
```

`remind` only notifies when the interval has actually elapsed and the quiet-hours window allows it,
so a frequent schedule is safe: it is a poll, not a reminder per run.

## Adding a tool

Add one entry to `targets()` in `scripts/install.mjs`:

```js
{
  id: 'mytool',
  label: 'My Tool',
  skills: [h('.mytool', 'skills')],
  hooks: {
    file: h('.mytool', 'hooks.json'),
    shape: 'nested',                      // 'nested' = {hooks:[{hooks:[…]}]}, 'flat' = {command,…}
    events: { UserPromptSubmit: 'claude' }, // event name → stdout contract
  },
}
```

Only fill in `hooks` after confirming the tool's config file name, its event names, and its stdout
contract. Leaving `hooks` off installs the skill and nothing else, which is always safe.
