# Plan: issue #288 — daemon `join()` visibility gate (fail-closed private join)

Status: IMPLEMENTED — all static gates green (daemon tsc 0 · root tsc 0 · eslint 0 · vitest 4148 passed / channels 295). Awaiting live-dogfood + commit/PR decision.
Owner: maintainer (REPO_MODE solo)
Date: 2026-06-23
Issue: #288 — "channel: join() has no visibility gate — any same-machine caller can join a private channel"
Related: `plans/channel-membership-v1-design.md` (Security note L24-25, Open Question L91) · trust-root epic F1 (same-user ceiling)

## ENG REVIEW outcome (3 independent reviewers, 2026-06-23) — confirmations + corrections

Three independent reviewers (security / architecture / regression-trace) read the plan + source + tests.
Strong convergence. Net decisions that OVERRIDE the draft below:

- **Design SOUND, unanimous:** single choke point (`ChannelService.join()`) covers MCP/pipe, renderer
  mutate-local, and daemon-direct — no 4th path. D1 (`isVisibleTo` reuse) is correct and can never
  *allow* a join that should be denied. D3 (placement after NOT_FOUND, before DUPLICATE) correct.
  No TOCTOU (gate runs inside the per-channel lock, before any mutation/persist). D4 (archived OOS) agreed.
