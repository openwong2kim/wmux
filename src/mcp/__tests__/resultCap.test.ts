// Unit coverage for the shared tool-result size guard (src/mcp/resultCap.ts).
//
// The guard is the one place every TEXT tool result passes through, so its
// contract is pinned directly: cap at the boundary with a visible marker that
// names the raise path, never split a UTF-8 codepoint, leave non-text content
// untouched, clamp a caller's maxBytes to the hard maximum instead of
// rejecting it.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESULT_CAP_BYTES,
  MAX_RESULT_CAP_BYTES,
  capText,
  capToolResultText,
  clampResultCapBytes,
  inputSchemaDeclaresMaxBytes,
  wrapHandlerWithResultCap,
} from '../resultCap';
import { z } from 'zod';

const MIB = 1024 * 1024;

describe('clampResultCapBytes', () => {
  it('returns the default for absent, non-numeric, or non-positive input', () => {
    expect(clampResultCapBytes(undefined)).toBe(DEFAULT_RESULT_CAP_BYTES);
    expect(clampResultCapBytes(null)).toBe(DEFAULT_RESULT_CAP_BYTES);
    expect(clampResultCapBytes('65536')).toBe(DEFAULT_RESULT_CAP_BYTES);
    expect(clampResultCapBytes(0)).toBe(DEFAULT_RESULT_CAP_BYTES);
    expect(clampResultCapBytes(-1)).toBe(DEFAULT_RESULT_CAP_BYTES);
    expect(clampResultCapBytes(Number.NaN)).toBe(DEFAULT_RESULT_CAP_BYTES);
  });

  it('raises the cap up to the hard bound and not beyond', () => {
    expect(clampResultCapBytes(1000)).toBe(1000);
    expect(clampResultCapBytes(MAX_RESULT_CAP_BYTES)).toBe(MAX_RESULT_CAP_BYTES);
    expect(clampResultCapBytes(100 * MIB)).toBe(MAX_RESULT_CAP_BYTES);
    // A float is floored, not rejected.
    expect(clampResultCapBytes(1000.9)).toBe(1000);
  });
});

describe('capText', () => {
  it('passes through text already within the cap unchanged', () => {
    expect(capText('small', DEFAULT_RESULT_CAP_BYTES)).toBe('small');
  });

  it('truncates oversized text head+tail and marks the cut with the raise path', () => {
    const input = `${'a'.repeat(200_000)}MIDDLE${'b'.repeat(200_000)}`;
    const capped = capText(input, DEFAULT_RESULT_CAP_BYTES, { declaresMaxBytes: true });
    expect(capped).not.toBe(input);
    // The marker's own bytes count inside the budget: the output never
    // exceeds the cap, marker included.
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(
      DEFAULT_RESULT_CAP_BYTES,
    );
    // Marker states what fraction survived and how to ask for more.
    expect(capped).toMatch(
      /\[truncated: \d+ of \d+ bytes shown; pass maxBytes to raise, up to 512 KiB\]/,
    );
    // Head and tail survive; only the middle is dropped.
    expect(capped.startsWith('aaa')).toBe(true);
    expect(capped.endsWith('bbb')).toBe(true);
    expect(capped).not.toContain('MIDDLE');
  });

  it('never cuts inside a UTF-8 codepoint', () => {
    // 3-byte codepoints; a cut at a byte multiple of 3 would be clean, so use
    // a cap offset by one byte to force the boundary walk.
    const input = '한'.repeat(100_000);
    const capped = capText(input, DEFAULT_RESULT_CAP_BYTES + 1);
    expect(capped).not.toContain('�');
  });

  it('keeps the byte bound across caps, including ones smaller than the marker', () => {
    for (const cap of [24, 100, 1024, 4096, DEFAULT_RESULT_CAP_BYTES]) {
      const capped = capText(`한`.repeat(cap), cap);
      expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(cap);
    }
  });
});

describe('inputSchemaDeclaresMaxBytes', () => {
  it('reads a ZodRawShape, a ZodObject, and neither', () => {
    expect(inputSchemaDeclaresMaxBytes({ maxBytes: z.number().optional() })).toBe(true);
    expect(inputSchemaDeclaresMaxBytes({ code: z.string() })).toBe(false);
    // strictInput tools hand the guard a ZodObject; its `.shape` carries the keys.
    expect(inputSchemaDeclaresMaxBytes(z.strictObject({ maxBytes: z.number() }))).toBe(true);
    expect(inputSchemaDeclaresMaxBytes(z.strictObject({ code: z.string() }))).toBe(false);
    expect(inputSchemaDeclaresMaxBytes(undefined)).toBe(false);
    expect(inputSchemaDeclaresMaxBytes(null)).toBe(false);
    expect(inputSchemaDeclaresMaxBytes('maxBytes')).toBe(false);
  });
});

