// @vitest-environment jsdom
//
// Moa's panel top: "Waiting on you" answers each workspace's decision in one
// click (to that decision's own workspace), and the delegated-work cards open
// to show what hangs off the work: waiting decisions, the A2A task, the PR.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MoaWaitingOnYou } from '../MoaWaitingOnYou';
import { MoaTaskCards } from '../MoaTaskCards';
import { MoaPanelTop } from '../MoaPanelTop';
import type { MoaMemoryCard as MoaMemoryCardData, MoaPendingDecision } from '../../../../../shared/moa';
import type { MoaMemoryCardApi } from '../../MoaMemoryCard';
import type { WorkLink } from '../../../../../shared/workLink';

let container: HTMLDivElement;
let root: Root;
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key;

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

const decision = (id: string, workspaceId: string, options: string[] = []): MoaPendingDecision => ({
  workspaceId,
  workspaceName: `Name ${workspaceId}`,
  decision: { id, question: `Question ${id}?`, options, context: '', raisedAt: 1 },
});

/** A fake of main's memory-card API: `set` swaps the card, `changed` fires DECK_MOA_CHANGED. */
function memoryApi(initial: MoaMemoryCardData | null) {
  let current = initial;
  const listeners: Array<() => void> = [];
  const api = {
    memoryCard: vi.fn(async () => ({ card: current })),
    memoryResolve: vi.fn(async () => ({ ok: true })),
    onChanged: (cb: () => void) => { listeners.push(cb); return () => undefined; },
  } satisfies MoaMemoryCardApi;
  return { api, set: (c: MoaMemoryCardData | null) => { current = c; }, changed: () => listeners.forEach((cb) => cb()) };
}

