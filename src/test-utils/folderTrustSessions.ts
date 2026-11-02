// A daemon session table for writer tests: one pane whose ring shows a measured
// folder-trust dialog, one at a shell prompt, one muted with nothing held.
import fs from 'node:fs';
import path from 'node:path';
import { RingBuffer } from '../daemon/RingBuffer';
import type { FolderTrustSession, FolderTrustSessions } from '../daemon/folderTrustState';

const FIXTURES = path.join(__dirname, '../daemon/approvals/__tests__/fixtures/folder-trust');

/** A measured dialog's rows (claude-folder-trust-120x40, codex-folder-trust-60x30, …). */
export function trustFixtureRows(name: string): string[] {
  return (JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as { screen: string[] }).screen;
}

function sessionWith(bytes: string, cols: number, rows: number, muted = false): FolderTrustSession {
  const ring = new RingBuffer(64 * 1024);
  ring.noteGeometry(cols, rows);
  ring.write(Buffer.from(bytes));
  return {
    meta: { state: 'attached', cols, rows },
    ptyProcess: { cols, rows },
    ringBuffer: ring,
    bridge: { isMuted: muted, outputModes: null, heldOutput: () => null },
  };
}

/** `pane-trust` (Claude's dialog at 120x40), `pane-shell` (a prompt), `pane-unknown` (muted, no held output to read). */
export function folderTrustSessions(): FolderTrustSessions {
  const dialog = trustFixtureRows('claude-folder-trust-120x40');
  const sessions = new Map<string, FolderTrustSession>([
    ['pane-trust', sessionWith(`\x1b[2J${dialog.map((row, i) => `\x1b[${i + 1};1H${row}`).join('')}`, 120, 40)],
    ['pane-shell', sessionWith('$ ls\r\nREADME.md\r\n$ ', 120, 40)],
    ['pane-unknown', sessionWith('', 120, 40, true)],
  ]);
  return { getSession: (id) => sessions.get(id) };
}
