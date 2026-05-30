# wmux — Windows Terminal Multiplexer for AI Agents (cmux alternative)

> **wmux is LSP-for-terminals** — a neutral substrate that lets external tools build workflow intelligence on top of any terminal session.
> Native Windows terminal multiplexer with split panes, MCP bridge, and browser automation — purpose-built for running Claude Code, Codex CLI, and Gemini CLI side by side. No WSL required.

[![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white)](https://github.com/openwong2kim/wmux/releases/latest)
[![Electron 41](https://img.shields.io/badge/Electron-41-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/openwong2kim/wmux?style=social)](https://github.com/openwong2kim/wmux)

**Keywords:** Windows tmux, tmux for Windows, terminal multiplexer Windows, AI agent terminal, Claude Code Windows, Codex CLI, Gemini CLI, MCP server, Chrome DevTools Protocol, split terminal, multi-agent terminal, browser automation, ConPTY, xterm.js, Electron terminal.

---

<img width="1578" height="782" alt="1" src="https://github.com/user-attachments/assets/3a75969a-d383-418e-96aa-d3f108c87e9a" />


## Still running one terminal for your AI coding agents on Windows?

**Windows has no native tmux.** Without WSL, there was no clean way to run multiple AI coding agents side by side.

**wmux fixes this.** A native Windows terminal multiplexer + browser automation + MCP server, purpose-built for AI coding agents like Claude Code, Codex CLI, and Gemini CLI. Your AI agent reads the terminal, controls the browser, and works autonomously — all in one window.

```
Claude Code writes the backend on the left
Codex builds the frontend on the right
Gemini CLI runs tests at the bottom
— all on one screen, simultaneously.
```

---

## Install in 30 seconds

**Winget (recommended — no security warning):**
```powershell
winget install openwong2kim.wmux
```

**Chocolatey:**
```powershell
choco install wmux
```

**Installer:** [Download wmux Setup.exe](https://github.com/openwong2kim/wmux/releases/latest)

> **Seeing a "Windows protected your PC" warning?** The installer is not yet Authenticode-signed (free code signing via SignPath is being set up — see **Code signing** below), so Windows SmartScreen flags it as from an unknown publisher. It's safe to proceed — click **More info → Run anyway**. Installing via **winget** or **Chocolatey** above avoids this prompt entirely, since those package managers run in a trusted context.

**One-liner (PowerShell):** downloads the prebuilt Setup.exe from the latest release and verifies its SHA-256 before launching it (no Node/Python/build tools needed).
```powershell
irm https://raw.githubusercontent.com/openwong2kim/wmux/main/install.ps1 | iex
```

Want to build from source instead (needs Node 18+, Python 3, and VS C++ Build Tools — auto-installed)?
```powershell
$env:WMUX_FROM_SOURCE=1; irm https://raw.githubusercontent.com/openwong2kim/wmux/main/install.ps1 | iex
```

**Code signing** — Free Authenticode code signing for Windows builds is provided by [SignPath.io](https://signpath.io/), certificate by the [SignPath Foundation](https://signpath.org/).

---

## Why wmux?

### 1. Your AI agent controls the browser — for real

Tell Claude Code "search Google for this" and it actually does it. wmux's built-in browser connects via Chrome DevTools Protocol (CDP). Click, type, screenshot, execute JS — all done by the AI directly. Works perfectly with React controlled inputs and CJK text (Korean, Japanese, Chinese).

```
You: "Search for wmux on Google"
Claude: browser_open → browser_snapshot → browser_fill(ref=13, "wmux") → browser_press_key("Enter")
→ Actually searches Google. Done.
```

### 2. Multiple terminals in one window

`Ctrl+D` to split, `Ctrl+N` for new workspace. Place multiple terminals and browsers in each workspace. `Ctrl+click` for multiview — see multiple workspaces at once.

ConPTY-based native Windows pseudo-terminal. xterm.js + WebGL hardware-accelerated rendering. 999K lines of scrollback. Terminal content persists even after app restart.

**Tmux-style prefix mode** — `Ctrl+B` then a single action key (split, focus, new workspace…) for muscle-memory terminal navigation. 13 actions, fully rebindable.

**Floating pane** — `` Ctrl+` `` for a Quake-style dropdown terminal that lives outside your main layout. Stays alive across toggles.

**Scroll bookmarks** — `Ctrl+M` marks the current scroll position, `Ctrl+Up/Down` jumps between marks. Indicators render on the gutter.

**Smart right-click** — Windows Terminal style. Selection → instant copy. Empty area → instant paste. Link → small Open / Copy Link menu. Zero modal interrupts.

### 3. No more asking "is it done yet?"

wmux tells you when your AI agent finishes.

- Task complete → desktop notification + taskbar flash
- Abnormal exit → immediate warning
- `git push --force`, `rm -rf`, `DROP TABLE` → dangerous action detection

Not pattern matching — output throughput-based detection. Works with any agent.

### 4. Automatic Claude Code (MCP) integration

Launch wmux and the MCP server registers automatically. Claude Code just works:

| What Claude can do | MCP Tool |
|---|---|
| Open browser | `browser_open` |
| Navigate to URL | `browser_navigate` |
| Take screenshot | `browser_screenshot` |
| Read page structure | `browser_snapshot` |
| Click element | `browser_click` |
| Fill form | `browser_fill` / `browser_type` |
| Execute JS | `browser_evaluate` |
| Press key | `browser_press_key` |
| Read terminal | `terminal_read` |
| Read commands semantically (OSC 133) | `terminal_read_events` |
| Send command | `terminal_send` |
| Manage workspaces | `workspace_list` / `surface_list` / `pane_list` |
| Agent-to-agent messaging | `a2a_send` / `a2a_broadcast` / `a2a_whoami` |
| Delegate tasks across agents | `a2a_task_send` / `a2a_task_query` / `a2a_task_cancel` |
| Company mode coordination | `company_a2a_send` / `company_a2a_inbox` / `company_a2a_status` |

**Multi-agent:** Every browser tool accepts `surfaceId` — each Claude Code session controls its own browser independently. A2A (agent-to-agent) tools route messages between sibling agents in the same wmux instance.

**Programmatic orchestration:** If you want to drive multiple wmux panes from your own script (TypeScript / Node), the MCP surface is wrapped by [`@wmux/orchestrator`](https://github.com/openwong2kim/wmux-orchestrator) — a small client-side SDK that gives you `sendAndWait`, `sendCommandAndWait` (OSC 133 exit codes), atomic pane claim, fan-out, and `agent.lifecycle` event subscription. Composes the primitives above, ships independently from wmux.

### 5. Session persistence — tmux-style, survives Quit, crash, and reboot

wmux never kills your work when you close the window. Like a tmux server, the background daemon owns every PTY and keeps it running; the UI only attaches and detaches. Quit wmux and reopen — your sessions are **still running, processes and all** (a build mid-flight, a `vim` buffer, an `ssh` shell), not just scrollback text.

- **Quit / app restart:** Closing wmux detaches from the daemon, which keeps every PTY process alive. The next launch reattaches each pane to its live session instantly.
- **Crash:** Same path — the daemon outlives the UI, so a renderer or main-process crash never takes your terminals with it.
- **Reboot:** PTYs can't survive a power cycle, so sessions are restored from saved scrollback + working directory instead. wmux auto-starts on login.
- **Full teardown:** When you want everything to actually stop, use the tray's **"Shut down wmux (close all sessions)"**. Closing every pane also lets the daemon idle-shut-down on its own after a few minutes.
- **Auto-update:** Checks for updates via GitHub Releases. Toggle on/off in Settings.

### 6. Security that actually matters

- Token authentication on all IPC pipes
- SSRF protection — blocks private IPs, `file://`, `javascript:` schemes
- PTY input sanitization — prevents command injection
- Randomized CDP port — no fixed debug port
- Memory pressure watchdog — reaps dead sessions at 750MB, blocks new ones at 1GB
- Electron Fuses — cookie encryption on; Node CLI inspect args and `NODE_OPTIONS` env disabled; app loads only from asar. (`RunAsNode` stays **enabled** — the background daemon is spawned as a detached Node process from `wmux.exe` via `ELECTRON_RUN_AS_NODE=1`.)

---

## All Features

### Terminal
- xterm.js + WebGL GPU-accelerated rendering
- ConPTY native Windows pseudo-terminal
- Unicode 11 width tables — correct CJK / emoji rendering for cursor-positioning TUIs (Claude Code, vim)
- Split panes — `Ctrl+D` horizontal, `Ctrl+Shift+D` vertical
- Tabs — multiple surfaces per pane
- **Floating pane** — Quake-style dropdown terminal, dedicated PTY, `` Ctrl+` ``
- **Smart right-click** — selection → instant copy, empty area → instant paste, link → Open / Copy Link menu
- **Scroll bookmarks** — `Ctrl+M` mark, `Ctrl+Up/Down` jump, gutter indicators
- Vi copy mode — `Ctrl+Shift+X`
- Search with regex toggle — `Ctrl+F`
- 999K line scrollback with disk persistence
- **Shell integration (OSC 133)** — semantic prompt / command boundaries for `terminal_read_events`. Auto-injected for pwsh / bash. Constrained Language Mode safe (v2.7.1).

### Keybindings
- **Tmux-style prefix mode** — `Ctrl+B` then action key, 13 default actions (splits, focus, workspaces, palette, floating pane, …)
- Customizable bindings + custom keymaps in Settings
- Reset-to-defaults available

### Workspaces
- Sidebar with drag-and-drop reordering
- `Ctrl+1~9` quick switch
- Multiview — `Ctrl+click` to view multiple workspaces side by side
- **Layout templates** — save current pane layout, restore via Command Palette ("recent" category)
- Full session persistence — layout, tabs, cwd, scrollback all restored
- One-click reset in Settings

### Browser + CDP Automation
- Built-in browser panel — `Ctrl+Shift+L`
- Navigation bar, DevTools, back/forward
- Element Inspector — hover to highlight, click to copy LLM-friendly context
- Full CDP automation: click, fill, type, screenshot, JS eval, key press

### Notifications
- Output throughput-based activity detection
- Taskbar flash + Windows toast notifications
- Process exit alerts
- Notification panel — `Ctrl+I`
- Web Audio sound effects

### Agent Detection
Claude Code, Cursor, Aider, Codex CLI, Gemini CLI, OpenCode, GitHub Copilot CLI
- Detects agent start → activates monitoring
- Critical action warnings

### Daemon Process
- Background session management (survives app restart)
- Scrollback buffer dump and auto-recovery
- Windows startup registration (survives reboot)
- Dead session TTL reaping (24h default)

### Auto-Update
- Automatic update checks via GitHub Releases
- Toggle on/off in Settings > General
- Manual check available in Settings

### Themes
Catppuccin Mocha, Monochrome, Sandstone

### i18n
English, Korean, Japanese, Chinese

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+D` | Split right |
| `Ctrl+Shift+D` | Split down |
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+N` | New workspace |
| `Ctrl+1~9` | Switch workspace |
| `Ctrl+click` | Add to multiview |
| `Ctrl+Shift+G` | Exit multiview |
| `Ctrl+Shift+L` | Open browser |
| `Ctrl+B` then `<key>` | Tmux-style prefix mode (13 actions) |
| `Ctrl+Shift+B` | Toggle sidebar |
| `` Ctrl+` `` | Toggle floating pane (Quake-style) |
| `Ctrl+K` | Command palette |
| `Ctrl+I` | Notifications |
| `Ctrl+,` | Settings |
| `Ctrl+F` | Search terminal (with regex toggle) |
| `Ctrl+M` | Add scrollback bookmark |
| `Ctrl+Up` / `Ctrl+Down` | Jump prev / next bookmark |
| `Ctrl+Shift+X` | Vi copy mode |
| Right-click | Smart copy (selection) / paste (empty) / link menu |
| `F12` | Browser DevTools |

---

## Development

```bash
git clone https://github.com/openwong2kim/wmux.git
cd wmux
npm install
npm start          # Dev mode
npm run make       # Build installer
```

### Requirements (dev only)
- Node.js 18+
- Python 3.x (for node-gyp)
- Visual Studio Build Tools with C++ workload

The `install.ps1` script auto-installs Python and VS Build Tools if missing **only when building from source** (`-FromSource` / `WMUX_FROM_SOURCE=1`). The default one-liner downloads the prebuilt Setup.exe and needs none of these.

---

## Architecture

```
Electron Main Process
├── PTYManager (node-pty / ConPTY)
├── PTYBridge (data forwarding + ActivityMonitor)
├── AgentDetector (gate-based agent status)
├── SessionManager (atomic save with .bak recovery)
├── ScrollbackPersistence (terminal buffer dump/load)
├── PipeServer (Named Pipe JSON-RPC + token auth)
├── McpRegistrar (auto-registers MCP in ~/.claude.json)
├── WebviewCdpManager (CDP proxy to <webview>)
├── DaemonClient (daemon mode connector)
├── AutoUpdater (GitHub Releases feed)
└── ToastManager (OS notifications + taskbar flash)

Renderer Process (React 19 + Zustand)
├── PaneContainer (recursive split layout)
├── Terminal (xterm.js + WebGL + scrollback restore)
├── BrowserPanel (webview + Inspector + CDP)
├── NotificationPanel
├── SettingsPanel (auto-update toggle, workspace reset)
└── Multiview grid

Daemon Process (standalone)
├── DaemonSessionManager (ConPTY lifecycle)
├── RingBuffer (circular scrollback buffer)
├── StateWriter (session suspend/resume)
├── ProcessMonitor (external process watchdog)
├── Watchdog (memory pressure escalation)
└── DaemonPipeServer (Named Pipe RPC + token auth)

MCP Server (stdio)
├── PlaywrightEngine (CDP connection, fast-fail)
├── CDP RPC fallback (screenshot, evaluate, type, click)
└── Claude Code <-> wmux Named Pipe RPC bridge
```

---

## FAQ

**Is wmux a tmux port for Windows?**
No. wmux is a native Windows terminal multiplexer built on ConPTY and Electron, offering tmux-style split panes, prefix keys, and session persistence — without requiring WSL or Cygwin.

**Does wmux work with Claude Code, Codex CLI, and Gemini CLI?**
Yes. wmux automatically detects these AI coding agents and registers an MCP server so Claude Code can drive the built-in browser and read terminal output.

**Can I run multiple AI agents at the same time?**
Yes. Each pane runs an independent PTY. Agents can communicate via the A2A (agent-to-agent) MCP tools for multi-agent workflows.

**Does it require WSL?**
No. wmux is fully native Windows (ConPTY + Electron). No WSL, Cygwin, or MSYS2 needed.

**Why does Windows show a "Windows protected your PC" warning when I run the installer?**
The installer isn't code-signed yet, so Windows SmartScreen flags it as coming from an unknown publisher. It's safe to proceed — click **More info → Run anyway**. To avoid the prompt entirely, install via `winget install openwong2kim.wmux` or `choco install wmux`; those package managers run in a trusted context, so SmartScreen never appears.

---

## Acknowledgments

- [xterm.js](https://xtermjs.org/) — Terminal rendering
- [node-pty](https://github.com/microsoft/node-pty) — Pseudo-terminal
- [Electron](https://www.electronjs.org/) — Desktop framework
- [Playwright](https://playwright.dev/) — Browser automation engine

---

## Note on AI Agents

wmux detects AI coding agents for status display purposes only. It does not call any AI APIs, capture agent outputs, or automate agent interactions. Users are responsible for complying with their AI provider's Terms of Service.

## License

MIT
