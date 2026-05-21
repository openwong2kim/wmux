# Agent Hook Integration (P1, dogfood-gated)

Status: DRAFT (P1, dogfood-gated)
Spawned from: `D:\wmux\plans\notification-system-26-concepts.md` (2026-05-21 SELECTIVE EXPANSION)
Related plans: 2026-05-12 agent-notification-pipeline (Phase 2 Eureka), 2026-05-21 notification 17-item PR

## Purpose

External wmux-master analysis and the prior 2026-05-12 internal CEO plan both converged on the same architectural insight: an AI agent (Claude Code, Codex, Gemini, etc.) knows when its own turn ends with 100% accuracy. Output sniffing — Gate banner regex + `ActivityMonitor` 5s idle — is a heuristic that produces both false positives (idle but not done) and false negatives (still in the middle of streaming).

Integrating Claude Code's official `PostToolUse` / `Stop` / `SubagentStop` / `SessionStart` hooks turns wmux's notification accuracy from heuristic into deterministic. This plan defers implementation until measured dogfood data shows the existing heuristic is wrong often enough to justify modifying the user's global `~/.claude/settings.json`.

## Why this is a separate plan, not the prior PR's scope

Three constraints from project memory force separation:

1. `[[feedback_substrate_neutrality]]` — wmux core stays neutral to user environments. Editing the user's global Claude Code config requires explicit opt-in, marker-bounded edits, and a clean uninstall path. That's a multi-day engineering surface, not a 30-minute toggle.
2. `[[feedback_no_ship_without_user_verification]]` — measurement before implementation. No dogfood data yet on how often the 5s idle heuristic is actually wrong, so we cannot justify the substrate cost on hypothesis alone.
3. `[[project_substrate_alignment_2026_05_16]]` — Substrate 3.0 alignment forbids opinionated per-session/per-workspace logic in substrate layers. Hook integration lives in the Electron app layer (`src/main/`), not in substrate (`src/daemon/` or `src/main/metadata/`).

## Pre-conditions before this plan ships

- The 2026-05-21 17-item notification expansion PR is merged and dogfooded for ≥ 1 week.
- Telemetry or manual dogfood reports include at least one of: (a) measurable false-positive rate for the 5s idle heuristic, (b) measurable false-negative rate, (c) user reports describing missed/wrong notifications that hooks would solve.
- If neither dogfood signal materializes within 4 weeks of the 17-item PR merge, this plan is downgraded back to P3 Eureka in TODOS.md and revisited later. We do not implement on hypothesis.

## Premise

> The agent's own end-of-turn is the source of truth. Every heuristic is a proxy. If the agent can emit a deterministic signal, we should consume it deterministically, and the existing AgentDetector becomes a fallback for environments where the hook isn't installed.

## Scope: 7 ACCEPTED items from the 2026-05-21 CEO plan

| # | Item | Sub-component |
|---|------|---------------|
| 1 | PostToolUse hook receiver | Per-tool-call activity signal (existing `ActivityMonitor` peer) |
| 2 | Stop hook receiver | Turn-end signal — replaces 5s idle heuristic when installed |
| 3 | SubagentStop hook | /team mode subagent completion routing |
| 4 | SessionStart hook | Metadata reset trigger (clear stale state) |
| 5 | Hook ↔ AgentDetector dedup | Hook signal wins; AgentDetector is fallback when hook absent |
| 21 | Marker-based `~/.claude/settings.json` editing | `<!-- wmux:start --> ... <!-- wmux:end -->` to protect existing user hooks |
| 22 | Hook auto-install opt-in (default OFF) | First-run wizard offers, sets persistent preference |
| 23 | Hook script ASAR-external path | `userData/hooks/wmux-bridge.mjs` unpacked location, since Node cannot read ASAR |

## Architecture

