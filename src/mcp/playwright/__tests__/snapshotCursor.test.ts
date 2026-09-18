import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectionScope, runInConnectionScope } from '../../connectionScope';
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
  continueSnapshotCapture,
  decodeSnapshotCursor,
  encodeSnapshotCursor,
  takeLineWindow,
  windowSnapshotText,
} from '../snapshotCursor';

/**
 * Store + windowing mechanics for the snapshot continuation cursor
 * (snapshotCursor.ts). The tool-level walk lives in
 * inspection.snapshotCursor.test.ts; this file covers the parts a tool cannot
 * observe: line granularity at the boundary, token opacity, the entry cap, the
 * TTL, and per-connection isolation of the capture store.
 */

const KEY = snapshotSurfaceKey('ws-1', 'surf-1');

/** Every window of a capture, walked to exhaustion. */
function walk(first: string, budget: number): string[] {
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
    // Five 9-character lines: 'aaaaaaaaa'..., so the first line costs 9 and
    // every later one 10 (its rejoining newline is charged too).
    const text = ['aaaaaaaaa', 'bbbbbbbbb', 'ccccccccc', 'ddddddddd', 'eeeeeeeee'].join('\n');
    const window = takeLineWindow(text, 0, 25);
    expect(window.text).toBe('aaaaaaaaa\nbbbbbbbbb');
    expect(window.text.length).toBeLessThanOrEqual(25);
    expect(window).toMatchObject({ from: 0, to: 2, total: 5 });
  });

  it('emits an over-budget line whole rather than stalling the cursor', () => {
    const text = ['x'.repeat(50), 'short'].join('\n');
    const window = takeLineWindow(text, 0, 10);
    expect(window.text).toBe('x'.repeat(50));
    expect(window.to).toBe(1);
  });

  it('reports exhaustion for an offset past the last line', () => {
    const window = takeLineWindow('a\nb', 2, 100);
    expect(window).toMatchObject({ text: '', from: 2, to: 2, total: 2 });
  });
});

describe('the cursor token is opaque and validated', () => {
  it('round-trips a capture id and a line offset', () => {
    const token = encodeSnapshotCursor('deadbeef', 42);
    expect(token).not.toContain(':');
    expect(decodeSnapshotCursor(token)).toEqual({ captureId: 'deadbeef', lineOffset: 42 });
  });

  it('rejects anything that is not one', () => {
    for (const bad of ['', 'not-base64url!!', encodeSnapshotCursor('zzz', 1), Buffer.from('nocolon').toString('base64url')]) {
      expect(decodeSnapshotCursor(bad)).toBeNull();
    }
  });
});

describe('windowSnapshotText', () => {
  it('returns a short result whole, with no cursor offered', () => {
    runInConnectionScope(createConnectionScope(), () => {
      const text = 'line one\nline two';
      expect(windowSnapshotText(KEY, text, 'https://x.test/', 1000)).toBe(text);
    });
  });

  it('walks a long capture window by window to exhaustion, losing no line', () => {
    runInConnectionScope(createConnectionScope(), () => {
      const lines = Array.from({ length: 60 }, (_, i) => `  [ref=${i}] button "Item ${i}"`);
      const text = lines.join('\n');
      const windows = walk(windowSnapshotText(KEY, text, 'https://x.test/', 120), 120);

      expect(windows.length).toBeGreaterThan(3);
      expect(windows[windows.length - 1]).toContain(END_OF_CAPTURE_NOTE);
      // Strip each window's closing line and the pieces reassemble byte-exactly
      // — so every ref the capture minted is delivered once, in order.
      const body = windows
        .map((w) => w.split('\n').slice(0, -1).join('\n'))
        .join('\n');
      expect(body).toBe(text);
    });
  });

  it('retires the previous capture when the next result fits whole', () => {
    runInConnectionScope(createConnectionScope(), () => {
      const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
      const token = /cursor:"([^"]+)"/.exec(windowSnapshotText(KEY, long, undefined, 60))?.[1];
      expect(token).toBeTruthy();

      windowSnapshotText(KEY, 'a fresh, short snapshot', undefined, 60);

      const dead = continueSnapshotCapture(token as string, 60);
      expect(dead.isError).toBe(true);
      expect(dead.text.startsWith(CURSOR_EXPIRED_PREFIX)).toBe(true);
    });
  });

  it('says so when the capture itself was cut at the store ceiling', () => {
    runInConnectionScope(createConnectionScope(), () => {
      const line = `${'y'.repeat(99)}\n`;
      const huge = line.repeat(Math.ceil((MAX_CAPTURE_CHARS + 20_000) / line.length));
      const first = windowSnapshotText(KEY, huge, undefined, 1000);
      const opening = decodeSnapshotCursor(/cursor:"([^"]+)"/.exec(first)?.[1] as string);
      const capture = getSnapshotCapture(opening?.captureId ?? '');
      if (!capture) throw new Error('the oversize snapshot stored no capture');
      expect(capture.capped).toBe(true);
      // Jump straight to the tail: the capture is ~10 000 lines and the point
      // here is only what the final window says.
      const tail = encodeSnapshotCursor(capture.id, capture.text.split('\n').length - 2);
      expect(continueSnapshotCapture(tail, 1000).text).toContain(
        `cut at ${MAX_CAPTURE_CHARS} characters`,
      );
    });
  });
});

describe('capture bounds and isolation', () => {
  it('expires a capture at the TTL', () => {
    runInConnectionScope(createConnectionScope(), () => {
      vi.useFakeTimers();
      const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
      const token = /cursor:"([^"]+)"/.exec(windowSnapshotText(KEY, long, undefined, 60))?.[1];

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      const dead = continueSnapshotCapture(token as string, 60);
      expect(dead.isError).toBe(true);
      expect(dead.text.startsWith(CURSOR_EXPIRED_PREFIX)).toBe(true);
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
      const dead = continueSnapshotCapture(encodeSnapshotCursor(captureA.id, 0), 60);
      expect(dead.isError).toBe(true);
      expect(dead.text.startsWith(CURSOR_EXPIRED_PREFIX)).toBe(true);
    });

    runInConnectionScope(scopeA, () => {
      expect(getSnapshotCapture(captureA.id)).not.toBeNull();
    });
  });
});
