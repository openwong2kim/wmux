// ─── Command Deck pipe RPC — commander pane-route resolution (P3b, M1.5) ────
//
// `deck.resolvePaneRoute` gives the commander brain's MCP subprocess the one
// thing external routing denies it: the true owning workspaceId of a pane, so
// its terminal_send/terminal_read can pass the ownership assert
// (assertWorkspaceOwnsPty) instead of being confined to a claimed "MCP"
// workspace. Auth is the per-spawn token main injected into that subprocess's
// env (commanderTrust.ts) — not the caller's pane identity — because the
// brain has none by construction.
//
// M1.5 (per-workspace orchestrator): resolution is CONFINED to the workspace
// the token was minted for. A pane owned by ANY OTHER workspace throws —
// a workspace's orchestrator structurally cannot target another workspace's
// panes (§4.0: the blast radius of a misjudging brain is its own workspace).
// Cross-workspace work is the operator's, via that workspace's own deck tab.
//
// Fail-closed: a missing/stale token, an unowned ptyId, or a pane outside the
// token's workspace throws; the MCP client then falls back to the ordinary
// (external) routing rules.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import { commanderTokenWorkspace } from '../../deck/commanderTrust';
import {
  loadWorkspaceDecision,
  raiseDecision,
  replaceStaleDecision,
  resolveDecision,
  isDecisionStale,
  type WorkspaceDecision,
} from '../../deck/deckDecisionStore';
import { loadWorkspaceMode } from '../../deck/deckAutonomyStore';
import { loadDeckHeartbeat } from '../../deck/deckHeartbeatStore';
import { hasReExamineLease } from '../../deck/reExamineLease';
import {
  completeActiveDeckWork,
  loadActiveDeckWork,
} from '../../deck/deckWorkStore';
import { getWorkspaceMirror } from '../../workspace/WorkspaceMirror';
import { DEFAULT_MAX_SNAPSHOT_AGE_MS, isOutstandingWorkerPane } from '../../deck/stopGate';

/** Minimum characters a self-resolve resolution must carry. The re-examine
 *  prompt demands the brain CITE the binding rule/basis that settles the
 *  decision; the server can't parse that intent, so it demands substance — a
 *  bare "yes"/"done" is refused. Not NLP, just a floor against empty self-grants. */
const MIN_SELF_RESOLVE_CHARS = 20;
const MIN_WORK_SUMMARY_CHARS = 8;
const MIN_WORK_VERIFICATION_CHARS = 12;

/** Pull a task's canonical state from either renderer or daemon query shape. */
function readTaskState(task: unknown): string | null {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
  const status = (task as Record<string, unknown>)['status'];
  if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
  const state = (status as Record<string, unknown>)['state'];
  return typeof state === 'string' ? state : null;
}

type GetWindow = () => BrowserWindow | null;

