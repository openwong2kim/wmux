import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Inline images in the web client (#1641). There is no bundler: the addon only
// runs if a marker inlines it, and app.js only uses it if both terminal paths
// load it. The options are the part that matters for a viewer.
const root = join(__dirname, '..', '..', '..', '..');
const html = readFileSync(join(root, 'src', 'daemon', 'web', 'frontend', 'index.html'), 'utf8');
const app = readFileSync(join(root, 'src', 'daemon', 'web', 'frontend', 'app.js'), 'utf8');
const build = readFileSync(join(root, 'scripts', 'build-daemon-web.mjs'), 'utf8');

describe('web client inline images', () => {
  it('inlines @xterm/addon-image right after xterm', () => {
    expect(html.indexOf('/*__ADDON_IMAGE_JS__*/')).toBeGreaterThan(html.indexOf('/*__XTERM_JS__*/'));
    expect(html.indexOf('/*__ADDON_IMAGE_JS__*/')).toBeLessThan(html.indexOf('/*__APP_JS__*/'));
    expect(build).toContain("inject(html, '/*__ADDON_IMAGE_JS__*/', addonImageJs)");
  });

  it('loads the addon into the 1-up terminal and every tile', () => {
    expect(app).toContain('term.open(termHost);\n      loadImageAddon(term);');
    expect(app).toContain('tile.term.open(host);\n    loadImageAddon(tile.term);');
  });

  it('never answers size queries and keeps mobile limits', () => {
    expect(app).toContain('enableSizeReports: false');
    expect(app).toContain('sixelSupport: sixelWasmAllowed');
    expect(app).toMatch(/storageLimit: \d+\b/);
    expect(Number(/storageLimit: (\d+)/.exec(app)?.[1])).toBeLessThanOrEqual(32);
  });
});
