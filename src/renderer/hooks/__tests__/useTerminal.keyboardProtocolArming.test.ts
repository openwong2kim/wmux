import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  foldRemoteKeyboardState,
  INITIAL_REMOTE_KEYBOARD_STATE,
} from '../../components/Remote/keyboardProtocol';

/**
 * #1363 — what is allowed to arm the pane's keyboard-protocol state.
 *
 * Two sources armed it that never negotiated anything:
 *   1. ConPTY's own `CSI ? 9001 h`, the first bytes of every Windows session.
 *   2. Scrollback replay, which re-delivers those same bytes on every restart.
 * Either one left Shift+Enter on win32 key records, where the SHIFT modifier
 * does not survive ConPTY and the TUI submits instead of inserting a newline.
 *
 * jsdom cannot run xterm's data path faithfully, so the wiring is pinned at
 * source level (as in useTerminal.ctrlLetterEncoding) and the decision itself
 * is exercised against the real fold.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
  'utf8',
);

/** The first bytes of every ConPTY session (verbatim from the field report). */
const CONPTY_STARTUP = '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H';

describe('useTerminal keyboard-protocol arming (#1363)', () => {
  it('replayed chunks are not folded into the tracker', () => {
    expect(SRC).toMatch(/if \(!payload\.replay\) noteKeyboard\(payload\.data\);/);
  });

  it('the fold is told not to trust ?9001h on a Windows host', () => {
    // The pane's host (the browser build reports the daemon's), else this machine.
    expect(SRC).toMatch(/hostPlatform\?\.\(\) \?\? window\.electronAPI\.platform/);
    expect(SRC).toMatch(/trustWin32Input: hostPlatform\(\) !== 'win32'/);
    expect(SRC).toMatch(/foldRemoteKeyboardState\(keyboardRef\.current, data, foldOpts\(\)\)/);
  });

  it("ConPTY's startup ?9001h does not arm win32 input on a Windows host", () => {
    const after = foldRemoteKeyboardState(
      INITIAL_REMOTE_KEYBOARD_STATE,
      CONPTY_STARTUP,
      { trustWin32Input: false },
    );
    expect(after.win32Input).toBe(false);
    expect(after).toBe(INITIAL_REMOTE_KEYBOARD_STATE);
  });

  it('#1694: native Windows Codex gets its newline from the detected agent', () => {
    // The fold above stays untrusting; the newline keys read host, WSL,
    // agent and prompt state per keystroke instead of the win32Input flag.
    expect(SRC).toMatch(
      /altEnterNewline: wantsAltEnterNewline\(\{\s*hostPlatform: hostPlatform\(\),\s*isWsl: wslByPtyId\.get\(ptyId\),\s*agentSlug: useStore\.getState\(\)\.surfaceAgent\[ptyId\]\?\.slug,\s*atPrompt: atPromptRef\.current,\s*codexEndedAt: codexEndedAtRef\.current,\s*\}\)/,
    );
    // WSL comes from the pty's real shell, the predicate the clipboard uses.
    expect(SRC).toMatch(/wslByPtyId\.set\(s\.id, isWslShell\(s\.shell\)\)/);
  });

  it('#1694: every live output chunk feeds the prompt state and the end-of-Codex latch', () => {
    expect(SRC).toMatch(/atPromptRef\.current = foldAtPrompt\(wasAtPrompt, data\)/);
    expect(SRC).toMatch(
      /codexEndedAtRef\.current = noteCodexEndedByPrompt\(\s*codexEndedAtRef\.current,\s*wasAtPrompt,\s*atPromptRef\.current,\s*useStore\.getState\(\)\.surfaceAgent\[ptyId\]\?\.slug,/,
    );
  });

  it('#1694: the latch clears once the stale Codex slug is dropped', () => {
    expect(SRC).toMatch(
      /if \(codexEndedAtRef\.current !== null && state\.surfaceAgent\[ptyId\]\?\.slug !== 'codex'\) \{\s*codexEndedAtRef\.current = null;/,
    );
  });

  it('a prompt start clears state without waiting for the liveness poll', () => {
    const armed = foldRemoteKeyboardState(INITIAL_REMOTE_KEYBOARD_STATE, '\x1b[>1u');
    expect(armed.kitty).toBe(true);
    expect(foldRemoteKeyboardState(armed, '\x1b]133;A\x07')).toEqual(
      INITIAL_REMOTE_KEYBOARD_STATE,
    );
  });
});
