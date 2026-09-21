import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/**
 * Guards the @xterm/addon-search patch (patches/@xterm+addon-search+0.16.0.patch).
 *
 * Upstream 0.16 caps every search loop at `buffer.active.baseY + rows` — the
 * viewport bottom. That is only equal to the buffer end when the viewport is
 * parked at the bottom; scrolled up (browsing history — the normal moment to
 * search), find()/findNext/findPrevious never see matches below the viewport
 * edge, so highlight-all covers a slice, Next/Prev wrap inside it, and the
 * regions revealed by later scrolling highlight nothing: issue #1266's
 * "search isn't functional / doesn't update with scrolling".
 *
 * The patch swaps the cap for `buffer.active.length` (the true buffer end) in
 * all five scan bounds. Same guard shape as atlasCoherence's addon-webgl
 * probe: if the patch silently stops applying (version drift, hybrid
 * node_modules), this fails instead of the bug reappearing in the field.
 */
describe('installed addon-search 0.16.0 search-range patch', () => {
  const FILES = [
    'node_modules/@xterm/addon-search/lib/addon-search.js',
    'node_modules/@xterm/addon-search/lib/addon-search.mjs',
  ] as const;

  it('is the version the patch was cut against', () => {
    const pkg = JSON.parse(
      readFileSync('node_modules/@xterm/addon-search/package.json', 'utf8'),
    ) as { version: string };
    expect(pkg.version).toBe('0.16.0');
  });

  it.each(FILES)('%s scans to the buffer end, not the viewport bottom', (file) => {
    const src = readFileSync(file, 'utf8');
    // The capped bound must be gone from every scan loop...
    expect(src).not.toContain('baseY+this._terminal.rows');
    // ...and the patched bound must be present in the forward scan loops and
    // the findPrevious bottom anchor + wrap compare — the shapes the patch
    // rewrites. (Loop variable letters differ between the .js and .mjs
    // minified builds, so match on the bound itself.)
    expect(src).toMatch(/[hps]<this\._terminal\.buffer\.active\.length&&/);
    expect(src).toContain('!==this._terminal.buffer.active.length-1');
  });
});
