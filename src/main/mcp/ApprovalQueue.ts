// ApprovalQueue — debounced + deduplicated user-approval orchestrator for
// Phase 2.2 enforcement (plan D7 step 5).
//
// Pre-commit 5 ships the queue in isolation (no RpcRouter wiring, no
// renderer IPC plumbing). Pre-commit 6 will:
//   - Call `requestApproval(...)` from RpcRouter.dispatch when the
//     enforcer rejects with status='unconfirmed', threading the returned
//     `promptId` into the RpcRejection's `pendingApproval` slot.
//   - Wire an IPC callback so renderer's PermissionApprovalDialog can
//     resolve a prompt via `resolvePrompt(promptId, approved)`.
//
// Dedupe model (plan D4): a request is a `(clientName, hash(sorted
// declaredCapabilities))` pair. Two RPCs from the same plugin landing
// while a prompt is open coalesce onto the same prompt — the user only
// sees one modal regardless of how many concurrent RPCs are racing in.
// When the user resolves it, every coalesced caller gets the same answer.
//
// Persistence: on resolve, the queue writes the user's decision through
// PluginTrustStore.setUserDecision with the exact capability snapshot that
// appeared in the prompt. That prevents a plugin from widening its stored
// declaration while a prompt is pending and having the wider set become
// trusted when the user approves the older prompt.

import { createHash } from 'node:crypto';
import type { PluginIdentityRecord } from '../../shared/rpc';
import type { PluginTrustStore } from './PluginTrustStore';

/**
 * Information about a pending prompt that gets shipped to the renderer to
 * drive the dialog. Plain JSON-serialisable so it can ride over IPC.
 */
export interface ApprovalPromptInfo {
  promptId: string;
  clientName: string;
  declaredCapabilities: string[];
  rationale?: string;
}

/** Callback the queue invokes when a fresh prompt should appear on screen. */
export type ApprovalPromptOpener = (info: ApprovalPromptInfo) => void;

/** Callback the queue invokes when a prompt leaves the queue (resolved/cancelled). */
export type ApprovalPromptCloser = (promptId: string) => void;

/** Resolution shape returned to every coalesced caller. */
export interface ApprovalResult {
  approved: boolean;
  promptId: string;
  /** The trust record after persistence. Undefined if the persistence write failed. */
  identity: PluginIdentityRecord | undefined;
}

/**
 * Return shape of `requestApproval`. The promptId is available
 * synchronously so the RpcRouter dispatch path can thread it into the
 * `pendingApproval.promptId` slot of an identity-status rejection without
 * awaiting the user's decision. The `resolution` promise resolves when the
 * user clicks Approve/Deny (or cancellation rejects it).
 */
export interface ApprovalHandle {
  promptId: string;
  resolution: Promise<ApprovalResult>;
}

interface PendingPrompt {
  promptId: string;
  clientName: string;
  declaredCapabilities: string[];
  rationale: string | undefined;
  /** All waiters coalesced onto this prompt — each gets the same outcome. */
  resolvers: ((r: ApprovalResult) => void)[];
  rejecters: ((err: Error) => void)[];
}

export interface ApprovalQueueOptions {
  /**
   * Called to notify the renderer that a fresh prompt should appear. The
   * queue does NOT block on this — duplicates from the same caller are
   * dropped so the renderer dialog only opens once per dedupe key.
   */
  openPrompt: ApprovalPromptOpener;
  /**
   * Notify the renderer a prompt left the queue (resolved/cancelled) so the
   * inbox removes its row. Best-effort; failures must not throw past the queue.
   */
  closePrompt?: ApprovalPromptCloser;
  /**
   * Optional override for the prompt-id factory (test determinism). Default
   * uses crypto.randomUUID().
   */
  mintPromptId?: () => string;
}

function hashCapabilities(caps: readonly string[]): string {
  // Sort first so order doesn't change the key. Capabilities are short
  // strings; SHA-256 is overkill but keeps the substring set deterministic
  // and adversary-proof. Truncate to 16 hex chars (8 bytes) — collision
  // probability against the ~50 entry cap on the trust DB is negligible.
  const sorted = [...caps].sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16);
}

function dedupKey(clientName: string, caps: readonly string[]): string {
  return `${clientName}::${hashCapabilities(caps)}`;
}

function defaultMintPromptId(): string {
  // Lazy import so unit tests in environments without webcrypto still work.
  // Node 20+ has globalThis.crypto.randomUUID by default.
  return (globalThis.crypto?.randomUUID?.() ?? `prompt-${Math.random().toString(36).slice(2, 12)}`);
}

export class ApprovalQueue {
  private readonly inflight = new Map<string, PendingPrompt>();
  private readonly byPromptId = new Map<string, string>(); // promptId → dedupKey
  private readonly openPrompt: ApprovalPromptOpener;
  private readonly closePrompt: ApprovalPromptCloser | undefined;
  private readonly mintPromptId: () => string;
  private readonly trustStore: PluginTrustStore;

