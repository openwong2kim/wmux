// @vitest-environment jsdom
//
// A hand-off Moa proposed shows in the target workspace's deck card only as a
// pointer to Moa's panel: no option buttons, no free-text answer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeckDecisionCard, type DeckDecisionApi } from '../DeckDecisionCard';
import type { WorkspaceDecision } from '../../../../main/deck/deckDecisionStore';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const decision = (over: Partial<WorkspaceDecision>): WorkspaceDecision => ({
  id: 'd1', question: 'Hand off?', options: ['Hand off', 'Edit', 'Cancel'], context: '', status: 'pending', raisedAt: 1, ...over,
});

const mount = async (d: WorkspaceDecision) => {
  const api: DeckDecisionApi = { get: vi.fn(async () => ({ decision: d })), resolve: vi.fn(async () => ({ ok: true })) };
  await act(async () => root.render(createElement(DeckDecisionCard, { api, onStream: () => () => undefined, workspaceId: 'ws-t' })));
};

describe('DeckDecisionCard — Moa hand-off', () => {
  it('a moa-handoff card shows the pointer line and no buttons or input', async () => {
    await mount(decision({ origin: 'moa-handoff' }));
    expect(container.querySelector('[data-deck-decision]')).not.toBeNull();
    expect(container.querySelector('[data-deck-decision-handoff]')?.textContent).toBe("Moa proposed a hand-off here. Answer it in Moa's panel.");
    expect(container.querySelectorAll('[data-decision-option]')).toHaveLength(0);
    expect(container.querySelector('[data-decision-answer]')).toBeNull();
    expect(container.querySelector('[data-decision-resolve]')).toBeNull();
  });

  it('a brain decision keeps its option buttons and answer field', async () => {
    await mount(decision({ options: ['Yes', 'No'] }));
    expect(container.querySelector('[data-deck-decision-handoff]')).toBeNull();
    expect(container.querySelectorAll('[data-decision-option]')).toHaveLength(2);
    expect(container.querySelector('[data-decision-answer]')).not.toBeNull();
  });
});
