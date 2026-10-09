import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GitWriteConfirmTokens, GitWriteReceipts, PHONE_GIT_WRITE_RECEIPTS_FILE, ghTokenFor, ghWriteEnv,
  type GitWriteBinding, type GhTokenRunner,
} from '../phoneGitWriteGate';
import { GIT_WRITE_CONFIRM_TTL_MS, GIT_WRITE_RECEIPT_TTL_MS } from '../../../shared/phoneGitWrite';

const OID = 'b'.repeat(40);
const binding: GitWriteBinding = { owner: 'device:a', sessionId: 's1', repo: '/r/.git', action: 'push', login: 'octo' };
const pins = { head: OID, ref: 'refs/heads/x', targetRef: 'refs/heads/x', remoteTip: null };

describe('confirm tokens', () => {
  it('is single use and expires after 90 s', () => {
    let now = 1_000;
    const tokens = new GitWriteConfirmTokens(() => now);
    const { confirmToken, expiresAt } = tokens.mint(binding, pins);
    expect(expiresAt).toBe(1_000 + GIT_WRITE_CONFIRM_TTL_MS);
    expect(tokens.consume(confirmToken, binding, { head: OID, ref: 'refs/heads/x' })).toEqual({ ok: true, pins });
    expect(tokens.consume(confirmToken, binding, { head: OID, ref: 'refs/heads/x' })).toEqual({ ok: false, error: 'confirm-required' });
    const late = tokens.mint(binding, pins).confirmToken;
    now += GIT_WRITE_CONFIRM_TTL_MS;
    expect(tokens.consume(late, binding, { head: OID })).toEqual({ ok: false, error: 'confirm-required' });
  });

  it('is bound to session, repo, action, login and the pinned values', () => {
    const tokens = new GitWriteConfirmTokens();
    const use = (b: Partial<GitWriteBinding>, bodyPins: Record<string, string> = { head: OID }) =>
      tokens.consume(tokens.mint(binding, pins).confirmToken, { ...binding, ...b }, bodyPins);
    expect(use({ sessionId: 's2' })).toEqual({ ok: false, error: 'confirm-required' });
    expect(use({ repo: '/other/.git' })).toEqual({ ok: false, error: 'confirm-required' });
    expect(use({ action: 'pr.merge' })).toEqual({ ok: false, error: 'confirm-required' });
    expect(use({ login: 'someone-else' })).toEqual({ ok: false, error: 'identity-changed' });
    expect(use({}, { head: 'c'.repeat(40) })).toEqual({ ok: false, error: 'stale', pins });
  });

  it('leaves a token alone when another owner presents it', () => {
    const tokens = new GitWriteConfirmTokens();
    const { confirmToken } = tokens.mint(binding, pins);
    expect(tokens.consume(confirmToken, { ...binding, owner: 'device:b' }, { head: OID })).toEqual({ ok: false, error: 'confirm-required' });
    expect(tokens.consume(confirmToken, binding, { head: OID }).ok).toBe(true);
  });
});

describe('receipts', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-git-write-receipts-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const row = { requestId: 'r', action: 'push' as const, sessionId: 's1', owner: 'device:a', fingerprint: 'f'.repeat(64) };

  it('persists across a restart: inFlight reads uncertain, pending reads refused, done stays', () => {
    let now = 5_000;
    const first = new GitWriteReceipts(dir, () => now);
    const [a, b, c] = ['a', 'b', 'c'].map((id) => GitWriteReceipts.key('device:a', '/r/.git', id));
    first.begin(a, { ...row, requestId: 'a' });
    first.begin(b, { ...row, requestId: 'b' });
    first.markInFlight(b);
    first.begin(c, { ...row, requestId: 'c' });
    first.markInFlight(c);
    first.settle(c, { state: 'done', fields: { pushed: OID, target: 'refs/heads/x' } });
    // The settle is coalesced onto the next tick; the restart below happens after it.
    return new Promise<void>((resolve) => setImmediate(() => {
      const second = new GitWriteReceipts(dir, () => now);
      expect(second.available).toBe(true);
      expect(second.find(a)).toMatchObject({ state: 'refused', error: 'confirm-required' });
      expect(second.find(b)).toMatchObject({ state: 'uncertain', startedAt: 5_000 });
      expect(second.find(c)).toMatchObject({ state: 'done', fields: { pushed: OID } });
      // Never re-run: an uncertain row settles only from a read.
      expect(second.uncertain('push').map((u) => u.key)).toEqual([b]);
      now += GIT_WRITE_RECEIPT_TTL_MS;
      expect(second.find(c)).toBeNull();
      resolve();
    }));
  });

  it('fails closed on a file it cannot read', () => {
    fs.writeFileSync(path.join(dir, PHONE_GIT_WRITE_RECEIPTS_FILE), '{truncated');
    const store = new GitWriteReceipts(dir);
    expect(store.available).toBe(false);
    expect(() => store.begin('k'.repeat(64), row)).toThrow();
  });
});

describe('gh identity', () => {
  it('asks gh for the login token with every inherited credential removed', async () => {
    let seen: { args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
    const run: GhTokenRunner = async (args, env) => { seen = { args, env }; return { ok: true, stdout: 'gho_login\n' }; };
    const result = await ghTokenFor('octo', run, { PATH: '/bin', GH_TOKEN: 'inherited', GITHUB_TOKEN: 'inherited2' });
    expect(result).toEqual({ ok: true, token: 'gho_login' });
    expect(seen?.args).toEqual(['auth', 'token', '--hostname', 'github.com', '--user', 'octo']);
    expect(seen?.env.GH_TOKEN).toBeUndefined();
    expect(seen?.env.GITHUB_TOKEN).toBeUndefined();
    expect(await ghTokenFor('octo', async () => ({ ok: false, ran: true }))).toEqual({ ok: false, reason: 'missing' });
    expect(await ghTokenFor('octo', async () => ({ ok: false, ran: false }))).toEqual({ ok: false, reason: 'unavailable' });
    expect(await ghTokenFor('bad login', run)).toEqual({ ok: false, reason: 'missing' });
  });

  it('overrides an inherited GH_TOKEN for the write', () => {
    const env = ghWriteEnv({ PATH: '/bin', GH_TOKEN: 'inherited', GITHUB_TOKEN: 'inherited2' }, 'gho_login');
    expect(env).toMatchObject({ PATH: '/bin', GH_TOKEN: 'gho_login', GH_HOST: 'github.com' });
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });
});
