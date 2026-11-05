// @vitest-environment jsdom
//
// #3079 — a company folder whose repository can't have seat worktrees (bare,
// with submodules, using Git LFS): the New company dialog says, under the
// folder, that the seats work in the folder itself, and with two agent seats
// besides the CEO that they can't share it. It used to say nothing, and the
// one seat started in the folder (or Make failed on two).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../utils/projectConfigProbe', () => ({ probeProjectConfig: vi.fn(async () => null) }));

import { useStore } from '../../../stores';
import type { WmuxProjectCompany } from '../../../../shared/companyFile';
import CompanyPresetDialog from '../CompanyPresetDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A company whose CEO is seat 0, with `staffAgents` agent seats besides it. */
function companyWith(staffAgents: number): WmuxProjectCompany {
  return {
    name: 'shop team',
    mission: '',
    standingOrders: '',
    ceo: 0,
    seats: [
      { label: 'ceo', owns: '', agent: 'claude' },
      ...Array.from({ length: staffAgents }, (_, i) => ({ label: `dev-${i + 1}`, owns: '', agent: 'claude' as const })),
      { label: 'notes', owns: '' },
    ],
  };
}

let container: HTMLDivElement;
let root: Root;
let saved: Partial<ReturnType<typeof useStore.getState>>;
const worktreeCheck = vi.fn();

async function render(staffAgents: number): Promise<void> {
  act(() => root.render(createElement(CompanyPresetDialog, { fromFile: { company: companyWith(staffAgents), folder: '/dev/shop' }, onClose: () => undefined })));
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const note = () => container.querySelector('[data-preset-folder-note]')?.textContent ?? null;

beforeEach(() => {
  saved = { workspaces: useStore.getState().workspaces };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  worktreeCheck.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    projectConfig: { companyGet: vi.fn(), companySave: vi.fn(), get: vi.fn(async () => null) },
    dialog: { pickFolder: vi.fn() },
    company: { seatLaunches: vi.fn(), worktreeCheck },
  };
  act(() => useStore.setState({ workspaces: [{ id: 'ws-1', name: 'shop', metadata: { cwd: '/dev/shop' } }] } as never));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  act(() => useStore.setState(saved));
});

describe('CompanyPresetDialog — a folder that cannot have seat worktrees (#3079)', () => {
  it('with one agent seat besides the CEO, says it works in the folder itself, and why', async () => {
    worktreeCheck.mockResolvedValue({ ok: false, reason: 'submodules' });
    await render(1);
    expect(worktreeCheck).toHaveBeenCalledWith('/dev/shop');
    expect(note()).toBe("Seats work in this folder itself: a repository with submodules can't have seat worktrees.");
  });

  it('with two, says too that two agents cannot share it', async () => {
    worktreeCheck.mockResolvedValue({ ok: false, reason: 'lfs' });
    await render(2);
    expect(note()).toBe("Seats would work in this folder itself: a repository that uses Git LFS can't have seat worktrees, and two agents can't share it. Choose another folder.");
  });

  it('says nothing for a folder whose seats get worktrees, or when main could not tell', async () => {
    for (const answer of [{ ok: true }, { ok: false, reason: 'git-error' }, { ok: false, reason: 'not-repo' }]) {
      worktreeCheck.mockResolvedValue(answer);
      await render(2);
      expect(note()).toBeNull();
    }
  });

  it('asks nothing while no seat besides the CEO has an agent', async () => {
    worktreeCheck.mockResolvedValue({ ok: false, reason: 'bare' });
    await render(0);
    expect(worktreeCheck).not.toHaveBeenCalled();
    expect(note()).toBeNull();
  });
});