describe('truncation marker raise path', () => {
  const oversized = 'q'.repeat(200_000);

  it('names maxBytes only for a tool whose schema declares it', () => {
    const declared = capText(oversized, DEFAULT_RESULT_CAP_BYTES, { declaresMaxBytes: true });
    expect(declared).toContain('pass maxBytes to raise, up to 512 KiB');
  });

  it('states the cut without a raise path the caller cannot take', () => {
    // On a strictInput tool without the field, passing maxBytes ERRORS, so the
    // marker must not advertise it — the default is off for exactly that case.
    const plain = capText(oversized, DEFAULT_RESULT_CAP_BYTES);
    expect(plain).toMatch(/\[truncated: \d+ of 200000 bytes shown\]/);
    expect(plain).not.toContain('maxBytes');
    expect(capText(oversized, DEFAULT_RESULT_CAP_BYTES, { declaresMaxBytes: false })).toBe(plain);
  });
});

describe('JSON-aware truncation', () => {
  // browser_extract_data / browser_network shape: one top-level array of
  // records. A head+tail cut would land mid-value and leave a blob the caller
  // cannot parse.
  const records = Array.from({ length: 400 }, (_, i) => ({
    index: i,
    url: `https://example.test/item/${i}`,
    note: 'p'.repeat(500),
  }));
  const document = JSON.stringify(records, null, 2);

  it('keeps a capped JSON array parseable by dropping trailing items', () => {
    expect(Buffer.byteLength(document, 'utf8')).toBeGreaterThan(DEFAULT_RESULT_CAP_BYTES);
    const capped = capText(document, DEFAULT_RESULT_CAP_BYTES);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(DEFAULT_RESULT_CAP_BYTES);

    const parsed = JSON.parse(capped) as Record<string, unknown>[];
    expect(Array.isArray(parsed)).toBe(true);
    // Leading records survive intact, not cut mid-value.
    expect(parsed[0]).toEqual(records[0]);
    // The last element states what was dropped, inside the data.
    const marker = parsed[parsed.length - 1]?.['_truncated'] as Record<string, number>;
    expect(marker.shownItems).toBe(parsed.length - 1);
    expect(marker.totalItems).toBe(records.length);
    expect(marker.totalBytes).toBe(Buffer.byteLength(document, 'utf8'));
    expect(marker.shownItems).toBeGreaterThan(0);
    expect(marker).not.toHaveProperty('raise');
  });

  it('names the raise path inside the marker element only when declared', () => {
    const capped = capText(document, DEFAULT_RESULT_CAP_BYTES, { declaresMaxBytes: true });
    const parsed = JSON.parse(capped) as Record<string, unknown>[];
    const marker = parsed[parsed.length - 1]?.['_truncated'] as Record<string, unknown>;
    expect(marker['raise']).toBe(`pass maxBytes up to ${MAX_RESULT_CAP_BYTES}`);
  });

  it('re-capping an already-capped JSON array is a no-op', () => {
    const once = capText(document, DEFAULT_RESULT_CAP_BYTES);
    expect(capText(once, DEFAULT_RESULT_CAP_BYTES)).toBe(once);
  });

  it('falls back to the head+tail cut for text that is not a JSON array', () => {
    const object = JSON.stringify({ body: 'z'.repeat(200_000) });
    const capped = capText(object, DEFAULT_RESULT_CAP_BYTES);
    expect(capped).toMatch(/\[truncated: \d+ of \d+ bytes shown\]/);
  });
});

describe('idempotency', () => {
  it('re-applying capText to capped output is a no-op', () => {
    const input = 'm'.repeat(600_000);
    const once = capText(input, DEFAULT_RESULT_CAP_BYTES);
    expect(capText(once, DEFAULT_RESULT_CAP_BYTES)).toBe(once);
  });

  it('returns an already-wrapped handler unchanged', () => {
    const handler = (input: { value?: string }) => ({
      content: [{ type: 'text' as const, text: String(input.value) }],
    });
    const once = wrapHandlerWithResultCap(handler);
    expect(wrapHandlerWithResultCap(once)).toBe(once);
  });

  it('wrapping twice yields byte-identical output to wrapping once', async () => {
    const text = 'n'.repeat(600_000);
    const handler = async (_input: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text }],
    });
    const once = wrapHandlerWithResultCap(handler);
    // The catalog lane wraps, then the patched registerTool wraps again; the
    // result must be one truncation pass, not two stacked markers.
    const twice = wrapHandlerWithResultCap(
      wrapHandlerWithResultCap(handler),
    );
    const [a, b] = (await Promise.all([
      once({ maxBytes: MAX_RESULT_CAP_BYTES }),
      twice({ maxBytes: MAX_RESULT_CAP_BYTES }),
    ])) as { content: { text: string }[] }[];
    expect(b.content[0]?.text).toBe(a.content[0]?.text);
    // The marker reports the TRUE original total, not a first pass's size.
    expect(a.content[0]?.text).toMatch(/\[truncated: \d+ of 600000 bytes shown/);
    expect(Buffer.byteLength(a.content[0]?.text ?? '', 'utf8')).toBeLessThanOrEqual(
      MAX_RESULT_CAP_BYTES,
    );
  });
});

