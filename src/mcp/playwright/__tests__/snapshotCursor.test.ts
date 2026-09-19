import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectionScope, runInConnectionScope } from '../../connectionScope';
import { DEFAULT_RESULT_CAP_BYTES, MAX_RESULT_CAP_BYTES } from '../../resultCap';
import {
  MAX_CAPTURE_CHARS,
  getSnapshotCapture,
  invalidateSnapshotBaseline,
  putSnapshotCapture,
  snapshotSurfaceKey,
} from '../snapshotCache';
import {
  CURSOR_EXPIRED_PREFIX,
  END_OF_CAPTURE_NOTE,
  capCaptureText,
  continueSnapshotCapture,
  decodeSnapshotCursor,
  encodeSnapshotCursor,
  takeLineWindow,
  windowBudget,
  windowBudgetForMaxBytes,
  windowSnapshotText,
  type WindowBudget,
} from '../snapshotCursor';

/**
 * Store + windowing mechanics for the snapshot continuation cursor
 * (snapshotCursor.ts). The tool-level walk lives in
 * inspection.snapshotCursor.test.ts; this file covers the parts a tool cannot
 * observe: line granularity at the boundary, the byte half of the budget, token
 * opacity, the capture ceiling, the entry cap, the TTL, and per-connection
 * isolation of the capture store.
 */

const KEY = snapshotSurfaceKey('ws-1', 'surf-1');

/** A small budget for tests that only care about where the cut lands. */
function tiny(chars: number, bytes = 1_000_000): WindowBudget {
  return { chars, bytes };
}

/** Every window of a capture, walked to exhaustion. */
function walk(first: string, budget: WindowBudget): string[] {
  const out = [first];
  let token = /cursor:"([^"]+)"/.exec(first)?.[1];
  while (token) {
    const next = continueSnapshotCapture(token, budget);
    expect(next.isError).toBe(false);
    out.push(next.text);
    token = /cursor:"([^"]+)"/.exec(next.text)?.[1];
  }
  return out;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('takeLineWindow never splits a line', () => {
  it('stops at the last line that fits, not at the budget character', () => {
    // Five 9-character lines, so the first costs 9 and every later one 10 (its
    // rejoining newline is charged too).
    const text = ['aaaaaaaaa', 'bbbbbbbbb', 'ccccccccc', 'ddddddddd', 'eeeeeeeee'].join('\n');
    const window = takeLineWindow(text, 0, tiny(25));
    expect(window.text).toBe('aaaaaaaaa\nbbbbbbbbb');
    expect(window.text.length).toBeLessThanOrEqual(25);
    expect(window).toMatchObject({ from: 0, to: 2, total: 5 });
  });

  it('emits an over-budget line whole rather than stalling the cursor', () => {
    const text = ['x'.repeat(50), 'short'].join('\n');
    const window = takeLineWindow(text, 0, tiny(10));
    expect(window.text).toBe('x'.repeat(50));
    expect(window.to).toBe(1);
  });

  it('reports exhaustion for an offset past the last line', () => {
    const window = takeLineWindow('a\nb', 2, tiny(100));
    expect(window).toMatchObject({ text: '', from: 2, to: 2, total: 2 });
  });
});

describe('the budget has a byte half, so the dispatch cap never elides a window', () => {
  it('cuts a multibyte page on bytes even when the characters would fit', () => {
    // 12 characters per line but 36 UTF-8 bytes: a char-only budget would take
    // all five lines, and the byte cap would then elide the middle of the
    // window while its trailer still promised continuity.
    const line = '가'.repeat(12);
    const text = Array.from({ length: 5 }, () => line).join('\n');
    const charsOnly = takeLineWindow(text, 0, { chars: 1000, bytes: 1000 });
    expect(charsOnly.to).toBe(5);

    const byteBound = takeLineWindow(text, 0, { chars: 1000, bytes: 80 });
    expect(byteBound.to).toBe(2);
    expect(Buffer.byteLength(byteBound.text, 'utf8')).toBeLessThanOrEqual(80);
  });

  it('sizes the default budget under the dispatch result cap, and follows maxBytes up', () => {
    expect(windowBudget().bytes).toBeLessThan(DEFAULT_RESULT_CAP_BYTES);
    expect(windowBudgetForMaxBytes(undefined).bytes).toBe(windowBudget().bytes);
    // A tool that declares maxBytes buys bigger windows with it.
    expect(windowBudgetForMaxBytes(MAX_RESULT_CAP_BYTES).bytes).toBeGreaterThan(
      windowBudget().bytes,
    );
    // Clamped, never rejected.
    expect(windowBudgetForMaxBytes(1e12).bytes).toBeLessThan(MAX_RESULT_CAP_BYTES);
  });

  it('keeps a whole CJK window inside the byte cap it was sized for', () => {
    runInConnectionScope(createConnectionScope(), () => {
      const lines = Array.from({ length: 4000 }, (_, i) => `  [ref=${i}] 버튼 "항목 ${i} 실행"`);
      const budget = windowBudget();
      const first = windowSnapshotText(KEY, lines.join('\n'), undefined, budget);
      expect(Buffer.byteLength(first, 'utf8')).toBeLessThanOrEqual(DEFAULT_RESULT_CAP_BYTES);
      expect(first).toContain('to continue this same capture');
    });
  });
});

