/**
 * Tests for the deterministic newline-key encoder.
 *
 * Regression target: Ctrl+J silently dropped under a CJK IME. xterm.js derives
 * Ctrl+<letter> from the deprecated `keyCode`, which becomes 229 ("Process")
 * with the IME active, so Ctrl+J never produced an LF and in-pane TUIs (codex,
 * Claude Code) never saw the newline. The encoder matches the physical `code`
 * so the byte is emitted regardless of IME/layout state.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveNewlineKeyByte,
  wantsAltEnterNewline,
  foldAtPrompt,
  noteCodexEndedByPrompt,
  CODEX_END_GRACE_MS,
  ALT_ENTER,
  type AltEnterNewlineScope,
  type NewlineKeyEventLike,
} from '../newlineKeys';

function ev(partial: Partial<NewlineKeyEventLike>): NewlineKeyEventLike {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...partial,
  };
}

describe('resolveNewlineKeyByte — Ctrl+J', () => {
  it('emits LF for Ctrl+J via physical code (Latin layout)', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true }))).toBe('\n');
  });

  it('emits LF for Ctrl+J even when an IME mangles key to "Process"', () => {
    // keyCode would be 229 here; we never look at it. code stays 'KeyJ'.
    expect(resolveNewlineKeyByte(ev({ key: 'Process', code: 'KeyJ', ctrlKey: true }))).toBe('\n');
  });

  it('ignores Ctrl+Shift+J (reserved for app shortcuts)', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('ignores Ctrl+Alt+J and Ctrl+Meta+J', () => {
    expect(resolveNewlineKeyByte(ev({ code: 'KeyJ', ctrlKey: true, altKey: true }))).toBeNull();
    expect(resolveNewlineKeyByte(ev({ code: 'KeyJ', ctrlKey: true, metaKey: true }))).toBeNull();
  });

  it('ignores a bare J (no Ctrl)', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ' }))).toBeNull();
  });

  it('defers during an active IME composition (isComposing) so preedit is not split', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Process', code: 'KeyJ', ctrlKey: true, isComposing: true })),
    ).toBeNull();
  });

  it('defers to an explicit user Ctrl+J keybinding', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true }), { hasCustomCtrlJBinding: true }),
    ).toBe(null);
  });

  it('still emits LF when opts is present but no Ctrl+J binding', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true }), { hasCustomCtrlJBinding: false }),
    ).toBe('\n');
  });
});

describe('resolveNewlineKeyByte — Shift+Enter (preserved behavior)', () => {
  it('emits LF for Shift+Enter on a local pane (default fallback, #1152)', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', code: 'Enter', shiftKey: true }))).toBe('\n');
  });

  it('emits LF even when an IME mangles key to "Process"', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Process', code: 'Enter', shiftKey: true })),
    ).toBe('\n');
  });

  it('emits LF for Shift+NumpadEnter', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', code: 'NumpadEnter', shiftKey: true })),
    ).toBe('\n');
  });

  it('defers during an active IME composition so a preedit is not split', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', code: 'Enter', shiftKey: true, isComposing: true })),
    ).toBeNull();
  });

  it('still emits CSI-u when the caller opts into that fallback', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }), { shiftEnterFallback: 'csi-u' }),
    ).toBe('\x1b[13;2u');
  });

  // #1363: the Unicode field carries LF, not CR — ConPTY drops the SHIFT
  // modifier, so a record with Uc=13 reaches the TUI as a plain Enter and the
  // prompt submits. Measured against a live Claude Code pane on Windows.
  it('emits the win32-input-mode pair with Uc=10 when the pane negotiated ?9001h (#1152)', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }), {
        protocol: { win32Input: true },
      }),
    ).toBe('\x1b[13;28;10;1;16;1_\x1b[13;28;0;0;16;1_');
  });

  it('never encodes a carriage return into the win32 record', () => {
    const byte = resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }), {
      protocol: { win32Input: true },
    });
    expect(byte).not.toContain(';13;1;16;');
  });

  it('prefers win32-input-mode over kitty when both were seen', () => {
    // Codex on Windows requests 9001; a stray kitty sequence must not win.
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }), {
        protocol: { win32Input: true, kitty: true },
      }),
    ).toBe('\x1b[13;28;10;1;16;1_\x1b[13;28;0;0;16;1_');
  });

  it('hands Shift+Enter back to xterm when a mirror/web viewer saw no protocol', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }), { shiftEnterFallback: 'xterm' }),
    ).toBeNull();
  });

  it('emits CSI u for a mirror once the remote asked for kitty', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }), {
        protocol: { kitty: true },
        shiftEnterFallback: 'xterm',
      }),
    ).toBe('\x1b[13;2u');
  });

  it('ignores plain Enter', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter' }))).toBeNull();
  });

  it('ignores Ctrl+Shift+Enter', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true, ctrlKey: true }))).toBeNull();
  });

  it('emits modifyOtherKeys mode 2 when that is what the pane asked for', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }), {
        protocol: { modifyOtherKeys: 2 },
      }),
    ).toBe('\x1b[27;2;13~');
  });
});

describe('resolveNewlineKeyByte — Ctrl+Enter', () => {
  it('emits LF for Ctrl+Enter so an in-pane TUI inserts a newline instead of submitting', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', code: 'Enter', ctrlKey: true }))).toBe('\n');
  });

  it('emits LF for Ctrl+Enter even when an IME mangles key to "Process"', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Process', code: 'Enter', ctrlKey: true })),
    ).toBe('\n');
  });

  it('emits LF for Ctrl+Enter on the numeric keypad (NumpadEnter still reports key "Enter")', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', code: 'NumpadEnter', ctrlKey: true }))).toBe('\n');
  });

  it('ignores Ctrl+Shift+Enter (Shift+Enter already owns its CSI u path)', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('ignores Ctrl+Alt+Enter and Ctrl+Meta+Enter', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', ctrlKey: true, altKey: true }))).toBeNull();
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', ctrlKey: true, metaKey: true }))).toBeNull();
  });

  it('defers during an active IME composition so a preedit is not split', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', ctrlKey: true, isComposing: true }))).toBeNull();
  });

  it('ignores a bare Enter (no Ctrl) — plain submit is unchanged', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter' }))).toBeNull();
  });
});

/**
 * #1694 — native Codex on a Windows host. ConPTY's own `?9001h` is ignored
 * there (#1363), so `win32Input` never arms and Shift+Enter fell back to LF,
 * which ConPTY hands Codex as Ctrl+Enter. The newline now keys off the agent
 * and sends Alt+Enter, the chord measured to insert a newline in Codex.
 */
