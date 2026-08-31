// #1129 — the close-destroys-the-remote-session policy. The walks it builds
// on are covered in shared/__tests__/paneUtils.test.ts; what is tested here is
// the POLICY: only an owned session is destroyed, a failure never rejects into
// the caller, and a missing bridge is a no-op rather than a crash.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  destroyRemoteSessions,
  destroySurfaceRemoteSession,
  destroyPaneTreeRemoteSessions,
  destroyWorkspaceRemoteSessions,
} from '../remoteSessionTeardown';
import type { PaneLeaf, Surface } from '../../../shared/types';

function remoteSurface(over: Partial<Surface> = {}): Surface {
  return {
    id: 's1',
    ptyId: '',
    title: '',
    shell: '',
    cwd: '',
    surfaceType: 'remote-terminal',
    remoteHostId: 'h1',
    remoteSessionId: 'web-1',
    remoteOwned: true,
    ...over,
  };
}

let sessionClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionClose = vi.fn().mockResolvedValue({ ok: true });
  (globalThis as unknown as { window: unknown }).window = { electronAPI: { remote: { sessionClose } } };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('destroySurfaceRemoteSession', () => {
  it('closes the session an owned remote tab points at', () => {
    destroySurfaceRemoteSession(remoteSurface());
    expect(sessionClose).toHaveBeenCalledWith('h1', 'web-1');
  });

  it('leaves a tab that only VIEWS somebody else\'s session alone', () => {
    destroySurfaceRemoteSession(remoteSurface({ remoteOwned: undefined }));
    expect(sessionClose).not.toHaveBeenCalled();
  });

  it('ignores a local terminal surface and an absent one', () => {
    destroySurfaceRemoteSession({ id: 's', ptyId: 'pty-1', title: '', shell: '', cwd: '' });
    destroySurfaceRemoteSession(undefined);
    expect(sessionClose).not.toHaveBeenCalled();
  });

  it('ignores an owned surface with no session pointer', () => {
    destroySurfaceRemoteSession(remoteSurface({ remoteSessionId: undefined }));
    expect(sessionClose).not.toHaveBeenCalled();
  });
});

describe('destroyPaneTreeRemoteSessions / destroyWorkspaceRemoteSessions', () => {
  const leaf: PaneLeaf = {
    id: 'leaf-1',
    type: 'leaf',
    activeSurfaceId: 's1',
    surfaces: [
      remoteSurface(),
      remoteSurface({ id: 's2', remoteSessionId: 'web-2', remoteOwned: undefined }),
    ],
  };

  it('closes every owned session under a pane subtree, and only those', () => {
    destroyPaneTreeRemoteSessions(leaf);
    expect(sessionClose).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledWith('h1', 'web-1');
  });

  it('reaches stashed panes at the workspace level', () => {
    const stashed: PaneLeaf = {
      id: 'leaf-x',
      type: 'leaf',
      activeSurfaceId: 'sx',
      surfaces: [remoteSurface({ id: 'sx', remoteSessionId: 'web-stashed' })],
    };
    destroyWorkspaceRemoteSessions({ rootPane: leaf, stashedPanes: [{ pane: stashed }] });
    expect(sessionClose.mock.calls).toEqual([['h1', 'web-1'], ['h1', 'web-stashed']]);
  });
});

// A source scan, in the style of useKeyboard.test.ts's shortcut checks: the
// leak in #1129 was not a broken helper, it was close paths that never called
// one. Rendering the whole Pane to prove that costs far more than it is worth,
// so this pins the wiring instead — a new close path that disposes PTYs and
// forgets the remote half is exactly the regression to catch.
describe('every explicit close path is wired to the teardown', () => {
  const cases: Array<[string, RegExp]> = [
    ['components/Pane/Pane.tsx', /destroySurfaceRemoteSession\(/],
    ['hooks/useKeyboard.ts', /destroySurfaceRemoteSession\(/],
    ['hooks/useKeyboard.ts', /destroyPaneTreeRemoteSessions\(/],
    ['hooks/useKeyboard.ts', /destroyWorkspaceRemoteSessions\(/],
    ['hooks/useRpcBridge.ts', /destroySurfaceRemoteSession\(/],
    ['hooks/useRpcBridge.ts', /destroyRemoteSessions\(/],
    ['components/Sidebar/Sidebar.tsx', /destroyWorkspaceRemoteSessions\(/],
    ['components/Settings/SettingsPanel.tsx', /destroyWorkspaceRemoteSessions\(/],
  ];

  it.each(cases)('%s calls %s', (relPath, pattern) => {
    const src = readFileSync(join(__dirname, '..', '..', relPath), 'utf8');
    expect(src).toMatch(pattern);
  });
});

describe('failure handling', () => {
  it('swallows a rejected close — the tab is already gone, there is nothing to report to', async () => {
    sessionClose.mockRejectedValue(new Error('host offline'));
    expect(() => destroyRemoteSessions([{ hostId: 'h1', sessionId: 'web-1' }])).not.toThrow();
    // Let the rejection settle; an unhandled one would fail the run.
    await Promise.resolve();
  });

  it('is a no-op when the preload bridge is absent', () => {
    (globalThis as unknown as { window: unknown }).window = {};
    expect(() => destroyRemoteSessions([{ hostId: 'h1', sessionId: 'web-1' }])).not.toThrow();
  });
});
