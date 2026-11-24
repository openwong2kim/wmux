import { describe, expect, it } from 'vitest';
import { createNativeCircuit } from '../nativeCircuit';

const cooldowns = [100, 200, 400];
const make = () => createNativeCircuit(cooldowns, 1000);

describe('the native snapshot circuit', () => {
  it('opens on a module error, skips through its cooldown, then admits one trial', () => {
    const circuit = make();
    circuit.settle(circuit.admit('/m.cjs', 0)!, false, 0);
    expect(circuit.admit('/m.cjs', 99)).toBeNull();
    const trial = circuit.admit('/m.cjs', 100);
    expect(trial).not.toBeNull();
    // One trial at a time: the next request skips until it settles.
    expect(circuit.admit('/m.cjs', 150)).toBeNull();
    expect(circuit.isOpen('/m.cjs', 150)).toBe(true);
  });

  it('closes when the trial finds the module working', () => {
    const circuit = make();
    circuit.settle(circuit.admit('/m.cjs', 0)!, false, 0);
    circuit.settle(circuit.admit('/m.cjs', 100)!, true, 120);
    expect(circuit.isOpen('/m.cjs', 121)).toBe(false);
    expect(circuit.failures('/m.cjs', 121)).toBe(0);
    expect(circuit.admit('/m.cjs', 121)).not.toBeNull();
  });

  it('reopens a failed trial with the next, longer cooldown, the last one repeating', () => {
    const circuit = make();
    circuit.settle(circuit.admit('/m.cjs', 0)!, false, 0);
    for (const [at, wait] of [[100, 200], [300, 400], [700, 400]] as const) {
      circuit.settle(circuit.admit('/m.cjs', at)!, false, at);
      expect(circuit.admit('/m.cjs', at + wait - 1)).toBeNull();
      expect(circuit.isOpen('/m.cjs', at + wait)).toBe(false);
    }
    expect(circuit.failures('/m.cjs', 700)).toBe(4);
  });

  it('lets only an attempt of the current generation change the state', () => {
    const circuit = make();
    // Two attempts admitted while closed both fail: one failure, not two.
    const a = circuit.admit('/m.cjs', 0)!;
    const b = circuit.admit('/m.cjs', 0)!;
    circuit.settle(a, false, 10);
    circuit.settle(b, false, 11);
    expect(circuit.failures('/m.cjs', 11)).toBe(1);
    // A late success from before the opening does not skip the cooldown.
    const c = circuit.admit('/m.cjs', 0);
    expect(c).toBeNull();
    circuit.settle(b, true, 20);
    expect(circuit.isOpen('/m.cjs', 20)).toBe(true);
    // Nor does an old failure end the trial or start a second one.
    const trial = circuit.admit('/m.cjs', 110)!;
    circuit.settle(a, false, 120);
    expect(circuit.admit('/m.cjs', 130)).toBeNull();
    circuit.settle(trial, true, 140);
    expect(circuit.isOpen('/m.cjs', 140)).toBe(false);
  });

  it('counts a trial that never settles as failed once its timeout passes', () => {
    const circuit = make();
    circuit.settle(circuit.admit('/m.cjs', 0)!, false, 0);
    const hung = circuit.admit('/m.cjs', 100)!;
    expect(circuit.isOpen('/m.cjs', 1099)).toBe(true);
    // A read once the timeout passed counts the hung trial before any request does.
    expect(circuit.failures('/m.cjs', 1099)).toBe(1);
    expect(circuit.failures('/m.cjs', 1100)).toBe(2);
    expect(circuit.isOpen('/m.cjs', 1100)).toBe(false);
    // Timed out at 1100: reopened with the second cooldown.
    expect(circuit.admit('/m.cjs', 1100)).toBeNull();
    expect(circuit.failures('/m.cjs', 1100)).toBe(2);
    expect(circuit.admit('/m.cjs', 1299)).toBeNull();
    expect(circuit.admit('/m.cjs', 1300)).not.toBeNull();
    // The hung attempt settling late changes nothing.
    circuit.settle(hung, true, 1400);
    expect(circuit.isOpen('/m.cjs', 1400)).toBe(true);
  });

  it('starts closed for another module path, and reading never changes the state', () => {
    const circuit = make();
    circuit.settle(circuit.admit('/old.cjs', 0)!, false, 0);
    // Diagnostics read under another path: the old circuit is untouched.
    expect(circuit.isOpen('/new.cjs', 1)).toBe(false);
    expect(circuit.failures('/new.cjs', 1)).toBe(0);
    expect(circuit.isOpen('/old.cjs', 1)).toBe(true);
    expect(circuit.failures('/old.cjs', 1)).toBe(1);
    // A request for the new path is admitted.
    expect(circuit.admit('/new.cjs', 2)).not.toBeNull();
    expect(circuit.isOpen('/old.cjs', 2)).toBe(false);
  });
});
