# wmux ↔ Codex CLI

Two independent bridges live here. They report the same turn boundary by
different routes, and you want **one** of them, not both.

| | `bin/wmux-codex-notify.mjs` | `bin/wmux-codex-hooks-bridge.mjs` |
|---|---|---|
| Registered as | `notify = [...]` in `config.toml` | `[[hooks.<Event>]]` in `config.toml` |
| Payload arrives | last argv token | stdin |
| Codex floor | any | **0.141.0** |
| Reports | turn complete | turn complete, turn start, session start, approval pause |
| Needs operator approval | no | **yes** (trust gate) |
| Installed by wmux | yes (`lifecycleIntegrations`) | yes — approve-then-verify, see *Installation* |

The notify program is what shipped first. The hooks bridge is the
replacement: it reports everything the notify program does plus turn start,
session start, and approval pauses.

## Why the hooks bridge exists

wmux decides "is this Codex pane done?" partly by scraping the terminal.
`src/main/pty/AgentDetector.ts` matches `^codex>\s*$` for idle and three
transcribed approval questions for `awaiting_input`. That holds until Codex
changes its TUI. The answer feeds notifications, the orchestrator's count of
what is still busy, and the blocking poll — so when it is wrong, the fleet
sends work to a pane that never stopped.

The notify program already reports turn-complete. What it cannot report is
turn *start* or session start, so a pane that has begun working is still
inferred rather than told.

## What Codex measurably does and does not give us

Measured live on **2026-08-31** against codex-cli **0.151.0** (and re-checked on
0.145.0-alpha.2, 0.143.0, 0.141.0, 0.140.0, 0.135.0) driving a stub Responses
endpoint, because the account on the measuring machine returns 402
`deactivated_workspace` and cannot complete a real model turn. The stub only
supplies the model's side of the wire; the hook machinery under test is
entirely local.

**Events in the enum** — `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`,
`SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`.

**Measured firing** — `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`,
`PreToolUse` (2026-08-31); `PostToolUse`, `PermissionRequest` (2026-09-07,
codex-cli 0.153.4, PTY-driven interactive TUI — the only way to see an
approval pause, since `codex exec` forces `approval: never`). Everything else
is an enum member nobody has watched fire, and none of those is mapped. An
unmeasured event is not a signal.

**`Stop` is a turn boundary, not a session one.** This was the question the
whole spike existed to answer. Across two turns of one session, `Stop` fired
once per turn carrying that turn's `turn_id`, and `SessionEnd` fired separately,
once, with no `turn_id`. A first run whose model call failed produced
`SessionStart` → `UserPromptSubmit` → `SessionEnd` with **no** `Stop` at all,
which is the same fact from the other side: no completed turn, no `Stop`.

**The payload envelope is Claude Code's, verbatim.** `session_id`,
`transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, plus
`turn_id` on turn-scoped events. Codex even normalizes tool names into Claude's
vocabulary — a shell call arrives as `tool_name: "Bash"`. A captured `Stop`:

```json
{"session_id":"01a0582a-…","turn_id":"01a0582a-…","transcript_path":"…/rollout-….jsonl",
 "cwd":"D:\\wmux","hook_event_name":"Stop","model":"gpt-5.6-sol",
 "permission_mode":"bypassPermissions","stop_hook_active":false,
 "last_assistant_message":"hi"}
