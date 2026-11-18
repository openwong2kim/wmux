/**
 * Settings › LAN › Remote approvals: one row per paired PC with its level, and
 * a confirmation before a PC is raised (off to anything, or to `command`).
 * Node env, no DOM: the pure view renders through renderToStaticMarkup, and
 * the model holds the rules.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  A2aApprovalsView,
  ApprovalsModel,
  pairedPcs,
  raisesApproval,
  type A2aApprovalsViewProps,
  type ApprovalLevel,
  type ApprovalsApi,
} from '../A2aRemoteApprovalsSection';
import { en } from '../../../i18n/locales/en';

const tEn = (key: string, vars?: Record<string, string | number>): string => {
  let s = (en as Record<string, string>)[key] ?? key;
  for (const [k, v] of Object.entries(vars ?? {})) s = s.replace(`{${k}}`, String(v));
  return s;
};

const PC_A = '11111111-1111-4111-8111-111111111111';
const PC_B = '22222222-2222-4222-8222-222222222222';

function props(over: Partial<A2aApprovalsViewProps> = {}): A2aApprovalsViewProps {
  return {
    pcs: [{ hostId: PC_A, name: 'Mac' }, { hostId: PC_B, name: 'Desk' }],
    levels: { [PC_A]: 'command' },
    damaged: false,
    pending: null,
    busy: false,
    error: null,
    onChange: () => undefined,
    onConfirm: () => undefined,
    onCancel: () => undefined,
    t: tEn,
    ...over,
  };
}
const render = (p: A2aApprovalsViewProps): string => renderToStaticMarkup(createElement(A2aApprovalsView, p));

describe('A2aApprovalsView', () => {
  it('one row per paired PC, in the plan\'s words, with its level checked; off when unset', () => {
    const html = render(props());
    expect(html).toContain('Agents on Mac can allow or deny permission prompts in tasks they sent here');
    expect(html).toContain('Agents on Desk can allow or deny permission prompts in tasks they sent here');
    const rowA = html.slice(html.indexOf(`data-a2a-approvals-pc="${PC_A}"`), html.indexOf(`data-a2a-approvals-pc="${PC_B}"`));
    const rowB = html.slice(html.indexOf(`data-a2a-approvals-pc="${PC_B}"`));
    expect(rowA).toMatch(/aria-checked="true"[^>]*>(?:<[^>]+>)*Command/);
    expect(rowB).toMatch(/aria-checked="true"[^>]*>(?:<[^>]+>)*Off/);
    // No confirmation, no primary button: the tab has its own primary elsewhere.
    expect(html).not.toContain('data-testid="a2a-approvals-confirm"');
    expect(html).not.toContain('ui-btn-primary');
  });

  it('a raise waiting for its confirmation: the warning under that row, with Cancel and Confirm (secondary)', () => {
    const html = render(props({ pending: { hostId: PC_B, level: 'command' } }));
    expect(html).toContain('data-testid="a2a-approvals-confirm"');
    expect(html).toContain('Agents on Desk will see the command of a permission prompt');
    expect(html).toContain('data-testid="a2a-approvals-ok"');
    expect(html).not.toContain('ui-btn-primary');
    expect(render(props({ pending: { hostId: PC_B, level: 'tool-only' } }))).toContain('Agents on Desk will see the tool name of a permission prompt');
  });

  it('no paired PC, and a damaged settings file, are said', () => {
    expect(render(props({ pcs: [] }))).toContain('No paired PCs.');
    expect(render(props({ damaged: true, levels: {} }))).toContain('data-testid="a2a-approvals-damaged"');
  });
});

describe('raisesApproval', () => {
  it('off to anything, or anything to command, is a raise; lowering never is', () => {
    const raise: Array<[ApprovalLevel, ApprovalLevel]> = [['off', 'tool-only'], ['off', 'command'], ['tool-only', 'command']];
    const lower: Array<[ApprovalLevel, ApprovalLevel]> = [['command', 'tool-only'], ['command', 'off'], ['tool-only', 'off']];
    for (const [a, b] of raise) expect(raisesApproval(a, b)).toBe(true);
    for (const [a, b] of lower) expect(raisesApproval(a, b)).toBe(false);
  });
});

function fakeApi(start: Record<string, ApprovalLevel> = {}) {
  const saved: Record<string, ApprovalLevel> = { ...start };
  const set = vi.fn<(hostId: string, level: ApprovalLevel) => void>();
  const api: ApprovalsApi & { set: typeof set } = {
    hostsList: async () => ({ hosts: [{ hostId: PC_A, name: 'Mac' }] }),
    peersList: async () => ({ peers: [{ hostId: PC_B, name: 'Desk' }, { hostId: '33333333-3333-4333-8333-333333333333', name: 'Old', revokedAt: '2026-11-01T00:00:00.000Z' }] }),
    approvalsGet: async () => ({ hosts: Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== 'off')), damaged: false }),
    set,
    approvalsSet: async (hostId, level) => { set(hostId, level); saved[hostId] = level; return { ok: true as const }; },
  };
  return { api, saved };
}

describe('ApprovalsModel', () => {
  it('lists the PCs this PC joined and those that joined it, not revoked ones', async () => {
    const { api } = fakeApi();
    const m = new ApprovalsModel(api, { failed: 'failed', changed: 'changed' }, () => undefined);
    await m.load();
    expect(m.pcs).toEqual([{ hostId: PC_A, name: 'Mac' }, { hostId: PC_B, name: 'Desk' }]);
    expect(pairedPcs([{ hostId: PC_A, name: 'Mac' }], [{ hostId: PC_A, name: 'dup' }])).toHaveLength(1);
  });

  it('a raise is not saved until confirmed; Cancel saves nothing', async () => {
    const { api } = fakeApi();
    const m = new ApprovalsModel(api, { failed: 'failed', changed: 'changed' }, () => undefined);
    await m.load();
    await m.choose(PC_A, 'command');
    expect(m.pending).toMatchObject({ hostId: PC_A, level: 'command', from: 'off' });
    expect(api.set).not.toHaveBeenCalled();
    m.cancel();
    expect(m.pending).toBeNull();
    expect(api.set).not.toHaveBeenCalled();
    await m.choose(PC_A, 'tool-only');
    await m.confirm();
    expect(api.set).toHaveBeenCalledWith(PC_A, 'tool-only');
    expect(m.levels[PC_A]).toBe('tool-only');
  });

  it('lowering or turning off is saved at once, without asking', async () => {
    const { api } = fakeApi({ [PC_A]: 'command' });
    const m = new ApprovalsModel(api, { failed: 'failed', changed: 'changed' }, () => undefined);
    await m.load();
    await m.choose(PC_A, 'tool-only');
    expect(m.pending).toBeNull();
    expect(api.set).toHaveBeenLastCalledWith(PC_A, 'tool-only');
    await m.choose(PC_A, 'off');
    expect(api.set).toHaveBeenLastCalledWith(PC_A, 'off');
    expect(m.levels[PC_A]).toBeUndefined();
  });

  it('a confirmation for a level that changed meanwhile is refused, and the new level shown', async () => {
    const { api, saved } = fakeApi();
    const m = new ApprovalsModel(api, { failed: 'failed', changed: 'changed' }, () => undefined);
    await m.load();
    await m.choose(PC_A, 'command');
    saved[PC_A] = 'tool-only';
    await m.confirm();
    expect(api.set).not.toHaveBeenCalled();
    expect(m.error).toBe('changed');
    expect(m.levels[PC_A]).toBe('tool-only');
  });
});
