import { describe, it, expect } from 'vitest';
import { classifyTasklistOutput, classifyKillOutcome } from '../launcher';

// Step ① of the duplicate-daemon / split-brain fix
// (plans/duplicate-daemon-split-brain.md). The bug's upstream trigger
// (Defect 1) was a probe TIMEOUT being coerced to "dead", so ensureDaemon
// skipped ping/reuse and spawned a second daemon over the live one. These
// tests pin the three-state classification so a timeout can never again read
// as `dead`.

describe('classifyTasklistOutput (win32 liveness)', () => {
  it('null stdout (probe timeout / exec error) → unknown, never dead', () => {
    // This is the exact regression guard for Defect 1: a tasklist stall
    // under Defender/CPU pressure must be `unknown`, not `dead`.
    expect(classifyTasklistOutput(1234, null)).toBe('unknown');
  });

  it('stdout carrying the PID row → alive', () => {
    expect(
      classifyTasklistOutput(1234, '"node.exe","1234","Console","1","50,000 K"\r\n'),
    ).toBe('alive');
  });

  it('authoritative empty listing (exec ok, PID absent) → dead', () => {
    expect(classifyTasklistOutput(1234, '')).toBe('dead');
  });

  it('real tasklist absent-PID output (INFO line, no data row) → dead', () => {
    // What tasklist actually prints to stdout (exit 0) for an absent PID —
    // the realistic 'dead' input, distinct from the phantom empty string.
    expect(
      classifyTasklistOutput(
        1234,
        'INFO: No tasks are running which match the specified criteria.\r\n',
      ),
    ).toBe('dead');
  });

  it('listing for a different PID only → dead', () => {
    expect(
      classifyTasklistOutput(1234, '"other.exe","9999","Console","1","10,000 K"\r\n'),
    ).toBe('dead');
  });
});

describe('classifyKillOutcome (POSIX liveness)', () => {
  it('no error (signal delivered to a live process) → alive', () => {
    expect(classifyKillOutcome(undefined)).toBe('alive');
  });

  it('ESRCH (no such process) → dead', () => {
    expect(classifyKillOutcome('ESRCH')).toBe('dead');
  });

  it('EPERM (process exists but not permitted to signal) → alive', () => {
    expect(classifyKillOutcome('EPERM')).toBe('alive');
  });

  it('any other error (timeout, EINVAL, ...) → unknown', () => {
    expect(classifyKillOutcome('ETIMEDOUT')).toBe('unknown');
    expect(classifyKillOutcome('EINVAL')).toBe('unknown');
  });
});
