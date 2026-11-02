// @vitest-environment jsdom
//
// decideProjectTrust records that the approving dialog showed the file's
// company only with a 'trusted' decision.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '../../stores';
import { decideProjectTrust, maybeAutoApplyProjectLayout } from '../projectConfigProbe';
import { createLeafPane } from '../../../shared/types';
import type { ProjectConfigState } from '../../../shared/wmuxProjectConfig';

const state = { found: true, root: '/dev/shop', configPath: '/dev/shop/wmux.json', contentHash: 'h1', trust: 'untrusted' };
const setTrust = vi.fn(async () => ({ ok: true }));
const get = vi.fn(async () => state);
let saved: Partial<ReturnType<typeof useStore.getState>>;

beforeEach(() => {
  const s = useStore.getState();
  saved = { workspaces: s.workspaces, projectConfigs: s.projectConfigs, projectLayoutAutoApplied: s.projectLayoutAutoApplied };
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

describe('maybeAutoApplyProjectLayout', () => {
  const withLayout = {
    ...state,
    trust: 'trusted',
    config: { version: 1, layout: { type: 'branch', direction: 'horizontal', children: [{ type: 'leaf' }, { type: 'leaf' }] } },
  } as ProjectConfigState;

  it('never lays a layout over a company, though a one-seat company looks fresh', () => {
    const ceo = createLeafPane();
    useStore.setState({
      workspaces: [{ id: 'ws-1', name: 'solo', rootPane: ceo, company: { v: 1, id: 'c1', coordinatorPaneId: ceo.id } }],
      projectConfigs: { 'ws-1': withLayout },
      projectLayoutAutoApplied: {},
    } as never);
    expect(maybeAutoApplyProjectLayout('ws-1')).toBe(false);
    expect(useStore.getState().workspaces[0].rootPane).toBe(ceo);
  });

  it('still lays it over a fresh workspace that is no company', () => {
    useStore.setState({
      workspaces: [{ id: 'ws-1', name: 'shop', rootPane: createLeafPane() }],
      projectConfigs: { 'ws-1': withLayout },
      projectLayoutAutoApplied: {},
    } as never);
    expect(maybeAutoApplyProjectLayout('ws-1')).toBe(true);
    expect(useStore.getState().workspaces[0].rootPane.type).toBe('branch');
  });
});
