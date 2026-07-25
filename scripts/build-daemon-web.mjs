#!/usr/bin/env node
// Build the wmux web frontend into a single self-contained page.
//
// wmux web serves a read-only-by-default browser terminal FROM THE DAEMON.
// Rather than run a bundler, we inline the shipped @xterm/xterm UMD build +
// css together with our own app.js/styles.css into one `terminal.html`. The
// daemon reads that file at runtime (WebTerminalServer.loadAssets) from a
// path resolved relative to its bundle, so `dist/daemon-web/` must sit as a
// sibling of `dist/daemon-bundle/` (forge extraResource ships it the same way).
//
// Output (dist/daemon-web/):
//   terminal.html          — the whole app, zero external requests (CSP-safe)
//   manifest.webmanifest    — PWA manifest
//   sw.js                   — service worker (secure-context only)
//   icon-192.png / icon-512.png — app icons (reused from assets/icon.png)
//   csp.json                — the hashes of every inlined block, for audit
//
// CSP (M3 §6): the daemon serves this page under a `script-src` pinned to the
// sha256 of each block inlined below, because M3 made the credential an XSS
// could steal durable. The SERVER derives that header from the bytes of
// terminal.html itself (src/daemon/web/webCsp.ts) so the two can never drift;
// what happens HERE is the gate — this script recomputes the hashes from the
// file it just wrote and REFUSES TO SHIP a page whose blocks cannot be named by
// a policy (an unhashable block, an external `src`, a leftover marker). A page
// that ships with a mismatched CSP is not a degraded page: it blocks its own
// bundle and the browser terminal is a blank screen.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const frontendDir = join(repoRoot, 'src', 'daemon', 'web', 'frontend');
const outDir = join(repoRoot, 'dist', 'daemon-web');

function read(p) {
  if (!existsSync(p)) {
    console.error(`build-daemon-web: source not found: ${p}`);
    process.exit(1);
  }
  return readFileSync(p, 'utf8');
}

// A function replacer avoids String.replace's `$` special-pattern handling,
// which would otherwise corrupt any `$&`/`$1` sequence inside the xterm bundle.
function inject(html, marker, content) {
  if (!html.includes(marker)) {
    console.error(`build-daemon-web: marker ${marker} missing from index.html`);
    process.exit(1);
  }
  return html.replace(marker, () => content);
}

