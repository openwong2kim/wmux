// @vitest-environment jsdom
// The usage-limit card (#4): opened by itself once for the pane in front,
// resume automatically on by default, another account only with 2+, the
// opt-in "Always switch automatically", another agent only when it is ready.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/continueInAgent', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../utils/continueInAgent')>(),
  continueInAgent: vi.fn(async () => true),
  handoffFacts: vi.fn(async () => ({ requests: ['fix the login bug'], reply: null, planFiles: [], branch: 'main', files: [], transcriptPath: null, draft: 'and the logout one' })),
}));

import { useStore } from '../../../stores';
import { setDaemonModeActive, resetDaemonModeForTests } from '../../../daemon/daemonMode';
import { resetAgentSetupForTests } from '../../../utils/agentSetupRuns';
import { continueInAgent } from '../../../utils/continueInAgent';
import UsageLimitChip from '../UsageLimitChip';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOUR = 3_600_000;
let container: HTMLDivElement;
let root: Root;
let detectedAt = Date.now();
const update = vi.fn(async () => ({ ok: true }));
const rotationSet = vi.fn(async () => ({ ok: true }));
const agentStatus = vi.fn();
const spawnAsk = vi.fn(async () => ({ ok: true, online: true, spawn: {} }));

const HOST = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OLD_HOST = '7a2b3c4d-5e6f-4a70-8b9c-0d1e2f3a4b5c';
/** A paired PC that lets this one start agents there, and one whose wmux cannot. */
const PLACES = [
  { hostId: HOST, name: 'DESK', online: true, supported: true, targets: { v: 1, version: 1, roots: [{ id: 'web', label: 'Web app' }], agents: ['claude'] } },
  { hostId: OLD_HOST, name: 'OLD', online: true, supported: false },
];

function stubApi(opts: { accounts?: number; codex?: 'ready' | 'login-needed'; rotation?: { claude: boolean; rows?: unknown[] }; places?: unknown[] } = {}) {
  const accounts = Array.from({ length: opts.accounts ?? 2 }, (_, i) => ({ id: `acc-${i}`, name: `Account ${i}`, vendor: 'claude', status: { loggedIn: true } }));
  vi.stubGlobal('electronAPI', {
    usageLimit: { update },
    accounts: { list: vi.fn(async () => ({ accounts, bindings: {} })), continuePane: vi.fn(async () => ({ ok: true })) },
    accountRotation: {
      get: vi.fn(async () => ({ settings: { claude: opts.rotation?.claude ?? false, codex: false }, rows: opts.rotation?.rows ?? [] })),
      set: rotationSet,
    },
    firstRun: { agentStatus: agentStatus.mockImplementation(async () => [{ agent: 'claude', readiness: 'ready' }, { agent: 'codex', readiness: opts.codex ?? 'ready' }]) },
    a2aRemote: { spawnOutgoing: vi.fn(async () => ({ requests: [], places: opts.places ?? [] })), spawnAsk },
  });
}

function hold(over: Record<string, unknown> = {}) {
  detectedAt += 1;
  useStore.setState({
    usageLimits: { 'pty-1': { ptyId: 'pty-1', provider: 'claude', detectedAt, resetsAt: Date.now() + 2 * HOUR, source: 'hook', autoResume: true, ...over } },
  } as never);
}

async function render(paneInFront = true) {
  useStore.setState({
    activeWorkspaceId: 'ws-1',
    workspaces: [{ id: 'ws-1', name: 'W', activePaneId: paneInFront ? 'pane-1' : 'pane-2' }],
    surfaceAgent: { 'pty-1': { name: 'claude', status: 'idle', slug: 'claude' } },
  } as never);
  await act(async () => root.render(<UsageLimitChip ptyId="pty-1" compact={false} workspaceId="ws-1" paneId="pane-1" cwd="/repo" />));
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}

const card = () => document.querySelector<HTMLElement>('[data-usage-limit-card]');
const q = <E extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<E>(sel);