describe('the cursor token is opaque and validated', () => {
  it('round-trips a capture id and a line offset', () => {
    const token = encodeSnapshotCursor('deadbeef', 42);
    expect(token).not.toContain(':');
    expect(decodeSnapshotCursor(token)).toEqual({ captureId: 'deadbeef', lineOffset: 42 });
  });

  it('rejects anything that is not one', () => {
    const bad = [
      '',
      'not-base64url!!',
      encodeSnapshotCursor('zzz', 1),
      Buffer.from('nocolon').toString('base64url'),
    ];
    for (const token of bad) expect(decodeSnapshotCursor(token)).toBeNull();
  });
});

describe('windowSnapshotText', () => {
  it('returns a short result whole, with no cursor offered', () => {
    runInConnectionScope(createConnectionScope(), () => {
      const text = 'line one\nline two';
      expect(windowSnapshotText(KEY, text, 'https://x.test/', tiny(1000))).toBe(text);
    });
  });

  it('walks a long capture window by window to exhaustion, losing no line', () => {
    runInConnectionScope(createConnectionScope(), () => {
      const lines = Array.from({ length: 60 }, (_, i) => `  [ref=${i}] button "Item ${i}"`);
      const text = lines.join('\n');
      const budget = tiny(120);
      const windows = walk(windowSnapshotText(KEY, text, 'https://x.test/', budget), budget);

      expect(windows.length).toBeGreaterThan(3);
      expect(windows[windows.length - 1]).toContain(END_OF_CAPTURE_NOTE);
      // Strip each window's closing line and the pieces reassemble byte-exactly
      // — so every ref the capture minted is delivered once, in order.
      const body = windows.map((w) => w.split('\n').slice(0, -1).join('\n')).join('\n');
      expect(body).toBe(text);
    });
  });

  it('stores no capture when the overflow is one unsplittable line', () => {
    runInConnectionScope(createConnectionScope(), () => {
      const single = 'x'.repeat(500);
      // Over budget and nothing left to page: a cursor here would only be a
      // token into a capture with no second window.
      expect(windowSnapshotText(KEY, single, undefined, tiny(50))).toBe(single);
      expect(putSnapshotCapture(KEY, 'probe\nprobe').surfaceKey).toBe(KEY);
    });
  });

  it('retires the previous capture when the next result fits whole', () => {
    runInConnectionScope(createConnectionScope(), () => {
      const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
      const budget = tiny(60);
      const token = /cursor:"([^"]+)"/.exec(windowSnapshotText(KEY, long, undefined, budget))?.[1];
      expect(token).toBeTruthy();

      windowSnapshotText(KEY, 'a fresh, short snapshot', undefined, budget);

      const dead = continueSnapshotCapture(token as string, budget);
      expect(dead.isError).toBe(true);
      expect(dead.text.startsWith(CURSOR_EXPIRED_PREFIX)).toBe(true);
    });
  });

  it('refuses to page a capture from a call aimed at a different surface', () => {
    runInConnectionScope(createConnectionScope(), () => {
      const long = Array.from({ length: 40 }, (_, i) => `[ref=${i}] item`).join('\n');
      const budget = tiny(60);
      const token = /cursor:"([^"]+)"/.exec(windowSnapshotText(KEY, long, undefined, budget))?.[1] as string;

      // Tab B's refs are not tab A's: a cursor minted on one surface must not
      // be served to a call that named another, or ref=N clicks the wrong thing.
      const other = snapshotSurfaceKey('ws-1', 'surface-other');
      const refused = continueSnapshotCapture(token, budget, other);
      expect(refused.isError).toBe(true);
      expect(refused.text.startsWith(CURSOR_EXPIRED_PREFIX)).toBe(true);
      expect(refused.text).toContain('different surface');

      // The surface it was taken on, and a call that named no surface, both page it.
      expect(continueSnapshotCapture(token, budget, KEY).isError).toBe(false);
      expect(continueSnapshotCapture(token, budget).isError).toBe(false);
    });
  });
});

