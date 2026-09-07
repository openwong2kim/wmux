import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Source-level regression locks for the #1228 review fixes (C1 + C2):
 *
 * C1 — keyboard-protocol negotiation state is liveness-scoped and survives
 * pane park/re-adoption. A terminal adopted after a restructure must seed
 * `keyboardRef` from the state its previous mount parked (else a live Codex
 * falls back to CSI-u, #1152), and the state must reset when process-truth /
 * OSC 133 says the foreground command died (else a Codex that armed win32
 * input mode without resetting it leaves junk encoding for the next app,
 * same staleness class as #1210).
 *
 * C2 — every directly-written control byte (newline, IME Escape, disabled
 * shortcut ctrl, catch-all ctrl) feeds `noteUserKeystroke`, so the interrupt
 * observer, resume-hint retraction, and input scheduler all see it. Before
 * this, direct writes fed only the dead-input watchdog and a directly-written
 * Ctrl+C skipped the renderer interrupt edge.
 *
 * jsdom can't faithfully run xterm's custom key handler, so like the
 * macCtrlPassthrough lock we pin the source.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
  'utf8',
);

const handlerStart = SRC.indexOf('attachCustomKeyEventHandler');
const handlerEnd = SRC.indexOf('// Right-click behavior', handlerStart);
const HANDLER = SRC.slice(handlerStart, handlerEnd);

describe('useTerminal ctrl-letter encoding + keyboard-state lifecycle (source-level lock)', () => {
  it('locates the custom key event handler', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
  });

  it('Ctrl+C copy branch is matched before the catch-all SIGINT encoder', () => {
    // Copy-with-selection must win: if the catch-all resolveCtrlLetterByte ran
    // first, a selected Ctrl+C would send 0x03 and never copy.
    const copyBranch = HANDLER.indexOf("resolveCtrlLetterByte(e) === '\\x03'");
    const catchAll = HANDLER.indexOf('const ctrlByte = resolveCtrlLetterByte(e)');
    expect(copyBranch).toBeGreaterThan(-1);
    expect(catchAll).toBeGreaterThan(-1);
    expect(copyBranch).toBeLessThan(catchAll);
  });

  it('the catch-all ctrl write runs the keystroke side effects', () => {
    // #1228 C2: the SIGINT path (Dvorak Ctrl+C, #1227) must feed the
    // interrupt observer via noteUserKeystroke, not just the watchdog.
    expect(HANDLER).toMatch(
      /if \(ctrlByte\) \{\s*e\.preventDefault\(\);\s*window\.electronAPI\.pty\.write\(ptyId, ctrlByte\);\s*noteUserKeystroke\(ctrlByte\);\s*return false;/,
    );
  });

  it('disabled-shortcut branch encodes the logical ctrl byte before returning true', () => {
    // #1152: a combo disabled in Settings must reach the PTY as a control
    // byte, not bubble dead. resolveCtrlLetterByte runs before the return.
    const guard = SRC.indexOf('matchesDisabledShortcut(');
    const encode = SRC.indexOf('const disabledCtrl = resolveCtrlLetterByte(e);', guard);
    const passThrough = SRC.indexOf('return true;', encode);
    expect(guard).toBeGreaterThan(-1);
    expect(encode).toBeGreaterThan(guard);
    expect(passThrough).toBeGreaterThan(encode);
  });

  it('all four direct-write sites feed noteUserKeystroke (C2)', () => {
    // Helper definition lives before attachCustomKeyEventHandler, so exactly
    // the four call sites (newline, IME Escape, disabled ctrl, catch-all
    // ctrl) are inside the handler slice.
    const calls = HANDLER.match(/noteUserKeystroke\(/g) ?? [];
    expect(calls.length).toBe(4);
    expect(HANDLER).toMatch(/noteUserKeystroke\(newlineByte\);/);
    expect(HANDLER).toMatch(/noteUserKeystroke\('\\x1b'\);/);
    expect(HANDLER).toMatch(/noteUserKeystroke\(disabledCtrl\);/);
    expect(HANDLER).toMatch(/noteUserKeystroke\(ctrlByte\);/);
  });

  it('an adopted terminal seeds keyboard state from the parked WeakMap (C1)', () => {
    expect(SRC).toMatch(
      /adopted\s*\?\s*parkedKeyboardByTerminal\.get\(terminal\) \?\? INITIAL_REMOTE_KEYBOARD_STATE/,
    );
    expect(SRC).toMatch(/parkedKeyboardByTerminal\.set\(terminal, keyboardRef\.current\)/);
  });

  it('keyboard state resets when the foreground command or agent dies (C1)', () => {
    // Process-truth (agentAliveByPtyId) and OSC 133 (commandRunningByPtyId)
    // alive→dead edges are the same ones #1210 clears agent identity on.
    expect(SRC).toMatch(
      /commandRunningByPtyId\[ptyId\], prev\.commandRunningByPtyId\[ptyId\]/,
    );
    expect(SRC).toMatch(
      /agentAliveByPtyId\[ptyId\], prev\.agentAliveByPtyId\[ptyId\]/,
    );
    expect(SRC).toMatch(/parkedKeyboardByTerminal\.delete\(terminal\)/);
  });

  it('the liveness subscription is torn down on unmount, park or dispose (C1)', () => {
    const park = SRC.indexOf('parkTerminal(ptyId, terminal, parkElement, disposeTerminal);');
    const unsub = SRC.indexOf('unsubscribeKeyboardLiveness();', park);
    const tail = SRC.indexOf('terminalRef.current = null;', unsub);
    expect(park).toBeGreaterThan(-1);
    expect(unsub).toBeGreaterThan(park);
    expect(tail).toBeGreaterThan(unsub);
  });
});
