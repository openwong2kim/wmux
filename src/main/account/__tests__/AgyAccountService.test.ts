import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgyVault, AGY_ACTIVE_TARGET, agyBlobEmail, copyTarget, type AgyVaultBackend } from '../agyVault';
import { AgyAccountService, agyAccountQuotaPath, agyQuotaKey } from '../AgyAccountService';
import type { AgyAccountQuotaSnapshot } from '../../../shared/agyAccounts';

// Every sign-in has its own refresh token, so the default differs per account.
function blobFor(email: string, refresh = `r1:${email}`): Buffer {
  const idToken = ['h', Buffer.from(JSON.stringify({ email })).toString('base64url'), 's'].join('.');
  return Buffer.from(JSON.stringify({ token: { access_token: 'a', refresh_token: refresh }, auth_method: 'oauth', id_token: idToken }));
}

class FakeBackend implements AgyVaultBackend {
  readonly store = new Map<string, Buffer>();
  read(target: string): Buffer | null { return this.store.get(target) ?? null; }
  write(target: string, _user: string, blob: Buffer): boolean { this.store.set(target, Buffer.from(blob)); return true; }
  remove(target: string): boolean { return this.store.delete(target); }
}

const NOW = Date.parse('2026-10-02T12:00:00Z');
const LATER = '2026-10-02T15:00:00Z';

describe('agyVault', () => {
  it('reads the email claim and nothing else', () => {
    expect(agyBlobEmail(blobFor('A@X.com'))).toBe('a@x.com');
    expect(agyBlobEmail(Buffer.from('not json'))).toBeNull();
    expect(agyBlobEmail(null)).toBeNull();
  });

  it('captures the live sign-in before swapping, keeping refreshed tokens', () => {
    const b = new FakeBackend();
    const vault = new AgyVault(b);
    b.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('a@x.com'));
    vault.captureActive();
    b.write(copyTarget('b@x.com'), 'antigravity', blobFor('b@x.com'));
    // agy refreshed a's token in the live slot after the first capture.
    b.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('a@x.com', 'r2'));
    expect(vault.activate('b@x.com')).toBe('ok');
    expect(vault.activeEmail()).toBe('b@x.com');
    expect(JSON.parse(String(b.read(copyTarget('a@x.com')))).token.refresh_token).toBe('r2');
  });

  it('refuses to activate an account without a matching copy', () => {
    const b = new FakeBackend();
    b.write(copyTarget('b@x.com'), 'antigravity', blobFor('c@x.com'));
    expect(new AgyVault(b).activate('b@x.com')).toBe('no-copy');
  });

  it('never overwrites or deletes a live sign-in it could not copy', () => {
    const unreadable = Buffer.from('{"token":{}}'); // no id_token: no email to file the copy under
    const tooBig = blobFor('a@x.com', 'r'.repeat(3000)); // over the vault's blob limit
    for (const live of [unreadable, tooBig]) {
      const b = new FakeBackend();
      b.write(AGY_ACTIVE_TARGET, 'antigravity', live);
      b.write(copyTarget('b@x.com'), 'antigravity', blobFor('b@x.com'));
      const vault = new AgyVault(b);
      expect(vault.activate('b@x.com')).toBe('live-not-saved');
      expect(vault.signOutActive()).toBe(false);
      expect(b.read(AGY_ACTIVE_TARGET)?.equals(live)).toBe(true);
    }
  });

  it('refuses when the copy write fails', () => {
    const b = new FakeBackend();
    b.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('a@x.com'));
    b.write(copyTarget('b@x.com'), 'antigravity', blobFor('b@x.com'));
    const realWrite = b.write.bind(b);
    b.write = (target, user, blob) => (target === copyTarget('a@x.com') ? false : realWrite(target, user, blob));
    expect(new AgyVault(b).activate('b@x.com')).toBe('live-not-saved');
    expect(agyBlobEmail(b.read(AGY_ACTIVE_TARGET))).toBe('a@x.com');
  });
});

