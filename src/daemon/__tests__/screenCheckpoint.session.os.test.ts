// The screen checkpoint through a real session: a real /bin/sh on the Rust
// engine, its output captured by DaemonPTYBridge into its ring, and the
// delivery frame read the way daemon/index.ts reads it. A fullscreen frame is
// drawn once, then cell-diff output that rewrites only one row floods the ring
// past its capacity, in steps as a long session writes it. The composer's
// rules, drawn before the ring's oldest byte, must still read.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonSessionManager } from '../DaemonSessionManager';
import { rustTerminalCoreAvailable } from '../../shared/terminalCoreSettings';
import { queuedScreenText } from '../queuedSessionText';
import { cursorInComposer, deliveryFrameOf, readComposer } from '../deliveryComposer';
import { screenCheckpointBytes } from '../screenCheckpoint';
import { waitFor } from '../../test-utils/waitFor';

const SHELL = '/bin/sh';
const posix = process.platform !== 'win32' && fs.existsSync(SHELL);
const RUST_PROMISED = process.env.WMUX_REQUIRE_RUST_CORE === '1';
const skip = !posix || (!rustTerminalCoreAvailable() && !RUST_PROMISED);

const COLS = 80;
const ROWS = 24;
const RULE = '─'.repeat(COLS);
const at = (row: number, col: number, text: string): string => `\x1b[${row};${col}H${text}`;

describe.skipIf(skip)('a screen checkpoint in a real session', () => {
  let cwd: string;
  let prevEngine: string | undefined;
  const mgr = new DaemonSessionManager();

  beforeAll(() => {
    prevEngine = process.env.WMUX_TERMINAL_CORE;
    process.env.WMUX_TERMINAL_CORE = 'rust';
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cp-'));
  });
  afterAll(() => {
    mgr.disposeAll();
    if (prevEngine === undefined) delete process.env.WMUX_TERMINAL_CORE;
    else process.env.WMUX_TERMINAL_CORE = prevEngine;
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('keeps the idle composer readable after the ring wrapped', async () => {
    const id = 'cp-session';
    await mgr.createSessionAsync({
      id, cmd: SHELL, cwd, cols: COLS, rows: ROWS,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, PS1: '$ ', TERM: 'xterm-256color', LC_ALL: 'C' },
    });
    const managed = mgr.getSession(id);
    if (!managed) throw new Error('no session');
    const capacity = managed.ringBuffer.capacityBytes;

    fs.writeFileSync(path.join(cwd, 'frame'), '\x1b[?1049h\x1b[2J'
      + at(19, 1, RULE) + at(20, 1, '❯ ') + at(21, 1, RULE) + at(22, 1, '  Opus · acct · ctx 9%') + at(23, 1, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'));
    // A quarter of the ring per step, rewriting only the transcript's first row.
    let step = '';
    for (let i = 0; step.length < capacity / 4; i++) step += at(1, 1, `⏺ line ${i}`.padEnd(60, '.'));
    fs.writeFileSync(path.join(cwd, 'step'), step);
    fs.writeFileSync(path.join(cwd, 'final'), at(2, 1, 'FINAL-MARK') + at(20, 3, ''));
    managed.ptyProcess.write('cat frame; for i in 1 2 3 4 5 6 7; do cat step; sleep 0.2; done; cat final; sleep 30\n');

    await waitFor(() => managed.ringBuffer.readAll().includes('FINAL-MARK'), 20_000);
    expect(managed.ringBuffer.totalBytesWritten).toBeGreaterThan(capacity * 1.5);
    expect(screenCheckpointBytes(managed.ringBuffer)).toBeGreaterThan(0);

    const outcome = await queuedScreenText(mgr, id, true, { keepUnknown: true });
    if (!outcome?.ok) throw new Error('screen read failed');
    const frame = deliveryFrameOf(outcome.rows, outcome.rowsBelowCursor);
    expect(frame.rows.slice(18, 21)).toEqual([RULE, '❯ ', RULE]);
    const read = readComposer(frame, 'claude', 'paste');
    expect(read.verdict).toBe('plain');
    expect(cursorInComposer(frame, read)).toBe(true);
  }, 40_000);
});
