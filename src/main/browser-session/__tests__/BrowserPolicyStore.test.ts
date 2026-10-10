import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserPolicyStore, BrowserPolicyWriteError } from '../BrowserPolicyStore';
import { BROWSER_POLICY_FILE, BROWSER_POLICY_HISTORY_FILE } from '../../../shared/browserPolicy';

const WS = 'ws-1';
const PANE = 'pane-1';
const PROFILE = 'pa';

function payload(over: Partial<Parameters<BrowserPolicyStore['write']>[0]> = {}) {
  return {
    workspaceId: WS,
    paneId: PANE,
    profileId: PROFILE,
    protected: true,
    hosts: { mode: 'allowlist' as const, allow: ['a.test'], block: [] },
    expectedEpoch: 0,
    ...over,
  };
}

describe('BrowserPolicyStore', () => {
  let dir: string;
  const primary = () => join(dir, BROWSER_POLICY_FILE);
  const history = () => join(dir, BROWSER_POLICY_HISTORY_FILE);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wmux-browser-policy-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('with no files: legacy everywhere, and reading never creates a file', async () => {
    const store = new BrowserPolicyStore(dir);
    expect(store.fileState()).toBe('missing');
    expect(store.hasAnyHistory()).toBe(false);
    expect(store.decisionFor(PANE, WS, PROFILE)).toEqual({ kind: 'legacy' });
    await store.bumpEpoch();
    await store.onPaneRebind(PANE);
    await store.reconcilePanes(new Set(['x']), new Map());
    expect(existsSync(primary())).toBe(false);
    expect(existsSync(history())).toBe(false);
  });

  it('a protected write records the history first and resolves to the confirmed hosts', async () => {
    const store = new BrowserPolicyStore(dir);
    const epoch = await store.write(payload(), PROFILE, true);
    expect(epoch).toBe(1);
    expect(JSON.parse(readFileSync(history(), 'utf8'))).toEqual({ panes: { [PANE]: WS } });
    const d = new BrowserPolicyStore(dir).decisionFor(PANE, WS, PROFILE);
    expect(d).toMatchObject({ kind: 'protected', confirmed: true, epoch: 1, hosts: { allow: ['a.test'] } });
  });

  it('refuses a stale expectedEpoch', async () => {
    const store = new BrowserPolicyStore(dir);
    await store.write(payload(), PROFILE, true);
    await expect(store.write(payload({ expectedEpoch: 0 }), PROFILE, true)).rejects.toMatchObject({ code: 'stale' });
    await expect(store.write(payload({ expectedEpoch: 1 }), PROFILE, true)).resolves.toBe(2);
  });

  it('refuses protection on a profile that is not the pane’s own, or that changed', async () => {
    const store = new BrowserPolicyStore(dir);
    await expect(store.write(payload(), PROFILE, false)).rejects.toBeInstanceOf(BrowserPolicyWriteError);
    await expect(store.write(payload(), 'other', true)).rejects.toMatchObject({ code: 'stale' });
    await expect(store.write(payload({ hosts: { mode: 'allowlist', allow: ['u@x'], block: [] } }), PROFILE, true))
      .rejects.toMatchObject({ code: 'invalid' });
  });

  it('a corrupt primary is never restored from .bak; a previously protected pane is refused', async () => {
    const store = new BrowserPolicyStore(dir);
    await store.write(payload(), PROFILE, true);
    await store.write(payload({ expectedEpoch: 1 }), PROFILE, true); // leaves a .bak behind, if any
    writeFileSync(primary(), '{ torn');
    writeFileSync(`${primary()}.bak`, readFileSync(history(), 'utf8')); // whatever .bak holds, it is ignored
    const fresh = new BrowserPolicyStore(dir);
    expect(fresh.fileState()).toBe('corrupt');
    expect(fresh.decisionFor(PANE, WS, PROFILE)).toMatchObject({ kind: 'denied' });
    expect(fresh.decisionFor('never-protected', WS, PROFILE)).toEqual({ kind: 'legacy' });
    expect(readFileSync(primary(), 'utf8')).toBe('{ torn'); // not quarantined or rewritten
  });

  it('a previously protected pane whose file went missing is refused', async () => {
    const store = new BrowserPolicyStore(dir);
    await store.write(payload(), PROFILE, true);
    rmSync(primary());
    const fresh = new BrowserPolicyStore(dir);
    expect(fresh.fileState()).toBe('missing');
    expect(fresh.decisionFor(PANE, WS, PROFILE)).toMatchObject({ kind: 'denied' });
  });

  it('an unreadable history fails closed when the primary cannot answer', () => {
    writeFileSync(history(), 'nope');
    const store = new BrowserPolicyStore(dir);
    expect(store.hasAnyHistory()).toBe(true);
    expect(store.decisionFor('any-pane', WS, PROFILE)).toMatchObject({ kind: 'denied' });
  });

  it('an unsupported version and a malformed entry both read as unusable', async () => {
    writeFileSync(primary(), JSON.stringify({ version: 99, epoch: 1, panes: {} }));
    expect(new BrowserPolicyStore(dir).fileState()).toBe('unsupported-version');
    writeFileSync(primary(), JSON.stringify({ version: 1, epoch: 1, panes: { [PANE]: { paneId: PANE } } }));
    expect(new BrowserPolicyStore(dir).fileState()).toBe('corrupt');
  });

  it('a rebind keeps protection on and refuses every host until confirmed again', async () => {
    const store = new BrowserPolicyStore(dir);
    await store.write(payload(), PROFILE, true);
    await store.onPaneRebind(PANE);
    const d = store.decisionFor(PANE, WS, 'pb');
    expect(d).toMatchObject({ kind: 'protected', confirmed: false, hosts: { mode: 'allowlist', allow: [] } });
    // Even back on the original profile, the pending confirmation holds.
    expect(store.decisionFor(PANE, WS, PROFILE)).toMatchObject({ confirmed: false });
    await store.write(payload({ profileId: 'pb', expectedEpoch: store.epoch() }), 'pb', true);
    expect(store.decisionFor(PANE, WS, 'pb')).toMatchObject({ confirmed: true });
  });

  it('a profile mismatch alone (no rebind event) is deny-all', async () => {
    const store = new BrowserPolicyStore(dir);
    await store.write(payload(), PROFILE, true);
    expect(store.decisionFor(PANE, WS, 'someone-else')).toMatchObject({ kind: 'protected', confirmed: false });
  });

  it('reconcile drops a closed pane and moves a moved pane’s history, deny-all until confirmed', async () => {
    const store = new BrowserPolicyStore(dir);
    await store.write(payload(), PROFILE, true);
    await store.write(payload({ paneId: 'pane-2', expectedEpoch: 1 }), PROFILE, true);
    await store.reconcilePanes(new Set([PANE]), new Map([[PANE, 'ws-2']]));
    expect(JSON.parse(readFileSync(history(), 'utf8'))).toEqual({ panes: { [PANE]: 'ws-2' } });
    expect(store.decisionFor('pane-2', WS, PROFILE)).toEqual({ kind: 'legacy' });
    expect(store.decisionFor(PANE, 'ws-2', PROFILE)).toMatchObject({ kind: 'protected', confirmed: false });
    expect(store.workspaceHasHistory('ws-2')).toBe(true);
  });

  it('profileDecision follows the pane bound to the profile', async () => {
    const store = new BrowserPolicyStore(dir);
    const lookup = { paneBindings: () => ({ [PANE]: { workspaceId: WS, profile: PROFILE } }) };
    expect(store.profileDecision(PROFILE, lookup)).toEqual({ kind: 'legacy' });
    await store.write(payload(), PROFILE, true);
    expect(store.profileDecision(PROFILE, lookup)).toMatchObject({ kind: 'protected', confirmed: true });
    expect(store.profileDecision('other', lookup)).toEqual({ kind: 'legacy' });
  });
});
