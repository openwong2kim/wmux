// Issue: v3.0.0 Korean-IME input death repro rig (real OS input stack).
// Hypothesis: imeResidueGuard's programmatic `textarea.value = ''` desyncs the
// Windows Korean IME (TSF); afterwards the IME claims keydowns (keyCode 229)
// and xterm drops them — letters AND arrows die until the terminal remounts.
//
// Detection is screenshot-based: xterm renders into WebGL canvas, so
// body.innerText only ever contains the composition PREEDIT overlay, not the
// echoed buffer (first rig version false-positived on this). The screenshots
// are read by the operator; the instrumented textarea event log
// (window.__imeLog) is the mechanical evidence.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';

const CDP = process.env.CDP;
const OUT = 'D:/wmux/out-dogfood';
const CYCLES = Number(process.env.CYCLES || 8);
const TAG = process.env.TAG || 'a';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 2-set layout key mappings: ga=rk na=sk da=ek ra=fk ma=ak ba=qk sa=tk a=dk
const SYLLABLES = ['rk', 'sk', 'ek', 'fk', 'ak', 'qk', 'tk', 'dk'];

// Bare 'powershell.exe' ENOENTs on this machine (PATH lacks System32 — same
// trap portWatch hit in the X1 dogfood); resolve via SystemRoot.
const PSEXE = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
function ps(script) {
  return execFileSync(PSEXE, ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30000 });
}

function sendKeys(seq) {
  const script = `
Add-Type -Name K -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);'
function Press([int]$vk) { [W.K]::keybd_event($vk, 0, 0, 0); Start-Sleep -Milliseconds 25; [W.K]::keybd_event($vk, 0, 2, 0); Start-Sleep -Milliseconds 35 }
$map = @{ 'HANGUL' = 0x15; 'LEFT' = 0x25; 'RIGHT' = 0x27; 'ESC' = 0x1B; 'ENTER' = 0x0D; 'BSP' = 0x08; 'SPACE' = 0x20 }
foreach ($tok in '${seq}'.Split(' ')) {
  if ($tok -eq '|') { Start-Sleep -Milliseconds 120; continue }
  if ($map.ContainsKey($tok)) { Press $map[$tok]; continue }
  Press ([int][char]$tok.ToUpper())
}
`;
  ps(script);
}

function focusWmuxWindow() {
  return ps(`
Add-Type -Name F -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);'
$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) { [W.F]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [W.F]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; 'focused ' + $p.Id } else { 'no window' }
`).trim();
}

async function findRenderer(ctx) {
  for (const p of ctx.pages()) {
    try { if (await p.evaluate(() => !!document.querySelector('.xterm'))) return p; } catch {}
  }
  return null;
}
async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/ime-${TAG}-${name}.png` }).catch(() => {});
  console.log(`[shot] ime-${TAG}-${name}.png`);
}
async function instrument(page) {
  await page.evaluate(() => {
    const w = window;
    w.__imeLog = [];
    const ta = document.activeElement;
    if (!ta || !ta.classList?.contains('xterm-helper-textarea')) { w.__imeLog.push('NO-TEXTAREA ' + ta?.className); return; }
    const log = (s) => { if (w.__imeLog.length < 1500) w.__imeLog.push(`${Date.now() % 1000000} ${s}`); };
    for (const t of ['compositionstart', 'compositionupdate', 'compositionend']) {
      ta.addEventListener(t, (e) => log(`${t} data=${JSON.stringify(e.data)} val=${JSON.stringify(ta.value)}`));
    }
    ta.addEventListener('keydown', (e) => log(`keydown key=${e.key} keyCode=${e.keyCode} composing=${e.isComposing} val=${JSON.stringify(ta.value)}`));
    ta.addEventListener('input', () => log(`input val=${JSON.stringify(ta.value)}`));
    log('INSTRUMENTED');
  });
}

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const page = await findRenderer(ctx);
if (!page) { console.log('no renderer'); process.exit(2); }
await page.bringToFront().catch(() => {});

// Fresh workspace; click the terminal to focus its textarea.
await page.keyboard.press('Control+n');
await sleep(2500);
const box = await page.evaluate(() => {
  const s = Array.from(document.querySelectorAll('.xterm-screen')).filter((el) => el.offsetParent !== null);
  const el = s[s.length - 1]; if (!el) return null; const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (!box) { console.log('no terminal'); process.exit(2); }
await page.mouse.click(box.x, box.y);
await sleep(2500);
await instrument(page);

console.log('focus1:', focusWmuxWindow());
await sleep(800);
console.log('focus2:', focusWmuxWindow());
await sleep(800);

// ── Calibration: real-key ASCII echo (hangul presumed OFF at start) ─────────
sendKeys('e c h o SPACE z z 1 ENTER');
await sleep(1200);
await shot(page, '01-ascii-calibration');

// If hangul mode was ON, the calibration line got composed — normalize: probe
// with 'rk', decide from the event log (preedit shows in innerText).
sendKeys('r k');
await sleep(800);
const probeTxt = await page.evaluate(() => document.body.innerText);
const hangulOn = probeTxt.includes('가');
console.log(`hangul probe: ${hangulOn ? 'ON' : 'OFF'}`);
if (!hangulOn) {
  sendKeys('BSP BSP HANGUL');
  await sleep(500);
} else {
  sendKeys('BSP BSP');
  await sleep(500);
}
await shot(page, '02-after-probe');

// ── Hangul typing cycles with >150ms idle gaps (guard wipes in every gap) ───
for (let i = 0; i < CYCLES; i++) {
  const a = SYLLABLES[i % SYLLABLES.length];
  const b = SYLLABLES[(i + 1) % SYLLABLES.length];
  sendKeys(`${a[0]} ${a[1]} | ${b[0]} ${b[1]} | SPACE`);
  await sleep(650); // crosses IME_RESIDUE_CLEAR_DELAY_MS between cycles
  console.log(`cycle ${i + 1} sent`);
  if (i === Math.floor(CYCLES / 2) - 1) await shot(page, '03-mid-cycles');
}
await shot(page, '04-after-cycles');

// ── Broken-state probes: arrows, Esc, then hangul-off ASCII ────────────────
sendKeys('LEFT LEFT LEFT');
await sleep(400);
sendKeys('HANGUL');
await sleep(300);
sendKeys('z z 2');
await sleep(900);
await shot(page, '05-arrow-ascii-probe');

const log = await page.evaluate(() => (window).__imeLog || []);
console.log(`--- imeLog (${log.length} events, tail 80) ---`);
for (const line of log.slice(-80)) console.log(line);

// Cleanup: clear the prompt line (Esc clears in PSReadLine).
sendKeys('ESC');
await browser.close();
console.log('DONE');
