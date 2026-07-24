// @vitest-environment jsdom
//
// Render tests for the D1 "welcome home" briefing card — fake api/onStream
// injected, no store/IPC. Covers the collapse/expand rules (including the
// "never fight the operator" preservation contract and the rising edge over
// CURRENT blocked state: a fresh block, a recovery, a re-block, a pane that
// spawns blocked), the acknowledge-vs-fetch split AND its visibility gate (off
// screen / hidden window / acknowledged on return), the mirror-not-ready retry
// and its backoff, the fleet-signature refetch that carries autonomy mode
// 'off', the empty-state guard, the reqSeq workspace-switch race guard, the
// single top-priority jump that replaced the pane roster, the channels-unread
// overlay, scoped onStream refetch, and the Settings config bus.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeckBriefingCard, mirrorRetryDelayMs, type DeckBriefingApi } from '../DeckBriefingCard';
import { notifyBriefingConfigChanged } from '../deckBriefingConfigBus';
import {
  summarizeBriefingCounts,
  type BriefingPane,
  type WorkspaceBriefing,
} from '../../../../main/deck/deckBriefing';
import type { AgentStatus } from '../../../../shared/types';

let container: HTMLDivElement;
let root: Root;

// ── the ack visibility gate harness ──────────────────────────────────────────
// jsdom has no layout and no IntersectionObserver, so the card's "is it actually
// on screen" input is driven explicitly here. Default: on screen + document
// visible, i.e. the ordinary operator-is-looking-at-it case.
interface FakeIO {
  cb: (entries: { isIntersecting: boolean; target: Element }[]) => void;
  el: Element | null;
}
let ioInstances: FakeIO[] = [];
let ioIntersecting = true;

function installFakeIntersectionObserver(): void {
  ioInstances = [];
  ioIntersecting = true;
  class Fake implements FakeIO {
    cb: FakeIO['cb'];
    el: Element | null = null;
    constructor(cb: FakeIO['cb']) {
      this.cb = cb;
      ioInstances.push(this);
    }
    observe(el: Element): void {
      this.el = el;
      this.cb([{ isIntersecting: ioIntersecting, target: el }]);
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      const i = ioInstances.indexOf(this);
      if (i >= 0) ioInstances.splice(i, 1);
    }
    takeRecords(): [] {
      return [];
    }
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Fake;
}

/** Scroll the card into / out of the viewport. */
async function setOnScreen(v: boolean): Promise<void> {
  ioIntersecting = v;
  await act(async () => {
    for (const io of [...ioInstances]) {
      if (io.el) io.cb([{ isIntersecting: v, target: io.el }]);
    }
  });
}

/** Minimize / restore the window. */
async function setDocumentVisible(v: boolean): Promise<void> {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (v ? 'visible' : 'hidden'),
  });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  installFakeIntersectionObserver();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
});

const REASON: Record<AgentStatus, BriefingPane['reason']> = {
  awaiting_input: 'blocked',
  waiting: 'blocked',
  error: 'error',
  complete: 'finished',
  running: 'running',
  idle: 'idle',
};

const pane = (
  ptyId: string,
  agentStatus: AgentStatus = 'running',
  agentName: string | null = null,
): BriefingPane => ({
  ptyId,
  agentName,
  agentStatus,
  priority: 1,
  reason: REASON[agentStatus],
});

/** `panes` is a TEST-ONLY input: the payload ships only the counts and the top
 *  of the priority ladder, so the fixture derives both from the list the test
 *  describes (keeping the tests readable in fleet terms). */
const briefing = (
  over: Partial<WorkspaceBriefing> & { panes?: BriefingPane[] } = {},
): WorkspaceBriefing => {
  const { panes, ...rest } = over;
  const list = panes ?? [pane('p-default')];
  return {
    workspaceId: 'ws-1',
    workspaceName: 'Proj',
    mode: 'assist',
    counts: summarizeBriefingCounts(list),
    topPane: list[0] ?? null,
    // Live blocked state, exactly as the real builder derives it — the card's
    // rising-edge input is current state, not the persisted delta.
    blockedPtyIds: list.filter((p) => p.reason === 'blocked').map((p) => p.ptyId),
    pendingDecision: null,
    loop: null,
    changed: null,
    coldStart: false,
    builtAt: 1,
    ...rest,
  };
};

