import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandStartAgentProbe, COMMAND_SETTLE_MS } from '../commandStartAgentProbe';

describe('CommandStartAgentProbe', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('probes a foreground command still running after the settle window', () => {
    const probe = vi.fn();
    const p = new CommandStartAgentProbe({ stillRunning: () => true, probe });
    p.onPromptEvent('s1', 'command_start');
    vi.advanceTimersByTime(COMMAND_SETTLE_MS - 1);
    expect(probe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(probe).toHaveBeenCalledWith('s1');
  });

  it('never probes a command that already returned to the prompt', () => {
    const probe = vi.fn();
    const p = new CommandStartAgentProbe({ stillRunning: () => true, probe });
    p.onPromptEvent('s1', 'command_start');
    p.onPromptEvent('s1', 'command_end');
    p.onPromptEvent('s1', 'prompt_start');
    vi.advanceTimersByTime(COMMAND_SETTLE_MS * 2);
    expect(probe).not.toHaveBeenCalled();
  });

  it('re-checks OSC 133 state when the window closes', () => {
    const probe = vi.fn();
    let running = true;
    const p = new CommandStartAgentProbe({ stillRunning: () => running, probe });
    p.onPromptEvent('s1', 'command_start');
    running = false; // the marker was lost, but the log says the shell is back
    vi.advanceTimersByTime(COMMAND_SETTLE_MS);
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps one window per pane', () => {
    const probe = vi.fn();
    const p = new CommandStartAgentProbe({ stillRunning: () => true, probe });
    p.onPromptEvent('s1', 'command_start');
    p.onPromptEvent('s2', 'command_start');
    p.onPromptEvent('s1', 'command_end');
    vi.advanceTimersByTime(COMMAND_SETTLE_MS);
    expect(probe.mock.calls).toEqual([['s2']]);
  });
});
