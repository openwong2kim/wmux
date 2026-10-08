// @vitest-environment jsdom
//
// Moa's panel lists the work it exchanged with other PCs' Moa (brain links),
// and re-reads it when main signals a change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MoaRemoteTasks } from '../MoaRemoteTasks';
import type { MoaRemoteTask } from '../../../../../shared/a2aRemoteDelivery';

let container: HTMLDivElement;
let root: Root;
const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}(${Object.values(vars).join(',')})` : key);

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

const task = (n: number, o: Partial<MoaRemoteTask> = {}): MoaRemoteTask => ({
  taskId: `rt-${String(n).padStart(32, '0')}`, title: `Task ${n}`, state: 'working', direction: 'sent', host: 'DESKTOP-WIN2', ...o,
});

describe('MoaRemoteTasks', () => {
  it('shows each task with its state, direction and PC; nothing when empty', async () => {
    let tasks: MoaRemoteTask[] = [];
    let changed: (() => void) | null = null;
    const api = {
      remoteTasks: vi.fn(async () => ({ tasks })),
      onChanged: (cb: () => void) => { changed = cb; return () => { changed = null; }; },
    };
    await act(async () => root.render(createElement(MoaRemoteTasks, { api, t })));
    expect(container.querySelector('[data-moa-remote-tasks]')).toBeNull();

    tasks = [task(1), task(2, { direction: 'received', state: 'input-required', host: 'LINUX-1' })];
    await act(async () => { changed?.(); await new Promise((r) => setTimeout(r, 200)); });
    const rows = [...container.querySelectorAll('[data-moa-remote-task]')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('moa.panel.remoteSent(DESKTOP-WIN2)');
    expect(rows[1].getAttribute('data-direction')).toBe('received');
    expect(rows[1].textContent).toContain('moa.panel.a2a.input-required');
    expect(rows[1].textContent).toContain('moa.panel.remoteReceived(LINUX-1)');
  });

  it('a sent task that is still open says whether the other Moa got it, read it, or not yet', async () => {
    const api = {
      remoteTasks: vi.fn(async () => ({
        tasks: [task(1, { state: 'submitted' }), task(2, { state: 'submitted', receipt: 'delivered' }), task(3, { state: 'submitted', receipt: 'read' }), task(4, { state: 'completed', receipt: 'read' })],
      })),
    };
    await act(async () => { root.render(createElement(MoaRemoteTasks, { api, t })); await new Promise((r) => setTimeout(r, 0)); });
    const shown = [...container.querySelectorAll('[data-moa-remote-receipt]')].map((el) => el.getAttribute('data-moa-remote-receipt'));
    expect(shown).toEqual(['none', 'delivered', 'read']);
    expect(container.textContent).toContain('moa.panel.remoteOnItsWay');
    expect(container.textContent).toContain('moa.panel.remoteGot');
    expect(container.textContent).toContain('moa.panel.remoteRead');
  });
});

