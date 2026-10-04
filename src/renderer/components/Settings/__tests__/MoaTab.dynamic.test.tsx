// @vitest-environment jsdom
//
// Settings › Moa against the real store, with the deck bridge mocked: the
// master switch (first-run card on the first turn-on), each HQ state's
// recovery action, the per-workspace mode table, the turn cap, the two Moa
// switches and the archived-decision notice.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TabMoa } from '../MoaTab';
import { useStore } from '../../../stores';
import { createWorkspace } from '../../../../shared/types';
import type { MoaHqState, MoaState } from '../../../../shared/moa';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const work = createWorkspace('Work', 1);
const hq = createWorkspace('Moa', 2);

function moaState(over: { enabled?: boolean; onboarded?: boolean; hq?: MoaHqState; unacked?: number; defaultReason?: MoaState['config']['defaultReason'] } = {}): MoaState {
  return {
    config: {
      enabled: over.enabled ?? true,
      onboarded: over.onboarded ?? true,
      level: 1,
      maxTurnsPerHour: 20,
      bubbles: false,
      reduceMotion: false,
      defaultReason: over.defaultReason ?? null,
    },
    hq: { workspaceId: over.hq === 'unset' ? null : hq.id, state: over.hq ?? 'ok' },
    archive: { unacked: over.unacked ?? 0, total: over.unacked ?? 0 },
  };
}

let current: MoaState;
let api: ReturnType<typeof makeApi>;

