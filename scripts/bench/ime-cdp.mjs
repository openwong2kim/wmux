// Korean IME composition through CDP (Input.imeSetComposition / insertText),
// no OS typing: what the terminal engine does with a composition — where the
// preedit draws, what reaches the pty on commit, and that keys pressed while
// composing do not leak the partial syllable. Screenshots per step into --out.
//   node scripts/bench/ime-cdp.mjs --cdp-port <port> --engine xterm|wongtty --out <dir> [--claude-cmd "<cmd>"]
// The engine must already be selected (engine-compare.mjs switches it).
import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const { chromium } = await import('playwright-core');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${args['cdp-port']}`);
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('index.html'));
const cdp = await page.context().newCDPSession(page);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = args.out; fs.mkdirSync(out, { recursive: true });
const engine = args.engine;
const target = args['claude-cmd'] ? 'claude' : 'shell';

await page.evaluate(() => {
  if (window.__ime) return;
  window.__ime = { cap: '' };
  window.electronAPI.pty.onData((_id, data, replay) => { if (!replay) window.__ime.cap = (window.__ime.cap + data).slice(-4096); });
});
const sent = [];
page.on('console', () => {});
const input = page.locator('textarea[aria-label="Terminal input"]').first();
const shot = (name) => page.screenshot({ path: `${out}/${engine}-${target}-${name}.png` });
const compose = (text) => cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
const commit = (text) => cdp.send('Input.insertText', { text });
const key = (k) => page.keyboard.press(k);
const cap = () => page.evaluate(() => window.__ime.cap);
const clearCap = () => page.evaluate(() => { window.__ime.cap = ''; });

await input.focus();
if (target === 'claude') {
  await page.keyboard.type(args['claude-cmd']); await key('Enter'); await sleep(9000);
} else {
  await page.keyboard.type("clear; printf '\\033[3J'"); await key('Enter'); await sleep(800);
}
const r = { engine, target };

// 1. Composition caret: 가 → 간 while composing, screenshot (preedit at the prompt).
await clearCap();
await compose('ㄱ'); await compose('가'); await compose('간');
await sleep(400); await shot('1-composing');
r.leakWhileComposing = JSON.stringify(await cap());
// 2. Backspace on the composing syllable: the IME turns 간 back into 가 (no DEL to the pty).
await compose('가'); await sleep(200);
r.leakAfterBackspace = JSON.stringify(await cap());
// commit 가, then 나다 as the next syllables, then mixed ASCII
await commit('가'); await compose('ㄴ'); await compose('나'); await commit('나');
await compose('다'); await commit('다');
await page.keyboard.type(' abc ');
await compose('라'); await commit('라');
await sleep(400); await shot('2-committed');
r.afterCommit = JSON.stringify(await cap());
// 3. Enter while composing: the IME commits 마 first, then Enter goes through.
await clearCap();
await compose('마');
await key('Enter');
await sleep(800);
r.enterWhileComposing = JSON.stringify(await cap());
await shot('3-enter');
// 4. Arrow while composing: commit 바, then the cursor moves left.
await clearCap();
await compose('바'); await key('ArrowLeft'); await sleep(400);
r.arrowWhileComposing = JSON.stringify(await cap());
await shot('4-arrow');
await key('Control+u');
if (target === 'claude') { await key('Escape'); await key('Control+c'); await sleep(300); await key('Control+c'); await sleep(2500); }
console.log(JSON.stringify(r));
await browser.close();
