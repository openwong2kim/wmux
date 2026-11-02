// @vitest-environment jsdom
//
// The wizard's "Agent ready" step: with no agent ready the Claude card's
// action is the single primary and the footer says Later; Install shows the
// exact line and runs nothing until Run; once a setup tab is open the dialog
// steps aside to the corner card, and "Back to setup" brings it back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const tab = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../utils/accountLogin', () => ({ openTerminalTab: tab.open }));

import FirstRunWizard from '../FirstRunWizard';
import { useStore } from '../../stores';
import { resetAgentSetupForTests } from '../../utils/agentSetupRuns';
import type { AgentSetupStatus } from '../../../shared/agentSetup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const notInstalled = (agent: 'claude' | 'codex'): AgentSetupStatus => ({
  agent, readiness: 'not-installed', executable: null, version: null, updateRecommended: false, loginKnown: true,
  candidates: [`/home/u/.local/bin/${agent}`],
});
const ready = (agent: 'claude' | 'codex'): AgentSetupStatus => ({
  agent, readiness: 'ready', executable: `/home/u/.local/bin/${agent}`, version: '9.9.9', updateRecommended: false, loginKnown: true, candidates: [],
});

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

function installBridge(statuses: AgentSetupStatus[]) {
  const firstRun = {
    check: vi.fn().mockResolvedValue({ shown: false, status: { claudeFound: false, mcpRegistered: false, claudeJsonPath: '' } }),
    reopen: vi.fn(),
    complete: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    registerMcp: vi.fn(),
    agentStatus: vi.fn().mockResolvedValue(statuses),
    agentPlan: vi.fn().mockResolvedValue({
      agent: 'claude',
      install: { command: INSTALL, shell: 'user', officialPage: 'https://code.claude.com/docs/en/setup', missing: [] },
      login: null,
    }),
    setAgentPath: vi.fn(),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    firstRun,
    pty: { onData: vi.fn(() => () => undefined), onExit: vi.fn(() => () => undefined) },
  };
  return firstRun;
}

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
const primaries = () => Array.from(container.querySelectorAll('.ui-btn-primary')) as HTMLButtonElement[];

