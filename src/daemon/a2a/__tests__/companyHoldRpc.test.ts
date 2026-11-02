import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aTaskService } from '../A2aTaskService';
import { registerCompanyHoldRpc } from '../companyHoldRpc';
import { A2A_COMPANY_RPC } from '../../../shared/companyHold';
import { COMPANY_BRIEF_KIND } from '../../../shared/company';
import type { CompletionEvidence } from '../../../shared/types';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a2a-hold-rpc-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const DONE: CompletionEvidence = { summary: 'done', items: [{ kind: 'inspection', status: 'verified', summary: 'checked' }] };

type Handler = (params: Record<string, unknown>, ctx: { clientId: string }) => Promise<unknown>;

async function setup() {
  const log = new AppendOnlyLog({ dir, fsync: () => undefined });
  log.open();
  const svc = new A2aTaskService({ log, origin: { machineId: 'm1', daemonEpoch: 1 } });
  const handlers = new Map<string, Handler>();
  registerCompanyHoldRpc({ onRpc: (method, handler) => handlers.set(method, handler), isFirstParty: (id) => id === 'main' }, svc);
  const call = (method: string, params: Record<string, unknown> = {}, clientId = 'main') => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params, { clientId });
  };
  const brief = (blockedBy?: string[]) => ({
    kind: 'message' as const,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    role: 'user' as const,
    parts: [{ kind: 'data' as const, data: { kind: COMPANY_BRIEF_KIND, v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r', ...(blockedBy ? { blockedBy } : {}) } }],
  });
  for (const [id, blockedBy] of [['A', undefined], ['C', ['A']]] as const) {
    // eslint-disable-next-line no-await-in-loop -- A exists before C names it
    await svc.createTask({
      id, title: id, from: { workspaceId: 'ws-co', name: 'Co', paneId: 'pane-ceo' }, to: { workspaceId: 'ws-co', name: 'Co', paneId: 'pane-s1' },
      history: [brief(blockedBy ? [...blockedBy] : undefined)],
    });
  }
  await svc.transition({ taskId: 'A', to: 'working', callerWorkspaceId: 'ws-co' });
  await svc.transition({ taskId: 'A', to: 'completed', callerWorkspaceId: 'ws-co', trustedLane: true, evidence: DONE });
  return { svc, call };
}

const idsOf = (res: unknown) => ((res as { tasks?: { id: string }[] }).tasks ?? []).map((t) => t.id);

describe('company hold RPCs', () => {
  it('answer the app\'s main process', async () => {
    const { call } = await setup();
    expect(idsOf(await call(A2A_COMPANY_RPC.pending))).toEqual(['C']);
    expect(idsOf(await call(A2A_COMPANY_RPC.held))).toEqual([]);
    expect(await call(A2A_COMPANY_RPC.mark, { taskId: 'C', attempted: true })).toMatchObject({ ok: true });
    expect(await call(A2A_COMPANY_RPC.mark, { taskId: 'C', delivered: true, ptyId: 'pty-1' })).toMatchObject({ ok: true });
    expect(idsOf(await call(A2A_COMPANY_RPC.pending))).toEqual([]);
  });

  it('refuse any other caller, and change nothing for it', async () => {
    const { svc, call } = await setup();
    for (const [method, params] of [
      [A2A_COMPANY_RPC.pending, {}],
      [A2A_COMPANY_RPC.held, {}],
      [A2A_COMPANY_RPC.mark, { taskId: 'C', delivered: true }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one at a time
      const res = await call(method, { ...params }, 'cli');
      expect(res).toEqual({ ok: false, error: `${method}: answered for the app only` });
    }
    expect(svc.getTask('C')?.metadata.companyHold).not.toHaveProperty('delivered');
  });

  it('check the mark\'s params', async () => {
    const { call } = await setup();
    expect(await call(A2A_COMPANY_RPC.mark, { taskId: 'C' })).toMatchObject({ ok: false, error: expect.stringContaining('exactly one') });
    expect(await call(A2A_COMPANY_RPC.mark, { taskId: 'C', held: 'later' })).toMatchObject({ ok: false, error: expect.stringContaining('unknown held reason') });
    expect(await call(A2A_COMPANY_RPC.mark, { taskId: 'C', attempted: true, ptyId: 'p' })).toMatchObject({ ok: false, error: expect.stringContaining('ptyId goes with delivered') });
  });
});
