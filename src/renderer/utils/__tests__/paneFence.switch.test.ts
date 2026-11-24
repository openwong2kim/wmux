// @vitest-environment jsdom
//
// The pane menu's fence switch against main's answer, and a multi-line
// keybinding in an opted-in tab (utils/paneFence.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { __resetPaneFenceForTesting, refuseMultilineFencedKeybinding, setTabWorkerFence } from '../paneFence';

let setFence: ReturnType<typeof vi.fn>;

function surface() {
  const pane = useStore.getState().workspaces[0].rootPane;
  return pane.type === 'leaf' ? pane.surfaces[0] : undefined;
}

beforeEach(() => {
  __resetPaneFenceForTesting();
  setFence = vi.fn(async (_id: string, on: boolean) => on);
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { setFence } };
  const ws = createWorkspace('W1', 1);
  useStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id } as never);
  useStore.getState().addSurface(ws.rootPane.id, 'pty-1', 'zsh', '/w');
});

describe('the tab\'s fence switch', () => {
  it('stays on when main applies it', async () => {
    setTabWorkerFence(surface()!.id, 'pty-1', true, false);
    await vi.waitFor(() => expect(setFence).toHaveBeenCalled(), { timeout: 5_000 });
    await Promise.resolve();
    expect(surface()?.workerFence).toBe(true);
  });

  it('goes back when main answers another state or fails', async () => {
    setFence.mockResolvedValueOnce(false);
    setTabWorkerFence(surface()!.id, 'pty-1', true, false);
    await vi.waitFor(() => expect(surface()?.workerFence).toBeUndefined(), { timeout: 5_000 });
    setFence.mockRejectedValueOnce(new Error('no main'));
    setTabWorkerFence(surface()!.id, 'pty-1', true, false);
    await vi.waitFor(() => expect(surface()?.workerFence).toBeUndefined(), { timeout: 5_000 });
  });
});

describe('a multi-line keybinding in an opted-in tab', () => {
  it('is refused when a line starts an agent, at any command word', () => {
    const on = { workerFence: true };
    expect(refuseMultilineFencedKeybinding(on, 'pty-1', 'cd d\nclear; claude\n')).toBe(true);
    expect(refuseMultilineFencedKeybinding(on, 'pty-1', 'cd d && codex\n')).toBe(true);
    expect(refuseMultilineFencedKeybinding(on, 'pty-1', 'git status\necho claude\n')).toBe(false);
    expect(refuseMultilineFencedKeybinding({}, 'pty-1', 'claude\n')).toBe(false);
  });
});