function makeApi() {
  const modes: Record<string, string> = {};
  return {
    moa: {
      state: vi.fn(async () => current),
      set: vi.fn(async (enabled: boolean): Promise<{ ok: boolean; enabled?: boolean; code?: string }> => {
        current = { ...current, config: { ...current.config, enabled } };
        return { ok: true, enabled };
      }),
      setConfig: vi.fn(async (_patch: Record<string, unknown>) => ({ ok: true })),
      setup: vi.fn(async (_workspaceId: string): Promise<{ ok: boolean; code?: string; archived?: number }> => ({ ok: true, archived: 0 })),
      archiveList: vi.fn(async () => ({
        decisions: [{
          workspaceId: work.id,
          decision: { id: 'd1', question: 'Ship the release?', options: [], context: '', status: 'pending' as const, raisedAt: 1 },
          archivedAt: Date.UTC(2026, 9, 1),
        }],
      })),
      archiveAck: vi.fn(async () => ({ ok: true })),
      resetStore: vi.fn(async () => ({ ok: true })),
      onChanged: () => () => undefined,
    },
    mode: {
      get: vi.fn(async (id: string) => ({ mode: modes[id] ?? 'off' })),
      set: vi.fn(async (id: string, mode: string) => {
        modes[id] = mode;
        return { ok: true, mode };
      }),
    },
    autoWake: { get: async () => ({ enabled: true }), set: async (enabled: boolean) => ({ enabled }) },
    ledgerGate: { get: async () => ({ enabled: false }), set: async (enabled: boolean) => ({ enabled }) },
    briefing: {
      getConfig: async () => ({ enabled: true, autoShow: true }),
      setConfig: async (c: Record<string, boolean>) => ({ enabled: true, autoShow: true, ...c }),
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let saved: { workspaces: unknown; activeWorkspaceId: unknown; moa: unknown; moaHqPendingId: unknown };

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

async function render(state: MoaState): Promise<void> {
  current = state;
  act(() => useStore.setState({ moa: state }));
  await act(async () => root.render(createElement(TabMoa)));
  await flush();
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
};
const rowSwitch = (id: string) => q<HTMLButtonElement>(`[data-setting-id="${id}"] [role="switch"]`);

beforeEach(() => {
  api = makeApi();
  (window as unknown as { electronAPI: unknown }).electronAPI = { deck: api };
  const s = useStore.getState();
  saved = { workspaces: s.workspaces, activeWorkspaceId: s.activeWorkspaceId, moa: s.moa, moaHqPendingId: s.moaHqPendingId };
  act(() => useStore.setState({ workspaces: [work, hq], activeWorkspaceId: work.id }));
  act(() => useStore.getState().setSettingsPanelVisible(true));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState(saved as never));
  act(() => useStore.getState().setSettingsPanelVisible(false));
});

describe('Settings › Moa › master switch', () => {
  it('opens the first-run card instead of turning on when not onboarded', async () => {
    await render(moaState({ enabled: false, onboarded: false, hq: 'unset' }));
    expect(rowSwitch('moaswitch')!.getAttribute('aria-checked')).toBe('false');
    await click(rowSwitch('moaswitch'));
    expect(q('[data-testid="moa-first-run"]')).not.toBeNull();
    expect(api.moa.set).not.toHaveBeenCalled();
  });

  it('turns on directly once onboarded with an HQ', async () => {
    await render(moaState({ enabled: false }));
    await click(rowSwitch('moaswitch'));
    expect(api.moa.set).toHaveBeenCalledWith(true);
    expect(q('[data-testid="moa-first-run"]')).toBeNull();
  });

  it('an existing orchestrator user with no HQ turns back on directly, without the card', async () => {
    await render(moaState({ enabled: false, onboarded: false, hq: 'unset', defaultReason: 'existing-brain' }));
    await click(rowSwitch('moaswitch'));
    expect(api.moa.set).toHaveBeenCalledWith(true);
    expect(q('[data-testid="moa-first-run"]')).toBeNull();
    expect(rowSwitch('moaswitch')!.getAttribute('aria-checked')).toBe('true');
  });

  it('a new install with no HQ still goes through the card', async () => {
    await render(moaState({ enabled: false, onboarded: false, hq: 'unset', defaultReason: 'new-install' }));
    await click(rowSwitch('moaswitch'));
    expect(api.moa.set).not.toHaveBeenCalled();
    expect(q('[data-testid="moa-first-run"]')).not.toBeNull();
    // The keep-current-behaviour button is for existing users only.
    expect(q('[data-testid="moa-first-run-turn-on-only"]')).toBeNull();
  });

  it("the card offers an existing user with no HQ to turn on without Moa's workspace", async () => {
    await render(moaState({ enabled: true, onboarded: false, hq: 'unset', defaultReason: 'existing-brain' }));
    await click(q('[data-testid="moa-hq-setup"]'));
    await click(q('[data-testid="moa-first-run-turn-on-only"]'));
    expect(api.moa.set).toHaveBeenCalledWith(true);
    expect(api.moa.setup).not.toHaveBeenCalled();
    expect(q('[data-testid="moa-first-run"]')).toBeNull();
  });

  it('turns off at once', async () => {
    await render(moaState({ enabled: true }));
    await click(rowSwitch('moaswitch'));
    expect(api.moa.set).toHaveBeenCalledWith(false);
    expect(rowSwitch('moaswitch')!.getAttribute('aria-checked')).toBe('false');
  });

  it('says so when main refuses the switch', async () => {
    api.moa.set.mockResolvedValueOnce({ ok: false, code: 'store_corrupt' });
    await render(moaState({ enabled: true }));
    await click(rowSwitch('moaswitch'));
    expect(q('[data-testid="moa-switch-error"]')?.getAttribute('role')).toBe('alert');
  });
});

describe('Settings › Moa › HQ workspace status', () => {
  it('ok: says Ready and opens the HQ', async () => {
    await render(moaState({ hq: 'ok' }));
    expect(q('[data-testid="moa-hq-status"]')!.textContent).toContain('Ready');
    await click(q('[data-testid="moa-hq-open"]'));
    expect(useStore.getState().activeWorkspaceId).toBe(hq.id);
    expect(useStore.getState().settingsPanelVisible).toBe(false);
  });

  it('hq-missing: recreates the Moa workspace', async () => {
    await render(moaState({ hq: 'hq-missing' }));
    expect(q('[data-testid="moa-hq-status"]')!.textContent).toContain('Missing');
    await click(q('[data-testid="moa-hq-recreate"]'));
    expect(api.moa.setup).toHaveBeenCalledTimes(1);
    const createdId = api.moa.setup.mock.calls[0][0];
    expect(useStore.getState().workspaces.find((w) => w.id === createdId)?.name).toBe('Moa');
  });

  it('hq-missing: a failed recreate says so', async () => {
    api.moa.setup.mockResolvedValueOnce({ ok: false, code: 'failed' });
    await render(moaState({ hq: 'hq-missing' }));
    await click(q('[data-testid="moa-hq-recreate"]'));
    expect(q('[data-testid="moa-hq-error"]')).not.toBeNull();
  });

  it('a setup main committed but did not finish: Finish setting up Moa retries on the same workspace', async () => {
    api.moa.setup.mockResolvedValueOnce({ ok: false, code: 'failed', committed: true } as never);
    await render(moaState({ hq: 'hq-missing' }));
    await click(q('[data-testid="moa-hq-recreate"]'));
    const createdId = api.moa.setup.mock.calls[0][0];
    // Kept, not rolled back, even though main now reports the HQ as ok.
    expect(useStore.getState().workspaces.some((w) => w.id === createdId)).toBe(true);
    current = { ...moaState({ hq: 'ok' }), hq: { workspaceId: createdId, state: 'ok' } };
    await act(async () => { await useStore.getState().refreshMoa(); });
    await flush();
    expect(q('[data-testid="moa-hq-status"]')!.textContent).toContain('Setup unfinished');
    await click(q('[data-testid="moa-hq-finish"]'));
    expect(api.moa.setup).toHaveBeenCalledTimes(2);
    expect(api.moa.setup.mock.calls[1][0]).toBe(createdId);
    expect(q('[data-testid="moa-hq-finish"]')).toBeNull();
    expect(q('[data-testid="moa-hq-status"]')!.textContent).toContain('Ready');
  });

  it('hq-unknown: shows Checking…', async () => {
    await render(moaState({ hq: 'hq-unknown' }));
    expect(q('[data-testid="moa-hq-status"]')!.textContent).toContain('Checking…');
    expect(q('[data-testid="moa-hq-status"] button')).toBeNull();
  });

  it('hq-store-corrupt: resets the store and re-reads', async () => {
    await render(moaState({ hq: 'hq-store-corrupt' }));
    const before = api.moa.state.mock.calls.length;
    await click(q('[data-testid="moa-hq-reset"]'));
    expect(api.moa.resetStore).toHaveBeenCalledTimes(1);
    expect(api.moa.state.mock.calls.length).toBeGreaterThan(before);
  });

  it('unset: Set up Moa opens the first-run card', async () => {
    await render(moaState({ hq: 'unset' }));
    expect(q('[data-testid="moa-hq-status"]')!.textContent).toContain('Not set up');
    await click(q('[data-testid="moa-hq-setup"]'));
    expect(q('[data-testid="moa-first-run"]')).not.toBeNull();
  });

  it('explains the rows when Moa is off', async () => {
    await render(moaState({ enabled: false }));
    expect(q('[data-setting-id="moahq"]')!.textContent).toContain('Moa is off');
    expect(q('[data-setting-id="moamodes"]')!.textContent).toContain('Moa is off');
  });
});

describe('Settings › Moa › workspace modes', () => {
  it('lists every workspace but the HQ and writes the picked mode', async () => {
    await render(moaState());
    const table = q('[data-setting-id="moamodes"]')!;
    expect(table.textContent).toContain('Work');
    expect(q(`[data-testid="moa-mode-${hq.id}"]`)).toBeNull();
    expect(api.mode.get).not.toHaveBeenCalledWith(hq.id);
    const group = q(`[data-testid="moa-mode-${work.id}"]`)!;
    const assist = [...group.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Assist')!;
    await click(assist);
    expect(api.mode.set).toHaveBeenCalledWith(work.id, 'assist');
    expect(assist.getAttribute('aria-checked')).toBe('true');
  });
});

describe('Settings › Moa › limits and switches', () => {
  const typeCap = async (value: string) => {
    const input = q<HTMLInputElement>('[data-testid="moa-turn-cap"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    await flush();
  };

  it('refuses a cap outside the range and saves one inside it', async () => {
    await render(moaState());
    await typeCap('0');
    expect(q('[data-testid="moa-turn-cap-error"]')!.textContent).toContain('1');
    await typeCap('500');
    expect(q('[data-testid="moa-turn-cap-error"]')).not.toBeNull();
    await typeCap('2.5');
    expect(api.moa.setConfig).not.toHaveBeenCalled();
    await typeCap('30');
    expect(q('[data-testid="moa-turn-cap-error"]')).toBeNull();
    expect(api.moa.setConfig).toHaveBeenCalledWith({ maxTurnsPerHour: 30 });
  });

  it('has no bubble or reduce-motion rows yet (nothing consumes them)', async () => {
    await render(moaState());
    expect(q('[data-setting-id="moabubbles"]')).toBeNull();
    expect(q('[data-setting-id="moareducemotion"]')).toBeNull();
  });
});

describe('Settings › Moa › archived decisions', () => {
  it('shows no notice when nothing is unacknowledged', async () => {
    await render(moaState());
    expect(q('[data-testid="moa-archive-notice"]')).toBeNull();
  });

  it('notice → dialog → close acknowledges and re-reads', async () => {
    await render(moaState({ unacked: 2 }));
    expect(q('[data-testid="moa-archive-notice"]')!.textContent).toContain("2 pending decisions were moved to Moa's archive");
    await click(q('[data-testid="moa-archive-view"]'));
    const dialog = q('[data-testid="moa-archive-dialog"]')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.textContent).toContain('Ship the release?');
    expect(dialog.textContent).toContain('Work');
    current = moaState({ unacked: 0 });
    const closeBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Close')!;
    await click(closeBtn);
    expect(api.moa.archiveAck).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="moa-archive-dialog"]')).toBeNull();
    expect(q('[data-testid="moa-archive-notice"]')).toBeNull();
  });
});

describe('Settings › Moa › owned dialogs', () => {
  it('registers an open dialog with Settings and releases it on close', async () => {
    const register = vi.fn();
    current = moaState({ enabled: false, onboarded: false, hq: 'unset' });
    act(() => useStore.setState({ moa: current }));
    await act(async () => root.render(createElement(TabMoa, { registerDialog: register })));
    await flush();
    await click(rowSwitch('moaswitch'));
    expect(register).toHaveBeenLastCalledWith(1);
    const notNow = [...q('[data-testid="moa-first-run"]')!.querySelectorAll('button')].find((b) => b.textContent === 'Not now')!;
    await click(notNow);
    expect(register).toHaveBeenLastCalledWith(-1);
  });
});

describe('Settings › Moa › HQ approval pressing', () => {
  it('is off by default, explains itself, and turns on with one patch', async () => {
    await render(moaState());
    expect(rowSwitch('moaapprovalpress')!.getAttribute('aria-checked')).toBe('false');
    expect(q('[data-setting-id="moaapprovalpress"]')!.textContent).toMatch(/Danger/);
    await click(rowSwitch('moaapprovalpress'));
    expect(api.moa.setConfig).toHaveBeenCalledWith({ approvalPress: true });
  });
});

describe('Settings › Moa › issue and PR proposals', () => {
  const typeInto = async (testId: string, value: string) => {
    const input = q<HTMLInputElement>(`[data-testid="${testId}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    await flush();
  };

  it('is off by default and saves the switch, interval and trusted authors', async () => {
    await render(moaState());
    expect(rowSwitch('moaissueproposals')!.getAttribute('aria-checked')).toBe('false');
    await click(rowSwitch('moaissueproposals'));
    expect(api.moa.setConfig).toHaveBeenCalledWith({ issueProposals: true });
    await typeInto('moa-issue-poll', '1');
    expect(q('[data-testid="moa-issue-poll-error"]')).not.toBeNull();
    await typeInto('moa-issue-poll', '30');
    expect(api.moa.setConfig).toHaveBeenCalledWith({ issuePollMinutes: 30 });
    await typeInto('moa-trusted-authors', '@Alice, bob, bad_login');
    expect(api.moa.setConfig).toHaveBeenCalledWith({ trustedAuthors: ['alice', 'bob'] });
    await typeInto('moa-ignored-repos', 'github.com/Acme/Widgets');
    expect(api.moa.setConfig).toHaveBeenCalledWith({ ignoredRepos: ['github.com/acme/widgets'] });
  });
});
