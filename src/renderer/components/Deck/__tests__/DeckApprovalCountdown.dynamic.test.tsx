// @vitest-environment jsdom
//
// The deck header's approval auto-reject badge. Covers the contract that
// matters: no deadline ⇒ no badge (never invent a countdown), the SOONEST
// deadline wins, and the badge takes the attention rendition near expiry.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DeckApprovalCountdown,
  approvalsForWorkspace,
  soonestApprovalDeadline,
  APPROVAL_URGENT_MS,
  type ApprovalDeadlineRecord,
} from '../DeckApprovalCountdown';
import { useStore } from '../../../stores';

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

async function mount(
  records: ApprovalDeadlineRecord[],
  now: number,
  workspaceId?: string,
): Promise<void> {
  await act(async () => {
    root.render(
      createElement(DeckApprovalCountdown, { records, workspaceId, now: () => now }),
    );
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

  it('takes the attention rendition inside the urgent window', async () => {
    await mount([{ deadlineAt: 1_000 + APPROVAL_URGENT_MS }], 1_000);
    expect(
      container.querySelector('[data-deck-approval-countdown]')?.getAttribute('data-urgent'),
    ).toBe('true');
  });

  // At zero the auto-reject has fired and the record is on its way out of the
  // queue. A badge parked at "Auto-reject in 0s" outlives the thing it
  // describes — and kept a 1 s timer running behind it.
  it('disappears once the deadline has passed', async () => {
    await mount([{ deadlineAt: 500 }], 10_000);
    expect(container.querySelector('[data-deck-approval-countdown]')).toBeNull();
    await mount([{ deadlineAt: 10_000 }], 10_000);
    expect(container.querySelector('[data-deck-approval-countdown]')).toBeNull();
  });

  it('stops ticking once the deadline passes', () => {
    vi.useFakeTimers();
    try {
      let clock = 1_000;
      act(() => {
        root.render(
          createElement(DeckApprovalCountdown, {
            records: [{ deadlineAt: 3_000 }],
            now: () => clock,
          }),
        );
      });
      expect(container.querySelector('[data-deck-approval-countdown]')).not.toBeNull();
      expect(vi.getTimerCount()).toBe(1);
      clock = 4_000;
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(container.querySelector('[data-deck-approval-countdown]')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // The approval queue is app-wide. Without scoping, workspace A's header
  // counts down a prompt raised by (and answerable in) workspace B.
  it('counts down only the prompts that belong to this deck', async () => {
    const mine = { deadlineAt: 30_000, receiverWorkspaceId: 'ws-a', senderWorkspaceId: 'ws-z' };
    const theirs = { deadlineAt: 5_000, receiverWorkspaceId: 'ws-b', senderWorkspaceId: 'ws-c' };
    await mount([theirs, mine], 1_000, 'ws-a');
    expect(container.querySelector('[data-deck-approval-countdown]')?.textContent).toContain('29');
    await mount([theirs], 1_000, 'ws-a');
    expect(container.querySelector('[data-deck-approval-countdown]')).toBeNull();
  });
});

describe('approvalsForWorkspace', () => {
  const a = { deadlineAt: 1, receiverWorkspaceId: 'ws-a', senderWorkspaceId: 'ws-x' };
  const b = { deadlineAt: 2, receiverWorkspaceId: 'ws-b', senderWorkspaceId: 'ws-a' };
  const c = { deadlineAt: 3, receiverWorkspaceId: 'ws-c', senderWorkspaceId: 'ws-c' };

  it('keeps a prompt this workspace either raised or would run', () => {
    expect(approvalsForWorkspace([a, b, c], 'ws-a')).toEqual([a, b]);
  });

  it('filters nothing when there is no workspace to scope to', () => {
    expect(approvalsForWorkspace([a, b, c], undefined)).toEqual([a, b, c]);
  });
});

// ─── One event, at most two renditions (DESIGN.md attention grammar) ────────
//
// The dialog is one. This badge is the second — but when the Fleet cockpit's
// Approvals tab is open it draws its own countdown per row, and this badge
// would be a third thing counting the same seconds down.
describe('DeckApprovalCountdown vs the Fleet approval inbox', () => {
  async function mountWithInbox(inboxOwnsApprovals: boolean): Promise<void> {
    await act(async () => {
      root.render(
        createElement(DeckApprovalCountdown, {
          records: [{ deadlineAt: 31_000 }],
          now: () => 1_000,
          inboxOwnsApprovals,
        }),
      );
    });
  }

  it('renders the badge while the inbox is not the surface on screen', async () => {
    await mountWithInbox(false);
    expect(container.querySelector('[data-deck-approval-countdown]')).not.toBeNull();
  });

  it('steps aside while the Fleet approvals inbox owns the prompt', async () => {
    await mountWithInbox(true);
    expect(container.querySelector('[data-deck-approval-countdown]')).toBeNull();
  });

  it('reads the cockpit state from the store when the prop is omitted', async () => {
    const render = async () => {
      await act(async () => {
        root.render(
          createElement(DeckApprovalCountdown, {
            records: [{ deadlineAt: 31_000 }],
            now: () => 1_000,
          }),
        );
      });
    };
    useStore.setState({ fleetViewVisible: true, fleetActiveTab: 'approvals' });
    await render();
    expect(container.querySelector('[data-deck-approval-countdown]')).toBeNull();

    // The cockpit is open on another tab — the inbox is not on screen, so the
    // header badge is again the operator's only view of the deadline.
    await act(async () => {
      useStore.setState({ fleetActiveTab: 'fleet' });
    });
    expect(container.querySelector('[data-deck-approval-countdown]')).not.toBeNull();

    useStore.setState({ fleetViewVisible: false, fleetActiveTab: 'fleet' });
  });
});

// Suppression is scoped: an inbox that is open but listing nothing for THIS
// deck has taken nothing over, and stepping aside for it would leave the
// operator with no countdown anywhere.
describe('DeckApprovalCountdown suppression scope', () => {
  const record = {
    approvalId: 'a1',
    taskId: 't1',
    messagePreview: '',
    expiresAt: 31_000,
    senderWorkspaceId: 'ws-a',
    receiverWorkspaceId: 'ws-a',
    cwd: null,
  };

  async function render(workspaceId: string): Promise<void> {
    await act(async () => {
      root.render(
        createElement(DeckApprovalCountdown, {
          records: [{ deadlineAt: 31_000, senderWorkspaceId: workspaceId, receiverWorkspaceId: workspaceId }],
          workspaceId,
          now: () => 1_000,
        }),
      );
    });
  }

  afterEach(() => {
    useStore.setState({
      fleetViewVisible: false,
      fleetActiveTab: 'fleet',
      pendingExecuteApprovals: {},
      pendingExecuteApprovalOrder: [],
    });
  });

  it('steps aside when the open inbox lists a row for this workspace', async () => {
    useStore.setState({
      fleetViewVisible: true,
      fleetActiveTab: 'approvals',
      pendingExecuteApprovals: { a1: record },
      pendingExecuteApprovalOrder: ['a1'],
    });
    await render('ws-a');
    expect(container.querySelector('[data-deck-approval-countdown]')).toBeNull();
  });

  it('keeps the badge when the open inbox is listing somebody else', async () => {
    useStore.setState({
      fleetViewVisible: true,
      fleetActiveTab: 'approvals',
      pendingExecuteApprovals: { a1: record },
      pendingExecuteApprovalOrder: ['a1'],
    });
    await render('ws-b');
    expect(container.querySelector('[data-deck-approval-countdown]')).not.toBeNull();
  });

  it('keeps the badge when the open inbox holds only MCP prompts (no deck owns one)', async () => {
    useStore.setState({
      fleetViewVisible: true,
      fleetActiveTab: 'approvals',
      pendingExecuteApprovals: {},
      pendingExecuteApprovalOrder: [],
    });
    await render('ws-a');
    expect(container.querySelector('[data-deck-approval-countdown]')).not.toBeNull();
  });
});
