# wmux

> Terminal multiplexer for Windows with built-in browser, notifications, and AI agent status detection.

Windows-native terminal multiplexer with workspaces, panes, tabs, integrated browser, notification system, CLI/API access, and session management.

## Quick Install

**PowerShell (recommended):**
```powershell
irm https://raw.githubusercontent.com/iamwongeeeee/wmux/main/install.ps1 | iex
```

**Git Bash / WSL:**
```bash
curl -fsSL https://raw.githubusercontent.com/iamwongeeeee/wmux/main/install.sh | bash
```

**Manual:**
```bash
git clone https://github.com/iamwongeeeee/wmux.git
cd wmux
npm install
npm start
```

## Requirements

- Windows 10/11
- Node.js 18+
- Git

## Features

- **Terminal**: xterm.js + WebGL GPU rendering, ConPTY, PowerShell native
- **Workspaces**: Vertical sidebar, drag-and-drop, Ctrl+1~9 switching
- **Split Panes**: Ctrl+D / Ctrl+Shift+D, directional focus
- **In-App Browser**: Ctrl+Shift+L, scriptable API
- **Notifications**: OSC 9/99/777, rings, toast, Ctrl+I panel
- **AI Agent Status**: Detects Claude Code, Cursor, Aider, Codex, Gemini, Copilot, OpenCode
- **Command Palette**: Ctrl+K fuzzy search
- **Terminal Search**: Ctrl+F
- **Vi Copy Mode**: Ctrl+Shift+X
- **CLI + API**: Named Pipe JSON-RPC, `wmux` CLI
- **Session Management**: Save and restore sessions
- **i18n**: English, Korean, Japanese, Chinese

## Usage

```bash
npm start              # Run in dev mode
npm run package        # Build executable
npm run make           # Create installer
wmux --help            # CLI commands
```

## CLI Examples

```bash
# Workspace management
wmux workspace create "MyWorkspace"
wmux workspace list
wmux workspace switch "MyWorkspace"

# Pane operations
wmux pane split-right
wmux pane split-down
wmux pane send-text "echo hello"

# Surface (browser)
wmux surface open "https://example.com"
wmux surface eval "window.location"
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Ctrl+B | Toggle sidebar |
| Ctrl+N | New workspace |
| Ctrl+D | Split right |
| Ctrl+Shift+D | Split down |
| Ctrl+T | New tab |
| Ctrl+W | Close tab |
| Ctrl+F | Search terminal |
| Ctrl+K | Command palette |
| Ctrl+I | Notifications |
| Ctrl+, | Settings |
| Ctrl+Shift+L | Open browser |
| Ctrl+Shift+H | Flash pane |
| Ctrl+1~9 | Switch workspace |

## Tech Stack

Electron 41 + React 19 + TypeScript 5.9 + Tailwind 3 + Zustand 5 + xterm.js 6 + node-pty

## Note on AI Agents

WinMux detects AI coding agents for status display purposes only. It does not call any AI APIs, capture agent outputs, or automate agent interactions. Users are responsible for complying with their AI provider's Terms of Service.

## License

MIT