beforeEach(() => {
  update.mockClear();
  rotationSet.mockClear();
  vi.mocked(continueInAgent).mockClear();
  agentStatus.mockReset();
  resetAgentSetupForTests();
  setDaemonModeActive(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetDaemonModeForTests();
  vi.unstubAllGlobals();
});

describe('usage-limit card', () => {
  it('opens by itself once for the pane in front, never for a pane behind; the chip toggles it', async () => {
    stubApi();
    hold();
    await render(false);
    expect(card()).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    hold();
    await render(true);
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain('Usage limit reached');
    // Closed, it stays closed for this limit; the chip opens it again.
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(card()).toBeNull();
    // The same limit drawn again (a tab switch remounts the chip): no reopen.
    act(() => root.unmount());
    root = createRoot(container);
    await render(true);
    expect(card()).toBeNull();
    await act(async () => q('[data-usage-limit-action="card"]')!.click());
    expect(card()).not.toBeNull();
  });

  it('resume automatically shows the pane\'s armed state and changes it', async () => {
    stubApi();
    hold({ autoResume: true });
    await render();
    const sw = q<HTMLButtonElement>('[data-usage-limit-card-action="auto-resume"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await act(async () => sw.click());
    expect(update).toHaveBeenCalledWith('pty-1', { autoResume: false });
  });

  it('another account: listed only with 2+ accounts; Always switch turns on switch-by-quota', async () => {
    stubApi({ accounts: 1 });
    hold();
    await render();
    expect(q('[data-testid="usage-limit-card-accounts"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    stubApi({ accounts: 2 });
    hold();
    await render();
    expect(document.querySelectorAll('[data-usage-limit-card-account]')).toHaveLength(2);
    const always = q<HTMLButtonElement>('[data-usage-limit-card-action="always-switch"]')!;
    expect(always.getAttribute('aria-checked')).toBe('false');
    await act(async () => always.click());
    expect(rotationSet).toHaveBeenCalledWith('claude', true);
  });

  it('another agent: offered only when installed and signed in, and opens it in this pane', async () => {
    stubApi({ codex: 'login-needed' });
    hold();
    await render();
    expect(q('[data-usage-limit-card-agent="codex"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    stubApi({ codex: 'ready' });
    resetAgentSetupForTests();
    hold();
    await render();
    // Never the agent that is out.
    expect(q('[data-usage-limit-card-agent="claude"]')).toBeNull();
    // The note it types in, previewed with its length; the unsent draft only once ticked.
    const memo = q('[data-usage-limit-card-memo]')!;
    expect(memo.textContent).toContain('The last request was:\nfix the login bug');
    expect(memo.textContent).not.toContain('and the logout one');
    await act(async () => q('[data-usage-limit-card-action="carry-draft"]')!.click());
    const note = q('[data-usage-limit-card-memo]')!.textContent!;
    expect(note).toContain('A draft that was never sent:\nand the logout one');
    expect(q('[data-usage-limit-card-memo-length]')!.textContent).toBe(`${note.length} characters`);
    await act(async () => q('[data-usage-limit-card-agent="codex"]')!.click());
    expect(continueInAgent).toHaveBeenCalledWith({ heldPtyId: 'pty-1', fromAgent: 'Claude Code', agent: 'codex', workspaceId: 'ws-1', paneId: 'pane-1', cwd: '/repo', note });
    expect(card()).toBeNull();
  });

  it('a limit hit before the app started does not open the card by itself', async () => {
    stubApi();
    hold({ detectedAt: 1_000 });
    await render(true);
    expect(card()).toBeNull();
  });

  it('Esc with the terminal focused closes the card and still reaches the terminal', async () => {
    stubApi();
    hold();
    await render();
    expect(card()).not.toBeNull();
    const term = document.createElement('textarea');
    document.body.appendChild(term);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const reached = vi.fn();
    term.addEventListener('keydown', reached);
    await act(async () => { term.dispatchEvent(esc); });
    expect(card()).toBeNull();
    expect(reached).toHaveBeenCalled();
    expect(esc.defaultPrevented).toBe(false);
    term.remove();
  });

  it('probes the installed agents once, not on every open', async () => {
    stubApi();
    hold();
    await render();
    expect(agentStatus).toHaveBeenCalledTimes(1);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await act(async () => q('[data-usage-limit-action="card"]')!.click());
    expect(card()).not.toBeNull();
    expect(agentStatus).toHaveBeenCalledTimes(1);
  });

  it('a failed handoff is caught, not left as an unhandled rejection', async () => {
    stubApi();
    hold();
    await render();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(continueInAgent).mockRejectedValueOnce(new Error('pty gone'));
    await act(async () => q('[data-usage-limit-card-agent="codex"]')!.click());
    await act(async () => { await Promise.resolve(); });
    expect(warn).toHaveBeenCalledWith('[usageLimit] continue in agent failed', expect.any(Error));
    warn.mockRestore();
  });

  it('another PC: offered for each PC that lets this one start an agent, and opens the ask with the note', async () => {
    stubApi({ codex: 'login-needed', places: PLACES });
    hold({ resetsAt: Date.now() + 150 * 60_000 });
    await render();
    expect(q('[data-usage-limit-card-pc="' + OLD_HOST + '"]')).toBeNull();
    const button = q<HTMLButtonElement>('[data-usage-limit-card-pc="' + HOST + '"]')!;
    expect(button.textContent).toBe('Continue on DESK');
    // Focus moves on: the replies still go to the held pane.
    useStore.setState({ activeWorkspaceId: 'elsewhere' } as never);
    await act(async () => button.click());
    expect(card()).toBeNull();
    const text = q<HTMLTextAreaElement>('[data-testid="remote-spawn-ask-text"]')!.value;
    expect(text).toContain('A conversation with Claude Code on another PC stopped at its usage limit.');
    expect(text).toContain('fix the login bug');
    expect(text).not.toContain('and the logout one');
    // The limit resets in 150 minutes: the request waits two whole hours at most.
    expect(q<HTMLSelectElement>('[data-testid="remote-spawn-ask-hours"]')!.value).toBe('2');
    expect(q('[data-testid="remote-spawn-ask-end"]')!.textContent).toBe('W');
    await act(async () => q<HTMLButtonElement>('[data-testid="remote-spawn-ask-send"]')!.click());
    expect(spawnAsk).toHaveBeenCalledWith({ hostId: HOST, agent: 'claude', folder: { root: 'web' }, text, expiresInHours: 2, end: { workspaceId: 'ws-1', paneId: 'pane-1' }, requestKey: expect.any(String) });
  });

  it('another PC: the unsent draft can go along with no other local agent, and only when ticked', async () => {
    stubApi({ codex: 'login-needed', places: PLACES });
    hold();
    await render();
    expect(q('[data-usage-limit-card-agent="codex"]')).toBeNull();
    const box = q('[data-testid="usage-limit-card-pcs"] [data-usage-limit-card-action="carry-draft"]')!;
    await act(async () => box.click());
    useStore.setState({ activeWorkspaceId: 'elsewhere' } as never);
    await act(async () => q<HTMLButtonElement>('[data-usage-limit-card-pc="' + HOST + '"]')!.click());
    await act(async () => { await Promise.resolve(); });
    expect(q<HTMLTextAreaElement>('[data-testid="remote-spawn-ask-text"]')!.value).toContain('and the logout one');
  });

  it('another PC: asked again on the click, and a PC that no longer lets this one start an agent opens nothing', async () => {
    stubApi({ codex: 'login-needed', places: PLACES });
    hold();
    await render();
    const button = q<HTMLButtonElement>('[data-usage-limit-card-pc="' + HOST + '"]')!;
    const api = (window as unknown as { electronAPI: { a2aRemote: { spawnOutgoing: ReturnType<typeof vi.fn> } } }).electronAPI;
    api.a2aRemote.spawnOutgoing.mockResolvedValue({ requests: [], places: [{ ...PLACES[0], targets: { v: 1, version: 2, roots: [], agents: [] } }] });
    await act(async () => button.click());
    await act(async () => { await Promise.resolve(); });
    expect(q('[data-testid="remote-spawn-ask"]')).toBeNull();
    expect(useStore.getState().toasts.at(-1)?.message).toBe('DESK no longer lets this PC start an agent there.');
  });

  it('another PC: not offered once the limit has reset', async () => {
    stubApi({ places: PLACES });
    hold({ resetsAt: Date.now() - 60_000 });
    await render();
    expect(q('[data-testid="usage-limit-card-pcs"]')).toBeNull();
  });

  it('another PC: not from a pane whose workspace was itself started for someone, nor with no such PC', async () => {
    stubApi({ places: PLACES });
    useStore.setState({ fanoutLineage: { 'ws-1': 'remote-spawn:22222222-2222-4222-8222-222222222222' } } as never);
    hold();
    await render();
    expect(card()).not.toBeNull();
    expect(q('[data-testid="usage-limit-card-pcs"]')).toBeNull();
    useStore.setState({ fanoutLineage: {} } as never);
    act(() => root.unmount());
    root = createRoot(container);
    stubApi({ places: [PLACES[1]] });
    hold();
    await render();
    expect(q('[data-testid="usage-limit-card-pcs"]')).toBeNull();
  });

  it('every account out: says when the first one reopens', async () => {
    const at = Date.now() + 3 * HOUR;
    stubApi({ rotation: { claude: true, rows: [
      { accountId: 'acc-0', vendor: 'claude', verdict: { usable: false, remaining: 0, availableAtMs: at }, capturedAtMs: 1 },
      { accountId: 'acc-1', vendor: 'claude', verdict: { usable: false, remaining: 0, availableAtMs: at + HOUR }, capturedAtMs: 1 },
    ] } });
    hold();
    await render();
    expect(q('[data-usage-limit-card-all-out]')?.textContent).toMatch(/^Every account is out until /);
  });
});
