import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildGitEnv, createGitRunner } from '../../sessionDiff';
import { PhoneGitWriteGate } from '../../phoneGitWriteGate';
import { PhoneGitWriteRoutes, matchPhoneGitWriteRoute, type PhoneGitWriteHost } from '../../phoneGitWriteRoutes';
import { registerPhoneGitWriteAction } from '../../phoneGitWriteRegistry';
import { createPhoneGitPrHandlers, type PrGhResult, type PrGhRunner } from '../../phoneGitPr';

/**
 * pr.create and pr.merge behind the real gate, tokens and receipts: a resend
 * after a lost response gets the stored receipt and runs nothing twice. The
 * host is a stub (no HTTP); gh is a fake.
 */

const HEAD = 'a'.repeat(40);
const SQUASH = 'c'.repeat(40);

describe('phone pr routes', { timeout: 30_000 }, () => {
  let root: string;
  let cwd: string;
  let gate: PhoneGitWriteGate;
  let routes: PhoneGitWriteRoutes;
  let calls: string[][];
  let merged: boolean;
  let prHead: string;
  let openPrs: unknown[];
  let unregister: Array<() => void>;

  const ok = (data: unknown): PrGhResult => ({ ok: true, stdout: JSON.stringify(data) });
  const gh: PrGhRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === 'pr' && args[1] === 'merge') { merged = true; return { ok: true, stdout: '' }; }
    if (args.includes('GET')) return ok(openPrs);
    if (args.includes('POST')) return ok({ number: 1981, html_url: 'https://github.com/octo/repo/pull/1981' });
    const query = args.find((a) => a.startsWith('query=')) ?? '';
    if (query.includes('squashMergeAllowed')) {
      return ok({ data: { repository: { squashMergeAllowed: true, pullRequest: {
        number: 1980, title: 'T', state: merged ? 'MERGED' : 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
        headRefOid: prHead, headRefName: 'feat/x', baseRefName: 'main', mergeCommit: merged ? { oid: SQUASH } : null,
        commits: { nodes: [] },
      } } } });
    }
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, env: buildGitEnv(), encoding: 'utf8' }).trim();
    return ok({ data: { repository: {
      defaultBranchRef: { name: 'main', compare: { aheadBy: 1 } }, headRef: { target: { oid: head } }, pullRequests: { nodes: [] },
    } } });
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phone-git-pr-routes-')));
    cwd = path.join(root, 'repo');
    fs.mkdirSync(cwd);
    const git = (...args: string[]) => execFileSync('git', args, { cwd, env: buildGitEnv(), encoding: 'utf8' });
    git('init', '-q', '-b', 'feat/x');
    git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'work');
    git('remote', 'add', 'origin', 'https://github.com/octo/repo.git');
    calls = [];
    merged = false;
    prHead = HEAD;
    openPrs = [];
    gate = new PhoneGitWriteGate({ wmuxDir: path.join(root, '.wmux'), ghToken: async () => ({ ok: true, stdout: 'gho_octo\n' }) });
    const h = createPhoneGitPrHandlers({ gh, git: createGitRunner() });
    unregister = [registerPhoneGitWriteAction('pr.create', h.create), registerPhoneGitWriteAction('pr.merge', h.merge)];
    const host: PhoneGitWriteHost = {
      ceiling: () => ({ allowGitWrite: true, login: 'octo' }),
      mayInput: () => true,
      explicitInputGrant: () => true,
      refuseInput: () => { throw new Error('unexpected'); },
      session: () => ({ spawnCwd: cwd }),
      stillAuthorized: async () => true,
      readJsonBody: (req, _res, onBody) => onBody((req as unknown as { body: unknown }).body),
      json: (res, status, body) => { (res as unknown as { out: Array<{ status: number; body: unknown }> }).out.push({ status, body }); },
      gate: () => gate,
      git: () => createGitRunner(),
      log: () => { /* silent */ },
    };
    routes = new PhoneGitWriteRoutes(host);
  });
  afterEach(() => {
    for (const u of unregister) u();
    gate.close();
    // A git child that a failed test left running still holds the directory on Windows.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** The first answer follows several real git spawns, which take seconds on a loaded Windows machine. */
  const WAIT = { timeout: 15_000 };

  /** One request; resolves with the first answer written. */
  const call = async (method: string, rest: string, body?: unknown) => {
    const res = { out: [] as Array<{ status: number; body: Record<string, unknown> }>, headersSent: false };
    const route = matchPhoneGitWriteRoute(method, rest)!;
    await routes.handle({ body } as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, route,
      new URL('http://127.0.0.1/'), { kind: 'device', deviceId: 'phone' });
    await vi.waitFor(() => expect(res.out.length).toBeGreaterThan(0), WAIT);
    return res.out[0];
  };
  const receipt = (rest: string) => vi.waitFor(async () => {
    const r = await call('GET', rest);
    expect(r.body.state).not.toMatch(/^(pending|inFlight)$/);
    return r;
  }, WAIT);

  it('advertises both actions once registered', () => {
    expect(routes.configKeys({ kind: 'device', deviceId: 'phone' })).toMatchObject({ gitPrCreate: true, gitPrMerge: { methods: ['squash'] } });
  });

  it('replays a resent pr.create and creates one PR', async () => {
    const body = { requestId: randomUUID(), title: 'Add the thing', body: '' };
    expect(await call('POST', 's1/git/pr', body)).toEqual({ status: 202, body: { requestId: body.requestId, replayed: false, state: 'pending' } });
    expect((await receipt(`s1/git/pr/receipts/${body.requestId}`)).body)
      .toEqual({ requestId: body.requestId, state: 'done', number: 1981, url: 'https://github.com/octo/repo/pull/1981' });
    expect(await call('POST', 's1/git/pr', body)).toEqual({
      status: 200, body: { requestId: body.requestId, replayed: true, state: 'done', number: 1981, url: 'https://github.com/octo/repo/pull/1981' },
    });
    expect(calls.filter((c) => c.includes('POST'))).toHaveLength(1);
    expect(await call('POST', 's1/git/pr', { ...body, title: 'Another' })).toEqual({ status: 409, body: { error: 'request-id-reused' } });
  });

  it('replays a resent merge after its token was spent and merges once', async () => {
    const preview = await call('POST', 's1/git/pr/1980/merge/preview', {});
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ number: 1980, headRefOid: HEAD, squashAllowed: true, block: null, identity: { login: 'octo' } });
    const body = { requestId: randomUUID(), confirmToken: preview.body.confirmToken, expectHead: HEAD, method: 'squash', subject: 'T (#1980)', body: '' };
    expect((await call('POST', 's1/git/pr/1980/merge', body)).status).toBe(202);
    expect((await receipt(`s1/git/pr/1980/merge/${body.requestId}`)).body).toEqual({ requestId: body.requestId, state: 'done', mergeCommitOid: SQUASH });
    expect(await call('POST', 's1/git/pr/1980/merge', body)).toEqual({
      status: 200, body: { requestId: body.requestId, replayed: true, state: 'done', mergeCommitOid: SQUASH },
    });
    expect(calls.filter((c) => c[0] === 'pr' && c[1] === 'merge')).toHaveLength(1);
  });

  it('puts the pr-exists number beside the tag in the receipt, as in the 409', async () => {
    openPrs = [{ number: 1977, title: 'Old', draft: false, created_at: '2026-10-01T00:00:00Z',
      html_url: 'https://github.com/octo/repo/pull/1977', base: { ref: 'main' }, head: { ref: 'feat/x', repo: { full_name: 'octo/repo' } } }];
    const body = { requestId: randomUUID(), title: 'Add the thing', body: '' };
    expect((await call('POST', 's1/git/pr', body)).status).toBe(202);
    expect((await receipt(`s1/git/pr/receipts/${body.requestId}`)).body)
      .toEqual({ requestId: body.requestId, state: 'refused', error: 'pr-exists', number: 1977 });
    expect(calls.filter((c) => c.includes('POST'))).toHaveLength(0);
  });

  it('puts the moved headRefOid beside stale in the receipt', async () => {
    const preview = await call('POST', 's1/git/pr/1980/merge/preview', {});
    prHead = 'b'.repeat(40);
    const body = { requestId: randomUUID(), confirmToken: preview.body.confirmToken, expectHead: HEAD, method: 'squash', subject: 'T (#1980)', body: '' };
    expect((await call('POST', 's1/git/pr/1980/merge', body)).status).toBe(202);
    expect((await receipt(`s1/git/pr/1980/merge/${body.requestId}`)).body)
      .toEqual({ requestId: body.requestId, state: 'refused', error: 'stale', headRefOid: prHead });
    expect(calls.filter((c) => c[0] === 'pr' && c[1] === 'merge')).toHaveLength(0);
  });
});
