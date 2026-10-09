/** Scoped component/browser QA, not native Electron E2E. Production settings,
 * JevFleetFastPath and CommanderSessionManager; dummy-only loopback bridge.
 * No real provider, credential lookup, persistent settings or external data. */
/* global globalThis */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(repo, 'scripts/fixtures/jev-ui-e2e');
const flags = new Set(process.argv.slice(2));
const mode = flags.has('--build-only') ? 'build' : flags.has('--server-check') ? 'server-check'
  : flags.has('--serve') ? 'serve' : 'browser';
const temp = await mkdtemp(path.join(tmpdir(), 'wmux-jev-ui-'));
const publicDir = path.join(temp, 'public');
let server;
let browser;
let backend;
const originalFetch = globalThis.fetch;

try {
  await build({
    absWorkingDir: repo, entryPoints: [path.join(fixture, 'backend.ts')],
    bundle: true, platform: 'node', format: 'esm', outfile: path.join(temp, 'backend.mjs'),
  });
  const tailwindConfig = require(path.join(repo, 'tailwind.config.js'));
  await build({
    absWorkingDir: repo, entryPoints: [path.join(fixture, 'renderer.tsx')],
    bundle: true, platform: 'browser', format: 'esm', outfile: path.join(publicDir, 'app.js'),
    jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'file' }, assetNames: 'assets/[name]-[hash]',
    plugins: [{
      name: 'isolated-english-translator',
      setup(plugin) {
        plugin.onResolve({ filter: /(?:^|\/)hooks\/useT$/ }, () => ({ path: 'useT', namespace: 'jev-test' }));
        plugin.onLoad({ filter: /.*/, namespace: 'jev-test' }, () => ({
          contents: `import { en } from ${JSON.stringify(path.join(repo, 'src/renderer/i18n/locales/en.ts'))}; export const useT = () => (key) => en[key] ?? key;`,
          loader: 'js', resolveDir: repo,
        }));
      },
    }, {
      name: 'production-style-tokens',
      setup(plugin) {
        plugin.onLoad({ filter: /\.css$/ }, async (args) => ({
          contents: (await postcss([tailwind({ ...tailwindConfig,
            content: [path.join(repo, 'src/renderer/**/*.{ts,tsx}'), path.join(fixture, '*.tsx')],
          })]).process(await readFile(args.path, 'utf8'), { from: args.path })).css,
          loader: 'css', resolveDir: path.dirname(args.path),
        }));
      },
    }],
  });
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><html data-theme="tint" lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Jev synthetic browser QA</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  if (mode === 'build') {
    console.log(JSON.stringify({ mode, passed: true, browserRun: false, filesCleanedOnExit: true }));
  } else {
    const { createJevHarness, DUMMY_KEY } = await import(pathToFileURL(path.join(temp, 'backend.mjs')).href);
    backend = createJevHarness();
    let base = '';
    const json = (res, value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    server = createServer(async (req, res) => {
      try {
        if (req.headers.host !== new URL(base).host || (req.headers.origin && req.headers.origin !== base)) {
          json(res, { error: 'Loopback origin required' }, 403); return;
        }
        const url = new URL(req.url, base);
        if (url.pathname.startsWith('/api/')) {
          if (req.method === 'GET' && url.pathname === '/api/status') { json(res, backend.status()); return; }
          if (req.method === 'GET' && url.pathname === '/api/counts') { json(res, backend.counts()); return; }
          if (req.method !== 'POST') { json(res, { error: 'Unknown synthetic endpoint' }, 404); return; }
          let raw = '';
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 8192) { json(res, { error: 'Synthetic request too large' }, 413); return; }
          }
          const body = JSON.parse(raw);
          if (url.pathname === '/api/configure') {
            // Holds the bridge response briefly to expose repeated-submit races.
            const result = backend.configure(body);
            await new Promise((resolve) => setTimeout(resolve, 60));
            json(res, result); return;
          }
          if (url.pathname === '/api/scenario') { json(res, backend.scenario(body.scenario)); return; }
          if (url.pathname === '/api/send' && typeof body.text === 'string') { json(res, await backend.send(body.text)); return; }
          json(res, { error: 'Unknown synthetic endpoint' }, 404); return;
        }
        if (req.method !== 'GET') { json(res, { error: 'GET required' }, 405); return; }
        const filename = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
        const target = path.resolve(publicDir, filename);
        if (!target.startsWith(`${publicDir}${path.sep}`)) { json(res, { error: 'Invalid path' }, 403); return; }
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
        res.writeHead(200, {
          'Content-Type': types[path.extname(target)] ?? 'application/octet-stream',
          'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          'Cache-Control': 'no-store',
        });
        res.end(await readFile(target));
      } catch {
        // Never include request data, credentials or raw exception text.
        if (!res.headersSent) json(res, { error: 'Synthetic request rejected' }, 400);
        else res.end();
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    // The production service receives an injected fake fetch. This extra fence
    // also rejects accidental external fetches in the Node harness itself.
    globalThis.fetch = (url, init) => {
      assert.equal(new URL(url instanceof Request ? url.url : url).origin, base, 'External network forbidden in Jev harness');
      return originalFetch(url, init);
    };
    const request = async (endpoint, body) => {
      const response = await fetch(`${base}/api/${endpoint}`, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    if (mode === 'serve') {
      console.log(JSON.stringify({ mode, url: base, dummyKey: DUMMY_KEY, browserRun: false,
        instructions: 'Use the built-in dummy key only. Ctrl+C removes temporary build files and closes the synthetic session.' }));
      await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    } else if (mode === 'server-check') {
      await checkBridge(request, DUMMY_KEY);
      console.log(JSON.stringify({ mode, passed: true, browserRun: false, counts: backend.counts() }));
    } else {
      const { chromium } = await import('playwright-core');
      // Never retry with --no-sandbox or other security-bypass flags. A launch
      // denial is a blocker, not permission to weaken the browser sandbox.
      browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, chromiumSandbox: true });
      const context = await browser.newContext({ viewport: { width: 1000, height: 1000 }, serviceWorkers: 'block' });
      const externalRequests = [];
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin !== base) {
          externalRequests.push(route.request().url()); return route.abort('blockedbyclient');
        }
        return route.continue();
      });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(base);
      await checkBrowser(page, request, DUMMY_KEY);
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(externalRequests, []);
      const screenshot = path.join(tmpdir(), 'jev-ui-e2e.png');
      await page.screenshot({ path: screenshot, fullPage: true });
      console.log(JSON.stringify({ mode: 'chromium-component-loopback', passed: true, nativeElectronRun: false,
        screenshot, counts: backend.counts(), externalRequestCount: externalRequests.length }));
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  await browser?.close();
  backend?.dispose();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await rm(temp, { recursive: true, force: true });
}

