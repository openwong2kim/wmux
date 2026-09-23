// @vitest-environment jsdom
//
// fleet.triage — the Fleet board as an RPC answer.
//
// useRpcBridge cannot be imported under vitest, so the routing is pinned in
// SOURCE (as the other useRpcBridge.*.test.ts files do) and the payload is
// tested through buildFleetTriage, the function the branch returns.
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useStore } from '../../stores';
import { buildFleetTriage, fleetTriageScopeError, FLEET_TRIAGE_MAX_ROWS, FLEET_TRIAGE_MAX_DETAIL, FLEET_TRIAGE_MAX_BYTES } from '../../utils/fleetTriage';
import { en } from '../../i18n/locales/en';
import { REMOTE_KEY, seedFleetTriageStore } from '../../utils/__tests__/fleetTriageFixture';

const NOW = 1_800_000_000_000;

beforeEach(() => {
  seedFleetTriageStore(NOW);
});

describe('useRpcBridge fleet.triage routing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8');
  const block = source.match(/if \(method === 'fleet\.triage'\) \{[\s\S]*?\r?\n {2}\}\r?\n/)?.[0] ?? '';

  it('returns the shared board builder, with no active-workspace fallback', () => {
    expect(block).toContain('return buildFleetTriage(store, {');
    // "Who needs me?" is a fleet question: an omitted workspaceId must never
    // collapse to whichever workspace happens to be on screen.
    expect(block).not.toContain('activeWorkspaceId');
    expect(block).toMatch(/includeIdle: params\.includeIdle === true/);
  });

  it('sits behind the startup gate every bridge method shares', () => {
    const gate = source.indexOf("if (store.paneGate !== 'ready')");
    expect(gate).toBeGreaterThan(-1);
    expect(source.indexOf("if (method === 'fleet.triage')")).toBeGreaterThan(gate);
  });
});

