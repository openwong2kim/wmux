// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// xterm reads navigator.platform once, when its module loads. Set it first.
vi.hoisted(() => {
  Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
});

import { Terminal } from '@xterm/xterm';
import { installCanvas2dStub } from '../../../test-utils/canvas2dStub';
import { resolveCtrlAltLetterBytes } from '../ctrlLetterKeys';

// #2136 against the installed xterm on Windows. xterm reads every Ctrl+Alt
// keydown there as AltGr and waits for a keypress; with no AltGr character for
// the key no keypress comes, so the chord never reaches the PTY. wmux's key
// handler writes it first. The handler's own placement is pinned in
// hooks/__tests__/useTerminal.ctrlLetterEncoding.os.test.ts.
describe('Ctrl+Alt+letter on Windows (#2136)', () => {
  const terms: Terminal[] = [];
  beforeAll(() => {
    installCanvas2dStub();
    window.matchMedia ??= ((q: string) => ({
      matches: false, media: q, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => { terms.splice(0).forEach((t) => t.dispose()); });

  function textarea(term: Terminal): HTMLTextAreaElement {
    if (!term.textarea) throw new Error('terminal is not open');
    return term.textarea;
  }

  /**
   * What reaches the PTY for one key press, with or without wmux's branch.
   * The branch cancels the keydown like the real handler; as in Chromium, a
   * cancelled keydown gets no keypress. `char` is the character the layout
   * produces in the keypress, if any.
   */
  function sent(withHandler: boolean, init: KeyboardEventInit & { keyCode: number }, char?: string) {
    const term = new Terminal({ allowProposedApi: true });
    terms.push(term);
    term.open(document.body.appendChild(document.createElement('div')));
    const data: string[] = [];
    term.onData((d) => data.push(d));
    if (withHandler) {
      term.attachCustomKeyEventHandler((e) => {
        const bytes = e.type === 'keydown' ? resolveCtrlAltLetterBytes(e, navigator.platform.startsWith('Win')) : null;
        if (!bytes) return true;
        e.preventDefault();
        data.push(bytes);
        return false;
      });
    }
    const down = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(down, 'keyCode', { value: init.keyCode });
    textarea(term).dispatchEvent(down);
    if (char !== undefined && !down.defaultPrevented) {
      const press = new KeyboardEvent('keypress', { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(press, 'keyCode', { value: char.charCodeAt(0) });
      Object.defineProperty(press, 'charCode', { value: char.charCodeAt(0) });
      textarea(term).dispatchEvent(press);
    }
    return data;
  }

  const ctrlAltD = { key: 'd', code: 'KeyD', keyCode: 68, ctrlKey: true, altKey: true };

  it('xterm alone sends nothing for Ctrl+Alt+D', () => {
    expect(navigator.platform).toBe('Win32');
    expect(sent(false, ctrlAltD)).toEqual([]);
  });

  it('with the branch the pane gets ESC + Ctrl+D', () => {
    expect(sent(true, ctrlAltD)).toEqual(['\x1b\x04']);
  });

  it('plain Ctrl+D and Alt+D are still xterm\'s', () => {
    expect(sent(true, { key: 'd', code: 'KeyD', keyCode: 68, ctrlKey: true })).toEqual(['\x04']);
    expect(sent(true, { key: 'd', code: 'KeyD', keyCode: 68, altKey: true })).toEqual(['\x1bd']);
  });

  it('an AltGr character still goes through xterm\'s keypress path', () => {
    // AltGr+Q on a German layout: keydown with Ctrl+Alt and key '@', then the keypress.
    const altGrQ = { key: '@', code: 'KeyQ', keyCode: 81, ctrlKey: true, altKey: true };
    expect(sent(false, altGrQ, '@')).toEqual(['@']);
    expect(sent(true, altGrQ, '@')).toEqual(['@']);
  });
});