describe('capToolResultText', () => {
  it('caps text blocks but leaves image content untouched', () => {
    const image = 'A'.repeat(3 * MIB);
    const result = {
      content: [
        { type: 'image' as const, data: image, mimeType: 'image/png' },
        { type: 'text' as const, text: 'x'.repeat(200_000) },
      ],
    };
    const capped = capToolResultText(result, DEFAULT_RESULT_CAP_BYTES);
    expect(capped.content[0]).toEqual({ type: 'image', data: image, mimeType: 'image/png' });
    expect((capped.content[1] as { text: string }).text).toMatch(/\[truncated: /);
  });

  it('returns the same object when nothing needed capping', () => {
    const result = { content: [{ type: 'text' as const, text: 'fine' }] };
    expect(capToolResultText(result, DEFAULT_RESULT_CAP_BYTES)).toBe(result);
  });

  it('passes non-result values through', () => {
    expect(capToolResultText(undefined, DEFAULT_RESULT_CAP_BYTES)).toBeUndefined();
  });
});

describe('wrapHandlerWithResultCap', () => {
  it('caps a sync handler result using the default cap', () => {
    const wrapped = wrapHandlerWithResultCap(
      (input: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: `${input.value}`.repeat(100_000) }],
      }),
    );
    const result = wrapped({ value: 'x' }) as { content: { text: string }[] };
    expect(result.content[0]?.text).toMatch(/\[truncated: /);
  });

  it('honours maxBytes from the first argument for an async handler', async () => {
    const wrapped = wrapHandlerWithResultCap(
      async (input: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: 'y'.repeat(150_000) }],
      }),
    );
    const within = (await wrapped({ maxBytes: 200_000 })) as { content: { text: string }[] };
    expect(within.content[0]?.text).toBe('y'.repeat(150_000));

    // Above the hard maximum: clamped to it, not rejected and not unbounded.
    // 600 KB of payload with a 100 MB request is served at 512 KiB.
    const wrappedBig = wrapHandlerWithResultCap(
      async (_input: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: 'z'.repeat(600_000) }],
      }),
    );
    const clamped = (await wrappedBig({ maxBytes: 500 * MIB })) as { content: { text: string }[] };
    // The marker counts inside the cap, so slightly under 512 KiB is shown —
    // but the marker still reports the TRUE original total.
    expect(clamped.content[0]?.text).toMatch(
      /\[truncated: \d+ of 600000 bytes shown/,
    );
    expect(
      Buffer.byteLength(clamped.content[0]?.text ?? '', 'utf8'),
    ).toBeLessThanOrEqual(MAX_RESULT_CAP_BYTES);
  });

  it('lets thrown errors pass through untouched', async () => {
    const wrapped = wrapHandlerWithResultCap(async (_input: Record<string, unknown>) => {
      throw new Error('boom');
    });
    await expect(wrapped({})).rejects.toThrow('boom');
  });
});

describe('capToolResultText with several images', () => {
  it('caps the text and passes every image block through untouched, in order', () => {
    // A browser_repl / repl_run result: one text block, then up to four images.
    const images = [1, 2, 3, 4].map((n) => ({
      type: 'image' as const,
      data: String(n).repeat(MIB),
      mimeType: n % 2 === 0 ? 'image/jpeg' : 'image/png',
    }));
    const result = { content: [{ type: 'text' as const, text: 'x'.repeat(2 * MIB) }, ...images] };
    const capped = capToolResultText(result, DEFAULT_RESULT_CAP_BYTES);
    expect(capped.content).toHaveLength(5);
    expect(Buffer.byteLength((capped.content[0] as { text: string }).text)).toBeLessThanOrEqual(
      DEFAULT_RESULT_CAP_BYTES,
    );
    for (let i = 0; i < images.length; i += 1) {
      expect(capped.content[i + 1]).toBe(images[i]);
    }
  });
});