- **D2 → `CHANNEL_NOT_FOUND` (CHANGED from draft's NOT_AUTHORIZED; user-confirmed).** Returning a distinct
  `NOT_AUTHORIZED` while `get()` returns null for the same (private, non-member) tuple creates an existence
  ORACLE ("get→nothing, join→forbidden" reveals the id is a real private channel). Use `CHANNEL_NOT_FOUND`
  with the SAME message bytes as a missing channel → symmetric with `get`/`getMembers`/`getMessages`,
  maximal fail-closed, no oracle.
- **Threat model under-claim (fix wording):** the escalation grants not just history but **live fan-out**
  (the attacker ws lands in every future post's `recipientSnapshot` + receives the `channel.message`
  event) **and roster presence** (appears to legit members). State this in the PR.
- **MUST-FIX regression — the draft's test audit was wrong.** The draft suspected `D5 join pin wins`
  (L1211) and `U7 join rollback` — both are SAFE (public channels / member re-join). The ACTUAL breakers
  are two tests that encode the vulnerability by self-joining a stranger into a private channel:
  - `U6 › list lets a non-creator member of a private channel see it` (L711-729) — asserts `list('ws-2')`
    after a stranger self-join → fix: seed ws-2 via `create({members:[…]})`, drop the join.
  - `U6 › getMessages … historyFromSeq floor` (L782-825) — asserts `joinRes.ok===true` for a stranger
    private join → see correction below.
- **CORRECTION to reviewers' "second-agent preserves private late-floor" suggestion — it does NOT.**
  `getMessages` finds the viewer by `workspaceId` only (first match, `ChannelService.ts:322`). A 2nd agent
  of an already-member ws is found AFTER the create-seeded agent (floor 0), so the late floor is never
  observed. Conclusion: **after the gate, a private-channel member with `historyFromSeq>0` is unreachable
  via the public API** (create-seed ⇒ floor 0; the only `includeHistory:false` join that passes the gate
  is a 2nd agent of an already-member ws, whose floor is masked by the ws's first member). The
  `getMessages` floor-apply branch (L319-333) stays as defensive code for a future invite model but is
  not reachable for private channels now. L782 is therefore rewritten to "a create-seeded private member
  sees full history" (floor 0); the SET side of historyFromSeq remains covered by the public test at L247.

## Problem

`ChannelService.join()` (`src/daemon/channels/ChannelService.ts:512-554`) checks only
`CHANNEL_NOT_FOUND` and `DUPLICATE_MEMBER`. It never inspects `channel.visibility` or calls
`isVisibleTo`. Every READ path (`list` / `get` / `getMembers` / `getMessages`) IS
membership-/visibility-scoped via `isVisibleTo` (L339-343) — so **join is the privilege
escalation**: a same-machine pipe/MCP caller that knows a private channel's id can `join` it
and thereby unlock its full history + live feed, even though it was never invited.

PoC `scripts/ch-privatejoin-repro.mjs` confirms: a non-member (`repro-B`) joins `repro-A`'s
private channel and gets `{ok:true}`.

## Root cause (confirmed by reading the code)

- Reads gate on `isVisibleTo(channel, verifiedWorkspaceId)`: public ⇒ always visible; private ⇒
  caller's workspace must be in the member list.
- `join()` has no such gate. Because D5 pins the joining member's workspace to the
  server-resolved `verifiedWorkspaceId` (L540), join is always a **self-join** — but with no
  visibility check, self-join into a private channel makes the caller a member, after which
  every read gate passes.

## Blast-radius analysis (what a fix touches)

Single choke point. Every mutating path funnels into `ChannelService.join()`:

| Caller | Path | Verified-ws anchor |
|---|---|---|
| MCP tool `channel_join` | `a2a.channel.join` pipe RPC → `forward()` → daemon | senderPtyId (unforgeable) |
| pipe/CLI client | `a2a.channel.join` → `forward()` → daemon | senderPtyId; mutating fails closed w/o it |
| in-app GUI | `channels:mutate-local` IPC → daemon | renderer-supplied (process-boundary trust) |
| daemon RPC handler | `daemon/index.ts:1594-1603` → `channelService.join(p)` | — |

Confirmed NON-impacts (fix is safe):
- **GUI is already public-only.** `ChannelMembers.tsx:199-200`:
  `canJoin = channel.visibility === 'public' && status !== 'archived' && !!selfWorkspaceId`.
  The "+ member" picker never offers private channels → no GUI regression.
- **MCP tool already documents private join as unexposed** (`channels.ts:197`). This fix makes
  the daemon enforce what the surface already claims.
- **`create` is unaffected.** Creator auto-membership and the optional `members[]` initial
  members are added INSIDE `create()` (L417-447), never through `join()`. So a private channel's
  legitimate members are still established at create time; only post-hoc self-join is gated.

## Threat model / ceiling (no overclaiming)

- This is bounded by the **same-user OS ceiling** (trust-root F1): a same-user process can already
  read workspace tokens. The fix restores the *per-channel privacy expectation within the
  agent-to-agent model* on one machine — it is NOT a remote RCE fix.
- **Not reachable via LanLink remote**: remote peers only append inbox notes; the wire layer
  exposes message fields, not channel RPCs. So this is a same-machine hardening, fail-closed.

## Design decisions (for ENG REVIEW)

### D1 — Gate predicate: reuse `isVisibleTo` (RECOMMENDED) vs. `visibility === 'private'` direct
- **Reuse `isVisibleTo`** so "you may join a channel iff you may see it" is one invariant shared
  with the read paths. Behavior:
  - public ⇒ visible ⇒ join allowed (normal self-join). ✓
  - private + caller's ws already a member ⇒ visible ⇒ falls through to `DUPLICATE_MEMBER`
    (accurate error). ✓
  - private + caller's ws NOT a member ⇒ not visible ⇒ rejected. ✓
- This also matches read **workspace-level** semantics: if ws W already has an agent member in a
  private channel, W's other agents may already READ it (getMessages finds a viewer by
  `workspaceId`), so letting W's second agent join is consistent — not a new hole. The direct
  `visibility==='private'` variant would reject that case, creating a read-yes/join-no asymmetry.
- **Recommendation: reuse `isVisibleTo`.**

### D2 — Error code: `NOT_AUTHORIZED` vs `CHANNEL_NOT_FOUND` (existence non-disclosure)
- `get()` returns `null` (≈ not-found) for private+non-member to avoid leaking existence.
- The issue text explicitly suggests `NOT_AUTHORIZED`. Trade-off:
  - `NOT_AUTHORIZED`: honest about a deliberate action; easy for MCP callers to branch on; the
    caller already had to know the (random-UUID) channelId to call join, so existence disclosure
    is marginal.
  - `CHANNEL_NOT_FOUND`: maximal fail-closed; symmetric with `get()`'s existence-hiding.
- **Recommendation: `NOT_AUTHORIZED`** (matches issue + honest action error). Open for the panel
  to flip to `CHANNEL_NOT_FOUND` if existence non-disclosure is judged to outweigh clarity.
- Note: `ChannelErrorCode` already includes both `NOT_AUTHORIZED` and `CHANNEL_NOT_FOUND` — no
  type change needed either way.

### D3 — Gate placement
Inside `join()`'s critical section, AFTER the `CHANNEL_NOT_FOUND` lookup and BEFORE the
`DUPLICATE_MEMBER` check, so:
- a non-member of a private channel is rejected by the gate, and
- an existing member re-joining a private channel still gets the precise `DUPLICATE_MEMBER`.

### D4 — Archived channels — OUT OF SCOPE
`join`/`leave` do not check `status === 'archived'` today (only `post` does); the membership
design notes this intentionally. Keep that as-is; not part of #288. (Will note in PR description.)

## Implementation

Single edit in `src/daemon/channels/ChannelService.ts`, `join()`:

```ts
const channel = this.state.channels.find((c) => c.id === params.channelId);
if (!channel) {
  return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
}
// #288: fail-closed visibility gate. You may join a channel only if you may
// SEE it (same invariant as the read paths). Public ⇒ always; private ⇒ the
// caller's verified workspace must already be a member. A non-member of a
// private channel cannot self-join to unlock its history (escalation). An
// existing member falls through to the precise DUPLICATE_MEMBER below.
if (!this.isVisibleTo(channel, params.verifiedWorkspaceId)) {
  return {
    ok: false,
    error: { code: 'NOT_AUTHORIZED', message: 'Cannot join a private channel you are not a member of' },
  };
}
const members = this.state.members[channel.id] ?? [];
// ... existing DUPLICATE_MEMBER check unchanged
```

No signature change, no new error code, no caller changes.

## Test plan

`src/daemon/channels/__tests__/ChannelService.test.ts` — extend the existing
`describe('U6: visibility + membership gate')` block (where the read-gate tests live):

1. **`join` on a private channel by a non-member ⇒ NOT_AUTHORIZED, no membership written, no persist side-effect.**
   (The core #288 regression — mirrors the PoC.)
2. **`join` on a PUBLIC channel by a non-member still succeeds** (self-join unaffected — guards against over-tightening).
3. **`join` on a private channel by an EXISTING member ⇒ DUPLICATE_MEMBER** (gate falls through to the precise error, not NOT_AUTHORIZED).
4. **(D1 consistency) same-workspace second agent may join a private channel where its workspace is already a member** ⇒ `{ok:true}` (read-yes/join-yes symmetry; proves we did not over-reject).

Existing tests that must stay green (no behavior change for them):
- `describe('join / leave')` — joins target public channels / channels the creator made → unaffected.
- `describe('D5 caller-identity server-pin')` `join pin wins` — joins a channel the attacker created (so attacker ws is a member / or public) → re-verify the fixture's channel visibility; adjust the fixture to public if it was relying on the missing gate.
- `U7: join rollback` tests — re-join by an existing member (Alice) of her own channel ⇒ visible ⇒ unaffected.

## Gates

- `tsc` 0 (daemon project).
- `npm run test:parallel` (or the channels-scoped vitest) fully green, incl. the 4 new cases.
- Re-run PoC `scripts/ch-privatejoin-repro.mjs` on a CLEAN single instance →
  expect `HOLE_CONFIRMED: false` / "join was rejected".

## Ship

- main is protected → PR off main. No Claude attribution. No per-PR VERSION bump.
- Branch: `fix/channel-join-visibility-gate`. Issue #288 closes on merge. [Unreleased].
- PR body: state the same-user ceiling honestly; note D4 (archived) is intentionally out of scope.

## Risks / non-goals

- **Non-goal:** an invite/grant model (would let non-members be ADDED to private channels). Not
  built — v1 is fail-closed: private channels are joinable only by workspaces already seeded at
  create time. An invite model is a separate, larger authz design.
- **Risk:** a hidden test/dogfood relying on the missing gate (private self-join). Mitigation: the
  test-plan audit above + full suite run; the only known private-join site is the PoC (which we
  WANT to flip).
