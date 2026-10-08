import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { holdNewXtermReplies } from '../replyParity';

function replies(term: Terminal, input: string): Promise<string[]> {
  const out: string[] = [];
  term.onData((d) => out.push(d));
  return new Promise((resolve) => term.write(input, () => resolve(out)));
}

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
});
