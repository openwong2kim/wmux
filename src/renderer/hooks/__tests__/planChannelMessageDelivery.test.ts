/**
 * planChannelMessageDelivery — the renderer's per-`channel.message` fan-out
 * decision: whether to append to the human's DISPLAY cache, and which local
 * workspaces to ROUTE the mention into.
 *
 * P5 (unified human identity): display is scoped to HUMAN membership only —
 * a channel appends to the human's dock iff the reserved ws-human seat is a
 * recipient, independent of the active workspace (the old active-workspace
 * display branch leaked private agent-only traffic into the human's view;
 * ship review: Codex privacy_leak + Claude adversarial F4). Mention ROUTING is
 * unchanged: it fans out to every mentioned LOCAL workspace (real workspaces
 * only — ws-human owns no panes and must never be a routing target).
 */

import { describe, it, expect } from 'vitest';
import { planChannelMessageDelivery } from '../useChannelsEventSubscription';

const HUMAN = 'ws-human';
const ACTIVE = 'ws-active';
const BG = 'ws-background';
const LOCAL = [ACTIVE, BG];

describe('planChannelMessageDelivery — display append (human membership only)', () => {
  it('appends when the human seat is a recipient, regardless of active workspace', () => {
    const plan = planChannelMessageDelivery('ws-agent', [HUMAN, ACTIVE], [], LOCAL);
    expect(plan.appendToDisplay).toBe(true);
  });

  it('appends a human-recipient channel even when NO local workspace is a recipient', () => {
    // The whole point of P5: the human sees their channels no matter which
    // workspace is on screen.
    const plan = planChannelMessageDelivery('ws-agent', [HUMAN, 'ws-other'], [], LOCAL);
    expect(plan.appendToDisplay).toBe(true);
  });

  it('does NOT append an agent-only channel the human is not in (no active-ws leak)', () => {
    // Pre-P5 this appended because the active workspace was a recipient; that
    // branch is gone (privacy leak / phantom unread badges).
    const plan = planChannelMessageDelivery('ws-agent', [ACTIVE, BG], [], LOCAL);
    expect(plan.appendToDisplay).toBe(false);
  });

  it('does NOT append a fully third-party post', () => {
    const plan = planChannelMessageDelivery('ws-x', ['ws-y'], [], LOCAL);
    expect(plan.appendToDisplay).toBe(false);
  });
});

describe('planChannelMessageDelivery — mention routing (all local workspaces)', () => {
  it('routes a SAME-WS mention of the active workspace (the regression guard)', () => {
    const plan = planChannelMessageDelivery('ws-remote', [ACTIVE], [ACTIVE], LOCAL);
    expect(plan.routeWorkspaces).toEqual([ACTIVE]);
  });

  it('routes a CROSS-WS mention of a BACKGROUND workspace (the multi-ws fix)', () => {
    const plan = planChannelMessageDelivery('ws-remote', [BG], [BG], LOCAL);
    expect(plan.routeWorkspaces).toEqual([BG]);
  });

  it('routes to BOTH when a single post mentions active + background', () => {
    const plan = planChannelMessageDelivery('ws-remote', [ACTIVE, BG], [ACTIVE, BG], LOCAL);
    expect(new Set(plan.routeWorkspaces)).toEqual(new Set([ACTIVE, BG]));
  });

  it('does NOT route a mention of a NON-LOCAL workspace (its own renderer handles it)', () => {
    const plan = planChannelMessageDelivery('ws-remote', [ACTIVE], ['ws-elsewhere'], LOCAL);
    expect(plan.routeWorkspaces).toEqual([]);
  });

  it('routes nothing for a post with no mentions (plain message)', () => {
    const plan = planChannelMessageDelivery('ws-remote', [ACTIVE, BG], [], LOCAL);
    expect(plan.routeWorkspaces).toEqual([]);
  });
});

describe('planChannelMessageDelivery — W1 operator observation', () => {
  it('appends an OBSERVED private agent channel even without a ws-human recipient', () => {
    // The human is not a recipient (no member row), but observes the channel:
    // the caller passes isObservedChannel=true — resolved from the mirror row's
    // daemon-stamped `observed` flag, NOT mere mirror presence (a non-member
    // public channel sits in the ws-human mirror too and must not append — GLM P2).
    const plan = planChannelMessageDelivery('ws-agent', [ACTIVE, BG], [], LOCAL, true);
    expect(plan.appendToDisplay).toBe(true);
  });

  it('does NOT append a non-observed agent channel (no observed flag → false)', () => {
    // Covers a channel absent from the mirror AND a mirror row without the
    // observed flag (e.g. an unjoined public channel) — the caller derives the
    // flag as `channels[id]?.observed === true`.
    const plan = planChannelMessageDelivery('ws-agent', [ACTIVE, BG], [], LOCAL, false);
    expect(plan.appendToDisplay).toBe(false);
  });

  it('observation does not affect mention routing (still real local workspaces only)', () => {
    const plan = planChannelMessageDelivery('ws-agent', [ACTIVE, BG], [BG], LOCAL, true);
    expect(plan.routeWorkspaces).toEqual([BG]);
  });
});

describe('planChannelMessageDelivery — P5 invariants', () => {
  it('a mention of the virtual human seat is NEVER a routing target (ws-human owns no panes)', () => {
    // Display appends (human is a recipient) but routing must stay empty — the
    // caller feeds real localIds (not the poll union that includes ws-human), so
    // even a ws-human mention resolves to zero panes.
    const plan = planChannelMessageDelivery('ws-agent', [HUMAN], [HUMAN], LOCAL);
    expect(plan.appendToDisplay).toBe(true);
    expect(plan.routeWorkspaces).toEqual([]);
  });

  it('human display is independent of routing: appends for the human, routes to a mentioned agent', () => {
    const plan = planChannelMessageDelivery('ws-remote', [HUMAN, BG], [BG], LOCAL);
    expect(plan.appendToDisplay).toBe(true);
    expect(plan.routeWorkspaces).toEqual([BG]);
  });
});
