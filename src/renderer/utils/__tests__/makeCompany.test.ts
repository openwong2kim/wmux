// @vitest-environment jsdom
//
// The make step shared by the New company dialog and a folder's company review:
// main's seats (names, launch lines, worktrees, launch env) become the
// workspace's pane seeds.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { makeCompany } from '../makeCompany';

const seatLaunches = vi.fn();

beforeEach(() => {
  seatLaunches.mockReset().mockResolvedValue({
    ok: true,
    labels: ['ceo', 'web', 'notes'],
    commands: ['claude', 'claude', null],
    cwds: [null, '/wt/web', null],
    launchEnvs: [{ CLAUDE_CODE_SANDBOXED: '1' }, { CLAUDE_CODE_SANDBOXED: '1' }, null],
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = { company: { seatLaunches } };
});

describe('makeCompany', () => {
  it('seeds each seat\'s launch line with the first-run env main made for it, never its pane env', async () => {
    const res = await makeCompany({
      name: 'shop',
      folder: '/dev/shop',
      mission: '',
      standingOrders: '',
      ceo: 0,
      tellSeats: true,
      seats: [
        { label: 'ceo', owns: '', agent: 'claude' },
        { label: 'web', owns: 'Web', agent: 'claude' },
        { label: 'notes', owns: '' },
      ],
    }, () => true);
    expect(res).toEqual({ ok: true });
    const state = useStore.getState();
    const ws = state.workspaces.find((w) => w.name === 'shop' && w.company);
    expect(ws).toBeDefined();
    const seeds = Object.values(state.projectPaneSeed).filter((seed) => ['ceo', 'web', 'notes'].includes(seed.label ?? ''));
    const byLabel = Object.fromEntries(seeds.map((seed) => [seed.label, seed]));
    expect(byLabel.ceo).toMatchObject({ command: 'claude', launchEnv: { CLAUDE_CODE_SANDBOXED: '1' } });
    expect(byLabel.web).toMatchObject({ command: 'claude', cwd: '/wt/web', launchEnv: { CLAUDE_CODE_SANDBOXED: '1' } });
    expect(byLabel.notes).not.toHaveProperty('launchEnv');
    for (const seed of seeds) expect(seed).not.toHaveProperty('env');
  });
});
