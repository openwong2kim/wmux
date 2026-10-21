// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import StarPromptRow, { STAR_THANKS_MS } from '../StarPromptRow';
import AgentNotReadyRow from '../AgentNotReadyRow';
import { useStore } from '../../../stores';
import { refreshAgentStatus, resetAgentSetupForTests } from '../../../utils/agentSetupRuns';
import { resetStarPromptForTests, useStarPromptSessionBridge } from '../../../utils/starPrompt';
import type { AgentSetupStatus } from '../../../../shared/agentSetup';
import {
  STAR_PROMPT_COOLDOWN_MS,
  STAR_PROMPT_MIN_AGE_MS,
  type StarActionResult,
  type StarPromptState,
  type StarredCheck,
} from '../../../../shared/starPrompt';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const status = (agent: 'claude' | 'codex', readiness: AgentSetupStatus['readiness']): AgentSetupStatus => ({
  agent, readiness, executable: null, version: null, updateRecommended: false, loginKnown: true, candidates: [],
});
const READY = [status('claude', 'ready'), status('codex', 'not-installed')];
const NONE_READY = [status('claude', 'login-needed'), status('codex', 'not-installed')];

/** Old enough, 20 sessions in: the row may show. */
const eligible = (): StarPromptState => ({
  firstSeenAt: Date.now() - STAR_PROMPT_MIN_AGE_MS - 1000,
  agentSessionsSinceBaseline: 20,
  nextThreshold: 20,
  deferredUntil: null,
  completed: false,
});

let container: HTMLDivElement;
let root: Root;
let checkStarred: ReturnType<typeof vi.fn>;
let star: ReturnType<typeof vi.fn>;

async function render(statuses: AgentSetupStatus[], opts: { check?: StarredCheck; star?: StarActionResult } = {}) {
  checkStarred = vi.fn().mockResolvedValue(opts.check ?? 'not-starred');
  star = vi.fn().mockResolvedValue(opts.star ?? 'starred');
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    firstRun: { agentStatus: vi.fn().mockResolvedValue(statuses) },
    starPrompt: { checkStarred, star, onAgentSession: vi.fn(() => () => undefined) },
  };
  await refreshAgentStatus();
  await act(async () => {
    root.render(createElement('div', null, createElement(AgentNotReadyRow), createElement(StarPromptRow)));
  });
}

const row = () => container.querySelector('[data-testid="sidebar-star-prompt"]');
const setupRow = () => container.querySelector('[data-testid="sidebar-agent-not-ready"]');

