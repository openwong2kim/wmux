// Kitty keyboard-protocol negotiation fold for the wmux web terminal.
//
// The frontend has no bundler: `keyboardProtocol.js` is inlined into
// terminal.html by scripts/build-daemon-web.mjs. Evaluate the shipped file
// verbatim, exactly like copyPasteKeys.test.ts / touchScroll.test.ts, so this
// covers the bytes the browser actually runs.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

type Fold = (prev: { kitty: boolean; modifyOtherKeys: number }, bytes: Uint8Array | string) => {
  kitty: boolean;
  modifyOtherKeys: number;
};

let fold: Fold;
let acceptsCsiU: (state: { kitty: boolean }) => boolean;
let INITIAL_STATE: { kitty: boolean; modifyOtherKeys: number };

const frontend = (name: string) => join(__dirname, '..', 'frontend', name);

const bytes = (s: string): Uint8Array => Array.from(s, (c) => c.charCodeAt(0));

beforeAll(() => {
  const src = readFileSync(frontend('keyboardProtocol.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  runInNewContext(src, sandbox);
  const mod = sandbox.wmuxKeyboardProtocol as Record<string, unknown>;
  fold = mod.foldRemoteKeyboardState as Fold;
  acceptsCsiU = mod.acceptsCsiU as (state: { kitty: boolean }) => boolean;
  INITIAL_STATE = mod.INITIAL_STATE as { kitty: boolean; modifyOtherKeys: number };
});

describe('initial state', () => {
  it('starts not negotiated', () => {
    expect(INITIAL_STATE).toEqual({ kitty: false, modifyOtherKeys: 0 });
  });

  it('does not accept CSI-u before any negotiation', () => {
    expect(acceptsCsiU(INITIAL_STATE)).toBe(false);
  });
});

describe('kitty push / set / pop', () => {
  it('a kitty push (CSI > flags u) turns kitty on', () => {
    const next = fold(INITIAL_STATE, bytes('\x1b[>1u'));
    expect(next.kitty).toBe(true);
    expect(acceptsCsiU(next)).toBe(true);
  });

  it('a kitty set (CSI = flags ; mode u) turns kitty on too', () => {
    const next = fold(INITIAL_STATE, bytes('\x1b[=1;2u'));
    expect(next.kitty).toBe(true);
  });

  it('a kitty pop (CSI < flags u) turns kitty back off', () => {
    const on = fold(INITIAL_STATE, bytes('\x1b[>1u'));
    const off = fold(on, bytes('\x1b[<1u'));
    expect(off.kitty).toBe(false);
    expect(acceptsCsiU(off)).toBe(false);
  });
});

describe('modifyOtherKeys', () => {
  it('tracks modifyOtherKeys level separately', () => {
    const next = fold(INITIAL_STATE, bytes('\x1b[>4;2m'));
    expect(next.modifyOtherKeys).toBe(2);
    // mode 2 is NOT kitty — it wants CSI 27 ; ... ~ instead of CSI-u
    expect(next.kitty).toBe(false);
    expect(acceptsCsiU(next)).toBe(false);
  });

  it('modifyOtherKeys off (0) does not negotiate anything', () => {
    const next = fold(INITIAL_STATE, bytes('\x1b[>4;0m'));
    expect(next.modifyOtherKeys).toBe(0);
    expect(acceptsCsiU(next)).toBe(false);
  });
});

describe('robustness', () => {
  it('ordinary output changes nothing and returns the same reference', () => {
    const next = fold(INITIAL_STATE, bytes('hello world\r\n'));
    expect(next).toBe(INITIAL_STATE);
  });

  it('a negotiation buried in pane output is still seen', () => {
    const mixed = bytes('some text\x1b[>1usome more');
    const next = fold(INITIAL_STATE, mixed);
    expect(next.kitty).toBe(true);
  });

  it('a push then a pop in the same chunk lands on the later one', () => {
    const next = fold(INITIAL_STATE, bytes('\x1b[>1u\x1b[<1u'));
    expect(next.kitty).toBe(false);
  });

  it('a string input is accepted as well as bytes', () => {
    const next = fold(INITIAL_STATE, '\x1b[>1u' as string);
    expect(next.kitty).toBe(true);
  });
});