```
USER's GLOBAL CONFIG (~/.claude/settings.json) — opt-in only
  ┌──────────────────────────────────────────────────┐
  │ <!-- wmux:start (auto-generated, do not edit) -->│
  │   hooks: {                                         │
  │     PostToolUse: [{ command: ".../wmux-bridge.mjs PostToolUse" }],
  │     Stop:        [{ command: ".../wmux-bridge.mjs Stop"        }],
  │     SubagentStop:[{ command: ".../wmux-bridge.mjs SubagentStop"}],
  │     SessionStart:[{ command: ".../wmux-bridge.mjs SessionStart"}],
  │   }                                                │
  │ <!-- wmux:end -->                                  │
  └──────────────────────────────────────────────────┘
                          │
                          ▼ spawn (per-event)
  ┌──────────────────────────────────────────────────┐
  │  wmux-bridge.mjs (ASAR-external, ~50 LOC)         │
  │  reads JSON from stdin (Claude Code hook payload) │
  │  POSTs to wmux daemon named-pipe RPC              │
  └──────────────────────────────────────────────────┘
                          │
                          ▼ RPC: hooks.signal
  ┌──────────────────────────────────────────────────┐
  │  daemon: HookSignalRouter                          │
  │  ├─ resolveSurface(claudeSessionId → ptyId)        │
  │  ├─ dedup against AgentDetector recent events       │
  │  │  (10s window, same kind → drop the second)       │
  │  └─ sendNotification helper (existing pipeline)     │
  └──────────────────────────────────────────────────┘
                          │
                          ▼ IPC notification:onNew
  ┌──────────────────────────────────────────────────┐
  │  renderer: useNotificationListener +              │
  │            useNotificationPolicy (from 17-item PR) │
  └──────────────────────────────────────────────────┘
```

### Signal mapping

| Hook | Notification type | Surface routing |
|------|-------------------|-----------------|
| PostToolUse | "activity" (suppressed if same surface) | Updates ActivityMonitor `running` state |
| Stop | "agent_completed" | Full 5-channel fan-out via existing policy |
| SubagentStop | "subagent_completed" | Routes to /team's coordinator pane if applicable |
| SessionStart | "session_reset" | Clears stale per-session metadata, never raises a Toast |

### Dedup with AgentDetector

```
Hook arrives at time t for sessionId S, kind=Stop
  → resolve to ptyId P, workspace W
  → check AgentDetector.recentEvents[P] for {kind:done, ts >= t-10s}
     ├─ match → mark hook as canonical, AgentDetector event becomes "redundant"
     │           (do not double-emit notification)
     └─ no match → emit notification, mark AgentDetector event to suppress for 10s

AgentDetector arrives at time t for ptyId P, kind=done
  → check HookSignalRouter.recentEvents[P] for {kind:Stop, ts >= t-10s}
     ├─ match → drop (hook already won)
     └─ no match → emit notification (fallback path)
```

## Installation flow (opt-in only)

```
First run after upgrade to version N (post-17-item-PR + dogfood):
  └─ banner in NotificationPanel header: "Improve agent notifications? 
      Install Claude Code hooks for 100% accurate turn-end signals."
      [ Install ] [ Not now ] [ Don't ask again ]

  Install clicked:
    1. Read ~/.claude/settings.json (create if missing)
    2. Validate it is JSON; reject if not (no auto-fix to avoid clobber risk)
    3. Locate or insert `<!-- wmux:start --> ... <!-- wmux:end -->` marker block
    4. Write hook entries inside marker, preserving everything outside
    5. Verify wmux-bridge.mjs exists at userData/hooks/wmux-bridge.mjs
    6. Set uiSlice.hookIntegrationInstalled = true
    7. Toast: "Hook integration installed. Restart Claude Code sessions to take effect."

  Uninstall (Settings panel):
    1. Read settings.json
    2. Remove marker block entirely (everything between markers + the markers themselves)
    3. Leave everything outside markers untouched
    4. Delete userData/hooks/wmux-bridge.mjs
    5. Set uiSlice.hookIntegrationInstalled = false
    6. Toast: "Hook integration removed."
```

## Risks + mitigations

| Risk | Mitigation |
|------|-----------|
| User's `~/.claude/settings.json` clobbered | Marker-bounded edits; refuse to edit malformed JSON; one-line preview shown before write |
| Hook bridge loops on its own signal | wmux-bridge.mjs ignores signals where `cwd` matches wmux's own dev/build directory |
| Claude Code env changes hook schema | Bridge validates payload shape; unknown event types are no-ops, logged for telemetry |
| User uninstalls wmux but settings.json still has hooks | Hook entries are absolute paths to userData; if file missing, Claude Code hook execution fails gracefully (Claude Code already handles missing hook scripts) |
| Hook fires for non-wmux Claude sessions | Bridge checks `cwd` against wmux's registered workspace directories; drops if no match |
| ASAR packaging — Node can't read from ASAR | wmux-bridge.mjs ships in `extraResources` (unpacked), referenced by absolute `process.resourcesPath` |
| Race: hook + AgentDetector both fire | 10s dedup window in HookSignalRouter (architecture above) |
| Multiple wmux installs (dev + prod) competing | Bridge writes to wmux daemon's named pipe per-install — pipe name includes install signature |

