/**
 * The one place a daemon event turns into the PLAINTEXT that leaves this
 * machine for a third party.
 *
 * This is not the phone path. `approvalPushPayload` builds a payload that is
 * sealed to a key only the user's own device holds, so it can afford to quote
 * the agent's question. Here the destination is an operator-configured URL —
 * commonly a shared ntfy topic on a public server — and the body travels in
 * the clear through whoever runs it. So the rule this module encodes is:
 *
 *   a notification that says SOMETHING HAPPENED and WHERE, never WHAT.
 *
 * Concretely, and deliberately absent: the agent's question text, tool names,
 * tool input summaries, choice labels, terminal output, file paths, cwd,
 * commands, tokens, and the full ids that address a pane over RPC. Panes and
 * workspaces are named by a short id PREFIX — enough to tell two panes apart
 * on a phone screen, not enough to be a handle.
 *
 * `NOTIFY_PAYLOAD_FIELDS` is the allowlist, and a test asserts every built
 * payload stays inside it. Adding a field is a decision about what a third
 * party gets to read; make it there, on purpose.
 */
import { approvalHasElevatedRisk } from './approvalRisk';
import type { ApprovalRequest } from '../approvals/types';

/** What raised the notification. */
export type NotifyEventKind = 'approval' | 'attention';

/**
 * The complete outbound shape. Every field here is either derived by this
 * module or an opaque short id — nothing is copied verbatim from agent-authored
 * text.
 */
export interface NotifyPayload {
  /** Schema version, so a receiver can branch without sniffing. */
  v: 1;
  /** Random per notification. NOT the approval id — that one resolves a pane. */
  id: string;
  event: NotifyEventKind;
  /** Short, STATIC human title. Never the agent's own words. */
  title: string;
  /** Agent display name ('Claude Code'). Absent when unknown. */
  agent?: string;
  /** Short prefix of the pane id — an eyeball discriminator, not a handle. */
  pane: string;
  /** Short prefix of the workspace id, when the event carried one. */
  workspace?: string;
  /** Derived risk tier, present only when elevated. Drives ntfy Priority. */
  risk?: 'critical';
  /** ISO 8601. */
  at: string;
}

/**
 * The allowlist. A payload with any other key must never be sent — see the
 * module doc for why that is a security property rather than tidiness.
 */
export const NOTIFY_PAYLOAD_FIELDS = [
  'v',
  'id',
  'event',
  'title',
  'agent',
  'pane',
  'workspace',
  'risk',
  'at',
] as const;

/** Static titles. Chosen so no branch can ever interpolate agent text. */
export const NOTIFY_TITLE_APPROVAL = 'Approval needed';
export const NOTIFY_TITLE_ATTENTION = 'Agent finished a turn';

/**
 * How much of an id travels.
 *
 * A pane id is an RPC target. The phone path ships it whole because the
 * envelope is sealed; here it would be sitting in a third party's log, so only
 * a prefix goes — long enough that two panes on one machine read differently,
 * short enough to be useless as an address.
 */
const SHORT_ID_LEN = 8;

function shortId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9-]/g, '').slice(0, SHORT_ID_LEN);
}

export interface NotifyIdentity {
  /** Injected so a test can pin it; defaults to a fresh uuid. */
  id: string;
  /** Epoch ms. */
  now: number;
}

export function buildApprovalNotifyPayload(
  request: ApprovalRequest,
  identity: NotifyIdentity,
): NotifyPayload {
  return {
    v: 1,
    id: identity.id,
    event: 'approval',
    title: NOTIFY_TITLE_APPROVAL,
    pane: shortId(request.sessionId),
    ...(request.workspaceId ? { workspace: shortId(request.workspaceId) } : {}),
    ...(request.agent ? { agent: request.agent } : {}),
    // RE-DERIVED, not copied from `request.risk`: the record's field is set
    // only on the harder tier, so copying it would score a softer destructive
    // match as ordinary. Here the consequence is only a notification priority,
    // not a lock-screen button — but the two paths disagreeing about what is
    // dangerous is its own bug, so this calls the SAME function the sealed
    // phone payload calls. See `approvalRisk.ts`.
    //
    // Deliberately the ONLY thing derived from the agent's text. The text
    // itself does not travel.
    ...(approvalHasElevatedRisk(request) ? { risk: 'critical' as const } : {}),
    at: new Date(identity.now).toISOString(),
  };
}

export interface AttentionNotifyInput {
  /** Daemon session (pane) id. */
  sessionId: string;
  /** Agent DISPLAY name, as the hook event carries it. */
  agent?: string;
}

export function buildAttentionNotifyPayload(
  input: AttentionNotifyInput,
  identity: NotifyIdentity,
): NotifyPayload {
  return {
    v: 1,
    id: identity.id,
    event: 'attention',
    title: NOTIFY_TITLE_ATTENTION,
    pane: shortId(input.sessionId),
    ...(input.agent ? { agent: input.agent } : {}),
    at: new Date(identity.now).toISOString(),
  };
}

/**
 * The one line a receiver reads when it only gets text (ntfy).
 *
 * Assembled from allowlisted fields only — never from the request — so the
 * text body cannot become a side door around the allowlist.
 */
export function notifyMessageText(payload: NotifyPayload): string {
  const parts = [payload.title];
  if (payload.agent) parts.push(payload.agent);
  parts.push(`pane ${payload.pane}`);
  if (payload.workspace) parts.push(`ws ${payload.workspace}`);
  return parts.join(' · ');
}
