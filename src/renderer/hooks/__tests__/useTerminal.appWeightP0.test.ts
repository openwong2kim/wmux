import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createPtyDispatcher } from '../useTerminal';

// App-weight P0 (plans/app-weight-reduction-2026-07-16.md) — the three
// renderer fixes the eng review made mandatory for the retention default flip.
// Source-level checks follow the useTerminal.hiddenRetention.test.ts
// convention (the hook needs a full xterm/electron bootstrap for behavioral
// tests); the dispatcher itself is behaviorally tested below via its export.
const src = fs.readFileSync(path.join(__dirname, '..', 'useTerminal.ts'), 'utf-8');

describe('P0-1 — scrollback pendingData obeys retention (Codex Eng #1)', () => {
  it('both pending-data flush loops route through routePtyData, never terminal.write', () => {
    const loops = src.match(/for \(const data of pendingData\) \{\s*\n\s*routePtyData\(data\);/g) ?? [];
    expect(loops.length).toBe(2);
    // The old bypass must be gone entirely.
    expect(src).not.toMatch(/for \(const data of pendingData\) \{\s*\n\s*terminal\.write\(data\);/);
  });
});

describe('P0-2 — a degraded resync stays dirty and rate-limits retries', () => {
  const body = src.slice(src.indexOf('const abortResync'), src.indexOf('const cancelResync'));

  it('abortResync never blesses the stale screen as clean', () => {
    expect(body).not.toMatch(/markTerminalClean/);
  });

  it('abortResync arms the retry cooldown and surfaces the stale UI state', () => {
    expect(body).toMatch(/degradedUntil = Date\.now\(\) \+ RESYNC_DEGRADED_COOLDOWN_MS/);
    expect(body).toMatch(/setPaneSyncUi\([^)]*'stale'\)/);
  });

  it('startResync suppresses retries during the cooldown window', () => {
    const startBody = src.slice(src.indexOf('const startResync'), src.indexOf('const startResync') + 2000);
    expect(startBody).toMatch(/Date\.now\(\) < st\.degradedUntil/);
  });

  it('successful settlement clears the cooldown (flush completion + dead snapshot)', () => {
    const flush = src.slice(src.indexOf('const completeResyncFromFlush'), src.indexOf('const completeResyncFromFlush') + 800);
    expect(flush).toMatch(/degradedUntil = 0/);
    const dead = src.slice(src.indexOf('const paintDeadSnapshot'), src.indexOf('const paintDeadSnapshot') + 900);
    expect(dead).toMatch(/degradedUntil = 0/);
  });
});

describe('P0-3 — single-dispatch PTY fan-out (source wiring)', () => {
  it('exactly one raw IPC subscription per channel (the dispatcher attach)', () => {
    expect((src.match(/window\.electronAPI\.pty\.onData\(/g) ?? []).length).toBe(1);
    expect((src.match(/window\.electronAPI\.pty\.onExit\(/g) ?? []).length).toBe(1);
    expect((src.match(/window\.electronAPI\.pty\.onFlushComplete\(/g) ?? []).length).toBe(1);
  });

  it('all per-pane registrations go through the dispatchers', () => {
    expect((src.match(/ptyDataDispatcher\.register\(/g) ?? []).length).toBe(2);
    expect((src.match(/ptyExitDispatcher\.register\(/g) ?? []).length).toBe(2);
    expect((src.match(/ptyFlushDispatcher\.register\(/g) ?? []).length).toBe(2);
  });
});

describe('P0-3 — dispatcher behavior (dual-mount overlap, Eng F5)', () => {
  function harness() {
    let emit: ((id: string, payload: string) => void) | null = null;
    const detach = vi.fn();
    const attach = vi.fn((cb: (id: string, payload: string) => void) => {
      emit = cb;
      return detach;
    });
    const d = createPtyDispatcher<string>(attach);
    return { d, attach, detach, emit: (id: string, p: string) => emit?.(id, p) };
  }

  it('dispatches only to the matching ptyId, O(1) in pane count', () => {
    const { d, emit } = harness();
    const a: string[] = []; const b: string[] = [];
    d.register('pty-a', (x) => a.push(x));
    d.register('pty-b', (x) => b.push(x));
    emit('pty-a', 'hello');
    expect(a).toEqual(['hello']);
    expect(b).toEqual([]);
  });

  it('a stale unsubscribe from instance A never deletes instance B (fast unmount→remount)', () => {
    const { d, emit } = harness();
    const seenA: string[] = []; const seenB: string[] = [];
    const offA = d.register('pty-1', (x) => seenA.push(x));
    // Instance B mounts on the SAME ptyId while A is being torn down.
    d.register('pty-1', (x) => seenB.push(x));
    offA();          // A's cleanup runs late…
    offA();          // …possibly twice — must be a no-op, not a foreign delete
    emit('pty-1', 'data');
    expect(seenA).toEqual([]);
    expect(seenB).toEqual(['data']); // B is still wired — the deaf-pane bug
  });

  it('attaches the raw listener lazily and exactly once', () => {
    const { d, attach } = harness();
    expect(attach).not.toHaveBeenCalled();
    d.register('x', () => {});
    d.register('y', () => {});
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('reset detaches the raw listener and drops all registrations (test isolation seam)', () => {
    const { d, detach, emit } = harness();
    const seen: string[] = [];
    d.register('z', (x) => seen.push(x));
    d.reset();
    expect(detach).toHaveBeenCalledTimes(1);
    emit('z', 'after-reset');
    expect(seen).toEqual([]);
  });
});

describe('P0-5 — reveal mechanism codes reach the persisted main log', () => {
  it('static-mechanism reveal paths log a [wmux:reveal] code', () => {
    for (const code of ['retained-catchup', 'dead-snapshot', 'resync-degraded']) {
      expect(src).toMatch(new RegExp(`\\[wmux:reveal\\][^\`]*mechanism=${code}`));
    }
  });

  it('resync settlement emits exactly ONE event, labelled by the delivering path (codex PR #470)', () => {
    const flush = src.slice(src.indexOf('const completeResyncFromFlush'), src.indexOf('const completeResyncFromFlush') + 1400);
    // Single settlement log, mechanism chosen by the raw-fallback flag…
    expect(flush).toMatch(/viaRawFallback \? 'dirty-raw-fallback' : 'dirty-snapshot'/);
    expect(flush).toMatch(/\[wmux:reveal\][^`]*mechanism=\$\{mechanism\}/);
    // …and the fallback path itself must NOT emit its own [wmux:reveal] event
    // (that would double-count a single reveal in doctor's aggregator).
    const fb = src.slice(src.indexOf('const fallbackReconnect'), src.indexOf('const fallbackReconnect') + 900);
    expect(fb).not.toMatch(/\[wmux:reveal\]/);
    expect(fb).toMatch(/viaRawFallback = true/);
  });

  it('cancelResync clears the CAPTURED ptyId, not the mutable ref (CodeRabbit PR #470)', () => {
    const body = src.slice(src.indexOf('const cancelResync'), src.indexOf('const cancelResync') + 1200);
    expect(body).toMatch(/cancelledPtyId/);
    expect(body).not.toMatch(/setPaneSyncUi\(ptyIdRef\.current/);
    expect(src).toMatch(/cancelResync\(ptyId\)/);
  });
});
