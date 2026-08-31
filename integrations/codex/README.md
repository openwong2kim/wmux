# wmux ↔ Codex CLI

Two independent bridges live here. They report the same turn boundary by
different routes, and you want **one** of them, not both.

| | `bin/wmux-codex-notify.mjs` | `bin/wmux-codex-hooks-bridge.mjs` |
|---|---|---|
| Registered as | `notify = [...]` in `config.toml` | `[[hooks.<Event>]]` in `config.toml` |
| Payload arrives | last argv token | stdin |
| Codex floor | any | **0.141.0** |
| Reports | turn complete | turn complete, turn start, session start |
| Needs operator approval | no | **yes** (trust gate) |
| Installed by wmux | yes (`lifecycleIntegrations`) | no — see *Installation* |

The notify program is what ships today. The hooks bridge is the replacement,
and it is not wired into the installer yet for the reason in *Installation*.

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
`PreToolUse`. Everything else is an enum member nobody has watched fire, and
none of those is mapped. An unmeasured event is not a signal.

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

### Not verified

`PermissionRequest` is the event that would let wmux retire the three
transcribed approval regexes in `AgentDetector.ts`, and it is the one that could
not be measured: `codex exec` forces `approval: never`, so no approval pause can
occur in a non-interactive run, and no amount of config overrides it
(`approval_policy = "untrusted"` is rejected outright in 0.151.0). Confirming it
needs an interactive TUI session. Until then the event is unmapped and the
screen regexes stay — mapping it now would mean guessing at its field names, and
a wrong `awaiting_permission` is worse than none.

## What the bridge reports

| Codex event | wmux signal |
|---|---|
| `SessionStart` | `agent.session_start` (with `source`) |
| `UserPromptSubmit` | `agent.user_prompt_submit` |
| `Stop` | `agent.stop` |

Deliberately unmapped, each for its own reason — the full argument is in the
`EVENT_TO_KIND` comment in the bridge:

- `PreToolUse` / `PostToolUse` — a spawn per tool call for a signal the server
  already throttles. And `PreToolUse` must **not** become `awaiting_input` the
  way Claude's does: Codex fires it on every tool call, gated or not, and has a
  separate `PermissionRequest` for the approval pause. Conflating them is the
  mistake #898 punished.
- `PermissionRequest` — unverified, see above.
- `SessionEnd` — measured, but there is no `AgentSignalKind` for "session
  over", and `agent.stop` would be a lie.
- `SubagentStart` / `SubagentStop` / `PreCompact` / `PostCompact` / `Interrupt`
  — never observed firing.

## Installation

**Not wired up.** `installLifecycleIntegrations` writes the notify program and
stops there.

This is not an oversight, and it is a different shape of problem from Kiro's.
For Kiro, writing the file *was* the whole job and only an account was missing.
Here, writing the file is explicitly **not** the job: Codex requires an operator
to trust the hook before it runs, it gives no warning when it has not been
trusted, and a programmatic installer almost certainly should not be able to
pre-trust its own hook. So an installer that wrote this block and reported
success would be reporting a lie — the pane would go on being screen-scraped
and nothing would say so.

What an installer will have to do instead is write the block, then tell the
operator to approve it in Codex, then verify it actually fires. The third step
is the one that needs designing, and it needs a machine with a working Codex
login to design against.

Until then, manual setup:

1. Check your version: `codex --version` must be **0.141.0 or newer**.
2. Copy the bridge somewhere **stable** — not the repo checkout:
   ```sh
   mkdir -p ~/.wmux/bridges
   cp integrations/codex/bin/wmux-codex-hooks-bridge.mjs ~/.wmux/bridges/
   ```
   The path goes into `config.toml` and into the trust hash Codex records
   against it. Pointing it at a working tree means moving, renaming, or
   re-cloning the checkout silently un-trusts the hook — and an un-trusted hook
   does not run and does not say so, which is the exact failure mode above.
   Re-copy after a `git pull` that touches the bridge, then re-approve.
3. Get the block (substitute the path you copied to):
   ```sh
   node -e "import('./integrations/codex/hooks/wmuxHooks.mjs').then(m=>console.log(m.renderCodexHooksToml(process.env.HOME + '/.wmux/bridges/wmux-codex-hooks-bridge.mjs')))"
   ```
4. Append it to `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`).
5. Start Codex interactively and **approve the hooks when it asks**. If it never
   asks, the hooks are not registered — re-check step 4.
6. Confirm: run a turn, then look for `"outcome":"ok"` lines in
   `~/.wmux/codex-hooks.log`.

If you use this bridge, remove the `notify = [...]` line — otherwise every turn
reports `agent.stop` twice. The `HookSignalRouter` dedup window swallows the
duplicate, so nothing breaks, but the second spawn is pure waste.

## Harmlessness

Both bridges are covered by `scripts/lib/hookHarmlessness.mjs`, which runs each
one against a fake daemon and requires it to classify identically to a no-op
hook: byte-empty stdout, exit 0, no surviving process, inside the latency
budget. The hooks bridge is exercised on all five measured events, including the
two it ignores — "ignored" has to mean silent and fast, not a slow no-op, and
`PreToolUse` fires on every tool call so a slow ignore there would be the most
expensive kind.