const link = (id: string, over: Partial<WorkLink> = {}): WorkLink => ({
  id,
  origin: 'moa',
  owner: { workspaceId: 'ws-a' },
  state: 'running',
  decisionIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('MoaWaitingOnYou', () => {
  it('draws nothing at zero (no dead gauges)', async () => {
    await act(async () => root.render(createElement(MoaWaitingOnYou, { decisions: [], onResolve: vi.fn(), memoryApi: memoryApi(null).api, t })));
    // Mounted (the memory card listens for a new card) but not drawn.
    expect(container.querySelector('[data-moa-waiting]')?.className).toBe('hidden');
  });

  it('answers an option in one click, to the decision\'s own workspace', async () => {
    const onResolve = vi.fn(async () => ({ ok: true }));
    const decisions = [decision('d1', 'ws-a', ['Ship it', 'Hold']), decision('d2', 'ws-b', ['Yes'])];
    await act(async () => root.render(createElement(MoaWaitingOnYou, { decisions, onResolve, t })));
    expect(container.querySelectorAll('[data-moa-decision]')).toHaveLength(2);
    expect(container.textContent).toContain('Name ws-a');
    const ship = [...container.querySelectorAll<HTMLButtonElement>('[data-moa-decision-option]')].find((b) => b.textContent === 'Ship it')!;
    await act(async () => { ship.click(); });
    expect(onResolve).toHaveBeenCalledWith({ workspaceId: 'ws-a', id: 'd1', resolution: 'Ship it' });
    // The answered row leaves at once; focus moves to the row that took its place.
    expect(container.querySelectorAll('[data-moa-decision]')).toHaveLength(1);
    expect(document.activeElement?.textContent).toBe('Yes');
  });

  it('a free-text decision gets a small input and sends what was typed', async () => {
    const onResolve = vi.fn(async () => ({ ok: true }));
    await act(async () => root.render(createElement(MoaWaitingOnYou, { decisions: [decision('d3', 'ws-c')], onResolve, t })));
    const input = container.querySelector('[data-moa-decision-input]') as HTMLInputElement;
    // Named by its question, so a screen reader hears what it answers.
    expect(input.getAttribute('aria-labelledby')).toBe('moa-decision-d3');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Use the staging DB');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (container.querySelector('[data-moa-decision-send]') as HTMLButtonElement).click(); });
    expect(onResolve).toHaveBeenCalledWith({ workspaceId: 'ws-c', id: 'd3', resolution: 'Use the staging DB' });
  });

  it('a refused answer keeps the row and says so', async () => {
    const onResolve = vi.fn(async () => ({ ok: false }));
    await act(async () => root.render(createElement(MoaWaitingOnYou, { decisions: [decision('d4', 'ws-a', ['Go'])], onResolve, t })));
    await act(async () => { (container.querySelector('[data-moa-decision-option]') as HTMLButtonElement).click(); });
    expect(container.querySelector('[data-moa-decision="d4"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('moa.panel.answerFailed');
  });

  it('a decision already answered elsewhere (not_pending) just leaves, with no error', async () => {
    const onResolve = vi.fn(async () => ({ ok: false, code: 'not_pending' }));
    await act(async () => root.render(createElement(MoaWaitingOnYou, { decisions: [decision('d5', 'ws-a', ['Go']), decision('d6', 'ws-b', ['Yes'])], onResolve, t })));
    await act(async () => { (container.querySelector('[data-moa-decision="d5"] [data-moa-decision-option]') as HTMLButtonElement).click(); });
    expect(container.querySelector('[data-moa-decision="d5"]')).toBeNull();
    expect(container.querySelector('[data-moa-decision="d6"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('MoaWaitingOnYou — the "Remember this?" card', () => {
  const card = (id: string, fullText: string): MoaMemoryCardData => ({
    id, kind: 'skill', name: 'triage-ci', question: 'Remember this? Moa proposes a skill', description: 'Triage a red CI run', fullText, replaces: false,
  });
  const long = `---\nname: triage-ci\n---\n${Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')}\nHIDDEN-TAIL\n`;

  it('is the first row of Waiting on you and counts in its total', async () => {
    const { api } = memoryApi(card('m1', 'short text'));
    await act(async () => root.render(createElement(MoaWaitingOnYou, { decisions: [decision('d1', 'ws-a', ['Go'])], onResolve: vi.fn(), memoryApi: api, t })));
    await act(async () => { await Promise.resolve(); });
    const section = container.querySelector('[data-moa-waiting]') as HTMLElement;
    expect(section.className).not.toBe('hidden');
    expect(section.querySelector('h3 span')?.textContent).toBe('2');
    const rows = section.querySelectorAll('ul > li');
    expect(rows[0].querySelector('[data-moa-memory-card="m1"]')).not.toBeNull();
    expect(rows[1].getAttribute('data-moa-decision')).toBe('d1');
  });

  it('alone, it still opens the section; Save stays off until the full text is opened; only Save and Discard', async () => {
    const { api } = memoryApi(card('m2', long));
    await act(async () => root.render(createElement(MoaWaitingOnYou, { decisions: [], onResolve: vi.fn(), memoryApi: api, t })));
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-moa-waiting]')?.className).not.toBe('hidden');
    expect(container.querySelector('h3 span')?.textContent).toBe('1');
    const save = container.querySelector('[data-moa-memory-save]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(container.querySelectorAll('[data-moa-memory-card] input, [data-moa-memory-card] textarea')).toHaveLength(0);
    await act(async () => { (container.querySelector('[data-moa-memory-toggle]') as HTMLButtonElement).click(); });
    expect(container.textContent).toContain('HIDDEN-TAIL');
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    expect(api.memoryResolve).toHaveBeenCalledWith({ id: 'm2', answer: 'save', fullTextShown: true });
  });

  it('re-reads on DECK_MOA_CHANGED: a new card shows up, an answered one leaves', async () => {
    const m = memoryApi(null);
    await act(async () => root.render(createElement(MoaWaitingOnYou, { decisions: [], onResolve: vi.fn(), memoryApi: m.api, t })));
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-moa-memory-card]')).toBeNull();
    m.set(card('m3', 'short text'));
    await act(async () => { m.changed(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-moa-memory-card="m3"]')).not.toBeNull();
    m.set(null);
    await act(async () => { m.changed(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-moa-memory-card]')).toBeNull();
    expect(container.querySelector('[data-moa-waiting]')?.className).toBe('hidden');
  });
});

describe('MoaTaskCards', () => {
  it('expands a card to its waiting decisions, A2A state and PR', async () => {
    const onOpenPr = vi.fn();
    const links = [link('l1', {
      title: 'Fix the flaky test',
      state: 'needs-you',
      reason: 'decision',
      decisionIds: ['d1', 'd-old'],
      a2aState: 'working',
      pr: { host: 'github.com', owner: 'o', repo: 'r', number: 42, url: 'https://github.com/o/r/pull/42' },
      prStatus: { state: 'open', checks: 'failing', reviewDecision: '', mergeable: 'MERGEABLE', observedAt: 1 },
    })];
    await act(async () => root.render(createElement(MoaTaskCards, {
      links,
      pendingDecisions: [decision('d1', 'ws-a')],
      workspaceName: (id: string) => (id === 'ws-a' ? 'Alpha' : undefined),
      onOpenPr,
      t,
    })));
    const toggle = container.querySelector('[data-moa-task-toggle]') as HTMLButtonElement;
    expect(toggle.textContent).toContain('Fix the flaky test');
    expect(toggle.textContent).toContain('Alpha');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-moa-task-details]')).toBeNull();

    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const details = container.querySelector('[data-moa-task-details]') as HTMLElement;
    expect(details.id).toBe(toggle.getAttribute('aria-controls'));
    // Only the decision that still waits is listed.
    expect(details.querySelectorAll('[data-moa-task-decisions] li')).toHaveLength(1);
    expect(details.textContent).toContain('Question d1?');
    expect(details.querySelector('[data-moa-task-a2a]')?.textContent).toBe('moa.panel.a2aLine(moa.panel.a2a.working)');
    expect(details.querySelector('[data-moa-task-pr]')?.textContent).toContain('moa.panel.prState.open · moa.panel.checks.failing');
    await act(async () => { (details.querySelector('[data-moa-task-pr-link]') as HTMLButtonElement).click(); });
    expect(onOpenPr).toHaveBeenCalledWith('https://github.com/o/r/pull/42');
  });
});

describe('MoaPanelTop', () => {
  it('re-reads the decisions when main says one was already answered elsewhere', async () => {
    const resolve = vi.fn(async () => ({ ok: false, code: 'not_pending' }));
    const onResolved = vi.fn();
    const linksApi = { list: vi.fn(async () => []), onChanged: vi.fn(() => () => undefined) };
    await act(async () => root.render(createElement(MoaPanelTop, { decisions: [decision('d7', 'ws-a', ['Go'])], resolve, onResolved, linksApi, t })));
    await act(async () => { (container.querySelector('[data-moa-decision-option]') as HTMLButtonElement).click(); });
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-moa-decision="d7"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('lists delegated work from workLinks and re-reads it when main says it changed', async () => {
    let changed: ((ids: string[]) => void) | null = null;
    const list = vi.fn(async () => [link('l1', { title: 'One' }), link('gone', { title: 'Gone', state: 'abandoned', manualClose: true })]);
    const onChanged = vi.fn((cb: (ids: string[]) => void) => { changed = cb; return () => undefined; });
    vi.useFakeTimers();
    try {
      await act(async () => root.render(createElement(MoaPanelTop, { decisions: [], linksApi: { list, onChanged }, t })));
      expect(list).toHaveBeenCalledWith({});
      expect([...container.querySelectorAll('[data-moa-task]')].map((el) => el.getAttribute('data-moa-task'))).toEqual(['l1']);
      list.mockResolvedValueOnce([link('l1', { title: 'One' }), link('l2', { title: 'Two', updatedAt: 9 })]);
      await act(async () => { changed!(['l2']); await vi.advanceTimersByTimeAsync(200); });
      expect([...container.querySelectorAll('[data-moa-task]')].map((el) => el.getAttribute('data-moa-task'))).toEqual(['l2', 'l1']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Open conversation links (#1779)', () => {
  const taskOf = (ws: string) => (ws === 'ws-task' ? 'wtask-1' : undefined);

  it('a fan-out task card links to its conversation; other work does not', async () => {
    const onOpenConversation = vi.fn();
    await act(async () => root.render(createElement(MoaTaskCards, {
      links: [link('l1', { title: 'Fan-out task', owner: { workspaceId: 'ws-task' } }), link('l2', { title: 'Plain send' })],
      pendingDecisions: [],
      workspaceName: () => undefined,
      conversationTaskId: taskOf,
      onOpenConversation,
      t,
    })));
    const toggles = container.querySelectorAll<HTMLButtonElement>('[data-moa-task-toggle]');
    await act(async () => { toggles[0].click(); toggles[1].click(); });
    const [taskCard, plainCard] = Array.from(container.querySelectorAll('[data-moa-task]'));
    expect(plainCard.querySelector('[data-moa-task-conversation]')).toBeNull();
    const open = taskCard.querySelector<HTMLButtonElement>('[data-moa-task-conversation]')!;
    expect(open.textContent).toBe('moa.panel.openConversation');
    await act(async () => { open.click(); });
    expect(onOpenConversation).toHaveBeenCalledWith('wtask-1');
  });

  it('a decision raised by a fan-out task links to its conversation', async () => {
    const onOpenConversation = vi.fn();
    await act(async () => root.render(createElement(MoaWaitingOnYou, {
      decisions: [decision('d1', 'ws-task', ['Go']), decision('d2', 'ws-b', ['Go'])],
      onResolve: vi.fn(),
      conversationTaskId: taskOf,
      onOpenConversation,
      t,
    })));
    const links = container.querySelectorAll<HTMLButtonElement>('[data-moa-decision-conversation]');
    expect(links).toHaveLength(1);
    expect(links[0].closest('[data-moa-decision]')?.getAttribute('data-moa-decision')).toBe('d1');
    await act(async () => { links[0].click(); });
    expect(onOpenConversation).toHaveBeenCalledWith('wtask-1');
  });
});
