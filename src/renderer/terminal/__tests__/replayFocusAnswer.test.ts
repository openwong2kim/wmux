// @vitest-environment jsdom
/**
 * A replayed `?1004h` must not type a focus report into the PTY.
 *
 * The browser xterm answers every `?1004h` it parses with an immediate
 * `ESC[I`/`ESC[O` through onData (InputHandler: case 1004 fires
 * onRequestSendFocus; CoreBrowserTerminal._reportFocus). A reattach replays the
 * pane's stored output, which on Windows always holds ConPTY's own `?1004h`,
 * so every reattach used to send at least one focus report nobody asked for.
 * In a console a killed agent left in VT-input mode it lands on the
 * PowerShell prompt as `[O`. This drives the REAL browser xterm (not headless,
 * which never answers) through the same mute useTerminal uses for replays.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Terminal } from '@xterm/xterm';
import { installShellPromptModeReset } from '../../../shared/terminal/shellPromptModeReset';
import { beginReplayWrite, createReplayMute, isReplayMuted } from '../replayMute';

const ESC = '\x1b';
/** ConPTY's own session-start preamble. */
const CONPTY_START = `${ESC}[?9001h${ESC}[?1004h`;

function make() {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const mute = createReplayMute();
  const guard = installShellPromptModeReset(term, { isReplaying: () => isReplayMuted(mute) });
  const toPty: string[] = [];
  // The order useTerminal's onData uses: the guard decides first.
  term.onData((data) => {
    if (guard.dropsReport(data)) return;
    toPty.push(data);
  });
  const replay = (data: string) => new Promise<void>((resolve) => {
    const release = beginReplayWrite(mute);
    term.write(data, () => { release(); resolve(); });
  });
  const live = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  return { term, toPty, replay, live };
}

describe('replayed ?1004h answer (reattach focus-report leak)', () => {
  it('the browser xterm does answer ?1004h at parse time (the premise)', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const emitted: string[] = [];
    term.onData((d) => emitted.push(d));
    await new Promise<void>((resolve) => term.write(CONPTY_START, resolve));
    expect(emitted).toEqual([`${ESC}[O`]);
    term.dispose();
  });

  it('sends nothing to the PTY while a replay re-arms focus reporting', async () => {
    const { term, toPty, replay } = make();
    // Ring replay (ConPTY preamble) followed by a snapshot mode tail.
    await replay(CONPTY_START + 'PS C:\\> ' + `${ESC}[?1003h${ESC}[?1006h${ESC}[?1004h`);
    expect(toPty).toEqual([]);
    // The mode itself is kept: a live program that armed it still owns it.
    expect(term.modes.sendFocusMode).toBe(true);
    term.dispose();
  });

  it('a live ?1004h still gets its answer', async () => {
    const { term, toPty, replay, live } = make();
    await replay(CONPTY_START);
    await live(`${ESC}[?1004l${ESC}[?1004h`);
    expect(toPty).toEqual([`${ESC}[O`]);
    term.dispose();
  });
});

describe('useTerminal wiring (source-level lock)', () => {
  const src = readFileSync(
    path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('hands the replay mute to the prompt-mode guard on every build', () => {
    const idx = src.indexOf('const promptModeGuard = installShellPromptModeReset(');
    expect(idx).toBeGreaterThan(-1);
    const call = src.slice(idx, idx + 400);
    expect(call).toMatch(/isReplaying: \(\) => isReplayMuted\(replayMuteRef\.current\)/);
  });
});
