// The chord table a remote-attach mirror applies before forwarding a keystroke.
//
// The bug this guards (#895): the mirror forwarded EVERY key raw, so the four
// things a terminal does with the LOCAL clipboard and the LOCAL selection were
// gone — Ctrl+C interrupted the remote instead of copying a highlighted line,
// Ctrl+V did nothing at all, and Shift+Enter submitted where it should have
// inserted a newline.
//
// Two properties matter as much as the four fixes, and most cases below exist
// to hold them: an empty selection must still let Ctrl+C interrupt, and a
// read-only host must never see a byte no matter which chord produced it.

import { describe, it, expect } from 'vitest';
import {
  decideMirrorKey,
  decideMirrorKeyWithRepeat,
  type MirrorKeyEventLike,
  type MirrorKeyOptions,
} from '../mirrorInput';

function key(over: Partial<MirrorKeyEventLike> = {}): MirrorKeyEventLike {
  return {
    type: 'keydown',
    key: 'a',
    code: 'KeyA',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...over,
  };
}

function opts(over: Partial<MirrorKeyOptions> = {}): MirrorKeyOptions {
  return { isMac: false, hasSelection: false, readOnly: false, ...over };
}

describe('decideMirrorKey — the four conveniences #895 asked for', () => {
  it('copies the selection on Ctrl+C instead of interrupting', () => {
    const d = decideMirrorKey(key({ key: 'c', code: 'KeyC', ctrlKey: true }), opts({ hasSelection: true }));
    expect(d).toEqual({ kind: 'copy' });
  });

  it('pastes on Ctrl+V', () => {
    const d = decideMirrorKey(key({ key: 'v', code: 'KeyV', ctrlKey: true }), opts());
    expect(d).toEqual({ kind: 'paste' });
  });

  // Shift+Enter is the one newline key whose byte is a NEGOTIATED encoding.
  // `\x1b[13;2u` means "newline" only to an app that asked for kitty; to any
  // other it is Escape followed by `[13;2u`, which in vim's insert mode leaves
  // insert and runs the rest as normal-mode input. A local pane can send it
  // blind because it and the TUI share one xterm; a mirror cannot.
  it('sends the CSI-u newline on Shift+Enter once the remote has asked for it', () => {
    const d = decideMirrorKey(
      key({ key: 'Enter', code: 'Enter', shiftKey: true }),
      opts({ remoteAcceptsCsiU: true }),
    );
    expect(d).toEqual({ kind: 'write', data: '\x1b[13;2u' });
  });

  it('hands Shift+Enter back to xterm when the remote never negotiated', () => {
    // `pass` is the pre-#924 behaviour: xterm encodes the legacy CR, which is
    // what every non-negotiating app expects.
    const d = decideMirrorKey(key({ key: 'Enter', code: 'Enter', shiftKey: true }), opts());
    expect(d).toEqual({ kind: 'pass' });
  });

  // Ctrl+Enter and Ctrl+J send a bare LF, which needs no negotiation at all —
  // the gate above must not swallow them along with the CSI-u one.
  it('still sends LF on Ctrl+Enter without any negotiation', () => {
    const d = decideMirrorKey(key({ key: 'Enter', code: 'Enter', ctrlKey: true }), opts());
    expect(d).toEqual({ kind: 'write', data: '\n' });
  });

  it('sends LF on Ctrl+J, the same byte a local pane emits', () => {
    const d = decideMirrorKey(key({ key: 'j', code: 'KeyJ', ctrlKey: true }), opts());
    expect(d).toEqual({ kind: 'write', data: '\n' });
  });
});

