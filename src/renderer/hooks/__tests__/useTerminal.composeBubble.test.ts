import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isComposeChord } from '../../terminal/composeChord';
import { resolveCtrlLetterByte } from '../../terminal/ctrlLetterKeys';

/**
 * #1280 — who gets the Ctrl+G keydown, the pane or Rich Input.
 *
 * xterm's own encode path ends in `cancel()`, which calls stopPropagation, so
 * before #1228 a Ctrl+G was swallowed by xterm and the document-level Rich
 * Input listener never saw it. #1228 added a catch-all `resolveCtrlLetterByte`
 * encoder that writes the byte itself with only `preventDefault()` — the event
 * then bubbles, so the pane got BEL (0x07, `^G` / the agent's external editor)
 * AND the popover opened. The fix bubbles the chord from useTerminal instead
 * of encoding it, so exactly one of the two happens.
 *
 * But only for the surface that OWNS the chord. `useComposeShortcut` acts on
 * the workspace's active leaf, so a FloatingPane (Ctrl+`) or Deck
 * BrainTerminalEmbed xterm would have the key swallowed here and declined
 * there — a dead key, or a popover aimed at a different pty. Those surfaces do
 * not opt in and keep encoding 0x07.
 *
 * The chord predicate itself is unit-tested in
 * `terminal/__tests__/composeChord.test.ts`; jsdom cannot run xterm's custom
 * key handler, so the wiring is pinned at the source like the neighbouring
 * `macCtrlPassthrough` / `ctrlLetterEncoding` locks — kept to the few lines
 * that matter so reformatting elsewhere cannot break it.
 */

function read(rel: string): string {
  return readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

const SRC = read('src/renderer/hooks/useTerminal.ts');
const handlerStart = SRC.indexOf('attachCustomKeyEventHandler');
const handlerEnd = SRC.indexOf('// Right-click behavior', handlerStart);
const HANDLER = SRC.slice(handlerStart, handlerEnd);

const ctrlG = {
  key: 'g', code: 'KeyG',
  ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
  isComposing: false,
};

describe('the pane gate and the popover gate share one chord predicate (#1280)', () => {
  it('locates the custom key event handler', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
  });

  it('bubbles on isComposeChord, gated by the shared ownership marker', () => {
    // The one line that wires both halves. Both gates read ownership from
    // composeOwnerHost, so they cannot disagree about it any more than about
    // the chord. Anything more specific is the predicates' own tests' job.
    expect(HANDLER).toMatch(/composeOwnerHost\(e\.target\)\.owns && isComposeChord\(e, isMac \? 'darwin' : 'win32'\)/);
    expect(HANDLER).toMatch(/return false; \/\/ let DOM bubble to useComposeShortcut/);
  });

  it('bubbles before the catch-all ctrl encoder, which would write BEL', () => {
    // Order is the whole fix: the catch-all writes 0x07 and returns false.
    expect(HANDLER.indexOf('composeOwnerHost(e.target).owns && isComposeChord'))
      .toBeLessThan(HANDLER.indexOf('const ctrlByte = resolveCtrlLetterByte(e)'));
  });

  it("'g' / KeyG stay out of the shared bubble allowlists", () => {
    // Those lists test only `ctrlKey && !shiftKey`, so a row there would also
    // swallow Ctrl+Alt+G and Ctrl+Meta+G, which nobody claims.
    const list = (name: string) => {
      const at = HANDLER.indexOf(`const ${name} = isMac`);
      expect(at).toBeGreaterThan(-1);
      return HANDLER.slice(at, HANDLER.indexOf(';', at));
    };
    expect(list('bubbleKeys')).not.toContain("'g'");
    expect(list('bubbleCodes')).not.toContain("'KeyG'");
  });

  it('the disabled-shortcut branch writes the byte, and runs before the bubble', () => {
    // The escape hatch: Ctrl+G is an advertised keymap row, so a user can
    // switch it off in Settings → Shortcuts and hand the key back to the pane.
    // That needs the disabled gate FIRST, writing the control byte inside its
    // own branch — returning true would let xterm encode it from the QWERTY
    // keyCode instead (#1227). Matched as one contiguous block so the write
    // cannot drift out of the branch.
    const branch = HANDLER.match(
      /if \(matchesDisabledShortcut\([\s\S]{0,300}?\)\) \{[\s\S]{0,900}?\n {6}\}/,
    );
    expect(branch).not.toBeNull();
    expect(branch?.[0]).toMatch(
      /const disabledCtrl = resolveCtrlLetterByte\(e\);\s*if \(disabledCtrl\) \{\s*e\.preventDefault\(\);\s*window\.electronAPI\.pty\.write\(ptyId, disabledCtrl\);\s*noteUserKeystroke\(disabledCtrl\);\s*return false;/,
    );
    expect(HANDLER.indexOf(branch?.[0] ?? ''))
      .toBeLessThan(HANDLER.indexOf('composeOwnerHost(e.target).owns && isComposeChord'));
  });
});

describe('only the active-leaf terminal owns the chord (#1280 review)', () => {
  it('Terminal.tsx opts in', () => {
    expect(read('src/renderer/components/Terminal/Terminal.tsx'))
      .toMatch(/ownsComposeShortcut: true/);
  });

  it('FloatingPane and BrainTerminalEmbed do NOT opt in', () => {
    // Ctrl+` floating pane and Deck's brain embed are never the active leaf
    // useComposeShortcut resolves, so the popover gate would decline and the
    // key would die if the pane gate swallowed it.
    expect(read('src/renderer/components/Terminal/FloatingPane.tsx'))
      .not.toContain('ownsComposeShortcut');
    expect(read('src/renderer/components/Deck/BrainTerminalEmbed.tsx'))
      .not.toContain('ownsComposeShortcut');
  });

  it('the option defaults to false, so a new embed is dead-key-safe', () => {
    expect(SRC).toMatch(/ownsComposeShortcut = false \} = options;/);
  });

  it('the option is published as the DOM marker both gates read', () => {
    // One source of ownership truth: useTerminal stamps every container with
    // its ptyId and adds the owner attribute only where the option is set, so
    // the document-level gate can reject a foreign terminal's keydown.
    expect(SRC).toMatch(/container\.setAttribute\(TERMINAL_PTY_ATTR, ptyId\);/);
    expect(SRC).toMatch(/if \(ownsComposeShortcut\) container\.setAttribute\(COMPOSE_OWNER_ATTR, ''\);/);
    // And removed on unmount, or the stale marker would outlive the terminal.
    expect(SRC).toMatch(/return \(\) => \{\s*container\.removeAttribute\(TERMINAL_PTY_ATTR\);\s*container\.removeAttribute\(COMPOSE_OWNER_ATTR\);/);
  });

  it('a non-owning terminal still encodes Ctrl+G as BEL', () => {
    // With the bubble branch skipped, the keydown reaches the catch-all
    // encoder, which is the byte the floating pane / brain embed shell (or
    // the agent CLI's external-editor binding) expects — 0x07, exactly what
    // 3.51.0 sent there.
    expect(resolveCtrlLetterByte(ctrlG)).toBe('\x07');
    // And it IS the chord — the predicate is not what excuses the encode;
    // ownership is. Both gates agree about the key either way.
    expect(isComposeChord(ctrlG, 'win32')).toBe(true);
  });
});
