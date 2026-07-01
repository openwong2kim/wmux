import { describe, it, expect } from 'vitest';
import {
  classifyTasklistOutput,
  classifyKillOutcome,
  lockOwnerIsReclaimable,
} from '../processLiveness';

describe('processLiveness — classifiers (shared contract)', () => {
  it('reads a FAILED tasklist probe (null) as unknown, never dead (Defect-1)', () => {
    expect(classifyTasklistOutput(1234, null)).toBe('unknown');
  });
  it('reads an authoritative listing without the PID as dead', () => {
    expect(classifyTasklistOutput(1234, '')).toBe('dead');
    expect(classifyTasklistOutput(1234, '"other.exe","9999","Console","1","10 K"\r\n')).toBe('dead');
  });
  it('reads a present PID as alive', () => {
    expect(classifyTasklistOutput(1234, '"node.exe","1234","Console","1","50,000 K"\r\n')).toBe('alive');
  });
  it('maps POSIX kill outcomes: none→alive, ESRCH→dead, EPERM→alive, else→unknown', () => {
    expect(classifyKillOutcome(undefined)).toBe('alive');
    expect(classifyKillOutcome('ESRCH')).toBe('dead');
    expect(classifyKillOutcome('EPERM')).toBe('alive');
    expect(classifyKillOutcome('ETIMEDOUT')).toBe('unknown');
    expect(classifyKillOutcome('EINVAL')).toBe('unknown');
  });
});

describe('lockOwnerIsReclaimable — Defect-1 lock-staleness decision', () => {
  it('reclaims ONLY a confirmed-dead owner', () => {
    expect(lockOwnerIsReclaimable('dead')).toBe(true);
  });
  it('never reclaims a live owner', () => {
    expect(lockOwnerIsReclaimable('alive')).toBe(false);
  });
  it('never reclaims on an unknown (flaky) probe — the split-brain guard', () => {
    // The whole point: a tasklist timeout must NOT let a second daemon remove a
    // live daemon's lock. unknown → not reclaimable → acquireLock returns false
    // ("assume a live daemon holds it") rather than stomping the lock.
    expect(lockOwnerIsReclaimable('unknown')).toBe(false);
  });
});