## Files (estimated, not exhaustive)

- `src/main/hooks/HookSignalRouter.ts` (NEW, ~200 LOC) — dedup + routing
- `src/main/hooks/settingsJsonEditor.ts` (NEW, ~150 LOC) — marker-bounded read/write
- `src/main/hooks/installer.ts` (NEW, ~80 LOC) — install/uninstall workflows
- `src/main/pipe/handlers/hooks.rpc.ts` (NEW, ~60 LOC) — receive bridge signals
- `resources/hooks/wmux-bridge.mjs` (NEW, ~80 LOC) — minimal Node script for hook execution
- `src/renderer/components/Settings/HookIntegrationSection.tsx` (NEW, ~100 LOC) — install/status/uninstall UI
- `src/renderer/components/Notification/HookOnboardingBanner.tsx` (NEW, ~60 LOC) — first-run prompt
- `src/renderer/stores/slices/uiSlice.ts` — `hookIntegrationInstalled`, `hookOnboardingDismissed`
- `src/main/pty/AgentDetector.ts` — dedup integration with HookSignalRouter
- `electron-builder.yml` (or build config) — `extraResources` for wmux-bridge.mjs

Approximate net new: 7 modules, ~700 LOC + integrations. **This is a substantive feature, not a small toggle.** Justifies separate PR.

## Tests

- Unit: settingsJsonEditor marker handling (valid JSON, malformed JSON refuse, existing block update, no-block insert, uninstall removes markers cleanly, preserves surrounding content).
- Unit: HookSignalRouter dedup (hook-then-detector / detector-then-hook / both-within-window / outside-window).
- Unit: wmux-bridge.mjs payload validation (valid Claude Code shapes, unknown event types no-op, malformed JSON exit 0).
- Integration: full installer flow with stub `~/.claude/settings.json` (RTL + temp dir).
- E2E (manual dogfood): install → run real Claude Code session → verify Stop signal arrives < 200ms after turn end → verify dedup against ActivityMonitor.

## Distribution

No new distribution channel. wmux ships as one Electron app; hook bridge is bundled as `extraResources` (already standard electron-builder pattern). Update flow is unchanged — existing release.yml + winget + Chocolatey covers it.

## NOT in scope

- Codex hooks (Codex doesn't have an official equivalent hook API yet — track separately)
- Gemini / OpenCode / Copilot hooks (no public hook APIs)
- Rich notification payload (file count, token cost from PostToolUse) — Phase 3, separate plan
- Cross-platform hook installer for non-Windows (macOS/Linux) — separate plan, gated on Windows ship + cross-platform branch policy `[[project_cross_platform_branch_policy]]`
- Automatic hook upgrade migration when wmux version changes — manual reinstall for now
- Per-workspace hook config (workspace A uses hooks, workspace B doesn't) — out of scope; install is global

## Open questions for next CEO review of this plan

1. Should the installer also wire Codex's `~/.codex/config.toml` equivalent if it exists, even though Codex has no Stop-hook concept? Cross-agent consistency vs scope creep.
2. Does the dedup window (10s) need to be tunable per agent, or is 10s universal?
3. SubagentStop routing for /team mode — where exactly does the notification land? Coordinator pane only, or all team panes?
4. SessionStart triggers — should they raise any user-visible event, or stay silent (metadata-only)?
5. Hook payload includes tool invocation count and token cost — surface these in the Toast immediately, or hold for Phase 3 "rich notification"?

## Sequencing

1. Pre-condition gate: 17-item PR merged + ≥ 1 week dogfood + measurable signal.
2. `/plan-ceo-review` this plan with updated dogfood data (premise verified vs falsified).
3. `/plan-eng-review` for architecture lock-in + test plan.
4. `/plan-design-review` for installer wizard UX + onboarding banner.
5. Implementation PR (single PR, ~700 LOC, gated by manual dogfood scenarios in installer).
6. Ship behind `hookIntegrationEnabled = false` default (opt-in stays opt-in).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**VERDICT:** DRAFT — gated on 17-item PR merge + dogfood signal. Run review skills against this plan once the pre-condition is met.
