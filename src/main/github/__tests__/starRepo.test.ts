import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

import { checkStarred, starRepo, type StarRepoDeps } from '../starRepo';
import type { GhApiOutcome } from '../../../shared/starPrompt';

function deps(over: Partial<StarRepoDeps> & { answer?: GhApiOutcome } = {}) {
  const gh = vi.fn<(args: string[]) => Promise<GhApiOutcome>>(async () => over.answer ?? { ok: true, stdout: 'HTTP/2.0 204 No Content\n' });
  const openExternal = vi.fn<(url: string) => Promise<void>>(async () => undefined);
  const d: StarRepoDeps = {
    ghReady: over.ghReady ?? (async () => true),
    gh: over.gh ?? gh,
    openExternal: over.openExternal ?? openExternal,
  };
  return { d, gh, openExternal };
}

describe('checkStarred', () => {
  it('makes no call at all while gh is missing or signed out', async () => {
    const { d, gh } = deps({ ghReady: async () => false });
    expect(await checkStarred(d)).toBe('unknown');
    expect(gh).not.toHaveBeenCalled();
  });

  it('treats a failing gate as signed out', async () => {
    const { d, gh } = deps({ ghReady: () => Promise.reject(new Error('boom')) });
    expect(await checkStarred(d)).toBe('unknown');
    expect(gh).not.toHaveBeenCalled();
  });

  it('asks GET /user/starred/openwong2kim/wmux and maps 204 / 404 / errors', async () => {
    const starred = deps({ answer: { ok: true, stdout: 'HTTP/2.0 204 No Content\n' } });
    expect(await checkStarred(starred.d)).toBe('starred');
    expect(starred.gh).toHaveBeenCalledWith(['api', '--include', '/user/starred/openwong2kim/wmux']);

    const notStarred = deps({ answer: { ok: false, stdout: 'HTTP/2.0 404 Not Found\n' } });
    expect(await checkStarred(notStarred.d)).toBe('not-starred');

    const broken = deps({ answer: { ok: false, stderr: 'context deadline exceeded' } });
    expect(await checkStarred(broken.d)).toBe('unknown');
  });
});

describe('starRepo', () => {
  it('stars with gh (PUT, 204) and opens nothing', async () => {
    const { d, gh, openExternal } = deps();
    expect(await starRepo(d)).toBe('starred');
    expect(gh).toHaveBeenCalledWith(['api', '--include', '--method', 'PUT', '/user/starred/openwong2kim/wmux']);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens the repository page when the gh call fails', async () => {
    const { d, openExternal } = deps({ answer: { ok: false, stderr: 'gh: Resource not accessible by integration (HTTP 403)' } });
    expect(await starRepo(d)).toBe('opened');
    expect(openExternal).toHaveBeenCalledWith('https://github.com/openwong2kim/wmux');
  });

  it('opens the repository page without calling gh when it is not signed in', async () => {
    const { d, gh, openExternal } = deps({ ghReady: async () => false });
    expect(await starRepo(d)).toBe('opened');
    expect(gh).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('fails when the browser cannot be opened either', async () => {
    const { d } = deps({ ghReady: async () => false, openExternal: () => Promise.reject(new Error('no browser')) });
    expect(await starRepo(d)).toBe('failed');
  });
});
