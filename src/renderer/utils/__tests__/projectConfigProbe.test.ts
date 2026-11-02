// @vitest-environment jsdom
//
// decideProjectTrust records that the approving dialog showed the file's
// company only with a 'trusted' decision.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '../../stores';
import { decideProjectTrust } from '../projectConfigProbe';

const state = { found: true, root: '/dev/shop', configPath: '/dev/shop/wmux.json', contentHash: 'h1', trust: 'untrusted' };
const setTrust = vi.fn(async () => ({ ok: true }));
const get = vi.fn(async () => state);
let saved: Partial<ReturnType<typeof useStore.getState>>;

beforeEach(() => {
  const s = useStore.getState();
  saved = { workspaces: s.workspaces, projectConfigs: s.projectConfigs };
  setTrust.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { projectConfig: { setTrust, get } };
  useStore.setState({
    workspaces: [{ id: 'ws-1', name: 'shop', metadata: { cwd: '/dev/shop' } }],
    projectConfigs: { 'ws-1': state },
  } as never);
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  useStore.setState(saved);
});

describe('decideProjectTrust', () => {
  it('passes companyReviewed with a trusted decision', async () => {
    await decideProjectTrust('ws-1', 'trusted', true, true);
    expect(setTrust).toHaveBeenCalledWith('/dev/shop', 'trusted', 'h1', true, true);
  });

  it('never passes companyReviewed with a denial or a clear', async () => {
    await decideProjectTrust('ws-1', 'denied', true, true);
    expect(setTrust).toHaveBeenLastCalledWith('/dev/shop', 'denied', 'h1', false, false);
    await decideProjectTrust('ws-1', 'clear', true, true);
    expect(setTrust).toHaveBeenLastCalledWith('/dev/shop', 'clear', undefined, false, false);
  });

  it('leaves companyReviewed off by default', async () => {
    await decideProjectTrust('ws-1', 'trusted');
    expect(setTrust).toHaveBeenCalledWith('/dev/shop', 'trusted', 'h1', false, false);
  });
});
