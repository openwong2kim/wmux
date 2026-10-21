// @vitest-environment jsdom
//
// A pending decision shows its option buttons and a free-text answer.
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
  id: 'd1', question: 'Ship it?', options: ['Yes', 'No'], context: '', status: 'pending', raisedAt: 1, ...over,
});

const mount = async (d: WorkspaceDecision) => {
  const api: DeckDecisionApi = { get: vi.fn(async () => ({ decision: d })), resolve: vi.fn(async () => ({ ok: true })) };
  await act(async () => root.render(createElement(DeckDecisionCard, { api, onStream: () => () => undefined, workspaceId: 'ws-t' })));
};

describe('DeckDecisionCard', () => {
  it('a brain decision shows its option buttons and answer field', async () => {
    await mount(decision({ options: ['Yes', 'No'] }));
    expect(container.querySelector('[data-deck-decision]')).not.toBeNull();
    expect(container.querySelectorAll('[data-decision-option]')).toHaveLength(2);
    expect(container.querySelector('[data-decision-answer]')).not.toBeNull();
  });
});
