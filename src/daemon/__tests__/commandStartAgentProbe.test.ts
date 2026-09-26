import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommandStartAgentProbe,
  COMMAND_RETRY_MS,
  COMMAND_SETTLE_MS,
  type CommandStartAgentProbeDeps,
} from '../commandStartAgentProbe';

function make(overrides: Partial<CommandStartAgentProbeDeps> = {}) {
  const probe = vi.fn();
  const p = new CommandStartAgentProbe({
    stillRunning: () => true,
    named: () => false,
    probe,
    ...overrides,
  });
  return { p, probe };
}

describe('CommandStartAgentProbe', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('probes a foreground command still running after the settle window', () => {
    const { p, probe } = make();
    p.onPromptEvent('s1', 'command_start');
    vi.advanceTimersByTime(COMMAND_SETTLE_MS - 1);
    expect(probe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(probe).toHaveBeenCalledWith('s1');
  });

  it('retries once for a slow starter, then stops', () => {
    const { p, probe } = make();
    p.onPromptEvent('s1', 'command_start');
    vi.advanceTimersByTime(COMMAND_SETTLE_MS + COMMAND_RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(COMMAND_RETRY_MS * 10);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('skips the retry once the pane is named, but not the first attempt', () => {
    // A pane can read as named because of an agent that just exited; the
    // first attempt is what notices that.
    const { p, probe } = make({ named: () => true });
    p.onPromptEvent('s1', 'command_start');
    vi.advanceTimersByTime(COMMAND_SETTLE_MS + COMMAND_RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('never probes a command that already returned to the prompt', () => {
    const { p, probe } = make();
    p.onPromptEvent('s1', 'command_start');
    p.onPromptEvent('s1', 'command_end');
    p.onPromptEvent('s1', 'prompt_start');
    vi.advanceTimersByTime((COMMAND_SETTLE_MS + COMMAND_RETRY_MS) * 2);
    expect(probe).not.toHaveBeenCalled();
  });

  it('cancels the pending retry when the command ends', () => {
    const { p, probe } = make();
    p.onPromptEvent('s1', 'command_start');
    vi.advanceTimersByTime(COMMAND_SETTLE_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    p.onPromptEvent('s1', 'command_end');
    vi.advanceTimersByTime(COMMAND_RETRY_MS * 2);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-checks OSC 133 state when the window closes', () => {
    let running = true;
    const { p, probe } = make({ stillRunning: () => running });
    p.onPromptEvent('s1', 'command_start');
    running = false; // the marker was lost, but the log says the shell is back
    vi.advanceTimersByTime(COMMAND_SETTLE_MS + COMMAND_RETRY_MS);
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps one window per pane', () => {
    const { p, probe } = make();
    p.onPromptEvent('s1', 'command_start');
    p.onPromptEvent('s2', 'command_start');
    p.onPromptEvent('s1', 'command_end');
    vi.advanceTimersByTime(COMMAND_SETTLE_MS);
    expect(probe.mock.calls).toEqual([['s2']]);
  });
});
