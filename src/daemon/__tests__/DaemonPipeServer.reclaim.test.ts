import { describe, it, expect } from 'vitest';
import { classifyReclaimProbe } from '../DaemonPipeServer';

// Step ③ of the duplicate-daemon / split-brain fix
// (plans/duplicate-daemon-split-brain.md). Defect 3: when a freshly spawned
// second daemon hits EADDRINUSE on the canonical control pipe, the OLD probe
// folded "a live process owns it" and "the probe was inconclusive" into a
// single `false`, then fell back to a `-N` suffix — producing TWO live daemons.
// classifyReclaimProbe splits those cases so only a CONFIRMED live owner makes
// start() yield (fail-fast), while ambiguous probes keep the legacy retry.

describe('classifyReclaimProbe (Step ③ live-owner vs zombie)', () => {
  it('connect succeeded → live-owner (must NOT take the -N fallback)', () => {
    expect(classifyReclaimProbe('connect')).toBe('live-owner');
  });

  it('ECONNREFUSED → reclaimed (genuine zombie, probe released the handle)', () => {
    expect(classifyReclaimProbe('error', 'ECONNREFUSED')).toBe('reclaimed');
  });

  it('ECONNRESET → reclaimed', () => {
    expect(classifyReclaimProbe('error', 'ECONNRESET')).toBe('reclaimed');
  });

  it('EPIPE → reclaimed', () => {
    expect(classifyReclaimProbe('error', 'EPIPE')).toBe('reclaimed');
  });

  it('timeout → unreclaimable (ambiguous — do NOT claim a live owner)', () => {
    expect(classifyReclaimProbe('timeout')).toBe('unreclaimable');
  });

  it('an unexpected error code → unreclaimable, NOT live-owner', () => {
    // The split-brain-relevant guarantee: a weird probe error must not be
    // mistaken for a confirmed live owner (which would wrongly fail-fast),
    // nor for a reclaimable zombie (which would wrongly steal the pipe).
    expect(classifyReclaimProbe('error', 'EACCES')).toBe('unreclaimable');
    expect(classifyReclaimProbe('error', 'ETIMEDOUT')).toBe('unreclaimable');
  });

  it('an error with no code → unreclaimable', () => {
    expect(classifyReclaimProbe('error', undefined)).toBe('unreclaimable');
  });
});
