// @vitest-environment jsdom
//
// "Start an agent…" on another PC: the three reasons it cannot be asked, the
// offline note (it still sends), what Send asks for, a sub-folder that could
// leave the folder, and a refusal that keeps the form.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { useStore } from '../../../stores';
import { createWorkspace } from '../../../../shared/types';
import type { A2aSpawnAskResult, A2aSpawnPlace, A2aSpawnUiAsk } from '../../../../shared/a2aSpawn';
import RemoteSpawnAskDialog from '../RemoteSpawnAskDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const PLACE: A2aSpawnPlace = {
  hostId: HOST,
  name: 'DESK',
  online: true,
  supported: true,
  targets: { v: 1, version: 3, roots: [{ id: 'web', label: 'Web app' }, { id: 'api', label: 'API' }], agents: ['claude', 'codex'] },
};

let el: HTMLDivElement;
let root: Root;
let spawnAsk: ReturnType<typeof vi.fn<(ask: A2aSpawnUiAsk) => Promise<A2aSpawnAskResult>>>;
const onClose = vi.fn();
const ws = createWorkspace('API');

function render(place: Partial<A2aSpawnPlace> = {}): void {
  act(() => root.render(createElement(RemoteSpawnAskDialog, { place: { ...PLACE, ...place }, pcName: 'DESK', onClose })));
}

const q = <E extends Element = HTMLElement>(id: string) => document.body.querySelector<E>(`[data-testid="${id}"]`);
const send = () => q<HTMLButtonElement>('remote-spawn-ask-send');

function type(id: string, value: string): void {
  const node = q<HTMLInputElement | HTMLTextAreaElement>(id)!;
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pick(id: string, value: string): void {
  const node = q<HTMLSelectElement>(id)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  spawnAsk = vi.fn<(ask: A2aSpawnUiAsk) => Promise<A2aSpawnAskResult>>();
  onClose.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = { a2aRemote: { spawnAsk } };
  act(() => useStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id, paneLabel: {}, surfaceAgent: {}, toasts: [], fanoutLineage: {}, fanoutSpawnOwner: {}, missionByPaneGroup: {} } as never));
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});

