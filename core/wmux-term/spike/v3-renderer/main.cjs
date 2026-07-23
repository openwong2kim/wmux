// V3 — load web-target wasm in Electron renderer (hidden BrowserWindow, show:false)
// → feed round-trip → collect results via IPC → exit code verdict.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

let timeoutHandle;

function finish(code, msg) {
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (msg) console.log(msg);
  app.exit(code);
}

app.whenReady().then(() => {
  console.log('[V3] Electron renderer + web target wasm');
  console.log(`  electron ${process.versions.electron} / chrome ${process.versions.chrome}`);

  // Renderer sends results back via IPC.
  ipcMain.on('v3-result', (_evt, payload) => {
    if (payload.ok) {
      let fail = 0;
      const check = (name, cond, got) => {
        if (cond) console.log(`  PASS ${name}`);
        else { console.error(`  FAIL ${name} — ${JSON.stringify(got)}`); fail++; }
      };
      check('wasm cols=80', payload.cols === 80, payload.cols);
      check('wasm rows=24', payload.rows === 24, payload.rows);
      check('feed dirtyRows=1', payload.dirtyRows === 1, payload.dirtyRows);
      check('feed writebackLen=0', payload.writebackLen === 0, payload.writebackLen);
      check('snapshot_row(0) prefix match', typeof payload.row0 === 'string' && payload.row0.startsWith('renderer wasm OK'), payload.row0);
      check('after CRLF row1', typeof payload.row1 === 'string' && payload.row1.startsWith('second'), payload.row1);
      finish(fail === 0 ? 0 : 1, fail === 0 ? '[V3] OK — renderer wasm load, round trip, IPC retrieval succeeded' : `[V3] FAIL — ${fail} case(s)`);
    } else {
      console.error('[V3] renderer error:', payload.error);
      finish(1, '[V3] FAIL — renderer exception');
    }
  });

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // Allow local wasm fetch in renderer — spike only (file:// load).
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  // Safety net: fail if the renderer does not respond within 15 seconds.
  timeoutHandle = setTimeout(() => finish(1, '[V3] FAIL — renderer timeout (15s)'), 15000);
}).catch((e) => {
  console.error('[V3] main exception:', e);
  finish(1);
});
