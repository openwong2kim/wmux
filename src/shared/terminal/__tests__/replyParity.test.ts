import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { holdNewXtermReplies, XTERM_60_VT_EXTENSIONS } from '../replyParity';

function replies(term: Terminal, input: string): Promise<string[]> {
  const out: string[] = [];
  term.onData((d) => out.push(d));
  return new Promise((resolve) => term.write(input, () => resolve(out)));
}

/** Whether the cell at column `x` of row 0 is bold after `input`. */
async function boldAt(term: Terminal, input: string, x: number): Promise<boolean> {
  await new Promise<void>((resolve) => term.write(input, resolve));
  return term.buffer.active.getLine(0)!.getCell(x)!.isBold() !== 0;
}

/** Bold, then SGR 221 (kitty "not bold"), then more text. */
const BOLD_THEN_221 = '\x1b[1mA\x1b[221mB';

describe('holdNewXtermReplies', () => {
  it('the installed xterm answers XTVERSION on its own (why the hold exists)', async () => {
    const term = new Terminal({ allowProposedApi: true });
    expect((await replies(term, '\x1b[>q')).join('')).toContain('\x1bP>|xterm.js(');
    term.dispose();
  });

  it('keeps XTVERSION and the color-scheme query unanswered, other replies intact', async () => {
    const term = new Terminal({ allowProposedApi: true });
    holdNewXtermReplies(term);
    expect(term.options.vtExtensions?.colorSchemeQuery).toBe(false);
    // DA1 still answers; XTVERSION does not.
    const out = await replies(term, '\x1b[>q\x1b[>0q\x1b[c');
    expect(out.join('')).not.toContain('xterm.js');
    expect(out.join('')).toContain('\x1b[?1;2c');
    term.dispose();
  });

  it('the installed xterm applies SGR 221 on its own (why the hold exists)', async () => {
    const term = new Terminal({ allowProposedApi: true });
    expect(await boldAt(term, BOLD_THEN_221, 1)).toBe(false);
    term.dispose();
  });

  it('ignores SGR 221 like 6.0, both through the hold and in a snapshot terminal', async () => {
    const held = new Terminal({ allowProposedApi: true });
    holdNewXtermReplies(held);
    expect(await boldAt(held, BOLD_THEN_221, 1)).toBe(true);
    held.dispose();
    // How HeadlessSnapshot builds its terminals: the same values at construction.
    const snapshot = new Terminal({ allowProposedApi: true, vtExtensions: { ...XTERM_60_VT_EXTENSIONS } });
    expect(await boldAt(snapshot, BOLD_THEN_221, 1)).toBe(true);
    snapshot.dispose();
  });
});
