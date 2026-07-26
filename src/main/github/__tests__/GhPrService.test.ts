// GhPrService — gh JSON mapping, gate, TTL, updatedAt detail cache (exec mocking,
// PrStatusCache test style). + PrProvider remote host classification.
import { describe, it, expect, vi } from 'vitest';
import { GhPrService, mapGhListItem, mapGhDetail } from '../GhPrService';
import { parseRemoteHost, isGithubHost, repoCacheKey } from '../PrProvider';
import { hostCommandTarget } from '../../git/paneCommand';
import { PR_COMMENT_BODY_CAP } from '../../../shared/prSurface';

type ExecCall = { cmd: string; args: string[] };

function makeService(
  handler: (args: string[]) => { stdout: string } | Error,
  nowRef: { t: number } = { t: 1000 },
) {
  const calls: ExecCall[] = [];
  const exec = vi.fn(async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const r = handler(args);
    if (r instanceof Error) throw r;
    return r;
  });
  const svc = new GhPrService(() => nowRef.t, exec as never);
  return { svc, calls, nowRef };
}

const LIST_JSON = JSON.stringify([
  {
    number: 423,
    title: 'feat(diff): workspace git diff view',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'openwong2kim' },
    headRefName: 'feat/workspace-diff-surface',
    updatedAt: '2026-07-12T15:00:00Z',
    url: 'https://github.com/o/r/pull/423',
    reviewDecision: 'REVIEW_REQUIRED',
    mergeable: 'CONFLICTING',
    statusCheckRollup: [
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'IN_PROGRESS', conclusion: '' },
    ],
  },
  {
    number: 1,
    title: 'old',
    state: 'MERGED',
    url: 'https://github.com/o/r/pull/1',
    statusCheckRollup: [{ conclusion: 'FAILURE' }],
  },
  { title: 'malformed — no number', url: 'https://x' },
]);

describe('mapGhListItem / mapGhDetail — mapping contract', () => {
  it('maps state·draft·checks·reviewDecision, malformed is null', () => {
    const arr = JSON.parse(LIST_JSON) as Parameters<typeof mapGhListItem>[0][];
    const a = mapGhListItem(arr[0])!;
    expect(a).toMatchObject({
      number: 423,
      state: 'open',
      author: 'openwong2kim',
      reviewDecision: 'REVIEW_REQUIRED',
      checks: 'pending', // IN_PROGRESS present so pending wins.
    });
    expect(a.mergeable).toBe('CONFLICTING'); // uppercased from the gh payload.
    expect(mapGhListItem(arr[1])!).toMatchObject({ state: 'merged', checks: 'failing', mergeable: '' });
    expect(mapGhListItem(arr[2])).toBeNull();
    expect(mapGhListItem({ number: 2, url: 'u', isDraft: true, state: 'OPEN' })!.state).toBe('draft');
    expect(mapGhListItem({ number: 3, url: 'u', statusCheckRollup: [] })!.checks).toBeNull();
  });

  it('comments+reviews as chronological single stream, body cap truncation marking', () => {
    const big = 'x'.repeat(PR_COMMENT_BODY_CAP + 10);
    const out = mapGhDetail(
      {
        comments: [
          { author: { login: 'b' }, body: 'second', createdAt: '2026-07-12T02:00:00Z' },
          { author: { login: 'c' }, body: big, createdAt: '2026-07-12T03:00:00Z', url: 'cu' },
        ],
        reviews: [
          { author: { login: 'a' }, body: 'first review', state: 'APPROVED', submittedAt: '2026-07-12T01:00:00Z' },
          { author: { login: 'd' }, body: '', state: 'CHANGES_REQUESTED', submittedAt: '2026-07-12T04:00:00Z' },
        ],
      },
      'pr-url',
    );
    expect(out.map((c) => c.author)).toEqual(['a', 'b', 'c', 'd']);
    expect(out[0]).toMatchObject({ kind: 'review', reviewState: 'APPROVED', url: 'pr-url' });
    expect(out[2].truncated).toBe(true);
    expect(out[2].body.length).toBe(PR_COMMENT_BODY_CAP);
    expect(out[3]).toMatchObject({ kind: 'review', reviewState: 'CHANGES_REQUESTED', body: '' });
  });

  it('merges inline review comments (gh api) with file:line anchors (Codex P2)', () => {
    const out = mapGhDetail(
      { comments: [], reviews: [] },
      'pr-url',
      [
        { user: { login: 'rev' }, body: 'nit here', created_at: '2026-07-12T05:00:00Z', html_url: 'h', path: 'src/a.ts', line: 42 },
        { user: { login: 'rev2' }, body: 'no path', created_at: '2026-07-12T06:00:00Z' },
      ],
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ author: 'rev', kind: 'review', url: 'h' });
    expect(out[0].body).toBe('src/a.ts:42 — nit here');
    expect(out[1].body).toBe('no path'); // no anchor without path.
  });

  it('HTML comments (bot markers) stripped from body', () => {
    const out = mapGhDetail(
      {
        comments: [
          {
            author: { login: 'coderabbitai' },
            body: '<!-- auto-generated -->\nactual content\n<!-- entry_end -->',
            createdAt: 't',
          },
        ],
      },
      'u',
    );
    expect(out[0].body).toBe('actual content');
  });
});

