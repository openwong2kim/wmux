/**
 * Deliveries wait for a verified agent process: the answer the daemon gives
 * (`daemon.deliveryPresence`) right before a paste or an Enter that main types
 * on someone's behalf. daemon/deliveryPresence.ts decides each tier.
 */

import type { AgentSlug } from './events';

/** How long a delivery waits for the daemon to attribute a pane's process. */
export const DELIVERY_PRESENCE_PROBE_MS = 1_500;

export type DeliveryPresenceReason =
  | 'no-session'
  | 'no-agent'
  | 'agent-ended'
  | 'not-running'
  | 'not-foreground'
  | 'other-agent'
  | 'shell-at-prompt'
  | 'no-screen-proof';

export type DeliveryPresence =
  /** A tracked agent process runs in the terminal's foreground. */
  | { tier: 'process'; slug: AgentSlug }
  /** No process could be attributed; the current screen shows the agent ready. */
  | { tier: 'screen'; slug: AgentSlug }
  | { tier: 'none'; reason: DeliveryPresenceReason };

const REASONS: ReadonlySet<string> = new Set<DeliveryPresenceReason>([
  'no-session', 'no-agent', 'agent-ended', 'not-running', 'not-foreground', 'other-agent', 'shell-at-prompt', 'no-screen-proof',
]);

/** The daemon's answer, checked; anything else is undefined (and so no write). */
export function parseDeliveryPresence(raw: unknown, isSlug: (v: unknown) => v is AgentSlug): DeliveryPresence | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { tier?: unknown; slug?: unknown; reason?: unknown };
  if (r.tier === 'process' && isSlug(r.slug)) return { tier: 'process', slug: r.slug };
  if (r.tier === 'screen' && isSlug(r.slug)) return { tier: 'screen', slug: r.slug };
  if (r.tier === 'none' && typeof r.reason === 'string' && REASONS.has(r.reason)) {
    return { tier: 'none', reason: r.reason as DeliveryPresenceReason };
  }
  return undefined;
}

/** A person-readable reason a delivery was not typed. */
export function presenceRefusalDetail(p: DeliveryPresence | undefined): string {
  if (!p || p.tier !== 'none') return 'wmux could not confirm an agent in the target pane';
  switch (p.reason) {
    case 'no-session': return 'the target pane is gone';
    case 'no-agent': return 'no agent is running in the target pane';
    case 'agent-ended': return 'the agent in the target pane has ended';
    case 'not-running': return 'the agent in the target pane is not running (stopped or replaced)';
    case 'not-foreground': return 'the agent in the target pane is not in the foreground (the shell has the terminal)';
    case 'other-agent': return 'another agent than the one addressed is in the target pane';
    case 'shell-at-prompt': return 'the target pane is at its shell prompt';
    case 'no-screen-proof': return 'no agent process could be confirmed in the target pane, and its screen does not show an agent ready for input';
  }
}
