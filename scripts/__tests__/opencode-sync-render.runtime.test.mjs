/* eslint-disable no-useless-escape -- escaped slashes keep inline scripts from closing the page template */
// Runtime regression for rapid OpenCode-style DEC 2026 full-screen frames.
//
// xterm 6.0 defers a completed synchronized frame through requestAnimationFrame.
// If the next frame opens before that callback runs, the paint is skipped and
// the screen only catches up on xterm's one-second safety timeout. OpenCode's
// animated TUI emits frames quickly enough to keep that failure active.
// Upstream tracking: https://github.com/xtermjs/xterm.js/issues/6071

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const xtermJs = readFileSync(join(root, 'node_modules/@xterm/xterm/lib/xterm.js'), 'utf8');
const xtermCss = readFileSync(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8');
const webglJs = readFileSync(join(root, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js'), 'utf8');

const pageHtml = `<!doctype html>
<meta charset="utf-8"><title>wmux OpenCode sync render regression</title>
<style>${xtermCss}</style>
<div id="terminal" style="width:900px;height:500px"></div>
<script>${xtermJs}<\/script>
<script>${webglJs}<\/script>
<script>
  const term = new Terminal({ cols: 100, rows: 24, cursorBlink: false });
  term.open(document.getElementById('terminal'));
  term.loadAddon(new WebglAddon.WebglAddon());

  const write = (data) => new Promise((resolve) => term.write(data, resolve));
  const frameBody = (n) => {
    const rows = [];
    for (let y = 0; y < 24; y++) rows.push(('frame ' + n + ' row ' + y).padEnd(90, '.'));
    return '\\x1b[H\\x1b[2J' + rows.join('\\r\\n');
  };

  window.runProbe = async () => {
    await write('\\x1b[?2026h' + frameBody(-1));
    await write('\\x1b[?2026l');
    await new Promise((resolve) => setTimeout(resolve, 80));

    let renders = 0;
    const sub = term.onRender(() => { renders++; });
    const sent = 30;
    for (let n = 0; n < sent; n++) {
      await write('\\x1b[?2026h' + frameBody(n));
      await write('\\x1b[?2026l');
    }
    const rendersDuringStream = renders;
    await new Promise((resolve) => setTimeout(resolve, 80));
    sub.dispose();

    const buffer = term.buffer.active;
    let visibleText = '';
    for (let y = 0; y < term.rows; y++) {
      visibleText += buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '';
    }
    return {
      sent,
      rendersDuringStream,
      rendersAfterSettle: renders,
      finalFrameVisible: visibleText.includes('frame ' + (sent - 1)),
      webglCanvasCount: document.querySelectorAll('.xterm canvas').length,
    };
  };
<\/script>`;

it('paints completed synchronized frames while OpenCode-style output remains active', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(pageHtml);
  });
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    // Windows is wmux's supported contributor platform and ships Edge, so a
    // fresh clone does not need a separate Playwright browser download.
    const channel = process.platform === 'win32'
      ? 'msedge'
      : process.env.CI ? 'chrome' : undefined;
    browser = await chromium.launch({
      channel,
      args: ['--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => typeof window.runProbe === 'function');
    const result = await page.evaluate(() => window.runProbe());

    expect(result.sent).toBeGreaterThanOrEqual(10);
    expect(result.rendersDuringStream).toBeGreaterThanOrEqual(Math.floor(result.sent * 0.75));
    expect(result.finalFrameVisible).toBe(true);
    expect(result.webglCanvasCount).toBeGreaterThan(0);
  } finally {
    await browser?.close();
    server.close();
  }
}, 30_000);
