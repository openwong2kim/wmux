import { describe, expect, it } from 'vitest';
import { createNativeCircuit } from '../nativeCircuit';

const cooldowns = [100, 200, 400];

describe('the native snapshot circuit', () => {
  it('opens on a module error, stays open through its cooldown, then admits one trial', () => {
    const circuit = createNativeCircuit(cooldowns);
    expect(circuit.state('/m.cjs', 0)).toBe('closed');
    circuit.settle('/m.cjs', false, 0);
    expect(circuit.state('/m.cjs', 99)).toBe('open');
    expect(circuit.state('/m.cjs', 100)).toBe('half-open');
    circuit.beginTrial('/m.cjs');
    // One trial at a time: the next request skips until it settles.
    expect(circuit.state('/m.cjs', 150)).toBe('open');
    expect(circuit.isOpen('/m.cjs')).toBe(true);
  });

  it('closes when a trial finds the module working', () => {
    const circuit = createNativeCircuit(cooldowns);
    circuit.settle('/m.cjs', false, 0);
    circuit.beginTrial('/m.cjs');
    circuit.settle('/m.cjs', true, 100);
    expect(circuit.state('/m.cjs', 101)).toBe('closed');
    expect(circuit.failures('/m.cjs')).toBe(0);
  });

  it('reopens a failed trial with the next, longer cooldown, the last one repeating', () => {
    const circuit = createNativeCircuit(cooldowns);
    circuit.settle('/m.cjs', false, 0);
    for (const [at, wait] of [[100, 200], [300, 400], [700, 400]] as const) {
      expect(circuit.state('/m.cjs', at)).toBe('half-open');
      circuit.beginTrial('/m.cjs');
      circuit.settle('/m.cjs', false, at);
      expect(circuit.state('/m.cjs', at + wait - 1)).toBe('open');
      expect(circuit.state('/m.cjs', at + wait)).toBe('half-open');
    }
    expect(circuit.failures('/m.cjs')).toBe(4);
  });

  it('closes at once for another module path', () => {
    const circuit = createNativeCircuit(cooldowns);
    circuit.settle('/old.cjs', false, 0);
    expect(circuit.state('/new.cjs', 1)).toBe('closed');
    expect(circuit.isOpen('/old.cjs')).toBe(false);
  });

  it('counts a request that worked while closed as nothing to undo', () => {
    const circuit = createNativeCircuit(cooldowns);
    circuit.settle('/m.cjs', true, 0);
    expect(circuit.state('/m.cjs', 0)).toBe('closed');
  });
});
