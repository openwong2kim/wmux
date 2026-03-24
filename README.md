# wmux — AI Agent Terminal for Windows

> **Run Claude Code + Codex + Gemini CLI side by side.**
> Split terminals, browser automation, MCP integration — the only proper way to use AI agents on Windows.

[![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white)](https://github.com/openwong2kim/wmux/releases/latest)
[![npm](https://img.shields.io/npm/v/@wong2kim/wmux?color=CB3837&logo=npm)](https://www.npmjs.com/package/@wong2kim/wmux)
[![Electron 41](https://img.shields.io/badge/Electron-41-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/openwong2kim/wmux?style=social)](https://github.com/openwong2kim/wmux)

---

## Still using one terminal for your AI coding agents on Windows?

macOS has [cmux](https://github.com/manaflow-ai/cmux) — a tmux-based terminal multiplexer for AI agents.

**Windows has no tmux.** Without WSL, there was no way.

wmux fixes this. Native Windows terminal multiplexer + browser automation + MCP server. Your AI agent reads the terminal, controls the browser, and works autonomously.

```
Claude Code writes the backend on the left
Codex builds the frontend on the right
Gemini CLI runs tests at the bottom
— all on one screen, simultaneously.
```

---

## Install in 30 seconds

**Installer:**

[Download wmux-2.0.0 Setup.exe](https://github.com/openwong2kim/wmux/releases/latest)

**One-liner (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/openwong2kim/wmux/main/install.ps1 | iex
```

**npm (CLI + MCP server):**
```bash
npm install -g @wong2kim/wmux
```

---

## Why wmux?

### 1. Your AI agent controls the browser — for real

Tell Claude Code "search Google for this" and it actually does it.

wmux's built-in browser connects via Chrome DevTools Protocol. Click, type, screenshot, execute JS — all done by the AI directly. Works perfectly with React controlled inputs and CJK text.

```
You: "Search for wmux on Google"
Claude: browser_open → browser_snapshot → browser_fill(ref=13, "wmux") → browser_press_key("Enter")
→ Actually searches Google. Done.
```

### 2. Multiple terminals in one window

`Ctrl+D` to split, `Ctrl+N` for new workspace. Place multiple terminals and browsers in each workspace. `Ctrl+click` for multiview — see multiple workspaces at once.

ConPTY-based native Windows terminal. xterm.js + WebGL hardware-accelerated rendering. 999K lines of scrollback. Terminal content persists even after restart.

### 3. No more asking "is it done yet?"

wmux tells you when your AI agent finishes.

- Task complete → desktop notification + taskbar flash
- Abnormal exit → immediate warning
- `git push --force`, `rm -rf`, `DROP TABLE` → dangerous action detection

Not pattern matching — output throughput-based detection. Works with any agent.

### 4. Automatic Claude Code integration

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
| Send command | `terminal_send` |
| Manage workspaces | `workspace_list` / `surface_list` / `pane_list` |

**Multi-agent:** Every browser tool accepts `surfaceId` — each Claude Code session controls its own browser independently.

### 5. Security that actually matters

- Token authentication on all IPC pipes
- SSRF protection — blocks private IPs, `file://`, `javascript:` schemes
- PTY input sanitization — prevents command injection
- Randomized CDP port — no fixed debug port
- Memory pressure watchdog — reaps dead sessions at 750MB, blocks new ones at 1GB
- Electron Fuses — RunAsNode disabled, cookie encryption enabled

---

## All Features

### Terminal
- xterm.js + WebGL GPU-accelerated rendering
- ConPTY native Windows pseudo-terminal
- Split panes — `Ctrl+D` horizontal, `Ctrl+Shift+D` vertical
- Tabs — multiple surfaces per pane
- Vi copy mode — `Ctrl+Shift+X`
- Search — `Ctrl+F`
- 999K line scrollback with disk persistence

### Workspaces
- Sidebar with drag-and-drop reordering
- `Ctrl+1~9` quick switch
- Multiview — `Ctrl+click` to view multiple workspaces side by side
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
- Dead session TTL reaping (24h default)

### Themes
Catppuccin, Tokyo Night, Dracula, Nord, Gruvbox, Solarized, One Dark, and more.

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
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+K` | Command palette |
| `Ctrl+I` | Notifications |
| `Ctrl+,` | Settings |
| `Ctrl+F` | Search terminal |
| `Ctrl+Shift+X` | Vi copy mode |
| `F12` | Browser DevTools |

---

## CLI

```bash
wmux workspace list
wmux workspace create "backend"
wmux pane split-right
wmux pane send-text "npm test"
wmux notify --title "Done" --body "Tests passed"
wmux browser snapshot
wmux browser click "#submit-btn"
```

---

## Development

```bash
git clone https://github.com/openwong2kim/wmux.git
cd wmux
npm install
npm start           # Dev mode
npm run make        # Build installer
```

### Requirements (dev only)
- Node.js 18+
- Python 3.x (for node-gyp)
- Visual Studio Build Tools with C++ workload

The `install.ps1` script auto-installs Python and VS Build Tools if missing.

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
└── ToastManager (OS notifications + taskbar flash)

Renderer Process (React 19 + Zustand)
├── PaneContainer (recursive split layout)
├── Terminal (xterm.js + WebGL + scrollback restore)
├── BrowserPanel (webview + Inspector + CDP)
├── NotificationPanel
├── SettingsPanel (workspace reset)
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

## Acknowledgments

- [cmux](https://github.com/manaflow-ai/cmux) — The macOS AI agent terminal that inspired wmux
- [xterm.js](https://xtermjs.org/) — Terminal rendering
- [node-pty](https://github.com/microsoft/node-pty) — Pseudo-terminal
- [Electron](https://www.electronjs.org/) — Desktop framework
- [Playwright](https://playwright.dev/) — Browser automation engine

---

## Note on AI Agents

wmux detects AI coding agents for status display purposes only. It does not call any AI APIs, capture agent outputs, or automate agent interactions. Users are responsible for complying with their AI provider's Terms of Service.

## License

MIT
