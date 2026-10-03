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

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { build as viteBuild } from 'vite';

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
// Inline images (#1641): the addon's UMD build publishes `ImageAddon` on the
// global. Inlined right after xterm so app.js can load it into every terminal.
// Both of its decoders are WebAssembly; inlineImages.js probes before loading.
const addonImageJs = read(join(repoRoot, 'node_modules', '@xterm', 'addon-image', 'lib', 'addon-image.js'));
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
// Same reason again: it publishes `wmuxTouchScroll` on the global and app.js
// attaches it to every terminal it creates. Separate so the gesture arithmetic
// — sub-cell accumulation and the axis lock, which is where a touch handler
// actually goes wrong — is unit-tested against the exact bytes the phone runs,
// without evaluating the whole app IIFE.
const touchScrollJs = read(join(frontendDir, 'touchScroll.js'));
// Kitty keyboard-protocol negotiation fold. Separate so the state machine is
// unit tested against the exact bytes the pane emits, without a DOM or xterm.
const keyboardProtocolJs = read(join(frontendDir, 'keyboardProtocol.js'));
// Copy / paste / newline key decisions. Separate so the chord table is unit
// tested against the exact bytes the phone runs, without a DOM or xterm.
const copyPasteKeysJs = read(join(frontendDir, 'copyPasteKeys.js'));
// Terminal behaviour shared with the desktop renderer (src/shared/terminal).
// Bundled from the TypeScript source rather than copied into frontend/, so the
// phone runs the exact module useTerminal.ts imports. Publishes
// `wmuxTerminalShared` on the global; inlined ahead of app.js, which reads it.
// es2017 keeps the output parseable by older mobile Safari.
const terminalSharedEntry = join(repoRoot, 'src', 'shared', 'terminal', 'webTerminalShared.ts');
read(terminalSharedEntry);
const terminalSharedJs = buildSync({
  entryPoints: [terminalSharedEntry],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'wmuxTerminalShared',
  platform: 'browser',
  target: 'es2017',
  minify: true,
  logLevel: 'error',
}).outputFiles[0].text;
// Inline-image gate (#1641): the wasm probe and the addon options. Separate so
// "no wasm, no addon" is unit tested against the exact bytes the phone runs.
const inlineImagesJs = read(join(frontendDir, 'inlineImages.js'));
let html = read(join(frontendDir, 'index.html'));

html = inject(html, '/*__XTERM_CSS__*/', xtermCss);
html = inject(html, '/*__APP_CSS__*/', appCss);
html = inject(html, '/*__XTERM_JS__*/', xtermJs);
html = inject(html, '/*__ADDON_IMAGE_JS__*/', addonImageJs);
html = inject(html, '/*__ATTENTION_FORMAT_JS__*/', attentionFormatJs);
html = inject(html, '/*__PAIR_QUERY_JS__*/', pairQueryJs);
html = inject(html, '/*__TOUCH_SCROLL_JS__*/', touchScrollJs);
html = inject(html, '/*__KEYBOARD_PROTOCOL_JS__*/', keyboardProtocolJs);
html = inject(html, '/*__KEYS_JS__*/', copyPasteKeysJs);
html = inject(html, '/*__TERMINAL_SHARED_JS__*/', terminalSharedJs);
html = inject(html, '/*__INLINE_IMAGES_JS__*/', inlineImagesJs);
html = inject(html, '/*__APP_JS__*/', appJs);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'terminal.html'), html);
copyFileSync(join(frontendDir, 'manifest.webmanifest'), join(outDir, 'manifest.webmanifest'));

