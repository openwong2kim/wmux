# wmux

**AI Agent Terminal for Windows**

Run Claude Code, Codex, Gemini CLI side by side — with built-in browser, smart notifications, and MCP integration.

Inspired by [cmux](https://github.com/manaflow-ai/cmux) (macOS), wmux brings the same philosophy to Windows: **a primitive, not a solution.** Composable building blocks for multi-agent workflows.

![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows)
![Electron](https://img.shields.io/badge/Electron-41-47848F?logo=electron)
![License](https://img.shields.io/badge/License-MIT-green)

---

## Install

**Download:** [wmux-1.1.1 Setup.exe](https://github.com/openwong2kim/wmux/releases/latest)

Or build from source:
```powershell
irm https://raw.githubusercontent.com/openwong2kim/wmux/main/install.ps1 | iex
```

---

## Why wmux?

| Problem | wmux |
|---------|------|
| Windows has no cmux | Native Windows terminal multiplexer for AI agents |
| Agents can't see the browser | Built-in browser with MCP — Claude clicks, fills, evaluates JS |
| "Is it done yet?" | Smart activity-based notifications + taskbar flash |
| Can't compare agents | Multiview — Ctrl+click workspaces to view side by side |
| Hard to describe UI elements to LLM | Inspector — click any element, LLM-friendly context copied |

---

## Features

### Terminal
- **xterm.js + WebGL** GPU-accelerated rendering
- **ConPTY** native Windows pseudo-terminal
- **Split panes** — `Ctrl+D` horizontal, `Ctrl+Shift+D` vertical
- **Tabs** — multiple surfaces per pane
- **Vi copy mode** — `Ctrl+Shift+X`
- **Search** — `Ctrl+F`
- **Unlimited scrollback** — 999,999 lines default

### Workspaces
- Sidebar with drag-and-drop reordering
- `Ctrl+1` ~ `Ctrl+9` quick switch
- **Multiview** — `Ctrl+click` workspaces to split-view them simultaneously
- `Ctrl+Shift+G` to exit multiview
- Session persistence — everything restored on restart

### Browser
- Built-in browser panel — `Ctrl+Shift+L`
- Navigation bar, DevTools, back/forward
- **Element Inspector** — magnifying glass button to inspect elements
  - Hover to highlight, click to copy LLM-friendly context:
    ```
    [Inspector] Google (https://www.google.com/)
    selector: input.gLFyf
    <input type="text" name="q" aria-label="Search">
    text: ""
    parent: div.RNNXgb > siblings: button"Google Search", button"I'm Feeling Lucky"
    ```
  - Paste directly into Claude — it understands the element immediately

### Notifications
- **Activity-based detection** — monitors output throughput, no fragile pattern matching
- **Taskbar flash** — orange flash when notifications arrive while unfocused
- **Windows toast** — native OS notification with click-to-focus
- **Process exit alerts** — notifies on non-zero exit codes
- **Notification panel** — `Ctrl+I`, read/unread tracking, per-workspace filtering
- **Sound** — Web Audio synthesized tones per notification type

### MCP Server (Claude Code Integration)
wmux automatically registers its MCP server when launched. Claude Code can:

| Tool | What it does |
|------|-------------|
| `browser_open` | Open a new browser panel |
| `browser_navigate` | Go to URL |
| `browser_snapshot` | Get full page HTML |
| `browser_click` | Click element by CSS selector |
| `browser_fill` | Fill input field |
| `browser_eval` | Execute JavaScript |
| `terminal_read` | Read terminal screen |
| `terminal_send` | Send text to terminal |
| `terminal_send_key` | Send key (enter, ctrl+c, etc.) |
| `workspace_list` | List all workspaces |
| `surface_list` | List surfaces |
| `pane_list` | List panes |

**Multi-agent:** All browser tools accept `surfaceId` — each Claude Code session controls its own browser independently.

### Agent Status Detection
Gate-based detection for AI coding agents:
- Claude Code, Cursor, Aider, Codex CLI, Gemini CLI, OpenCode, GitHub Copilot CLI
- Detects agent startup → activates monitoring
- Critical action warnings (git push --force, rm -rf, DROP TABLE, etc.)

### Themes
Catppuccin, Tokyo Night, Dracula, Nord, Gruvbox, Solarized, One Dark, and more.

### i18n
English, 한국어, 日本語, 中文

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
| `Ctrl+click` | Add workspace to multiview |
| `Ctrl+Shift+G` | Exit multiview |
| `Ctrl+Shift+L` | Open browser |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+K` | Command palette |
| `Ctrl+I` | Notifications |
| `Ctrl+,` | Settings |
| `Ctrl+F` | Search terminal |
| `Ctrl+Shift+X` | Vi copy mode |
| `Ctrl+Shift+H` | Flash pane |
| `Alt+Ctrl+Arrow` | Focus adjacent pane |
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

### Requirements (development only)
- Node.js 18+
- Python 3.x (for node-gyp)
- Visual Studio Build Tools with C++ workload

The `install.ps1` script auto-installs Python and VS Build Tools if missing.

---

## Architecture

```
Electron Main Process
├── PTYManager (node-pty)
├── PTYBridge (data forwarding + ActivityMonitor)
├── AgentDetector (gate-based agent status)
├── PipeServer (Named Pipe JSON-RPC)
├── McpRegistrar (auto-registers MCP in ~/.claude.json)
└── ToastManager (OS notifications + taskbar flash)

Renderer Process (React 19 + Zustand)
├── PaneContainer (recursive split layout)
├── Terminal (xterm.js + WebGL)
├── BrowserPanel (webview + Inspector)
├── NotificationPanel
└── Multiview grid

MCP Server (stdio)
└── Bridges Claude Code ↔ wmux via Named Pipe RPC
```

---

## Acknowledgments

- [cmux](https://github.com/manaflow-ai/cmux) — The macOS AI agent terminal that inspired wmux. Same philosophy: primitives over prescriptive workflows.
- [xterm.js](https://xtermjs.org/) — Terminal rendering
- [node-pty](https://github.com/microsoft/node-pty) — Pseudo-terminal
- [Electron](https://www.electronjs.org/) — Desktop framework

---

## Note on AI Agents

wmux detects AI coding agents for status display purposes only. It does not call any AI APIs, capture agent outputs, or automate agent interactions. Users are responsible for complying with their AI provider's Terms of Service.

## License

MIT
