import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserPolicyStore } from '../BrowserPolicyStore';
import { BROWSER_POLICY_FILE, BROWSER_POLICY_VERSION } from '../../../shared/browserPolicy';

// Standing consent ("Always on this pane") in the policy store: written only at
// the expected epoch, every change bumps the epoch, kept across an edit of the
// site list, dropped on a rebind or a move.

const WS = 'ws-1';
const PANE = 'pane-1';
const PROFILE = 'pa';
const where = { workspaceId: WS, profileId: PROFILE };
const hosts = { mode: 'allowlist' as const, allow: ['a.test'], block: [] };

let dir: string;
let store: BrowserPolicyStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wmux-policy-grants-'));
  store = new BrowserPolicyStore(dir);
  await store.write({ workspaceId: WS, paneId: PANE, profileId: PROFILE, protected: true, hosts, expectedEpoch: 0 }, PROFILE, true);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('BrowserPolicyStore grants', () => {
  it('setGrants writes at the expected epoch, bumps it, and persists', async () => {
    const before = store.epoch();
    const epoch = await store.setGrants(PANE, where, (g) => ({ ...g, evaluate: true }), before);
    expect(epoch).toBe(before + 1);
    const reread = new BrowserPolicyStore(dir);
    expect(reread.grantsFor(PANE, WS, PROFILE)).toEqual({ grants: { evaluate: true }, epoch });
    expect(JSON.parse(readFileSync(join(dir, BROWSER_POLICY_FILE), 'utf8')).version).toBe(BROWSER_POLICY_VERSION);
  });

  it('a stale epoch, another profile or an unconfirmed pane is refused', async () => {
    await expect(store.setGrants(PANE, where, () => ({ evaluate: true }), store.epoch() - 1)).rejects.toMatchObject({ code: 'stale' });
    await expect(store.setGrants(PANE, { ...where, profileId: 'pb' }, () => ({ evaluate: true }), store.epoch())).rejects.toMatchObject({ code: 'stale' });
    await store.onPaneRebind(PANE);
    await expect(store.setGrants(PANE, where, () => ({ evaluate: true }), store.epoch())).rejects.toMatchObject({ code: 'stale' });
    expect(store.grantsFor(PANE, WS, PROFILE)).toBeNull();
  });

  it('an edit of the site list keeps the grants; turning protection off drops them', async () => {
    await store.setGrants(PANE, where, () => ({ download: true, sensitiveHosts: ['mail.google.com'] }), store.epoch());
    await store.write({ workspaceId: WS, paneId: PANE, profileId: PROFILE, protected: true, hosts: { ...hosts, allow: ['a.test', 'b.test'] }, expectedEpoch: store.epoch() }, PROFILE, true);
    expect(store.entryFor(PANE)?.grants).toEqual({ download: true, sensitiveHosts: ['mail.google.com'] });
    await store.write({ workspaceId: WS, paneId: PANE, profileId: PROFILE, protected: false, hosts, expectedEpoch: store.epoch() }, PROFILE, true);
    expect(store.entryFor(PANE)?.grants).toBeUndefined();
  });

  it('a rebind or a move drops them', async () => {
    await store.setGrants(PANE, where, () => ({ evaluate: true }), store.epoch());
    await store.onPaneRebind(PANE);
    expect(store.entryFor(PANE)?.grants).toBeUndefined();

    await store.write({ workspaceId: WS, paneId: PANE, profileId: PROFILE, protected: true, hosts, expectedEpoch: store.epoch() }, PROFILE, true);
    await store.setGrants(PANE, where, () => ({ evaluate: true }), store.epoch());
    await store.reconcilePanes(new Set([PANE]), new Map([[PANE, 'ws-2']]));
    expect(store.entryFor(PANE)?.grants).toBeUndefined();
  });

  it('reads a version 1 file (no grants) and refuses a malformed grant as a corrupt file', () => {
    const file = join(dir, BROWSER_POLICY_FILE);
    const v1 = { version: 1, epoch: 4, panes: { [PANE]: { workspaceId: WS, paneId: PANE, profileId: PROFILE, protected: true, hosts } } };
    writeFileSync(file, JSON.stringify(v1));
    const s1 = new BrowserPolicyStore(dir);
    expect(s1.fileState()).toBe('ok');
    expect(s1.grantsFor(PANE, WS, PROFILE)).toEqual({ grants: {}, epoch: 4 });
    writeFileSync(file, JSON.stringify({ ...v1, version: 2, panes: { [PANE]: { ...v1.panes[PANE], grants: { sensitiveHosts: ['Not A Host'] } } } }));
    expect(new BrowserPolicyStore(dir).fileState()).toBe('corrupt');
  });
});
