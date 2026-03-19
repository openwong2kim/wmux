# wmux

> AI Agent Terminal for Windows — Run Claude Code, Codex, Gemini CLI in parallel

Windows-native terminal with AI agent orchestration, built-in browser, notification system, and Company Mode for managing multi-agent teams.

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

## Usage

```bash
npm start              # Run in dev mode
npm run package        # Build executable
npm run make           # Create installer
wmux --help            # CLI commands
```

## Features

- **Terminal**: xterm.js + WebGL GPU rendering, ConPTY, PowerShell native
- **Workspaces**: Vertical sidebar, drag-and-drop, Ctrl+1~9 switching
- **Split Panes**: Ctrl+D / Ctrl+Shift+D, directional focus
- **In-App Browser**: Ctrl+Shift+L, scriptable API
- **Notifications**: OSC 9/99/777, rings, toast, Ctrl+I panel
- **AI Agent Detection**: Claude Code, Codex, Gemini, Copilot, OpenCode, Aider
- **Command Palette**: Ctrl+K fuzzy search
- **Terminal Search**: Ctrl+F
- **Vi Copy Mode**: Ctrl+Shift+X
- **CLI + API**: Named Pipe JSON-RPC, `wmux` CLI
- **i18n**: English, Korean, Japanese, Chinese
- **Company Mode**: Multi-agent team management with file-based communication

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
| Ctrl+Shift+O | Company view |
| Ctrl+Shift+H | Flash pane |

## Company Mode

Create AI agent teams with pre-configured roles:

```bash
# Templates: Full-Stack, Startup MVP, Code Review, Enterprise
# CEO → Department Leads → Team Members
# File-based async communication (.wmux/ directory)
```

## Tech Stack

Electron 41 + React 19 + TypeScript 5.9 + Tailwind 3 + Zustand 5 + xterm.js 6 + node-pty

## License

MIT
