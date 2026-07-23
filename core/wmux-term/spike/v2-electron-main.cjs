// V2 — load the same .node in Electron 41 main process (U2 proof: stable ABI → no rebuild).
// No window needed. app.whenReady → require → verify → process.exit(0/1).
const { app } = require('electron');
const path = require('node:path');

function run() {
  let fail = 0;
  const check = (name, cond, got) => {
    if (cond) {
      console.log(`  PASS ${name}`);
    } else {
      console.error(`  FAIL ${name} — got: ${JSON.stringify(got)}`);
      fail++;
    }
  };

  console.log('[V2] Electron 41 main process + napi .node (U2)');
  console.log(`  electron ${process.versions.electron} / node ${process.versions.node} / modules ABI ${process.versions.modules}`);

  // Exactly the same .node built by plain Node — must load without rebuild for U2 to pass.
  const addon = require(path.join(__dirname, '..', 'dist', 'napi', 'index.cjs'));
  const { WmuxTerm } = addon;

  const term = new WmuxTerm(80, 24);
  check('new(80,24) cols', term.cols === 80, term.cols);
  check('new(80,24) rows', term.rows === 24, term.rows);

  const enc = new TextEncoder();
  const r = term.feed(enc.encode('electron main OK'));
  check('feed dirtyRows=1', r.dirtyRows === 1, r);
  check('snapshot_row(0) prefix match', term.snapshotRow(0).startsWith('electron main OK'), JSON.stringify(term.snapshotRow(0)));

  term.feed(enc.encode('\r\nline2'));
  check('after CRLF row1', term.snapshotRow(1).startsWith('line2'), JSON.stringify(term.snapshotRow(1)));

  if (fail === 0) {
    console.log('[V2] OK — no-rebuild load and round trip succeeded in Electron main');
    app.exit(0);
  } else {
    console.error(`[V2] FAIL — ${fail} case(s)`);
    app.exit(1);
  }
}

app.whenReady().then(run).catch((e) => {
  console.error('[V2] exception:', e);
  app.exit(1);
});