type GetResult = { briefing: WorkspaceBriefing | null; autoShow?: boolean; mirrorReady?: boolean };

/** A controllable fake: the current result can be swapped between refreshes, and
 *  every get/seen call is recorded. */
function makeApi(initial: GetResult): {
  api: DeckBriefingApi;
  calls: string[];
  seenCalls: { workspaceId: string; builtAt: number }[];
  set: (r: GetResult) => void;
} {
  let result = initial;
  const calls: string[] = [];
  const seenCalls: { workspaceId: string; builtAt: number }[] = [];
  return {
    calls,
    seenCalls,
    set: (r: GetResult) => {
      result = r;
    },
    api: {
      get: async (workspaceId: string) => {
        calls.push(workspaceId);
        return result;
      },
      seen: async (workspaceId: string, builtAt: number) => {
        seenCalls.push({ workspaceId, builtAt });
        return { ok: true };
      },
    },
  };
}

async function mount(props: Parameters<typeof DeckBriefingCard>[0]): Promise<void> {
  await act(async () => {
    root.render(createElement(DeckBriefingCard, props));
  });
}

/** Fire a deck stream tick for the workspace and let the 200ms debounce land. */
function streamHarness(): {
  onStream: (cb: (env: { workspaceId: string; event: unknown }) => void) => () => void;
  tick: (workspaceId?: string) => Promise<void>;
} {
  let fire: (env: { workspaceId: string; event: unknown }) => void = () => undefined;
  return {
    onStream: (cb) => {
      fire = cb;
      return () => undefined;
    },
    tick: async (workspaceId = 'ws-1') => {
      await act(async () => {
        fire({ workspaceId, event: {} });
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 250));
      });
    },
  };
}

const toggle = (): HTMLButtonElement =>
  container.querySelector('[data-briefing-toggle]') as HTMLButtonElement;
const isExpanded = (): boolean => container.querySelector('[data-briefing-body]') !== null;
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.click();
  });
};

describe('DeckBriefingCard — render guards', () => {
  it('renders nothing without an api (preload absent)', async () => {
    await mount({ workspaceId: 'ws-1' });
    expect(container.querySelector('[data-deck-briefing]')).toBeNull();
  });

  it('renders nothing when the briefing is null (config disabled)', async () => {
    await mount({ api: makeApi({ briefing: null }).api, workspaceId: 'ws-1' });
    expect(container.querySelector('[data-deck-briefing]')).toBeNull();
  });

  it('renders nothing when there is genuinely nothing to say (no dead chrome)', async () => {
    const { api } = makeApi({ briefing: briefing({ panes: [] }), autoShow: true });
    await mount({ api, workspaceId: 'ws-1' });
    expect(container.querySelector('[data-deck-briefing]')).toBeNull();
  });

  it('a cold start with nothing to report does NOT open an empty container', async () => {
    const { api } = makeApi({ briefing: briefing({ panes: [], coldStart: true }), autoShow: true });
    await mount({ api, workspaceId: 'ws-1' });
    expect(container.querySelector('[data-deck-briefing]')).toBeNull();
  });

  it('a pending decision alone is enough content to render', async () => {
    const decision = {
      id: 'dec-1',
      question: 'Ship it?',
      options: [],
      context: '',
      status: 'pending' as const,
      raisedAt: 1,
    };
    const { api } = makeApi({
      briefing: briefing({ panes: [], pendingDecision: decision, coldStart: true }),
      autoShow: true,
    });
    await mount({ api, workspaceId: 'ws-1' });
    expect(container.querySelector('[data-deck-briefing]')).not.toBeNull();
    expect(container.querySelector('[data-briefing-decision]')).not.toBeNull();
  });
});