describe('resolveNewlineKeyByte — native Codex on Windows (#1694)', () => {
  const NEWLINE_KEYS: Array<[string, Partial<NewlineKeyEventLike>]> = [
    ['Shift+Enter', { key: 'Enter', code: 'Enter', shiftKey: true }],
    ['Ctrl+Enter', { key: 'Enter', code: 'Enter', ctrlKey: true }],
    ['Ctrl+J', { key: 'j', code: 'KeyJ', ctrlKey: true }],
  ];
  const NATIVE_CODEX: AltEnterNewlineScope = {
    hostPlatform: 'win32',
    isWsl: false,
    agentSlug: 'codex',
    atPrompt: false,
  };
  const PROTOCOL = { kitty: false, win32Input: false, modifyOtherKeys: 0 as const };
  /** Exactly what useTerminal passes, with the scope forced. */
  const opts = (scope: Partial<AltEnterNewlineScope>) => ({
    protocol: PROTOCOL,
    shiftEnterFallback: 'lf' as const,
    altEnterNewline: wantsAltEnterNewline({ ...NATIVE_CODEX, ...scope }),
  });
  /** What the same pane sent before #1694 (no agent-keyed mapping). */
  const before = (e: Partial<NewlineKeyEventLike>) =>
    resolveNewlineKeyByte(ev(e), { protocol: PROTOCOL, shiftEnterFallback: 'lf' });

  it('only native Codex on a win32 host, mid-command, gets the mapping', () => {
    expect(wantsAltEnterNewline(NATIVE_CODEX)).toBe(true);
    expect(wantsAltEnterNewline({ ...NATIVE_CODEX, agentSlug: 'claude' })).toBe(false);
    expect(wantsAltEnterNewline({ ...NATIVE_CODEX, agentSlug: undefined })).toBe(false);
    expect(wantsAltEnterNewline({ ...NATIVE_CODEX, isWsl: true })).toBe(false);
    expect(wantsAltEnterNewline({ ...NATIVE_CODEX, isWsl: undefined })).toBe(false);
    expect(wantsAltEnterNewline({ ...NATIVE_CODEX, atPrompt: true })).toBe(false);
    expect(wantsAltEnterNewline({ ...NATIVE_CODEX, hostPlatform: 'darwin' })).toBe(false);
    expect(wantsAltEnterNewline({ ...NATIVE_CODEX, hostPlatform: 'linux' })).toBe(false);
    expect(wantsAltEnterNewline({ ...NATIVE_CODEX, hostPlatform: null })).toBe(false);
  });

  it.each(NEWLINE_KEYS)('%s in a native Codex pane on win32 sends Alt+Enter (ESC CR)', (_, e) => {
    expect(ALT_ENTER).toBe('\x1b\r');
    expect(resolveNewlineKeyByte(ev(e), opts({}))).toBe(ALT_ENTER);
  });

  it.each(NEWLINE_KEYS)('%s in a Codex pane inside WSL on win32 is unchanged', (_, e) => {
    expect(resolveNewlineKeyByte(ev(e), opts({ isWsl: true }))).toBe(before(e));
    expect(resolveNewlineKeyByte(ev(e), opts({ isWsl: true }))).toBe('\n');
  });

  it('a WSL Codex that negotiated kitty keeps the negotiated Shift+Enter', () => {
    const kitty = { ...PROTOCOL, kitty: true };
    const e = ev({ key: 'Enter', code: 'Enter', shiftKey: true });
    expect(
      resolveNewlineKeyByte(e, {
        protocol: kitty,
        shiftEnterFallback: 'lf',
        altEnterNewline: wantsAltEnterNewline({ ...NATIVE_CODEX, isWsl: true }),
      }),
    ).toBe('\x1b[13;2u');
  });

  it.each(NEWLINE_KEYS)('%s in a Claude Code pane on win32 stays LF', (_, e) => {
    expect(resolveNewlineKeyByte(ev(e), opts({ agentSlug: 'claude' }))).toBe('\n');
  });

  it.each(NEWLINE_KEYS)('%s in a plain PowerShell pane on win32 stays LF', (_, e) => {
    expect(resolveNewlineKeyByte(ev(e), opts({ agentSlug: undefined }))).toBe('\n');
  });

  it.each(['darwin', 'linux'])('a Codex pane on %s is unchanged', (host) => {
    for (const [, e] of NEWLINE_KEYS) {
      expect(resolveNewlineKeyByte(ev(e), opts({ hostPlatform: host }))).toBe(before(e));
    }
  });

  it('still defers to an IME preedit and a custom Ctrl+J binding', () => {
    const codex = opts({});
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true, isComposing: true }), codex)).toBeNull();
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', ctrlKey: true, isComposing: true }), codex)).toBeNull();
    expect(
      resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true }), { ...codex, hasCustomCtrlJBinding: true }),
    ).toBeNull();
  });

  it('plain Enter still submits', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', code: 'Enter' }), opts({}))).toBeNull();
  });
});

