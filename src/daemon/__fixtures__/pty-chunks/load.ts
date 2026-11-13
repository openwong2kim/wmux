// Reader for the recorded PTY chunk fixtures in this folder (format in
// README.md). Shared by the fixture check and by replay tests, so the format
// is read in one place.
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export const PTY_CHUNK_FIXTURE_DIR = __dirname;

export interface PtyChunkHeader {
  format: 'wmux-pty-chunks/1';
  backend: 'rustpty' | 'node-pty';
  wmuxSha: string;
  agent: string;
  agentVersion: string;
  cols: number;
  rows: number;
  startedAt: null;
}

/** One line after the header: a chunk, a resize, or a recorder's input note. */
export type PtyChunkRow =
  | { t: number; b64: string }
  | { t: number; resize: { cols: number; rows: number } }
  | { t: number; input: string };

export interface PtyChunkFixture {
  header: PtyChunkHeader;
  rows: PtyChunkRow[];
  /** The decoded chunks, in order, with their times (ms since the first chunk). */
  chunks: Array<{ t: number; bytes: Buffer }>;
}

/** The fixture files, sorted. */
export function ptyChunkFixtureNames(): string[] {
  return fs.readdirSync(PTY_CHUNK_FIXTURE_DIR).filter((name) => name.endsWith('.jsonl.gz')).sort();
}

export function loadPtyChunkFixture(name: string): PtyChunkFixture {
  const lines = gunzipSync(fs.readFileSync(path.join(PTY_CHUNK_FIXTURE_DIR, name))).toString('utf8').trim().split('\n');
  const header = JSON.parse(lines[0]) as PtyChunkHeader;
  const rows = lines.slice(1).map((line) => JSON.parse(line) as PtyChunkRow);
  const chunks = rows.flatMap((row) => ('b64' in row ? [{ t: row.t, bytes: Buffer.from(row.b64, 'base64') }] : []));
  return { header, rows, chunks };
}