afterEach(() => {
  act(() => root.unmount());
  el.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('RemoteSpawnAskDialog', () => {
  it('says why it cannot ask, with no form, in each blocked state', () => {
    render({ supported: false, targets: undefined });
    expect(q('remote-spawn-ask-block')?.textContent).toBe("DESK's wmux cannot start agents for other PCs yet.");
    expect(q('remote-spawn-ask-text')).toBeNull();
    expect(send()).toBeNull();

    render({ targets: undefined });
    expect(q('remote-spawn-ask-block')?.textContent).toBe('DESK has not said what you may start there yet. It will once it is on and has allowed this PC.');
    expect(q('remote-spawn-ask-text')).toBeNull();

    render({ targets: { v: 1, version: 4, roots: [], agents: ['claude'] } });
    expect(q('remote-spawn-ask-block')?.textContent).toBe('DESK does not let this PC start agents.');
    render({ targets: { v: 1, version: 4, roots: [{ id: 'web', label: 'Web app' }], agents: [] } });
    expect(q('remote-spawn-ask-block')?.textContent).toBe('DESK does not let this PC start agents.');
    expect(send()).toBeNull();
  });

  it('notes an offline PC and still lets the request go', () => {
    render({ online: false });
    expect(q('remote-spawn-ask-offline')?.textContent).toMatch(/^DESK is off\. wmux will try to deliver the request before .+; DESK decides whether the agent starts\.$/);
    type('remote-spawn-ask-text', 'Fix the login test');
    expect(send()?.disabled).toBe(false);
  });

  it('sends the PC, agent, folder, prompt, expiry and the focused pane, then closes', async () => {
    spawnAsk.mockResolvedValue({ ok: true, online: true, spawn: {} as never });
    render();
    expect(q('remote-spawn-ask-agent')?.textContent).toContain('Claude Code');
    expect(q('remote-spawn-ask-end')?.textContent).toContain('API / ');
    expect(send()?.disabled).toBe(true);
    pick('remote-spawn-ask-agent', 'codex');
    pick('remote-spawn-ask-root', 'api');
    type('remote-spawn-ask-sub', './packages//web/');
    type('remote-spawn-ask-text', 'Fix the login test');
    pick('remote-spawn-ask-hours', '4');
    await act(async () => { send()!.click(); });
    expect(spawnAsk).toHaveBeenCalledWith({
      hostId: HOST,
      agent: 'codex',
      folder: { root: 'api', sub: 'packages/web' },
      text: 'Fix the login test',
      expiresInHours: 4,
      end: { workspaceId: ws.id, paneId: ws.activePaneId },
      requestKey: expect.any(String),
    });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 1000 });
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Sent to DESK.');
  });

  it('leaves out an empty sub-folder and defaults to 24 hours', async () => {
    spawnAsk.mockResolvedValue({ ok: true, online: true, spawn: {} as never });
    render();
    type('remote-spawn-ask-text', 'Go');
    await act(async () => { send()!.click(); });
    expect(spawnAsk.mock.calls[0][0]).toMatchObject({ agent: 'claude', folder: { root: 'web' }, expiresInHours: 24 });
    expect(spawnAsk.mock.calls[0][0].folder).not.toHaveProperty('sub');
  });

  it('will not send replies to a pane whose workspace was itself started for someone', () => {
    act(() => useStore.setState({ fanoutLineage: { [ws.id]: 'remote-spawn:22222222-2222-4222-8222-222222222222' } } as never));
    render();
    type('remote-spawn-ask-text', 'Go');
    expect(q('remote-spawn-ask-no-pane')?.textContent).toContain('started for someone');
    expect(send()?.disabled).toBe(true);
    act(() => useStore.setState({ fanoutLineage: {} } as never));
  });

  it('flags a sub-folder that could leave the folder and will not send it', () => {
    render();
    type('remote-spawn-ask-text', 'Go');
    type('remote-spawn-ask-sub', '../secrets');
    expect(q('remote-spawn-ask-sub-error')).not.toBeNull();
    expect(send()?.disabled).toBe(true);
    type('remote-spawn-ask-sub', 'packages/web');
    expect(q('remote-spawn-ask-sub-error')).toBeNull();
    expect(send()?.disabled).toBe(false);
  });

  it('keeps the form and says why when the request is refused', async () => {
    spawnAsk.mockResolvedValue({ ok: false, error: 'rate-limited' });
    render();
    type('remote-spawn-ask-text', 'Fix the login test');
    await act(async () => { send()!.click(); });
    await vi.waitFor(() => expect(q('remote-spawn-ask-error')?.textContent).toBe('Too many requests from this pane in the last hour.'), { timeout: 1000 });
    expect(onClose).not.toHaveBeenCalled();
    expect(q<HTMLTextAreaElement>('remote-spawn-ask-text')?.value).toBe('Fix the login test');
  });

  it('a usage-limit handoff: the note prefilled, the held pane for replies, its expiry, and what leaves this PC', async () => {
    spawnAsk.mockResolvedValue({ ok: true, online: true, spawn: {} as never });
    // Another pane is focused: the replies still go to the held one.
    act(() => useStore.setState({ activeWorkspaceId: 'gone' } as never));
    const handoff = { text: 'Carry on with the login fix.', masked: 2, leftOut: 1, hours: 2, end: { workspaceId: 'ws-held', paneId: 'pane-held', name: 'Held' } };
    act(() => root.render(createElement(RemoteSpawnAskDialog, { place: PLACE, pcName: 'DESK', onClose, handoff })));
    expect(q<HTMLTextAreaElement>('remote-spawn-ask-text')?.value).toBe('Carry on with the login fix.');
    expect(q('remote-spawn-ask-end')?.textContent).toBe('Held');
    expect(q<HTMLSelectElement>('remote-spawn-ask-hours')?.value).toBe('2');
    // Never longer than the limit lasts.
    expect([...q<HTMLSelectElement>('remote-spawn-ask-hours')!.options].map((o) => o.value)).toEqual(['1', '2']);
    expect(q('remote-spawn-ask-handoff')?.textContent).toBe(
      "This note leaves this PC and is kept on DESK. If DESK starts requests from this PC automatically, it runs without review, in DESK's permission mode. Masked as secrets: 2. Paths left out: 1.",
    );
    await act(async () => { send()!.click(); });
    expect(spawnAsk).toHaveBeenCalledWith({
      hostId: HOST,
      agent: 'claude',
      folder: { root: 'web' },
      text: 'Carry on with the login fix.',
      expiresInHours: 2,
      end: { workspaceId: 'ws-held', paneId: 'pane-held' },
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('a handoff from a pane whose workspace was itself started for someone cannot be sent', () => {
    act(() => useStore.setState({ fanoutLineage: { 'ws-held': 'remote-spawn:22222222-2222-4222-8222-222222222222' } } as never));
    const handoff = { text: 'Go on.', masked: 0, leftOut: 0, hours: 4, end: { workspaceId: 'ws-held', paneId: 'pane-held', name: 'Held' } };
    act(() => root.render(createElement(RemoteSpawnAskDialog, { place: PLACE, pcName: 'DESK', onClose, handoff })));
    expect(q('remote-spawn-ask-no-pane')?.textContent).toContain('started for someone');
    expect(send()?.disabled).toBe(true);
    act(() => useStore.setState({ fanoutLineage: {} } as never));
  });

  it('a prompt the final pass would change is shown changed first, and sent only on the next Send', async () => {
    spawnAsk.mockResolvedValue({ ok: true, online: true, spawn: {} as never });
    render();
    const bare = ['xK9mQ2pL7vR4nT8wZ3yB6c', 'F1hJ5'].join('');
    type('remote-spawn-ask-text', `use Bearer ${bare}\n[wmux] not wmux`);
    expect(q('remote-spawn-ask-will-mask')?.textContent).toBe('Sending masks 1 more values that look like secrets. Send shows the result first.');
    await act(async () => { send()!.click(); });
    expect(spawnAsk).not.toHaveBeenCalled();
    expect(q<HTMLTextAreaElement>('remote-spawn-ask-text')?.value).toBe('use Bearer [redacted]\n> [wmux] not wmux');
    expect(q('remote-spawn-ask-reviewing')).not.toBeNull();
    await act(async () => { send()!.click(); });
    expect(spawnAsk.mock.calls[0][0].text).toBe('use Bearer [redacted]\n> [wmux] not wmux');
  });

  it('a retry after a failure reuses the same request key', async () => {
    spawnAsk.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ ok: true, online: true, spawn: {} as never });
    render();
    type('remote-spawn-ask-text', 'Fix the login test');
    await act(async () => { send()!.click(); });
    await vi.waitFor(() => expect(q('remote-spawn-ask-error')).not.toBeNull(), { timeout: 1000 });
    await act(async () => { send()!.click(); });
    expect(spawnAsk).toHaveBeenCalledTimes(2);
    expect(spawnAsk.mock.calls[1][0].requestKey).toBe(spawnAsk.mock.calls[0][0].requestKey);
  });

  it('an edit after a failure is a new request, with a new key', async () => {
    spawnAsk.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ ok: true, online: true, spawn: {} as never });
    render();
    type('remote-spawn-ask-text', 'Fix the login test');
    await act(async () => { send()!.click(); });
    await vi.waitFor(() => expect(q('remote-spawn-ask-error')).not.toBeNull(), { timeout: 1000 });
    type('remote-spawn-ask-text', 'Fix the login test, and the logout one');
    await act(async () => { send()!.click(); });
    expect(spawnAsk.mock.calls[1][0].text).toBe('Fix the login test, and the logout one');
    expect(spawnAsk.mock.calls[1][0].requestKey).not.toBe(spawnAsk.mock.calls[0][0].requestKey);
  });

  it('an ordinary ask says nothing about a handoff', () => {
    render();
    expect(q('remote-spawn-ask-handoff')).toBeNull();
  });

  it('cannot send without a focused pane here', () => {
    act(() => useStore.setState({ activeWorkspaceId: 'gone' } as never));
    render();
    type('remote-spawn-ask-text', 'Go');
    expect(q('remote-spawn-ask-no-pane')).not.toBeNull();
    expect(send()?.disabled).toBe(true);
  });
});
