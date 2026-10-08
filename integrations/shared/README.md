# Shared Claude-compatible hook bridge

Many agent CLIs now run lifecycle hooks the way Claude Code does: a command per
event, the event as JSON on stdin, and exit 0 with no output meaning "no
opinion". Such a CLI does not need its own wmux bridge. One bridge,
`bin/wmux-hooks-bridge.mjs`, serves all of them:

```
node "<path>/wmux-hooks-bridge.mjs" <flavour> [<EventName>]
```

A **flavour** is a hook dialect: which config file the CLI reads, what it calls
each event, and where its payload keeps the session id and cwd. The bridge maps
the event to a wmux signal kind and sends the standard `AgentSignal` envelope
over the same `hooks.signal` RPC that every other bridge uses. The daemon's
existing rules apply unchanged: dispatch is by kind, and hook evidence outranks
process and screen evidence for the pane's agent identity.

| Kind sent | What the pane shows |
|---|---|
| `agent.session_start` | idle, before the first turn |
| `agent.user_prompt_submit` | working |
| `agent.awaiting_input` | waiting on you (approval prompts only) |
| `agent.stop` | done / idle |

The flavour table lives in two places that a test keeps identical:
`src/shared/hooks/hookFlavours.ts` (the installer side: config paths, events to
register, command form) and `FLAVOURS` in the bridge (the runtime side: event
map and payload fields). The bridge cannot import from `src/`.

## Rules every flavour follows

- **Metadata only.** The bridge reads the event name, the session id, the cwd,
  and the `source` of a session start. Prompts, replies, tool inputs and
  transcript paths are never read, logged or forwarded.
- **Pane attribution comes from `WMUX_PTY_ID` only.** A hook fired outside a
  wmux pane is dropped. A session id identifies a conversation, not a pane.
