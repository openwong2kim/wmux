// @vitest-environment jsdom
//
// Render test for the Commander brain surface (Command Deck P2d). Mounts the
// pure <CommanderViewContent/> and asserts the brain conversation renders as
// text bubbles + tool chips, a pane-targeting chip is a clickable jump, and the
// busy bar's Stop button interrupts. The packaged Electron UI can't be
// automated, so the pure content component is the render seam.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommanderViewContent, type CommanderViewContentProps } from '../CommanderView';
import type { DeckBrainMessage } from '../deckBrain';

let container: HTMLDivElement;
let root: Root;

function mount(props: Partial<CommanderViewContentProps>): void {
  const full: CommanderViewContentProps = {
    threads: [],
    brainMessages: [],
    brainBusy: false,
    onInterrupt: vi.fn(),
    mentionCandidates: [],
    onSubmit: vi.fn(async () => ({ ok: true })),
    onJumpToPane: vi.fn(),
    resolvePtyPane: () => null,
    workspaceName: () => undefined,
    t: (k: string) => k,
    ...props,
  };
  act(() => {
    root.render(createElement(CommanderViewContent, full));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const brainTurn = (): DeckBrainMessage[] => [
  { id: 'u1', role: 'user', text: 'spawn a worker and run the tests' },
  {
    id: 'a1',
    role: 'assistant',
    text: 'Spawned a worker.',
    status: 'done',
    tools: [
      { toolId: 't1', name: 'pane_split', inputSummary: 'ws-1', ok: true, paneId: 'pane-9', workspaceId: 'ws-1' },
      { toolId: 't2', name: 'terminal_send', inputSummary: 'npm test', ok: true },
    ],
  },
];

describe('CommanderViewContent — brain surface', () => {
  it('shows the empty state when there is no brain or fan-out history', () => {
    mount({});
    expect(container.querySelector('[data-commander-empty]')).not.toBeNull();
  });

  it('renders brain messages as bubbles with tool chips', () => {
    mount({ brainMessages: brainTurn() });
    const msgs = container.querySelectorAll('[data-commander-brain-message]');
    expect(msgs).toHaveLength(2);
    const text = container.querySelectorAll('[data-commander-brain-text]');
    expect(text[text.length - 1].textContent).toContain('Spawned a worker.');
    expect(container.querySelectorAll('[data-commander-tool-chip]')).toHaveLength(2);
    expect(container.querySelector('[data-commander-empty]')).toBeNull();
  });

  it('makes a pane-targeting chip a clickable jump', () => {
    const onJumpToPane = vi.fn();
    mount({ brainMessages: brainTurn(), onJumpToPane });
    const jumpChip = container.querySelector(
      'button[data-commander-tool-chip][data-pane-id="pane-9"]',
    ) as HTMLButtonElement;
    expect(jumpChip).not.toBeNull();
    act(() => jumpChip.click());
    expect(onJumpToPane).toHaveBeenCalledWith('ws-1', 'pane-9');

    // The non-pane chip is a plain span, not a button.
    const plain = container.querySelector('[data-commander-tool-chip][data-tool-name="terminal_send"]');
    expect(plain?.tagName).toBe('SPAN');
  });

  it('shows the busy bar and Stop interrupts', () => {
    const onInterrupt = vi.fn();
    mount({ brainMessages: brainTurn(), brainBusy: true, onInterrupt });
    expect(container.querySelector('[data-commander-busy]')).not.toBeNull();
    const stop = container.querySelector('[data-commander-interrupt]') as HTMLButtonElement;
    act(() => stop.click());
    expect(onInterrupt).toHaveBeenCalled();
    // Composer disabled while busy.
    const input = container.querySelector('[data-channel-composer-input]') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
  });

  it('renders an assistant error inline', () => {
    mount({
      brainMessages: [
        { id: 'u1', role: 'user', text: 'x' },
        { id: 'a1', role: 'assistant', text: '', status: 'error', errorText: 'auth failed' },
      ],
    });
    const err = container.querySelector('[data-commander-brain-error]');
    expect(err?.textContent).toContain('auth failed');
  });

  it('shows the recovery greeting card and its buttons fire (P3b)', () => {
    const onRecoverFleet = vi.fn();
    const onDismissRecovery = vi.fn();
    const panes = [
      {
        ptyId: 'p1',
        autoName: 'w1-1(claude)',
        label: 'api worker',
        workspaceName: 'Backend',
        agent: 'claude',
        command: 'claude --resume sess-1',
        exact: true,
      },
    ];
    mount({ recoveryPanes: panes, onRecoverFleet, onDismissRecovery });

    const card = container.querySelector('[data-commander-recovery]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('api worker');

    const run = container.querySelector('[data-recovery-run]') as HTMLButtonElement;
    act(() => run.click());
    expect(onRecoverFleet).toHaveBeenCalled();

    const dismiss = container.querySelector('[data-recovery-dismiss]') as HTMLButtonElement;
    act(() => dismiss.click());
    expect(onDismissRecovery).toHaveBeenCalled();
  });

  it('disables the recovery button while a brain turn streams', () => {
    mount({
      recoveryPanes: [
        {
          ptyId: 'p1',
          autoName: 'w1-1(claude)',
          label: 'w1-1(claude)',
          workspaceName: 'Backend',
          agent: 'claude',
          command: 'claude --continue',
          exact: false,
        },
      ],
      brainBusy: true,
      brainMessages: brainTurn(),
    });
    const run = container.querySelector('[data-recovery-run]') as HTMLButtonElement;
    expect(run.disabled).toBe(true);
  });

  it('hides the card when there are no recoverable panes', () => {
    mount({ recoveryPanes: [] });
    expect(container.querySelector('[data-commander-recovery]')).toBeNull();
  });
});
