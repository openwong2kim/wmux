# Scrollback Restore — Two-Storage Sync Fix Design

> **Status:** Pre-implementation design doc. Awaiting plan-eng-review.
> **Scope:** Fix A (terminal.reset() gating in useTerminal) + Fix B (cap-aware reconcile in AppLayout). Two surgical changes that restore the recovery feature without restructuring.
> **Out of scope:** Fix C — unifying the two scrollback storages under a single daemon-authoritative source of truth. That's a Substrate Phase 2+ effort and is documented as a follow-up at the end of this doc.
> **Target release:** v2.9.2 (patch).

---

## 0. TL;DR

The scrollback restore feature has been silently broken since v2.8.x. Today's dogfood + daemon log instrumentation (branch `fix/daemon-shutdown-phase-instrumentation`) proved the dump → file → recovery byte path is byte-perfect, then traced the visible failure to two upstream issues:

1. **`useTerminal.ts:602` calls `terminal.reset()` unconditionally** when daemon connects after a `.txt`-cache restore. If the daemon's SessionPipe flush then returns 0 bytes (mismatch case below), the user sees a fresh empty terminal — the `.txt` cache that *did* have content gets wiped with nothing to replace it.
2. **`AppLayout.tsx:319` reconcile falls back to `pty.create` whenever a `session.json` ptyId isn't in `daemon.listSessions()`**. The 40-session recovery cap (`MAX_RECOVER_SESSIONS`) and force-kill scenarios both push ptyIds out of `listSessions()`, even when the daemon's `state.sessions` *still has them as suspended*. The recovered scrollback for those ptyIds becomes orphaned and reaped after 7 days.

Both fixes are call-site-local. No schema changes, no protocol bumps.

---

## 1. Inputs