describe('AgyAccountService', () => {
  let dataDir: string;
  let backend: FakeBackend;
  let snapshots: Map<string, AgyAccountQuotaSnapshot>;
  let timers: Array<() => void>;

  const make = () => new AgyAccountService({
    vault: new AgyVault(backend),
    dataDir,
    now: () => NOW,
    readSnapshot: (email) => snapshots.get(email) ?? null,
    setTimer: (fn) => { timers.push(fn); return { cancel: () => undefined }; },
  });
  const quota = (fiveH: number): AgyAccountQuotaSnapshot => ({ quota: { 'gemini-5h': { remaining_fraction: fiveH, reset_time: LATER } } });

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-agy-accounts-'));
    backend = new FakeBackend();
    snapshots = new Map();
    timers = [];
  });
  afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  async function withAccounts(service: AgyAccountService, emails: string[]): Promise<void> {
    for (const e of emails) {
      backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor(e));
      await service.addCurrent();
    }
  }

  it('registers the current sign-in once and persists without secrets', async () => {
    const s = make();
    await withAccounts(s, ['a@x.com', 'a@x.com']);
    expect(s.snapshot().accounts.map((a) => a.email)).toEqual(['a@x.com']);
    const onDisk = fs.readFileSync(path.join(dataDir, 'agy-accounts.json'), 'utf8');
    expect(onDisk).not.toContain('refresh_token');
    expect(onDisk).not.toContain('id_token');
  });

  it('does not swap away from an unregistered sign-in it cannot copy, and blames no account', async () => {
    const s = make();
    await s.setAutoRotate(true);
    await withAccounts(s, ['a@x.com', 'b@x.com']);
    snapshots.set('a@x.com', quota(0.6));
    snapshots.set('b@x.com', quota(0.6));
    const unregistered = Buffer.from('{"token":{}}');
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', unregistered);

    expect(await s.prepareLaunch()).toEqual({ ok: true, account: null, switched: false });
    expect(backend.read(AGY_ACTIVE_TARGET)?.equals(unregistered)).toBe(true);
    expect(s.snapshot().accounts.every((a) => a.state !== 'needs-reauth')).toBe(true);
  });

  it('leaves a sign-in made outside wmux alone even with switching on', async () => {
    const s = make();
    await s.setAutoRotate(true);
    await withAccounts(s, ['a@x.com']);
    snapshots.set('a@x.com', quota(0.9));
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('z@x.com'));
    expect(await s.prepareLaunch()).toEqual({ ok: true, account: null, switched: false });
    expect(new AgyVault(backend).activeEmail()).toBe('z@x.com');
  });

  it('holds instead of using a registered active account that is out when the swap is refused', async () => {
    const s = make();
    await s.setAutoRotate(true);
    await withAccounts(s, ['b@x.com', 'a@x.com']); // a is live now
    snapshots.set('a@x.com', quota(0));
    snapshots.set('b@x.com', quota(0.6));
    const realWrite = backend.write.bind(backend);
    backend.write = (target, user, blob) => (target === copyTarget('a@x.com') ? false : realWrite(target, user, blob));

    // b still has quota, so the hold names the active account rather than claiming every account is out.
    expect(await s.prepareLaunch()).toMatchObject({ ok: false, reason: 'active-exhausted' });
    expect(agyBlobEmail(backend.read(AGY_ACTIVE_TARGET))).toBe('a@x.com');
  });

  it('keeps automatic switching off until the user turns it on', async () => {
    const s = make();
    expect(s.snapshot().autoRotate).toBe(false);
    await withAccounts(s, ['a@x.com', 'b@x.com']); // b is live now
    snapshots.set('b@x.com', quota(0.6));
    snapshots.set('a@x.com', quota(0.9));
    expect(await s.prepareLaunch()).toMatchObject({ ok: true, switched: false });
    expect(agyBlobEmail(backend.read(AGY_ACTIVE_TARGET))).toBe('b@x.com');
  });

  it('never switches away from an account the user picked by hand', async () => {
    const s = make();
    await s.setAutoRotate(true);
    await withAccounts(s, ['a@x.com', 'b@x.com']);
    snapshots.set('a@x.com', quota(0.3));
    snapshots.set('b@x.com', quota(0.9));
    const a = s.snapshot().accounts.find((r) => r.email === 'a@x.com')!;
    await s.activate(a.id); // "Use now"

    // a still has quota: the pick stays even though b has more.
    expect(await s.prepareLaunch()).toMatchObject({ ok: true, switched: false });
    // a runs out: held, not switched behind the user's back.
    snapshots.set('a@x.com', quota(0));
    expect(await s.prepareLaunch()).toMatchObject({ ok: false, reason: 'active-exhausted' });
    expect(agyBlobEmail(backend.read(AGY_ACTIVE_TARGET))).toBe('a@x.com');

    // Flipping the switch hands the choice back: now it switches.
    await s.setAutoRotate(false);
    await s.setAutoRotate(true);
    expect(await s.prepareLaunch()).toMatchObject({ ok: true, switched: true, account: { email: 'b@x.com' } });
  });

  it('lets a launch through unchanged with no accounts', async () => {
    expect(await make().prepareLaunch()).toEqual({ ok: true, account: null, switched: false });
  });

  it('switches to the account with quota before a launch', async () => {
    const s = make();
    await s.setAutoRotate(true);
    await withAccounts(s, ['a@x.com', 'b@x.com']); // b is live now
    snapshots.set('b@x.com', quota(0));
    snapshots.set('a@x.com', quota(0.6));
    const d = await s.prepareLaunch();
    expect(d).toMatchObject({ ok: true, switched: true, account: { email: 'a@x.com' } });
    expect(new AgyVault(backend).activeEmail()).toBe('a@x.com');
  });

  it('gates on the launched model family: spent third-party quota never holds Gemini', async () => {
    const s = make();
    await withAccounts(s, ['a@x.com']);
    snapshots.set('a@x.com', { quota: {
      'gemini-5h': { remaining_fraction: 0.9, reset_time: LATER },
      '3p-weekly': { remaining_fraction: 0, reset_time: LATER },
    } });
    expect(await s.prepareLaunch()).toMatchObject({ ok: true });
    expect(await s.prepareLaunch('3p')).toEqual({ ok: false, reason: 'all-exhausted', availableAtMs: Date.parse(LATER) });
  });

  it('holds the launch when every account is out, without swapping', async () => {
    const s = make();
    await withAccounts(s, ['a@x.com', 'b@x.com']);
    snapshots.set('a@x.com', quota(0));
    snapshots.set('b@x.com', quota(0.01));
    expect(await s.prepareLaunch()).toEqual({ ok: false, reason: 'all-exhausted', availableAtMs: Date.parse(LATER) });
    expect(new AgyVault(backend).activeEmail()).toBe('b@x.com');
  });

  it('never swaps with rotation off but still refuses an exhausted active account', async () => {
    const s = make();
    await withAccounts(s, ['a@x.com', 'b@x.com']);
    await s.setAutoRotate(false);
    snapshots.set('b@x.com', quota(0));
    snapshots.set('a@x.com', quota(1));
    expect((await s.prepareLaunch()).ok).toBe(false);
    expect(new AgyVault(backend).activeEmail()).toBe('b@x.com');
  });

  it('marks an account that lost its saved sign-in and moves on', async () => {
    const s = make();
    await s.setAutoRotate(true);
    await withAccounts(s, ['a@x.com', 'b@x.com', 'c@x.com']);
    snapshots.set('c@x.com', quota(0));
    snapshots.set('a@x.com', quota(0.9));
    snapshots.set('b@x.com', quota(0.5));
    backend.remove(copyTarget('a@x.com'));
    const d = await s.prepareLaunch();
    expect(d).toMatchObject({ ok: true, account: { email: 'b@x.com' } });
    expect(s.snapshot().accounts.find((a) => a.email === 'a@x.com')?.state).toBe('needs-reauth');
  });

  it('does not claim every account is out while another only needs signing in again', async () => {
    const s = make();
    await withAccounts(s, ['a@x.com', 'b@x.com']); // b is live; switching is off
    snapshots.set('a@x.com', quota(0.9));
    snapshots.set('b@x.com', quota(0));
    backend.remove(copyTarget('a@x.com'));
    await s.setAutoRotate(true);
    await s.prepareLaunch(); // a's lost copy marks it needs-reauth
    await s.setAutoRotate(false);
    expect(s.snapshot().accounts.find((r) => r.email === 'a@x.com')?.state).toBe('needs-reauth');
    expect(await s.prepareLaunch()).toMatchObject({ ok: false, reason: 'active-exhausted' });
  });

  it('clears needs-reauth once the active account is signed in again outside wmux', async () => {
    const s = make();
    await withAccounts(s, ['a@x.com', 'b@x.com']); // b is live
    backend.remove(copyTarget('a@x.com'));
    await expect(s.activate(s.snapshot().accounts.find((a) => a.email === 'a@x.com')?.id ?? '')).rejects.toMatchObject({ code: 'swap-failed' });
    expect(s.snapshot().accounts.find((a) => a.email === 'a@x.com')?.state).toBe('needs-reauth');
    // The user signs in to a with agy itself; a has quota.
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('a@x.com', 'r-fresh'));
    snapshots.set('a@x.com', quota(0.8));
    expect(await s.prepareLaunch()).toMatchObject({ ok: true, switched: false, account: { email: 'a@x.com', state: 'active' } });
    expect(s.snapshot().accounts.find((a) => a.email === 'a@x.com')?.state).toBe('active');
  });

  it('never reports an active account that needs signing in again as out of quota', async () => {
    const s = make();
    await withAccounts(s, ['a@x.com', 'b@x.com']); // b is live
    backend.remove(copyTarget('a@x.com'));
    await expect(s.activate(s.snapshot().accounts.find((a) => a.email === 'a@x.com')?.id ?? '')).rejects.toBeTruthy();
    // a is live again, but its sign-in is over the vault limit, so no copy can confirm it.
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('a@x.com', 'r'.repeat(3000)));
    expect(await s.prepareLaunch()).toMatchObject({ ok: true, switched: false, account: { email: 'a@x.com', state: 'needs-reauth' } });
  });

  it('sign-in flow: saves the live account, signs out, registers the new one', async () => {
    const s = make();
    await withAccounts(s, ['a@x.com']);
    const state = await s.beginLogin();
    expect(state).toMatchObject({ pending: true, previousEmail: 'a@x.com' });
    expect(backend.read(AGY_ACTIVE_TARGET)).toBeNull();
    expect(backend.read(copyTarget('a@x.com'))).not.toBeNull();
    // Launches during sign-in are not gated (the sign-in pane runs agy).
    expect(await s.prepareLaunch()).toEqual({ ok: true, account: null, switched: false });
    await s.pollLogin();
    expect(s.loginState().pending).toBe(true);
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('b@x.com'));
    await s.pollLogin();
    expect(s.loginState()).toMatchObject({ pending: false, lastResult: 'b@x.com' });
    expect(s.snapshot().accounts.map((a) => a.email).sort()).toEqual(['a@x.com', 'b@x.com']);
  });

  it('cancelling a sign-in restores the previous account', async () => {
    const s = make();
    await withAccounts(s, ['a@x.com']);
    await s.beginLogin();
    await s.cancelLogin();
    expect(new AgyVault(backend).activeEmail()).toBe('a@x.com');
  });

  it('remove drops the vault copy but leaves the live sign-in', async () => {
    const s = make();
    await withAccounts(s, ['a@x.com']);
    await s.remove(s.snapshot().accounts[0].id);
    expect(backend.read(copyTarget('a@x.com'))).toBeNull();
    expect(new AgyVault(backend).activeEmail()).toBe('a@x.com');
  });

  it('reports unsupported without a vault and never gates', async () => {
    const s = new AgyAccountService({ vault: null, dataDir });
    expect(s.snapshot().supported).toBe(false);
    expect(await s.prepareLaunch()).toEqual({ ok: true, account: null, switched: false });
    await expect(s.addCurrent()).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('quota key matches the sensor file layout', () => {
    expect(agyQuotaKey(' A@X.com ')).toBe(agyQuotaKey('a@x.com'));
    expect(agyQuotaKey('a@x.com')).toMatch(/^[0-9a-f]{16}$/);
    expect(agyAccountQuotaPath('a@x.com', '/h')).toBe(path.join('/h', '.wmux', 'quota', 'agy-accounts', `${agyQuotaKey('a@x.com')}.json`));
  });
});