// --- / (app.html): the desktop renderer's components in the browser ----------
// vite.web.config.ts builds src/renderer/web/main.tsx into ONE classic script
// (es2022) + ONE stylesheet; the fonts it references stay files under
// /app/assets/, served same-origin by the daemon (`font-src 'self'`). Ahead of
// the bundle sits boot.ts at es2017: it installs the credential and the
// deny-by-default window.electronAPI, and sends a browser that cannot parse the
// bundle to the classic page at `/classic` (terminal.html). See
// docs/phone-client-contract.md "Browser app (`/`)".
const appBuildDir = join(repoRoot, 'dist', 'daemon-web-app');
const appAssetsOut = join(outDir, 'app-assets');
const buildFail = (msg) => {
  console.error(`build-daemon-web: /app build failed — ${msg}`);
  process.exit(1);
};
const viteStarted = Date.now();
await viteBuild({ configFile: join(repoRoot, 'vite.web.config.ts'), logLevel: 'warn' });
const viteMs = Date.now() - viteStarted;
const webAppJs = read(join(appBuildDir, 'app.js'));
const webAppCss = read(join(appBuildDir, 'app.css'));
// An inline block ends at the first `</script` / `</style`, and `<!--` inside a
// script switches the tokenizer into escape states: either would cut the page
// short while every hash still "matched" the truncated body.
if (/<\/script|<!--/i.test(webAppJs)) buildFail('the bundle contains `</script` or `<!--`');
if (/<\/style/i.test(webAppCss)) buildFail('the stylesheet contains `</style`');
// import.meta cannot exist in a classic script; Rollup would polyfill it from
// document.currentScript.src, which is empty for an inline block.
if (/import\.meta/.test(webAppJs)) buildFail('the bundle still reads import.meta');
// Every url() in the stylesheet must be one of our own emitted fonts: the CSP
// gate below only sees <script src>/<link>, not what a stylesheet pulls in.
const emitted = existsSync(join(appBuildDir, 'assets')) ? readdirSync(join(appBuildDir, 'assets')) : [];
// The daemon's font route serves exactly the names WEB_APP_FONT_FILE accepts;
// a font it would refuse must not ship (it would 404 in every browser).
const compiledCspForFonts = join(repoRoot, 'dist', 'daemon', 'daemon', 'web', 'webCsp.js');
if (!existsSync(compiledCspForFonts)) buildFail('dist/daemon/daemon/web/webCsp.js not found — run `tsc -p tsconfig.daemon.json` first');
const { WEB_APP_FONT_FILE } = createRequire(import.meta.url)(compiledCspForFonts);
for (const f of emitted) {
  if (!/\.woff2$/.test(f)) buildFail(`unexpected emitted asset ${f} (only fonts may ship)`);
  if (!WEB_APP_FONT_FILE.test(f)) buildFail(`font ${f} does not match the daemon's font route (${WEB_APP_FONT_FILE})`);
}
for (const m of webAppCss.matchAll(/url\(\s*['"]?([^'")]+)/g)) {
  const ref = m[1];
  if (ref.startsWith('data:')) continue;
  const name = ref.startsWith('/app/assets/') ? ref.slice('/app/assets/'.length) : null;
  if (!name || !emitted.includes(name)) buildFail(`stylesheet references ${ref}, which the daemon does not serve`);
}
rmSync(appAssetsOut, { recursive: true, force: true });
mkdirSync(appAssetsOut, { recursive: true });
for (const f of emitted) copyFileSync(join(appBuildDir, 'assets', f), join(appAssetsOut, f));
const webBootEntry = join(repoRoot, 'src', 'renderer', 'web', 'boot.ts');
read(webBootEntry);
const webBootJs = buildSync({
  entryPoints: [webBootEntry],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2017',
  minify: true,
  logLevel: 'error',
}).outputFiles[0].text;
let appHtml = read(join(frontendDir, 'app.html'));
appHtml = inject(appHtml, '/*__WEB_APP_CSS__*/', webAppCss);
appHtml = inject(appHtml, '/*__WEB_APP_BOOT_JS__*/', webBootJs);
appHtml = inject(appHtml, '/*__WEB_APP_JS__*/', webAppJs);
writeFileSync(join(outDir, 'app.html'), appHtml);

// Stamp the service worker with a hash of the pages it caches. Without this the
// cache name is a constant, so an installed PWA keeps serving the build it first
// saw and no update can ever reach it.
const buildId = createHash('sha256').update(html).update(appHtml).digest('hex').slice(0, 12);
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

function gatePage(file, expectedScripts, cspOptions) {
  const written = readFileSync(join(outDir, file), 'utf8');
  const blocks = extractInlineBlocks(written);
  const fail = (msg) => {
    console.error(`build-daemon-web: CSP gate failed (${file}) — ${msg}`);
    process.exit(1);
  };

  // The page inlines ten scripts (xterm, addon-image, attentionFormat,
  // pairQuery, touchScroll, keyboardProtocol, copyPasteKeys, terminalShared,
  // inlineImages, app) and one style block (xterm css + our css).
  // A count that moved means index.html grew or lost a block and nobody re-read
  // this gate; refuse rather than guess which. Raised 3 → 4 when pairQuery.js
  // was added for QR pairing, 4 → 5 when touchScroll.js was added for #890,
  // 5 → 6 when copyPasteKeys.js was added for browser copy/paste, 6 → 7 when
  // keyboardProtocol.js was added for the kitty-negotiation gate, 7 → 8 when
  // the shared terminal bundle (src/shared/terminal) was added, 8 → 10 when
  // @xterm/addon-image and its inlineImages.js gate were added for inline
  // images (#1641): the policy itself is derived from the served bytes, so an
  // extra block is hashed like the others — the count is here to make the
  // change deliberate, not to cap it.
  //
  // app.html (/app) inlines two: the es2017 boot script and the es2022 bundle.
  if (blocks.scripts.length !== expectedScripts) {
    fail(`expected ${expectedScripts} inline <script> blocks, found ${blocks.scripts.length}`);
  }
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
  const policy = buildWebCsp(written, cspOptions);

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
  return { policy, scriptHashes, styleHashes };
}

// Same options WebTerminalServer.loadAssets passes for each page.
const terminalGate = gatePage('terminal.html', 10, { wasm: true });
const appGate = gatePage('app.html', 2);

writeFileSync(
  join(outDir, 'csp.json'),
  `${JSON.stringify({ buildId, ...terminalGate, app: appGate }, null, 2)}\n`,
);

const kb = (readFileSync(join(outDir, 'terminal.html')).length / 1024).toFixed(0);
const appKb = (readFileSync(join(outDir, 'app.html')).length / 1024).toFixed(0);
const fontKb = (emitted.reduce((n, f) => n + readFileSync(join(appAssetsOut, f)).length, 0) / 1024).toFixed(0);
console.log(`build-daemon-web: wrote dist/daemon-web/terminal.html (${kb} KB, build ${buildId}) + manifest + sw + icons`);
console.log(`build-daemon-web: wrote dist/daemon-web/app.html (${appKb} KB) + ${emitted.length} fonts (${fontKb} KB) in ${viteMs} ms`);
console.log(`build-daemon-web: CSP gate ok — terminal.html ${terminalGate.scriptHashes.length} script hashes, app.html ${appGate.scriptHashes.length}`);