describe('decideMirrorKey — what must NOT be taken away', () => {
  it('lets Ctrl+C through as SIGINT when nothing is selected', () => {
    const d = decideMirrorKey(key({ key: 'c', code: 'KeyC', ctrlKey: true }), opts({ hasSelection: false }));
    expect(d).toEqual({ kind: 'pass' });
  });

  it('forwards an ordinary key untouched', () => {
    expect(decideMirrorKey(key(), opts())).toEqual({ kind: 'pass' });
  });

  it('forwards Ctrl+D — a mirror has no local pane to split, so EOF stays EOF', () => {
    const d = decideMirrorKey(key({ key: 'd', code: 'KeyD', ctrlKey: true }), opts());
    expect(d).toEqual({ kind: 'pass' });
  });

  it('decides nothing on keyup, so a chord is not handled twice', () => {
    const d = decideMirrorKey(
      key({ type: 'keyup', key: 'c', code: 'KeyC', ctrlKey: true }),
      opts({ hasSelection: true }),
    );
    expect(d).toEqual({ kind: 'pass' });
  });

  it('defers Ctrl+J to an explicit user binding', () => {
    const d = decideMirrorKey(
      key({ key: 'j', code: 'KeyJ', ctrlKey: true }),
      opts({ hasCustomCtrlJBinding: true }),
    );
    expect(d).toEqual({ kind: 'pass' });
  });
});

describe('decideMirrorKey — a read-only host receives no bytes', () => {
  // `--allow-input` is off: the remote would reject the write anyway, so the
  // mirror must not send it. Copying stays allowed — it reads local state only.
  it.each([
    ['Ctrl+V', key({ key: 'v', code: 'KeyV', ctrlKey: true })],
    ['Ctrl+Shift+V', key({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true })],
    ['Shift+Enter', key({ key: 'Enter', code: 'Enter', shiftKey: true })],
    ['Ctrl+J', key({ key: 'j', code: 'KeyJ', ctrlKey: true })],
  ])('swallows %s', (_name, ev) => {
    expect(decideMirrorKey(ev, opts({ readOnly: true }))).toEqual({ kind: 'swallow' });
  });

  it('still copies a selection', () => {
    const d = decideMirrorKey(
      key({ key: 'c', code: 'KeyC', ctrlKey: true }),
      opts({ readOnly: true, hasSelection: true }),
    );
    expect(d).toEqual({ kind: 'copy' });
  });
});

describe('decideMirrorKey — macOS uses the Cmd chords', () => {
  const mac = (over: Partial<MirrorKeyOptions> = {}) => opts({ isMac: true, ...over });

  it('copies on ⌘C with a selection', () => {
    const d = decideMirrorKey(key({ key: 'c', code: 'KeyC', metaKey: true }), mac({ hasSelection: true }));
    expect(d).toEqual({ kind: 'copy' });
  });

  it('hands ⌘C back to the OS with no selection', () => {
    const d = decideMirrorKey(key({ key: 'c', code: 'KeyC', metaKey: true }), mac());
    expect(d).toEqual({ kind: 'pass' });
  });

  it('pastes on ⌘V', () => {
    const d = decideMirrorKey(key({ key: 'v', code: 'KeyV', metaKey: true }), mac());
    expect(d).toEqual({ kind: 'paste' });
  });

  it('keeps Ctrl+C as SIGINT even with a selection — copying is ⌘C on mac', () => {
    const d = decideMirrorKey(key({ key: 'c', code: 'KeyC', ctrlKey: true }), mac({ hasSelection: true }));
    expect(d).toEqual({ kind: 'pass' });
  });

  it("keeps Ctrl+V as readline's quoted-insert", () => {
    const d = decideMirrorKey(key({ key: 'v', code: 'KeyV', ctrlKey: true }), mac());
    expect(d).toEqual({ kind: 'pass' });
  });
});