/** #1694 review — the mapping ends with the command, not with the slug. */
describe('foldAtPrompt (#1694)', () => {
  const PROMPT = '\x1b]133;D;0\x07\x1b]133;A\x07PS C:\\> ';
  const COMMAND = '\x1b]133;C\x07';

  it('slug still codex + OSC 133;A → back to the previous encoding', () => {
    const atPrompt = foldAtPrompt(false, PROMPT);
    expect(atPrompt).toBe(true);
    const e = ev({ key: 'Enter', code: 'Enter', shiftKey: true });
    expect(
      resolveNewlineKeyByte(e, {
        shiftEnterFallback: 'lf',
        altEnterNewline: wantsAltEnterNewline({
          hostPlatform: 'win32', isWsl: false, agentSlug: 'codex', atPrompt,
        }),
      }),
    ).toBe('\n');
  });

  it('a new command start (133;C) arms it again', () => {
    expect(foldAtPrompt(true, COMMAND)).toBe(false);
  });

  it('the later marker in one chunk wins', () => {
    expect(foldAtPrompt(false, PROMPT + 'codex\r\n' + COMMAND)).toBe(false);
    expect(foldAtPrompt(false, COMMAND + 'bye\r\n' + PROMPT)).toBe(true);
  });

  it('a chunk without a marker keeps the state', () => {
    expect(foldAtPrompt(true, 'plain output\r\n')).toBe(true);
    expect(foldAtPrompt(false, '\x1b[?9001h\x1b[?1004h')).toBe(false);
  });

  it('reads byte chunks the same as strings', () => {
    expect(foldAtPrompt(false, new TextEncoder().encode(PROMPT))).toBe(true);
    expect(foldAtPrompt(true, new TextEncoder().encode(COMMAND))).toBe(false);
  });
});

