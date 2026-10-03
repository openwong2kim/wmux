import { describe, it, expect } from 'vitest';
import { buildWebCsp, cspHash, extractInlineBlocks, normalizeForHash, WEB_APP_FONT_FILE } from '../webCsp';

const page = (body: string): string =>
  `<!doctype html><html><head><style>\n.a { color: red }\n</style></head><body>${body}</body></html>`;

describe('webCsp', () => {
  it('hashes CRLF and LF forms of the same block identically', () => {
    // The rule the whole policy rests on. The HTML parser rewrites CRLF to LF
    // before the tokenizer runs, so the browser hashes LF text no matter what
    // the file holds — and terminal.html mixes both conventions. Hashing raw
    // bytes yields a header that blocks every block it meant to allow, which
    // does not degrade the terminal, it blanks it.
    const lf = "var a = 1;\nvar b = 2;\n";
    expect(cspHash(lf.replace(/\n/g, '\r\n'))).toBe(cspHash(lf));
    expect(cspHash(lf.replace(/\n/g, '\r'))).toBe(cspHash(lf));
    expect(normalizeForHash('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });

  it('names one hash per inline script and nothing else', () => {
    const html = page('<script>one();</script><script>two();</script>');
    const blocks = extractInlineBlocks(html);
    expect(blocks.scripts).toEqual(['one();', 'two();']);
    expect(blocks.styles).toEqual(['\n.a { color: red }\n']);

    const policy = buildWebCsp(html, { wasm: true });
    const scriptSrc = policy.split('; ').find((d) => d.startsWith('script-src '))!;
    expect(scriptSrc).toBe(`script-src ${cspHash('one();')} ${cspHash('two();')} 'wasm-unsafe-eval'`);
    expect(scriptSrc).not.toContain('unsafe-inline');
    // WebAssembly compilation only (#1641); JS string evaluation stays refused.
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'self'");
  });

  it('leaves style-src free of hashes, because a hash would nullify unsafe-inline', () => {
    // Per CSP3 a hash or nonce present in a directive makes 'unsafe-inline' be
    // IGNORED. `style-src 'unsafe-inline' 'sha256-…'` is therefore the BROKEN
    // spelling, not the belt-and-braces one — it would refuse xterm's runtime
    // <style> injections exactly as a hash-only directive does.
    const styleSrc = buildWebCsp(page('<script>x();</script>'))
      .split('; ')
      .find((d) => d.startsWith('style-src '))!;
    expect(styleSrc).toBe("style-src 'unsafe-inline'");
    expect(styleSrc).not.toContain('sha256-');
  });

  it('reports sub-resources that default-src none would block', () => {
    const html = page('<script src="/app.js"></script><link rel="stylesheet" href="/x.css"><script>ok();</script>');
    const blocks = extractInlineBlocks(html);
    expect(blocks.scripts).toEqual(['ok();']);
    expect(blocks.externalRefs).toEqual([
      '<script src="/app.js">',
      '<link rel="stylesheet" href="/x.css">',
    ]);
  });

  it('falls closed when there is no page to hash', () => {
    // The assets-missing 503 path. A policy carried over from the last good
    // page, or an empty script-src that some parser reads as permissive, is
    // worse than saying 'none' out loud.
    const policy = buildWebCsp(null);
    expect(policy).toContain("script-src 'none';");
    expect(policy).not.toContain('wasm-unsafe-eval');
    expect(policy).toContain("default-src 'none'");
  });

  it('serves exactly this policy for the terminal page', () => {
    // The whole header, spelled out: a directive added, dropped or loosened
    // anywhere has to change this line on purpose.
    expect(buildWebCsp(page('<script>x();</script>'), { wasm: true })).toBe(
      "default-src 'none'; " +
        `script-src ${cspHash('x();')} 'wasm-unsafe-eval'; ` +
        "style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
        "connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; " +
        "base-uri 'none'; form-action 'none'",
    );
  });

  it('gives WebAssembly only to a page that asks for it (/app does not)', () => {
    const app = buildWebCsp(page('<script>x();</script>'));
    expect(app).toContain(`script-src ${cspHash('x();')}; `);
    expect(app).not.toContain('wasm-unsafe-eval');
    expect(buildWebCsp(null, { wasm: true })).not.toContain('wasm-unsafe-eval');
  });

  it('keeps the directives the served page depends on', () => {
    // worker-src and manifest-src are not decoration: CSP falls worker-src back
    // to script-src (so a hash-pinned script-src refuses
    // navigator.serviceWorker.register) and manifest-src back to default-src
    // (so 'none' refuses the PWA manifest). Verified against real Chromium.
    const policy = buildWebCsp(page('<script>x();</script>'));
    expect(policy).toContain("worker-src 'self'");
    expect(policy).toContain("manifest-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("img-src 'self' data:");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'none'");
  });

  it('names the /app font files the build may ship and the daemon serves', () => {
    for (const ok of ['Inter-latin-8kRkwJBP.woff2', 'Inter.latin-B_x.1.woff2', 'JetBrainsMono-Be_q-A24.woff2']) {
      expect(WEB_APP_FONT_FILE.test(ok)).toBe(true);
    }
    for (const bad of ['..woff2', '.hidden.woff2', 'a/b.woff2', 'font.woff', 'x.woff2.js', '../x.woff2']) {
      expect(WEB_APP_FONT_FILE.test(bad)).toBe(false);
    }
  });
});
