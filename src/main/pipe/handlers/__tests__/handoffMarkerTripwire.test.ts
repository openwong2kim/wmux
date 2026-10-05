// The hand-off provenance line is written only by main's operator lane. A
// non-operator caller whose text carries it is refused before anything is
// written (input.send, a2a.task.send / update).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import { refuseHandoffMarker } from '../a2a.rpc';
import type { PTYManager } from '../../../pty/PTYManager';
import { buildHandoffText } from '../../../../shared/moaHandoff';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const marked = buildHandoffText('Run the audit.', 'task-0123456789abcdef');

describe('hand-off marker tripwire', () => {
  beforeEach(() => vi.clearAllMocks());

  it('input.send from a non-operator caller with the marker is refused before any write', async () => {
    const router = new RpcRouter();
    const write = vi.fn();
    registerInputRpc(router, { write, get: () => undefined } as unknown as PTYManager, () => ({}) as BrowserWindow);
    const res = await router.dispatch({
      id: '1', method: 'input.send',
      params: { workspaceId: 'ws-a', ptyId: 'pty-1', text: marked.toUpperCase() },
    });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toMatch(/operator-approved hand-offs/);
    expect(write).not.toHaveBeenCalled();
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('a2a sends and updates: refused off the operator lane, allowed on it, ignored without the marker', () => {
    expect(refuseHandoffMarker('a2a.task.send', marked, { origin: 'local' } as never)).toMatchObject({ error: expect.stringContaining('moa_propose_handoff') });
    expect(refuseHandoffMarker('a2a.task.send', marked, { origin: 'local', operator: true } as never)).toBeNull();
    expect(refuseHandoffMarker('a2a.task.update', 'all good', { origin: 'local' } as never)).toBeNull();
  });
});
