// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  isComposeChord,
  composeOwnerHost,
  TERMINAL_PTY_ATTR,
  COMPOSE_OWNER_ATTR,
  type ComposeChordEventLike,
} from '../composeChord';
import { WMUX_KEYMAP } from '../../../shared/keymap';

/**
 * #1280. This predicate exists so the two gates that both handle ⌘G / Ctrl+G —
 * useTerminal's xterm key handler (does the pane get a byte?) and
 * useComposeShortcut (does Rich Input open?) — cannot disagree. Testing it
 * directly is what lets the source-level lock over useTerminal shrink to the
 * single line that wires it.
 */

const ev = (over: Partial<ComposeChordEventLike> = {}): ComposeChordEventLike => ({
  key: 'g', code: 'KeyG',
  ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
  isComposing: false,
  ...over,
});

describe('isComposeChord', () => {
  it('accepts plain Ctrl+G off macOS', () => {
    expect(isComposeChord(ev(), 'win32')).toBe(true);
    expect(isComposeChord(ev(), 'linux')).toBe(true);
  });

  it('rejects Shift — Ctrl+Shift+G is clearMultiview', () => {
    // The original bug: `key` is 'G' exactly when Shift is held, and the old
    // inline test accepted both spellings of the letter with no shift check.
    expect(isComposeChord(ev({ key: 'G', shiftKey: true }), 'win32')).toBe(false);
  });

  it('accepts an unshifted capital G (Caps Lock)', () => {
    expect(isComposeChord(ev({ key: 'G' }), 'win32')).toBe(true);
  });

  it('rejects Alt and Meta — nobody binds Ctrl+Alt+G / Ctrl+Meta+G', () => {
    // These must keep reaching the pane; swallowing them would leave a key
    // that writes no byte and triggers no action.
    expect(isComposeChord(ev({ altKey: true }), 'win32')).toBe(false);
    expect(isComposeChord(ev({ metaKey: true }), 'win32')).toBe(false);
  });

  it('rejects the bare letter and every other letter', () => {
    expect(isComposeChord(ev({ ctrlKey: false }), 'win32')).toBe(false);
    expect(isComposeChord(ev({ key: 'f', code: 'KeyF' }), 'win32')).toBe(false);
  });

  it('falls back to the physical KeyG under a non-Latin layout', () => {
    // Hangul / Pinyin report a composed jamo or 'Process' in `key`.
    expect(isComposeChord(ev({ key: 'ㅎ' }), 'win32')).toBe(true);
    expect(isComposeChord(ev({ key: 'Process' }), 'win32')).toBe(true);
  });

  it('defers while an IME composition is active', () => {
    // Every other ctrl-letter path defers here (resolveCtrlLetterByte,
    // resolveNewlineKeyByte, the IME-Escape branch). Without it a Hangul
    // preedit plus the physical fallback above popped Rich Input mid-word.
    expect(isComposeChord(ev({ isComposing: true }), 'win32')).toBe(false);
    expect(isComposeChord(ev({ key: 'Process', isComposing: true }), 'win32')).toBe(false);
    expect(isComposeChord(ev({ key: 'g', metaKey: true, ctrlKey: false, isComposing: true }), 'darwin')).toBe(false);
  });

  it('macOS binds ⌘G and leaves literal Ctrl+G to readline', () => {
    expect(isComposeChord(ev({ ctrlKey: false, metaKey: true }), 'darwin')).toBe(true);
    expect(isComposeChord(ev(), 'darwin')).toBe(false);
    // Ctrl+⌘+G is neither: `baseModifier` requires Ctrl to be up on mac.
    expect(isComposeChord(ev({ ctrlKey: true, metaKey: true }), 'darwin')).toBe(false);
  });

  it('accepts auto-repeat — a held chord is still the chord', () => {
    // Repeat is not in the predicate at all, so both gates see the same
    // answer for a repeat tick. The popover gate then declines to TOGGLE on
    // one (flapping is not the ask), which makes Ctrl+G a deliberate
    // non-repeating chord rather than a key that dies between the gates.
    expect(isComposeChord({ ...ev(), key: 'g' }, 'win32')).toBe(true);
  });

  it('no other keymap combo is mistaken for the chord', () => {
    // Swept on BOTH platforms, with ⌘ substituted for Ctrl in the non-literal
    // family the way useKeyboard dispatches it, and `code` filled in from the
    // letter so the physical fallback is exercised too.
    for (const platform of ['win32', 'darwin'] as const) {
      for (const entry of WMUX_KEYMAP) {
        if (entry.combo === 'Ctrl+G') continue;
        expect(isComposeChord(eventForCombo(entry.combo, platform, entry.literalCtrl === true), platform),
          `${entry.combo} on ${platform} must not read as the compose chord`).toBe(false);
      }
    }
  });
});

describe('composeOwnerHost', () => {
  const mount = (ptyId: string | null, owns: boolean): HTMLElement => {
    const host = document.createElement('div');
    if (ptyId !== null) host.setAttribute(TERMINAL_PTY_ATTR, ptyId);
    if (owns) host.setAttribute(COMPOSE_OWNER_ATTR, '');
    const inner = document.createElement('textarea');
    host.appendChild(inner);
    document.body.appendChild(host);
    return inner;
  };

  it('reads the ptyId and the owner marker from the enclosing terminal', () => {
    expect(composeOwnerHost(mount('pty-1', true))).toEqual({ ptyId: 'pty-1', owns: true });
  });

  it('reports a non-owning terminal (floating pane, brain embed)', () => {
    // The live b4135076 failure came from here: the document gate had no way
    // to tell this keydown apart from the active leaf's.
    expect(composeOwnerHost(mount('daemon-floating', false)))
      .toEqual({ ptyId: 'daemon-floating', owns: false });
  });

  it('reports no terminal for an event from elsewhere, and for a null target', () => {
    // Distinct from a FOREIGN terminal: the caller keeps acting on the active
    // leaf here, because the binding never required terminal focus.
    const loose = document.createElement('button');
    document.body.appendChild(loose);
    expect(composeOwnerHost(loose)).toEqual({ ptyId: null, owns: false });
    expect(composeOwnerHost(null)).toEqual({ ptyId: null, owns: false });
    loose.remove();
  });
});

/**
 * Turn a stored combo ('Ctrl+Shift+ArrowUp') into the event that combo
 * actually produces on `platform`. The cmdOrCtrl family fires on ⌘ under
 * macOS; `literalCtrl` rows and rows with no Ctrl at all keep literal Ctrl.
 */
function eventForCombo(
  combo: string,
  platform: NodeJS.Platform,
  literalCtrl: boolean,
): ComposeChordEventLike {
  const parts = combo.split('+');
  // 'Ctrl+Shift++' → the trailing '+' is the key, not a separator.
  const key = parts.pop() || '+';
  const wantsCtrl = parts.includes('Ctrl');
  const mac = platform === 'darwin';
  const useMeta = wantsCtrl && mac && !literalCtrl;
  return {
    key,
    code: /^[A-Za-z]$/.test(key) ? `Key${key.toUpperCase()}` : key,
    ctrlKey: wantsCtrl && !useMeta,
    metaKey: useMeta,
    shiftKey: parts.includes('Shift'),
    altKey: parts.includes('Alt'),
    isComposing: false,
  };
}
