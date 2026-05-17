#!/usr/bin/env node
/**
 * scrollback-reset — clear accumulated wmux state to validate Fix 0 from
 * a clean slate, or to escape from a session.json ↔ daemon buffer-dump
 * mismatch that has built up over previous launches.
 *
 * NON-DESTRUCTIVE — everything moves into ~/.wmux/backup-<timestamp>/.
 * You can restore by moving files back if needed.
 *
 * What this script does:
 *   1. Kills any running wmux + Electron processes (so daemon releases
 *      its singleton state and stops writing to sessions.json mid-move).
 *   2. Backs up + removes ~/.wmux/sessions.json and its .bak* siblings.
 *   3. Backs up + removes ~/.wmux/buffers/*.buf (the daemon ringBuffer dumps).
 *   4. Backs up + removes %APPDATA%/wmux/session.json and its .bak* siblings
 *      (the renderer-side workspace snapshot, which holds the stale ptyIds).
 *
 * Use cases:
 *   - You're running Fix 0 dogfood and the daemon's accumulated state from
 *     pre-Fix-0 launches is masking the new behavior. Run this once, then
 *     `npm start` → make panes → tray Quit → `npm start` → verify scrollback
 *     restoration works end-to-end.
 *   - You hit a session.json/buffer-dump mismatch that no amount of
 *     restarting fixes. This is the escape hatch.
 *
 * Cross-platform: PowerShell-friendly on Windows, also works on macOS/Linux
 * via /bin/sh. The kill step uses platform-specific commands.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const HOME = os.homedir();
const WMUX_DIR = path.join(HOME, '.wmux');
const APPDATA_WMUX_DIR =
  process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'wmux')
    : process.platform === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support', 'wmux')
    : path.join(HOME, '.config', 'wmux');

const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BACKUP_DIR = path.join(WMUX_DIR, `backup-${TIMESTAMP}`);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function moveIfExists(src, destDir, label) {
  if (!fs.existsSync(src)) {
    console.log(`  [skip] ${label} — not present`);
    return false;
  }
  ensureDir(destDir);
  const dest = path.join(destDir, path.basename(src));
  fs.renameSync(src, dest);
  const size = (() => {
    try {
      const st = fs.statSync(dest);
      return st.isDirectory() ? '<dir>' : `${st.size}B`;
    } catch {
      return '?';
    }
  })();
  console.log(`  [moved] ${label} → ${dest} (${size})`);
  return true;
}

function moveGlob(dir, pattern, destDir, label) {
  if (!fs.existsSync(dir)) {
    console.log(`  [skip] ${label} — dir not present`);
    return 0;
  }
  const entries = fs.readdirSync(dir).filter((name) => pattern.test(name));
  if (entries.length === 0) {
    console.log(`  [skip] ${label} — no matches`);
    return 0;
  }
  ensureDir(destDir);
  let count = 0;
  let totalBytes = 0;
  for (const name of entries) {
    const src = path.join(dir, name);
    const dest = path.join(destDir, name);
    try {
      const st = fs.statSync(src);
      totalBytes += st.size;
      fs.renameSync(src, dest);
      count++;
    } catch (err) {
      console.warn(`  [warn] ${name}: ${err.message}`);
    }
  }
  console.log(`  [moved] ${label} — ${count} files, ${totalBytes} bytes total → ${destDir}`);
  return count;
}

function killWmuxProcesses() {
  console.log('[1/4] killing running wmux/electron processes…');
  if (process.platform === 'win32') {
    // taskkill returns non-zero if no matching process — that's fine.
    for (const name of ['wmux.exe', 'electron.exe', 'node.exe']) {
      try {
        const out = execSync(`taskkill /F /IM ${name} /FI "WINDOWTITLE eq wmux*" 2>nul`, {
          stdio: ['ignore', 'pipe', 'pipe'],
        }).toString();
        if (out.trim()) console.log(`  [taskkill] ${name}: ${out.trim()}`);
      } catch {
        /* no matching process — fine */
      }
    }
    // Also try without window-title filter for the wmux launcher itself.
    try {
      execSync('taskkill /F /IM wmux.exe 2>nul', { stdio: 'ignore' });
    } catch {
      /* fine */
    }
  } else {
    try {
      execSync('pkill -f "wmux" || true', { stdio: 'ignore' });
    } catch {
      /* fine */
    }
  }
  // Give the OS a moment to release file locks.
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    // busy-wait, harmless for ~1.5s
  }
  console.log('  done.');
}

function main() {
  console.log(`scrollback-reset @ ${TIMESTAMP}`);
  console.log(`  HOME=${HOME}`);
  console.log(`  WMUX_DIR=${WMUX_DIR}`);
  console.log(`  APPDATA_WMUX_DIR=${APPDATA_WMUX_DIR}`);
  console.log(`  BACKUP_DIR=${BACKUP_DIR}`);
  console.log('');

  if (!fs.existsSync(WMUX_DIR)) {
    console.log('No ~/.wmux/ directory found. Nothing to clean. Exiting.');
    return;
  }

  killWmuxProcesses();

  console.log('[2/4] backing up daemon sessions.json + .bak siblings…');
  ensureDir(BACKUP_DIR);
  moveGlob(WMUX_DIR, /^sessions\.json(\.bak.*)?$/, BACKUP_DIR, 'sessions.json*');

  console.log('[3/4] backing up daemon buffer dumps…');
  const buffersBackup = path.join(BACKUP_DIR, 'buffers');
  moveGlob(path.join(WMUX_DIR, 'buffers'), /\.buf$/, buffersBackup, 'buffers/*.buf');

  console.log('[4/4] backing up renderer session.json + .bak siblings…');
  const appdataBackup = path.join(BACKUP_DIR, 'appdata');
  moveGlob(APPDATA_WMUX_DIR, /^session\.json(\.bak.*)?$/, appdataBackup, 'AppData/wmux/session.json*');

  console.log('');
  console.log('==============================================');
  console.log('CLEAN STATE READY');
  console.log('==============================================');
  console.log(`Backup: ${BACKUP_DIR}`);
  console.log('');
  console.log('To restore everything (undo this reset):');
  if (process.platform === 'win32') {
    console.log(`  Move-Item "${BACKUP_DIR}\\sessions.json*" "${WMUX_DIR}\\"`);
    console.log(`  Move-Item "${BACKUP_DIR}\\buffers\\*.buf" "${WMUX_DIR}\\buffers\\"`);
    console.log(`  Move-Item "${BACKUP_DIR}\\appdata\\session.json*" "${APPDATA_WMUX_DIR}\\"`);
  } else {
    console.log(`  mv "${BACKUP_DIR}/sessions.json"* "${WMUX_DIR}/"`);
    console.log(`  mv "${BACKUP_DIR}/buffers"/*.buf "${WMUX_DIR}/buffers/"`);
    console.log(`  mv "${BACKUP_DIR}/appdata/session.json"* "${APPDATA_WMUX_DIR}/"`);
  }
  console.log('');
  console.log('Next steps for Fix 0 dogfood:');
  console.log('  1. npm start');
  console.log('  2. Create 2+ panes, run something with visible output');
  console.log('  3. Tray → Quit (graceful)');
  console.log('  4. npm start');
  console.log('  5. Expect: "패널 복원 중…" placeholder, then panes with restored scrollback');
}

main();
