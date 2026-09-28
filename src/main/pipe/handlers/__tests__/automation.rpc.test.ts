// automation.propose / list / runs on the pipe: an agent drafts, never enables
// or elevates; reads come back without prompt, folder, account or session ids.

import { describe, it, expect, beforeEach } from 'vitest';
import { AutomationClient } from '../../../automation/AutomationClient';
import { AUTOMATION_PROPOSE_LIMIT, AUTOMATION_PROPOSE_WINDOW_MS, registerAutomationRpc } from '../automation.rpc';
import type { Automation, AutomationRun } from '../../../../shared/automation';
import type { RpcContext } from '../../../../shared/rpc';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

const stored: Automation = {
  id: 'a1',
  name: 'Nightly review',
  enabled: false,
  proposed: true,
  revision: 1,
  trigger: { kind: 'schedule', weekdays: [1, 3], time: '09:30', graceMinutes: 180 },
  action: { kind: 'launch', cwd: '/work/repo', agent: 'claude', accountId: 'acc-1', prompt: 'SECRET PROMPT' },
  permission: { mode: 'approval' },
  policy: { overlap: 'skip_if_active' },
  nextRunAt: null,
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'mcp-proposal',
};

const run: AutomationRun = {
  id: 'r1',
  automationId: 'a1',
  revision: 1,
  effectiveMode: 'approval',
  scheduledFor: 100,
  trigger: 'scheduled',
  state: 'completed',
  ptyId: 'auto-xyz',
  agentSessionId: 'sess-1',
  startedAt: 101,
  endedAt: 200,
  hasSnapshot: true,
};

const valid = {
  name: 'Nightly review',
  cwd: '/work/repo',
  agent: 'claude',
  prompt: 'SECRET PROMPT',
  weekdays: [3, 1, 3],
  time: '09:30',
};

let handlers: Map<string, Handler>;
let sent: { method: string; params: Record<string, unknown> | undefined }[];
let clock: number;

beforeEach(() => {
  handlers = new Map();
  sent = [];
  clock = 1_000_000;
  const transport = {
    rpc: async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === 'automation.propose') return { ok: true, automation: stored };
      if (method === 'automation.list') return { automations: [stored], pendingAttention: [] };
      if (method === 'automation.runs') return { runs: [run] };
      throw new Error(`unexpected ${method}`);
    },
  };
  const router = { register: (m: string, h: Handler) => handlers.set(m, h) };
  registerAutomationRpc(router as never, {
    getClient: () => new AutomationClient(transport),
    isDirectory: async (p) => p === '/work/repo',
    now: () => clock,
  });
});

const call = (m: string, p: Record<string, unknown>, ctx?: RpcContext) => handlers.get(m)!(p, ctx);

describe('automation.propose', () => {
  it('sends the daemon exactly { draft } and reports a disabled, proposed, approval-mode draft', async () => {
    const res = (await call('automation.propose', valid)) as { ok: boolean; automation: Record<string, unknown>; note: string };
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('automation.propose');
    expect(Object.keys(sent[0].params!)).toEqual(['draft']);
    expect(sent[0].params!.draft).toEqual({
      name: 'Nightly review',
      trigger: { kind: 'schedule', weekdays: [1, 3], time: '09:30', graceMinutes: 180 },
      action: { kind: 'launch', cwd: '/work/repo', agent: 'claude', prompt: 'SECRET PROMPT' },
      policy: {},
    });
    expect(res.ok).toBe(true);
    expect(res.automation).toMatchObject({ id: 'a1', enabled: false, proposed: true, permissionMode: 'approval' });
    expect(JSON.stringify(res)).not.toContain('SECRET PROMPT');
    expect(res.note).toMatch(/human/);
  });

  it.each([
    ['enabled', true],
    ['permission', { mode: 'bypass', grantedRevision: 1 }],
    ['mode', 'bypass'],
    ['allowedTools', ['Bash']],
    ['accountId', 'acc-1'],
    ['policy', { maxRunMinutes: 1440 }],
  ])('refuses %s without reaching the daemon', async (key, value) => {
    const res = (await call('automation.propose', { ...valid, [key]: value })) as { ok: boolean; error: { code: string; message: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INVALID_ARGUMENT');
    expect(res.error.message).toContain(key);
    expect(sent).toHaveLength(0);
  });

  it('validates bounds, time, weekdays and that cwd exists', async () => {
    for (const bad of [
      { time: '24:00' },
      { weekdays: [] },
      { weekdays: [7] },
      { agent: 'bash' },
      { cwd: 'relative/dir' },
      { cwd: '/does/not/exist' },
      { prompt: 'x'.repeat(8001) },
      { graceMinutes: 0 },
    ]) {
      const res = (await call('automation.propose', { ...valid, ...bad })) as { ok: boolean };
      expect(res.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(sent).toHaveLength(0);
  });

  it(`allows ${AUTOMATION_PROPOSE_LIMIT} drafts per minute across all callers`, async () => {
    for (let i = 0; i < AUTOMATION_PROPOSE_LIMIT; i++) {
      expect(((await call('automation.propose', valid)) as { ok: boolean }).ok).toBe(true);
    }
    const limited = (await call('automation.propose', valid)) as { ok: boolean; error: { code: string } };
    expect(limited.error.code).toBe('RATE_LIMITED');
    expect(sent).toHaveLength(AUTOMATION_PROPOSE_LIMIT);
    clock += AUTOMATION_PROPOSE_WINDOW_MS;
    expect(((await call('automation.propose', valid)) as { ok: boolean }).ok).toBe(true);
  });

  it('refuses a remote-origin caller', async () => {
    const res = (await call('automation.propose', valid, { origin: 'remote' } as RpcContext)) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe('automation.list / automation.runs', () => {
  it('list returns no prompt, folder or account, with the last run folded in', async () => {
    const res = (await call('automation.list', {})) as { ok: boolean; automations: Record<string, unknown>[] };
    expect(res.ok).toBe(true);
    expect(res.automations).toEqual([{
      id: 'a1',
      name: 'Nightly review',
      enabled: false,
      proposed: true,
      agent: 'claude',
      weekdays: [1, 3],
      time: '09:30',
      permissionMode: 'approval',
      nextRunAt: null,
      lastRun: { state: 'completed', at: 200 },
    }]);
    const text = JSON.stringify(res);
    for (const leak of ['SECRET PROMPT', '/work/repo', 'acc-1', 'pendingAttention']) expect(text).not.toContain(leak);
  });

  it('runs drop the PTY id, agent session id and snapshot flag', async () => {
    const res = (await call('automation.runs', { automationId: 'a1' })) as { ok: boolean; runs: Record<string, unknown>[] };
    expect(sent[0].params).toEqual({ automationId: 'a1' });
    expect(res.runs).toEqual([{
      id: 'r1', automationId: 'a1', trigger: 'scheduled', state: 'completed',
      effectiveMode: 'approval', scheduledFor: 100, startedAt: 101, endedAt: 200,
    }]);
  });
});