/**
 * #1694 Windows verify — the slug outlives Codex by a few seconds, and a
 * command started in that window used to re-arm the mapping on its 133;C
 * (measured: a ReadKey logger got `Enter mods=Alt` for Shift+Enter).
 */
describe('end-of-Codex latch (#1694)', () => {
  const PROMPT = '\x1b]133;D;0\x07\x1b]133;A\x07PS C:\\> ';
  const COMMAND = '\x1b]133;C\x07';
  const T0 = 1_000_000;
  const scope = (over: Partial<AltEnterNewlineScope>): AltEnterNewlineScope => ({
    hostPlatform: 'win32', isWsl: false, agentSlug: 'codex', atPrompt: false, ...over,
  });

  /** Replays useTerminal's per-chunk fold for one pane. */
  function replay(chunks: Array<[string, string | undefined, number]>) {
    let atPrompt = false;
    let endedAt: number | null = null;
    for (const [chunk, slug, now] of chunks) {
      const was = atPrompt;
      atPrompt = foldAtPrompt(was, chunk);
      endedAt = noteCodexEndedByPrompt(endedAt, was, atPrompt, slug, now);
    }
    return { atPrompt, endedAt };
  }

  it('a command started while the slug is still codex stays on the old bytes', () => {
    const s = replay([[PROMPT, 'codex', T0], [COMMAND, 'codex', T0 + 1_500]]);
    expect(s.atPrompt).toBe(false);
    expect(s.endedAt).toBe(T0);
    const altEnter = wantsAltEnterNewline(scope({ atPrompt: s.atPrompt, codexEndedAt: s.endedAt, now: T0 + 2_000 }));
    expect(altEnter).toBe(false);
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', code: 'Enter', shiftKey: true }), {
        shiftEnterFallback: 'lf',
        altEnterNewline: altEnter,
      }),
    ).toBe('\n');
  });

  it('a slug still codex after the grace window is a Codex that really runs again', () => {
    const s = replay([[PROMPT, 'codex', T0], [COMMAND, 'codex', T0 + 1_500]]);
    expect(wantsAltEnterNewline(scope({ codexEndedAt: s.endedAt, now: T0 + CODEX_END_GRACE_MS - 1 }))).toBe(false);
    expect(wantsAltEnterNewline(scope({ codexEndedAt: s.endedAt, now: T0 + CODEX_END_GRACE_MS }))).toBe(true);
  });

  it('a cleared latch (slug dropped, then Codex detected again) arms at once', () => {
    expect(wantsAltEnterNewline(scope({ codexEndedAt: null, now: T0 + 1 }))).toBe(true);
  });

  it('only a prompt edge that ends a running Codex stamps the latch', () => {
    // Prompt with no Codex slug: a plain shell, nothing to latch.
    expect(replay([[PROMPT, undefined, T0]]).endedAt).toBeNull();
    // Already at a prompt: a second prompt mark is not a new edge.
    expect(noteCodexEndedByPrompt(null, true, true, 'codex', T0)).toBeNull();
    // A command start never stamps it.
    expect(noteCodexEndedByPrompt(null, true, false, 'codex', T0)).toBeNull();
    // The stamp survives later chunks until the caller clears it.
    expect(noteCodexEndedByPrompt(T0, false, false, 'codex', T0 + 5)).toBe(T0);
  });

  it('a pane where Codex starts from a prompt is armed as before', () => {
    // Fresh pane: prompt (no slug yet), `codex` starts (133;C), slug detected.
    const s = replay([[PROMPT, undefined, T0], [COMMAND, undefined, T0 + 100]]);
    expect(s.endedAt).toBeNull();
    expect(wantsAltEnterNewline(scope({ atPrompt: s.atPrompt, codexEndedAt: s.endedAt, now: T0 + 3_000 }))).toBe(true);
  });
});
