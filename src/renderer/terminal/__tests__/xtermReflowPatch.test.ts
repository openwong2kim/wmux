import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/**
 * Guards the reflow hunk in patches/@xterm+xterm+6.1.0-beta.336.patch and
 * patches/@xterm+headless+6.1.0-beta.334.patch (#3372).
 *
 * xterm's Buffer._reflowSmaller writes a narrowing's rows bottom-up, and the
 * inner loop that places one line's new rows does not stop at index 0. On a
 * full scrollback, when the rows pushed off the top cut inside that line's new
 * rows, the rest go to negative indexes, which CircularList maps onto the
 * bottom rows: the pane's last rows turn into stale wrapped rows. The hunk
 * stops that loop at index 0. @xterm/xterm is the renderer's terminal;
 * @xterm/headless is the daemon's xterm fallback and the snapshot reference.
 *
 * Same guard shape as searchAddonPatch.test.ts: if the patch stops applying
 * (version drift, hybrid node_modules), this fails instead of the bug coming
 * back. RustReflowParity's full-scrollback cases check the behavior.
 */
const PACKAGES = [
  { name: '@xterm/xterm', version: '6.1.0-beta.336', files: ['lib/xterm.js', 'lib/xterm.mjs'] },
  { name: '@xterm/headless', version: '6.1.0-beta.334', files: ['lib-headless/xterm-headless.js', 'lib-headless/xterm-headless.mjs'] },
] as const;

// The loop over one line's new rows, with or without the stop at index 0.
// Minified names differ between bundles, so the pattern back-references them.
const PATCHED = /for\(let ([\w$]+)=([\w$]+)\.newLines\.length-1;\1>=0&&([\w$]+)>=0;\1--\)this\.lines\.set\(\3--,\2\.newLines\[\1\]\)/g;
const UNPATCHED = /for\(let ([\w$]+)=([\w$]+)\.newLines\.length-1;\1>=0;\1--\)this\.lines\.set\([\w$]+--,\2\.newLines\[\1\]\)/;

describe.each(PACKAGES)('installed $name reflow patch', ({ name, version, files }) => {
  it('is the version the patch was cut against', () => {
    const pkg = JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')) as { version: string };
    expect(pkg.version).toBe(version);
  });

  it.each(files)('%s stops placing a line\'s new rows at index 0', (file) => {
    const src = readFileSync(`node_modules/${name}/${file}`, 'utf8');
    expect(src).not.toMatch(UNPATCHED);
    expect(src.match(PATCHED)).toHaveLength(1);
  });
});
