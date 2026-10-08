import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #1360: browser_open's `url` parameter was documented as "Defaults to
// google.com", which no lane does. The chrome backend opens about:blank
// (browser.rpc.ts passes `url ?? 'about:blank'`); only the builtin panel has a
// start page, and only on the create path. An agent that read the description
// waited for a search page that was never coming.
//
// Source-level, like the other invariants over src/mcp/index.ts: the shape is
// module-private on purpose (one zod object shared by every broker server), so
// the text is what there is to assert.
describe('browser_open url description (#1360)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');
  const shape = src.slice(
    src.indexOf('const BROWSER_OPEN_SHAPE'),
    src.indexOf('const BROWSER_CLOSE_SHAPE'),
  );

  it('has a BROWSER_OPEN_SHAPE block to describe', () => {
    expect(shape.length).toBeGreaterThan(0);
  });

  it('no longer promises a default page it does not open', () => {
    // Only the .describe() text — the comment above it explains the old claim.
    const described = /\.describe\((['"])([\s\S]*?)\1\)/.exec(shape)?.[2] ?? '';
    expect(described).not.toContain('google');
    expect(described.toLowerCase()).toContain('blank');
  });
});

describe('browser_open private flag', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');
  const shape = src.slice(
    src.indexOf('const BROWSER_OPEN_SHAPE'),
    src.indexOf('const BROWSER_CLOSE_SHAPE'),
  );

  it('declares an optional boolean `private` parameter', () => {
    expect(shape).toMatch(/\bprivate: z\.boolean\(\)\.optional\(\)\.describe\(/);
  });

  it('forwards it to browser.open only when set', () => {
    expect(src).toContain("...(isPrivate === true && { private: true })");
  });
});
