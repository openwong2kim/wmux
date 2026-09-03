import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { generateHoldSchedule, typeHumanlike } from '../human-typing';
import { KEY_HOLD_MAX_MS, KEY_HOLD_MIN_MS } from '../../../shared/humanRhythm';

// A keystroke is a key held DOWN and then released, not a press-and-release in
// the same millisecond. These cover the split, the hold that sits between the
// two events, and the fallback for characters that cannot be a key at all.

type KeyEvent = { type: 'down' | 'up' | 'press' | 'insert'; key: string; at: number };

/** A fake Page recording every keyboard event with the (fake) clock time. */
function fakePage(opts?: { downRejects?: (char: string) => boolean }): {
  page: Page;
  events: KeyEvent[];
} {
  const events: KeyEvent[] = [];
  const page = {
    click: vi.fn(async () => undefined),
    keyboard: {
      down: vi.fn(async (key: string) => {
        if (opts?.downRejects?.(key)) throw new Error(`Unknown key: "${key}"`);
        events.push({ type: 'down', key, at: Date.now() });
      }),
      up: vi.fn(async (key: string) => {
        events.push({ type: 'up', key, at: Date.now() });
      }),
      press: vi.fn(async (key: string) => {
        // press() calls down() internally, so a character down() refuses is
        // refused here too. The fake mirrors that rather than pretending
        // press() is a second way in.
        if (opts?.downRejects?.(key)) throw new Error(`Unknown key: "${key}"`);
        events.push({ type: 'press', key, at: Date.now() });
      }),
      insertText: vi.fn(async (text: string) => {
        events.push({ type: 'insert', key: text, at: Date.now() });
      }),
    },
  } as unknown as Page;
  return { page, events };
}

/**
 * Run `typeHumanlike` on fake timers, draining every scheduled sleep as it is
 * created so the loop advances without real waiting. `Date.now()` follows the
 * fake clock, so the recorded event times are the schedule itself.
 */
async function typeOnFakeClock(page: Page, text: string): Promise<void> {
  vi.useFakeTimers();
  try {
    const done = typeHumanlike(page, '', text);
    // Each await in the loop resolves a microtask before the next timer is
    // scheduled, so keep pumping until the whole run settles.
    for (let i = 0; i < text.length * 8 + 8; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    await done;
  } finally {
    vi.useRealTimers();
  }
}

describe('typeHumanlike key hold', () => {
  it('splits each character into down + up rather than a bare press', async () => {
    const { page, events } = fakePage();
    await typeOnFakeClock(page, 'abc');

    expect(events.map((e) => `${e.type}:${e.key}`)).toEqual([
      'down:a', 'up:a', 'down:b', 'up:b', 'down:c', 'up:c',
    ]);
    expect((page.keyboard.press as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('holds every key inside the 30-150 ms band', async () => {
    const { page, events } = fakePage();
    // Short enough that the schedule's budget is not the binding constraint:
    // when it is, delays and holds are scaled together and a hold may land
    // under the band's floor by design (see generateKeystrokeSchedule).
    await typeOnFakeClock(page, 'the quick');

    const holds: number[] = [];
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i].type).toBe('down');
      expect(events[i + 1].type).toBe('up');
      holds.push(events[i + 1].at - events[i].at);
    }
    expect(holds).toHaveLength('the quick'.length);
    for (const hold of holds) {
      // The defect: press() produced a ~1 ms dwell time on every key.
      expect(hold).toBeGreaterThanOrEqual(Math.floor(KEY_HOLD_MIN_MS));
      expect(hold).toBeLessThanOrEqual(Math.ceil(KEY_HOLD_MAX_MS));
    }
    // Not every key held for the same length of time either.
    expect(new Set(holds).size).toBeGreaterThan(1);
  });

  it('inserts a character that cannot be a key, rather than losing it', async () => {
    // CJK and emoji halves: keyboard.down() cannot describe them — and neither
    // can press(), which calls down() itself. insertText is the path that puts
    // the character in, at the cost of that one keystroke's hold.
    const { page, events } = fakePage({ downRejects: (c) => c === '한' });
    await typeOnFakeClock(page, 'a한b');

    expect(events.map((e) => `${e.type}:${e.key}`)).toEqual([
      'down:a', 'up:a', 'insert:한', 'down:b', 'up:b',
    ]);
  });

  it('keeps a long text inside the schedule budget, holds included', async () => {
    const { page, events } = fakePage();
    const text = 'the quick brown fox jumps over the lazy dog, twice over';
    await typeOnFakeClock(page, text);

    const spent = events[events.length - 1].at - events[0].at;
    // 120 ms per character plus 1500 ms of slack is the cap the schedule
    // promises; adding every hold on top of an already-capped delay list blew
    // through it by more than half.
    expect(spent).toBeLessThanOrEqual(text.length * 120 + 1500);
  });

  it('clicks the selector first when one is given', async () => {
    const { page } = fakePage();
    vi.useFakeTimers();
    try {
      const done = typeHumanlike(page, '#login', 'x');
      for (let i = 0; i < 16; i++) await vi.advanceTimersByTimeAsync(1000);
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(page.click).toHaveBeenCalledWith('#login');
  });
});

describe('generateHoldSchedule', () => {
  it('returns one hold per character, inside the clamp', () => {
    const schedule = generateHoldSchedule('hello');
    expect(schedule).toHaveLength(5);
    for (const hold of schedule) {
      expect(hold).toBeGreaterThanOrEqual(KEY_HOLD_MIN_MS);
      expect(hold).toBeLessThanOrEqual(KEY_HOLD_MAX_MS);
    }
  });
});
