import { describe, expect, it, vi } from 'vitest';
import { ActiveWorkPowerBlocker } from '../ActiveWorkPowerBlocker';

function harness(enabled = true) {
  const blocker = { start: vi.fn(() => 41), stop: vi.fn() };
  return { blocker, guard: new ActiveWorkPowerBlocker(blocker, enabled) };
}

describe('ActiveWorkPowerBlocker', () => {
  it('blocks for running commands and releases after the last command boundary', () => {
    const { blocker, guard } = harness();
    guard.promptBoundary('pane-a', 'command_start');
    guard.promptBoundary('pane-b', 'command_start');
    expect(blocker.start).toHaveBeenCalledOnce();
    expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    guard.promptBoundary('pane-a', 'command_end');
    expect(blocker.stop).not.toHaveBeenCalled();
    guard.promptBoundary('pane-b', 'prompt_start');
    expect(blocker.stop).toHaveBeenCalledWith(41);
  });

  it('hydrates active commands and exec workflows without counting idle shells', () => {
    const { blocker, guard } = harness();
    guard.replaceSessions([
      { id: 'idle', state: 'attached', commandRunning: false },
      { id: 'unknown', state: 'detached' },
      { id: 'dead', state: 'dead', commandRunning: true },
      // WSL Bash now emits the same OSC 133 state as native shells. This is
      // the incident regression: a live wsl.exe command must acquire power.
      { id: 'wsl-command', state: 'attached', commandRunning: true },
      { id: 'workflow', state: 'detached', exec: { command: 'npm test' } },
    ]);
    expect(blocker.start).toHaveBeenCalledOnce();
    guard.sessionEnded('wsl-command');
    expect(blocker.stop).not.toHaveBeenCalled();
    guard.sessionEnded('workflow');
    expect(blocker.stop).toHaveBeenCalledWith(41);
  });

  it('tracks exec workflows created after hydration', () => {
    const { blocker, guard } = harness();
    guard.sessionCreated('workflow', true);
    expect(blocker.start).toHaveBeenCalledOnce();
    guard.sessionEnded('workflow');
    expect(blocker.stop).toHaveBeenCalledOnce();
  });

  it('rejects an async hydration snapshot after a newer lifecycle event', () => {
    const { blocker, guard } = harness();
    const revision = guard.revision;
    guard.promptBoundary('pane-a', 'command_start');

    expect(guard.replaceSessionsIfUnchanged([], revision)).toBe(false);
    expect(blocker.stop).not.toHaveBeenCalled();
  });

  it('does nothing when disabled and disposes an active blocker', () => {
    const disabled = harness(false);
    disabled.guard.promptBoundary('pane-a', 'command_start');
    expect(disabled.blocker.start).not.toHaveBeenCalled();
    const active = harness();
    active.guard.promptBoundary('pane-a', 'command_start');
    active.guard.dispose();
    expect(active.blocker.stop).toHaveBeenCalledWith(41);
  });

  it('tracks local-mode OSC boundaries and releases when the PTY ends', () => {
    const { blocker, guard } = harness();
    guard.localPromptBoundary('local-pane', 'command_start');
    expect(blocker.start).toHaveBeenCalledOnce();
    guard.localSessionEnded('local-pane');
    expect(blocker.stop).toHaveBeenCalledWith(41);
  });

  it('keeps daemon work protected through reconnect, then expires without touching local work', () => {
    vi.useFakeTimers();
    try {
      const { blocker, guard } = harness();
      guard.promptBoundary('daemon-pane', 'command_start');
      guard.localPromptBoundary('local-pane', 'command_start');
      guard.beginDaemonReconnectGrace(30_000);

      vi.advanceTimersByTime(30_000);
      expect(blocker.stop).not.toHaveBeenCalled();
      guard.localSessionEnded('local-pane');
      expect(blocker.stop).toHaveBeenCalledWith(41);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles a reconnect snapshot before the grace expires', () => {
    vi.useFakeTimers();
    try {
      const { blocker, guard } = harness();
      guard.promptBoundary('old-pane', 'command_start');
      guard.beginDaemonReconnectGrace(30_000);
      guard.replaceSessions([
        { id: 'new-pane', state: 'attached', commandRunning: true },
      ]);
      vi.advanceTimersByTime(30_000);
      expect(blocker.stop).not.toHaveBeenCalled();
      guard.sessionEnded('new-pane');
      expect(blocker.stop).toHaveBeenCalledWith(41);
    } finally {
      vi.useRealTimers();
    }
  });
});