```

**Pane environment is inherited.** `WMUX_PTY_ID` set on the Codex process
reaches the hook unchanged, so pane attribution works exactly as it does for
Kiro and Claude.

**Resume binding is possible**, unlike Kiro. `SessionStart.source` is
`"startup"` on a fresh session and `"resume"` on `codex … resume`, with the
**same** `session_id`. So the bridge keeps the notify program's resume spool.

**The payloads carry content.** `prompt` (UserPromptSubmit),
`last_assistant_message` (Stop), `tool_input` (PreToolUse). wmux's bridges are
metadata-only, so none of it is read, logged, or forwarded — the allowlist in
`buildCodexHookEnvelope` is the enforcement, and the test asserts on the
serialized envelope so a future content-bearing field fails it too.

**Exit code 2 blocks.** The binary carries `PreToolUse hook exited with code 2
but did not write a blocking reason to stderr` and `hook returned invalid
pre-tool-use JSON output`. The bridge writes nothing and always exits 0.

### Two things that will waste your afternoon

**1. The trust gate is silent.** Codex will not run a hook it has not been told
to trust, and it does not say so. With an untrusted `[[hooks.Stop]]` in
`config.toml`, `codex exec` printed no warning, no "hooks need review" line, and
exited 0 — the hook simply never ran, and the config parsed clean. The only
signal that anything was wrong was the absence of output from the hook itself.
`HookStateToml { enabled, trusted_hash }` is the on-disk representation, and
`--dangerously-bypass-hook-trust` is the escape hatch.

**2. Neither the feature flag nor the CLI flag is a capability probe.**
0.135.0 and 0.140.0 both report `hooks  stable  true` from
`codex features list`, both accept `--dangerously-bypass-hook-trust`, both
parse `[[hooks.*]]` without complaint — and both fire nothing. Bisected:

| version | hooks fire? |
|---|---|
| 0.135.0 | no |
| 0.140.0 | no |
| **0.141.0** | **yes** |
| 0.143.0 / 0.145.0-alpha.2 / 0.151.0 | yes |

Only the version distinguishes them, which is why `codexSupportsHooks()` gates
on the version and fails closed on anything it cannot parse.

### PermissionRequest, measured 2026-09-07

The event that lets wmux stop screen-scraping Codex approval pauses was finally
observed. `codex exec` forces `approval: never` and no config overrides it, so
the measurement drove the **interactive TUI** in a PTY (node-pty) against the
stub Responses endpoint, returning an `exec_command` call with
`sandbox_permissions: "require_escalated"` — the model-side request for an
unsandboxed run, which is what raises the TUI approval dialog.

Firing order for one gated call, all events carrying the same `turn_id`:

```
PreToolUse → PermissionRequest → (operator approves in the TUI) → PostToolUse → Stop
```

A captured `PermissionRequest` (elided):

```json
{"session_id":"01a07ba6-…","turn_id":"01a07ba7-…","transcript_path":"…/rollout-….jsonl",
 "cwd":"/spike/work","hook_event_name":"PermissionRequest","model":"stub-1",
 "permission_mode":"default","tool_name":"Bash",
 "tool_input":{"command":"echo proof > /tmp/…","description":"write the spike proof file outside the sandbox"}}