describe('DeckBriefingCard — headline composition (i18n)', () => {
  it('composes the headline from counts via t(), not from a main-supplied string', async () => {
    const panes = [
      pane('a', 'awaiting_input'),
      pane('b', 'running'),
      pane('c', 'running'),
      pane('d', 'complete'),
    ];
    await mount({
      api: makeApi({ briefing: briefing({ panes }), autoShow: true }).api,
      workspaceId: 'ws-1',
    });
    expect(toggle().textContent).toContain('1 needs you, 2 running, 1 finished.');
  });

  it('cold start prefixes the welcome sentence', async () => {
    await mount({
      api: makeApi({
        briefing: briefing({ panes: [pane('a', 'complete')], coldStart: true }),
        autoShow: true,
      }).api,
      workspaceId: 'ws-1',
    });
    expect(toggle().textContent).toContain('Welcome back. 1 finished.');
  });

  it('all-idle uses the whole-sentence plural key', async () => {
    await mount({
      api: makeApi({
        briefing: briefing({ panes: [pane('a', 'idle'), pane('b', 'idle')] }),
        autoShow: true,
      }).api,
      workspaceId: 'ws-1',
    });
    expect(toggle().textContent).toContain('All 2 agents are idle.');
  });

  it('a locale t() overrides every fragment (no English leaks through)', async () => {
    const ko: Record<string, string> = {
      'deck.briefing.welcomeBack': '다시 오셨네요.',
      'deck.briefing.clause.blocked.other': '{count}개가 당신을 기다립니다',
      'deck.briefing.headline.sentence': '{clauses}.',
      'deck.briefing.headline.join': ', ',
    };
    await mount({
      api: makeApi({
        briefing: briefing({
          panes: [pane('a', 'awaiting_input'), pane('b', 'awaiting_input')],
          coldStart: true,
        }),
        autoShow: true,
      }).api,
      workspaceId: 'ws-1',
      t: (key: string) => ko[key] ?? '',
    });
    expect(toggle().textContent).toContain('다시 오셨네요. 2개가 당신을 기다립니다.');
  });
});

