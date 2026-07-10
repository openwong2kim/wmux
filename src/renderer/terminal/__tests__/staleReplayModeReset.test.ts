// @vitest-environment jsdom
/**
 * Stale-replay input-mode reset (reboot-reattach RCA 2026-07-02).
 *
 * A recovered session's ring replay re-executes the dead agent's DECSET
 * arming sequences into xterm — most damagingly ?1003 (any-motion mouse
 * tracking), which makes the pane emit SGR mouse reports through onData the
 * moment the pointer moves toward the resume pill, dismissing it via the
 * "user typed" heuristic before it can be clicked.
 *
 * The reset constant is verified BEHAVIORALLY against a real (headless)
 * xterm Terminal: arm the exact modes observed in the incident buffers, write
 * the reset, assert everything is disarmed and that the reset itself provokes
 * no response bytes. The useTerminal wiring is pinned at the source level,
 * matching the other regression locks in hooks/__tests__.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Terminal } from '@xterm/xterm';
import { STALE_REPLAY_INPUT_MODE_RESETS } from '../staleReplayModeReset';

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

// What the 2026-07-02 incident buffers actually ended with: both attached
// panes' replays left these ENABLED (the agent was killed mid-run by the OS
// shutdown, so the disable sequences never got written).
const DEAD_AGENT_ARMING =
  '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h\x1b[?2004h';

describe('STALE_REPLAY_INPUT_MODE_RESETS — behavioral (headless xterm)', () => {
  it('disarms mouse/focus/paste reporting armed by a replayed dead-agent buffer', async () => {
    const term = new Terminal();
    try {
      await write(term, DEAD_AGENT_ARMING);
      expect(term.modes.mouseTrackingMode).toBe('any');
      expect(term.modes.sendFocusMode).toBe(true);
      expect(term.modes.bracketedPasteMode).toBe(true);

      await write(term, STALE_REPLAY_INPUT_MODE_RESETS);
      expect(term.modes.mouseTrackingMode).toBe('none');
      expect(term.modes.sendFocusMode).toBe(false);
      expect(term.modes.bracketedPasteMode).toBe(false);
    } finally {
      term.dispose();
    }
  });

  it('provokes no response bytes of its own (nothing new for onData to mistake for typing)', async () => {
    const term = new Terminal();
    try {
      const emitted: string[] = [];
      term.onData((d) => emitted.push(d));
      await write(term, STALE_REPLAY_INPUT_MODE_RESETS);
      expect(emitted).toEqual([]);
    } finally {
      term.dispose();
    }
  });

  it('is pure DECRST and leaves display state (alt screen, cursor) alone', () => {
    // Only `CSI ? Pd l` — the reset must never arm a mode or swap screens.
    // eslint-disable-next-line no-control-regex
    expect(STALE_REPLAY_INPUT_MODE_RESETS).toMatch(/^(\x1b\[\?\d+l)+$/);
    expect(STALE_REPLAY_INPUT_MODE_RESETS).not.toContain('1049');
    expect(STALE_REPLAY_INPUT_MODE_RESETS).not.toContain('[?25');
  });
});

describe('useTerminal stale-replay reset wiring (source-level lock)', () => {
  const src = readFileSync(
    path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
    'utf8',
  );

  it('gates on the daemon resumeAgent field (recovered-this-boot, agent not re-detected)', () => {
    const idx = src.indexOf('const resetStaleReplayModes');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 900);
    // No replay → nothing leaked → no reset.
    expect(body).toMatch(/recoveredBytes\s*<=\s*0\)\s*return/);
    // The daemon is the authority — NOT the renderer's resumeHint slice, which
    // hydrates racily against the boot flush.
    expect(body).toMatch(/window\.electronAPI\.pty\.list\(\)/);
    expect(body).toMatch(/resumeAgent/);
    // Terminal-side only: the leaked modes live in xterm, the PTY never saw them.
    expect(body).toMatch(/terminal\.write\(STALE_REPLAY_INPUT_MODE_RESETS\)/);
    expect(body).not.toMatch(/pty\.write/);
  });

  it('runs after the flush in BOTH branches (.txt restore present and absent) and after a resync replay', () => {
    // 2 = the two onFlushComplete branches (with/without a .txt restore).
    // 3rd = Phase 3 completeResyncFromFlush: a hidden-pane resync replays the
    // ring too, so the same leaked-DECSET disarm must follow that replay.
    const calls = src.match(/resetStaleReplayModes\(recoveredBytes\)/g) ?? [];
    expect(calls).toHaveLength(3);
    // The resync completion path must include it (regression lock for PR-A).
    const resyncIdx = src.indexOf('const completeResyncFromFlush');
    expect(resyncIdx).toBeGreaterThan(-1);
    expect(src.slice(resyncIdx, resyncIdx + 1200)).toMatch(/resetStaleReplayModes\(recoveredBytes\)/);
  });
});