```

Three facts that matter for the mapping:

- **`tool_name` is Claude-normalized** ("Bash"), like every tool event.
- **`tool_input.description` is the call's user-facing `justification`** —
  content, never forwarded (the bridge is metadata-only).
- **No `tool_use_id`**, unlike the `PreToolUse`/`PostToolUse` events firing
  around it.

The spike also surfaced two TUI-only dialogs the driver had to get past, worth
recording for the next person to drive this thing: a fresh cwd raises a
*directory trust* dialog (pre-answerable in config: `[projects."<abs path>"]`
with `trust_level = "trusted"`), and a version-update nag whose default option
runs `npm install -g @openai/codex` — pick Skip when driving a spike.

## What the bridge reports

| Codex event | wmux signal |
|---|---|
| `SessionStart` | `agent.session_start` (with `source`) |
| `UserPromptSubmit` | `agent.user_prompt_submit` |
| `Stop` | `agent.stop` |
| `PermissionRequest` | `agent.awaiting_input` |

`PermissionRequest` maps to `agent.awaiting_input` — the same pane state the
three transcribed approval regexes in `AgentDetector.ts` produce — and **not**
to `agent.awaiting_permission`, which is reserved for wmux's own blocking
permission gate (#783: the daemon holding the bridge RPC open until a phone
resolves it), not the agent's local TUI dialog. The regexes stay as the
fallback for panes without a trusted hook; a pane with this bridge gets the
fact instead of the screenshot guess.

Deliberately unmapped, each for its own reason — the full argument is in the
`EVENT_TO_KIND` comment in the bridge:

- `PreToolUse` / `PostToolUse` — a spawn per tool call for a signal the server
  already throttles. And `PreToolUse` must **not** become `awaiting_input`
  the way Claude's does: Codex fires it on every tool call, gated or not, and
  has a separate `PermissionRequest` for the approval pause. Conflating them
  is the mistake #898 punished.
- `SessionEnd` — measured, but there is no `AgentSignalKind` for "session
  over", and `agent.stop` would be a lie.
- `SubagentStart` / `SubagentStop` / `PreCompact` / `PostCompact` / `Interrupt`
  — never observed firing.

## Installation

**Wired up — approve-then-verify.** `wmux setup-hooks` now installs both
Codex bridges. Writing the block is deliberately **not** the end of the
install, because Codex requires an operator to trust a hook before it runs,
gives no warning when it has not been trusted, and a programmatic installer
almost certainly should not be able to pre-trust its own hook. An installer
that wrote the block and reported success would be reporting a lie — the pane
would go on being screen-scraped and nothing would say so.

So the flow is:

1. `wmux setup-hooks` — writes the bridge to the stable managed location
   (`~/.wmux/hooks/wmux-codex-hooks-bridge.mjs`, refreshed on every run) and
   appends the marker-bracketed `[[hooks.*]]` block to `$CODEX_HOME/config.toml`
   (default `~/.codex/config.toml`). It refuses to write when:
   - `codex --version` cannot be probed or is below **0.141.0** (fail closed —
     0.140.0 parses the block, advertises the feature, and fires nothing);
   - config.toml already has ANY `[[hooks.*]]` the wmux markers cannot claim
     (skip-if-foreign, the notify lane's rule applied one level wider);
   - the config is unparseable, or a hand-pasted wmux block is missing its
     end marker (the installer never guesses a region boundary).
2. **Approve** — start Codex interactively and approve the wmux hooks when it
   asks. Until then Codex silently runs nothing; wmux's status says so.
3. **Verify** — `wmux setup-hooks --status` reports the honest verdict:
   `WRITTEN but NOT trusted` until the bridge has actually fired after the
   block was written, `ACTIVE` once it has.

The verdict is evidence-based, not file-based: the installer stamps when it
wrote the block (`~/.wmux/codex-hooks-install.json`), and the bridge appends
one JSON line per firing to `~/.wmux/codex-hooks.log`. A log entry newer than
the stamp is the only thing that reads as installed — it proves the operator
approved AND Codex actually spawned the hook. Idempotent re-runs never move
the stamp, and a refresh that changes the bridge path resets it (re-approval
genuinely required, and the status says so).

Manual setup (no `wmux setup-hooks`) still works:

1. Check your version: `codex --version` must be **0.141.0 or newer**.
2. Copy the bridge somewhere **stable** — not the repo checkout:
   ```sh
   mkdir -p ~/.wmux/hooks
   cp integrations/codex/bin/wmux-codex-hooks-bridge.mjs ~/.wmux/hooks/
   ```
   The path goes into `config.toml` and into the trust hash Codex records
   against it. Pointing it at a working tree means moving, renaming, or
   re-cloning the checkout silently un-trusts the hook — and an un-trusted
   hook does not run and does not say so, which is the exact failure mode
   above. Re-copy after a `git pull` that touches the bridge, then re-approve.
3. Get the block (substitute the path you copied to):
   ```sh
   node -e "import('./integrations/codex/hooks/wmuxHooks.mjs').then(m=>console.log(m.renderCodexHooksToml(process.env.HOME + '/.wmux/hooks/wmux-codex-hooks-bridge.mjs')))"
   ```
4. Append it to `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`).
   A manually-installed block has no install stamp, so `--status` counts ANY
   firing as active — the honest floor for a block wmux did not write.
5. Start Codex interactively and **approve the hooks when it asks**. If it never
   asks, the hooks are not registered — re-check step 4.
6. Confirm: run a turn, then look for `"outcome":"ok"` lines in
   `~/.wmux/codex-hooks.log`.

If you use this bridge, remove the `notify = [...]` line — otherwise every turn
reports `agent.stop` twice. The `HookSignalRouter` dedup window swallows the
duplicate, so nothing breaks, but the second spawn is pure waste.

## Identity on the main pipe (#1111)

Both bridges send `clientName: 'wmux-hook-bridge'` on every request. On the
daemon control pipe it is ignored — there is no enforcer there. On the MAIN
pipe it is load-bearing: `hooks.signal` is `wmux.internal`, so no declaration
can ever grant it, and the enforcer instead recognises that exact name and
allows that one method (`src/main/mcp/hookBridge.ts`). Without it the signal is
refused as `identity-status:legacy` once the envelope-less grandfather closes,
and turn-state reporting degrades **silently** — the failure this integration
exists to remove.

The name is a literal in each bridge rather than an import, because a bridge is
a standalone `.mjs` outside the main build. `hookBridge.lockstep.test.ts` parses
the bridge sources to keep the copies honest; this bridge additionally carries
the same two assertions in `__tests__/codexHookEnvelope.test.ts`.

`hooks.signal` is the only main-pipe method either bridge calls. Adding another
means widening the lane in `hookBridge.ts` deliberately.

## Harmlessness

Both bridges are covered by `scripts/lib/hookHarmlessness.mjs`, which runs each
one against a fake daemon and requires it to classify identically to a no-op
hook: byte-empty stdout, exit 0, no surviving process, inside the latency
budget. The hooks bridge is exercised on all six measured events, including the
two it ignores — "ignored" has to mean silent and fast, not a slow no-op, and
`PreToolUse` fires on every tool call so a slow ignore there would be the most
expensive kind.
