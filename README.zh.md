# hydration-coach · 跨工具喝水提醒 skill

给**所有主流 AI 编程工具**用的喝水提醒技能。一份 `SKILL.md`，Claude Code、Codex、Cursor、Gemini CLI、WorkBuddy 都能读——因为 [Agent Skills](https://agentskills.io) 已经是开放标准，格式统一，只有**发现路径**各家不同。

本仓库用一句话解决路径差异：**一份本体，软链到每个工具的 skills 目录**。

```
~/.agents/skills/hydration-coach      ─┐
~/.claude/skills/hydration-coach       │
~/.codex/skills/hydration-coach        │
~/.cursor/skills/hydration-coach       ├─→ 软链到同一份本体
~/.gemini/skills/hydration-coach       │
~/.workbuddy/skills/hydration-coach    │
~/.config/opencode/skills/hydration-coach ─┘
```

改一次，所有工具同时生效。

## 提醒是怎么真的发生的

skill 本身只是说明文字——Agent Skills **不能跑后台守护进程**，这是标准的边界，不是实现偷懒。所以提醒靠四层，任一层可用即可：

| 层 | 触发时机 | 覆盖工具 | 可靠性 |
| --- | --- | --- | --- |
| **hook**（推荐） | 你每次提交提示词 / 开会话时 | Claude Code、Codex、Cursor、Gemini CLI | 高——真正自动 |
| **会话内指令** | 助手按 skill 说明主动跑 `check` | 全部工具 | 中——依赖模型遵循 |
| **手动** | 你自己敲 `npm run status` / `check` | 全部工具 | 确定 |
| **系统级调度** | launchd / cron / 任务计划程序 | 与 AI 工具无关 | 最高——无需开工具 |

装了 hook 之后，到点时你会同时收到：**系统通知**（macOS/Linux/Windows 原生）+（Claude Code 下）会话里助手顺口说一句。

## 安装

```bash
node scripts/install.mjs --dry-run     # 先看会改什么，不写任何东西
node scripts/install.mjs --hooks       # 装 skill 链接 + 自动提醒 hook
```

可选：

```bash
node scripts/install.mjs --project ~/my-repo   # 同时装项目级目录（可提交进 git 共享给同事）
node scripts/install.mjs --copy                # 用复制代替软链（不支持软链的文件系统）
node scripts/install.mjs --uninstall --hooks   # 完整卸载
npm run status                                  # 看今天喝了多少
```

**两条安全保证**（安装器强制，改代码时请保留）：

1. **只写入已存在的配置文件**。`~/.claude/settings.json` 存在，才说明该工具装了、且它的 hook 格式就是我们认识的那种。文件不存在只报告，**绝不创建**。
2. **改配置前先备份原文**（`<文件>.bak-hydration-<时间戳>`，逐字节），且**幂等**——第二次运行什么也不改，也不会留下第二份备份。

## 命令

```bash
node scripts/water.mjs status                 # 今日进度、剩余、连续天数、下次提醒
node scripts/water.mjs check                  # 到点了吗？exit 0 = 到点
node scripts/water.mjs remind                 # 同 check，并弹系统通知
node scripts/water.mjs log [ml] [--note 咖啡]  # 记一杯（默认按配置杯量）
node scripts/water.mjs snooze [minutes]       # 顺延下次提醒
node scripts/water.mjs config --goal 1800 --min 50 --max 80 --quiet 22:00-08:00
node scripts/water.mjs reset [--all]          # 清运行状态；--all 连日志一起清
node scripts/water.mjs paths                  # 打印配置与状态文件位置
```

`status` / `log` / `check` / `snooze` 都支持 `--json`。

## 配置

配置文件 `~/.hydration-coach/config.json`（`paths` 可打印确切位置），状态在旁边的 `state.json`。两个文件**跨工具共享**——在 Codex 里记的一杯，Claude Code 也认。

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用提醒 |
| `minMinutes` / `maxMinutes` | `40` / `60` | 随机区间。**每次重新抽**，故意不固定 |
| `goalMl` | `2000` | 每日目标 |
| `cupMl` | `250` | 一杯的容量 |
| `snoozeMinutes` | `5` | 默认顺延 |
| `quietHours` | 关闭，`22:00-08:00` | 落窗口内的提醒顺延到窗口结束 |
| `notify` | `true` | 是否弹系统通知 |

区间夹在 `[5, 720]` 分钟，目标 `[200, 20000]` ml。也可以直接编辑 `config.json`。

## 为什么区间必须随机

规律到能被预判的提醒，人会迅速学会无视它——这正是"整点喝水"类 App 被关掉的原因。所以每次从区间里重新抽一个值；嫌烦就**放宽区间**（`--min 60 --max 90`），不要固定成整点。

## 实测过的行为

- 记一杯会**重置区间**——下次提醒从这杯重新算 40–60 分钟。
- **过期锚点不会立刻触发**：安静时段结束或长时间没动之后，下一个提醒仍是完整的 40–60 分钟，而不是一回来就弹。
- **安静时段跨午夜**正确（`22:00-08:00`）。
- 状态文件写坏 → 自动降级为全新状态，不报错。
- hook 命令**永远 exit 0**，脚本丢了也会输出合法空对象——绝不弄坏你的工具。
- 定时记录走"临时文件 + rename"，崩溃不会截断。

## 已知限制（说实话那种）

- **没有 hook 或系统调度时，提醒不会自己出现**。`check` 只在被调用时才算，这是 skill 的机制边界。
- **只有 Claude Code 的会话内注入是官方文档验证过的**。Codex / Cursor / Gemini 的 hook 输出契约我没找到权威文档，所以它们只发系统通知、输出安全空对象（`{}` / `{"continue":true}`），**不会**往会话里注入文字。想升级：确认该工具文档里的输出格式后，把 `scripts/install.mjs` 里它的 `events` 值改成 `claude`，重跑 `--hooks`。细节见 `references/tools.md`。
- **Windows 的 hook 命令是 POSIX sh 写的**，未做 Windows 适配；skill 本身（含状态脚本）在 Windows 上可用。
- **需要 Node 18+**。所有主流 AI 编程工具都通过 npm 分发，所以 node 一定存在。
- 依赖 `osascript` / `notify-send` / PowerShell 弹通知；都没有时只写日志，不报错。

## 和 DSH 插件的关系

另有一个独立项目 `dsh-water-reminder` 是 **DeepSeek Harness 插件**，能力更强：侧边栏倒计时面板、设置页、4 个原生工具、内嵌 skill。它单独一个仓库——本 skill 不依赖它，它也不依赖本 skill。

两者共享同一套领域规则（随机区间、安静时段、连续天数、记一杯重置区间），状态文件各存各的——DSH 插件用 `~/.dsh/water-reminder.json`，本 skill 用 `~/.hydration-coach/`。

## 测试

```bash
npm test        # 54 个测试，无需安装任何依赖
```

| 文件 | 覆盖 |
| --- | --- |
| `test/water.test.js` | 纯逻辑（区间/安静时段/统计/连续天数）+ CLI 退出码、状态持久化、损坏文件降级 |
| `test/install.test.js` | 各工具 hook 形态写入、保留用户原有 hook、幂等、备份、卸载归属校验、`--dry-run`；**并把生成的 hook 命令送进 `sh -n` 语法检查再真正执行**；以及经软链调用脚本的回归测试 |
| `test/skill.test.js` | Agent Skills 规范符合性：name 等于目录名且为 kebab-case、description 在 1024 字符内并含 "Use when"、正文体积、正文引用的路径真实存在 |

`install.test.js` 里那几条 shell 测试是有来历的：第一版生成的命令是 `{ ...; } if [...]`，**缺一个分隔符导致语法错误**，每个 hook 都会静默失败；而软链测试存在，是因为 CLI 一度在经软链调用时静默退出 0、什么都不做——而软链正是本 skill 的安装方式。两者都只有真跑一遍才能发现，于是都成了回归测试。

## 许可

MIT，见 [LICENSE](./LICENSE)。
