// @vitest-environment jsdom
//
// The mention picker as a user drives it: open, filter, Enter vs ⌘Enter,
// Escape, IME composition, refusal feedback, and a workspace row that has no
// single pane to send to.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Pane, Workspace } from '../../../../shared/types';

const { insertMention } = vi.hoisted(() => ({ insertMention: vi.fn((_source: unknown, _text: string) => 'inserted') }));
vi.mock('../../../utils/agentMentionInsert', async (orig) => ({
  ...(await orig<typeof import('../../../utils/agentMentionInsert')>()),
  insertMention,
}));

import { useStore } from '../../../stores';
import AgentMentionPicker from '../AgentMentionPicker';
import { OPEN_MENTION_PICKER_EVENT } from '../../../utils/agentMentionInsert';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const invoke = vi.fn();

function leaf(id: string, ordinal: number, ptyId: string): Pane {
  return {
    id, type: 'leaf', ordinal, activeSurfaceId: `s-${id}`,
    surfaces: [{ id: `s-${id}`, ptyId, title: 'zsh', shell: 'zsh', cwd: '/', surfaceType: 'terminal' }],
  } as Pane;
}

function seed(): void {
  const ws = {
    id: 'ws-1', name: 'wmux', wsOrdinal: 1, activePaneId: 'pane-a',
    rootPane: { id: 'root', type: 'branch', direction: 'horizontal', children: [leaf('pane-a', 1, 'pty-a'), leaf('pane-b', 2, 'pty-b'), leaf('pane-c', 3, 'pty-c')] },
  } as unknown as Workspace;
  act(() => {
    useStore.setState((s) => {
      s.workspaces = [ws];
      s.activeWorkspaceId = 'ws-1';
      s.surfaceAgent = {
        'pty-a': { name: 'Claude Code', status: 'idle' },
        'pty-b': { name: 'Codex', status: 'idle' },
        'pty-c': { name: 'Gemini', status: 'idle' },
      };
    });
  });
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const open = () => act(() => { document.dispatchEvent(new CustomEvent(OPEN_MENTION_PICKER_EVENT)); });
function key(el: Element, init: KeyboardEventInit) {
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
}
function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
const options = () => [...document.querySelectorAll('[role=option]')].map((o) => o.textContent);

beforeEach(() => {
  insertMention.mockClear();
  invoke.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = { platform: 'darwin', rpc: { invoke } };
  seed();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(React.createElement(AgentMentionPicker)); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AgentMentionPicker', () => {
  it('lists the other agents and inserts the chosen one on Enter', () => {
    open();
    expect(options()).toHaveLength(3); // Codex, Gemini, workspace row
    const filter = q<HTMLInputElement>('[data-agent-mention-filter]')!;
    type(filter, 'gemini');
    key(filter, { key: 'Enter' });
    expect(insertMention).toHaveBeenCalledTimes(1);
    expect(insertMention.mock.calls[0][1]).toContain('[wmux agent "Gemini"');
    expect(q('[data-agent-mention-picker]')).toBeNull();
  });

  it('Escape closes without inserting', () => {
    open();
    key(q('[data-agent-mention-filter]')!, { key: 'Escape' });
    expect(q('[data-agent-mention-picker]')).toBeNull();
    expect(insertMention).not.toHaveBeenCalled();
  });

  it('an Enter that confirms an IME composition does nothing', () => {
    open();
    key(q('[data-agent-mention-filter]')!, { key: 'Enter', isComposing: true });
    expect(insertMention).not.toHaveBeenCalled();
    expect(q('[data-agent-mention-picker]')).not.toBeNull();
  });

  it('pressing the shortcut again while open keeps the draft', () => {
    open();
    type(q<HTMLInputElement>('[data-agent-mention-message]')!, 'draft');
    open();
    expect(q<HTMLInputElement>('[data-agent-mention-message]')!.value).toBe('draft');
  });

  it('⌘Enter sends through main\'s a2a.task.send and shows a refusal inline', async () => {
    invoke.mockResolvedValue({ id: 1, ok: false, error: 'a2a.task.send: pane is gone' });
    open();
    type(q<HTMLInputElement>('[data-agent-mention-message]')!, 'please review');
    key(q('[data-agent-mention-filter]')!, { key: 'Enter', metaKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(insertMention).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('a2a.task.send', expect.objectContaining({
      workspaceId: 'ws-1', senderPtyId: 'pty-a', to: 'ws-1', paneId: 'pane-b',
    }));
    expect(q('[data-agent-mention-feedback]')!.textContent).toContain('pane is gone');
  });

  it('a sent message clears the field and says so', async () => {
    invoke.mockResolvedValue({ id: 1, ok: true, result: { ok: true, delivery: { notified: true, mode: 'nudge' } } });
    open();
    const msg = q<HTMLInputElement>('[data-agent-mention-message]')!;
    type(msg, 'hello');
    key(msg, { key: 'Enter' });
    await act(async () => { await Promise.resolve(); });
    expect(q('[data-agent-mention-feedback]')!.textContent).toContain('Codex');
    expect(msg.value).toBe('');
  });

  it('a workspace row cannot be sent to: Send disabled, no ⌘Enter hint', () => {
    open();
    const filter = q<HTMLInputElement>('[data-agent-mention-filter]')!;
    type(q<HTMLInputElement>('[data-agent-mention-message]')!, 'hi');
    key(filter, { key: 'ArrowUp' }); // wraps to the last row: the workspace row
    expect(q<HTMLButtonElement>('[data-agent-mention-send]')!.disabled).toBe(true);
    expect(q('[data-agent-mention-send-hint]')).toBeNull();
    expect(q('[data-agent-mention-pick-pane]')).not.toBeNull();
    key(filter, { key: 'Enter', metaKey: true });
    expect(invoke).not.toHaveBeenCalled();
  });
});
