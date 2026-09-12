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
 * The fix is the allowlist Ctrl+D / Ctrl+T already use: bubble the key so
 * neither xterm nor the catch-all encoder writes anything. jsdom cannot run
 * xterm's custom key handler faithfully, so — like the macCtrlPassthrough and
 * ctrlLetterEncoding locks next to this file — we pin the source.
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

describe('useTerminal bubbles Ctrl+G to the Rich Input listener (#1280)', () => {
  it('locates the custom key event handler', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
  });

  it("non-mac bubbleKeys carries 'g'", () => {
    const list = bubbleList('bubbleKeys');
    const nonMac = list.slice(list.indexOf(':'));
    expect(nonMac).toContain("'g'");
  });

  it("non-mac bubbleCodes carries 'KeyG' for the IME/non-Latin layout path", () => {
    const list = bubbleList('bubbleCodes');
    const nonMac = list.slice(list.indexOf(':'));
    expect(nonMac).toContain("'KeyG'");
  });

  it('macOS keeps Ctrl+G as a readline byte (⌘G is the binding there)', () => {
    const keys = bubbleList('bubbleKeys');
    const macKeys = keys.slice(0, keys.indexOf(':'));
    expect(macKeys).not.toContain("'g'");
    const codes = bubbleList('bubbleCodes');
    const macCodes = codes.slice(0, codes.indexOf(':'));
    expect(macCodes).not.toContain("'KeyG'");
  });

  it('the bubble allowlist is reached before the catch-all ctrl encoder', () => {
    // Order is the whole fix: the catch-all writes 0x07 and returns false.
    expect(HANDLER.indexOf('const bubbleKeys = isMac'))
      .toBeLessThan(HANDLER.indexOf('const ctrlByte = resolveCtrlLetterByte(e)'));
  });

  it('the disabled-shortcut gate still precedes the bubble allowlist', () => {
    // A user who switches Ctrl+G off in Settings gets the byte, not the popover.
    expect(HANDLER.indexOf('matchesDisabledShortcut('))
      .toBeLessThan(HANDLER.indexOf('const bubbleKeys = isMac'));
  });
});
