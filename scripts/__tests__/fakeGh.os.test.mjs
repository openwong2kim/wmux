// scripts/factory-e2e/fake-gh.mjs as a subprocess: the argv shapes wmux main
// sends, read from and written to one state file, every call logged.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'factory-e2e', 'fake-gh.mjs');
const HEAD = 'a'.repeat(40);

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp9-fakegh-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    login: 'octo',
    repos: { 'github.com/acme/app': {
      prs: [{ number: 1, title: 'feat', state: 'OPEN', headSha: HEAD, headRefName: 'wtask/x', author: 'octo', labels: [], createdAt: '2026-10-12T00:00:00Z', checks: 'SUCCESS', requiredChecks: ['build'], files: ['a.ts'] }],
      issues: [{ number: 3, title: 'bug', state: 'OPEN', author: 'r', labels: ['bug'], createdAt: '2026-10-12T00:00:00Z' }],
    } },
  }));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function gh(...args) {
  const r = spawnSync(process.execPath, [FAKE, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, FACTORY_E2E_GH_STATE: path.join(dir, 'state.json'), FACTORY_E2E_GH_LOG: path.join(dir, 'log.jsonl') },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text answer */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}
const log = () => fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

describe('fake gh', () => {
  it('answers the repo watch query with the open PRs, their rollup and the open issues', () => {
    const r = gh('api', 'graphql', '--hostname', 'github.com', '-f', 'query=query { repository { open: pullRequests(states: OPEN) { nodes { number } } } }', '-f', 'owner=acme', '-f', 'repo=app');
    expect(r.code).toBe(0);
    expect(r.json.data.repository.open.nodes[0]).toMatchObject({ number: 1, headRefOid: HEAD, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } });
    expect(r.json.data.repository.issues.nodes.map((i) => i.number)).toEqual([3]);
  });

  it('answers the lane read with required checks, and the default-branch rollup', () => {
    const lane = gh('api', 'graphql', '--hostname', 'github.com', '-f', 'query=query { repository { pullRequest(number: $number) { number } } }', '-f', 'owner=acme', '-f', 'repo=app', '-F', 'number=1');
    expect(lane.json.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes).toEqual([expect.objectContaining({ name: 'build', isRequired: true, conclusion: 'SUCCESS' })]);
    const ci = gh('api', 'graphql', '-f', 'query=query { repository { defaultBranchRef { name } } }', '-f', 'owner=acme', '-f', 'repo=app');
    expect(ci.json.data.repository.defaultBranchRef.target.statusCheckRollup.state).toBe('SUCCESS');
  });

  it('lists and reads issues over REST, query string and all', () => {
    expect(gh('api', '--hostname', 'github.com', 'repos/acme/app/issues?state=open&per_page=100').json.map((i) => i.number)).toEqual([3]);
    expect(gh('api', 'repos/acme/app/issues/3').json).toMatchObject({ number: 3, state: 'open', user: { login: 'r' } });
    expect(gh('api', 'repos/acme/app/issues/9').code).toBe(1);
  });

  it('a boolean flag never swallows the positional after it; -R is --repo', () => {
    expect(gh('api', '--paginate', 'user').json).toMatchObject({ login: 'octo' });
    expect(gh('pr', 'view', '1', '-R', 'acme/app', '--json', 'number').json).toMatchObject({ number: 1, headRefOid: HEAD });
  });

  it('merges only at the expected head, then serves the PR merged', () => {
    expect(gh('pr', 'merge', '1', '--repo', 'github.com/acme/app', '--squash', `--match-head-commit=${'b'.repeat(40)}`).code).toBe(1);
    expect(state().repos['github.com/acme/app'].prs[0].state).toBe('OPEN');
    expect(gh('pr', 'merge', '1', '--repo', 'github.com/acme/app', '--squash', '--subject=x (#1)', `--match-head-commit=${HEAD}`).code).toBe(0);
    expect(state().repos['github.com/acme/app'].prs[0]).toMatchObject({ state: 'MERGED', mergedAt: expect.any(String) });
  });

  it('marks an open draft ready; an unknown number fails', () => {
    const s = state();
    s.repos['github.com/acme/app'].prs[0].isDraft = true;
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
    expect(gh('pr', 'view', '1', '--repo', 'github.com/acme/app', '--json', 'isDraft').json).toMatchObject({ isDraft: true });
    expect(gh('pr', 'ready', '1', '--repo', 'github.com/acme/app').code).toBe(0);
    expect(state().repos['github.com/acme/app'].prs[0].isDraft).toBe(false);
    expect(gh('pr', 'ready', '9', '--repo', 'github.com/acme/app').code).toBe(1);
  });

  it('an unknown command fails without a rate-limit message and is logged as unhandled', () => {
    const r = gh('release', 'list');
    expect(r.code).toBe(1);
    expect(r.err).not.toMatch(/rate limit/i);
    expect(log().at(-1)).toMatchObject({ argv: ['release', 'list'], handled: false, exit: 1 });
  });

  it('state-changing calls run one at a time: concurrent creates all land', async () => {
    const { spawn } = await import('node:child_process');
    const env = { ...process.env, FACTORY_E2E_GH_STATE: path.join(dir, 'state.json') };
    await Promise.all([2, 3, 4, 5, 6, 7].map((i) => new Promise((resolve) => {
      spawn(process.execPath, [FAKE, 'pr', 'create', '-R', 'acme/app', '--head', `b${i}`, '--title', `t${i}`], { cwd: dir, env, stdio: 'ignore' }).on('exit', resolve);
    })));
    expect(state().repos['github.com/acme/app'].prs).toHaveLength(7);
    expect(fs.existsSync(path.join(dir, 'state.json.lock'))).toBe(false);
  });

  it('a lock left by a process that is gone is taken over; a live holder\'s lock is never removed by another call', () => {
    fs.writeFileSync(path.join(dir, 'state.json.lock'), '2147483646');
    expect(gh('pr', 'create', '-R', 'acme/app', '--head', 'b9', '--title', 't9').code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'state.json.lock'))).toBe(false);
    // A read takes no lock and leaves another holder's lock in place.
    fs.writeFileSync(path.join(dir, 'state.json.lock'), String(process.pid));
    expect(gh('pr', 'view', '1', '-R', 'acme/app', '--json', 'number').code).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'state.json.lock'), 'utf8')).toBe(String(process.pid));
  });
});
