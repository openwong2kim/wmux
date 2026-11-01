// @vitest-environment jsdom
// Pane menu → "Continue in another agent…": the entry only on a pane whose
// agent wmux knows; the dialog offers only other agents that are installed and
// signed in, previews the note, carries the draft only when ticked, and hands
// the previewed note to the same continueInAgent path the usage-limit card uses.
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/continueInAgent', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../utils/continueInAgent')>(),
  continueInAgent: vi.fn(async () => true),
  handoffFacts: vi.fn(async () => ({
    requests: ['fix the login bug'], reply: 'Found it in session.ts.', filesTouched: ['src/session.ts'], planFiles: [],
    repo: 'app', branch: 'main', files: [], transcriptPath: '/t/1.jsonl', draft: 'and the logout one',
  })),
}));

import { useStore } from '../../../stores';
import { resetAgentSetupForTests } from '../../../utils/agentSetupRuns';
import { continueInAgent, handoffFacts } from '../../../utils/continueInAgent';
import ContinueInAgentDialog, { usePaneContinueInAgent } from '../ContinueInAgentDialog';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const q = <E extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<E>(sel);
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); }); };

function stubAgents(statuses: { agent: string; readiness: string }[]) {
  vi.stubGlobal('electronAPI', { firstRun: { agentStatus: vi.fn(async () => statuses) } });
}

/** The menu entry, opening the dialog the way SurfaceTabs does. */
function Harness({ ptyId }: { ptyId: string }) {
  const [open, setOpen] = useState(false);
  const items = usePaneContinueInAgent({ ptyId, allowed: true, onOpen: () => setOpen(true) });
  return (
    <>
      {items.map((item) => <button key={item.key} type="button" data-entry={item.key} onClick={item.onSelect}>{item.label}</button>)}
      {open && <ContinueInAgentDialog ptyId={ptyId} workspaceId="ws-1" paneId="pane-1" cwd="/repo" onClose={() => setOpen(false)} />}
    </>
  );
}

beforeEach(() => {
  vi.mocked(continueInAgent).mockClear();
  resetAgentSetupForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Continue in another agent (pane menu)', () => {
  it('offers the other signed-in agents, previews the note, and hands that note to continueInAgent', async () => {
    stubAgents([{ agent: 'claude', readiness: 'ready' }, { agent: 'codex', readiness: 'ready' }, { agent: 'gemini', readiness: 'login-needed' }]);
    useStore.setState({ surfaceAgent: { 'pty-1': { name: 'claude', status: 'idle', slug: 'claude' }, 'pty-2': { name: 'zsh', status: 'idle' } } } as never);
    await act(async () => root.render(<Harness ptyId="pty-2" />));
    // A terminal with no known agent has no entry.
    expect(q('[data-entry]')).toBeNull();
    await act(async () => root.render(<Harness ptyId="pty-1" />));
    expect(q('[data-entry="continue-in-agent"]')!.textContent).toBe('Continue in another agent…');
    await act(async () => q('[data-entry="continue-in-agent"]')!.click());
    await flush();
    expect(q('[data-testid="continue-in-agent-dialog"]')).not.toBeNull();
    // Never the pane's own agent, never one that is not signed in.
    expect([...document.querySelectorAll('[data-continue-in-agent]')].map((b) => b.getAttribute('data-continue-in-agent'))).toEqual(['codex']);
    const preview = () => q('[data-handoff-note]')!.textContent!;
    expect(preview()).toContain('Continuing work Claude Code started in app, on branch main.\nAsked: fix the login bug\n');
    expect(preview()).not.toContain('and the logout one');
    await act(async () => q('[data-continue-in-agent-action="carry-draft"]')!.click());
    const note = preview();
    expect(note.endsWith('\nUnsent draft: and the logout one')).toBe(true);
    expect(q('[data-handoff-note-length]')!.textContent).toBe(`${note.length} characters`);
    await act(async () => q('[data-continue-in-agent="codex"]')!.click());
    expect(continueInAgent).toHaveBeenCalledWith({ heldPtyId: 'pty-1', fromAgent: 'Claude Code', agent: 'codex', workspaceId: 'ws-1', paneId: 'pane-1', cwd: '/repo', note });
    expect(q('[data-testid="continue-in-agent-dialog"]')).toBeNull();
  });

  it('offers no agent until the note is previewed', async () => {
    stubAgents([{ agent: 'claude', readiness: 'ready' }, { agent: 'codex', readiness: 'ready' }]);
    useStore.setState({ surfaceAgent: { 'pty-1': { name: 'claude', status: 'idle', slug: 'claude' } } } as never);
    vi.mocked(handoffFacts).mockReturnValueOnce(new Promise(() => undefined));
    await act(async () => root.render(<ContinueInAgentDialog ptyId="pty-1" workspaceId="ws-1" paneId="pane-1" onClose={() => undefined} />));
    await flush();
    expect(q<HTMLButtonElement>('[data-continue-in-agent="codex"]')!.disabled).toBe(true);
    expect(q('[data-handoff-note]')).toBeNull();
  });

  it('says so when no other agent is installed and signed in', async () => {
    stubAgents([{ agent: 'claude', readiness: 'ready' }, { agent: 'codex', readiness: 'not-installed' }]);
    useStore.setState({ surfaceAgent: { 'pty-1': { name: 'claude', status: 'idle', slug: 'claude' } } } as never);
    await act(async () => root.render(<ContinueInAgentDialog ptyId="pty-1" workspaceId="ws-1" paneId="pane-1" onClose={() => undefined} />));
    await flush();
    expect(q('[data-continue-in-agent]')).toBeNull();
    expect(q('[data-continue-in-agent-none]')!.textContent).toBe('No other agent here is installed and signed in.');
  });
});
