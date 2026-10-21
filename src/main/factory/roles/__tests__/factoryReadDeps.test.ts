// The bot reads pick the CLI by the repo key's host: gh for GitHub, glab for
// any other host (GitLab, self-managed included).
import { describe, expect, it, vi } from 'vitest';

const { gh, ghIssues, glab, glabIssues } = vi.hoisted(() => {
  const gh = {
    laneFacts: vi.fn(async () => ({ ok: true as const, value: 'gh-pr' })),
    watchGraphql: vi.fn(async () => ({ ok: false as const, code: 'error' as const, message: 'gh graphql' })),
  };
  const ghIssues = {
    listIssues: vi.fn(async () => ({ ok: true as const, issues: ['gh-issue'] })),
    issueDetail: vi.fn(async () => ({ ok: true as const, detail: 'gh-detail' })),
    signedInLogin: vi.fn(async () => 'gh-owner'),
  };
  const glab = {
    laneFacts: vi.fn(async () => ({ ok: true as const, value: 'glab-mr' })),
    defaultBranchCi: vi.fn(async () => ({ error: 'glab ci' })),
    connection: vi.fn(async () => ({ ok: true as const })),
    loginOnHost: vi.fn(async () => 'glab-owner'),
  };
  const glabIssues = {
    listIssues: vi.fn(async () => ({ ok: true as const, issues: ['glab-issue'] })),
    issueDetail: vi.fn(async () => ({ ok: true as const, detail: 'glab-detail' })),
  };
  return { gh, ghIssues, glab, glabIssues };
});

vi.mock('../../../github/GhPrReviewService', async (actual) => ({ ...(await actual<object>()), ghPrReviewService: gh }));
vi.mock('../../../github/GhIssueService', async (actual) => ({ ...(await actual<object>()), ghIssueService: ghIssues }));
vi.mock('../../../github/GlabPrService', async (actual) => ({ ...(await actual<object>()), glabPrService: glab }));
vi.mock('../../../github/GlabIssueService', async (actual) => ({ ...(await actual<object>()), glabIssueService: glabIssues }));

import { factoryReadDeps } from '../index';
import { signedInLogin } from '../../../github/hostLane';

const GL = 'gitlab.example.com/group/proj';
const GH = 'github.com/o/r';

describe('factoryReadDeps host switch', () => {
  it('a GitLab key reads merge requests, issues and CI with glab', async () => {
    const d = factoryReadDeps();
    expect(await d.readPr('/r', GL, 3)).toEqual({ ok: true, value: 'glab-mr' });
    expect(glab.laneFacts).toHaveBeenCalledWith('/r', GL, 3);
    expect(await d.listIssues('/r', { kind: 'all' }, GL)).toEqual({ ok: true, issues: ['glab-issue'] });
    expect(await d.issueDetail('/r', 4, GL)).toEqual({ ok: true, detail: 'glab-detail' });
    expect(glabIssues.issueDetail).toHaveBeenCalledWith('/r', 4, '', GL);
    expect(await d.ciRollup('/r', GL)).toEqual({ error: 'glab ci' });
    expect(gh.laneFacts).not.toHaveBeenCalled();
    expect(ghIssues.listIssues).not.toHaveBeenCalled();
    expect(gh.watchGraphql).not.toHaveBeenCalled();
  });

  it('a GitHub key stays on gh', async () => {
    const d = factoryReadDeps();
    expect(await d.readPr('/r', GH, 3)).toEqual({ ok: true, value: 'gh-pr' });
    expect(await d.listIssues('/r', { kind: 'all' }, GH)).toEqual({ ok: true, issues: ['gh-issue'] });
    expect(await d.issueDetail('/r', 4, GH)).toEqual({ ok: true, detail: 'gh-detail' });
    expect(await d.ciRollup('/r', GH)).toEqual({ error: 'gh graphql' });
    expect(await d.hostReady?.({ repoPath: '/r', repoKey: GH, workspaceId: 'ws-1' })).toBeNull();
    expect(glab.connection).not.toHaveBeenCalled();
  });
});

describe('owner login by host', () => {
  it('reads the owner with gh on GitHub and with glab on any other host', async () => {
    expect(await signedInLogin('github.com', '/r')).toBe('gh-owner');
    expect(ghIssues.signedInLogin).toHaveBeenCalledWith('github.com', '/r');
    expect(await signedInLogin('gitlab.example.com', '/r')).toBe('glab-owner');
    expect(glab.loginOnHost).toHaveBeenCalledWith('gitlab.example.com', '/r');
  });
});