  constructor(trustStore: PluginTrustStore, options: ApprovalQueueOptions) {
    this.trustStore = trustStore;
    this.openPrompt = options.openPrompt;
    this.closePrompt = options.closePrompt;
    this.mintPromptId = options.mintPromptId ?? defaultMintPromptId;
  }

  /**
   * Request user approval for a (clientName, declaredCapabilities) pair.
   *
   * Returns an `ApprovalHandle` with:
   *   - `promptId` (synchronously available): the dispatcher threads this
   *     into the `pendingApproval.promptId` slot of the identity-status
   *     rejection so the client can correlate the response with the
   *     eventual approve/deny decision.
   *   - `resolution`: a promise that resolves once the user clicks
   *     Approve/Deny (possibly via another concurrent caller's prompt —
   *     see dedupe above).
   *
   * Multiple inflight calls with the same dedupe key share a prompt; the
   * renderer only sees one modal. Coalesced callers receive identical
   * `promptId`s and the same eventual resolution.
   */
  requestApproval(input: {
    clientName: string;
    declaredCapabilities: readonly string[];
    rationale?: string;
  }): ApprovalHandle {
    const key = dedupKey(input.clientName, input.declaredCapabilities);
    const existing = this.inflight.get(key);
    if (existing) {
      const resolution = new Promise<ApprovalResult>((resolve, reject) => {
        existing.resolvers.push(resolve);
        existing.rejecters.push(reject);
      });
      return { promptId: existing.promptId, resolution };
    }
    const promptId = this.mintPromptId();
    const pending: PendingPrompt = {
      promptId,
      clientName: input.clientName,
      declaredCapabilities: [...input.declaredCapabilities],
      rationale: input.rationale,
      resolvers: [],
      rejecters: [],
    };
    this.inflight.set(key, pending);
    this.byPromptId.set(promptId, key);
    const resolution = new Promise<ApprovalResult>((resolve, reject) => {
      pending.resolvers.push(resolve);
      pending.rejecters.push(reject);
    });
    // Fire the opener. Failures here MUST NOT throw past the queue —
    // a renderer that's mid-shutdown can drop the IPC; subsequent calls
    // for the same key continue to coalesce and will receive whatever
    // resolution arrives. If the renderer never resolves, all callers
    // hang — that's the same failure mode as any IPC RPC.
    try {
      this.openPrompt({
        promptId,
        clientName: input.clientName,
        declaredCapabilities: [...input.declaredCapabilities],
        rationale: input.rationale,
      });
    } catch {
      /* swallow — best-effort renderer notification */
    }
    return { promptId, resolution };
  }

  /**
   * Resolve a prompt with the user's decision. Persists the decision to
   * the trust DB, then fans out the resolution to every coalesced caller.
   * Idempotent — a duplicate resolve (e.g. user clicks twice, or renderer
   * re-sends) is a no-op.
   */
  async resolvePrompt(promptId: string, approved: boolean): Promise<void> {
    const key = this.byPromptId.get(promptId);
    if (!key) return; // already resolved (or never existed)
    const pending = this.inflight.get(key);
    if (!pending) return;
    this.byPromptId.delete(promptId);
    this.inflight.delete(key);
    // Fire the removal-push BEFORE the trust-store await so the renderer
    // inbox row is removed even if the persistence write below fails.
    try { this.closePrompt?.(promptId); } catch { /* best-effort renderer notification */ }

    let identity: PluginIdentityRecord | undefined;
    try {
      identity = await this.trustStore.setUserDecision(
        pending.clientName,
        approved ? 'trusted' : 'denied',
        approved ? pending.declaredCapabilities : undefined,
      );
    } catch {
      // Trust-DB write failed — still resolve the waiters so they don't
      // hang. The next RPC from this plugin will re-trigger the enforcer
      // (which will check the in-disk state — which didn't change).
    }
    const result: ApprovalResult = {
      approved,
      promptId,
      identity,
    };
    // Snapshot the resolvers before fanning out so a re-entrant call into
    // requestApproval from a resolver can't see the cleared state.
    for (const r of pending.resolvers) {
      try {
        r(result);
      } catch {
        /* swallow — one bad waiter must not affect the others */
      }
    }
  }

  /**
   * Cancel a prompt (e.g. plugin disconnected before the user clicked).
   * Every coalesced caller receives a rejection. The trust DB is NOT
   * touched — the user never made a decision.
   */
  cancelPrompt(promptId: string, reason: string): void {
    const key = this.byPromptId.get(promptId);
    if (!key) return;
    const pending = this.inflight.get(key);
    if (!pending) return;
    this.byPromptId.delete(promptId);
    this.inflight.delete(key);
    try { this.closePrompt?.(promptId); } catch { /* best-effort renderer notification */ }
    const err = new Error(`Approval prompt cancelled: ${reason}`);
    for (const r of pending.rejecters) {
      try {
        r(err);
      } catch {
        /* swallow */
      }
    }
  }

  /** Test/observability helper. */
  inflightCount(): number {
    return this.inflight.size;
  }
}
