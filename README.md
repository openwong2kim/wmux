<div align="center">

# wmux

### The workspace multiplexer for AI agents.

Run **fleets of Claude Code, Codex & Gemini in parallel** — each agent in its own pane, or fan one prompt out into **N isolated git worktrees** and harvest with **atomic adoption**: tick the hunks you want and they land as one all-or-nothing `git apply` — **your tree takes the whole selection or stays untouched**. Native on **Windows & macOS**, with approval gates, agent-to-agent channels, and an integrated browser your agents can drive. Walk away — after a crash or **full OS reboot**, they come back mid-conversation.

<img width="924" alt="wmux — the workspace multiplexer for AI agents, on Windows and macOS" src="docs/banner.png" />

[![Website](https://img.shields.io/badge/wmux.app-E8A33D?label=&labelColor=151517)](https://www.wmux.app)
[![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white)](https://github.com/openwong2kim/wmux/releases/latest)
[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-000000?logo=apple&logoColor=white)](https://github.com/openwong2kim/wmux/releases/latest)
[![Latest release](https://img.shields.io/github/v/release/openwong2kim/wmux?color=2ea44f&label=release)](https://github.com/openwong2kim/wmux/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/openwong2kim/wmux/total?color=blue&label=downloads)](https://github.com/openwong2kim/wmux/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/openwong2kim/wmux?style=social)](https://github.com/openwong2kim/wmux)

</div>

> **What's a *workspace multiplexer*?** tmux splits a terminal. wmux multiplexes whole **workspaces** — terminals, agents, git worktrees, a browser, and the channels they coordinate over — all owned by a daemon that keeps them running across quits, crashes, and full reboots. **One window. One fleet. Windows & macOS.** *Building in the open since March 2026.*

---

## 📸 See it in action

<!-- ⭐ HERO SLOT — the animated English 4-agent orchestration clip (Claude×2 · Codex · OpenCode, role-based delegation) drops in here once re-recorded in English; promote to the top hero when ready. -->

<p align="center">
<img alt="Four panes in one window — two Claude Code agents, an OpenAI Codex pane, and a test run — with the fleet roster in the side dock" src="docs/hero-grid.png" width="900" />
<br><sub><b>A fleet in one window.</b> Two Claude Code agents, an OpenAI Codex pane, and a test run — split into a grid, each pane its own PTY, with the roster and the orchestrator in the side dock.</sub>
</p>

<p align="center">
<img alt="The orchestrator hands a task to an idle pane and relays the answer back" src="docs/orchestrate-subagent.gif" width="900" />
<br><sub><b>Orchestrate real agents, not just chat.</b> The orchestrator picks an idle pane, hands it the task, and relays the answer back — while the Git dock and the diff stay open next to it.</sub>
</p>

<table>
<tr>
<td width="50%" valign="top">
<img alt="Git tab — pull requests and worktrees in the dock, workspace diff open" src="docs/git-tab.png" />
<br><sub><b>Git in the dock.</b> Pull requests, worktrees, and a live diff for the repo behind your active pane — create a worktree, open it as a workspace, or one-click a PR.</sub>
</td>
<td width="50%" valign="top">
<img alt="Read-only workspace diff opened from the command palette" src="docs/workspace-diff.png" />
<br><sub><b>Workspace diff.</b> "Show Git Diff" opens every staged, unstaged, and untracked change against HEAD — read-only, no IDE creep. Non-git panes get a polite toast.</sub>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img alt="Ask the orchestrator about a hunk — code context attached in the chat" src="docs/diff-ask.png" />
<br><sub><b>Ask about a hunk.</b> From any diff hunk, ask the orchestrator with the repo, file, and code fenced into the message — question and evidence together.</sub>
</td>
<td width="50%" valign="top">
<img alt="Start a loop — objective, per-iteration steps, done-when checklist, and what the loop is allowed to do" src="docs/loop-modal.png" />
<br><sub><b>One-click loops.</b> Point the orchestrator at an objective — with optional per-iteration <b>steps</b> from your <code>.claude</code> skills and a done-when checklist — and it keeps working, event-woken by your agents and surviving restarts. It tells you up front what it may and may not do.</sub>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img alt="Agents coordinating in a channel" src="docs/channels.png" />
<br><sub><b>Channels.</b> Slack-style rooms your agents read, post, and get @-mentioned into — durable, server-verified sender, survives reboot.</sub>
</td>
<td width="50%" valign="top">
<img alt="Resume pill on a recovered pane after the app was quit and reopened" src="docs/resume.png" />
<br><sub><b>Survives reboot.</b> After a quit, crash, or full OS reboot, a recovered pane offers a one-click <b>Resume</b> — straight back to the exact agent conversation, with the shell that was running still running.</sub>
</td>
</tr>
</table>

---

## ⚡ Install in 30 seconds

**Windows** — use a package manager (avoids the SmartScreen warning):

```powershell
winget install openwong2kim.wmux
```

<sub>or `choco install wmux` &nbsp;·&nbsp; [**download Setup.exe**](https://github.com/openwong2kim/wmux/releases/latest) for offline install — the installer is signed with a SignPath *test* certificate for now, so SmartScreen still shows an unknown publisher; winget/choco skip the prompt ([why?](#install-help))</sub>

**macOS** (Apple Silicon)

<sub>[**Download the .dmg**](https://github.com/openwong2kim/wmux/releases/latest) — Developer ID signed, notarized and stapled, so it opens without a Gatekeeper detour — and drag wmux to Applications. On first launch the `wmux` CLI installs itself onto your PATH.</sub>

<sub>Both platforms update themselves in place: wmux checks for a new release every 30 minutes and verifies the download against a published SHA-256 before installing (Windows x64 and macOS arm64).</sub>

**Linux** — experimental AppImage / .deb / .rpm builds are on the [releases page](https://github.com/openwong2kim/wmux/releases/latest).

<sub>Prefer a tour first? [**wmux.app**](https://www.wmux.app) walks through the same features with screenshots.</sub>

---

## 🤔 Why wmux?

|   |   |
|---|---|
| 🧵 **One prompt → N agents → merge the best** | Fan out a prompt into up to 8 tasks, each in an **isolated git worktree** with its own agent pane and a private mission channel. Review each task's diff side by side, **tick the hunks you want** — per file, across files — and adopt that selection in one atomic `git apply` that lands whole or is refused whole, then close it or open a **PR in one click** — leftovers land in a cleanup list, never as mystery folders. |
| 🌿 **Git & GitHub live in the dock** | A **Git tab** shows the worktrees of the repo behind your active pane — create, open as a workspace, or remove — plus its **pull requests and comments** (GitHub via `gh`, GitLab via `glab`, including self-hosted). A read-only **workspace diff** is one palette command away, and from any hunk you can **ask the orchestrator** with the code attached. No alt-tabbing to the browser to see if review feedback landed. |
| 🪟 **Many agents, one window** | Split panes + workspaces. Claude on the left, Codex on the right, Gemini running tests below — simultaneously. Every pane is a plain PTY, so **any CLI agent works**, not just the ones on the box. |
| 🤝 **Agents coordinate, not just coexist** | Agent-to-agent messaging + task delegation, plus **channels** — Slack-style rooms several agents read, post, and get @-mentioned into. An **execute approval gate** stops any agent running code in your workspace without your OK. This is the multi-agent moat. |
| 🧭 **Fleet View cockpit** | `Ctrl+Shift+A` — every agent across every workspace in an **always-on side panel** (other panes stay live), blocked ones floated to the top with a live activity line. Clear every stuck approval from one **inbox**; click any card to jump straight there. |
| 🔔 **Knows when an agent finishes** | Desktop notification + taskbar flash on completion. Flags `rm -rf`, `git push --force`, `DROP TABLE` for your approval. |
| 💾 **Survives quit, crash & reboot** | A tmux-style daemon owns every PTY. Reopen and your sessions are **still running — processes and all.** A pane declared in `wmux.json` is **supervised like an init system** — auto-restarted across crashes and reboots (the app relaunches at login), resuming the *exact* Claude conversation it was on. |
| 🤖 **Zero-config MCP** | Launch wmux and Claude Code just works — **86 tools** (browser, terminal, panes, channels, A2A, fan-out) register themselves, scoped to the workspace that called them. |
| 🌐 **A browser is in the workspace** | Chrome over CDP is integrated, so browser work happens in the same window as the panes and channels — your agent clicks, types, and screenshots through the same MCP surface, with nothing to wire up. Works with React inputs and CJK text. |

---

## ✨ Highlights

- 🧵 **Task fan-out & harvest** — one prompt → N worktree-isolated tasks (idempotent, per-task compensation) · side-by-side diff with **per-hunk adoption** (check individual hunks in any text file — renames, binaries, mode-only and over-cap files stay display-only; the selection lands as one all-or-nothing `git apply`) · close / one-click PR / cleanup list · mission channels record every decision
- 🌿 **Git surface** — a **Git tab** in the dock: worktrees (create / open-as-workspace / remove, no force-delete) + **pull requests & comments** for the active repo (GitHub via `gh`, GitLab via `glab`, self-hosted included) · read-only **workspace diff** from the palette · **ask the orchestrator about a hunk** with the code attached
- 🔁 **One-click loops** — put the orchestrator on an objective with optional per-iteration **steps** (a `/`-picker autocompletes your `.claude` skills), a done-when checklist, and a cadence; it keeps working across restarts, event-woken by your agents, and stopping fails closed to report-only
- 🤝 **A2A multi-agent** — agents message + delegate tasks by pane, gated by a per-pane execute approval, with a pollable task inbox + symmetric reply
- 💬 **Channels** — Slack-style rooms agents read, post, and get @-mentioned into · server-verified sender · durable per-agent inbox · `wmux channel` CLI · operators can self-join private agent rooms (audited)
- 🤖 **Agent supervision** — declare a pane in `wmux.json` (trust-gated) and the daemon keeps it alive: restart policy, backoff, reboot survival
- 🖥️ **Native PTY (ConPTY on Windows, forkpty on macOS) + xterm.js WebGL** rendering · 999K-line scrollback · Unicode 11 (correct CJK / emoji)
- ⌨️ **Tmux-style prefix** (`Ctrl+B` + key, 13 actions) · **floating pane** (`` Ctrl+` ``) · scroll bookmarks
- 🔀 **Multiview** — several workspaces side by side · layout templates · drag-to-reorder sidebar
- 🧩 **Plugin host** — sandboxed iframe plugins with an explicit permission model
- 🛡️ **Token-authed IPC**, SSRF guard, PTY input sanitization, randomized CDP port, Electron Fuses
- 📱 **`wmux web`** — your live panes in a phone browser (PWA-installable), read-only and loopback-only by default; input and network exposure are explicit, warned-about opt-ins
- ⬆️ **In-app auto-update** on Windows and macOS (arm64) — checked every 30 minutes, SHA-256 verified against a published manifest before it installs
- 🎨 **10 UI themes** (Amber by default · Catppuccin · Nightowl · Monochrome · Void · Hinomaru · Taegeuk · Stars & Stripes · Red Dynasty · Custom) and **10 terminal palettes**, light ones included &nbsp;·&nbsp; 🌏 **23 locales scaffolded** — English · 한국어 · 中文 complete, 日本語 in progress — **[translations welcome](https://github.com/openwong2kim/wmux/labels/good%20first%20issue)**

> 💡 **Tip:** point Claude Code at the MCP tools (`browser_open`, `terminal_read`, `pane_list`, `a2a_task_send`, `channel_post`) or script the `wmux` CLI (`wmux send` / `read-screen` / `list-panes` / `wmux channel post`) to orchestrate panes programmatically.

---

<details>
<summary><b>⌨️ &nbsp;Keyboard shortcuts</b></summary>

<br>

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `Ctrl+D` | Split right | `Ctrl+Shift+D` | Split down |
| `Ctrl+T` / `Ctrl+W` | New / close tab | `Ctrl+N` | New workspace |
| `Ctrl+1~9` | Switch workspace | `Ctrl+click` | Add to multiview |
| `Ctrl+Shift+A` | Fleet View | `Ctrl+Shift+L` | Open browser |
| `Ctrl+B` → key | Prefix mode (13 actions) | `` Ctrl+` `` | Floating pane |
| `Ctrl+K` | Command palette | `Ctrl+I` | Notifications |
| `Ctrl+F` | Search (regex) | `Ctrl+M` | Scroll bookmark |
| `Ctrl+Shift+X` | Vi copy mode | `Ctrl+,` | Settings |
| Right-click | Smart copy / paste / link menu | `F12` | Browser DevTools |

<sub>On **macOS**, app shortcuts live on `⌘` instead of `Ctrl` (so `Ctrl+C`, `Ctrl+D`, and friends pass through to the shell as you'd expect).</sub>

</details>

<details>
<summary><b>📦 &nbsp;Full feature list</b></summary>

<br>

**Terminal** — xterm.js + WebGL, native PTY (ConPTY on Windows, forkpty on macOS), Unicode 11 width tables, split panes, tabs, floating pane, smart right-click (selection→copy / empty→paste / link menu), scroll bookmarks, Vi copy mode, regex search, 999K scrollback with disk persistence, shell integration (OSC 133) for semantic command boundaries (Constrained Language Mode safe).

**Keybindings** — Tmux-style prefix mode (`Ctrl+B`, 13 default actions), fully customizable, reset-to-defaults.

**Workspaces** — drag-and-drop sidebar, `Ctrl+1~9` quick switch, multiview, layout templates, full session persistence (layout / tabs / cwd / scrollback), Fleet View cockpit.

**Browser + CDP** — built-in panel (`Ctrl+Shift+L`), nav bar / DevTools / back-forward, element Inspector (hover-highlight, click-to-copy LLM context), full automation: click / fill / type / screenshot / JS eval / key press.

**Notifications** — output-throughput activity detection (not pattern matching, works with any agent), native OS toasts + taskbar flash (Windows) / Dock & menu-bar tray (macOS), process-exit alerts, notification panel (`Ctrl+I`), Web Audio cues.

**Agent detection** — any CLI agent runs in a pane (each pane is a plain PTY; nothing depends on detection). Claude Code, Codex CLI, Gemini CLI, Aider, OpenCode, and GitHub Copilot CLI additionally get first-class detection: start → activates monitoring, warns on critical actions.

**Task journey (fan-out → diff → PR)** — spawn up to 8 `WorkTask` missions from one prompt, each with a dedicated git worktree on a fresh `wtask/*` branch, its own task workspace, a private mission channel, and a file-backed initial prompt. Idempotency-keyed end to end; per-task failures compensate individually, and worktrees are preserved — never force-deleted. Harvest through a diff surface (file tree, unified diff, per-hunk checkboxes across files; the hunks you selected are combined into a single all-or-nothing `git apply` gated by a target snapshot, so the target takes that whole selection or stays untouched — and it is refused as a whole if the target moved, if it has uncommitted changes to those files, or if any selected hunk no longer applies. The selection is resolved against a fresh read of the task worktree at adopt time, so re-read the diff if the agent is still writing to it), comment straight into the mission channel, then close the task (the worktree is removed only after a clean check — dirty output is preserved and the close is held) or open a PR with one click (`gh`-gated, idempotent re-entry). A palette cleanup list scans the worktree root for leftovers, and missions show up in the sidebar and fleet panel.

**Multi-agent (A2A)** — agent-to-agent messaging + task delegation addressed by pane/surface, same-workspace and cross-workspace. Per-pane **execute approval gate** (a remote agent can't spawn a `bypassPermissions` worker in your workspace without your approval). Symmetric reply (a reply returns to the exact pane that asked), pollable task inbox on the EventBus, broadcast, and a unified approval inbox in Fleet View.

**Channels** — Slack-style rooms for a workspace's agents: create / join / invite / post / read / archive, each message carrying a server-verified sender — shown as the sender's pane identity chip plus a per-workspace color badge, so you can tell agents apart at a glance. A durable per-member inbox (unread + @-mention counts, survives reboot), a human-readable right-side dock, and a headless `wmux channel` CLI (`unread` / `read` / `post` / `ack` / `join` / `list`) so a nudged agent can catch up and reply.

**Supervision & wmux.json** — declare panes/agents in a trust-gated `wmux.json` (auto-layout + custom commands). The daemon supervises declared agent panes like an init system: restart policy with backoff across process exits, daemon restarts, and full reboots, with a runaway-crash guard — and it resumes the exact agent conversation on restart, not a fresh shell.

**Plugins** — sandboxed iframe plugin host with a bridge + explicit permission model and pane decorations.

**Daemon** — background session management (survives app restart), scrollback dump + auto-recovery, start-at-login registration on Windows and macOS (relaunches after reboot), dead-session TTL reaping.

**MCP tools** — `browser_*` (open / navigate / screenshot / snapshot / click / fill / type / evaluate / press_key), `terminal_read` / `terminal_read_events` (OSC 133) / `terminal_send` / `terminal_send_key`, `workspace_list` / `surface_list` / `surface_new` / `pane_list` / `pane_split` / `pane_close` / `pane_focus`, `channel_*` (create / post / read / ack / invite / join / list), `a2a_*` agent-to-agent + task delegation, `company_a2a_*`, `wmux_events_poll` / `wmux_search_panes`. Every browser tool takes a `surfaceId` so each session drives its own browser.

</details>

<details>
<summary><b>🏗️ &nbsp;Architecture</b></summary>

<br>

```
Electron Main          Renderer (React 19 + Zustand)     Daemon (standalone)
├── PTYManager         ├── PaneContainer (split tree)     ├── DaemonSessionManager
├── PTYBridge          ├── Terminal (xterm + WebGL)       ├── RingBuffer (scrollback)
├── AgentDetector      ├── BrowserPanel (CDP + Inspector) ├── StateWriter (suspend/resume)
├── SessionManager     ├── NotificationPanel              ├── ProcessMonitor
├── PipeServer (RPC)   ├── SettingsPanel                  ├── Watchdog (memory pressure)
├── McpRegistrar       └── Multiview / Fleet View grid    └── DaemonPipeServer (RPC)
├── DaemonClient
├── AutoUpdater                MCP Server (stdio)
└── ToastManager       ├── PlaywrightEngine (CDP, fast-fail)
                       ├── CDP RPC fallback
                       └── Claude Code ⇄ wmux pipe bridge
```

</details>

<a id="install-help"></a>

<details>
<summary><b>❓ &nbsp;FAQ + install troubleshooting</b></summary>

<br>

**Is wmux a tmux port?** No — tmux was the inspiration, not the base. wmux is a native **workspace multiplexer** on Electron (ConPTY on Windows, forkpty on macOS): tmux-*style* split panes, prefix keys, and session persistence, but it also multiplexes agents, git worktrees, a browser, and channels. No WSL / Cygwin / MSYS2.

**Which Macs are supported?** Apple Silicon (arm64) — download the `.dmg` from [releases](https://github.com/openwong2kim/wmux/releases/latest). It is Developer ID signed, notarized and stapled, so Gatekeeper lets it through on first launch. Intel builds aren't produced right now; open an issue if you need one.

**Can I reach my panes from my phone?** Yes — `wmux web` serves your live panes to a browser (PWA-installable). It is **read-only and loopback-only by default**; `--allow-input` and network exposure are explicit opt-ins. For HTTPS, use the one-command `wmux web --tailscale` path, or terminate it directly with `wmux web --expose --tls-cert <fullchain.pem> --tls-key <privkey.pem>` (add `--allow-host <certificate-dns-name>` so requests for that name are accepted and it is advertised in URLs). Re-supply both TLS paths when re-running the CLI to change options; a CLI start without them and without `--tailscale` explicitly selects HTTP. Bare `--expose` remains HTTP and prints an explicit cleartext warning. Even read-only shows a pane's full scrollback to whoever can reach the port, so do not publish it to the open internet. You can also attach a remote machine's `wmux web` into your own desktop app's sidebar and mirror its panes locally — see [Attach a remote machine's workspaces](docs/how-to/remote-workspaces.md).

**Works with Claude Code / Codex / Gemini?** Yes. wmux auto-detects them and registers an MCP server so they can drive the browser and read terminal output.

**Multiple agents at once?** Yes. Each pane is an independent PTY, and agents coordinate over A2A MCP tools — message each other, delegate tasks by pane, reply to the exact pane that asked, and gate any cross-agent code execution behind your approval.

**Feels heavy, or a workspace switch is slow?** See [docs/performance.md](docs/performance.md) — what runs while a pane is hidden, the daemon's `config.json` knobs, and how to self-diagnose with `wmux doctor`.

**"Windows protected your PC" warning?** The release pipeline already signs `Setup.exe` through [SignPath](https://signpath.io/), but with a *test* certificate while the [SignPath Foundation](https://signpath.org/) OSS certificate is pending — Windows does not trust it, so SmartScreen still reports an unknown publisher. It's safe: click **More info → Run anyway**, or install via **winget** / **Chocolatey** to skip the prompt.

**Installer blocked with no "Run anyway"?** **Smart App Control (SAC)** on Windows 11 can block unsigned binaries outright. Check with `Get-MpComputerStatus | Select-Object SmartAppControlState`. SAC uses cloud reputation, so blocks are often transient — retry later, use winget/choco, or build from source ([#200](https://github.com/openwong2kim/wmux/issues/200)).

**PowerShell one-liner** (downloads the prebuilt Setup.exe, verifies SHA-256, no build tools):
```powershell
irm https://raw.githubusercontent.com/openwong2kim/wmux/main/install.ps1 | iex
```

</details>

---

## 🛠️ Build from source

```powershell
git clone https://github.com/openwong2kim/wmux.git
cd wmux
npm install
npm start          # dev mode
npm run make       # build installer
```

Requires Node 18+ and Python 3.x, plus a native toolchain: VS Build Tools (C++ workload) on Windows — `WMUX_FROM_SOURCE=1 irm …/install.ps1 | iex` auto-installs them — or the Xcode Command Line Tools on macOS (`xcode-select --install`).

---

## 🙌 Contributors

wmux is built in the open. Huge thanks to everyone who's shipped code, squashed bugs, and translated locales:

[![Contributors](https://contrib.rocks/image?repo=openwong2kim/wmux)](https://github.com/openwong2kim/wmux/graphs/contributors)

Community shout-outs to [@snowyukitty](https://github.com/snowyukitty), [@matdac6](https://github.com/matdac6), [@margvez](https://github.com/margvez), [@zer0ken](https://github.com/zer0ken), [@AnandSundar](https://github.com/AnandSundar), [@cloim](https://github.com/cloim), [@cheyras](https://github.com/cheyras), [@junbeom09](https://github.com/junbeom09), [@rayss868](https://github.com/rayss868), [@dev-minggyu](https://github.com/dev-minggyu), and [@alphabeen](https://github.com/alphabeen) for their contributions. 💛

**New here?** Grab a [**good first issue**](https://github.com/openwong2kim/wmux/labels/good%20first%20issue), help translate a locale (한국어 · 中文 complete, 日本語 in progress), or read [**CONTRIBUTING.md**](CONTRIBUTING.md). PRs welcome.

Built on [xterm.js](https://xtermjs.org/), [node-pty](https://github.com/microsoft/node-pty), [Electron](https://www.electronjs.org/), and [Playwright](https://playwright.dev/).

> wmux detects AI coding agents for status display only. It does not call AI APIs, capture agent output, or automate agent interactions. You are responsible for complying with your AI provider's Terms of Service.

## License

[MIT](LICENSE)

<sub>**Keywords:** workspace multiplexer · AI coding agent workspace · agent fleet · multi-agent terminal · git worktree fan-out · Claude Code · Codex CLI · Gemini CLI · MCP server · Chrome DevTools Protocol · browser automation · split terminal · cmux alternative · Windows terminal multiplexer · macOS terminal multiplexer · ConPTY · xterm.js · Electron terminal · tmux for Windows</sub>

<div align="center"><sub>⭐ Star history</sub><br>

[![Star History](https://star-history.dera.page/svg?repos=openwong2kim/wmux&type=Date)](https://star-history.dera.page/#openwong2kim/wmux&Date)

</div>
