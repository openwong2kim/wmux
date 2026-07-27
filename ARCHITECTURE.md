# wmux Architecture

> AI-native terminal multiplexer with multi-agent orchestration

## Process Model

```
                     ┌──────────────────────────────────┐
                     │  Claude Code / Cursor / MCP      │
                     │  (External AI Clients)            │
                     └──────────┬───────────────────────┘
                                │ Named Pipe RPC (token auth)
                     ┌──────────▼───────────────────────┐
        ┌────────────┤    Electron Main Process         │
        │            ├──────────────────────────────────┤
        │            │ PipeServer ─ RpcRouter           │
        │            │ PTYManager ─ PTYBridge           │
        │            │ WebviewCdpManager                │
        │            │ ClaudeWorker (background agent)  │
        │            │ McpRegistrar                     │
        │            └──────────┬───────────────────────┘
        │                       │ Electron IPC
        │            ┌──────────▼───────────────────────┐
        │            │    Renderer (React + Zustand)    │
        │            ├──────────────────────────────────┤
        │            │ PaneContainer (split layout)     │
        │            │ Terminal (xterm.js + WebGL)      │
        │            │ BrowserPanel (webview + CDP)     │
        │            │ useRpcBridge (RPC dispatch)      │
        │            │ Store: workspaces, A2A, company  │
        │            └──────────────────────────────────┘
        │
        │ Named Pipe RPC
        └────────────┬──────────────────────────────────┐
                     │    Daemon (background)           │
                     ├──────────────────────────────────┤
                     │ SessionManager + RingBuffer      │
                     │ ProcessMonitor + Watchdog        │
                     │ Keep PTYs alive after app exit   │
                     └──────────────────────────────────┘

        Spawned by Claude Code (stdio):
                     ┌──────────────────────────────────┐
                     │    MCP Server                    │
                     ├──────────────────────────────────┤
                     │ 30+ tools (browser, terminal,    │
                     │ workspace, A2A)                  │
                     │ PlaywrightEngine (browser auto)  │
                     │ PID-based workspace resolver     │
                     └──────────────────────────────────┘
```

## Source Structure

```
src/
├── main/              Electron main process
│   ├── pty/           PTY creation, data forwarding, agent detection
│   ├── pipe/          Named Pipe RPC server + route handlers
│   ├── ipc/           Electron IPC handlers (pty, fs, metadata)
│   ├── mcp/           MCP auto-registration in ~/.claude.json
│   ├── a2a/           ClaudeWorker (background task execution)
│   ├── company/       Company templates + worktree management
│   ├── security/      Navigation policy, SSRF validation
│   └── browser-session/  CDP proxy, profile manager, port allocation
├── renderer/          React 19 UI
│   ├── components/    Terminal, Browser, Pane, Sidebar, Palette
│   ├── stores/        Zustand slices (workspace, surface, a2a, company, ui)
│   ├── hooks/         useRpcBridge, useKeyboard, useTerminal
│   └── company/       Agent persona, cost estimator, message queue
├── mcp/               MCP server (Claude Code integration)
│   ├── playwright/    Browser automation tools (30+ Playwright tools)
│   └── a2a/           wmux-a2a MCP server (company mode comms)
├── daemon/            Background daemon (session persistence)
│   └── transcript/    TranscriptProjector — Chat View's transcript-to-TurnEvent projection
├── preload/           Electron contextBridge (IPC exposure)
├── shared/            Types, RPC definitions, constants, security utils
└── cli/               Command-line interface
```

## Communication Layers

### Layer 1: Electron IPC (Main <-> Renderer)
- PTY lifecycle: `pty:create`, `pty:write`, `pty:data`, `pty:exit`
- RPC bridge: `rpc:command` / `rpc:response` (pipe server -> renderer)
- Session: `session:save`, `session:load`
- Metadata: `metadata:update` (git branch, cwd, ports)

### Layer 2: Named Pipe JSON-RPC (Main <-> External)
- 40+ RPC methods: workspace, surface, pane, input, browser, A2A, company
- Token auth from `~/.wmux-auth-token`
- Rate limiting: 200 req/s global, 50 max connections
- TCP fallback on Windows EPERM

### Layer 3: Daemon RPC (Main <-> Daemon)
- Session management: create, attach, detach, destroy, resize
- Per-session data pipes for PTY output
- Events: `session:died`, `session:output`

## Key Data Flow: A2A Message

```
1. Agent A calls MCP tool: send_message(to: "2", message: "hello")
2. MCP server resolves own workspace via PID tree walking
3. MCP sends RPC: a2a.task.send { workspaceId, to, message }
4. PipeServer routes to renderer via IPC bridge
5. Renderer creates task in Zustand store
6. Renderer finds target workspace's active terminal PTY
7. Formatted message pasted into target PTY via pty:write
8. Agent B receives message in its terminal stdin
```

## Workspace Identity Resolution

Claude Code doesn't propagate env vars to MCP child processes.
wmux resolves workspace identity via PID tree walking:

```
1. PTYManager writes ~/.wmux/pid-map/{shellPID} = workspaceId
2. MCP server calls a2a.resolve.identity RPC -> gets all mappings
3. MCP walks process.ppid -> parent -> grandparent...
4. Matches ancestor PID against known PTY shell PIDs
5. Caches resolved workspace ID for session lifetime
```

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Workspace** | Named collection of panes (like tmux windows) |
| **Surface** | Single terminal or browser instance |
| **Pane** | Recursive binary tree layout (leaf = surfaces) |
| **A2A Task** | Structured message between workspaces with lifecycle |
| **Company** | Multi-agent org: CEO -> departments -> members |
| **Daemon** | Background process keeping PTYs alive after exit |

## Files & Tokens

| File | Purpose |
|------|---------|
| `~/.wmux-auth-token` | Shared auth token for pipe RPC |
| `~/.wmux-tcp-port` | TCP fallback port (Windows EPERM) |
| `~/.wmux/session.json` | Persisted app state |
| `~/.wmux/pid-map/` | PID -> workspace mappings for MCP |
| `~/.wmux/scrollback/` | Per-surface scrollback dumps |
| `~/.wmux/daemon.pid` | Daemon process ID |
| `~/.claude.json` | MCP server registration |
