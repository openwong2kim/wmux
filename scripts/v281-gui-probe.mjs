// v2.8.1 GUI dynamic verification — attach to running dev electron via CDP
// Pulls: console logs, toast DOM state, pane count, daemon ready state, sessions snapshot
// Uses built-in WebSocket (Node 22+)

const WS_URL = process.argv[2] || 'ws://localhost:18882/devtools/page/1BE1D2C1DEFB375E1AAC7E0C299F6B21';
const TIMEOUT_MS = 10000;

const ws = new WebSocket(WS_URL);
let nextId = 1;
const pending = new Map();
const consoleLog = [];
const logEntries = [];
const exceptions = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.addEventListener('open', async () => {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Console.enable');
  await send('Page.enable');

  // Wait briefly for buffered events to flush
  await new Promise(r => setTimeout(r, 1500));

  // Toast DOM count
  const toastDom = await send('Runtime.evaluate', {
    expression: `(() => {
      const sels = ['[role="status"]','[role="alert"]','.toast','[class*="toast" i]','[class*="Toast"]','[data-sonner-toast]','[id*="toast" i]'];
      const out = [];
      for (const sel of sels) {
        document.querySelectorAll(sel).forEach(el => {
          const t = (el.textContent||'').trim().slice(0,200);
          if (t) out.push({ sel, text: t, classes: el.className });
        });
      }
      return JSON.stringify(out);
    })()`,
    returnByValue: true,
  });

  // Pane / terminal count
  const paneDom = await send('Runtime.evaluate', {
    expression: `(() => {
      const xtermNodes = document.querySelectorAll('.xterm');
      const tabs = document.querySelectorAll('[role="tab"], [data-tab-id], [class*="tab" i]');
      const focused = document.activeElement ? document.activeElement.tagName + ' ' + (document.activeElement.className||'') : null;
      return JSON.stringify({
        xtermCount: xtermNodes.length,
        firstThreeXtermClasses: Array.from(xtermNodes).slice(0,3).map(n => n.className),
        tabCandidateCount: tabs.length,
        focused,
        bodyClasses: document.body.className,
        url: location.href,
        title: document.title,
      });
    })()`,
    returnByValue: true,
  });

  // Daemon ready / app state via window globals
  const appState = await send('Runtime.evaluate', {
    expression: `(() => {
      const w = window;
      const out = {};
      try { out.hasWmuxApi = !!w.wmux; } catch(_){}
      try { out.daemon = w.wmux?.daemon ? Object.keys(w.wmux.daemon) : null; } catch(_){}
      try { out.events = w.wmux?.events ? Object.keys(w.wmux.events) : null; } catch(_){}
      try {
        if (typeof w.wmux?.daemon?.getReadyState === 'function') {
          // not awaited here — sync probe
        }
      } catch(_){}
      return JSON.stringify(out);
    })()`,
    returnByValue: true,
  });

  // Best-effort: invoke daemon ready state if exposed
  let daemonReady = null;
  try {
    const r = await send('Runtime.evaluate', {
      expression: `(async () => {
        try {
          if (window.wmux?.daemon?.getReadyState) {
            return await window.wmux.daemon.getReadyState();
          }
          if (window.wmux?.daemon?.whenReady) {
            const p = window.wmux.daemon.whenReady();
            const r = await Promise.race([p, new Promise(r => setTimeout(() => r('TIMEOUT_2s'), 2000))]);
            return { whenReady: r };
          }
          return { error: 'no daemon ready API' };
        } catch (e) { return { error: String(e) }; }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    daemonReady = r.result?.value;
  } catch (e) {
    daemonReady = { probeError: String(e) };
  }

  console.log('=== TOAST DOM SCAN ===');
  console.log(toastDom.result?.value);
  console.log();
  console.log('=== PANE / DOM SCAN ===');
  console.log(paneDom.result?.value);
  console.log();
  console.log('=== APP STATE ===');
  console.log(appState.result?.value);
  console.log();
  console.log('=== DAEMON READY PROBE ===');
  console.log(JSON.stringify(daemonReady));
  console.log();
  console.log('=== CONSOLE LOG TAIL (Runtime.consoleAPICalled) ===');
  for (const e of consoleLog.slice(-50)) console.log(e);
  console.log();
  console.log('=== LOG ENTRIES (Log.entryAdded) ===');
  for (const e of logEntries.slice(-50)) console.log(e);
  console.log();
  console.log('=== EXCEPTIONS (Runtime.exceptionThrown) ===');
  for (const e of exceptions.slice(-20)) console.log(e);

  ws.close();
});

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(msg.error); else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const args = (msg.params.args || []).map(a => a.value !== undefined ? JSON.stringify(a.value) : (a.description || a.type)).join(' ');
    consoleLog.push(`[${msg.params.type}] ${args}`);
  } else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    logEntries.push(`[${e.level}] [${e.source}] ${e.text}${e.url ? ' ('+e.url+')' : ''}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const ed = msg.params.exceptionDetails;
    exceptions.push(`${ed.text} :: ${ed.exception?.description || ''}`);
  }
});

ws.addEventListener('error', (e) => { console.error('WS error', e.message || e.type); process.exit(1); });

setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, TIMEOUT_MS);