beforeEach(() => {
  resetAgentSetupForTests();
  resetStarPromptForTests();
  useStore.setState({ paneGate: 'ready', starPrompt: eligible() });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetAgentSetupForTests();
  resetStarPromptForTests();
  vi.useRealTimers();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('StarPromptRow', () => {
  it('shows once eligible with an agent ready, after asking gh once', async () => {
    await render(READY);
    expect(setupRow()).toBeNull();
    expect(row()?.textContent).toContain('Enjoying wmux?');
    expect(row()?.querySelector('[data-testid="sidebar-star-prompt-star"]')?.textContent).toBe('Star on GitHub');
    expect(row()?.querySelector('[data-testid="sidebar-star-prompt-dismiss"]')?.getAttribute('aria-label')).toBe('Not now');
    expect(checkStarred).toHaveBeenCalledTimes(1);
    // A second mount in the same app session does not ask again.
    await act(async () => { root.render(createElement('div')); });
    await act(async () => { root.render(createElement(StarPromptRow)); });
    expect(row()).not.toBeNull();
    expect(checkStarred).toHaveBeenCalledTimes(1);
  });

  it('gives way to "Agent not set up": never both rows', async () => {
    await render(NONE_READY);
    expect(setupRow()).not.toBeNull();
    expect(row()).toBeNull();
    expect(checkStarred).not.toHaveBeenCalled();
  });

  it('stays hidden before the agent check has run', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      starPrompt: { checkStarred: vi.fn(), star: vi.fn(), onAgentSession: vi.fn() },
    };
    await act(async () => { root.render(createElement(StarPromptRow)); });
    expect(row()).toBeNull();
  });

  it('stays hidden while not eligible, without asking gh', async () => {
    useStore.setState({ starPrompt: { ...eligible(), agentSessionsSinceBaseline: 19 } });
    await render(READY);
    expect(row()).toBeNull();
    expect(checkStarred).not.toHaveBeenCalled();
  });

  it('never shows when gh says it is already starred, and ends the prompt', async () => {
    await render(READY, { check: 'starred' });
    expect(row()).toBeNull();
    expect(useStore.getState().starPrompt.completed).toBe(true);
  });

  it('shows anyway when the check cannot tell', async () => {
    await render(READY, { check: 'unknown' });
    expect(row()).not.toBeNull();
  });

  it('"Not now" hides it, doubles the threshold, restarts the count and defers three days', async () => {
    await render(READY);
    const before = Date.now();
    act(() => (row()?.querySelector('[data-testid="sidebar-star-prompt-dismiss"]') as HTMLButtonElement).click());
    expect(row()).toBeNull();
    const s = useStore.getState().starPrompt;
    expect(s.nextThreshold).toBe(40);
    expect(s.agentSessionsSinceBaseline).toBe(0);
    expect(s.deferredUntil).toBeGreaterThanOrEqual(before + STAR_PROMPT_COOLDOWN_MS);
    expect(s.completed).toBe(false);
  });

  it('a gh star says thank you, then leaves for good', async () => {
    await render(READY, { star: 'starred' });
    vi.useFakeTimers();
    await act(async () => {
      (row()?.querySelector('[data-testid="sidebar-star-prompt-star"]') as HTMLButtonElement).click();
    });
    expect(star).toHaveBeenCalledTimes(1);
    const thanks = container.querySelector('[data-testid="sidebar-star-prompt-thanks"]');
    expect(thanks?.textContent).toContain('Starred — thank you');
    expect(thanks?.getAttribute('role')).toBe('status');
    expect(useStore.getState().starPrompt.completed).toBe(true);
    act(() => { vi.advanceTimersByTime(STAR_THANKS_MS); });
    expect(container.querySelector('[data-testid="sidebar-star-prompt-thanks"]')).toBeNull();
    expect(row()).toBeNull();
  });

  it('opening the page instead (no gh) hides it at once and ends the prompt', async () => {
    await render(READY, { star: 'opened' });
    await act(async () => {
      (row()?.querySelector('[data-testid="sidebar-star-prompt-star"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="sidebar-star-prompt-thanks"]')).toBeNull();
    expect(row()).toBeNull();
    expect(useStore.getState().starPrompt.completed).toBe(true);
  });

  it('keeps the row when neither gh nor the browser worked', async () => {
    await render(READY, { star: 'failed' });
    await act(async () => {
      (row()?.querySelector('[data-testid="sidebar-star-prompt-star"]') as HTMLButtonElement).click();
    });
    expect(row()).not.toBeNull();
    expect(useStore.getState().starPrompt.completed).toBe(false);
  });
});

describe('useStarPromptSessionBridge', () => {
  it('waits for the restored session, takes what main held, then drains on every poke', async () => {
    let poke: () => void = () => undefined;
    const drainSessions = vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(2);
    const onAgentSession = vi.fn((cb: () => void) => { poke = cb; return () => undefined; });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      starPrompt: { drainSessions, onAgentSession },
    };
    useStore.setState({ starPrompt: { ...eligible(), agentSessionsSinceBaseline: 0 } });
    function Bridge({ loaded }: { loaded: boolean }) { useStarPromptSessionBridge(loaded); return null; }
    // Before loadSession: nothing is taken, so the restored state cannot overwrite it.
    await act(async () => { root.render(createElement(Bridge, { loaded: false })); });
    expect(drainSessions).not.toHaveBeenCalled();
    expect(onAgentSession).not.toHaveBeenCalled();
    await act(async () => { root.render(createElement(Bridge, { loaded: true })); });
    expect(drainSessions).toHaveBeenCalledTimes(1);
    expect(useStore.getState().starPrompt.agentSessionsSinceBaseline).toBe(3);
    await act(async () => { poke(); });
    expect(drainSessions).toHaveBeenCalledTimes(2);
    expect(useStore.getState().starPrompt.agentSessionsSinceBaseline).toBe(5);
  });
});
