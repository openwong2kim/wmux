# wmux × Claude Code Integration (multi-phase)

Status: DRAFT (Phase 1 dogfood-ready, Phases 2-3 slots only)
Spawned from: `D:\wmux\plans\notification-system-26-concepts.md` (2026-05-21 SELECTIVE EXPANSION)
Supersedes: `plans/agent-hook-integration.md` (renamed in this revision; git history preserved)
Related plans: 2026-05-12 agent-notification-pipeline (Phase 2 Eureka), 2026-05-21 notification 17-item PR

## Why this plan exists

Two distinct user needs converged on the same architectural answer:

1. **Heuristic accuracy gap** — wmux's `AgentDetector` + 5s `ActivityMonitor` idle fallback misses real turn-end events (user dogfood report 2026-05-22: "no alarm at all"). Claude Code knows its own turn-end with 100% accuracy. We want that signal.
2. **Rate-limit visibility gap** — Claude Code's 5h / 7d unified rate-limit utilization is invisible inside wmux. Reference impl `openwong2kim/claude-token-check` (macOS menubar app, 2026-05-21) proves the Anthropic API header polling pattern works. User wants the same surface inside wmux.

Both needs are "Claude Code integration layer" concerns. They share infrastructure (wmux daemon RPC client, cross-platform auth helper, settings UI slot). Putting them in one repo with two phases minimizes total cost and lets new integrations (Codex, Gemini) drop into the same pattern later.

## Architectural decision: Claude Code plugin + sidecar, NOT global settings.json edit

The prior revision of this plan (single-phase, hook only) assumed marker-bound edits to `~/.claude/settings.json`. This revision rejects that approach. Reasoning:

- `[[feedback_substrate_neutrality]]` — wmux core must stay neutral to user environments. Mutating the user's global Claude Code config has unbounded blast radius (other tools' hooks, future schema changes, multi-install conflicts).
- Claude Code's plugin system (`v2.1.128+`, stable) provides a first-class isolation boundary. Plugins live in their own namespace; uninstall is `/plugin uninstall` (one command); no risk of clobbering user-owned config.
- Hooks defined in a plugin's `hooks/hooks.json` use the same merge rules as user settings, BUT live in plugin-scope — they coexist with user-defined hooks instead of overriding them at the file level.
- Background polling (Phase 2 sidecar) does not fit the plugin event model. Sidecar lives outside the plugin, spawned by wmux daemon on opt-in.

**Two mechanisms, one repo, one user-facing identity ("wmux-claude-integration"):**

| Mechanism | Lives where | Purpose |
|-----------|-------------|---------|
| Claude Code plugin (`hooks/hooks.json`) | Installed via `/plugin install` | Phase 1: deterministic turn-end signals |
| Sidecar daemon | Spawned by wmux on opt-in | Phase 2: Anthropic rate-limit header polling |

## Repo structure decision

**Start in main wmux repo under `integrations/<agent>/`. Agent-agnostic pattern from day 1 (CEO review 2026-05-22). Split to dedicated repo after Phase 2 ships.**

```
D:\wmux\
├── src/                              (wmux core, unchanged)
├── integrations/
│   ├── shared/                       (NEW — cross-agent infrastructure, lifted to top level)
│   │   ├── rpc.ts                    (wmux daemon named-pipe client, agent-agnostic)
│   │   ├── signal-types.ts           (canonical signal taxonomy: agent.stop, agent.activity, ...)
│   │   └── auth-helper.ts            (cross-platform credential reader, Phase 2)
│   └── claude/                       (NEW — first concrete integration)
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── hooks/
│       │   └── hooks.json
│       ├── bin/
│       │   └── wmux-bridge.mjs       (~80 LOC, Node hook executor, translates Claude hook
│       │                              payload → agent-agnostic signal envelope)
│       ├── sidecar/                  (Phase 2; slot only in Phase 1)
│       │   ├── package.json
│       │   └── src/poll.ts
│       ├── marketplace.json          (for /plugin marketplace add)
│       └── README.md
└── plans/
    └── wmux-claude-integration.md    (this file)
```

**Agent-agnostic design (Phase 1, accepted CEO scope expansion 2026-05-22, refined by eng review 2026-05-22):**

- `integrations/shared/` lives at the top of `integrations/`, NOT under `claude/`. New agents reuse it without refactor.
- **Canonical signal envelope** (eng review 2026-05-22):
  ```typescript
  interface AgentSignal {
    kind: 'agent.stop' | 'agent.activity' | 'agent.subagent_stop' | 'agent.session_start';
    agent: 'claude' | 'codex' | 'gemini' | 'aider';  // SLUG form (not display name)
    agentSessionId?: string;                          // Optional, agent-defined opaque id (Claude=sessionId, codex=pid)
    cwd: string;                                       // Resolved to ptyId via workspace.list RPC
    payload: Record<string, unknown>;                  // Raw hook data, agent-specific
    ts: number;                                        // Unix ms, hook fire time (NOT wmux receive time) — drives SignalLatencyMeter
  }
  ```
- **Agent naming**: SLUG form (`claude`, `codex`, ...). `AgentDetector.AgentPattern` gains a `slug: string` field so HookSignalRouter dedup keys match without translation tables.
- **Bridge workspace lookup**: `wmux-bridge.mjs` calls `workspace.list` RPC (already exists, `src/main/pipe/handlers/workspace.rpc.ts:11`). Phase 1 extends the response schema to include `cwd` and `ptyIds` per workspace. No new RPC method.
- **HookSignalRouter** (daemon-side) dispatches on `signal.kind`, not on `signal.agent`. Per-agent quirks live in bridge scripts only.
- **Bridge silent-failure detection**: `SignalLatencyMeter` exposes `lastSignalAt: number | null`. Settings panel "Plugin signal health" card surfaces stale state ("Last hook received 25h ago — plugin may have stopped firing").
- Cost: ~15% more architectural work in Phase 1 (~700→~800 LOC). Rework avoided in Phase 3.

