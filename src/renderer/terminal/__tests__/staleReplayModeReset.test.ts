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
import {
  STALE_REPLAY_INPUT_MODE_RESETS,
  STALE_REPLAY_ALIVE_SHELL_RESETS,
  STALE_REPLAY_DISPLAY_RESETS,
  staleReplayResetLevel,
} from '../staleReplayModeReset';

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

// Internal xterm buffer access — `buffer.active.scrollTop/scrollBottom` are
// not on the public API (HeadlessSnapshot.ts documents this gap explicitly:
// "DECSTBM scroll margins are not exposed by the public API"), so the only
// way to observe an armed region is through `_core`, same as the daemon's
// own MarginTracker has to track it externally rather than read it off xterm.
type TerminalWithCore = Terminal & {
  _core: { buffer: { scrollTop: number; scrollBottom: number } };
};

describe('STALE_REPLAY_DISPLAY_RESETS — behavioral (headless xterm)', () => {
  it('releases a DECSTBM scroll region left armed by a replayed dead-TUI buffer (the frozen-scroll-window bug)', async () => {
    const term = new Terminal({ rows: 24, cols: 80 }) as TerminalWithCore;
    try {
      // A TUI (e.g. an agent's input box pinned to the bottom) narrows the
      // scroll region and is killed before it can emit the matching ESC[r.
      await write(term, '\x1b[5;20r');
      expect(term._core.buffer.scrollTop).toBe(4);
      expect(term._core.buffer.scrollBottom).toBe(19);

      await write(term, STALE_REPLAY_DISPLAY_RESETS);
      expect(term._core.buffer.scrollTop).toBe(0);
      expect(term._core.buffer.scrollBottom).toBe(term.rows - 1);
    } finally {
      term.dispose();
    }
  });

  it('preserves the replayed cursor position (xterm.js CSI r snaps the cursor to (0,0) as a side effect)', async () => {
    const term = new Terminal({ rows: 24, cols: 80 });
    try {
      // Replay left the cursor mid-buffer, inside the still-armed region.
      await write(term, '\x1b[5;20r\x1b[10;15H');
      expect(term.buffer.active.cursorY).toBe(9);
      expect(term.buffer.active.cursorX).toBe(14);

      await write(term, STALE_REPLAY_DISPLAY_RESETS);
      expect(term.buffer.active.cursorY).toBe(9);
      expect(term.buffer.active.cursorX).toBe(14);
    } finally {
      term.dispose();
    }
  });

  it('does not erase any cell (safe to apply even when nothing was armed)', async () => {
    const term = new Terminal();
    try {
      await write(term, 'line one\r\nline two\r\n');
      const before = term.buffer.active.getLine(0)?.translateToString();
      await write(term, STALE_REPLAY_DISPLAY_RESETS);
      expect(term.buffer.active.getLine(0)?.translateToString()).toBe(before);
    } finally {
      term.dispose();
    }
  });

  it('provokes no response bytes of its own', async () => {
    const term = new Terminal();
    try {
      const emitted: string[] = [];
      term.onData((d) => emitted.push(d));
      await write(term, STALE_REPLAY_DISPLAY_RESETS);
      expect(emitted).toEqual([]);
    } finally {
      term.dispose();
    }
  });
});

describe('STALE_REPLAY_ALIVE_SHELL_RESETS — the alive-shell subset', () => {
  it('disarms every mouse-reporting mode the replay could have armed', async () => {
    const term = new Terminal();
    try {
      await write(term, DEAD_AGENT_ARMING);
      expect(term.modes.mouseTrackingMode).toBe('any');

      await write(term, STALE_REPLAY_ALIVE_SHELL_RESETS);
      expect(term.modes.mouseTrackingMode).toBe('none');
    } finally {
      term.dispose();
    }
  });

  it('disarms focus reporting — a leaked ?1004h types ESC[I into the prompt on every focus change', async () => {
    // Same leak as the mouse modes: xterm emits CSI I / CSI O through onData,
    // and useTerminal.ts forwards onData to the PTY unconditionally (its
    // CSI I / CSI O check only spares the resume hint, it does not skip the
    // write). A shell never arms ?1004 for itself, so there is no owner to
    // desynchronize — unlike ?2004 below.
    const term = new Terminal();
    try {
      await write(term, DEAD_AGENT_ARMING);
      expect(term.modes.sendFocusMode).toBe(true);

      await write(term, STALE_REPLAY_ALIVE_SHELL_RESETS);
      expect(term.modes.sendFocusMode).toBe(false);
    } finally {
      term.dispose();
    }
  });

  it('leaves bracketed paste armed — clearing it turns a multi-line paste into N executed commands', async () => {
    // wmux decides whether to wrap a paste in ESC[200~ by reading xterm's OWN
    // modes.bracketedPasteMode (clipboardChunk.ts:159, Terminal.tsx:289,
    // useTerminal.ts:1647). A shell at its prompt has ?2004 armed and expects
    // wrapped pastes. Clearing it terminal-side desyncs the two and the shell
    // runs every pasted line. This is the everyday-path regression the split
    // exists to prevent.
    const term = new Terminal();
    try {
      await write(term, DEAD_AGENT_ARMING);
      await write(term, STALE_REPLAY_ALIVE_SHELL_RESETS);
      expect(term.modes.bracketedPasteMode).toBe(true);
    } finally {
      term.dispose();
    }
  });

  it('is a strict subset of the full reset (no mode escapes the known-dead path)', () => {
    for (const seq of STALE_REPLAY_ALIVE_SHELL_RESETS.split('\x1b').filter(Boolean)) {
      expect(STALE_REPLAY_INPUT_MODE_RESETS).toContain(`\x1b${seq}`);
    }
    expect(STALE_REPLAY_ALIVE_SHELL_RESETS).not.toContain('2004');
    
  });
});