describe('buildFleetTriage', () => {
  it('sorts rows into the Fleet sections, in the Fleet order', () => {
    const result = buildFleetTriage(useStore.getState(), {}, NOW);
    expect(result.generatedAt).toBe(NOW);
    // Input requests first (most recent first), then the remote error.
    expect(result.needsYou.map((row) => row.paneId)).toEqual(['p2', 'p1', 'pr']);
    expect(result.running.map((row) => row.paneId)).toEqual(['p3']);
  });

  it('points ptyId at the tab to act on, not the active tab', () => {
    const [background, active] = buildFleetTriage(useStore.getState(), {}, NOW).needsYou;
    expect(background).toMatchObject({
      ptyId: 'pty-2b',
      paneId: 'p2',
      workspaceId: 'ws-2',
      workspaceName: 'beta',
      status: 'awaiting_input',
      detail: 'Which branch should I use?',
      idleMs: 60_000,
    });
    expect(active).toMatchObject({
      ptyId: 'pty-1',
      title: 'migrate billing',
      agentName: 'Claude Code',
      detail: 'Run the migration now?',
      idleMs: 5 * 60_000,
    });
  });

  it('answers fallback details in English even when the UI locale is not', () => {
    expect(useStore.getState().locale).toBe('ko');
    const result = buildFleetTriage(useStore.getState(), {}, NOW);
    expect(result.running[0]).toMatchObject({
      ptyId: 'pty-3',
      status: 'running',
      title: 'Ship fleet triage',
      detail: en['fleet.detail.running'],
    });
    expect(result.needsYou[2].detail).toBe(en['fleet.detail.error']);
  });

  it('keeps a remote row on its synthetic key and names its host', () => {
    const remote = buildFleetTriage(useStore.getState(), {}, NOW).needsYou[2];
    expect(remote).toMatchObject({
      ptyId: REMOTE_KEY,
      paneId: 'pr',
      agentName: 'Codex',
      status: 'error',
      remote: { hostLabel: 'office-mac' },
    });
  });

  it('summarises idle panes and lists them only on includeIdle', () => {
    const summary = buildFleetTriage(useStore.getState(), {}, NOW).idle;
    expect(summary).toEqual({ count: 2, oldestIdleMs: 3 * 3_600_000 });

    const full = buildFleetTriage(useStore.getState(), { includeIdle: true }, NOW).idle;
    expect(full.count).toBe(2);
    expect(full.rows?.map((row) => [row.paneId, row.ptyId, row.detail])).toEqual([
      ['p5', 'pty-5', en['fleet.detail.idle']],
      ['p4', 'pty-4', en['fleet.detail.idle']],
    ]);
  });

  it('narrows to one workspace when workspaceId is given', () => {
    const result = buildFleetTriage(useStore.getState(), { workspaceId: 'ws-2' }, NOW);
    expect(result.needsYou.map((row) => row.ptyId)).toEqual(['pty-2b']);
    expect(result.running).toEqual([]);
    expect(result.idle).toEqual({ count: 0 });

    const idleOnly = buildFleetTriage(useStore.getState(), { workspaceId: 'ws-4', includeIdle: true }, NOW);
    expect(idleOnly.needsYou).toEqual([]);
    expect(idleOnly.idle.rows?.map((row) => row.paneId)).toEqual(['p5', 'p4']);
  });

  it('marks a stashed pane so the caller knows to unstash before focusing', () => {
    const ws = useStore.getState().workspaces.find((w) => w.id === 'ws-4')!;
    const [p4, p5] = (ws.rootPane as Extract<typeof ws.rootPane, { type: 'branch' }>).children;
    useStore.setState({
      workspaces: useStore.getState().workspaces.map((w) => (w.id === 'ws-4'
        ? { ...w, rootPane: p4, activePaneId: 'p4', stashedPanes: [{ pane: p5 }] } as typeof w
        : w)),
    });
    const rows = buildFleetTriage(useStore.getState(), { includeIdle: true }, NOW).idle.rows ?? [];
    expect(rows.find((row) => row.paneId === 'p5')?.stashed).toBe(true);
    expect(rows.find((row) => row.paneId === 'p4')?.stashed).toBeUndefined();
  });

  it('gives every row a locale-free reason', () => {
    const result = buildFleetTriage(useStore.getState(), { includeIdle: true }, NOW);
    const reasons = [...result.needsYou, ...result.running, ...(result.idle.rows ?? [])].map((r) => r.reason);
    expect(reasons.every((r) => typeof r === 'string')).toBe(true);
    expect(result.needsYou[0].reason).toBe('input');
    expect(result.running[0].reason).toBe('running');
  });

  it('clips a long detail so one question cannot blow the result cap', () => {
    const long = 'Should I '.repeat(100);
    useStore.setState({ surfacePendingQuestion: { ...useStore.getState().surfacePendingQuestion, 'pty-2b': long } });
    const [row] = buildFleetTriage(useStore.getState(), {}, NOW).needsYou;
    expect(Array.from(row.detail).length).toBe(FLEET_TRIAGE_MAX_DETAIL);
    expect(row.detail.endsWith('…')).toBe(true);
  });

  it('caps the rows most-urgent first and reports how many were left out', () => {
    const base = useStore.getState();
    const many = Array.from({ length: FLEET_TRIAGE_MAX_ROWS + 20 }, (_, i) => ({
      id: `ws-many-${i}`, name: `many ${i}`, activePaneId: `pm-${i}`,
      rootPane: { id: `pm-${i}`, type: 'leaf' as const, activeSurfaceId: `sm-${i}`,
        surfaces: [{ id: `sm-${i}`, ptyId: `pty-m-${i}`, title: 't', shell: 'zsh', cwd: '/', surfaceType: 'terminal' as const }] },
    }));
    const status = Object.fromEntries(many.map((w) => [`pty-m-${w.id.slice(8)}`, 'error' as const]));
    useStore.setState({
      workspaces: [...base.workspaces, ...many] as typeof base.workspaces,
      surfaceAgentStatus: { ...base.surfaceAgentStatus, ...status },
    });
    const result = buildFleetTriage(useStore.getState(), { includeIdle: true }, NOW);
    const returned = result.needsYou.length + result.running.length + (result.idle.rows?.length ?? 0);
    expect(returned).toBe(FLEET_TRIAGE_MAX_ROWS);
    expect(result.running).toEqual([]);
    expect(result.omitted?.needsYou).toBeGreaterThan(0);
    expect(result.omitted?.running).toBe(1);
    expect(result.idle.count).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result, null, 2))).toBeLessThan(64 * 1024);
  });

  it('refuses an unknown or empty workspaceId instead of answering an empty board', () => {
    const state = useStore.getState();
    expect(fleetTriageScopeError(state, undefined)).toBeNull();
    expect(fleetTriageScopeError(state, state.workspaces[0].id)).toBeNull();
    expect(fleetTriageScopeError(state, 'ws-gone')).toContain('unknown workspaceId');
    expect(fleetTriageScopeError(state, '')).toContain('unknown workspaceId');
  });

  it('the bridge returns the scope error before building a board', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8');
    const block = source.match(/if \(method === 'fleet\.triage'\) \{[\s\S]*?\r?\n {2}\}\r?\n/)?.[0] ?? '';
    expect(block.indexOf('fleetTriageScopeError(')).toBeGreaterThan(-1);
    expect(block.indexOf('fleetTriageScopeError(')).toBeLessThan(block.indexOf('return buildFleetTriage('));
  });

  it('keeps a Hangul-heavy fleet under the byte budget as whole JSON', () => {
    const base = useStore.getState();
    const many = Array.from({ length: FLEET_TRIAGE_MAX_ROWS }, (_, i) => ({
      id: `ws-ko-${i}`, name: `작업공간 ${i}`, activePaneId: `pk-${i}`,
      rootPane: { id: `pk-${i}`, type: 'leaf' as const, activeSurfaceId: `sk-${i}`,
        surfaces: [{ id: `sk-${i}`, ptyId: `pty-k-${i}`, title: 't', shell: 'zsh', cwd: '/', surfaceType: 'terminal' as const }] },
    }));
    const question = '스테이징에 마이그레이션을 지금 적용할까요, 아니면 리뷰를 기다릴까요? '.repeat(10);
    useStore.setState({
      workspaces: [...base.workspaces, ...many] as typeof base.workspaces,
      surfaceAgentStatus: { ...base.surfaceAgentStatus, ...Object.fromEntries(many.map((_, i) => [`pty-k-${i}`, 'awaiting_input' as const])) },
      surfacePendingQuestion: { ...base.surfacePendingQuestion, ...Object.fromEntries(many.map((_, i) => [`pty-k-${i}`, question])) },
    });
    const result = buildFleetTriage(useStore.getState(), {}, NOW);
    const text = JSON.stringify(result, null, 2);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(FLEET_TRIAGE_MAX_BYTES);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(result.omitted?.needsYou).toBeGreaterThan(0);
    expect(result.needsYou.length + (result.omitted?.needsYou ?? 0)).toBeGreaterThanOrEqual(FLEET_TRIAGE_MAX_ROWS);
  });

  it('reports the scope it read', () => {
    const state = useStore.getState();
    expect(buildFleetTriage(state, {}, NOW).scope).toBe('fleet');
    expect(buildFleetTriage(state, { workspaceId: state.workspaces[0].id }, NOW).scope).toBe(state.workspaces[0].id);
  });
});