async function checkBridge(request, dummyKey) {
  assert.deepEqual(await request('status'), { enabled: false, hasKey: false });
  assert.equal((await request('send', { text: 'Fleet status' })).route, 'normal');
  assert.deepEqual(await request('configure', { apiKey: dummyKey }), { enabled: false, hasKey: true });
  assert.equal((await request('send', { text: 'Fleet status' })).route, 'normal');
  assert.equal((await request('counts')).providerRequests, 0);
  assert.deepEqual(await request('configure', { enabled: true }), { enabled: true, hasKey: true });
  assert.equal((await request('send', { text: 'Fleet status' })).route, 'local');
  for (const scenario of ['error', 'timeout', 'malformed', 'stale']) {
    await request('scenario', { scenario });
    assert.equal((await request('send', { text: 'Fleet status' })).route, 'normal', scenario);
  }
  const beforeMixed = await request('counts');
  assert.equal((await request('send', { text: 'Fleet status and delete all tasks' })).route, 'normal');
  assert.equal((await request('counts')).providerRequests, beforeMixed.providerRequests);
  assert.deepEqual(await request('configure', { clearKey: true }), { enabled: false, hasKey: false });
  assert.equal((await request('send', { text: 'Fleet status' })).route, 'normal');
  assertCounts(await request('counts'));
}

function assertCounts(counts) {
  assert.deepEqual(counts, { providerRequests: 5, normalBrainSends: 8, boardReads: 2, configurationWrites: 3 });
}

async function checkBrowser(page, request, dummyKey) {
  const key = page.getByTestId('jev-key');
  const toggle = page.getByRole('switch', { name: 'Allow Jev this session' });
  await page.waitForFunction(() => !document.querySelector('[data-testid="jev-key"]').disabled);
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.equal(await key.getAttribute('type'), 'password');
  const send = async (scenario = 'valid', text = 'Fleet status') => {
    await page.getByLabel('Synthetic scenario').selectOption(scenario);
    await page.getByLabel('Synthetic question').fill(text);
    await page.getByRole('button', { name: 'Send synthetic question' }).click();
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find((el) => el.textContent === 'Send synthetic question');
      return !button.disabled && document.querySelector('[data-testid="synthetic-answer"]').textContent;
    });
    return JSON.parse(await page.getByTestId('synthetic-answer').textContent());
  };
  assert.equal((await send()).route, 'normal');
  await key.fill(dummyKey);
  await page.getByRole('button', { name: 'Cancel key entry' }).click();
  assert.equal(await key.inputValue(), '');
  assert.equal((await request('counts')).configurationWrites, 0);
  await key.fill(dummyKey);
  await page.locator('form').evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
  await page.waitForFunction(() => !document.querySelector('[data-testid="jev-key"]').disabled);
  assert.equal((await request('counts')).configurationWrites, 1);
  assert.equal(await key.inputValue(), '');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.equal((await send()).route, 'normal');
  assert.equal((await request('counts')).providerRequests, 0);
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="jev-enable"]').getAttribute('aria-checked') === 'true');
  assert.equal((await send()).route, 'local');
  for (const scenario of ['error', 'timeout', 'malformed', 'stale']) assert.equal((await send(scenario)).route, 'normal', scenario);
  const beforeMixed = await request('counts');
  assert.equal((await send('valid', 'Fleet status and delete all tasks')).route, 'normal');
  assert.equal((await request('counts')).providerRequests, beforeMixed.providerRequests);
  await page.getByRole('button', { name: 'Clear key and turn off' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="jev-status"]').textContent.includes('No key entered'));
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.equal(await key.inputValue(), '');
  assert.equal((await send()).route, 'normal');
  assertCounts(await request('counts'));
}