export function registerDeckRpc(router: RpcRouter, getWindow: GetWindow): void {
  router.register('deck.resolvePaneRoute', async (params) => {
    const token = params['token'];
    const tokenWorkspaceId = commanderTokenWorkspace(token);
    if (!tokenWorkspaceId) {
      throw new Error('deck.resolvePaneRoute: not a live commander session');
    }
    const ptyId = params['ptyId'];
    if (typeof ptyId !== 'string' || ptyId.length === 0) {
      throw new Error('deck.resolvePaneRoute: missing required param "ptyId"');
    }
    // Same ownership oracle assertWorkspaceOwnsPty consults — mirror-first
    // with the renderer's live workspace tree as fallback/deny authority
    // (workspace/ptyOwnership.ts).
    const owner = await resolvePtyOwnerWorkspace(getWindow, ptyId, {
      expected: tokenWorkspaceId,
    });
    if (typeof owner !== 'string' || owner.length === 0) {
      throw new Error(`deck.resolvePaneRoute: no workspace owns PTY "${ptyId}"`);
    }
    if (owner !== tokenWorkspaceId) {
      throw new Error(
        `deck.resolvePaneRoute: PTY "${ptyId}" is outside this orchestrator's workspace`,
      );
    }
    return { workspaceId: owner };
  });

  // `deck.resolveCommanderWorkspace` gives the brain its OWN sender identity —
  // the home workspace its token is bound to — with no pane needed. The brain's
  // MCP subprocess has no pane ancestry and no WMUX_WORKSPACE_ID env hint, so
  // the A2A identity resolver (resolveWorkspaceId) otherwise misses on every
  // path and every A2A tool (send_message / a2a_task_send / a2a_broadcast …)
  // throws "Workspace identity unknown". Auth is the same per-spawn token as
  // resolvePaneRoute; a missing/stale token throws and the MCP client falls
  // through to the ordinary (external) resolution, so non-commander callers are
  // unchanged. Unlike resolvePaneRoute this needs no ptyId and no renderer
  // round-trip — it is a pure token→workspace lookup in main's trust registry.
  router.register('deck.resolveCommanderWorkspace', async (params) => {
    const tokenWorkspaceId = commanderTokenWorkspace(params['token']);
    if (!tokenWorkspaceId) {
      throw new Error('deck.resolveCommanderWorkspace: not a live commander session');
    }
    return { workspaceId: tokenWorkspaceId };
  });

  // Final-response barrier for a direct human request. This does not trust the
  // model's prose: it checks the live local worker snapshot and re-queries every
  // A2A task projected into the durable work record before removing that record.
  // The verification text is an auditable statement of what the commander
  // actually checked; it is required but is not treated as executable proof.
  router.register('deck.completeWork', async (params) => {
    const token = params['token'];
    const ws = commanderTokenWorkspace(token);
    if (!ws) {
      throw new Error('deck.completeWork: not a live commander session');
    }
    const work = loadActiveDeckWork(ws);
    if (!work) return { ok: false, error: 'no_active_work' };

    const summary = typeof params['summary'] === 'string' ? params['summary'].trim().slice(0, 8_000) : '';
    const verification =
      typeof params['verification'] === 'string'
        ? params['verification'].trim().slice(0, 12_000)
        : '';
    if (summary.length < MIN_WORK_SUMMARY_CHARS) {
      return { ok: false, error: 'summary_too_short' };
    }
    if (verification.length < MIN_WORK_VERIFICATION_CHARS) {
      return { ok: false, error: 'verification_required' };
    }

    // Brain PTYs are excluded from the mirror upstream, so only worker panes can
    // block. A stale/missing renderer snapshot cannot prove work outstanding and
    // therefore does not wedge finalization; A2A has a durable query below.
    //
    // The predicate is the Stop gate's (`isOutstandingWorkerPane`), imported
    // rather than restated: the two used to carry separate copies of the same
    // rule and only this one counted the operator's own shell as a worker.
    const snapshot = getWorkspaceMirror().getFleetSnapshot(ws);
    if (snapshot && Date.now() - snapshot.ts <= DEFAULT_MAX_SNAPSHOT_AGE_MS) {
      const outstanding = snapshot.panes.filter(isOutstandingWorkerPane);
      if (outstanding.length > 0) {
        return {
          ok: false,
          error: 'workers_outstanding',
          panes: outstanding.map((pane) => ({
            ptyId: pane.ptyId,
            agent: pane.agentName,
            status: pane.agentStatus,
          })),
        };
      }
    }

    const trackedIds = Object.keys(work.a2aTasks);
    if (trackedIds.length > 0) {
      const query = await router.dispatch({
        id: `deck-complete-${work.id}`,
        method: 'a2a.task.query',
        params: { workspaceId: ws },
        ...(typeof token === 'string' ? { commanderToken: token } : {}),
      });
      if (!query.ok) return { ok: false, error: 'a2a_query_failed' };
      const result = query.result;
      const tasks =
        result && typeof result === 'object' && !Array.isArray(result) &&
        Array.isArray((result as Record<string, unknown>)['tasks'])
          ? ((result as Record<string, unknown>)['tasks'] as unknown[])
          : null;
      if (!tasks) return { ok: false, error: 'a2a_state_unavailable' };
      const canonical = new Map<string, string | null>();
      for (const task of tasks) {
        if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
        const id = (task as Record<string, unknown>)['id'];
        if (typeof id === 'string') canonical.set(id, readTaskState(task));
      }
      const incomplete = trackedIds
        .map((taskId) => ({ taskId, state: canonical.get(taskId) ?? null }))
        .filter((task) => task.state !== 'completed');
      if (incomplete.length > 0) {
        return { ok: false, error: 'a2a_tasks_outstanding', tasks: incomplete };
      }
    }

    // Compare-and-delete: a human prompt that arrived while the canonical query
    // was in flight may have extended/replaced ownership. Never close a newer
    // request with an older completion verdict.
    const completed = completeActiveDeckWork(ws, work);
    if (!completed) return { ok: false, error: 'active_work_changed' };
    return { ok: true, workId: work.id, summary, verification };
  });

  // `deck.requestDecision` is how the commander brain RAISES a decision gate —
  // it pauses its own working loop and asks the human operator to settle a fork
  // it should not settle itself. Auth is the same per-spawn commander token; a
  // missing/stale token (or a non-commander MCP client, which never has one)
  // is rejected. The pending decision is persisted (deckDecisionStore) and the
  // wake-suppression check (CommanderEventCoalescer / DeckScheduler) blocks
  // auto-advance until a human resolves it. At most one active decision per
  // workspace: a second raise while one is pending is refused, not stacked.
  router.register('deck.requestDecision', async (params) => {
    const ws = commanderTokenWorkspace(params['token']);
    if (!ws) {
      throw new Error('deck.requestDecision: not a live commander session');
    }
    const question = params['question'];
    if (typeof question !== 'string' || question.trim().length === 0) {
      throw new Error('deck.requestDecision: missing required param "question"');
    }
    const options = Array.isArray(params['options'])
      ? (params['options'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    const context = typeof params['context'] === 'string' ? (params['context'] as string) : '';
    const existing = loadWorkspaceDecision(ws);
    let decision: WorkspaceDecision | null;
    if (existing && existing.status === 'pending') {
      // STALE REPLACE (WP3): the re-examine turn explicitly offers "re-raise a
      // sharper question, which replaces this one". That contract only exists
      // when the pending decision is actually STALE (past the TTL) — a fresh
      // pending decision still refuses a second raise, so the brain cannot
      // stack or churn decisions inside a normal turn. The replace itself is a
      // COMPARE-AND-SWAP inside one serialized store mutation (3-way review
      // round 2): if the human's resolve wins the race, the CAS fails and their
      // answer stays intact — we refuse instead of overwriting it.
      const ttlMs = loadDeckHeartbeat().decisionTtlMs;
      if (!isDecisionStale(existing, ttlMs)) {
        return { ok: false, error: 'decision_pending', id: existing.id };
      }
      decision = await replaceStaleDecision(ws, existing.id, ttlMs, {
        question,
        options,
        context,
      });
      if (!decision) {
        // CAS lost — the decision was resolved/cleared/replaced concurrently.
        return { ok: false, error: 'decision_pending', id: existing.id };
      }
      return { ok: true, id: decision.id };
    }
    decision = await raiseDecision(ws, { question, options, context });
    // Fail CLOSED: if nothing was persisted (write failure, or the question
    // sanitized to empty), do NOT tell the brain the decision was raised — it
    // would end its turn believing the loop is blocked while hasPendingDecision
    // stays false and the loop auto-resumes without waiting (3-way review).
    if (!decision) {
      return { ok: false, error: 'raise_failed' };
    }
    return { ok: true, id: decision.id };
  });

  // `deck.resolveDecision` is how the commander brain resolves its OWN stale
  // pending decision (WP3) — the escape hatch for a decision that has blocked the
  // workspace's wake loop past the TTL with no human answer. It is ONLY valid
  // after the heartbeat's re-examine turn tells the brain it may self-resolve,
  // and the server enforces every precondition (a tool-description rule is not
  // enough): ALL of the following must hold or the resolve is refused with a
  // condition-specific error:
  //   (i)   the workspace mode is 'auto' — assist/off may never self-resolve;
  //   (ii)  the pending decision is actually STALE (age > decisionTtlMs) — the
  //         brain cannot resolve a fresh decision it just raised this turn;
  //   (iii) the resolution is substantive (>= MIN_SELF_RESOLVE_CHARS) so it can
  //         carry the cited rule/basis, not a bare self-grant.
  // Auth is the same per-spawn commander token as requestDecision; a non-commander
  // caller has none and fails closed. On success the pending decision flips to
  // resolved (deckDecisionStore); the brain — already awake in the re-examine turn
  // — proceeds, and that turn's end consumes the resolved record (deck.handler).
  router.register('deck.resolveDecision', async (params) => {
    const ws = commanderTokenWorkspace(params['token']);
    if (!ws) {
      throw new Error('deck.resolveDecision: not a live commander session');
    }
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    if (!id) {
      throw new Error('deck.resolveDecision: missing required param "id"');
    }
    const resolution = typeof params['resolution'] === 'string' ? params['resolution'].trim() : '';

    // Load the current decision once — the id must match the ACTIVE pending one.
    const current = loadWorkspaceDecision(ws);
    if (!current || current.status !== 'pending' || current.id !== id) {
      return { ok: false, error: 'not_pending' };
    }
    // (0) TURN LEASE (round-5 review P1) — self-resolve is valid ONLY inside
    // the heartbeat's re-examine turn for exactly this decision. The commander
    // token is valid across every turn of the session, so without this check an
    // ordinary turn (a human chat while a stale decision is pending) could pass
    // the mode/TTL/substance gates and self-resolve outside the re-examine
    // framing. The lease is granted/revoked by the re-examine turn itself.
    if (!hasReExamineLease(ws, id)) {
      return { ok: false, error: 'no_reexamine_lease' };
    }
    // (i) mode gate — `danger` only (the mode formerly called `auto`).
    if (loadWorkspaceMode(ws) !== 'danger') {
      return { ok: false, error: 'mode_not_auto' };
    }
    // (ii) age gate — must be stale per the configured TTL. POLARITY GUARD
    // (3-way review): isDecisionStale treats a lost clock (raisedAt <= 0, the
    // sanitize fallback) as "stale immediately", which is the conservative
    // choice for the heartbeat re-examine (wake early) but the DANGEROUS one
    // here (self-resolve early). For the self-resolve gate a lost clock must
    // fail CLOSED: without a trustworthy age we cannot prove the TTL elapsed,
    // so the decision stays human-only.
    if (!(current.raisedAt > 0)) {
      return { ok: false, error: 'not_stale' };
    }
    const ttlMs = loadDeckHeartbeat().decisionTtlMs;
    if (!isDecisionStale(current, ttlMs)) {
      return { ok: false, error: 'not_stale' };
    }
    // (iii) substance gate — the resolution must cite a basis, not be empty/bare.
    if (resolution.length < MIN_SELF_RESOLVE_CHARS) {
      return { ok: false, error: 'insufficient_basis' };
    }
    // Tag the provenance: a self-resolve is the BRAIN's answer, and only a
    // brain-resolved record may be consumed by the re-examine turn that made it.
    // A human's resolution (default 'human') must always survive to a resume
    // turn (3-way review round 2 — never drop the human's answer).
    const resolved = await resolveDecision(ws, id, resolution, undefined, 'brain');
    // resolveDecision re-checks id+pending under its write lock; a null here means
    // a concurrent resolve/clear won the race — surface it as not_pending.
    if (!resolved || resolved.status !== 'resolved') {
      return { ok: false, error: 'not_pending' };
    }
    return { ok: true, id: resolved.id };
  });
}
