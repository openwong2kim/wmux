import { describe, it, expect, beforeEach } from 'vitest';
import {
  attachImeStormGuard,
  IME_STORM_THRESHOLD,
  IME_STORM_COOLDOWN_MS,
  type ImeStormGuardTextarea,
  type ImeStormRecoveryInfo,
} from '../imeStormGuard';

class FakeTextarea implements ImeStormGuardTextarea {
  listeners = new Map<string, Set<(e: Event) => void>>();
  calls: string[] = [];

  addEventListener(type: string, listener: (e: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (e: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  blur(): void { this.calls.push('blur'); }
  focus(): void { this.calls.push('focus'); }

  fire(type: string, props: Record<string, unknown> = {}): void {
    const e = { type, ...props } as unknown as Event;
    for (const l of this.listeners.get(type) ?? []) l(e);
  }
  keydown(keyCode: number, code: string, isComposing = false): void {
    this.fire('keydown', { keyCode, code, isComposing });
  }
  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

describe('attachImeStormGuard', () => {
  let ta: FakeTextarea;
  let recoveries: ImeStormRecoveryInfo[];
  let clock: number;

  beforeEach(() => {
    ta = new FakeTextarea();
    recoveries = [];
    clock = 100_000;
  });

  function attach(opts: { threshold?: number; minDistinctCodes?: number; cooldownMs?: number } = {}) {
    return attachImeStormGuard(
      { textarea: ta },
      { ...opts, onRecover: (info) => recoveries.push(info), now: () => clock },
    );
  }

  function stormKeys(n: number, codes: string[]): void {
    for (let i = 0; i < n; i++) ta.keydown(229, codes[i % codes.length]);
  }

  it('recovers after threshold claimed keydowns across distinct keys', () => {
    attach();
    stormKeys(IME_STORM_THRESHOLD, ['KeyA', 'KeyS', 'ArrowDown']);

    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].count).toBe(IME_STORM_THRESHOLD);
    expect(recoveries[0].codes).toContain('ArrowDown');
    expect(ta.calls).toEqual(['blur', 'focus']);
  });

  it('a healthy composition flow never triggers (compositionstart resets)', () => {
    attach();
    // Real Korean typing: every claimed keydown is followed by a composition
    // event in the same task (observed in scripts/ime-desync-repro.mjs).
    for (let i = 0; i < 30; i++) {
      ta.keydown(229, 'KeyR');
      ta.fire('compositionstart', { data: '' });
      ta.keydown(229, 'KeyK', true); // mid-composition keydowns report isComposing
      ta.fire('compositionupdate', { data: '가' });
      ta.fire('compositionend', { data: '가' });
    }
    expect(recoveries).toHaveLength(0);
    expect(ta.calls).toEqual([]);
  });

  it('mid-composition (isComposing=true) keydowns are not counted', () => {
    attach();
    for (let i = 0; i < IME_STORM_THRESHOLD * 2; i++) ta.keydown(229, `Key${i}`, true);
    expect(recoveries).toHaveLength(0);
  });

  it('a single repeated physical key does not trigger (held key)', () => {
    attach();
    stormKeys(IME_STORM_THRESHOLD * 2, ['KeyA']);
    expect(recoveries).toHaveLength(0);
  });

  it('a mashed Escape still recovers — it is the interrupt key (#1152)', () => {
    attach();
    stormKeys(IME_STORM_THRESHOLD, ['Escape']);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].codes).toEqual(['Escape']);
    expect(ta.calls).toEqual(['blur', 'focus']);
  });

  it('a normal keydown resets the counter', () => {
    attach();
    stormKeys(IME_STORM_THRESHOLD - 1, ['KeyA', 'KeyS']);
    ta.keydown(65, 'KeyA'); // normally-delivered key — IME not claiming
    stormKeys(IME_STORM_THRESHOLD - 1, ['KeyA', 'KeyS']);
    expect(recoveries).toHaveLength(0);
  });

  it('input activity resets the counter', () => {
    attach();
    stormKeys(IME_STORM_THRESHOLD - 1, ['KeyA', 'KeyS']);
    ta.fire('input');
    stormKeys(IME_STORM_THRESHOLD - 1, ['KeyA', 'KeyS']);
    expect(recoveries).toHaveLength(0);
  });

  it('rate-limits recoveries to the cooldown window', () => {
    attach();
    stormKeys(IME_STORM_THRESHOLD, ['KeyA', 'KeyS']);
    expect(recoveries).toHaveLength(1);

    // Still claimed right after recovery — within cooldown, no second blur.
    stormKeys(IME_STORM_THRESHOLD * 3, ['KeyA', 'KeyS']);
    expect(recoveries).toHaveLength(1);

    clock += IME_STORM_COOLDOWN_MS;
    stormKeys(IME_STORM_THRESHOLD, ['KeyA', 'KeyS']);
    expect(recoveries).toHaveLength(2);
    expect(ta.calls).toEqual(['blur', 'focus', 'blur', 'focus']);
  });

  it('dispose removes every listener; missing textarea is a no-op', () => {
    const guard = attach();
    expect(ta.listenerCount()).toBeGreaterThan(0);
    guard.dispose();
    expect(ta.listenerCount()).toBe(0);

    const noop = attachImeStormGuard({ textarea: undefined });
    noop.dispose();
  });
});
