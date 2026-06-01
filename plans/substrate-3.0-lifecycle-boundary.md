# Substrate 3.0 — Lifecycle Boundary (idle-shutdown gray zone, redrawn)

Status: design / plan-level. Not a wire-contract change yet.
Basis: prior-art research (Hydra 1975 → X11 → Exokernel; tmux/systemd/Docker/
kubelet/LSP/Postgres/mosh comparison) + internal substrate audit (2026-06-01).

## Why this exists

`docs/PROTOCOL.md` defines three substrate contract layers — **state**, **event**,
**identity** — and explicitly says wmux "owns panes, terminal I/O, and the event
bus. It does not own workflow logic." But the protocol is **silent on session/daemon
lifecycle**. Meanwhile the daemon hard-codes a pile of lifecycle *policy*:

| Concern | Where | Configurable? |
|---|---|---|
| idle-shutdown (exit when 0 live sessions, 5 min) | `Watchdog.ts:149-167`, `index.ts:1199-1208,1295-1307`, `config.ts:41` | ✅ config + env, `0`=off |
| MAX_SESSIONS cap = 200 | `DaemonSessionManager.ts:97` | ❌ hard-coded literal |
| MAX_RECOVER_SESSIONS = 40 | `index.ts:43` | ❌ hard-coded |
| dead-session TTL = 24h | `DaemonSessionManager.ts:16,160`, reaper `index.ts:1316-1336` | ⚠️ default-backed, fixed at create |
| suspended TTL = 7d | `StateWriter.ts:26` | ❌ hard-coded |
| memory-pressure reap/block (500/750/1024 MB) | `Watchdog.ts:40-42` | ❌ hard-coded |

The neutrality principle is honored for state/event/identity but never extended to
lifecycle. "idle-shutdown" got labeled the gray zone. After the research, that label
is **wrong** — see below. The real gray zone is narrower and elsewhere.

## The classification test (prior art)

1. **Independence** — can the behavior change by parameter / upper-layer module
   without touching the mechanism? → policy.
2. **Universality (Hydra)** — must every client decide it identically, or does the
   right answer depend on who is asking? → if it depends, policy.
3. **Fairness carve-out (Hydra / Exokernel)** — a substrate MAY embed the *minimum*
   policy needed to protect its own integrity, but only if: (a) the substrate itself
   breaks without it, (b) the **threshold is configurable**, (c) it fires on
   **measured resource pressure or count, never on idle-time/age/intent**.

Empirical pattern across 7 systems: **idle-time-based eviction is always policy and
always off-by-default or in an outer layer** (Postgres `idle_session_timeout=0`, tmux
`destroy-unattached=off`, mosh tmout unset, LSP "client decides shutdown"). No mature
core daemon auto-kills live sessions on idle. Resource *floors* (OOM killer, kubelet
eviction, Postgres `max_connections`, containerd GC) live in the substrate — all with
configurable thresholds, all firing on pressure, never on idle.

## Redrawing idle-shutdown: it was two things, conflated

"idle-shutdown" bundled two behaviors that belong in different tiers:

- **exit-empty** — daemon exits when **0 live sessions** remain (after a grace
  window). This is tmux's `exit-empty` (default **on**, configurable). It is NOT
  idle-time eviction: it fires on *count == 0*, the daemon has literally nothing to
  hold. → **Legitimate substrate, Tier 1/2. Stays. Not a gray zone.**
  wmux's current idle-shutdown IS exactly this (`listLiveSessions() === 0` →
  `Watchdog.evaluateIdle`), and it's already escapable. ✅ correct as-is.

- **idle-timeout eviction** — kill/suspend a session (or exit the daemon) because
  *live sessions have been idle for N time*. This is intent-based. → **Policy.
  Tier 3. Out of substrate.** wmux does NOT do this today, and must not.

So the gray zone is not "idle-shutdown." idle-shutdown (= exit-empty) is fine. The
remaining gray is two narrower things:
1. **Hard-coded thresholds** on the legitimate floors (MAX_SESSIONS, memory) — Tier 2
   requires them configurable; literals violate that.
