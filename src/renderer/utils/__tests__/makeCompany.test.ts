// @vitest-environment jsdom
//
// The make step shared by the New company dialog and a folder's company review:
// main's seats (names, launch lines, worktrees, first-run env) become the
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
    envs: [{ CLAUDE_CODE_SANDBOXED: '1' }, { CLAUDE_CODE_SANDBOXED: '1' }, null],
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = { company: { seatLaunches } };
});

describe('makeCompany', () => {
  it('seeds each seat with the first-run env main made for it', async () => {
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
    expect(byLabel.ceo).toMatchObject({ command: 'claude', env: { CLAUDE_CODE_SANDBOXED: '1' } });
    expect(byLabel.web).toMatchObject({ command: 'claude', cwd: '/wt/web', env: { CLAUDE_CODE_SANDBOXED: '1' } });
    expect(byLabel.notes).not.toHaveProperty('env');
  });
});