describe('DeckBriefingCard — expansion rules', () => {
  it('collapsed by default when no delta and not cold start', async () => {
    await mount({
      api: makeApi({ briefing: briefing(), autoShow: true }).api,
      workspaceId: 'ws-1',
    });
    expect(container.querySelector('[data-deck-briefing]')).not.toBeNull();
    expect(isExpanded()).toBe(false);
  });

  it('auto-expands on cold start with content', async () => {
    await mount({
      api: makeApi({ briefing: briefing({ coldStart: true }), autoShow: true }).api,
      workspaceId: 'ws-1',
    });
    expect(isExpanded()).toBe(true);
  });

  it('auto-expands on a newly-blocked delta and renders the while-away line', async () => {
    const b = briefing({
      changed: { finished: [], newlyBlocked: ['p1'], errored: [], newDecision: false },
    });
    await mount({ api: makeApi({ briefing: b, autoShow: true }).api, workspaceId: 'ws-1' });
    expect(isExpanded()).toBe(true);
    expect(container.querySelector('[data-briefing-delta]')!.textContent).toBe(
      'While you were away: 1 is now blocked on you',
    );
  });

  it('stays collapsed on a plain finished delta but still shows it once expanded', async () => {
    const b = briefing({
      changed: { finished: ['p1', 'p2'], newlyBlocked: [], errored: [], newDecision: false },
    });
    await mount({ api: makeApi({ briefing: b, autoShow: true }).api, workspaceId: 'ws-1' });
    expect(isExpanded()).toBe(false);
    await click(toggle());
    expect(container.querySelector('[data-briefing-delta]')!.textContent).toContain('2 finished');
  });

  it('never auto-expands when autoShow is false, even on cold start', async () => {
    await mount({
      api: makeApi({ briefing: briefing({ coldStart: true }), autoShow: false }).api,
      workspaceId: 'ws-1',
    });
    expect(isExpanded()).toBe(false);
  });

  // ── the "do not fight the operator" contract ──────────────────────────────
  it('a background refresh does NOT collapse a card the operator expanded', async () => {
    const { api, set } = makeApi({ briefing: briefing(), autoShow: true });
    const stream = streamHarness();
    await mount({ api, onStream: stream.onStream, workspaceId: 'ws-1' });
    await click(toggle()); // manual expand
    expect(isExpanded()).toBe(true);
    set({ briefing: briefing({ builtAt: 2 }), autoShow: true });
    await stream.tick();
    expect(isExpanded()).toBe(true);
  });

  it('a background refresh does NOT re-open a card the operator collapsed', async () => {
    const blocked = [pane('p1', 'awaiting_input')];
    const b = briefing({
      coldStart: true,
      panes: blocked,
      changed: { finished: [], newlyBlocked: ['p1'], errored: [], newDecision: false },
    });
    const { api, set } = makeApi({ briefing: b, autoShow: true });
    const stream = streamHarness();
    await mount({ api, onStream: stream.onStream, workspaceId: 'ws-1' });
    expect(isExpanded()).toBe(true);
    await click(toggle()); // manual collapse
    expect(isExpanded()).toBe(false);
    // The SAME blocked pane keeps being reported on every tick — that is not new.
    set({ briefing: briefing({ panes: blocked, builtAt: 2 }), autoShow: true });
    await stream.tick();
    await stream.tick();
    expect(isExpanded()).toBe(false);
  });

  it('a genuine rising edge (an additional blocked pane) re-expands', async () => {
    const b = briefing({
      panes: [pane('p1', 'awaiting_input')],
      changed: { finished: [], newlyBlocked: ['p1'], errored: [], newDecision: false },
    });
    const { api, set } = makeApi({ briefing: b, autoShow: true });
    const stream = streamHarness();
    await mount({ api, onStream: stream.onStream, workspaceId: 'ws-1' });
    await click(toggle()); // operator collapses it
    expect(isExpanded()).toBe(false);
    set({
      briefing: briefing({
        builtAt: 2,
        panes: [pane('p1', 'awaiting_input'), pane('p2', 'awaiting_input')],
      }),
      autoShow: true,
    });
    await stream.tick();
    expect(isExpanded()).toBe(true);
  });

  it('a pane that RECOVERED and blocked again re-expands (blocked → running → blocked)', async () => {
    // The delta could never see this: the ack baseline is not what the card
    // diffs. Two consecutive live observations are.
    const { api, set } = makeApi({
      briefing: briefing({ coldStart: true, panes: [pane('p1', 'awaiting_input')] }),
      autoShow: true,
    });
    const stream = streamHarness();
    await mount({ api, onStream: stream.onStream, workspaceId: 'ws-1' });
    expect(isExpanded()).toBe(true);
    await click(toggle()); // operator reads it, collapses
    expect(isExpanded()).toBe(false);
    set({ briefing: briefing({ builtAt: 2, panes: [pane('p1', 'running')] }), autoShow: true });
    await stream.tick();
    expect(isExpanded()).toBe(false); // a recovery is never a reason to open
    set({
      briefing: briefing({ builtAt: 3, panes: [pane('p1', 'awaiting_input')] }),
      autoShow: true,
    });
    await stream.tick();
    expect(isExpanded()).toBe(true);
  });

  it('a pane that spawns already blocked is a rising edge', async () => {
    const { api, set } = makeApi({
      briefing: briefing({ panes: [pane('p1', 'running')] }),
      autoShow: true,
    });
    const stream = streamHarness();
    await mount({ api, onStream: stream.onStream, workspaceId: 'ws-1' });
    expect(isExpanded()).toBe(false);
    // A brand-new pane, blocked from its first observation. main's `changed`
    // reports nothing (it has no prior status to transition FROM).
    set({
      briefing: briefing({
        builtAt: 2,
        panes: [pane('p1', 'running'), pane('fresh', 'awaiting_input')],
        changed: { finished: [], newlyBlocked: [], errored: [], newDecision: false },
      }),
      autoShow: true,
    });
    await stream.tick();
    expect(isExpanded()).toBe(true);
  });

  it('a decision that just appeared is a rising edge', async () => {
    const { api, set } = makeApi({ briefing: briefing(), autoShow: true });
    const stream = streamHarness();
    await mount({ api, onStream: stream.onStream, workspaceId: 'ws-1' });
    expect(isExpanded()).toBe(false);
    set({
      briefing: briefing({
        builtAt: 2,
        pendingDecision: {
          id: 'dec-1',
          question: 'Ship it?',
          options: [],
          context: '',
          status: 'pending',
          raisedAt: 1,
        },
      }),
      autoShow: true,
    });
    await stream.tick();
    expect(isExpanded()).toBe(true);
  });
});

