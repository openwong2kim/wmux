// @vitest-environment jsdom
//
// #3050 — a wmux.json project command is a command, not an agent: its pane stays
// gated even when the user turns off "Withhold credentials from agent panes".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '../../stores';
import { runProjectCommand } from '../projectCommands';
import { resolveEnvPolicy } from '../../../shared/spawnKind';

vi.mock('../projectConfigProbe', () => ({ probeProjectConfig: vi.fn(async () => null) }));

const create = vi.fn(async () => ({ id: 'pty-1', cwd: '/dev/shop' }));
let saved: Partial<ReturnType<typeof useStore.getState>>;

beforeEach(() => {
  const s = useStore.getState();
  saved = { workspaces: s.workspaces, projectConfigs: s.projectConfigs, addSurface: s.addSurface };
  create.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { create, dispose: vi.fn(async () => undefined) } };
  useStore.setState({
    workspaces: [{ id: 'ws-1', name: 'shop', activePaneId: 'pane-1', metadata: { cwd: '/dev/shop' } }],
    projectConfigs: {
      'ws-1': { found: true, root: '/dev/shop', trust: 'trusted', config: { commands: [{ id: 'test', title: 'Test', command: 'npm test' }] } },
    },
    addSurface: vi.fn(),
  } as never);
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  useStore.setState(saved);
});

describe('runProjectCommand env policy', () => {
  it('creates a pane that stays gated with the setting off', async () => {
    await expect(runProjectCommand('ws-1', 'test')).resolves.toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(1);
    const opts = create.mock.calls[0][0] as { initialCommand?: string; spawnKind?: 'user-shell' | 'agent' | 'exec' };
    expect(opts.initialCommand).toBe('npm test');
    expect(resolveEnvPolicy({ spawnKind: opts.spawnKind, withholdFromAgents: false })).toBe('gated');
  });
});