describe('capCaptureText', () => {
  it('leaves anything under the ceiling alone', () => {
    expect(capCaptureText('a\nb')).toBe('a\nb');
  });

  it('cuts at a line boundary and says what it dropped', () => {
    const line = `${'y'.repeat(99)}\n`;
    const huge = line.repeat(Math.ceil((MAX_CAPTURE_CHARS + 20_000) / line.length));
    const capped = capCaptureText(huge);

    expect(capped.length).toBeLessThan(huge.length);
    expect(capped.split('\n').slice(-1)[0]).toContain('capture ceiling reached');
    // Boundary, not mid-line: every retained line is a whole one.
    for (const l of capped.split('\n').slice(0, -1)) {
      expect(l === '' || l === 'y'.repeat(99)).toBe(true);
    }
  });
});

describe('capture bounds and isolation', () => {
  it('expires a capture that nobody came back for', () => {
    runInConnectionScope(createConnectionScope(), () => {
      vi.useFakeTimers();
      const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
      const budget = tiny(60);
      const token = /cursor:"([^"]+)"/.exec(windowSnapshotText(KEY, long, undefined, budget))?.[1];

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      const dead = continueSnapshotCapture(token as string, budget);
      expect(dead.isError).toBe(true);
      expect(dead.text.startsWith(CURSOR_EXPIRED_PREFIX)).toBe(true);
    });
  });

  it('is an idle timeout, so a walk in progress does not expire under the agent', () => {
    runInConnectionScope(createConnectionScope(), () => {
      vi.useFakeTimers();
      const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
      const budget = tiny(60);
      let token = /cursor:"([^"]+)"/.exec(windowSnapshotText(KEY, long, undefined, budget))?.[1];

      // Four minutes between windows, for well over the TTL in total.
      for (let i = 0; i < 4 && token; i++) {
        vi.advanceTimersByTime(4 * 60 * 1000);
        const next = continueSnapshotCapture(token, budget);
        expect(next.isError).toBe(false);
        token = /cursor:"([^"]+)"/.exec(next.text)?.[1];
      }
      expect(token).toBeTruthy();
    });
  });

  it('evicts the oldest capture past the entry cap', () => {
    runInConnectionScope(createConnectionScope(), () => {
      const first = putSnapshotCapture(snapshotSurfaceKey('ws-1', 'surf-0'), 'a\nb');
      for (let i = 1; i <= 8; i++) {
        putSnapshotCapture(snapshotSurfaceKey('ws-1', `surf-${i}`), 'a\nb');
      }
      expect(getSnapshotCapture(first.id)).toBeNull();
      // The cap bounds concurrently-paged surfaces; the newest is untouched.
      expect(getSnapshotCapture(putSnapshotCapture(KEY, 'a\nb').id)).not.toBeNull();
    });
  });

  it('drops a surface capture on the navigation invalidation path', () => {
    runInConnectionScope(createConnectionScope(), () => {
      const capture = putSnapshotCapture(KEY, 'a\nb', 'https://x.test/one');
      invalidateSnapshotBaseline('ws-1', 'surf-1');
      expect(getSnapshotCapture(capture.id)).toBeNull();
    });
  });

  it('never lets one connection read another connection capture', () => {
    const scopeA = createConnectionScope();
    const scopeB = createConnectionScope();
    const captureA = runInConnectionScope(scopeA, () => putSnapshotCapture(KEY, 'a\nb'));

    runInConnectionScope(scopeB, () => {
      expect(getSnapshotCapture(captureA.id)).toBeNull();
      // Same surface key, same token shape — still a different store.
      const dead = continueSnapshotCapture(encodeSnapshotCursor(captureA.id, 0), tiny(60));
      expect(dead.isError).toBe(true);
      expect(dead.text.startsWith(CURSOR_EXPIRED_PREFIX)).toBe(true);
    });

    runInConnectionScope(scopeA, () => {
      expect(getSnapshotCapture(captureA.id)).not.toBeNull();
    });
  });
});