2. **Age-based TTLs** (dead 24h, suspended 7d) — need the GC-vs-eviction distinction.

### GC vs eviction (resolves the TTL question)

Reaping a **dead/suspended** session is **garbage collection of a tombstone** — there
is no live process behind it, only retained metadata + scrollback. Prior art
(containerd GC of unreferenced blobs/snapshots) says GC of dead artifacts IS
legitimate substrate mechanism, with configurable retention. → dead/suspended TTL =
**Tier 2 (configurable GC)**, not policy. Reaping a **live** idle session is eviction
= **Tier 3 (policy, outer layer)**. wmux only reaps dead/suspended. ✅ correct kind;
just needs configurable retention.

## The three-tier lifecycle model

```
TIER 1 — MECHANISM (substrate core, non-negotiable, no knob)
  · create / destroy / attach / detach
  · persist-across-detach + recover (the recovery promise)
  · exit-empty (exit when 0 live sessions; grace window configurable)
  · track lastActivity / idleSince / createdAt  (facts, no action attached)
  · emit lifecycle events: session.created / .idle / .destroyed / daemon.idleSince

TIER 2 — RESOURCE FLOOR (substrate, CONFIGURABLE threshold, fires on pressure/count)
  · MAX_SESSIONS cap → refuse new with RESOURCE_EXHAUSTED (never evict existing)
  · memory-pressure guard → block new + reap DEAD (never kill live)
  · dead/suspended tombstone GC (retention configurable)
  Rule: protect the substrate's own integrity, react to MEASURED pressure/count,
        refuse-or-GC — never evict a live session.

TIER 3 — POLICY (outer layer: GUI app / plugin / operator, OFF by default)
  · idle-session reaping ("kill sessions idle > Nh")
  · suspend-on-idle / checkpoint
  · session age TTL eviction of LIVE sessions
  · "kill oldest to make room"
  Substrate's only role: emit the event + expose the fact. The DECISION lives here.
```

## Migration items (substrate 3.0)

1. **Reclassify + rename idle-shutdown → `exitEmpty` semantics.** It is not a gray
   zone; document it as Tier-1/2 exit-empty (tmux precedent). Keep configurable
   (`idleShutdownMinutes`, `0`=off already exists). No behavior change; doc + naming.
2. **Make Tier-2 thresholds configurable** (the actual defect): surface
   `maxSessions`, memory thresholds, `maxRecoverSessions`, dead/suspended TTL in
   `config.json` with the current values as defaults. Tier-2 floors are legitimate
   ONLY when the threshold is a knob, not a literal.
3. **Keep refuse-not-evict.** MAX_SESSIONS already throws `RESOURCE_EXHAUSTED`
   (v2.8.2) — that's the correct floor behavior. Never add silent eviction of live
   sessions to make room.
4. **Add the lifecycle contract to PROTOCOL.md** (the missing 4th surface):
   - session-list fields: `createdAt`, `lastActivity`, `idleSince`, `state`.
   - events: `session.idle` / `session.active` / `session.idleThresholdExceeded`
     (threshold configurable, emit-only — substrate never acts on it).
   - knobs: `exitEmpty`/`idleShutdownMinutes`, `maxSessions`, memory floor, TTLs.
   - §7 boundary entry: "Lifecycle neutrality — substrate enforces resource FLOORS
     (configurable, pressure-based, refuse/GC) and emits idle FACTS; it never evicts
     a live session on idle/age. That is outer-layer policy."
