/**
 * Common event Envelope — append-only log record schema (envelope-design §1).
 *
 * ┌── PROTOCOL file: additive-only contract ──────────────────────────────┐
 * │ This file is the contract for log records persisted to disk. After a     │
 * │ crash, boot replays past records by re-parsing with this schema:         │
 * │   - Do not remove, rename, or change field meaning (past record parse    │
 * │     collapse).                                                           │
 * │   - New fields must be optional (`?:`) only (absent on old records).     │
 * │   - domain enum·TrustTier values: add only; never reuse existing values. │
 * │ (§8 origin.keyId, §6.F evidence etc. future extensions are all optional  │
 * │ additive.)                                                               │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Scope boundary: payload is domain-owned opaque value. The log layer never
 * interprets it (§1 field table). Channel/A2A transition payload·completion
 * evidence (evidence) schemas are PR5-owned — not defined here.
 */

/**
 * Event domain (§1). Log is domain-agnostic — out-of-scope values pass through uninterpreted.
 * Q1 reroute targets are 'channel'·'a2a' only; the rest are reserved slots for future consumers.
 * (additive-only: add values only; never reuse or remove existing values.)
 */
export type EventDomain =
  | 'channel'
  | 'a2a'
  | 'task'
  | 'approval'
  | 'recording'
  | 'asp';

/**
 * Trust tier (§7, 1:1 with §6.K 4-tier). principalId/trustTier are for routing·display·
 * audit, not authz — the authz anchor is verifiedWorkspaceId.
 * (additive-only.)
 */
export type TrustTier = 'trusted' | 'semi-trusted' | 'heuristic' | 'untrusted';

/**
 * Record provenance (§1, §8). `(machineId, seq)` is globally unique across boot boundaries.
 * daemonEpoch is order-agnostic provenance stamp (§8 D8).
 */
export interface EventOrigin {
  /** §8: permanently immutable UUID for install lifetime (no replacement — Q4 splits via keyId). */
  machineId: string;
  /** §8 D8: = CHANNELS_EPOCH. Schema-generation provenance only, order-agnostic. */
  daemonEpoch: number;
  /** §8 D7: append index for this machine's log (persisted monotonic·non-reset). Issued by append. */
  seq: number;
  // keyId?: string  // §8: Q4 additive reservation — pairing key fingerprint (not machineId replacement)
}

/** Trust context (§7). Stamped at daemon boundary. */
export interface AuthContext {
  /** §7: display/routing stamp (not authz). Determined server-side by daemon. */
  principalId: string;
  /** §7: server pin (authz anchor, not forgeable). */
  verifiedWorkspaceId: string;
  /** §7, §6.K. */
  trustTier: TrustTier;
}

/**
 * One log record (§1). One line (NDJSON) = one EventEnvelope.
 *
 * Order authority is `lamport` (daemon-global logical clock); `wallClock` is display/audit
 * only and never participates in ordering (§1 D10).
 */
export interface EventEnvelope {
  /**
   * §1 D9: randomUUID() v4. Record identity (≠ idempotencyKey). **Issued in append critical
   * section** — if present on draft, retries reusing the same draft cause two distinct commit
   * records to share the same eventId (combined with at-least-once promotion), breaking global
   * uniqueness (3-model panel). Hence absent on draft.
   */
  eventId: string;
  origin: EventOrigin;
  /** §1 D6: daemon-global logical clock, display-order authority. Issued by append (pre-increment). */
  lamport: number;
  /** §1 D10: Date.now() @ append. Display·audit only, order-agnostic. */
  wallClock: number;
  /** §4: business idempotency key (when present). at-least-once promotion retry-absorption anchor (§2.6). */
  idempotencyKey?: string;
  /** §1: eventIds of direct cause events[]. Q1 non-gating provenance. */
  causalRefs?: string[];
  authContext: AuthContext;
  domain: EventDomain;
  /** Domain-owned opaque. Log layer does not interpret (layer boundary, §1 field table). */
  payload: unknown;
}

/**
 * makeEnvelope output — draft with all issued fields (eventId·lamport·wallClock·origin.seq)
 * excluded.
 *
 * All four fields are issued by AppendOnlyLog.append in its own critical section (§1 "@ append",
 * §3). lamport/seq need the hwm critical section; eventId/wallClock are fresh per record so
 * draft-reuse retries cannot commit the same eventId twice. Services fill only business fields
 * into a draft and pass to append — types enforce that issuance is log-only.
 */
export type EventEnvelopeDraft = Omit<
  EventEnvelope,
  'eventId' | 'lamport' | 'wallClock' | 'origin'
> & {
  origin: Omit<EventOrigin, 'seq'>;
};

/** makeEnvelope input. All issued fields are append-owned, not here. */
export interface MakeEnvelopeInput {
  domain: EventDomain;
  payload: unknown;
  /** machineId·daemonEpoch. seq is append-issued, not here. */
  origin: Omit<EventOrigin, 'seq'>;
  authContext: AuthContext;
  idempotencyKey?: string;
  causalRefs?: string[];
}

/**
 * Envelope draft factory (§1, §5). Assembles business fields and tidies optionals.
 * All issued fields (eventId·lamport·wallClock·origin.seq) are filled by append.
 */
export function makeEnvelope(input: MakeEnvelopeInput): EventEnvelopeDraft {
  const draft: EventEnvelopeDraft = {
    origin: {
      machineId: input.origin.machineId,
      daemonEpoch: input.origin.daemonEpoch,
    },
    authContext: {
      principalId: input.authContext.principalId,
      verifiedWorkspaceId: input.authContext.verifiedWorkspaceId,
      trustTier: input.authContext.trustTier,
    },
    domain: input.domain,
    payload: input.payload,
  };
  // Include optionals only when set, keeping log lines clean (additive convention).
  if (input.idempotencyKey !== undefined) {
    draft.idempotencyKey = input.idempotencyKey;
  }
  if (input.causalRefs !== undefined) {
    draft.causalRefs = input.causalRefs;
  }
  return draft;
}
