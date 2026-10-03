import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHATV2_RPC } from '../../../../shared/chatv2/ipc';
import { createChatV2Host } from '../host';
import { registerChatV2Rpc } from '../rpc';
import type { ChatV2HostDeps } from '../types';

type Handler = (params: Record<string, unknown>, ctx: { clientId: string }) => Promise<unknown>;

function setup(firstParty = true) {
  const handlers = new Map<string, Handler>();
  const host = createChatV2Host({
    wmuxDir: fs.mkdtempSync(path.join(os.tmpdir(), 'chatv2-rpc-')),
    log: () => undefined,
    now: () => Date.now(),
    sessionManager: { getSession: () => undefined },
    approvals: () => null,
    paneFree: async () => true,
    writeToPane: () => false,
    sendTo: () => true,
    processIdentity: async () => null,
    killTree: async () => undefined,
    drivers: () => null,
  } as unknown as ChatV2HostDeps);
  registerChatV2Rpc((method, handler) => handlers.set(method, handler), host, () => firstParty);
  return { handlers, host };
}

describe('registerChatV2Rpc', () => {
  it('registers every daemon.chatv2 method', () => {
    expect([...setup().handlers.keys()].sort()).toEqual(Object.values(CHATV2_RPC).sort());
  });

  it('validates params, then hands them to the host', async () => {
    const { handlers } = setup();
    await expect(handlers.get('daemon.chatv2.bindingForPane')!({ paneId: 'pty-1' }, { clientId: 'main' }))
      .resolves.toEqual({ ok: true, binding: null });
    await expect(handlers.get('daemon.chatv2.send')!({ paneId: 'pty-1' }, { clientId: 'main' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    await expect(handlers.get('daemon.chatv2.create')!({ paneId: 'pty-1', agent: 'claude', mode: 'default' }, { clientId: 'main' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'pane-not-found' } });
  });

  it('refuses a non-first-party client before parsing', async () => {
    const { handlers } = setup(false);
    await expect(handlers.get('daemon.chatv2.create')!({ paneId: 'pty-1', agent: 'claude', mode: 'default' }, { clientId: 'x' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });

  it('refuses everything when the daemon has no host', async () => {
    const handlers = new Map<string, Handler>();
    registerChatV2Rpc((method, handler) => handlers.set(method, handler), null, () => true);
    await expect(handlers.get('daemon.chatv2.bindingForPane')!({ paneId: 'pty-1' }, { clientId: 'main' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });

  it('answers a claude native decision it does not hold with not-found', async () => {
    const { host } = setup();
    await expect(host.answerNative({ adapter: 'claude', requestId: 'r1' }, { decision: 'approve', formKind: 'permission' }, 'pty-1'))
      .resolves.toBe('not-found');
    expect(host.bindingForPane('pty-1')).toBeNull();
  });
});
