import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * #1280 — Ctrl+G must LEAVE the pane alone on Windows/Linux.
 *
 * xterm's own encode path ends in `cancel()`, which calls stopPropagation, so
 * before #1228 a Ctrl+G was swallowed by xterm and the document-level Rich
 * Input listener never saw it. #1228 added a catch-all `resolveCtrlLetterByte`
 * encoder that writes the byte itself with only `preventDefault()` — the event
 * then bubbles, so the pane got BEL (0x07, `^G` / the agent's external editor)
 * AND the popover opened. Fixing only the modifier match in
 * useComposeShortcut would have left the `^G`.
 *
 * The fix bubbles the key, the way Ctrl+D / Ctrl+T already do, so neither
 * xterm nor the catch-all encoder writes anything — but from its OWN branch
 * testing the exact chord, not from those allowlists: their condition is only
 * `ctrlKey && !shiftKey`, so a row there would also swallow Ctrl+Alt+G and
 * Ctrl+Meta+G, which no handler claims (CodeRabbit on #1286).
 *
 * jsdom cannot run xterm's custom key handler faithfully, so — like the
 * macCtrlPassthrough and ctrlLetterEncoding locks next to this file — we pin
 * the source.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
  'utf8',
);

const handlerStart = SRC.indexOf('attachCustomKeyEventHandler');
const handlerEnd = SRC.indexOf('// Right-click behavior', handlerStart);
const HANDLER = SRC.slice(handlerStart, handlerEnd);

function bubbleList(name: string): string {
  const at = HANDLER.indexOf(`const ${name} = isMac`);
  expect(at).toBeGreaterThan(-1);
  return HANDLER.slice(at, HANDLER.indexOf(';', at));
}

const COMPOSE_BRANCH = /!isMac && e\.ctrlKey && !e\.shiftKey && !e\.altKey && !e\.metaKey\s*\n?\s*&& \(e\.key === 'g' \|\| e\.code === 'KeyG'\)/;

describe('useTerminal bubbles Ctrl+G to the Rich Input listener (#1280)', () => {
  it('locates the custom key event handler', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
  });

  it('bubbles the exact Ctrl+G chord — no Shift, no Alt, no Meta', () => {
    // Alt/Meta excluded on purpose: those chords are not the binding, and a
    // bubble would leave them writing no byte and triggering no action.
    expect(HANDLER).toMatch(COMPOSE_BRANCH);
  });

  it('matches the physical KeyG too, for a non-Latin layout / IME', () => {
    expect(COMPOSE_BRANCH.source).toContain("code === 'KeyG'");
    expect(HANDLER).toMatch(COMPOSE_BRANCH);
  });

  it('is non-mac only — macOS keeps Ctrl+G as a readline byte (⌘G is the binding)', () => {
    const at = HANDLER.search(COMPOSE_BRANCH);
    expect(at).toBeGreaterThan(-1);
    expect(HANDLER.slice(at, at + 20)).toContain('!isMac');
    // And 'g' / KeyG stay out of the shared allowlists, whose mac branch would
    // otherwise hand ⌘-less Ctrl+G to the app on macOS as well.
    const keys = bubbleList('bubbleKeys');
    expect(keys).not.toContain("'g'");
    expect(bubbleList('bubbleCodes')).not.toContain("'KeyG'");
  });

  it('bubbles before the catch-all ctrl encoder, which would write BEL', () => {
    // Order is the whole fix: the catch-all writes 0x07 and returns false.
    expect(HANDLER.search(COMPOSE_BRANCH))
      .toBeLessThan(HANDLER.indexOf('const ctrlByte = resolveCtrlLetterByte(e)'));
  });

  it('the disabled-shortcut branch writes the byte, and runs before the bubble', () => {
    // The escape hatch: Ctrl+G is an advertised keymap row, so a user can
    // switch it off in Settings → Shortcuts and hand the key back to the pane
    // (Claude Code's external editor, readline's abort). That needs the
    // disabled gate to come FIRST and to write the control byte inside its own
    // branch — returning true would let xterm encode it from the QWERTY
    // keyCode instead (#1227). Matched as one contiguous block so the write
    // cannot drift out of the branch (CodeRabbit on #1286).
    const disabledBranch = HANDLER.match(
      /if \(matchesDisabledShortcut\([\s\S]{0,300}?\)\) \{[\s\S]{0,900}?\n {6}\}/,
    );
    expect(disabledBranch).not.toBeNull();
    expect(disabledBranch?.[0]).toMatch(
      /const disabledCtrl = resolveCtrlLetterByte\(e\);\s*if \(disabledCtrl\) \{\s*e\.preventDefault\(\);\s*window\.electronAPI\.pty\.write\(ptyId, disabledCtrl\);\s*noteUserKeystroke\(disabledCtrl\);\s*return false;/,
    );
    expect(HANDLER.indexOf(disabledBranch?.[0] ?? ''))
      .toBeLessThan(HANDLER.search(COMPOSE_BRANCH));
  });
});