describe('decideMirrorKey — a CJK IME must not disable the clipboard', () => {
  // Under an IME `key` is a composed jamo or the literal 'Process'; xterm's own
  // Ctrl+<letter> path is keyed on the deprecated keyCode and stops matching.
  // Matching the physical `code` is what keeps these chords alive — the same
  // failure useTerminal.ts documents for the local pane.
  it('copies on Ctrl+C when key is a composed jamo', () => {
    const d = decideMirrorKey(key({ key: 'ㅊ', code: 'KeyC', ctrlKey: true }), opts({ hasSelection: true }));
    expect(d).toEqual({ kind: 'copy' });
  });

  it("pastes on Ctrl+V when key is 'Process'", () => {
    const d = decideMirrorKey(key({ key: 'Process', code: 'KeyV', ctrlKey: true }), opts());
    expect(d).toEqual({ kind: 'paste' });
  });

  it('does not inject a newline into an active preedit', () => {
    const d = decideMirrorKey(
      key({ key: 'j', code: 'KeyJ', ctrlKey: true, isComposing: true }),
      opts(),
    );
    expect(d).toEqual({ kind: 'pass' });
  });
});

describe('decideMirrorKey — the explicit Ctrl+Shift forms', () => {
  it('copies on Ctrl+Shift+C with a selection', () => {
    const d = decideMirrorKey(
      key({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }),
      opts({ hasSelection: true }),
    );
    expect(d).toEqual({ kind: 'copy' });
  });

  it('swallows Ctrl+Shift+C with nothing selected rather than typing it', () => {
    const d = decideMirrorKey(
      key({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }),
      opts(),
    );
    expect(d).toEqual({ kind: 'swallow' });
  });

  it('pastes on Ctrl+Shift+V', () => {
    const d = decideMirrorKey(
      key({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }),
      opts(),
    );
    expect(d).toEqual({ kind: 'paste' });
  });

  // Windows reports AltGr as Ctrl+Alt. Without excluding altKey the layouts
  // that put a character on AltGr+C / AltGr+V cannot type it into the remote
  // at all, and emacs' C-M-v arrives as a paste.
  describe('AltGr and other modifier combinations belong to the remote', () => {
    for (const [name, ev] of [
      ['AltGr+C', { key: 'ć', code: 'KeyC', ctrlKey: true, altKey: true }],
      ['AltGr+V', { key: 'w', code: 'KeyV', ctrlKey: true, altKey: true }],
      ['Ctrl+Alt+Shift+C', { key: 'C', code: 'KeyC', ctrlKey: true, altKey: true, shiftKey: true }],
      ['Ctrl+Alt+Shift+V', { key: 'V', code: 'KeyV', ctrlKey: true, altKey: true, shiftKey: true }],
      ['Ctrl+Meta+V', { key: 'v', code: 'KeyV', ctrlKey: true, metaKey: true }],
    ] as const) {
      it(`${name} passes through even with a selection`, () => {
        expect(
          decideMirrorKey(key(ev as Partial<MirrorKeyEventLike>), opts({ hasSelection: true })),
          name,
        ).toEqual({ kind: 'pass' });
      });
    }
  });

  describe('a held key does not repeat a clipboard action', () => {
    it('swallows repeated paste instead of injecting the clipboard again', () => {
      const held = key({ key: 'v', code: 'KeyV', ctrlKey: true, repeat: true });
      expect(decideMirrorKey(held, opts())).toEqual({ kind: 'paste' });
      expect(decideMirrorKeyWithRepeat(held, opts())).toEqual({ kind: 'swallow' });
    });

    it('swallows repeated copy', () => {
      const held = key({ key: 'c', code: 'KeyC', ctrlKey: true, repeat: true });
      expect(decideMirrorKeyWithRepeat(held, opts({ hasSelection: true }))).toEqual({ kind: 'swallow' });
    });

    // Holding Ctrl+C to send repeated SIGINTs is deliberate, so the repeat
    // guard must not touch a decision that was already passing through.
    it('still repeats Ctrl+C to the remote when there is nothing to copy', () => {
      const held = key({ key: 'c', code: 'KeyC', ctrlKey: true, repeat: true });
      expect(decideMirrorKeyWithRepeat(held, opts())).toEqual({ kind: 'pass' });
    });

    it('still repeats ordinary keys', () => {
      const held = key({ key: 'a', code: 'KeyA', repeat: true });
      expect(decideMirrorKeyWithRepeat(held, opts())).toEqual({ kind: 'pass' });
    });
  });
});
