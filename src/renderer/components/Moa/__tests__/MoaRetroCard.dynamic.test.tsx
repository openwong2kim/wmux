// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MoaRetroCard, retroHeadline } from '../MoaRetroCard';
import type { RetroCard } from '../../../../shared/trackRecord';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CARD: RetroCard = {
  weekStart: 0,
  builtAt: 0,
  interruptions: { decisions: 4, approvals: 3, total: 7, prevTotal: 10 },
  approvalsLane: 5,
  delegations: 6,
  done: 5,
  missedStalls: [{ workspaceId: 'ws-a', agent: 'claude', ref: 'ab12cd34', ms: 9 * 3_600_000, state: 'needs-you' }],
  repeated: [{ workspaceId: 'ws-a', count: 3, lastAt: 1 }],
  slowest: [{ workspaceId: 'ws-a', agent: 'codex', ref: 'ef56', ms: 2 * 3_600_000 }],
  suggestions: ['precedent', 'stalls'],
};

const t = () => '';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function api(card: RetroCard | null) {
  const calls = { dismiss: 0 };
  return {
    calls,
    api: {
      getRetro: async () => ({ card }),
      dismissRetro: async () => { calls.dismiss += 1; return { ok: true }; },
      onChanged: () => () => undefined,
    },
  };
}

async function mount(card: RetroCard | null) {
  const a = api(card);
  await act(async () => {
    root.render(createElement(MoaRetroCard, { workspaceId: 'ws-hq', t, api: a.api }));
  });
  return a;
}

describe('MoaRetroCard', () => {
  it('renders nothing when main has no card', async () => {
    await mount(null);
    expect(host.innerHTML).toBe('');
  });

  it('shows the headline against last week, details on open, and dismisses', async () => {
    const a = await mount(CARD);
    expect(host.textContent).toContain('You were asked 7 times last week (10 the week before).');
    expect(host.querySelector('[data-moa-retro-details]')).toBeNull();
    await act(async () => { (host.querySelector('[data-moa-retro-open]') as HTMLButtonElement).click(); });
    const details = host.querySelector('[data-moa-retro-details]')?.textContent ?? '';
    expect(details).toContain('4 decisions and 3 approvals reached you; 5 approvals were pressed by rule.');
    expect(details).toContain('waited 9h 00m for you (ab12cd34)');
    expect(details).toContain('A similar question came up 3 times');
    expect(details).toContain('codex · 2h 00m to done (ef56)');
    expect(host.querySelector('[data-moa-retro-suggestion="precedent"]')).not.toBeNull();
    await act(async () => { (host.querySelector('[data-moa-retro-dismiss]') as HTMLButtonElement).click(); });
    expect(a.calls.dismiss).toBe(1);
    expect(host.innerHTML).toBe('');
  });

  it('words a quiet week and a single interruption', () => {
    expect(retroHeadline({ ...CARD, interruptions: { ...CARD.interruptions, total: 0 } }, t)).toBe('Nothing had to wait on you last week.');
    expect(retroHeadline({ ...CARD, interruptions: { ...CARD.interruptions, total: 1, prevTotal: 2 } }, t)).toBe('You were asked once last week (2 the week before).');
  });
});
