// What the remote asked for, read from what the remote printed.
//
// The mirror encodes a few keys itself (Shift+Enter as `\x1b[13;2u`). That
// byte means "newline" to an app running the kitty keyboard protocol and
// "Escape, then normal-mode input" to one that is not — so the mirror has to
// know which it is talking to, and xterm exposes nothing for it.
import { describe, it, expect } from 'vitest';
import {
  foldRemoteKeyboardState,
  acceptsCsiU,
  INITIAL_REMOTE_KEYBOARD_STATE as INIT,
} from '../keyboardProtocol';

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('foldRemoteKeyboardState', () => {
  it('starts un-negotiated, which is the side that cannot corrupt a session', () => {
    expect(acceptsCsiU(INIT)).toBe(false);
  });

  it('returns the SAME object for output that says nothing about keyboards', () => {
    // Reference equality is the cheap "nothing changed" signal for the caller.
    const after = foldRemoteKeyboardState(INIT, 'hello\r\n\x1b[32mgreen\x1b[0m');
    expect(after).toBe(INIT);
  });

  for (const [name, seq] of [
    ['push with flags', '\x1b[>1u'],
    ['push with a larger flag set', '\x1b[>13u'],
    ['set form', '\x1b[=5;1u'],
  ] as const) {
    it(`recognises the kitty ${name}`, () => {
      expect(acceptsCsiU(foldRemoteKeyboardState(INIT, seq))).toBe(true);
    });
  }

  it('treats a zero flag set as not asking', () => {
    expect(acceptsCsiU(foldRemoteKeyboardState(INIT, '\x1b[>0u'))).toBe(false);
  });

  it('follows a pop back to un-negotiated', () => {
    const on = foldRemoteKeyboardState(INIT, '\x1b[>1u');
    expect(acceptsCsiU(on)).toBe(true);
    expect(acceptsCsiU(foldRemoteKeyboardState(on, '\x1b[<u'))).toBe(false);
  });

  it('lands on the LAST event when a chunk both pushes and pops', () => {
    // An app that starts, finishes and restores inside one flush must not be
    // read as still negotiated because a regex ran in the wrong order.
    expect(acceptsCsiU(foldRemoteKeyboardState(INIT, '\x1b[>1u...\x1b[<u'))).toBe(false);
    expect(acceptsCsiU(foldRemoteKeyboardState(INIT, '\x1b[<u...\x1b[>1u'))).toBe(true);
  });

  // modifyOtherKeys mode 2 wants `CSI 27 ; 2 ; 13 ~`, not CSI-u. Counting it
  // as "negotiated" would send the wrong escape to an app that asked for a
  // different one — the same class of mistake, one protocol over.
  it('tracks modifyOtherKeys without treating it as a CSI-u agreement', () => {
    const s = foldRemoteKeyboardState(INIT, '\x1b[>4;2m');
    expect(s.modifyOtherKeys).toBe(2);
    expect(acceptsCsiU(s)).toBe(false);
    expect(foldRemoteKeyboardState(s, '\x1b[>4;0m').modifyOtherKeys).toBe(0);
  });

  it('reads raw bytes, which is what the mirror actually hands it', () => {
    expect(acceptsCsiU(foldRemoteKeyboardState(INIT, bytes('\x1b[>1u')))).toBe(true);
  });

  it('is not fooled by the sequence appearing as ordinary text', () => {
    // A pane printing documentation about the protocol has no ESC in it.
    expect(acceptsCsiU(foldRemoteKeyboardState(INIT, 'send CSI [>1u to enable'))).toBe(false);
  });
});