Rationale for in-repo start:
- RPC schema between wmux daemon and integration code must co-evolve in Phase 1. Same-repo PRs avoid two-repo sync cost.
- `release.yml` already auto-publishes wmux. Plugin marketplace manifest can ride along with no new pipeline.
- Splitting later is cheap (git filter-repo or fresh repo + tag); splitting before stable RPC is expensive.

Split trigger: after Phase 2 ships AND we see meaningful adoption outside wmux users (community PRs, issues from non-wmux users).

## Phase 1 — Claude Code hook plugin (READY, dogfood-gated pre-conditions)

### Pre-conditions

- The 2026-05-21 17-item notification expansion PR is merged (confirmed via memory `project_notification_26_concepts_ceo`).
- ≥ 1 week dogfood elapsed since merge.
- At least one concrete dogfood signal that the existing heuristic is wrong. **Confirmed 2026-05-22**: user reports zero notifications on real agent turn-end across multiple workspaces. This is the green light.

### Scope (7 items from 2026-05-21 CEO plan, repackaged for plugin distribution)

| # | Item | Sub-component |
|---|------|---------------|
| 1 | PostToolUse hook receiver | Per-tool-call activity signal (existing `ActivityMonitor` peer) |
| 2 | Stop hook receiver | Turn-end signal — supersedes 5s idle heuristic when plugin installed |
| 3 | SubagentStop hook | /team mode subagent completion routing |
| 4 | SessionStart hook | Metadata reset trigger (clear stale state) |
| 5 | Hook ↔ AgentDetector dedup | Hook signal wins; AgentDetector is fallback when plugin absent |
| 6 | Plugin marketplace entry | `marketplace.json` so users run `/plugin marketplace add openwong2kim/wmux` |
| 7 | First-run onboarding banner | NotificationPanel header prompts install when wmux detects Claude Code use without plugin |
| 8 | **Agent-agnostic architecture** (CEO 2026-05-22) | `integrations/shared/` at top level + canonical signal envelope. Phase 3 cost pre-amortized |
| 9 | **Hook signal latency telemetry** (CEO 2026-05-22) | Local-only ring buffer (max 100 entries) recording (claude turn-end → wmux toast) delta. Settings panel shows P50/P95. No remote telemetry, no opt-in needed because data never leaves disk |

Note: items 21/22/23 from the prior revision (marker-based settings.json editing, opt-in installer, ASAR-external path) are **DROPPED**. Plugin system replaces all three concerns.

### Architecture (Phase 1)

```
USER ACTION (one time):
  /plugin marketplace add openwong2kim/wmux
  /plugin install wmux-claude-integration

CLAUDE CODE LOADS PLUGIN:
  integrations/claude/.claude-plugin/plugin.json → registers hooks
  integrations/claude/hooks/hooks.json (CORRECTED 2026-05-22 codex review P0 #1):
    {
      "hooks": {
        "PostToolUse": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/bin/wmux-bridge.mjs PostToolUse"
        }],
        "Stop": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/bin/wmux-bridge.mjs Stop"
        }],
        "SubagentStop": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/bin/wmux-bridge.mjs SubagentStop"
        }],
        "SessionStart": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/bin/wmux-bridge.mjs SessionStart"
        }]
      }
    }
  # Validated by `claude plugin validate` in CI before publish.

ON EVENT (per hook fire):
  wmux-bridge.mjs (SELF-CONTAINED, no TS imports — codex review P0 #2):
    1. Reads JSON from stdin (Claude Code hook payload)
    2. Reads ~/.wmux/auth-token from disk (CORRECTED codex review P0 #4)
    3. Connects to wmux MAIN PROCESS named pipe (not daemon — codex review P0 #3)
       - Pipe path: \\.\pipe\wmux-{install-id} on Windows
       - Auth: sends WMUX_AUTH_TOKEN header read from disk
    4. RPC: workspace.list → resolves cwd to {workspaceId, ptyId}
    5. RPC: hooks.signal → emits AgentSignal envelope
       └─ HookSignalRouter (in main process):
          ├─ resolveSurface(cwd → ptyId via workspace.list match)
          ├─ dedup against AgentDetector emission ledger (10s window)
          └─ sendNotification (existing pipeline → renderer)

IF wmux NOT RUNNING:
  wmux-bridge.mjs cannot find pipe → log to ~/.wmux/bridge.log → exit 0 silent.
  Hook becomes no-op. Plugin still safe. SignalLatencyMeter detects staleness.

IF AUTH TOKEN MISSING (no ~/.wmux/auth-token):
  wmux is not running OR is pre-token-file version → exit 0 silent + log.
```

### Signal mapping (unchanged from prior revision)

| Hook | Notification type | Surface routing |
|------|-------------------|-----------------|
| PostToolUse | "activity" (suppressed if same surface) | Updates ActivityMonitor `running` state |
| Stop | "agent_completed" | Full 5-channel fan-out via existing policy |
| SubagentStop | "subagent_completed" | Routes to /team's coordinator pane if applicable |
| SessionStart | "session_reset" | Clears stale per-session metadata, never raises a Toast |

### Dedup with AgentDetector