describe('GhPrService — gate', () => {
  it('gh ENOENT → cli-missing, no reprobe for process lifetime', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    const { svc, calls } = makeService(() => enoent);
    expect((await svc.gate('D:/r')).ok).toBe(false);
    expect((await svc.gate('D:/r')).ok).toBe(false);
    expect(calls.length).toBe(1); // second gate doesn't call exec at all.
  });

  it('version OK + auth failure → unauthenticated', async () => {
    const { svc } = makeService((args) =>
      args[0] === '--version' ? { stdout: 'gh version 2' } : new Error('not logged in'),
    );
    const g = await svc.gate('D:/r');
    expect(g).toMatchObject({ ok: false, reason: 'unauthenticated' });
  });
});

describe('GhPrService — list TTL·detail updatedAt cache', () => {
  it('re-call within 30s skips exec, refetch after TTL', async () => {
    const nowRef = { t: 0 };
    const { svc, calls } = makeService((args) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: LIST_JSON };
      return { stdout: '' };
    }, nowRef);
    const r1 = await svc.listPrs('D:/r');
    expect(r1.ok && r1.prs.length).toBe(2); // 1 malformed filtered.
    await svc.listPrs('D:/r');
    expect(calls.filter((c) => c.args[1] === 'list').length).toBe(1);
    nowRef.t = 31_000;
    await svc.listPrs('D:/r');
    expect(calls.filter((c) => c.args[1] === 'list').length).toBe(2);
  });

  it('force=true re-invokes gh even inside TTL window (manual refresh, Codex P2)', async () => {
    const nowRef = { t: 0 };
    const { svc, calls } = makeService((args) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: LIST_JSON };
      return { stdout: '' };
    }, nowRef);
    await svc.listPrs('D:/r');
    await svc.listPrs('D:/r'); // TTL hit — no re-call.
    expect(calls.filter((c) => c.args[1] === 'list').length).toBe(1);
    await svc.listPrs('D:/r', true); // force — ignore TTL.
    expect(calls.filter((c) => c.args[1] === 'list').length).toBe(2);
  });

  it('detail — skips refetch when same updatedAt, refetches when changed', async () => {
    const { svc, calls } = makeService((args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return { stdout: JSON.stringify({ number: 423, url: 'u', comments: [{ author: { login: 'a' }, body: 'hi', createdAt: 't' }], reviews: [] }) };
      }
      return { stdout: '' };
    });
    const d1 = await svc.prDetail('D:/r', 423, 'T1');
    expect(d1.ok && d1.detail.comments.length).toBe(1);
    await svc.prDetail('D:/r', 423, 'T1'); // cache hit.
    expect(calls.filter((c) => c.args[1] === 'view').length).toBe(1);
    await svc.prDetail('D:/r', 423, 'T2'); // updatedAt changed → re-fetch.
    expect(calls.filter((c) => c.args[1] === 'view').length).toBe(2);
  });

  it('gh failure stderr demoted fail-soft', async () => {
    const { svc } = makeService(() => Object.assign(new Error('boom'), { stderr: 'no pull requests' }));
    const r = await svc.listPrs('D:/r');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('no pull requests');
  });

  // The Deck PR panel (github.handler → listPrs(repoPath, force)) and the pane
  // poller (PrReviewRouter → listPrs(cwd, false, target)) address the SAME repo
  // by two call shapes. Two keys means two gh subprocesses and two TTL windows.
  it('targeted and untargeted calls for one repo share a single cache entry', async () => {
    const { svc, calls } = makeService((args) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: LIST_JSON };
      return { stdout: '' };
    });
    await svc.listPrs('D:\\repo');
    await svc.listPrs('D:\\repo', false, hostCommandTarget('D:\\repo\\packages\\app'));
    // ...and path-spelling variance folds too, both with and without a target.
    await svc.listPrs('d:/repo/');
    await svc.listPrs('D:/Repo', false, hostCommandTarget('d:\\repo\\'));
    expect(calls.filter((c) => c.args[1] === 'list').length).toBe(1);
  });

  it('detail cache is shared between targeted and untargeted call shapes', async () => {
    const { svc, calls } = makeService((args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return { stdout: JSON.stringify({ number: 423, url: 'u', comments: [], reviews: [] }) };
      }
      return { stdout: '' };
    });
    await svc.prDetail('D:\\repo', 423, 'T1');
    await svc.prDetail('d:/repo/', 423, 'T1', hostCommandTarget('D:\\repo\\packages\\app'));
    expect(calls.filter((c) => c.args[1] === 'view').length).toBe(1);
  });

  it('isolates WSL distro caches and preserves structured argv/caps', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: LIST_JSON });
    const svc = new GhPrService(() => 0, exec);
    const ubuntu = {
      sessionId: 'pty-u',
      location: { domain: 'wsl' as const, cwd: '/repo with spaces/packages/app', shell: 'wsl.exe', distro: 'Ubuntu' },
      activeContext: { sessionId: 'pty-u', active: true as const, distro: 'Ubuntu' },
    };
    const ubuntuOtherPane = {
      sessionId: 'pty-u2',
      location: { domain: 'wsl' as const, cwd: '/repo with spaces/packages/other', shell: 'wsl.exe', distro: 'Ubuntu' },
      activeContext: { sessionId: 'pty-u2', active: true as const, distro: 'Ubuntu' },
    };
    const debian = {
      sessionId: 'pty-d',
      location: { domain: 'wsl' as const, cwd: '/repo with spaces', shell: 'wsl.exe', distro: 'Debian' },
      activeContext: { sessionId: 'pty-d', active: true as const, distro: 'Debian' },
    };
    await svc.listPrs('/repo with spaces', false, ubuntu);
    await svc.listPrs('/repo with spaces', false, ubuntuOtherPane);
    await svc.listPrs('/repo with spaces', false, debian);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledWith(
      'wsl.exe',
      expect.arrayContaining(['-d', 'Ubuntu', '--cd', '/repo with spaces/packages/app', '--exec']),
      expect.objectContaining({ timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }),
    );
  });

  it('keeps host and WSL cache identities isolated for the same repo path', () => {
    const wsl = {
      sessionId: 'pty-u',
      location: { domain: 'wsl' as const, cwd: '/repo/subdir', shell: 'wsl.exe', distro: 'Ubuntu' },
      activeContext: { sessionId: 'pty-u', active: true as const, distro: 'Ubuntu' },
    };
    expect(repoCacheKey('/repo', wsl)).not.toBe(repoCacheKey('/repo'));
  });

  it('fails soft without invoking wsl.exe for stale pane context', async () => {
    const exec = vi.fn();
    const svc = new GhPrService(() => 0, exec);
    const result = await svc.listPrs('/repo', false, {
      sessionId: 'pty-current',
      location: { domain: 'wsl', cwd: '/repo', shell: 'wsl.exe', distro: 'Ubuntu' },
      activeContext: { sessionId: 'pty-stale', active: true, distro: 'Ubuntu' },
    });
    expect(result.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('parseRemoteHost / isGithubHost — provider routing inputs', () => {
  it.each([
    ['https://github.com/o/r.git', 'github.com'],
    ['git@github.com:o/r.git', 'github.com'],
    ['ssh://git@github.com/o/r', 'github.com'],
    ['https://gitlab.com/o/r.git', 'gitlab.com'],
    ['git@gitlab.example.com:o/r.git', 'gitlab.example.com'],
    ['https://oauth2@gitlab.company.io/team/repo.git', 'gitlab.company.io'],
    ['', null],
  ])('%s → %s', (url, expected) => {
    expect(parseRemoteHost(url)).toBe(expected);
  });

  it('github.com family only uses gh path', () => {
    expect(isGithubHost('github.com')).toBe(true);
    expect(isGithubHost('gitlab.com')).toBe(false);
    expect(isGithubHost('gitlab.company.io')).toBe(false);
  });
});