describe('DeckBriefingCard — acknowledge is viewing, not fetching', () => {
  const withDelta = (builtAt: number): WorkspaceBriefing =>
    briefing({
      builtAt,
      changed: { finished: ['p1'], newlyBlocked: [], errored: [], newDecision: false },
    });
  /** Same delta, but auto-expanded on mount (the cold-start path) — the case
   *  where nobody clicked, so "did they SEE it" is the only gate left. */
  const openOnMount = (builtAt: number): WorkspaceBriefing =>
    briefing({
      builtAt,
      coldStart: true,
      changed: { finished: ['p1'], newlyBlocked: [], errored: [], newDecision: false },
    });

  it('a collapsed card fetches but never acknowledges', async () => {
    const { api, seenCalls, calls } = makeApi({ briefing: withDelta(1), autoShow: true });
    const stream = streamHarness();
    await mount({ api, onStream: stream.onStream, workspaceId: 'ws-1' });
    await stream.tick();
    expect(calls.length).toBeGreaterThan(1);
    expect(isExpanded()).toBe(false);
    expect(seenCalls).toEqual([]);
  });

  it('acknowledges the exact build once it is rendered expanded', async () => {
    const { api, seenCalls } = makeApi({ briefing: withDelta(7), autoShow: true });
    await mount({ api, workspaceId: 'ws-1' });
    expect(seenCalls).toEqual([]);
    await click(toggle());
    expect(seenCalls).toEqual([{ workspaceId: 'ws-1', builtAt: 7 }]);
  });

  it('acknowledges a NO-NEWS build too — the baseline has to follow a recovery', async () => {
    // Round 1 skipped the ack when there was no delta. That is what left the
    // baseline pinned to an old "blocked" record, so the next genuine block
    // never re-opened the card. Main de-duplicates the write instead, so this
    // still costs no disk IO when the state truly did not move.
    const noDelta = briefing({
      builtAt: 3,
      changed: { finished: [], newlyBlocked: [], errored: [], newDecision: false },
    });
    const { api, seenCalls } = makeApi({ briefing: noDelta, autoShow: true });
    await mount({ api, workspaceId: 'ws-1' });
    await click(toggle());
    expect(seenCalls).toEqual([{ workspaceId: 'ws-1', builtAt: 3 }]);
  });

  it('an auto-expanded card that is scrolled OFF SCREEN does not acknowledge', async () => {
    // The commander thread pins to the bottom once it has history, so an
    // auto-expanded briefing at the top can be entirely out of view.
    ioIntersecting = false;
    const { api, seenCalls } = makeApi({ briefing: openOnMount(11), autoShow: true });
    await mount({ api, workspaceId: 'ws-1' });
    expect(isExpanded()).toBe(true);
    expect(seenCalls).toEqual([]);
    // The operator scrolls up to it — NOW it has been seen.
    await setOnScreen(true);
    expect(seenCalls).toEqual([{ workspaceId: 'ws-1', builtAt: 11 }]);
  });

  it('a hidden window does not acknowledge, and acknowledges on return', async () => {
    // Leaving the deck open and walking away is the single most likely way to
    // be "away" — precisely what this card exists for.
    await setDocumentVisible(false);
    const { api, seenCalls } = makeApi({ briefing: openOnMount(12), autoShow: true });
    await mount({ api, workspaceId: 'ws-1' });
    expect(isExpanded()).toBe(true);
    expect(seenCalls).toEqual([]);
    await setDocumentVisible(true);
    expect(seenCalls).toEqual([{ workspaceId: 'ws-1', builtAt: 12 }]);
  });

  it('a late acknowledge carries the build that is actually on screen', async () => {
    // The builtAt match in main is what stops a stale ack committing a build
    // the operator never saw; the card must therefore acknowledge the CURRENT
    // build, not the one that was pending when it went off screen.
    ioIntersecting = false;
    const { api, set, seenCalls } = makeApi({ briefing: openOnMount(20), autoShow: true });
    const stream = streamHarness();
    await mount({ api, onStream: stream.onStream, workspaceId: 'ws-1' });
    expect(seenCalls).toEqual([]);
    set({ briefing: openOnMount(21), autoShow: true });
    await stream.tick();
    expect(seenCalls).toEqual([]);
    await setOnScreen(true);
    expect(seenCalls).toEqual([{ workspaceId: 'ws-1', builtAt: 21 }]);
  });

  it('a collapsed card on screen still never acknowledges', async () => {
    const { api, seenCalls } = makeApi({ briefing: withDelta(13), autoShow: false });
    await mount({ api, workspaceId: 'ws-1' });
    expect(isExpanded()).toBe(false);
    expect(seenCalls).toEqual([]);
  });

  it('the shown delta stays on screen after it has been acknowledged', async () => {
    const { api, set } = makeApi({ briefing: withDelta(1), autoShow: true });
    const stream = streamHarness();
    await mount({ api, onStream: stream.onStream, workspaceId: 'ws-1' });
    await click(toggle());
    expect(container.querySelector('[data-briefing-delta]')).not.toBeNull();
    // Main has consumed the delta, so the next build reports nothing new — the
    // line the operator is reading must not blink out from under them.
    set({
      briefing: briefing({
        builtAt: 2,
        changed: { finished: [], newlyBlocked: [], errored: [], newDecision: false },
      }),
      autoShow: true,
    });
    await stream.tick();
    expect(container.querySelector('[data-briefing-delta]')!.textContent).toContain('1 finished');
    // Collapsing dismisses it — it has been read.
    await click(toggle());
    await click(toggle());
    expect(container.querySelector('[data-briefing-delta]')).toBeNull();
  });

  it('a preload without seen() degrades to "shown but never consumed", not a throw', async () => {
    const api: DeckBriefingApi = { get: async () => ({ briefing: withDelta(1), autoShow: true }) };
    await mount({ api, workspaceId: 'ws-1' });
    await click(toggle());
    expect(container.querySelector('[data-briefing-delta]')).not.toBeNull();
  });
});