```
Hook arrives at time t for sessionId S, kind=Stop
  → resolve to ptyId P, workspace W (cwd match against registered workspaces)
  → check AgentDetector.recentEvents[P] for {kind:done, ts >= t-10s}
     ├─ match → mark hook as canonical, suppress AgentDetector emission
     └─ no match → emit notification, mark AgentDetector to suppress for 10s

AgentDetector arrives at time t for ptyId P, kind=done
  → check HookSignalRouter.recentEvents[P] for {kind:Stop, ts >= t-10s}
     ├─ match → drop (plugin already won)
     └─ no match → emit notification (fallback path; plugin not installed or hook missed)
```

### Risks + mitigations (Phase 1 only)

| Risk | Mitigation |
|------|-----------|
| Claude Code plugin SDK breaking changes | Pin plugin SDK version in `plugin.json`; CI matrix test against last 2 minor versions |
| Bridge fires for non-wmux Claude sessions | Bridge checks `cwd` against wmux's registered workspace directories; drops if no match |
| Hook bridge loops on its own signal | Bridge ignores signals where `cwd` matches wmux's own dev/build directory |
| Claude Code env changes hook payload schema | Bridge validates payload shape; unknown event types are no-ops, logged for telemetry |
| User uninstalls wmux but plugin still installed | Bridge connects to named pipe; if pipe missing, exit 0 silently. Claude Code unaffected |
| ASAR packaging — Node can't read from ASAR | Plugin lives in `integrations/claude/`, distributed via marketplace separately from wmux ASAR. Bridge is a standalone .mjs |
| Race: hook + AgentDetector both fire | 10s dedup window in HookSignalRouter (architecture above) |
| Multiple wmux installs (dev + prod) competing | Bridge writes to named pipe per-install — pipe name includes install signature; first-match-wins or both receive |
| Plugin marketplace discovery fails | wmux Settings panel includes a "Copy install command" button — user can paste into Claude Code manually |

### Files (Phase 1 estimate)

