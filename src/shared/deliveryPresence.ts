/**
 * Deliveries wait for a verified agent in plain input mode: the answer the
 * daemon gives (`daemon.deliveryPresence`) before text typed on someone's
 * behalf is written, and again before its Enter. daemon/deliveryPresence.ts
 * decides each tier.
 */

import type { AgentSlug } from './events';

/** How long a delivery waits for the daemon to attribute a pane's process. */
export const DELIVERY_PRESENCE_PROBE_MS = 1_500;

/** When the delivery asks: before it writes anything, or before its Enter. */
export interface DeliveryCheck {
  phase: 'paste' | 'enter';
  /** At the Enter: the start of the pasted text, to tell whether the pane still shows it. */
  shownProbe?: string;
}

export type DeliveryPresenceReason =
  | 'no-session'
  | 'no-agent'
  | 'agent-ended'
  | 'not-running'
  | 'not-foreground'
  | 'foreground-unknown'
  | 'other-agent'
  | 'shell-at-prompt'
  | 'no-screen-proof'
  | 'attribution-pending'
  | 'composer-mode'
  | 'composer-busy'
  | 'composer-unknown';

export type DeliveryPresence =
  /**
   * A verified agent: a tracked process in the foreground (`process`), or,
   * where none can be attributed, its plain prompt on screen (`screen`).
   * `full`: its plain prompt is on screen now; `pointer`: an agent whose plain
   * prompt wmux does not know, which gets only wmux's own pointer line.
   */
  | { tier: 'process' | 'screen'; slug: AgentSlug; input: 'full' | 'pointer'; bracketedPaste: boolean; pasteShown?: boolean }
  /** `pasteShown` (at the Enter only, either answer): the agent's input box, or
   *  the cursor's row where there is none, still shows this delivery's paste. */
  | { tier: 'none'; reason: DeliveryPresenceReason; pasteShown?: boolean };

const REASONS: ReadonlySet<string> = new Set<DeliveryPresenceReason>([
  'no-session', 'no-agent', 'agent-ended', 'not-running', 'not-foreground', 'foreground-unknown', 'other-agent',
  'shell-at-prompt', 'no-screen-proof', 'attribution-pending', 'composer-mode', 'composer-busy', 'composer-unknown',
]);

/** The daemon's answer, checked; anything else is undefined (and so no write). */
export function parseDeliveryPresence(raw: unknown, isSlug: (v: unknown) => v is AgentSlug): DeliveryPresence | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { tier?: unknown; slug?: unknown; reason?: unknown; input?: unknown; bracketedPaste?: unknown; pasteShown?: unknown };
  if ((r.tier === 'process' || r.tier === 'screen') && isSlug(r.slug) && (r.input === 'full' || r.input === 'pointer')) {
    return { tier: r.tier, slug: r.slug, input: r.input, bracketedPaste: r.bracketedPaste === true, ...(r.pasteShown === true ? { pasteShown: true } : {}) };
  }
  if (r.tier === 'none' && typeof r.reason === 'string' && REASONS.has(r.reason)) {
    return { tier: 'none', reason: r.reason as DeliveryPresenceReason, ...(r.pasteShown === true ? { pasteShown: true } : {}) };
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
    case 'not-foreground': return 'the agent in the target pane is not in the foreground';
    case 'foreground-unknown': return 'wmux could not tell whether the agent in the target pane is in the foreground';
    case 'other-agent': return 'another agent than the one addressed is in the target pane';
    case 'shell-at-prompt': return 'the target pane is at its shell prompt';
    case 'no-screen-proof': return 'no agent process could be confirmed in the target pane, and its screen does not show an agent ready for input';
    case 'attribution-pending': return 'wmux is still checking which program runs in the target pane';
    case 'composer-mode': return "the agent's input box is in a mode that would not take the text as a message (for example a shell mode or a dialog)";
    case 'composer-busy': return "the agent's input box already holds a draft";
    case 'composer-unknown': return "wmux could not confirm that the agent's input box is a plain prompt";
  }
}
