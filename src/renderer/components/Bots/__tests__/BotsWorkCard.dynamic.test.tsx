// @vitest-environment jsdom
// The work card (owner decision 2026-10-16): folded, it names who the work
// was handed to and its state, the request and the delegate's newest
// message; Show steps expands it in place into the folded cards as steps
// with Open thread, and remembers that for the session.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomCard, ThreadId } from '../../../../shared/room';
import type { BotProfile } from '../../../../shared/bot';
import BotsWorkCard from '../BotsWorkCard';
import type { WorkThread, WorkView } from '../botsWork';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEV = 'bot-0000000b';
const H1 = 'handoff:h-1' as ThreadId;
const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}(${Object.values(vars).join('|')})` : key);
const dev: Pick<BotProfile, 'id' | 'name' | 'role'> = { id: DEV, name: 'Dev', role: 'lead' };

function card(id: string, p: Partial<RoomCard>): RoomCard {
  return { version: 1, id, seq: 1, workspaceId: 'w1', threadId: H1, kind: 'fact', at: new Date(2026, 9, 16, 15, 12).getTime(), actor: { kind: 'system' }, title: id, ...p };
}

const hop = card('hop', { title: 'dispatch → Dev: Add a flag' });
const refused = card('refused', { kind: 'refusal', title: 'Handoff refused: Add a flag' });
const latest = card('latest', { kind: 'opinion', actor: { kind: 'bot', workspaceId: 'w1', botId: DEV }, title: 'Opened the PR' });

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(threadId: ThreadId, view: Partial<WorkView> = {}, onOpenThread = vi.fn()) {
  const work: WorkThread = { workspaceId: 'w1', threadId, steps: [hop, refused, latest], all: [hop, refused, latest] };
  const full: WorkView = { delegateId: DEV, title: 'Add a flag', latest, state: 'review', lastAt: latest.at, refUrl: null, ...view };
  act(() => {
    root.render(
      <BotsWorkCard
        work={work}
        view={full}
        t={t}
        faceOf={(id) => (id === DEV ? dev : null)}
        nameOf={(id) => (id === DEV ? 'Dev' : '')}
        textOf={(c) => c.title}
        onOpenThread={onOpenThread}
      />,
    );
  });
  return onOpenThread;
}

describe('BotsWorkCard', () => {
  it('folded: who it went to, its state, the request, the newest message and the step count', () => {
    render(H1);
    const el = host.querySelector('[data-bots-work]')!;
    expect(el.getAttribute('data-work-state')).toBe('review');
    expect(el.textContent).toContain('botsPage.work.handedTo(Dev)');
    expect(host.querySelector('[data-bots-work-state]')!.textContent).toBe('botsPage.work.review');
    expect(host.querySelector('[data-bots-work-title]')!.textContent).toBe('Add a flag');
    expect(host.querySelector('[data-bots-work-latest]')!.textContent).toBe('Opened the PR');
    expect(el.textContent).toContain('botsPage.work.steps(3|');
    expect(host.querySelector('[data-bots-work-steps]')).toBeNull();
    expect(host.querySelector('[data-bots-work-toggle]')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('while expanded the foot holds the one toggle, and focus follows it', () => {
    render('handoff:h-4' as ThreadId);
    act(() => host.querySelector<HTMLButtonElement>('[data-bots-work-toggle]')!.click());
    // The count row keeps the count, not a second toggle.
    expect(host.querySelector('[data-bots-work-toggle]')).toBeNull();
    expect(host.querySelectorAll('[aria-expanded]')).toHaveLength(1);
    const hide = host.querySelector<HTMLButtonElement>('[data-bots-work-hide]')!;
    expect(document.activeElement).toBe(hide);
    act(() => hide.click());
    expect(document.activeElement).toBe(host.querySelector('[data-bots-work-toggle]'));
  });

  it('a failed one says so in the danger colour; no title falls back to the kind word', () => {
    render('handoff:h-2' as ThreadId, { state: 'failed', title: null });
    const state = host.querySelector('[data-bots-work-state]')!;
    expect(state.textContent).toBe('botsPage.worker.failed');
    expect(state.className).toContain('--accent-red');
    expect(host.querySelector('[data-bots-work-title]')!.textContent).toBe('room.thread.handoff');
  });

  it('expands in place into its steps with Open thread, and keeps that for the session', () => {
    const onOpen = render('handoff:h-3' as ThreadId);
    act(() => host.querySelector<HTMLButtonElement>('[data-bots-work-toggle]')!.click());
    const toggle = host.querySelector<HTMLButtonElement>('[data-bots-work-hide]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const steps = host.querySelector('[data-bots-work-steps]')!;
    expect(toggle.getAttribute('aria-controls')).toBe(steps.id);
    expect([...steps.querySelectorAll('[data-bots-work-step]')].map((s) => s.getAttribute('data-bots-work-step'))).toEqual(['hop', 'refused', 'latest']);
    // A refusal keeps its red kind word.
    const refusedStep = steps.querySelector('[data-bots-work-step="refused"]')!;
    expect(refusedStep.querySelector('.text-\\[var\\(--accent-red\\)\\]')!.textContent).toBe('room.kind.refusal ');
    act(() => host.querySelector<HTMLButtonElement>('[data-bots-work-open]')!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    // Rendered again (another visit this session): still expanded.
    act(() => root.unmount());
    root = createRoot(host);
    render('handoff:h-3' as ThreadId);
    expect(host.querySelector('[data-bots-work-steps]')).not.toBeNull();
    // Hide steps folds it.
    act(() => host.querySelector<HTMLButtonElement>('[data-bots-work-hide]')!.click());
    expect(host.querySelector('[data-bots-work-steps]')).toBeNull();
    expect(host.querySelector('[data-bots-work-toggle]')!.getAttribute('aria-expanded')).toBe('false');
  });
});