- `integrations/shared/rpc.ts` (NEW, ~60 LOC) — wmux **MAIN process** named-pipe client (TS, used by daemon-side code only — codex review P0 #3). NOT imported by bridges (bridges are JS-only)
- `integrations/shared/signal-types.ts` (NEW, ~40 LOC) — canonical signal envelope types. NOT imported by bridges (`.d.ts` for documentation; bridges duplicate-declare locally in JS)
- **Auth token (codex review P0 #4)** — RESOLVED by reusing existing wmux infrastructure. `PipeServer` already writes the auth token to `getAuthTokenPath()` (`~/.wmux-auth-token`, mode 0600 via `secureWriteTokenFile`) at startup. No new file needed. Bridges read this path directly. Plan's original `src/main/auth/auth-token-file.ts` NOT created — preexisting code covers it.
- `integrations/claude/.claude-plugin/plugin.json` (NEW, ~20 LOC) — plugin manifest
- `integrations/claude/hooks/hooks.json` (NEW, ~30 LOC) — hook registrations
- `integrations/claude/bin/wmux-bridge.mjs` (NEW, ~120 LOC) — **self-contained JS only** (codex review P0 #2). Inlines minimal RPC client (no TS imports possible from plugin runtime). Reads `~/.wmux/auth-token`. Connects to wmux MAIN process pipe (not daemon, codex P0 #3). Translates Claude hook payload → canonical signal envelope
- `integrations/claude/marketplace.json` (NEW, ~15 LOC) — marketplace listing
- `integrations/claude/README.md` (NEW) — install instructions
- `src/main/hooks/HookSignalRouter.ts` (NEW, ~200 LOC) — daemon-side dedup + routing. Dispatches on `signal.kind`, not on `agent`
- `src/main/hooks/SignalLatencyMeter.ts` (NEW, ~100 LOC) — local-only ring buffer (max 100 entries) for hook arrival latency. `recordSignal(agent, hookFireTs)`, `getStats(): { p50, p95, count, lastSignalAt }`, `isStale(thresholdMs)`. Lockless single-writer ring buffer
- `src/main/pipe/handlers/hooks.rpc.ts` (NEW, ~60 LOC) — receive bridge signals via `hooks.signal` RPC
- `src/main/pipe/handlers/workspace.rpc.ts` — EXTEND existing `workspace.list` to include `cwd` and `ptyIds` per workspace (~10 LOC)
- `src/renderer/components/Notification/HookOnboardingBanner.tsx` (NEW, ~60 LOC) — first-run prompt
- `src/renderer/components/Settings/ClaudeIntegrationSection.tsx` (NEW, ~120 LOC) — install status, copy-command button, uninstall instructions, signal health card (P50/P95 + staleness banner)
- `src/renderer/stores/slices/uiSlice.ts` — `hookIntegrationDetected`, `hookOnboardingDismissed`, `signalHealth: { p50, p95, lastSignalAt }`
- `src/main/pty/AgentDetector.ts` — add `slug: string` field to `AgentPattern`. Dedup integration with HookSignalRouter via slug key
- `src/main/hooks/HookSignalRouter.test.ts` (NEW) — dedup 4-case matrix
- `src/main/hooks/SignalLatencyMeter.test.ts` (NEW) — ring buffer overflow, P50/P95 query, empty/single/N=100 boundaries, isStale
- `integrations/claude/bin/__tests__/wmux-bridge.test.mjs` (NEW) — JSON validation, malformed input, no-daemon graceful exit

Approximate net new for Phase 1: ~13 modules, ~850 LOC. Single PR. (Up from 800 due to eng review adding workspace.list extension + explicit test files.)

### Tests (Phase 1) — eng review 2026-05-22 expanded

- **Unit (wmux-bridge.mjs)**: valid Claude Code Stop/PostToolUse/SubagentStop/SessionStart payloads, unknown event types no-op, malformed JSON exit 0, empty stdin exit 0, no-wmux-running exit 0, workspace.list RPC timeout exit 0, cwd no-match drop with log.
- **Unit (HookSignalRouter)**: dedup 4-case matrix (hook→detector / detector→hook / both-within-10s / outside-10s) × per-pty isolation.
- **Unit (SignalLatencyMeter)** [eng review gap fix]: ring buffer overflow (101+ entries → oldest dropped), P50/P95 query (empty buffer returns nulls / single entry / N=100 boundary), `isStale(threshold)` with `lastSignalAt === null`, timestamp monotonicity (regression on out-of-order ts).
- **Unit (workspace.rpc)**: extended schema returns `cwd` and `ptyIds`. Backward-compat: existing `{id, name}` consumers unaffected.
- **Integration**: full marketplace install flow against stub Claude Code config (RTL + temp dir).
- **Integration**: bridge → workspace.list → hooks.signal end-to-end with real named pipe.
- **E2E (manual dogfood)**: install → run real Claude Code session → verify Stop signal arrives < 200ms after turn end → verify dedup against AgentDetector → verify `SignalLatencyMeter.getStats()` populated → verify Settings panel "signal health" card shows P50/P95.

### NOT in scope (Phase 1)

- Phase 2 sidecar (rate-limit polling) — see below
- Phase 3 multi-agent (Codex / Gemini / etc.) — see below
- Codex hooks (Codex doesn't have an official equivalent hook API yet)
- Rich notification payload (file count, token cost from PostToolUse) — Phase 2 candidate
- Cross-platform hook installer for non-Windows (macOS/Linux) — gated on Windows ship + `[[project_cross_platform_branch_policy]]`
- Automatic plugin upgrade migration when wmux version changes — Claude Code's `/plugin update` handles it

**Deferred to TODOS.md (CEO review 2026-05-22 expansion decisions):**

- **In-app plugin install/uninstall** — Settings panel button that writes Claude Code plugin files directly without CLI. Risk: Claude Code's plugin tracking DB reverse-engineering, path conflicts, permission edge cases. Revisit after Phase 1 ship + dogfood when Claude Code plugin file format is observed stable.
- **Smart notification grouping** — when ≥2 agents complete within 2s, surface as "3 agents finished" rather than 3 separate toasts. Notification policy extension. Demand unproven until hook rates are observed.
- **Plugin auto-detect via Claude Code lockfile** — auto-detect if Claude Code session is running in any wmux pane and surface install banner. Path-fragile.
- **`/team` mode subagent activity timeline** — visualize SubagentStop hook fan-out across team panes. Niche but interesting UX. Phase 2+ candidate.
- **Public RPC for external tools** — let third-party tools subscribe to wmux hook signals over HTTP/named pipe. Phase 3 platform play.
- **Cross-agent context bridge** — forward one agent's turn result as input to another agent. Phase 3+. Big idea, no premise yet.
- **Cost dashboard** — Phase 2 sidecar slot already mentions usage display. Dashboard-level UI is a Phase 2 detail decision, not Phase 1.
- **Cross-workspace status bar widget** — single consolidated view of all workspace agent states. Phase 2 UI surface, depends on what data Phase 2 collects.

## Phase 2 — Rate-limit usage sidecar (SLOT)

### Status

SLOT ONLY. Detailed plan deferred until Phase 1 ships and dogfoods for ≥ 2 weeks. Recording intent + constraints here so Phase 1 doesn't paint Phase 2 into a corner.

### Premise

Anthropic's API exposes unified rate-limit utilization via response headers (`anthropic-ratelimit-unified-5h-utilization`, `-7d-utilization`, `-5h-reset`, `-7d-reset`). A lightweight sidecar polls these by sending a `max_tokens:1` dummy request and parses the headers. Reference: `openwong2kim/claude-token-check` (macOS-only, Swift, menubar UI).

### Inherits from Phase 1

- `integrations/claude/shared/rpc.ts` — wmux daemon named-pipe client (sidecar pushes utilization updates here)
- `src/renderer/components/Settings/ClaudeIntegrationSection.tsx` — adds "Enable usage meter" toggle
- Plugin marketplace listing — adds "wmux Usage Meter" as a sibling component

### New surface (Phase 2 estimated, not designed)

- `integrations/claude/sidecar/` — Node daemon, cross-platform (macOS/Windows/Linux)
- Auth strategy: read `~/.claude/.credentials.json` (or platform keychain) only after user opts in via Settings toggle. Never auto-read.
- Polling cadence: configurable, default 5 minutes. Skip polling when wmux window is hidden > 30 min.
- New IPC: `usage.update` → renderer updates a status-bar indicator with utilization %
- New UI surface: status-bar widget with 5h/7d utilization + reset countdown

### Open questions for Phase 2 design

1. Auth: read credentials file directly vs require user to paste API key? Direct read is convenient but adds a security review surface.
2. Dummy request: which model to target? Cheapest possible (Haiku) — confirm header presence on Haiku responses.
3. Failure modes: rate-limited on the dummy request itself, expired credentials, no internet — each needs distinct UI state.
4. Cost: the dummy request is non-zero. Quantify monthly cost at default cadence; surface to user before enabling.
5. macOS Keychain integration: required for parity with `claude-token-check` or skip and use plain file read?

### NOT in scope (Phase 2)

- Cost dashboard / history graphs — Phase 3+ candidate
- Per-session token attribution — wmux's existing `TokenTracker.ts` already covers this from PTY output
- Subscription type detection (Pro / Max / Team) — could be inferred from header values; defer
- Anthropic Console integration — out of scope

## Phase 3 — Multi-agent extension (SLOT)

### Status

SLOT ONLY. Recorded as an aspirational target so the Phase 1 architecture doesn't accidentally couple to "Claude Code" specifically when "AI coding agent" would generalize.

### Vision

Once Claude Code (Phase 1+2) ships and stabilizes, the same `integrations/` shape becomes the home for other agents:

```
integrations/
├── claude/    (Phase 1 + 2, shipped)
├── codex/     (Phase 3 — when Codex ships official hooks)
├── gemini/    (Phase 3 — when Gemini CLI gains hook API)
└── shared/    (lifted from claude/shared/ when 2nd integration arrives)
```

### Trigger conditions

A new `integrations/<agent>/` folder is created when:
1. That agent has an official, stable hook or event API (no scraping stdout).
2. ≥ 1 wmux user actively wants the integration (issue / PR / dogfood report).
3. Reuse of `shared/rpc.ts` covers ≥ 50% of the integration's needs.

If a candidate fails any of these, it stays out. We do not pre-build integrations on hypothesis.

### NOT in scope (ever — explicit guardrails)

- Generic "AI agent abstraction layer" with pluggable backends. Each agent gets its own folder; no premature abstraction.
- Forking or contributing to Claude Code itself, Codex CLI, etc. wmux integrations live in wmux's repo only.
- Vendor-lock features (e.g. one-click subscription upgrade, payment surfaces). wmux stays neutral on commercial agent tier.

## Sequencing (across phases)

1. **Phase 1**: `/plan-ceo-review` + `/plan-eng-review` this revised plan → implementation PR → ship behind `hookIntegrationDetected = auto`. Default UX: NotificationPanel banner prompts install when wmux detects user is on Claude Code without the plugin.
2. **Phase 1 dogfood**: ≥ 2 weeks. Track (a) plugin install rate, (b) hook signal arrival latency, (c) dedup correctness via telemetry counts.
3. **Phase 2 design**: open questions list above gets resolved via dedicated `/plan-eng-review` once Phase 1 dogfood data is in. Phase 2 PR is separate, ~300 LOC sidecar + ~100 LOC UI.
4. **Phase 2 dogfood**: ≥ 2 weeks, focus on auth failure modes + polling cost.
5. **Phase 3**: triggered only by an external integration request meeting the trigger conditions above. No proactive Phase 3 work.

## Capacity budget (honest math)

Personal time, 8–12 hours/week sustainable. Concrete per-milestone
allocation:

| Milestone | Estimated hours | Wall-clock at 10h/w | Cut trigger |
|-----------|----------------|---------------------|------------|
| Phase 1.5 (UI + dedup wiring) | 20–30 | 2–3 weeks | If > 3 weeks elapsed at midpoint, cut top of README fallback ladder |
| Phase 2 (rate-limit sidecar) | 40–60 | 4–6 weeks | If > 4 weeks elapsed without first sidecar prototype, descope to single-window utilization |
| Phase 3 slot | n/a | n/a | Demand-driven only |

Re-evaluate at each milestone gate. If reality falls short of estimate,
**cut from the README fallback ladder before extending the calendar.**
Silent slipping is the worst failure mode.

## Risk: Anthropic roadmap collision

If Anthropic ships first-party UI for any of the following during
Phase 1.5 or Phase 2 window, re-evaluate scope:

- **Native hook-signal dashboard** in Claude Code itself (5h/7d
  utilization, hook latency, per-tool counters). → Phase 2 sidecar
  scope shrinks materially. Likely just a wmux-side adapter that
  reads Claude Code's exposed data rather than polling Anthropic.
- **Multi-agent native UI** (Agent View descendant) that handles
  /team-style fan-out without external multiplexer. → Phase 1
  notification path still useful for non-/team workflows, but the
  "multi-agent orchestration" narrative weakens. Plugin alone is
  still defensible.
- **Plugin marketplace UI inside Claude Code** that auto-installs
  wmux-claude-integration on first detection of wmux running. →
  Cut the Phase 1.5 onboarding banner entirely; the marketplace
  does the discovery work.

Monitor monthly: Claude Code release notes + `code.claude.com/docs`
changelog. Record any move in this plan's revision history.

## Pre-Phase-2 dogfood gate (n=3 external users)

Before Phase 2 implementation starts, run a small external dogfood
session to confirm the Phase 1 install + signal path works for
someone who is NOT the author. Concrete protocol:

- **Three participants** (n=3). Selected from outside the author's
  immediate circle: Kyungshin AI TFT non-KAD-team members, Korean
  indie iOS developer Slack, or Threads dev-profile replies. Pay
  honorarium ₩30,000 per session.
- **Single 20-minute task**: install wmux + plugin from a fresh
  setup, run one Claude Code session, report whether they received
  any wmux notification when the session ended.
- **Gate**: ≥ 2 of 3 receive a notification within their first
  Claude Code Stop event → Phase 2 starts as planned. < 2 → Phase
  1.5 polish gets another lap before Phase 2 begins.
- **Trigger**: invoke after Phase 1.5 hard-floor item ships (the
  PTYBridge dedup wiring), not before. There is no point dogfooding
  a known double-notification state.

The point of this gate is to avoid Phase 2 over-fitting to the
author's own dogfood signal. The author IS the most biased dogfood
source for this codebase; n=3 outside opinions are not statistically
robust but they are noise-bounded enough to catch directional
problems (e.g., "no one figured out the install command", "the
notification is too quiet to notice").

## Open questions for next CEO review of this plan

1. Should the marketplace entry be on the official `claude-plugins-official` marketplace or only on a wmux-owned marketplace (`openwong2kim/wmux`)? Trade-off: discoverability vs. review cycle dependency.
2. Default to "plugin auto-detected" silent-detect, or always show the install banner once on first Claude Code use? UX feel.
3. Plugin uninstall — should wmux Settings include a "Disable hook integration" toggle that doesn't actually uninstall the plugin (just stops processing signals), for users who want to keep the plugin but pause it temporarily?
4. Telemetry — is hook arrival latency something we want to measure? If yes, where does the data go (existing wmux telemetry, or none)?
5. Phase 2 dummy-request cost — is wmux comfortable being responsible for a recurring API cost on behalf of users, even a tiny one? Or is "user pastes API key + reads their own consumption" the cleaner ethical line?

## CEO Review (2026-05-22, SCOPE EXPANSION mode)

### Mode + premise

SCOPE EXPANSION selected by user. Premise validated 3 ways:
1. Direct user dogfood report 2026-05-22 ("no alarm at all" across workspaces)
2. TODOS.md line 76-89 already lists this as P1 (4-week gate passed)
3. Heuristic false-negative empirically observed (this conversation)

### Implementation alternatives considered (0C-bis)

- **A** Plugin + sidecar, main repo `integrations/<agent>/` — CHOSEN
- **B** Separate repo from day 1 — rejected (premature, schema not stable yet)
- **C** Settings.json marker-bound edit — rejected (substrate neutrality violation, hooks override risk)

### Expansion decisions

| # | Proposal | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Agent-agnostic Phase 1 architecture | **ACCEPTED to scope** | Architectural — deferring means Phase 3 rework. Phase 3 slot already in plan, so abstraction shape is committed regardless |
| 2 | In-app plugin install/uninstall | DEFERRED to TODOS.md | Claude Code plugin tracking DB reverse-engineering = brittle. Revisit after Phase 1 ship + dogfood |
| 3 | Hook signal latency telemetry (local-only) | **ACCEPTED to scope** | Cheap (~80 LOC), no privacy concerns (never leaves disk), gives Phase 2/3 design data foundation |
| 4 | Cross-workspace status bar widget | DEFERRED | Depends on Phase 2 data shape |
| 5 | Smart notification grouping | DEFERRED | Demand unproven until hook rates observed |
| 6 | Plugin auto-detect via lockfile | DEFERRED | Path-fragile, defer |
| 7 | /team mode subagent timeline | DEFERRED | Niche UX, Phase 2+ candidate |
| 8 | Public RPC for external tools | DEFERRED | Phase 3 platform play |
| 9 | Cross-agent context bridge | DEFERRED | Phase 3+, no premise yet |
| 10 | Cost dashboard | DEFERRED | Phase 2 detail, slot exists |

Result: 2 accepted to Phase 1 scope, 8 deferred to TODOS.md / Phase 2-3 slots. Phase 1 net LOC ~700 → ~800.

### Sections 1-11 findings (compressed)

| Section | Status | Note |
|---------|--------|------|
| 1. Architecture | OK | Agent-agnostic refactor (expansion #1) handles 12-month trajectory. cwd→ptyId resolution is the single coupling point — well-isolated in `HookSignalRouter.resolveSurface` |
| 2. Error & Rescue | **GAP** | Bridge stdin read failure (Claude Code abnormal exit) not surfaced. Bridge currently `exit 0 silent`. User has no way to know hook integration broke. Add: SignalLatencyMeter detects "no signals in N minutes" → surface to onboarding banner |
| 3. Security | **GAP** | Bridge's workspace cwd list source unspecified. Need: bridge queries wmux daemon via shared/rpc.ts for `getRegisteredWorkspaces()` rather than reading state files directly. Otherwise stale cwd list = wrong-target notifications |
| 4. Data/UX edges | OK | Hook payload validation in plan. Concurrent fires handled by per-pty dedup. Burst case (smart grouping) deferred but tracked |
| 5. Code quality | NOTE | New modules should follow `AgentDetector.onEvent(callback)` registration pattern for consistency. Add to README convention |
| 6. Tests | **GAP** | SignalLatencyMeter unit test missing from plan's test list. Add: ring buffer overflow, P50/P95 query correctness, timestamp monotonicity |
| 7. Performance | OK | Ring buffer fixed memory. Hook burst handled by dedup. PostToolUse frequency not specified but tool-call-count bounded |
| 8. Observability | **GAP** | Bridge `exit 0 silent` is invisible. Pair with Section 2 fix: latency meter `staleness` field surfaces "no hooks recently" to user |
| 9. Deployment | OK | Plugin updates independent of wmux release. Rollback = uninstall plugin OR toggle off in Settings (which one? plan should pick) |
| 10. Long-term | OK | Reversibility 4/5. Agent-agnostic decision pre-amortizes Phase 3 debt |
| 11. Design/UX | **WARNING** | HookOnboardingBanner copy at risk of AI slop ("Install plugin for better notifications"). Defer to `/plan-design-review`. Banner must be dismissible + keyboard accessible |

### Critical gaps to address before implementation PR

1. **Section 2 + 8 (combined)**: Bridge silent-failure detection. SignalLatencyMeter exposes `lastSignalAt` timestamp; UI surfaces stale state if plugin was working but stopped.
2. **Section 3**: Specify bridge's workspace lookup mechanism. RPC call to daemon, NOT direct state file read.
3. **Section 6**: Add SignalLatencyMeter unit tests to plan's test list.
4. **Section 11**: Banner copy gets `/plan-design-review` treatment, not implementer choice.

### NOT in scope (final)

See "Deferred to TODOS.md" block above + the original Phase 1 NOT-in-scope list.

### What already exists (leveraged)

- `AgentDetector` — becomes fallback (heuristic), wins via dedup when hook fires
- `sendNotification`, `HookSignalRouter` integrates here, no new dispatch path
- `useNotificationPolicy` (17-item PR) — handles fan-out unchanged
- Named pipe RPC — `hooks.rpc.ts` is just another handler

### Dream state delta

Plan moves wmux from "heuristic agent monitor" → "universal agent integration hub" (12-month ideal). Expansion #1 (agent-agnostic) is the load-bearing decision. Without it, Phase 3 = rewrite. With it, Phase 3 = drop-in folder.

## Eng Review (2026-05-22)

### CEO gaps resolved

| Gap | Resolution | Plan section updated |
|-----|-----------|----------------------|
| #1+#8 Bridge silent-failure | SignalLatencyMeter exposes `lastSignalAt`. Settings card surfaces stale state | Architecture, Files |
| #2 Bridge workspace lookup | Use existing `workspace.list` RPC. Extend response with `cwd` + `ptyIds` (no new RPC) | Architecture, Files |
| #3 SignalLatencyMeter unit test | Explicit test file added with 5 case categories (overflow, query, boundary, stale, monotonic) | Tests |
| #4 Section 11 design slop | Defer to `/plan-design-review` for banner/Settings copy. Not eng review scope | Open question for design review |

### Architecture decisions locked

- **Signal envelope**: `{ kind, agent (slug), agentSessionId?, cwd, payload, ts }`. `ts` drives latency meter
- **Agent naming**: SLUG form (`claude`, `codex`, `gemini`, `aider`). `AgentPattern.slug` added to `AgentDetector`
- **10s dedup window**: maintained. SignalLatencyMeter P95 data will drive future tuning
- **Bridge workspace lookup**: `workspace.list` RPC extension (existing handler, +`cwd`/`ptyIds` fields)
- **HookSignalRouter dispatch**: on `signal.kind`, not on `agent`. Per-agent quirks isolated to bridges

### Sections 1-4 findings

| Section | Issues | Resolution |
|---------|--------|-----------|
| 1. Architecture | 5 findings (1.1-1.5) | 2 obvious fixes auto-applied to plan, 2 user decisions (envelope+naming), 1 monitoring note (10s window) |
| 2. Code Quality | No major issues | Convention noted (follow `AgentDetector.onEvent` callback pattern) |
| 3. Test Review | Coverage diagram produced, 15 paths identified, all new (Phase 1 not impl yet). All 15 must be covered before merge | Test list expanded in plan |
| 4. Performance | 1 concern (PostToolUse burst → bridge spawn 30ms × N could backlog) | Deferred to Phase 1.5 once rate observed. Not blocking |

### Failure modes registry (post-resolution)

| Codepath | Failure | Rescued? | Test? | User sees? |
|----------|---------|----------|-------|-----------|
| wmux-bridge.mjs malformed JSON | exit 0 + log to `~/.wmux/bridge.log` | YES | YES (added) | Silent — surface via SignalLatencyMeter staleness |
| wmux-bridge.mjs no daemon | exit 0 silent | YES | YES (added) | Silent — surface via SignalLatencyMeter staleness |
| workspace.list timeout | exit 0 | YES | YES (added) | Silent — surface via SignalLatencyMeter staleness |
| HookSignalRouter dedup miss | emit duplicate notification | NO (acceptable: dup > drop) | YES (added) | Two toasts (user sees) |
| AgentDetector fires after hook | dedup drops detector emission | YES | YES (added) | Single toast |

**Critical gaps remaining**: 0. All CEO gaps resolved or explicitly deferred with rationale.

### Parallelization strategy

| Step | Module | Depends on |
|------|--------|------------|
| 1. shared/ infra (rpc.ts, signal-types.ts) | `integrations/shared/` | — |
| 2. AgentDetector slug field | `src/main/pty/` | — (independent) |
| 3. HookSignalRouter + hooks.rpc | `src/main/hooks/`, `src/main/pipe/handlers/` | Step 1 (envelope types), Step 2 (dedup) |
| 4. SignalLatencyMeter | `src/main/hooks/` | Step 1 |
| 5. workspace.list extension | `src/main/pipe/handlers/`, `src/renderer/` | — (independent) |
| 6. integrations/claude/ (plugin manifest, bridge.mjs) | `integrations/claude/` | Step 1 |
| 7. Settings ClaudeIntegrationSection + Banner | `src/renderer/components/` | Step 4 (signal health data) |

**Parallel lanes** (worktree-suitable):
- **Lane A**: Steps 1, 2, 5 (all independent foundational work)
- **Lane B** (after A merges Step 1): Steps 3, 4, 6
- **Lane C** (after Lane B): Step 7

3 lanes, mostly parallel, ~1 merge gate between lanes.

## Codex Review (2026-05-22, outside voice)

### Findings summary

Codex independently reviewed the plan after CEO + Eng review. Found 14 issues across severities:

| Severity | Count | Status |
|----------|-------|--------|
| P0 | 4 | **All 4 applied to plan body (this revision)** |
| P1 | 6 | Deferred to TODOS.md per user decision 2026-05-22 |
| P2 | 3 | Deferred to TODOS.md |
| P3 | 1 | Deferred to TODOS.md |

### P0 findings (APPLIED to plan)

| # | Finding | Resolution |
|---|---------|-----------|
| 1 | Hook schema used `${pluginDir}` and missed `type:"command"`/`hooks` wrapper | Plan's `hooks.json` block corrected to official Claude plugin schema with `${CLAUDE_PLUGIN_ROOT}`. CI requirement added: `claude plugin validate` |
| 2 | Plan's `integrations/shared/rpc.ts` (TS) cannot be imported from a Node plugin runtime | Bridge declared **self-contained .mjs**, inlines minimal RPC client. `shared/rpc.ts` flagged as wmux-internal only. Bridge LOC budget raised 80→120 to absorb inlined client |
| 3 | RPC target unclear — plan said "daemon named-pipe" but `workspace.rpc` is in main process | Plan corrected throughout: bridge connects to **wmux MAIN process named pipe**. Daemon's `daemon.*` namespace not involved in Phase 1 |
| 4 | Auth token missing — `WMUX_AUTH_TOKEN` not inherited by Claude Code child processes | New file `src/main/auth/auth-token-file.ts` writes `~/.wmux/auth-token` (mode 0600). Bridge reads it. Rotation + cleanup specified |

### P1 findings (DEFERRED to TODOS.md)

| # | Finding | Why deferred |
|---|---------|--------------|
| 5 | "SDK pin in plugin.json" is fake — schema has no SDK version field | Replace with Claude version check at implementation time. Not blocking architecture |
| 6 | `workspace.list` extension not cheap (tree traversal, stale-pty handling, daemon/local parity) | Implementation-time complexity. Allocate extra LOC budget |
| 7 | `cwd` routing too weak — `WMUX_WORKSPACE_ID`/`WMUX_SURFACE_ID` env exists per `docs/PROTOCOL.md:381` | **Strong recommendation**: env-first routing is materially better. Defer is risky — flag as P1 TODO with high priority |
| 8 | Dedup ledger doesn't exist — AgentDetector has private `lastEmittedFor` only | Implementation must add explicit emission ledger at notification boundary. Documented in Files section |
| 9 | `PostToolUse` spawn cost real, plan understates | Implementation option: drop PostToolUse from Phase 1 if dogfood shows lag. Stop/SubagentStop/SessionStart can ship without it |
| 10 | "Silent-failure detection" mislabeled — no signals ≠ broken plugin | Add explicit heartbeat path in Phase 1.5 or pair with banner state machine |

### P2 findings (DEFERRED)

| # | Finding | Resolution |
|---|---------|-----------|
| 11 | `NotificationType` taxonomy collision — domain `agent.stop` vs renderer `'agent'` | Implementation: keep signal `kind` separate from renderer `NotificationType`. Translate at HookSignalRouter |
| 12 | Release distribution doesn't actually publish a plugin package | Add `release.yml` step + `forge.config.ts` `extraResource` extension when Phase 1 implementation begins |
| 13 | Phase 2 `auth-helper.ts` contaminates Phase 1 files list | Removed from Phase 1 Files list. Stays in Phase 2 SLOT |

### P3 findings (DEFERRED)

| # | Finding | Resolution |
|---|---------|-----------|
| 14 | Plan internally inconsistent — `integrations/shared/` vs `integrations/claude/shared/` | This revision standardizes on `integrations/shared/` at top level. Some older paragraphs may still say `claude/shared/` — cleanup in follow-up PR |

### Cross-model tension analysis

**Claude (CEO + Eng) missed**:
- Hook schema spec validation against official Claude plugin docs (P0 #1)
- TS-in-plugin Node module resolution (P0 #2)
- Main vs daemon pipe distinction (P0 #3)
- **Auth token surface** (P0 #4) — biggest miss, security-critical
- AgentDetector internal dedup structure (P1 #8)
- WMUX_WORKSPACE_ID env existence (P1 #7)
- PostToolUse cost magnitude (P1 #9 — Claude said "Phase 1.5 burst handling"; codex says "drop or async-batch")

**Claude was right about** (codex didn't contest):
- Plugin marketplace direction (substrate-neutral)
- Agent-agnostic envelope value
- 10s dedup window

**Verdict**: Codex review was high-value. 4 P0 fixes are non-negotiable for implementation correctness. P1 #7 (env-first routing) is the strongest soft recommendation — should be revisited before implementation PR.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy across 3 phases | 1 | DONE_WITH_GAPS → resolved by eng | SCOPE EXPANSION, 2 accepted/8 deferred, 4 critical gaps |
| Codex Review | `/codex review` (outside voice via eng review) | Independent challenge | 1 | DONE_WITH_GAPS | 14 findings (4 P0 fixed / 10 P1-P3 deferred) |
| Eng Review | `/plan-eng-review` | Phase 1 architecture lock-in, RPC schema, test plan | 1 | CLEAN (pre-codex) | 4 CEO gaps resolved, envelope+naming locked, 15 test paths, 3 parallel lanes |
| Design Review | `/plan-design-review` | Onboarding banner UX + Settings integration section | 0 | — | — |
| DX Review | `/plan-devex-review` | Plugin install friction, marketplace UX | 0 | — | — |

**CODEX:** 4 P0 (schema, TS in plugin, RPC target, auth) APPLIED. 10 lower-severity findings deferred to TODOS.md per user 2026-05-22.

**CROSS-MODEL:** Claude missed 4 P0 spec/security issues that codex caught. Codex confirmed Claude's strategic direction (plugin marketplace, agent-agnostic envelope, 10s dedup).

**UNRESOLVED:** P1 #7 (env-first routing) flagged as strongest deferred recommendation — revisit before implementation PR.

**VERDICT:** CEO + ENG + CODEX COMPLETE. Plan is implementation-ready after one more pass on P1 #7 (env-first routing) and `/plan-design-review` for banner/Settings copy. P0 fixes locked, P1-P3 captured for follow-up. Goal `ceo > eng > codex` achieved.
