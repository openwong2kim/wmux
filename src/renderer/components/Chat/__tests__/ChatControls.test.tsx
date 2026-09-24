// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatControls } from '../ChatControls';
import type { TranscriptStatus } from '../../../../shared/transcript/turnEvents';

vi.mock('../../../hooks/useT', () => ({ useT: () => (key: string) => key }));
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function fixture() {
  const controls = { providers: vi.fn(async () => [{ id: 'codex', name: 'Codex', transport: 'codex' }]),
    start: vi.fn(async () => ({ ok: true })), reconnect: vi.fn(async () => ({ ok: true })),
    cancel: vi.fn(async () => ({ ok: true })), respond: vi.fn(async () => ({ ok: true })), close: vi.fn(async () => ({ ok: true })) };
  vi.stubGlobal('electronAPI', { chat: { controls } });
  const status: TranscriptStatus = { available: true, reason: 'ok', agentSessionId: 'native', managed: {
    provider: { id: 'codex', name: 'Codex', transport: 'codex' }, phase: 'blocked',
    capabilities: { send: true, cancel: true, permissions: true, questions: true, resume: true, fileDiff: true, fileUndo: false, liveTerminalAttach: false },
    pending: [{ id: 'permission-1', kind: 'permission', title: 'Run a command', detail: 'echo hello', options: [{ id: 'allow', label: 'Allow once' }] }],
  } };
  return { controls, status, render: async (value = status) => { await act(async () => root.render(<ChatControls ptyId="pane" status={value} refresh={vi.fn()} />)); } };
}
describe('chat controls', () => {
  it('never starts or advertises a separate process when terminal history is unavailable', async () => {
    const f = fixture(); await f.render({ available: false, reason: 'unsupported-agent' });
    expect(host.textContent).toBe('');
    expect(f.controls.providers).not.toHaveBeenCalled();
    expect(f.controls.start).not.toHaveBeenCalled();
  });
  it('does not duplicate native launch input above the shared composer', async () => {
    const f = fixture();
    const launchTerminal = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('electronAPI', { chat: { controls: f.controls, launchTerminal } });
    await f.render({ available: false, reason: 'no-hook' });
    expect(host.textContent).toBe('');
    expect(host.querySelector('input')).toBeNull();
    expect(launchTerminal).not.toHaveBeenCalled();
    await f.render({ available: true, reason: 'ok', agentSessionId: 'existing' });
    expect(host.textContent).toBe('');
  });
  it('binds an approval to its displayed native session and request', async () => {
    const f = fixture(); await f.render();
    expect(host.textContent).toContain('echo hello');
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Allow once')!.click());
    expect(f.controls.respond).toHaveBeenCalledWith({ ptyId: 'pane', agentSessionId: 'native', requestId: 'permission-1', answer: { optionId: 'allow' } });
    expect(host.textContent).not.toContain('chat.closeManaged');
  });
  it('shows recovery for uncertain delivery without automatically retrying the prompt', async () => {
    const f = fixture(); f.status.managed!.phase = 'unconfirmed'; f.status.managed!.pending = [];
    await f.render();
    expect(host.textContent).toContain('chat.deliveryUnknown');
    expect(f.controls.reconnect).not.toHaveBeenCalled();
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'chat.reconnect')!.click());
    expect(f.controls.reconnect).toHaveBeenCalledWith({ ptyId: 'pane', agentSessionId: 'native' });
  });
});