describe('AgyAccountService — self-healing signals', () => {
  let dataDir: string;
  let backend: FakeBackend;
  let snapshots: Map<string, AgyAccountQuotaSnapshot>;
  let clock: number;

  const make = () => new AgyAccountService({
    vault: new AgyVault(backend),
    dataDir,
    now: () => clock,
    readSnapshot: (email) => snapshots.get(email) ?? null,
    setTimer: () => ({ cancel: () => undefined }),
  });

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-agy-heal-'));
    backend = new FakeBackend();
    snapshots = new Map();
    clock = NOW;
  });
  afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('cancelling a sign-in says so when the previous account cannot be restored', async () => {
    const s = make();
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('a@x.com'));
    await s.addCurrent();
    await s.beginLogin();
    backend.remove(copyTarget('a@x.com')); // the saved copy is gone
    await s.cancelLogin();
    expect(s.loginState()).toMatchObject({ pending: false, restoreFailed: 'a@x.com' });

    // A later sign-in clears the notice.
    await s.beginLogin();
    expect(s.loginState().restoreFailed).toBeUndefined();
  });

  it('sign-in accepts the same account signed in again (new refresh token)', async () => {
    const s = make();
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('a@x.com', 'r1'));
    await s.addCurrent();
    await s.beginLogin();
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('a@x.com', 'r-new'));
    await s.pollLogin();
    expect(s.loginState()).toMatchObject({ pending: false, lastResult: 'a@x.com' });
    expect(agyBlobEmail(backend.read(AGY_ACTIVE_TARGET))).toBe('a@x.com');
  });

  it('sign-in ignores the previous account written back by a running session', async () => {
    const s = make();
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('a@x.com'));
    await s.addCurrent();
    await s.beginLogin();
    // A running session refreshes its access token; the refresh token stays the same.
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('a@x.com'));
    await s.pollLogin();
    expect(s.loginState().pending).toBe(true);
    expect(backend.read(AGY_ACTIVE_TARGET)).toBeNull();
    expect(JSON.parse(String(backend.read(copyTarget('a@x.com')))).token.refresh_token).toBe('r1:a@x.com');
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('b@x.com'));
    await s.pollLogin();
    expect(s.loginState()).toMatchObject({ pending: false, lastResult: 'b@x.com' });
  });

  it('sign-in ignores any saved account written back by a running session, not only the previous one', async () => {
    const s = make();
    for (const e of ['a@x.com', 'b@x.com']) {
      backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor(e));
      await s.addCurrent();
    }
    // Sessions on a and b are running; b is live. Start adding c.
    await s.beginLogin();
    // a's session refreshes its access token and writes a back into the slot.
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('a@x.com'));
    await s.pollLogin();
    expect(s.loginState()).toMatchObject({ pending: true, lastResult: null });
    expect(backend.read(AGY_ACTIVE_TARGET)).toBeNull();
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('c@x.com'));
    await s.pollLogin();
    expect(s.loginState()).toMatchObject({ pending: false, lastResult: 'c@x.com' });
    // c, not a, is pinned as the manual pick.
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'agy-accounts.json'), 'utf8')).manualEmail).toBe('c@x.com');
  });

  it('sign-in without a refresh token counts as new only for an account wmux did not know', async () => {
    const s = make();
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('a@x.com'));
    await s.addCurrent();
    await s.beginLogin();
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('a@x.com', ''));
    await s.pollLogin();
    expect(s.loginState().pending).toBe(true);
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('b@x.com', ''));
    await s.pollLogin();
    expect(s.loginState()).toMatchObject({ pending: false, lastResult: 'b@x.com' });
  });

  it('a sign-in that cannot be registered ends the watch without an unhandled rejection', async () => {
    const s = make();
    await s.beginLogin();
    // The new sign-in is over the vault's blob limit, so it cannot be saved.
    backend.write(AGY_ACTIVE_TARGET, 'antigravity', blobFor('c@x.com', 'r'.repeat(3000)));
    await expect(s.pollLogin()).resolves.toBeUndefined();
    expect(s.loginState()).toMatchObject({ pending: false, lastResult: 'c@x.com' });
  });
});
