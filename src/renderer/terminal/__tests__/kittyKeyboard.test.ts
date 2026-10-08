// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { installCanvas2dStub } from '../../../test-utils/canvas2dStub';
import {
  imeKeyLeaksUnderKitty,
  installKittyPromptReset,
  kittyKeyboardForHost,
  xtermEncodesKey,
  xtermKittyFlags,
} from '../kittyKeyboard';

const key = (over: Partial<KeyboardEventInit & { keyCode: number; type: string }>) => ({
  type: 'keydown', key: 'a', keyCode: 65, isComposing: false,
  ctrlKey: false, altKey: false, metaKey: false, ...over,
});

describe('kitty keyboard step-aside', () => {
  it('turns the extension on only in the desktop window, and not on Windows', () => {
    expect(kittyKeyboardForHost({ platform: 'darwin' })).toBe(true);
    expect(kittyKeyboardForHost({ platform: 'linux' })).toBe(true);
    expect(kittyKeyboardForHost({ platform: 'win32' })).toBe(false);
    expect(kittyKeyboardForHost({ platform: 'darwin', hostPlatform: () => 'darwin' })).toBe(false);
  });

  it('hands a key to xterm only on a negotiated pane and only when xterm can name it', () => {
    expect(xtermEncodesKey(key({ key: 'Escape', keyCode: 27 }), false)).toBe(false);
    expect(xtermEncodesKey(key({ key: 'Escape', keyCode: 27 }), true)).toBe(true);
    expect(xtermEncodesKey(key({ key: 'Enter', keyCode: 13, shiftKey: true }), true)).toBe(true);
    expect(xtermEncodesKey(key({ key: 'c', keyCode: 67, ctrlKey: true }), true)).toBe(true);
    // The IME owns it, or the layout mangled the key: wmux keeps its IME-safe path.
    expect(xtermEncodesKey(key({ key: 'Process', keyCode: 229 }), true)).toBe(false);
    expect(xtermEncodesKey(key({ key: 'Escape', keyCode: 27, isComposing: true }), true)).toBe(false);
    expect(xtermEncodesKey(key({ key: 'ㅊ', keyCode: 67, ctrlKey: true }), true)).toBe(false);
  });
});

describe('xtermjs/xterm.js#6112 against the installed xterm', () => {
  const terms: Terminal[] = [];
  beforeAll(() => {
    installCanvas2dStub();
    window.matchMedia ??= ((q: string) => ({
      matches: false, media: q, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => { terms.splice(0).forEach((t) => t.dispose()); });

  /** A kitty-negotiated terminal; returns what reaches the PTY for one keydown. */
  async function sent(withGuard: boolean, ev: { key: string; code: string; keyCode: number; isComposing: boolean }) {
    const term = new Terminal({ allowProposedApi: true, vtExtensions: { kittyKeyboard: true } });
    terms.push(term);
    term.open(document.body.appendChild(document.createElement('div')));
    await new Promise<void>((r) => term.write('\x1b[>1u', r));
    if (withGuard) term.attachCustomKeyEventHandler((e) => !imeKeyLeaksUnderKitty(e, true));
    const data: string[] = [];
    term.onData((d) => data.push(d));
    const e = new KeyboardEvent('keydown', { key: ev.key, code: ev.code, isComposing: ev.isComposing, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { value: ev.keyCode });
    term.textarea!.dispatchEvent(e);
    return data;
  }

  const candidateSpace = { key: ' ', code: 'Space', keyCode: 32, isComposing: true };

  it('reads the flags xterm encodes with, so a replayed push still counts', async () => {
    // After a reattach the push arrives as replay, which wmux's fold skips;
    // xterm parses it, and the step-aside / #6112 guard follow xterm.
    const term = new Terminal({ allowProposedApi: true, vtExtensions: { kittyKeyboard: true } });
    terms.push(term);
    const write = (s: string) => new Promise<void>((r) => term.write(s, r));
    expect(xtermKittyFlags(term)).toBe(0);
    await write('\x1b[>5u');
    expect(xtermKittyFlags(term)).toBe(5);
    expect(imeKeyLeaksUnderKitty(key({ key: ' ', keyCode: 32, isComposing: true }), xtermKittyFlags(term)! > 0)).toBe(true);
    await write('\x1b[<u');
    expect(xtermKittyFlags(term)).toBe(0);
  });

  it('without the guard the IME candidate key leaks next to the commit', async () => {
    expect(await sent(false, candidateSpace)).toEqual([' ']);
  });

  it('with the guard nothing leaks, and a space outside a composition still goes', async () => {
    expect(await sent(true, candidateSpace)).toEqual([]);
    expect(await sent(true, { key: '1', code: 'Digit1', keyCode: 49, isComposing: true })).toEqual([]);
    expect(await sent(true, { ...candidateSpace, isComposing: false })).toEqual([' ']);
  });

  it('drops the flags of an app that died without popping at the next prompt', async () => {
    const term = new Terminal({ allowProposedApi: true, vtExtensions: { kittyKeyboard: true } });
    terms.push(term);
    installKittyPromptReset(term);
    const replies: string[] = [];
    term.onData((d) => replies.push(d));
    const write = (s: string) => new Promise<void>((r) => term.write(s, r));
    await write('\x1b[>5u\x1b[?u');
    await write('\x1b]133;A\x07$ ');
    await write('\x1b[?u');
    expect(replies).toEqual(['\x1b[?5u', '\x1b[?0u']);
  });
});