describe('staleReplayResetLevel — the gate (#807)', () => {
  it('clears everything when the daemon booted into recovery (the 2026-07-02 case)', () => {
    expect(staleReplayResetLevel({ resumeAgent: 'claude' })).toBe('full');
  });

  it('clears mouse only when the shell sits at its prompt after an app-only restart', () => {
    // The daemon survived the app quit, so `resumeAgent` is absent — the exact
    // gap that let a replayed ?1003h/?1006h write `35;9;12M` into the prompt.
    // The SHELL is alive here, so ?2004 must survive.
    expect(staleReplayResetLevel({ commandRunning: false })).toBe('mouse');
  });

  it('never clobbers a live TUI that legitimately armed mouse reporting', () => {
    expect(staleReplayResetLevel({ commandRunning: true })).toBe('none');
  });

  it('declines without evidence (no shell integration → commandRunning undefined)', () => {
    expect(staleReplayResetLevel({})).toBe('none');
    expect(staleReplayResetLevel(undefined)).toBe('none');
  });

  it('a live command outranks a stale recovery flag (the user started a fresh TUI)', () => {
    // `resumeAgent` records what the daemon saw at ITS boot. If a foreground
    // command owns the PTY now, that record is out of date and the live
    // process owns the modes.
    expect(staleReplayResetLevel({ resumeAgent: 'claude', commandRunning: true })).toBe('none');
  });

  it('a recovered pane idling at its prompt still earns the full reset', () => {
    expect(staleReplayResetLevel({ resumeAgent: 'claude', commandRunning: false })).toBe('full');
  });
});

describe('useTerminal stale-replay reset wiring (source-level lock)', () => {
  const src = readFileSync(
    path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
    'utf8',
  );

  it('gates on the shared daemon-state predicate, not an inline resumeAgent check', () => {
    const idx = src.indexOf('const resetStaleReplayModes');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 900);
    // No replay → nothing leaked → no reset.
    expect(body).toMatch(/recoveredBytes\s*<=\s*0\)\s*return/);
    // The daemon is the authority — NOT the renderer's resumeHint slice, which
    // hydrates racily against the boot flush.
    expect(body).toMatch(/window\.electronAPI\.pty\.list\(\)/);
    // #807: the gate is the exported predicate. An inline `?.resumeAgent` here
    // is exactly the too-narrow test that missed app-restart-with-live-daemon.
    expect(body).toMatch(/staleReplayResetLevel\(/);
    expect(body).not.toMatch(/\?\.resumeAgent/);
    // The alive-shell path must pick the mouse subset. Writing the full reset
    // unconditionally is the paste-corruption regression.
    expect(body).toMatch(/level === 'full' \? STALE_REPLAY_INPUT_MODE_RESETS : STALE_REPLAY_ALIVE_SHELL_RESETS/);
    // Terminal-side only: the leaked modes live in xterm, the PTY never saw them.
    expect(body).toMatch(/terminal\.write\(/);
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
    // Window widened from 1200: the function gained the #998 comment block
    // explaining why its buffer flush is muted. The assertion is "the reset is
    // in this function", not "within N characters of its opening brace".
    expect(src.slice(resyncIdx, resyncIdx + 2400)).toMatch(/resetStaleReplayModes\(recoveredBytes\)/);
  });

  it('pairs STALE_REPLAY_DISPLAY_RESETS with STALE_REPLAY_INPUT_MODE_RESETS at both call sites (frozen-scroll-window fix)', () => {
    // Site 1: the dead-snapshot paint (no resumeAgent gate — dead is dead).
    const deadSnapshotIdx = src.indexOf('const paintDeadSnapshot');
    expect(deadSnapshotIdx).toBeGreaterThan(-1);
    const deadSnapshotBody = src.slice(deadSnapshotIdx, deadSnapshotIdx + 1400);
    // The payload write, however it is spelled: #998 routes replay payloads
    // through writeReplayed() so the OSC 52 clipboard bridge stays muted while
    // stored bytes are parsed. What this locks is the ORDER — payload first,
    // then the mode resets — not the identity of the call.
    expect(deadSnapshotBody).toMatch(
      /terminal\.write\(bytes\)|term\.write\(bytes\)|writeReplayed\(term(?:inal)?, bytes/,
    );
    expect(deadSnapshotBody).toMatch(/STALE_REPLAY_INPUT_MODE_RESETS/);
    expect(deadSnapshotBody).toMatch(/STALE_REPLAY_DISPLAY_RESETS/);

    // Site 2: resetStaleReplayModes (daemon-state gated).
    const resetFnIdx = src.indexOf('const resetStaleReplayModes');
    expect(resetFnIdx).toBeGreaterThan(-1);
    const resetFnBody = src.slice(resetFnIdx, resetFnIdx + 900);
    expect(resetFnBody).toMatch(/STALE_REPLAY_INPUT_MODE_RESETS/);
    expect(resetFnBody).toMatch(/STALE_REPLAY_DISPLAY_RESETS/);
  });
});