describe('DeckBriefingCard — mirror not ready', () => {
  it('renders nothing and retries until the mirror is populated', async () => {
    const { api, set, calls } = makeApi({ briefing: null, mirrorReady: false });
    await mount({ api, workspaceId: 'ws-1' });
    expect(container.querySelector('[data-deck-briefing]')).toBeNull();
    expect(calls.length).toBe(1);
    set({ briefing: briefing({ coldStart: true }), autoShow: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(calls.length).toBeGreaterThan(1);
    expect(container.querySelector('[data-deck-briefing]')).not.toBeNull();
    expect(isExpanded()).toBe(true); // the cold start was not burned while waiting
  });

  it('the retry ceiling clears a heavy cold recovery, backing off rather than hammering', async () => {
    // Issue #537: a 35-session cold recovery took ~23s, which is why a 15s
    // launcher budget became a 90s ceiling. A flat 750ms × 20 gave up at 15s.
    expect(mirrorRetryDelayMs(0)).toBe(750);
    expect(mirrorRetryDelayMs(1)).toBeGreaterThan(mirrorRetryDelayMs(0));
    // Bounded: it settles to a calm cadence instead of polling forever at 750ms.
    expect(mirrorRetryDelayMs(50)).toBe(5000);
    let budget = 0;
    for (let i = 0; i < 45; i += 1) budget += mirrorRetryDelayMs(i);
    expect(budget).toBeGreaterThan(60_000);
  });
});

describe('DeckBriefingCard — autonomy mode `off` (no brain stream)', () => {
  it('refetches when the fleet signature changes, debounced', async () => {
    const { api, calls } = makeApi({ briefing: briefing(), autoShow: false });
    await mount({ api, workspaceId: 'ws-1', fleetSignature: 'p1:running' });
    expect(calls.length).toBe(1); // mount fetch only — the first signature is a no-op
    await mount({ api, workspaceId: 'ws-1', fleetSignature: 'p1:awaiting_input' });
    expect(calls.length).toBe(1); // still debouncing
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(calls.length).toBe(2);
  });

  it('an unchanged signature does not refetch (no storm)', async () => {
    const { api, calls } = makeApi({ briefing: briefing(), autoShow: false });
    await mount({ api, workspaceId: 'ws-1', fleetSignature: 'p1:running' });
    await mount({ api, workspaceId: 'ws-1', fleetSignature: 'p1:running' });
    await mount({ api, workspaceId: 'ws-1', fleetSignature: 'p1:running' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(calls.length).toBe(1);
  });

  it('a fleet change that blocks a pane re-expands the card with no stream tick', async () => {
    const { api, set } = makeApi({
      briefing: briefing({ panes: [pane('p1', 'running')] }),
      autoShow: true,
    });
    await mount({ api, workspaceId: 'ws-1', fleetSignature: 'p1:running' });
    expect(isExpanded()).toBe(false);
    set({
      briefing: briefing({ builtAt: 2, panes: [pane('p1', 'awaiting_input')] }),
      autoShow: true,
    });
    await mount({ api, workspaceId: 'ws-1', fleetSignature: 'p1:awaiting_input' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(isExpanded()).toBe(true);
  });
});

describe('DeckBriefingCard — no roster, one jump', () => {
  const fleet = [
    pane('p1', 'awaiting_input', 'claude'),
    pane('p2', 'running', 'codex'),
    pane('p3', 'idle', 'shell-a'),
  ];

  it('renders NO pane rows — DeckFleet above owns the roster', async () => {
    await mount({
      api: makeApi({ briefing: briefing({ coldStart: true, panes: fleet }), autoShow: true }).api,
      workspaceId: 'ws-1',
      resolvePtyPane: (ptyId) => ({ workspaceId: 'ws-1', paneId: ptyId }),
    });
    expect(isExpanded()).toBe(true);
    expect(container.querySelectorAll('[data-briefing-pane]').length).toBe(0);
    expect(container.querySelector('[data-briefing-more]')).toBeNull();
  });

  it('surfaces exactly ONE jump — the top of the priority ladder — even at fleet scale', async () => {
    const many = [
      pane('p-block', 'awaiting_input', 'claude'),
      ...Array.from({ length: 29 }, (_, i) => pane(`p${i}`, 'running', `a${i}`)),
    ];
    await mount({
      api: makeApi({ briefing: briefing({ coldStart: true, panes: many }), autoShow: true }).api,
      workspaceId: 'ws-1',
      resolvePtyPane: (ptyId) => ({ workspaceId: 'ws-1', paneId: ptyId }),
    });
    const jumps = container.querySelectorAll('[data-briefing-jump]');
    expect(jumps.length).toBe(1);
    expect(jumps[0].getAttribute('aria-label')).toBe('Jump to claude');
  });

  it('the jump is reachable while COLLAPSED (one click from the claim to its evidence)', async () => {
    const jumped: { workspaceId: string; paneId: string }[] = [];
    await mount({
      api: makeApi({ briefing: briefing({ panes: fleet }), autoShow: true }).api,
      workspaceId: 'ws-1',
      resolvePtyPane: (ptyId) =>
        ptyId === 'p1' ? { workspaceId: 'ws-1', paneId: 'pane-3' } : null,
      onJumpToPane: (workspaceId, paneId) => jumped.push({ workspaceId, paneId }),
    });
    expect(isExpanded()).toBe(false);
    const jump = container.querySelector('[data-briefing-jump]') as HTMLButtonElement;
    expect(jump).not.toBeNull();
    expect(jump.textContent).toContain('claude');
    await click(jump);
    expect(jumped).toEqual([{ workspaceId: 'ws-1', paneId: 'pane-3' }]);
  });

  it('clicking the jump does not toggle the card (it is not nested in the toggle)', async () => {
    await mount({
      api: makeApi({ briefing: briefing({ panes: fleet }), autoShow: true }).api,
      workspaceId: 'ws-1',
      resolvePtyPane: (ptyId) => ({ workspaceId: 'ws-1', paneId: ptyId }),
    });
    expect(isExpanded()).toBe(false);
    await click(container.querySelector('[data-briefing-jump]') as HTMLButtonElement);
    expect(isExpanded()).toBe(false);
  });

  it('an unnamed pane falls back to the shell label in the accessible name', async () => {
    await mount({
      api: makeApi({ briefing: briefing({ panes: [pane('p9', 'error')] }), autoShow: true }).api,
      workspaceId: 'ws-1',
      resolvePtyPane: (ptyId) => ({ workspaceId: 'ws-1', paneId: ptyId }),
    });
    expect(
      container.querySelector('[data-briefing-jump]')!.getAttribute('aria-label'),
    ).toBe('Jump to shell');
  });

  it('no jump is offered when the pane cannot be resolved (never a click to nowhere)', async () => {
    await mount({
      api: makeApi({ briefing: briefing({ panes: fleet }), autoShow: true }).api,
      workspaceId: 'ws-1',
      resolvePtyPane: () => null,
    });
    expect(container.querySelector('[data-briefing-jump]')).toBeNull();
  });

  it('with a decision pending, the decision pointer leads the body and the jump is secondary', async () => {
    const b = briefing({
      coldStart: true,
      panes: fleet,
      pendingDecision: {
        id: 'dec-1',
        question: 'Ship it?',
        options: [],
        context: '',
        status: 'pending',
        raisedAt: 1,
      },
      changed: { finished: ['p9'], newlyBlocked: [], errored: [], newDecision: true },
    });
    await mount({
      api: makeApi({ briefing: b, autoShow: true }).api,
      workspaceId: 'ws-1',
      resolvePtyPane: (ptyId) => ({ workspaceId: 'ws-1', paneId: ptyId }),
    });
    const body = container.querySelector('[data-briefing-body]')!;
    const kinds = [...body.children].map((el) =>
      el.hasAttribute('data-briefing-decision')
        ? 'decision'
        : el.hasAttribute('data-briefing-delta')
          ? 'delta'
          : 'other',
    );
    expect(kinds[0]).toBe('decision');
    expect(kinds).toContain('delta');
    // The pane jump still exists, in the header, secondary to the pointer.
    expect(container.querySelector('[data-briefing-jump]')).not.toBeNull();
  });

  it('shows the channels-unread overlay and jumps to channels', async () => {
    let jumped = 0;
    await mount({
      api: makeApi({ briefing: briefing({ coldStart: true }), autoShow: true }).api,
      workspaceId: 'ws-1',
      channelsUnread: 4,
      onJumpToChannels: () => {
        jumped += 1;
      },
    });
    const chip = container.querySelector('[data-briefing-channels]') as HTMLButtonElement;
    expect(chip.textContent).toContain('4 unread in channels');
    await click(chip);
    expect(jumped).toBe(1);
  });
});

describe('DeckBriefingCard — refresh plumbing', () => {
  it('reqSeq guard: a stale response for the old workspace does not overwrite the new card', async () => {
    // Slow api for ws-1, fast for ws-2 — remount with ws-2 before ws-1 resolves.
    let releaseWs1: (v: GetResult) => void = () => undefined;
    const slow = new Promise<GetResult>((res) => {
      releaseWs1 = res;
    });
    const api: DeckBriefingApi = {
      get: async (workspaceId: string) => {
        if (workspaceId === 'ws-1') return slow;
        return {
          briefing: briefing({ workspaceId: 'ws-2', panes: [pane('w2', 'complete')] }),
          autoShow: false,
        };
      },
    };
    await mount({ api, workspaceId: 'ws-1' });
    await mount({ api, workspaceId: 'ws-2' });
    expect(toggle().textContent).toContain('1 finished.');
    // ws-1's slow response now lands — it must be ignored (superseded).
    await act(async () => {
      releaseWs1({
        briefing: briefing({ workspaceId: 'ws-1', panes: [pane('w1', 'awaiting_input')] }),
        autoShow: false,
      });
      await slow;
    });
    expect(toggle().textContent).toContain('1 finished.');
    expect(toggle().textContent).not.toContain('needs you');
  });

  it('refetches on an onStream tick for the matching workspace only', async () => {
    const { api, calls } = makeApi({ briefing: briefing(), autoShow: false });
    const stream = streamHarness();
    await mount({ api, onStream: stream.onStream, workspaceId: 'ws-1' });
    expect(calls.length).toBe(1); // initial mount fetch
    await stream.tick('ws-other');
    expect(calls.length).toBe(1);
    await stream.tick('ws-1');
    expect(calls.length).toBe(2);
  });

  it('a Settings config change refreshes the card (disabling it unmounts the card)', async () => {
    const { api, set, calls } = makeApi({ briefing: briefing(), autoShow: true });
    await mount({ api, workspaceId: 'ws-1' });
    expect(container.querySelector('[data-deck-briefing]')).not.toBeNull();
    set({ briefing: null }); // main now reports the briefing as disabled
    await act(async () => {
      notifyBriefingConfigChanged();
    });
    expect(calls.length).toBe(2);
    expect(container.querySelector('[data-deck-briefing]')).toBeNull();
  });
});
