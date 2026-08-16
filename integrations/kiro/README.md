# wmux ↔ Kiro CLI

Turns "is this Kiro pane done?" from a guess into a fact.

Without a hook, wmux infers a Kiro turn boundary by scraping the terminal
(`AgentDetector`, a two-stage regex gate on Kiro's chrome and prompt lines).
That works until the model prints something prompt-shaped, or Kiro changes its
UI. With the hook, Kiro reports the turn ending itself, and wmux's turn-end
consumers — notifications, the orchestrator's "what's still busy" count,
`wmux_events_poll(blockMs)` — get a fact instead of an inference.

**Not wired into wmux's installer yet.** The bridge, its tests and its
harmlessness coverage ship here; automatic installation is deliberately held
back until the end-to-end path can be verified on a machine with a Kiro
account. Set it up by hand today with the steps below.

## What it reports

| Kiro trigger | wmux signal |
|---|---|
| `stop` | `agent.stop` — the turn ended |
| `agentSpawn` | `agent.session_start` |

Deliberately **not** registered:

- `preToolUse` / `postToolUse` — an activity stamp would cost a process spawn
  per tool call. That is the one path that actually makes things heavier.
- `userPromptSubmit` → `agent.awaiting_input` — Kiro has no approval-specific
  event, and "a prompt was submitted" is not "a human is being waited on".
  Conflating those is what issue #898 punished; no signal beats a false one.

## What it cannot do (measured, not assumed)

- **No resume binding.** Kiro's `stop` payload is
  `{hook_event_name, cwd, assistant_response}` — there is no session id, so
  there is nothing to bind a resumable session to.
- **Pane attribution comes only from `WMUX_PTY_ID`**, inherited from the pane
  environment. A payload without it is dropped rather than attached to a guess.
- **Only panes launched with `--agent wmux`.** A hand-run `kiro-cli chat` keeps
  using the detector, exactly as before.

## Privacy

Kiro's payloads carry content: `prompt` is the user's whole input and
`assistant_response` is the model's whole reply. wmux's bridges are
metadata-only, so the envelope builder reads `hook_event_name` and `cwd` and
nothing else. The test asserts on the serialized envelope, so a future field
that happens to carry content fails it too.

## Manual setup

1. Put the bridge somewhere stable, e.g. `~/.wmux/hooks/wmux-kiro-bridge.mjs`.
2. Write `~/.kiro/agents/wmux.json` with the config
   `agent/wmuxAgent.mjs` builds, pointing `command` at that path:

   ```json
   {
     "name": "wmux",
     "description": "wmux-managed: kiro-lifecycle-agent",
     "prompt": "",
     "tools": ["*"],
     "includeMcpJson": true,
     "resources": ["file://AmazonQ.md", "file://AGENTS.md", "file://README.md",
                   "skill://.kiro/skills/*/SKILL.md",
                   "skill://<home>/.kiro/skills/*/SKILL.md",
                   "file://<home>/.kiro/steering/**/*.md"],
     "hooks": {
       "stop":       [{ "command": "node \"<path>/wmux-kiro-bridge.mjs\"", "timeout_ms": 2500 }],
       "agentSpawn": [{ "command": "node \"<path>/wmux-kiro-bridge.mjs\"", "timeout_ms": 2500 }]
     }
   }
   ```

3. Launch Kiro panes with `kiro-cli chat --agent wmux`.

Confirm Kiro picked it up with `kiro-cli agent list` — it appears under
`Global`, and the `*` stays on `kiro_default`, because this does not change
your default agent.

## Why the agent config looks like that

It mirrors `kiro_default` in everything except the prompt. `allowedTools` is
`[]` in the built-in too, which is why approval behaviour cannot change.
`includeMcpJson` and `resources` are carried over because dropping them
silently costs MCP access and project context. The empty prompt is the one
intended difference: measured 3x on a tool-using task, thin and built-in both
scored 3/3 with no time or cost penalty, and cloning the built-in's 1.7KB
prompt would freeze it at install time and drift.

`scripts/kiro-agent-equivalence.mjs` re-checks that against the live built-in —
run it after a Kiro upgrade.

## Harmlessness

Covered by the P-5 gate (`scripts/__tests__/hookHarmlessness.runtime.test.mjs`)
in five environment scenarios: the bridge writes zero bytes to stdout, always
exits 0, adds ~90ms, and leaves no process holding the host's stdio. Measured
separately on 2.15.1: Kiro tolerates even a hook that writes stderr and exits
2, but this bridge does neither.