beforeEach(() => {
  resetAgentSetupForTests();
  tab.open.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetAgentSetupForTests();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('FirstRunWizard agent ready step', () => {
  it('no agent ready: Claude Install is the single primary and the footer says Later', async () => {
    installBridge([notInstalled('claude'), notInstalled('codex')]);
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-agent-claude-install']);
    expect(byId('first-run-wizard-skip')?.textContent).toBe('Later');
    // The old "not detected → claude.ai/code" row is replaced by the card.
    expect(byId('first-run-wizard-claude-missing')).toBeNull();
  });

  it('one agent ready is enough: no agent primary, the footer keeps its usual label', async () => {
    installBridge([notInstalled('claude'), ready('codex')]);
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();
    expect(primaries().map((b) => b.dataset.testid)).not.toContain('first-run-agent-claude-install');
    expect(byId('first-run-wizard-skip')?.textContent).not.toBe('Later');
    expect(byId('first-run-agent-codex')?.dataset.status).toBe('ok');
  });

  it('once an agent is signed in, only it is listed; the rest wait under Other agents', async () => {
    installBridge([notInstalled('claude'), ready('codex')]);
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();
    expect(byId('first-run-agent-codex')).not.toBeNull();
    expect(byId('first-run-agent-claude')).toBeNull();
    const more = byId('first-run-agent-show-others') as HTMLButtonElement;
    expect(more.textContent).toMatch(/^Other agents \(\d+\)$/);
    await act(async () => { more.click(); });
    expect(byId('first-run-agent-claude')).not.toBeNull();
    expect(byId('first-run-agent-show-others')).toBeNull();
  });

  it('Install shows the exact line and runs nothing until Run; then the dialog steps aside', async () => {
    installBridge([notInstalled('claude'), notInstalled('codex')]);
    tab.open.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-1' });
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();

    await act(async () => { byId('first-run-agent-claude-install')?.click(); });
    await settle();
    expect(byId('first-run-agent-claude-command')?.textContent).toBe(INSTALL);
    expect(tab.open).not.toHaveBeenCalled();

    await act(async () => { byId('first-run-agent-claude-run')?.click(); });
    await settle();
    expect(tab.open).toHaveBeenCalledWith(expect.objectContaining({ initialCommand: INSTALL, plainEnv: true }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(byId('first-run-agent-corner')).not.toBeNull();

    await act(async () => { byId('first-run-agent-corner-back')?.click(); });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(byId('first-run-agent-claude')?.textContent).toContain('Installing');
  });

  it('Retry after a failed install goes back to the confirm step; View log steps the dialog aside', async () => {
    installBridge([notInstalled('claude'), notInstalled('codex')]);
    let onData: ((id: string, data: string, replay: boolean) => void) | null = null;
    (window as unknown as { electronAPI: { pty: Record<string, unknown> } }).electronAPI.pty.onData =
      vi.fn((cb: typeof onData) => { onData = cb; return () => undefined; });
    tab.open.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-1' });
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();
    await act(async () => { byId('first-run-agent-claude-install')?.click(); });
    await settle();
    await act(async () => { byId('first-run-agent-claude-run')?.click(); });
    await settle();
    // The installer exits 1: the run fails and the dialog comes back.
    await act(async () => { onData?.('pty-1', '\x1b]133;C\x07\x1b]133;D;1\x07', false); });
    await settle();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(byId('first-run-agent-claude')?.dataset.status).toBe('error');

    // View log: with the run's tab in the store, the dialog steps aside so the
    // tab is usable, and "Back to setup" returns to it.
    const prev = useStore.getState();
    useStore.setState({
      activeWorkspaceId: 'ws-1',
      workspaces: [{ ...(prev.workspaces[0] ?? {}), id: 'ws-1', activePaneId: 'pane-1',
        rootPane: { type: 'leaf', id: 'pane-1', surfaces: [{ id: 'surf-1', ptyId: 'pty-1' }] } }] as never,
    });
    await act(async () => { byId('first-run-agent-claude-view-log')?.click(); });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(byId('first-run-agent-corner')?.textContent).toContain('the terminal tab');
    await act(async () => { byId('first-run-agent-corner-back')?.click(); });
    useStore.setState({ workspaces: prev.workspaces, activeWorkspaceId: prev.activeWorkspaceId });
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry') as HTMLButtonElement).click();
    });
    await settle();
    expect(byId('first-run-agent-claude-command')?.textContent).toBe(INSTALL);
    // One primary only: the card that was primary keeps it (Run).
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-agent-claude-run']);
  });

  it('a row opened from Other agents stays listed through a failed install and Retry', async () => {
    installBridge([notInstalled('claude'), ready('codex')]);
    let onData: ((id: string, data: string, replay: boolean) => void) | null = null;
    (window as unknown as { electronAPI: { pty: Record<string, unknown> } }).electronAPI.pty.onData =
      vi.fn((cb: typeof onData) => { onData = cb; return () => undefined; });
    tab.open.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-1' });
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();
    expect(byId('first-run-agent-claude')).toBeNull();
    await act(async () => { byId('first-run-agent-show-others')?.click(); });
    await act(async () => { byId('first-run-agent-claude-install')?.click(); });
    await settle();
    await act(async () => { byId('first-run-agent-claude-run')?.click(); });
    await settle();
    // The dialog stepped aside to the corner card while the install ran.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { onData?.('pty-1', '\x1b]133;C\x07\x1b]133;D;1\x07', false); });
    await settle();
    expect(byId('first-run-agent-claude')?.dataset.status).toBe('error');
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry') as HTMLButtonElement).click();
    });
    await settle();
    // Retry cleared the failed run; the row is still there, on its confirm step.
    expect(byId('first-run-agent-claude-command')?.textContent).toBe(INSTALL);
  });

  it('an agent whose sign-in wmux cannot check shows installed, says so, and offers Sign in as a secondary', async () => {
    installBridge([notInstalled('claude'), notInstalled('codex'), {
      agent: 'grok', readiness: 'installed', executable: '/home/u/.grok/bin/grok', version: '1.0.67', updateRecommended: false, loginKnown: false, candidates: [],
    }]);
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();
    const card = byId('first-run-agent-grok');
    expect(card?.dataset.status).toBe('ok');
    expect(card?.textContent).toContain('Installed · 1.0.67');
    expect(byId('first-run-agent-grok-sign-in-note')?.textContent).toContain("wmux can't check it");
    expect(byId('first-run-agent-grok-login')?.className).not.toContain('ui-btn-primary');
    // Claude's Install is still the one primary.
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-agent-claude-install']);
  });

  it('an agent with several documented install lines lets the user pick one, and runs exactly that one from the home folder', async () => {
    const PS = 'irm https://x.ai/cli/install.ps1 | iex';
    const WINGET = 'winget install --id xAI.GrokBuild -e';
    const firstRun = installBridge([ready('claude'), notInstalled('codex'), {
      agent: 'grok', readiness: 'not-installed', executable: null, version: null, updateRecommended: false, loginKnown: true, candidates: [],
    }]);
    const ps = { via: 'script', command: PS, shell: 'powershell', officialPage: 'https://docs.x.ai/build/overview', missing: [] };
    const winget = { via: 'winget', command: WINGET, shell: 'powershell', officialPage: 'https://docs.x.ai/build/overview', missing: [] };
    firstRun.agentPlan.mockResolvedValue({ agent: 'grok', install: ps, installs: [ps, winget], login: null });
    tab.open.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-1' });
    // A workspace with its own startup folder: the install still runs from home.
    act(() => {
      useStore.setState((st) => ({ workspaces: st.workspaces.map((w, i) => (i === 0 ? { ...w, profile: { ...w.profile, startupCwd: '/work/project' } } : w)) }) as never);
    });
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();
    // Claude is ready, so the agents not installed wait under "Other agents".
    expect(byId('first-run-agent-grok')).toBeNull();
    await act(async () => { byId('first-run-agent-show-others')?.click(); });

    await act(async () => { byId('first-run-agent-grok-install')?.click(); });
    await settle();
    const via = byId('first-run-agent-grok-via');
    expect([...(via?.querySelectorAll('[role="radio"]') ?? [])].map((b) => b.textContent)).toEqual(['PowerShell', 'WinGet']);
    expect(byId('first-run-agent-grok-command')?.textContent).toBe(PS);

    const wingetOption = [...(via?.querySelectorAll('[role="radio"]') ?? [])].find((b) => b.textContent === 'WinGet') as HTMLButtonElement;
    await act(async () => { wingetOption.click(); });
    expect(byId('first-run-agent-grok-command')?.textContent).toBe(WINGET);
    expect(tab.open).not.toHaveBeenCalled();

    await act(async () => { byId('first-run-agent-grok-run')?.click(); });
    await settle();
    // From the home folder (null), never a workspace's startup folder.
    expect(tab.open).toHaveBeenCalledWith(expect.objectContaining({ initialCommand: WINGET, shell: 'powershell.exe', cwd: null }));
  });

  it('an installed agent whose sign-in wmux cannot check counts as set up: the footer is no longer Later', async () => {
    installBridge([notInstalled('claude'), notInstalled('codex'), {
      agent: 'agy', readiness: 'installed', executable: '/home/u/.local/bin/agy', version: '1.4.5', updateRecommended: false, loginKnown: false, candidates: [],
    }]);
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();
    expect(byId('first-run-wizard-skip')?.textContent).not.toBe('Later');
  });

  it('Run on a card that is not the primary stays secondary', async () => {
    const fr = installBridge([notInstalled('claude'), notInstalled('codex')]);
    fr.agentPlan.mockResolvedValue({
      agent: 'codex',
      install: { command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', shell: 'user', officialPage: 'https://learn.chatgpt.com/docs/codex/cli', missing: [] },
      login: null,
    });
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();
    await act(async () => { byId('first-run-agent-codex-install')?.click(); });
    await settle();
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-agent-claude-install']);
  });

  it('View log shows the clicked agent\'s tab, not the newest run', async () => {
    const fr = installBridge([notInstalled('claude'), notInstalled('codex')]);
    fr.agentPlan.mockImplementation(async (agent: string) => ({
      agent,
      install: { command: `install ${agent}`, shell: 'user', officialPage: 'https://example.invalid', missing: [] },
      login: null,
    }));
    const handlers: Array<(id: string, data: string, replay: boolean) => void> = [];
    (window as unknown as { electronAPI: { pty: Record<string, unknown> } }).electronAPI.pty.onData =
      vi.fn((cb: (id: string, data: string, replay: boolean) => void) => { handlers.push(cb); return () => undefined; });
    let n = 0;
    tab.open.mockImplementation(async () => ({ workspaceId: 'ws-1', ptyId: `pty-${++n}` }));
    const prev = useStore.getState();
    useStore.setState({
      activeWorkspaceId: 'ws-1',
      workspaces: [{ ...(prev.workspaces[0] ?? {}), id: 'ws-1', activePaneId: 'pane-1',
        rootPane: { type: 'leaf', id: 'pane-1', surfaces: [{ id: 'surf-1', ptyId: 'pty-1' }, { id: 'surf-2', ptyId: 'pty-2' }] } }] as never,
    });
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();
    const fail = async (agent: 'claude' | 'codex', pty: string) => {
      await act(async () => { byId(`first-run-agent-${agent}-install`)?.click(); });
      await settle();
      await act(async () => { byId(`first-run-agent-${agent}-run`)?.click(); });
      await settle();
      await act(async () => { for (const h of handlers) h(pty, '\x1b]133;C\x07\x1b]133;D;1\x07', false); });
      await settle();
    };
    await fail('claude', 'pty-1'); // older run
    await fail('codex', 'pty-2');  // newer run
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => { byId('first-run-agent-claude-view-log')?.click(); });
    expect(byId('first-run-agent-corner')?.dataset.agent).toBe('claude');
    useStore.setState({ workspaces: prev.workspaces, activeWorkspaceId: prev.activeWorkspaceId });
  });

  it('after a sign-in succeeds the corner stays: the agent may still be asking in its tab', async () => {
    const loginNeeded: AgentSetupStatus = { ...ready('claude'), readiness: 'login-needed' };
    const fr = installBridge([loginNeeded, notInstalled('codex')]);
    fr.agentPlan.mockResolvedValue({
      agent: 'claude',
      install: { command: INSTALL, shell: 'user', officialPage: 'https://code.claude.com/docs/en/setup', missing: [] },
      login: { command: "'/home/u/.local/bin/claude'", shell: 'user' },
    });
    let onData: ((id: string, data: string, replay: boolean) => void) | null = null;
    (window as unknown as { electronAPI: { pty: Record<string, unknown> } }).electronAPI.pty.onData =
      vi.fn((cb: typeof onData) => { onData = cb; return () => undefined; });
    tab.open.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-1' });
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();
    await act(async () => { byId('first-run-agent-claude-login')?.click(); });
    await settle();
    expect(byId('first-run-agent-corner')).not.toBeNull();
    // Signed in; the agent's own command line ends (the credential is there).
    fr.agentStatus.mockResolvedValue([ready('claude'), notInstalled('codex')]);
    await act(async () => { onData?.('pty-1', '\x1b]133;C\x07\x1b]133;D;0\x07', false); });
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(byId('first-run-agent-corner')?.textContent).toContain('Signed in');
    await act(async () => { byId('first-run-agent-corner-back')?.click(); });
    expect(byId('first-run-agent-claude')?.dataset.status).toBe('ok');
  });
});