| Source | What it tells us |
|---|---|
| `~/.wmux/logs/daemon-2026-05-17.log` (today's dogfood) | dump bytes = recovery read bytes (perfect match across 50 sessions). SessionPipe.flush bytes=0 for every session.json ptyId. The 50 recovered sessions and the 10 attached ptyIds had **0 overlap**. |
| `~/.wmux/sessions.json` + `%APPDATA%/wmux/session.json` snapshot comparison | Currently 10/10 match — proves "force-kill" *isn't* the only cause; the architectural mismatch can also be triggered by the cap alone. |
| `src/renderer/hooks/useTerminal.ts:570-620` | The unconditional `terminal.reset()` lives inside the `scrollback.load()` `.then` callback, fired by `daemon.onConnected`. |
| `src/main/ipc/handlers/pty.handler.ts:421-468` | `pty:reconnect` exists and works, but is gated by `daemon.listSessions()` — which already excludes cap-skipped suspended sessions. |
| `src/daemon/index.ts:282-294` (`selectRecoverableSessions` invocation) | Cap-skipped sessions remain in `state.sessions` verbatim as `suspended`. They are reachable, just not auto-recovered on boot. |
| Memory: `project_scrollback_restore_root_cause`, `project_scrollback_corruption_fix`, `reference_terminal_fit_guards` | Prior scrollback work (v2.9.0) addressed dump-time corruption. This doc addresses restore-time loss. Same conceptual category as the `fit()` wipe issue. |

---

## 2. Current architecture (the part that's broken)

Two parallel scrollback storages, separately keyed, written and read on different schedules:

```
                  ┌─────────────────────────────────────────────────┐
                  │  ~/.wmux/buffers/{sessionId}.buf                │
                  │    keyed by daemon sessionId                    │
                  │    written by: daemon shutdown dump + 30s snap  │
                  │    read by:    recoverSessions() → ringBuffer   │
                  │                → SessionPipe.flush → renderer   │
                  └─────────────────────────────────────────────────┘
                                       ▲
                                       │ flush bytes=N
                                       │
   renderer attach                     │
       ──────────────► ────────────────┤
                                       │ flush bytes=0  (mismatch case)
                                       ▼
                  ┌─────────────────────────────────────────────────┐
                  │  %APPDATA%/wmux/scrollback/{surfaceId}.txt      │
                  │    keyed by renderer surfaceId                  │
                  │    written by: 5s autosave tick + on tick       │
                  │    read by:    useTerminal scrollback.load()    │
                  └─────────────────────────────────────────────────┘
```

The two never see each other's keys. The renderer's `.txt` cache is the *last visible viewport per surface*. The daemon's `.buf` is the *PTY ring buffer at suspend time*. When they go out of sync (different surface vs session topology), the restore mechanism degrades to whichever happens to have data.

## 3. Failure sequence (today's dogfood, validated end-to-end)

1. **t=0**: startup. `useTerminal` mounts for surface S, calls `scrollback.load(surface-S.txt)`.
2. **t≈80ms**: `.txt` content arrives, written into terminal. User sees previous viewport (~0.1s).
3. **t≈100ms**: daemon connects, `daemon.onConnected` fires.
4. **t=100ms**: `terminal.reset()` runs (useTerminal.ts:602). xterm scrollback buffer **wiped**.
5. **t≈120ms**: AppLayout reconcile runs. surface.ptyId (P) is checked against `daemon.listSessions()`. P not in list → `pty.create()` fallback → new sessionId N created with **empty ringBuffer**.
6. **t≈140ms**: SessionPipe attach for N → flush bytes=0 (the line we see in daemon log).
7. **t≈150ms**: fresh PTY init output streams in (`ESC[2J`, OSC 0 window title, OSC 7 cwd, prompt). User sees an empty terminal with a prompt. The OSC 7 raw text seen in today's screenshot (`e]7;file://...`) is the first chunk landing immediately after `terminal.reset()` while xterm's escape state machine has just been zeroed.

## 4. Fix A — `terminal.reset()` gating via FLUSH_DONE_MARKER

**Where:** `src/renderer/hooks/useTerminal.ts:596-604`, `src/main/ipc/handlers/pty.handler.ts` (new event), `src/preload/preload.ts` (new IPC channel).

**Current code:**
```typescript
removeDaemonConnectedForRestore = window.electronAPI.daemon.onConnected(() => {
  if (!didRestoreTxt) return;
  if (terminalRef.current !== terminal) return;
  terminal.reset();
  didRestoreTxt = false;
});
```

**Why the naive "first byte" trigger fails:** SessionPipe delivers data in two phases:
1. *Recovered scrollback bytes* (from `ringBuffer.readAll()`) — 0 or more bytes.
2. `FLUSH_DONE_MARKER` (`\x00WMUX_FLUSH_DONE\x00`, declared at `src/daemon/SessionPipe.ts:8`).
3. *Live PTY output* — always includes shell init sequences (clear screen, OSC 0 window title, OSC 7 cwd, prompt) within milliseconds of attach.

A "reset on first byte" rule fires on phase 3 even when phase 1 was empty — exactly today's bug, just shifted one layer.

**Change:** main process detects the marker in the SessionPipe stream and emits a discrete `pty:flushComplete` event with `{ id, recoveredBytes: N }`. Renderer's reset trigger keys off that event, not raw data length.

**Sketch (main, pty.handler.ts):**
```typescript
// In daemonClient.connectSessionPipe data forwarding
let flushDone = false;
let recoveredBytes = 0;
const onSessionData = (payload: { sessionId: string; data: Buffer }) => {
  if (payload.sessionId !== sessionId) return;
  if (!flushDone) {
    const markerIdx = payload.data.indexOf(FLUSH_DONE_MARKER);
    if (markerIdx === -1) {
      recoveredBytes += payload.data.length;
    } else {
      recoveredBytes += markerIdx;
      flushDone = true;
      win.webContents.send('pty:flushComplete', sessionId, recoveredBytes);
      const tail = payload.data.subarray(markerIdx + FLUSH_DONE_MARKER.length);
      if (tail.length > 0) win.webContents.send(IPC.PTY_DATA, sessionId, decodeSessionData(sessionId, tail));
      return;
    }
  }
  win.webContents.send(IPC.PTY_DATA, sessionId, decodeSessionData(sessionId, payload.data));
};
```

**Sketch (renderer, useTerminal.ts):**
```typescript
const pendingResetRef = useRef(false);

removeDaemonConnectedForRestore = window.electronAPI.daemon.onConnected(() => {
  if (!didRestoreTxt) return;
  if (terminalRef.current !== terminal) return;
  pendingResetRef.current = true;
  didRestoreTxt = false;
});

const removeFlushListener = window.electronAPI.pty.onFlushComplete((id, recoveredBytes) => {
  if (id !== ptyId) return;
  if (!pendingResetRef.current) return;
  pendingResetRef.current = false;
  if (recoveredBytes > 0) {
    terminal.reset();   // daemon has authoritative scrollback — wipe .txt cache
  }
  // else: leave .txt cache alone — daemon has nothing to replace it with
});
```

**Implementation notes:**
- `pendingResetRef` uses `useRef` so the value survives re-renders without being recaptured by stale closures. The original `let` in a useEffect closure would unmount-race.
- The marker split runs on `Buffer`, not the decoded string, so a multibyte UTF-8 boundary can't desync the index.
- `pty:flushComplete` fires exactly once per attach. Subsequent reconnects re-arm `flushDone`.

**Guarantees:**
- Mismatch case (recoveredBytes=0): no reset → `.txt` cache preserved. Worst case: user sees a viewport snapshot up to 5s stale instead of a blank terminal. The cache wasn't authoritative anyway.
- Match case (recoveredBytes>0): reset fires after the flush completes; everything thereafter is daemon-authoritative — same as today's intent.
- PTY init output (clear screen, prompt) arrives *after* the marker → never mistaken for recovered data.

**Failure modes considered:**
- `.txt` cache corrupted but daemon recovery succeeds → reset fires after flush → cache wiped (correct).
- `.txt` cache fresh but daemon never sends a single byte (attach succeeds, PTY immediately exits before any data) → no `pty:flushComplete` event → cache stays as best available approximation.
- `.txt` cache empty + daemon flush bytes=0 → terminal stays blank with a prompt-only PTY init output. Same as today.
- Marker split across two `payload.data` chunks → `Buffer.indexOf` only checks within a single chunk. **Mitigation:** keep a per-session `flushTailBuffer` that concatenates pending unparsed bytes (max FLUSH_DONE_MARKER.length - 1 bytes) and search across the boundary.

**Cost:** ~30 minutes of code, ~45 minutes of tests (mock SessionPipe stream with various marker positions).

## 5. Fix B — cap-aware reconcile

**Where:** `src/renderer/components/Layout/AppLayout.tsx:319-346` + extend existing `daemon.listSessions` + new `daemon.promoteSession` RPC.

**Current behavior:** `pty.list()` calls `daemon.listSessions()`, which only returns *active* sessions (the cap-recovered set). A suspended-but-not-recovered session in `state.sessions` is invisible to renderer reconcile, so reconcile falls through to `pty.create`.

**Change:**
1. **Extend `daemon.listSessions` with `{ includeSuspended?: boolean }` param.** Default `false` preserves existing callers. When `true`, returns the union of active + cap-skipped suspended sessions, each tagged with `state`. Reusing the existing RPC keeps the wire surface smaller than adding `listSuspended` as a parallel call.
2. **Reconcile fallback in AppLayout:**
   ```typescript
   if (activeIds.has(surface.ptyId)) {
     // existing reconnect path
   } else {
     const allSessions = await window.electronAPI.pty.list({ includeSuspended: true });
     const candidate = allSessions.find(s => s.id === surface.ptyId && s.state === 'suspended');
     if (candidate) {
       // Cap-skipped recovery — promote on demand.
       const promoteRes = await window.electronAPI.pty.promote(surface.ptyId);
       if (promoteRes.success) {
         const result = await window.electronAPI.pty.reconnect(surface.ptyId);
         if (result.success) continue; // proceed with this ptyId
       }
     }
     // existing pty.create fallback path
   }
   ```
3. **New RPC `daemon.promoteSession`** spawns the PTY for a suspended session on demand, reusing the recovery code path in `recoverSessions` (extracted into a `promoteOne(sessionId)` helper). Honors `MAX_SESSIONS=200` cap.

**Idempotency:** `promoteSession` is idempotent — if `sessionId` is already active, returns `{ success: true }` silently. Concurrent calls from racing reconcile passes do not throw `Session 'X' already exists`.

**Why extend `listSessions` instead of a parallel `listSuspended` RPC:**
- Minimal diff: one RPC + one param vs two parallel RPCs.
- Matches the existing wmux RPC pattern (filter-by-param).
- Old renderers ignore the param → backward compat free.

**Failure modes considered:**
- Suspended session's `bufferDumpPath` is missing → promote spawns fresh PTY with empty ringBuffer. Same as today's cap-skipped behavior, but at least the ptyId stays stable.
- Promote hits `MAX_SESSIONS=200` → existing RESOURCE_EXHAUSTED error surfaces to reconcile → falls through to `pty.create` (same as today). Graceful.
- Race: two surfaces concurrently promote the same ptyId → idempotency rule above. Both observe `{ success: true }`.
- Race: user creates a new pane while reconcile is mid-promote → both succeed independently because IDs are different. No conflict.

**Cost:** ~2-3 hours. RPC extension + `promoteOne` extraction + reconcile wiring + 3 dynamic-verify scenarios (R2 + partial-mismatch + concurrent-promote).

## 6. Combined behavior matrix

| Scenario | Today | After A | After A+B |
|---|---|---|---|
| Graceful Quit + 1 surface within cap | Works | Works | Works |
| Graceful Quit + 50 surfaces (cap=40) | 10 surfaces blank | 10 keep `.txt` cache | 10 fully restored |
| Force-kill (Ctrl+C, taskkill /F) | All surfaces blank | All keep `.txt` cache | All keep `.txt` cache (daemon state stale) |
| First-ever startup | Works | Works | Works |
| Daemon never connects | Works (renderer fallback) | Works | Works |

A alone is the "blast radius reducer." B is the "feature actually works for power users."

## 7. Tests

Extend `scripts/instrumentation-verify.mjs` (added in `fix/daemon-shutdown-phase-instrumentation` branch) with new dynamic scenarios:

1. **Flow R1 (flush-marker reset gating)**: spawn daemon, create 1 session, write content, gracefully shut down. Restart daemon with `MAX_RECOVER_SESSIONS=0` (env override). Probe: confirm `pty:flushComplete` event fires with `recoveredBytes=0`. Mock renderer must NOT call `terminal.reset()`. Assert `.txt` cache survives.
2. **Flow R2 (cap-aware reconcile, fully covered)**: spawn daemon, create 41 sessions, gracefully shut down. Restart with cap=40. Probe: `listSessions().length == 40`, `listSessions({ includeSuspended: true }).length == 41`. Issue `promoteSession(skippedId)`. Probe: 41 active. Re-attach and assert flush `recoveredBytes > 0`.
3. **Flow R3 (partial mismatch)**: spawn daemon, create 5 sessions, shut down. Restart with cap=3. Reconcile 5 surfaces — 3 reconnect path, 2 promote path. Assert all 5 see `recoveredBytes > 0`.
4. **Flow R4 (concurrent promote idempotency)**: shut down daemon with 1 suspended cap-skipped session. Restart with cap=0. Issue two concurrent `promoteSession(id)` from different workspaces. Both must return `{ success: true }` without the second one throwing `Session already exists`.
5. **Flow R5 (regression — today's exact reproduction)**: shut down with 50 sessions, restart with cap=40. Confirm 10 cap-skipped sessions are all promoted-on-demand by renderer reconcile and end up with `recoveredBytes > 0`. Asserts the precise scenario this PR fixes.

All scenarios use the bundled-daemon-subprocess pattern (`reference_dynamic_test_pattern`).

Unit tests:
- `useTerminal.test.tsx` — mock `daemon.onConnected` → `pty:flushComplete(recoveredBytes=0)` and `(recoveredBytes>0)` to assert reset timing on each path. Include marker-split-across-chunks edge case (chunks `[0..14]` + `[15..end]` where the marker straddles 14/15).
- `AppLayout.reconcile.test.tsx` — mock `pty.list({ includeSuspended })` and `pty.promote` to cover the five branch points (active / suspended-promote-success / suspended-promote-fail-MAX / suspended-promote-fail-other / fallback-create).
- `pty.handler.test.ts` — new tests for `pty:flushComplete` event emission with various marker positions in the data stream.

**Coverage diagram delta after this PR:**

```
[+] src/renderer/hooks/useTerminal.ts
    └── handleFlushComplete()
        ├── [TEST R1]      recoveredBytes=0 → cache preserved
        ├── [TEST R5]      recoveredBytes>0 → reset + replay
        └── [TEST]         marker-split-chunks → no desync

[+] src/main/ipc/handlers/pty.handler.ts
    └── onSessionData() (flush phase)
        ├── [TEST]         marker fully in first chunk → emit + tail forward
        ├── [TEST]         marker straddles two chunks → buffer + match → emit
        └── [TEST]         marker absent (live mode) → forward as PTY_DATA

[+] src/renderer/components/Layout/AppLayout.tsx
    └── reconcile()
        ├── [TEST]         activeIds.has → reconnect (existing)
        ├── [TEST R2]      suspended → promote → reconnect (new)
        ├── [TEST R4]      concurrent promote → idempotent (new)
        └── [TEST]         not found → create fallback (existing)
```

## 8. Backward compatibility

- **State files**: no schema changes. `state.sessions` already carries `suspended` state.
- **Wire protocol**: two new RPCs (`listSuspended`, `promoteSession`) are additive. Old renderers ignore them and fall through to `pty.create` — same as today.
- **`.txt` cache**: no format change. Continues to be 5s-autosave.
- **No version bump needed for v2.9.x consumers.** This is a true patch fix.

## 9. Out of scope — Fix C (future)

The two-storage architecture is a known design debt. The "right" long-term fix is to make the daemon authoritative for both per-pane/per-surface metadata *and* scrollback, with the renderer as a dumb consumer. This eliminates the sync window entirely.

Why we're not doing it now:
- It's ~2-3 weeks of work and touches Substrate Phase 2 (workspace/pane state migration). Premature.
- A+B brings the user-visible failure rate to near-zero — the diminishing return on Fix C is small until the substrate migration is closer.
- Fix C should be planned alongside the M0-followups already on the substrate roadmap.

Captured as a backlog item in `project_substrate_10_plan` memory.

## 10. Dynamic-verify gate

Before merging this branch:
- [ ] Flow R1 (flush-marker reset gating, recoveredBytes=0) passes 5/5 runs.
- [ ] Flow R2 (cap-aware reconcile via promote) passes 5/5 runs.
- [ ] Flow R3 (partial mismatch — mixed reconnect + promote) passes 5/5 runs.
- [ ] Flow R4 (concurrent promote idempotency) passes 5/5 runs.
- [ ] Flow R5 (regression — 50 sessions / cap 40 exact repro) passes 5/5 runs.
- [ ] Manual dogfood: 50-session graceful quit + restart, scroll-up confirms restored scrollback in surfaces both within and beyond the cap.
- [ ] No regression in `scripts/instrumentation-verify.mjs` shutdown phase flow.

User-side dogfood verification required before push (per `feedback_no_ship_without_user_verification`).

---

---

## Update 2026-05-17 — Upstream Root Cause Discovered

Dogfood of the Fix A implementation revealed a layer this design did not
account for: `src/renderer/stores/slices/workspaceSlice.ts:loadSession`
**force-clears every surface.ptyId to `""` on every startup**. The
existing rationale (lines 145-180) cites a past incident where stale
ptyIds caused PTY_WRITE drops via a Pane → Terminal propagation race.
The workaround was to wipe the ptyId on load and let Terminal.tsx's
self-`pty.create` path handle session creation fresh every time.

This wipe makes both Fix A and Fix B ineffective:

```
session.json: { ptyId: "d5733af7", ... }     ← graceful Quit saved this
       ↓ startup
loadSession: ptyId = ""                       ← WIPED before reconcile sees it
       ↓
AppLayout.reconcile: `if (!surface.ptyId) continue;`  ← skipped
       ↓
Terminal.tsx mount: externalPtyId falsy → calls pty.create()
       ↓
new ptyId, new ringBuffer (empty), flush bytes=0  ← what the daemon log showed
```

The Fix A code in this branch is architecturally correct but inert
against `ptyId === ""`. The daemon side perfectly recovers the original
ptyId (16648-byte ringBuffer for `d5733af7` confirmed in the
2026-05-17 dogfood log) — the renderer is the one that never asks for it.

**Required precursor:** Fix 0 — remove the wipe and properly fix the
Pane → Terminal propagation race that the wipe was working around. The
real fix is probably: make AppLayout.reconcile responsible for *every*
PTY assignment, including the no-existing-ptyId case, and remove
Terminal.tsx's self-`pty.create` path. That way ptyId only changes via
`updateSurfacePtyId`, which is propagation-race-free by design.

After Fix 0:
- Fix A becomes active (current branch's code).
- Fix B becomes meaningful (cap-skipped ptyIds can be promoted on demand).

This doc needs a second-pass plan-eng-review once Fix 0 is sketched.
Treat the Section 4 (Fix A) and Section 5 (Fix B) content as the *correct*
target for the post-Fix-0 architecture, but understand that today's
build will not produce user-visible improvement until Fix 0 lands.

**Diagnostic instrumentation is the only reason this layer was found.**
Keep `src/daemon/util/logSink.ts` (on `fix/daemon-shutdown-phase-instrumentation`,
commit 17df184) and the recovery/shutdown/flush-complete instrumentation
in this branch. They are the eyes that exposed the wipe.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 1 P1 (Fix A trigger race) + 3 minor — all resolved into design doc |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**UNRESOLVED:** 0 (initial review) → 1 (post-dogfood: upstream loadSession ptyId wipe, see Update section above)
**VERDICT:** ENG CLEARED for Fix A/B architecture, but **NEEDS RE-REVIEW** after Fix 0 (loadSession wipe removal + Terminal.tsx propagation race fix) is added to the plan. Fix A/B implementation in this branch is correct but inert until Fix 0 lands.