const xtermJs = read(join(repoRoot, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'));
const xtermCss = read(join(repoRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'));
const appCss = read(join(frontendDir, 'styles.css'));
const appJs = read(join(frontendDir, 'app.js'));
// Inlined AHEAD of app.js: it publishes `wmuxAttentionFormat` on the global,
// which app.js calls at notification time. Kept a separate file (rather than a
// function inside app.js) so the unit tests can evaluate the formatting rule
// without a DOM.
const attentionFormatJs = read(join(frontendDir, 'attentionFormat.js'));
// Same reason, same shape: it publishes `pairQuery` on the global and app.js
// reads it when /pair loads. Separate so the parsing — which decides whether a
// scanned code is auto-submitted or lands on the manual form — is unit-tested
// against the exact bytes the phone runs.
const pairQueryJs = read(join(frontendDir, 'pairQuery.js'));
let html = read(join(frontendDir, 'index.html'));

html = inject(html, '/*__XTERM_CSS__*/', xtermCss);
html = inject(html, '/*__APP_CSS__*/', appCss);
html = inject(html, '/*__XTERM_JS__*/', xtermJs);
html = inject(html, '/*__ATTENTION_FORMAT_JS__*/', attentionFormatJs);
html = inject(html, '/*__PAIR_QUERY_JS__*/', pairQueryJs);
html = inject(html, '/*__APP_JS__*/', appJs);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'terminal.html'), html);
copyFileSync(join(frontendDir, 'manifest.webmanifest'), join(outDir, 'manifest.webmanifest'));
// Stamp the service worker with a hash of the page it caches. Without this the
// cache name is a constant, so an installed PWA keeps serving the build it first
// saw and no update can ever reach it.
const buildId = createHash('sha256').update(html).digest('hex').slice(0, 12);
const sw = read(join(frontendDir, 'sw.js')).replace('__BUILD_ID__', () => buildId);
if (sw.includes('__BUILD_ID__')) {
  console.error('build-daemon-web: sw.js build stamp not substituted');
  process.exit(1);
}
writeFileSync(join(outDir, 'sw.js'), sw);

// Reuse the app icon for both declared PWA sizes (browsers scale). A dedicated
// 192 is a follow-up polish; one 512 PNG already satisfies installability.
const iconSrc = join(repoRoot, 'assets', 'icon.png');
if (existsSync(iconSrc)) {
  copyFileSync(iconSrc, join(outDir, 'icon-512.png'));
  copyFileSync(iconSrc, join(outDir, 'icon-192.png'));
} else {
  console.warn('build-daemon-web: assets/icon.png not found — PWA icons skipped');
}

// --- CSP gate ---------------------------------------------------------------
// Everything below reads the file BACK OFF DISK. Hashing the `html` variable
// still in memory would prove only that this script is self-consistent; the
// server reads the file, so the file is what has to be provably hashable.

const compiledCsp = join(repoRoot, 'dist', 'daemon', 'daemon', 'web', 'webCsp.js');
if (!existsSync(compiledCsp)) {
  console.error(
    'build-daemon-web: dist/daemon/daemon/web/webCsp.js not found — the CSP gate needs the ' +
    'compiled daemon sources. Run `tsc -p tsconfig.daemon.json` first (npm run build:daemon does).',
  );
  process.exit(1);
}
const { buildWebCsp, extractInlineBlocks, cspHash } = createRequire(import.meta.url)(compiledCsp);

const written = readFileSync(join(outDir, 'terminal.html'), 'utf8');
const blocks = extractInlineBlocks(written);
const fail = (msg) => {
  console.error(`build-daemon-web: CSP gate failed — ${msg}`);
  process.exit(1);
};

// The page inlines four scripts (xterm, attentionFormat, pairQuery, app) and
// one style block (xterm css + our css). A count that moved means index.html
// grew or lost a block and nobody re-read this gate; refuse rather than guess
// which. Raised 3 → 4 when pairQuery.js was added for QR pairing: the policy
// itself is derived from the served bytes, so an extra block is hashed like the
// others — the count is here to make the change deliberate, not to cap it.
if (blocks.scripts.length !== 4) fail(`expected 4 inline <script> blocks, found ${blocks.scripts.length}`);
if (blocks.styles.length !== 1) fail(`expected 1 inline <style> block, found ${blocks.styles.length}`);
if (blocks.externalRefs.length > 0) {
  fail(
    `the page references sub-resources that \`default-src 'none'\` will block: ` +
    `${blocks.externalRefs.join(', ')}`,
  );
}
for (const [i, body] of blocks.scripts.entries()) {
  if (body.trim().length === 0) fail(`inline <script> #${i + 1} is empty — a marker did not substitute`);
}
for (const [i, body] of blocks.styles.entries()) {
  if (body.trim().length === 0) fail(`inline <style> #${i + 1} is empty — a marker did not substitute`);
}
if (/\/\*__[A-Z_]+__\*\//.test(written)) {
  fail('an inline marker survived into the built page');
}

const scriptHashes = blocks.scripts.map(cspHash);
const styleHashes = blocks.styles.map(cspHash);
const policy = buildWebCsp(written);

// The gate proper: every hash this build computed must actually appear in the
// header the server will send for this exact file. `style-src` is deliberately
// not hash-pinned (see webCsp.ts — xterm injects <style> elements whose content
// only exists at runtime), so the style hash is recorded but not required in
// the policy; the SCRIPT hashes are, and a missing one is a blank terminal.
for (const h of scriptHashes) {
  if (!policy.includes(h)) fail(`script hash ${h} is inlined in the page but missing from the policy`);
}
const policyHashes = policy.match(/'sha256-[A-Za-z0-9+/=]+'/g) ?? [];
for (const h of policyHashes) {
  if (!scriptHashes.includes(h)) fail(`policy names ${h}, which no inlined block produces`);
}
if (policyHashes.length !== scriptHashes.length) {
  fail(`policy names ${policyHashes.length} hashes for ${scriptHashes.length} inlined scripts`);
}

writeFileSync(
  join(outDir, 'csp.json'),
  `${JSON.stringify({ buildId, policy, scriptHashes, styleHashes }, null, 2)}\n`,
);

const kb = (readFileSync(join(outDir, 'terminal.html')).length / 1024).toFixed(0);
console.log(`build-daemon-web: wrote dist/daemon-web/terminal.html (${kb} KB, build ${buildId}) + manifest + sw + icons`);
console.log(`build-daemon-web: CSP gate ok — ${scriptHashes.length} script hashes, ${styleHashes.length} style hash recorded`);
