import { describe, expect, it } from 'vitest';
import { foregroundFromProcStat, foregroundFromPs, processHoldsForeground } from '../agentForeground';

describe('processHoldsForeground', () => {
  it('reads pgrp and tpgid from /proc/<pid>/stat, a command name with spaces and parentheses included', () => {
    expect(foregroundFromProcStat('4242 (claude) S 4100 4242 4100 34817 4242 4194560 0 0')).toBe(true);
    // Stopped with Ctrl+Z: the shell's group took the terminal back.
    expect(foregroundFromProcStat('4242 (claude) T 4100 4242 4100 34817 4100 4194560 0 0')).toBe(false);
    expect(foregroundFromProcStat('4242 (node (my agent)) S 4100 4242 4100 34817 4242 0')).toBe(true);
    expect(foregroundFromProcStat('4242 claude S 4100 4242 4100 34817 4242 0')).toBeUndefined();
    expect(foregroundFromProcStat('4242 (claude) S 4100 4242 4100 0 -1 0')).toBe(false);
    expect(foregroundFromProcStat('garbage')).toBeUndefined();
  });

  it('reads ps pgid and tpgid', () => {
    expect(foregroundFromPs(' 4242  4242\n')).toBe(true);
    expect(foregroundFromPs('4242 4100')).toBe(false);
    expect(foregroundFromPs('')).toBeUndefined();
  });

  it('has no answer where a console has no process groups, or for a bad pid', async () => {
    expect(await processHoldsForeground(1234, 'win32')).toBeUndefined();
    expect(await processHoldsForeground(0, 'darwin')).toBeUndefined();
  });
});
