import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTOMATION_RPC, type AutomationMutationResult } from '../../../shared/automation';
import { AutomationEngine } from '../AutomationEngine';
import { assertExternalSessionId, registerAutomationRpc } from '../rpc';

type Handler = (params: Record<string, unknown>, ctx: { clientId: string }) => Promise<unknown>;

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rpc-'));
  const engine = new AutomationEngine({
    wmuxDir: dir,
    parentEnv: {},
    log: () => undefined,
    emit: () => undefined,
    buildBaseCommand: async () => 'claude',
    createSession: async () => undefined,
    sessionPid: () => null,
    isAttached: () => false,
    destroySession: async () => undefined,
    readScreen: async () => '',
    sendKey: async () => undefined,
    readAgent: () => ({ slug: null, verified: false, status: 'idle', inputQuiet: false, incarnationId: null }),
    armAgentTracker: () => undefined,
    deliverPrompt: async () => 'error',
    hasPendingApproval: () => false,
    transcriptTurnEndAt: () => undefined,
    snapshotText: async () => null,
    killTree: async () => undefined,
  });
  await engine.start({ timers: false });
  const handlers = new Map<string, Handler>();
  registerAutomationRpc((m, h) => handlers.set(m, h), engine, (clientId) => clientId === 'desktop', (clientId) => clientId === 'desktop');
  const call = (method: string, params: Record<string, unknown>, clientId: string) => handlers.get(method)!(params, { clientId });
  return { engine, call };
}

const draft = {
  name: 'N',
  trigger: { kind: 'schedule', weekdays: [1], time: '08:30', graceMinutes: 60 },
  action: { kind: 'launch', cwd: '/w', agent: 'claude', prompt: 'p' },
};

describe('automation RPC boundary', () => {
  it('refuses every mutation from a non-first-party client', async () => {
    const { engine, call } = await setup();
    for (const method of [AUTOMATION_RPC.create, AUTOMATION_RPC.propose]) {
      expect(await call(method, { draft }, 'mcp')).toEqual({ ok: false, error: 'Unavailable' });
    }
    expect(engine.list().automations).toEqual([]);
    const created = (await call(AUTOMATION_RPC.create, { draft }, 'desktop')) as AutomationMutationResult;
    if (!created.ok) throw new Error();
    const id = created.automation.id;
    for (const [method, params] of [
      [AUTOMATION_RPC.update, { id, draft }],
      [AUTOMATION_RPC.grant, { id, mode: 'bypass' }],
      [AUTOMATION_RPC.setEnabled, { id, enabled: false }],
      [AUTOMATION_RPC.runNow, { id, kind: 'manual' }],
      [AUTOMATION_RPC.remove, { id }],
      [AUTOMATION_RPC.cancelRun, { runId: 'x' }],
      [AUTOMATION_RPC.ackAttention, { ids: [] }],
    ] as const) {
      expect(await call(method, params, 'mcp'), method).toEqual({ ok: false, error: 'Unavailable' });
    }
    expect(engine.list().automations[0]).toMatchObject({ enabled: true, permission: { mode: 'approval' } });
    expect(engine.listRuns()).toEqual([]);
    // Reads stay open; run output does not.
    expect(((await call(AUTOMATION_RPC.list, {}, 'mcp')) as { automations: unknown[] }).automations).toHaveLength(1);
    expect(await call(AUTOMATION_RPC.snapshot, { runId: 'x' }, 'mcp')).toEqual({ text: null });
  });

  it('ignores a client-sent grantedRevision; grant records the server revision', async () => {
    const { call } = await setup();
    const created = (await call(AUTOMATION_RPC.create, {
      draft: { ...draft, permission: { mode: 'bypass', grantedRevision: 1 } },
    }, 'desktop')) as AutomationMutationResult;
    if (!created.ok) throw new Error();
    expect(created.automation.permission).toEqual({ mode: 'approval' });
    const granted = (await call(AUTOMATION_RPC.grant, {
      id: created.automation.id, mode: 'bypass', grantedRevision: 99,
    }, 'desktop')) as AutomationMutationResult;
    expect(granted.ok && granted.automation.permission).toEqual({ mode: 'bypass', grantedRevision: 1 });
  });

  it('create can start disabled atomically; default stays enabled; propose ignores enabled', async () => {
    const { call } = await setup();
    const off = (await call(AUTOMATION_RPC.create, { draft, enabled: false }, 'desktop')) as AutomationMutationResult;
    expect(off.ok && off.automation).toMatchObject({ enabled: false, nextRunAt: null });
    const on = (await call(AUTOMATION_RPC.create, { draft }, 'desktop')) as AutomationMutationResult;
    expect(on.ok && on.automation.enabled).toBe(true);
    const proposed = (await call(AUTOMATION_RPC.propose, { draft, enabled: true }, 'desktop')) as AutomationMutationResult;
    expect(proposed.ok && proposed.automation.enabled).toBe(false);
  });

  it('a non-first-party list gets no prompt, folder or account', async () => {
    const { call } = await setup();
    await call(AUTOMATION_RPC.create, {
      draft: { ...draft, action: { ...draft.action, accountId: 'acct', prompt: 'secret plan' } },
    }, 'desktop');
    const third = (await call(AUTOMATION_RPC.list, {}, 'mcp')) as { automations: Array<{ name: string; action: Record<string, unknown> }> };
    expect(third.automations[0].name).toBe('N');
    expect(third.automations[0].action).toEqual({ kind: 'launch', agent: 'claude', cwd: '', prompt: '' });
    const first = (await call(AUTOMATION_RPC.list, {}, 'desktop')) as { automations: Array<{ action: { prompt: string } }> };
    expect(first.automations[0].action.prompt).toBe('secret plan');
  });

  it('external daemon.createSession may not use the reserved auto- prefix', () => {
    expect(() => assertExternalSessionId({ id: 'auto-123' })).toThrow();
    expect(() => assertExternalSessionId({ id: 'AUTO-123' })).toThrow();
    expect(() => assertExternalSessionId({ id: 'pane-1' })).not.toThrow();
  });
});