5. **Never bring Tier-3 into substrate.** Auto-reaping of live idle sessions stays in
   the GUI/plugin layer, subscribing to `session.idleThresholdExceeded` and calling
   the `destroySession` mechanism. (PR #86 already declined this — correct.)

## What this means for the open features

- **PR #86** (workspace.close dispose + tray count): Tier-1 mechanism + visibility.
  Clean. Merge as-is.
- **selective background-session cleanup UI** (discussed): 100% Tier-3 outer layer.
  Substrate's only obligation is item 4 (expose `idleSince` + emit idle events).
  The "which to kill / when" UI is the GUI app's.
- **the 500MB problem**: solved within neutrality by Tier-2 (configurable cap, refuse
  new) + Tier-3 (GUI surfaces idle facts, user/plugin decides). Substrate never
  kills a live agent session on its own.

## Resolved decisions (eng review 2026-06-01)

Full eng review (architecture / code-quality / test / performance) + codex independent
review. The body above is the design rationale; this section is the build contract.

- **D1 — exitEmpty default: ON** (tmux precedent = current wmux behavior); disable via
  `idleShutdownMinutes: 0`. No behavior change.
- **D2 — `session.idleThresholdExceeded`: DEFERRED to v3.1.** No Tier-3 consumer exists;
  wiring an unused event into the contract is a proxy-metric anti-pattern. v3.0 may expose
  idle FACTS (`lastActivity` / `idleSince`) but emits no idle event.
- **D3 — dead/suspended TTL: keep daemon-side GC (Tier-2, configurable).** Tombstones are
  substrate storage. (GC framing corrected per codex below; per-session persistence noted.)

### Implementation scope (locked)

Real work = **5 new config knobs + 1 existing cleanup + PROTOCOL.md doc.** Not "6".

| Knob | Source today | Action |
|---|---|---|
| `maxSessions` | `DaemonSessionManager.ts:97` literal 200 | → config |
| `memWarnMb` / `memReapMb` / `memBlockMb` | `Watchdog.ts:40-42` static 500/750/1024 | → config (static→instance) |
| `suspendedTtlHours` | `StateWriter.ts:26` literal 7*24 | → config (thread into load/prune) |
| `deadSessionTtlHours` | already in config (`config.ts:49`) | cleanup dup at `DaemonSessionManager.ts:16` |
| ~~`maxRecoverSessions`~~ | `index.ts:43` literal 40 | **NOT exposed — derive from `maxSessions`** |

- **Naming:** docs/concept only → "exit-empty". Config key `idleShutdownMinutes` + all code
  symbols FROZEN (validateConfig silently drops unknown keys → renaming wipes a user setting).
- **Default SSOT:** `createDefaultConfig`; modules import from there; clean up the dead-TTL dup.
- **maxRecoverSessions:** derive from `maxSessions` (e.g. `min(maxSessions, 40)`), never a
  separate knob — startup headroom heuristic, not a floor. `maxRecover ≤ maxSessions` by
  construction (kills the data-loss config, codex #4).
- **Clamp policy (per-field, NOT one generic rule):**
  - `idleShutdownMinutes`: `0` = off (unchanged).
  - `maxSessions`, memory triple, `suspendedTtlHours`: **hard min clamp** (0/neg → floor;
    no "off"). Permanent retention = large TTL, not 0.
  - memory triple: **absolute upper cap** too (mirror `bufferSizeMb` HARD_CAP `config.ts:91`)
    so a value above physical RAM can't silently disable protection.
  - order invariant `memWarn ≤ memReap ≤ memBlock`, corrected after per-field clamp.
  - malformed lifecycle field → **per-field backfill** (that field → default; rest preserved).
    Whole-file reset ONLY for core-structure breakage. Never nuke pipeName for a maxSessions
    typo (codex #13).

### Outside-voice corrections (codex gpt-5.5, 2026-06-01)

Body-text fixes (the design above is wrong in three spots):
- **Tier model self-contradiction (codex #6):** "Tier 2 never age-based" then files
  dead/suspended TTL (age-based, `StateWriter.ts:205`) under Tier 2. Reword: Tier-2 has TWO
  mechanisms — (a) pressure/count floors (maxSessions, memory) and (b) GC of tombstones
  (age-based, but GC of dead artifacts ≠ eviction of live sessions). "Never age-based"
  applies to (a) only.
- **"not a wire-contract change" is false once PROTOCOL.md documents knobs (codex #11):**
  config keys become an operator contract. v3.0 adds a daemon **config contract** (distinct
  from the pane/event/identity wire contract, but a contract).
- **scope "6" → "5 new + 1 cleanup" (codex #1);** keep Tier prose from driving unnecessary
  protocol language (codex #15).

Build-time landmines the review missed (codex caught):
- **[P1] Startup sequencing (codex #3):** `acquireLock()` builds `new StateWriter(wmuxDir)`
  and `.load()`s BEFORE normal config load (`index.ts:222`). Threading config into
  StateWriter means this early path must get config too, or suspended-TTL prune runs on the
  default. Handle BOTH startup paths.
- **[P1] maxSessions lowered below persisted recoverable (codex #4):** recovery must cap
  gracefully (recover up to the limit, keep the rest SUSPENDED) and **never mark the overflow
  dead** (`index.ts:412`). Data-loss-shaped. Explicit test required.
- **[P1/critical-gap] memory block sticky → silent boot brick (codex #9):** sticky until
  RSS < block (`Watchdog.ts:101`). A block below normal idle RSS permanently blocks new
  sessions on boot, silently. Min sane floor + startup warning log (not silent).
- **[P2] dead TTL is per-session persisted (codex #5):** `deadTtlHours` stored per session
  (`DaemonSessionManager.ts:160`), reaper uses per-session value (`index.ts:1332`). Config
  applies to NEW sessions only; existing tombstones keep create-time value. No silent
  retroactive change.
- **[P2] suspended TTL threading (codex #2):** not just an import — `StateWriter.load()`
  prunes before recovery (`:167`), config must reach the load/prune path.

### Test requirements

5 critical regressions (IRON RULE):
1. Old v1 config.json (no new fields) → defaults backfilled, existing fields +
   `idleShutdownMinutes` preserved. (highest priority)
2. Watchdog static→instance: default 500/750/1024 escalation unchanged.
3. `maxSessions` default 200, `suspendedTtlHours` default 7d, recovery default 40 unchanged.
4. **maxSessions < persisted recoverable → overflow stays SUSPENDED, none marked dead.**
5. memory block below idle RSS → clamped to min + warning logged (no silent brick).

New unit coverage: createDefaultConfig new-field defaults; validateConfig per-field backfill
(absent / valid / garbage → that field only); loadConfig clamp (over-cap, ≤0 floor, mem
order inversion, passthrough, absolute upper cap). No E2E/eval. Dogfood: existing-config
update preserves settings; low maxSessions reflected; garbage/inverted memory triple keeps
daemon sane. (Full diagram: `~/.gstack/projects/openwong2kim-wmux/rizz-fix-daemon-exit-observability-eng-review-test-plan-20260601.md`)

## NOT in scope

- **D2 idle event** — v3.1, no consumer yet.
- **maxRecoverSessions as a knob** — derived, not exposed.
- **Tier-3 live-session idle reaping** — outer GUI/plugin layer, never substrate.
- **env-var overrides** — config.json only (plan's "config + env" was inaccurate; no env
  path exists in config.ts).
- **idleShutdownMinutes validation change** — its garbage→whole-reset stays as-is; only NEW
  lifecycle fields get per-field backfill.

## What already exists (reused, not rebuilt)

- exit-empty mechanism (`Watchdog.evaluateIdle`, count==0 gate) — complete, config-escapable.
- `deadSessionTtlHours` — already config-exposed; the template for the rest.
- config infra: `createDefaultConfig` + `validateConfig` + `bufferSizeMb` HARD_CAP clamp.
- refuse-not-evict (`MAX_SESSIONS` throws RESOURCE_EXHAUSTED) — done; no-op for this plan.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 13 findings, all valid; 4 P1 the review missed |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 4 decisions locked; 5 codex P1/P2 folded in; 1 critical gap (memory brick) gated to impl |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — (no UI) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** 13 findings, all accepted. 3 reversed prior review decisions (0=off→per-field,
whole-file→per-field reset, maxRecover→derive); rest folded in as build landmines + body
corrections.
**UNRESOLVED:** 0 (D1/D2/D3 + 3 codex tensions all decided).
**VERDICT:** ENG CLEARED (codex corrections folded in) — ready to implement. Daemon =
highest-risk area: implement behind tests, codex-review the diff, GUI dogfood before ship.
