import { describe, it, expect, beforeEach } from 'vitest';
import { SignalLatencyMeter, MAX_BUFFER } from '../SignalLatencyMeter';

describe('SignalLatencyMeter', () => {
  let meter: SignalLatencyMeter;

  beforeEach(() => {
    meter = new SignalLatencyMeter();
  });

  describe('empty buffer', () => {
    it('reports nulls and zero count when no signals recorded', () => {
      const stats = meter.getStats();
      expect(stats.total).toBe(0);
      expect(stats.count).toBe(0);
      expect(stats.p50).toBeNull();
      expect(stats.p95).toBeNull();
      expect(stats.lastSignalAt).toBeNull();
      expect(stats.perAgent).toEqual({});
    });

    it('isStale() returns true with empty buffer regardless of threshold', () => {
      expect(meter.isStale(1000)).toBe(true);
      expect(meter.isStale(0)).toBe(true);
      expect(meter.isStale(Number.MAX_SAFE_INTEGER)).toBe(true);
    });
  });

  describe('single entry', () => {
    it('p50 === p95 === sole delta', () => {
      meter.recordSignal('claude', 1000, 1200);
      const stats = meter.getStats();
      expect(stats.count).toBe(1);
      expect(stats.total).toBe(1);
      expect(stats.p50).toBe(200);
      expect(stats.p95).toBe(200);
      expect(stats.lastSignalAt).toBe(1200);
      expect(stats.perAgent.claude).toBe(1);
    });

    it('clamps negative delta to 0 (clock skew protection)', () => {
      meter.recordSignal('claude', 5000, 4000);
      expect(meter.getStats().p50).toBe(0);
    });
  });

  describe('ring buffer eviction at MAX_BUFFER', () => {
    it('keeps lifetime total even after eviction', () => {
      for (let i = 0; i < MAX_BUFFER + 50; i++) {
        meter.recordSignal('claude', i, i + 10);
      }
      const stats = meter.getStats();
      expect(stats.total).toBe(MAX_BUFFER + 50);
      expect(stats.count).toBe(MAX_BUFFER);
    });

    it('lastSignalAt reflects the most recent entry after wraparound', () => {
      for (let i = 0; i < MAX_BUFFER + 10; i++) {
        meter.recordSignal('claude', i, i + 5);
      }
      const stats = meter.getStats();
      // Latest entry was i = MAX_BUFFER+9, so receiveTs = MAX_BUFFER+14.
      expect(stats.lastSignalAt).toBe(MAX_BUFFER + 14);
    });

    it('evicted entries no longer affect percentiles', () => {
      // First 50 entries with very high latency (10000ms).
      // Then MAX_BUFFER more with low latency (10ms). The high ones
      // should be evicted out.
      for (let i = 0; i < 50; i++) {
        meter.recordSignal('claude', 0, 10000);
      }
      for (let i = 0; i < MAX_BUFFER; i++) {
        meter.recordSignal('claude', i + 100000, i + 100010);
      }
      const stats = meter.getStats();
      expect(stats.count).toBe(MAX_BUFFER);
      // p95 should be ~10ms, NOT close to 10000.
      expect(stats.p95).toBeLessThan(50);
    });
  });

  describe('percentile correctness', () => {
    it('p50 is the median for an even-count buffer', () => {
      meter.recordSignal('claude', 0, 100);
      meter.recordSignal('claude', 0, 200);
      meter.recordSignal('claude', 0, 300);
      meter.recordSignal('claude', 0, 400);
      const stats = meter.getStats();
      // Linear interp at idx 1.5 of [100,200,300,400] = 250.
      expect(stats.p50).toBe(250);
    });

    it('p95 over many entries matches expected (linear interp)', () => {
      for (let i = 1; i <= 100; i++) {
        meter.recordSignal('claude', 0, i);
      }
      // Sorted 1..100. p95 = idx 0.95 * 99 = 94.05 → linear between 95 and 96.
      const stats = meter.getStats();
      expect(stats.p95).not.toBeNull();
      expect(stats.p95!).toBeGreaterThan(94);
      expect(stats.p95!).toBeLessThan(97);
    });
  });

  describe('per-agent breakdown', () => {
    it('counts agents independently', () => {
      meter.recordSignal('claude', 0, 100);
      meter.recordSignal('claude', 0, 200);
      meter.recordSignal('codex', 0, 150);
      const stats = meter.getStats();
      expect(stats.perAgent.claude).toBe(2);
      expect(stats.perAgent.codex).toBe(1);
    });
  });

  describe('isStale()', () => {
    it('returns false when most recent signal is within threshold', () => {
      meter.recordSignal('claude', 0, 1000);
      expect(meter.isStale(500, 1400)).toBe(false);
    });

    it('returns true when most recent signal is older than threshold', () => {
      meter.recordSignal('claude', 0, 1000);
      expect(meter.isStale(500, 2000)).toBe(true);
    });

    it('uses the MOST RECENT entry across the ring (not the oldest)', () => {
      // 100 old entries.
      for (let i = 0; i < MAX_BUFFER; i++) {
        meter.recordSignal('claude', 0, i);
      }
      // One fresh entry overwrites slot 0 in ring.
      meter.recordSignal('claude', 0, 99999);
      expect(meter.isStale(1000, 100000)).toBe(false);
    });
  });

  describe('resetForTests', () => {
    it('clears all state', () => {
      meter.recordSignal('claude', 0, 100);
      meter.resetForTests();
      const stats = meter.getStats();
      expect(stats.count).toBe(0);
      expect(stats.total).toBe(0);
      expect(stats.lastSignalAt).toBeNull();
    });
  });
});
