// #546 / #1036 — parseBootMarker is the launcher's whole safety predicate for
// "a live daemon claims to be booting", and (since #1041) also the predicate
// the boot-marker runtime test polls with. Its rejection set is therefore a
// contract two places rely on, and until now it had no direct test: the
// review round on #1041 justified the test-side poll by claiming equivalence
// with this function, so the claim gets pinned here rather than staying an
// assertion in a comment.
import { describe, it, expect } from 'vitest';
import { parseBootMarker } from '../daemonLauncherCore';

describe('#546 parseBootMarker — the boot-claim predicate', () => {
  const PID = 9052;

  it('accepts exactly a marker naming the expected PID', () => {
    expect(parseBootMarker('9052', PID)).toBe(true);
    // The daemon writes String(process.pid) with no newline, but a trailing
    // newline must not defeat the claim if that ever changes.
    expect(parseBootMarker('9052\n', PID)).toBe(true);
    expect(parseBootMarker('  9052  ', PID)).toBe(true);
  });

  it('rejects the create-then-write intermediate: the empty file', () => {
    // The #1036 flake: writeFileSync creates the file before writing it, and
    // a dense poll can read the empty middle state.
    expect(parseBootMarker('', PID)).toBe(false);
    expect(parseBootMarker('   ', PID)).toBe(false);
    expect(parseBootMarker(null, PID)).toBe(false);
  });

  it('rejects a torn read: a strict prefix of the PID parses but must not claim', () => {
    // "90" of "9052" — parseInt succeeds, so Number.isFinite alone would let
    // it through; only the equality with the verified PID refuses it. This is
    // the case the #1041 review round found the test-side poll still passing.
    expect(parseBootMarker('90', PID)).toBe(false);
    expect(parseBootMarker('905', PID)).toBe(false);
  });

  it('rejects a different live PID: a predecessor\'s leftover is not our claim', () => {
    expect(parseBootMarker('1234', PID)).toBe(false);
  });

  it('rejects garbage without throwing', () => {
    expect(parseBootMarker('not-a-pid', PID)).toBe(false);
    expect(parseBootMarker('NaN', PID)).toBe(false);
    expect(parseBootMarker('Infinity', PID)).toBe(false);
  });
});
