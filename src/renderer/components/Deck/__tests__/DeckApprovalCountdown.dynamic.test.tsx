// @vitest-environment jsdom
//
// The deck header's approval auto-reject badge. Covers the contract that
// matters: no deadline ⇒ no badge (never invent a countdown), the SOONEST
// deadline wins, and the badge takes the attention rendition near expiry.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DeckApprovalCountdown,
  soonestApprovalDeadline,
  APPROVAL_URGENT_MS,
  type ApprovalDeadlineRecord,
} from '../DeckApprovalCountdown';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(records: ApprovalDeadlineRecord[], now: number): Promise<void> {
  await act(async () => {
    root.render(createElement(DeckApprovalCountdown, { records, now: () => now }));
  });
}

describe('soonestApprovalDeadline', () => {
  it('is null with no records and with records that carry no deadline', () => {
    expect(soonestApprovalDeadline([])).toBeNull();
    expect(soonestApprovalDeadline([{}, { expiresAt: 0 }])).toBeNull();
  });

  it('prefers deadlineAt and takes the soonest of several', () => {
    expect(
      soonestApprovalDeadline([{ deadlineAt: 900, expiresAt: 100 }, { expiresAt: 500 }]),
    ).toBe(500);
    expect(soonestApprovalDeadline([{ deadlineAt: 300 }, { deadlineAt: 800 }])).toBe(300);
  });
});

describe('DeckApprovalCountdown', () => {
  it('renders nothing while no pending approval carries a deadline', async () => {
    await mount([{ expiresAt: 0 }], 1_000);
    expect(container.querySelector('[data-deck-approval-countdown]')).toBeNull();
  });

  it('renders the seconds left on the soonest deadline', async () => {
    await mount([{ expiresAt: 46_000 }, { deadlineAt: 31_000 }], 1_000);
    const badge = container.querySelector('[data-deck-approval-countdown]');
    expect(badge?.textContent).toContain('30');
    expect(badge?.getAttribute('data-urgent')).toBeNull();
  });

  it('takes the attention rendition inside the urgent window and never goes negative', async () => {
    await mount([{ deadlineAt: 1_000 + APPROVAL_URGENT_MS }], 1_000);
    expect(
      container.querySelector('[data-deck-approval-countdown]')?.getAttribute('data-urgent'),
    ).toBe('true');
    await mount([{ deadlineAt: 500 }], 10_000);
    expect(container.querySelector('[data-deck-approval-countdown]')?.textContent).toContain('0');
  });
});
