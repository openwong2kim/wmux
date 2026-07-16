import { describe, expect, it, vi } from 'vitest';

// B0 regression: the seam must NOT initialize playwright-core at import time
// — the whole point of the lazy chunk is that the idle MCP child never pays
// for the library. In the vitest layout there is no playwright-chunk.js next
// to the transpiled module, so loadPlaywright() exercises the node_modules
// fallback path.
describe('lazyPlaywright', () => {
  it('loads playwright-core on first call, not at import', async () => {
    vi.resetModules();
    const seam = await import('../lazyPlaywright');
    expect(seam.__isPlaywrightLoaded()).toBe(false);

    const pw = seam.loadPlaywright();
    expect(seam.__isPlaywrightLoaded()).toBe(true);
    expect(typeof pw.chromium.connectOverCDP).toBe('function');
    expect(pw.devices).toBeTruthy();

    // Second call returns the cached module.
    expect(seam.loadPlaywright()).toBe(pw);
  });
});