- **Only approval events mean "waiting on you".** A prompt submit or a
  pre-tool hook does not (#898).
- **No per-tool-call hooks, and no events nobody has seen documented or
  measured.** Each would cost a process spawn for nothing.
- **Always exit 0, never write stdout.**

## Installing

`wmux setup-hooks --agent copilot` (with `--status` or `--remove`) writes
`~/.copilot/hooks/wmux.json`, a file wmux owns, and copies the bridge to
`~/.wmux/hooks/`. When `COPILOT_HOME` is set, the file goes to
`$COPILOT_HOME/hooks/wmux.json` instead, which is where Copilot reads user hooks
from ([hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference)).
Run the command with the same `COPILOT_HOME` that Copilot sees; `--status`
names the directory it checked. It never edits a settings file you also edit. A file at that
path that wmux did not write is reported and left alone. The plain
`wmux setup-hooks` run does not touch Copilot.

Each entry uses exec form (`"exec": "node"` plus `"args"`), which Copilot starts
without a shell. A shell-form command (`node "<path>" <flavour> <Event>`) starts
with a bare `node` because PowerShell cannot run a line that begins with a quoted
token (#1882). Both forms are tested under PowerShell 5.1, cmd and Git Bash in
`__tests__/hooksBridgeShells.test.ts`.

## Compatibility by CLI

Checked against each CLI's public documentation on 2026-10-08. **Live** means
measured against a running CLI. **Docs** means read off the documentation and
not yet seen working.

| CLI (wmux slug) | Docs | Hook config | Event names | Session id / cwd fields | Windows command | wmux status |
|---|---|---|---|---|---|---|
| Claude Code (`claude`) | [hooks](https://code.claude.com/docs/en/hooks) | `~/.claude/settings.json` `hooks` | The reference set: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`, … | `session_id` / `cwd` | shell, or exec form (`command` + `args`, 2.1.139+) | Own bridge (`integrations/claude`); gates and approval cards need it. Not moved. |
| Codex CLI (`codex`) | `integrations/codex/README.md` | `$CODEX_HOME/config.toml` `[[hooks.*]]` | Claude's names | `session_id` / `cwd` | `command` + `commandWindows` | Own bridge. Claude-compatible on the wire, but its bridge also does thread attribution, sub-agent reclassification and the resume spool, and hooks must be trusted inside Codex. Not moved. |
| GitHub Copilot CLI (`copilot`) | [hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference) | `~/.copilot/hooks/*.json`, `~/.copilot/settings.json` `hooks`, repo `.github/hooks/*.json` | camelCase (`sessionStart`, `agentStop`, …) **or** Claude's PascalCase names, which switch the payload to snake_case | `session_id` (PascalCase mode; `sessionId` in camelCase) / `cwd` | `bash` / `powershell` / `command`, or `exec` + `args` with no shell | **Shared bridge, flavour `copilot`.** Registers `SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`. Opt-in installer (honours `COPILOT_HOME`). Live, 1.0.93 on Windows. |
| Gemini CLI (`gemini`) | [hooks](https://geminicli.com/docs/hooks/), [reference](https://geminicli.com/docs/hooks/reference/) | `~/.gemini/settings.json` `hooks` (also project and `/etc/gemini-cli/`) | Its own: `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `Notification`, `PreCompress` | `session_id` / `cwd` (also `GEMINI_SESSION_ID` in the env) | `command` only. The docs' Windows examples are PowerShell. | **Shared bridge, flavour `gemini`**: `BeforeAgent` → working, `AfterAgent` → done, `Notification` with `notification_type: "ToolPermission"` → waiting. No installer yet, because the hooks would be merged into your own `settings.json`. Docs only. |
| Kiro CLI 2.x (`kiro`) | [2.x hooks](https://kiro.dev/docs/cli/2x-reference/#hooks) | An agent config, `~/.kiro/agents/<name>.json` | camelCase: `agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`, `stop` | No session id / `cwd` | `command` (shell) | **Shared bridge, flavour `kiro`** (moved from its own bridge; same envelopes). Manual install, see `integrations/kiro/README.md`. Live, 2.15.1. |
| Kiro, unified hooks | [hooks](https://kiro.dev/docs/hooks/) | `.kiro/hooks/*.json` | `PromptSubmit`/`promptSubmit`, `AgentStop`/`agentStop`, `SessionStart`, `SessionEnd`, `preToolUse`, … | Not documented | Not documented | Not supported yet. The stdin fields are not documented. |
| Cursor CLI (no slug) | [hooks](https://cursor.com/docs/agent/hooks) | `~/.cursor/hooks.json`, `.cursor/hooks.json` | camelCase: `sessionStart`, `beforeSubmitPrompt`, `stop`, `sessionEnd`, `preToolUse`, … | `conversation_id` on every event, `session_id` on session events / `workspace_roots`, no `cwd` | `command` (shell) | Not in the registry. Cursor also loads Claude Code hooks from `~/.claude/settings.json` (see below). |
| Qwen Code (no slug) | [hooks](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md) | `~/.qwen/settings.json` `hooks`, `.qwen/settings.json` | Claude's names, plus extras (`PostToolBatch`, `TodoCreated`, …) | `session_id` / `cwd` | `command`, with `"shell": "bash" \| "powershell"` | Not in the registry. Would be a flavour row identical to Claude's names. |

### Known cross-tool risk

Cursor reads `~/.claude/settings.json` (its "third-party hooks" setting), and
GitHub Copilot CLI reads a repository's `.claude/settings.json`. If wmux's
Claude Code hooks are configured there, those CLIs run the **Claude** bridge,
which reports `agent: "claude"` for a pane that is not running Claude. Not
fixed here; it is the same class of problem as #1823.

### Measured on a live CLI

- Copilot CLI 1.0.93 on Windows (2026-10-08): loads `~/.copilot/hooks/wmux.json`
  and fires PascalCase `SessionStart`, `UserPromptSubmit`, `PermissionRequest`
  and `Stop` with `session_id` and `cwd`. `exec` finds `node` on `PATH`. With
  `COPILOT_HOME` set it does not read `~/.copilot/hooks/`. Cancelling a
  permission prompt with Esc fires no hook at all, so wmux clears the pane's
  waiting card when it sees the prompt answered at the terminal (#1918).

### Unknowns to settle on a live CLI

- Gemini: whether hooks need an enable switch in some versions, and which
  shell runs a hook command on Windows.
- Kiro unified hooks: the stdin payload.
