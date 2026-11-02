import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanAsIs, cleanCopyText, type AgentReply } from '../agentReplyCopy';

// Each fixture is a real Claude Code 2.1.316 screen (a seeded transcript shown
// with `--resume`, rendered by @xterm/headless at `cols` columns, banner rows
// dropped) and the parts of the replies on it.
interface Fixture { cols: number; rows: string[]; replies: AgentReply[] }

function fixture(name: string): Fixture {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'agentReplyCopy', `${name}.json`), 'utf8')) as Fixture;
}

/** What xterm's selection gives for a drag from the first `from` on screen to
 *  the end of the first `to` at or after it: each row cut to the selected
 *  columns and right-trimmed, rows joined with newlines. */
function select(fx: Fixture, from: string, to: string): string {
  const r1 = fx.rows.findIndex((row) => row.includes(from));
  const c1 = fx.rows[r1].indexOf(from);
  let r2 = r1;
  while (!fx.rows[r2].includes(to, r2 === r1 ? c1 : 0)) r2++;
  const c2 = fx.rows[r2].indexOf(to, r2 === r1 ? c1 : 0) + to.length;
  return fx.rows
    .slice(r1, r2 + 1)
    .map((row, i) => row.slice(i === 0 ? c1 : 0, i === r2 - r1 ? c2 : undefined).trimEnd())
    .join('\n');
}

function copy(name: string, from: string, to: string): string | null {
  const fx = fixture(name);
  return cleanCopyText(select(fx, from, to), fx.replies);
}

const SECOND_PARAGRAPH =
  'A second paragraph that is long enough to wrap at sixty columns for sure, and it keeps going past one hundred columns too so we see the wrap.';

describe('cleanCopyText: a span of one reply', () => {
  it('a command the TUI wrapped copies on one line', () => {
    expect(copy('wrapcmd.60', 'docker', '--remove-orphans'))
      .toBe('docker compose -f docker-compose.prod.yml up --build --force-recreate --remove-orphans');
  });

  it('a URL broken at the pane edge copies unbroken', () => {
    const url = 'https://example.com/a/very/long/path/that/goes/on/and/on/segment/another-segment/yet-another?query=1&b=2';
    expect(copy('url.60', 'https', 'b=2')).toBe(url);
    expect(copy('url.100', 'https', 'b=2')).toBe(url);
  });

  it('a code block copies its body verbatim, without the margin', () => {
    expect(copy('fence_nolang.60', 'plain', 'two')).toBe('plain line one\n    indented line two');
    expect(copy('fence_lang.100', 'const', '}')).toBe('const a = 1;\nfunction g(b: number) {\n  return a + b;\n}');
  });

  it('a long line of code wrapped by the TUI copies as the one line it is', () => {
    expect(copy('longcode.60', 'curl', '--verbose')).toBe(
      'curl -fsSL https://example.com/install.sh | bash -s -- --prefix /opt/tools --with-feature-alpha --with-feature-beta --verbose',
    );
  });

  it('a whole reply, from its marker on, copies with its parts one blank line apart', () => {
    expect(copy('basic.60', '⏺', 'Done.')).toBe(
      `Here is bold text and italic text and inline code in one line.\n\n${SECOND_PARAGRAPH}\n\ndef f(x):\n    return x + 1\n\nDone.`,
    );
  });

  it('newlines around a part do not widen the gap between parts', () => {
    const fx = fixture('fence_lang.60');
    const padded = fx.replies.map((reply) =>
      reply.map((part) => (part.kind === 'prose' ? { ...part, text: `\n${part.text}\n\n` } : { ...part, body: `${part.body}\n` })),
    );
    expect(cleanCopyText(select(fx, 'Code:', 'End.'), padded))
      .toBe('Code:\n\nconst a = 1;\nfunction g(b: number) {\n  return a + b;\n}\n\nEnd.');
  });

  it('a span from the middle of a paragraph copies just that span', () => {
    expect(copy('basic.60', 'long enough', 'one hundred'))
      .toBe('long enough to wrap at sixty columns for sure, and it keeps going past one hundred');
  });

  it('bold, italic and inline-code markers are not put back', () => {
    expect(copy('basic.100', 'Here', 'line.')).toBe('Here is bold text and italic text and inline code in one line.');
    expect(copy('emph.60', 'Plain', 'end.'))
      .toBe('Plain bold words then italic words then under italic then under bold and both end.');
    expect(copy('inline.60', 'Run', 'exit.')).toBe('Run npm test -- --run and then git status before exit.');
  });

  it('a code span begun from the margin of an indented line keeps its relative indentation', () => {
    const replies: AgentReply[] = [[{ kind: 'code', body: 'def f():\n    a = 1\n    if a:\n        return a' }]];
    expect(cleanCopyText('      a = 1\n      if a:\n          return a', replies)).toBe('    a = 1\n    if a:\n        return a');
    // Begun on the text itself: the selection starts there, and so does the copy.
    expect(cleanCopyText('a = 1\n      if a:\n          return a', replies)).toBe('a = 1\n    if a:\n        return a');
  });

  it('the reply marker other platforms draw (●) is not part of the copy', () => {
    const replies: AgentReply[] = [[{ kind: 'prose', text: 'Here is the plan.\nThen run it.' }]];
    expect(cleanCopyText('● Here is the plan.\n  Then run it.', replies)).toBe('Here is the plan.\nThen run it.');
  });

  it('bold around a code span loses both markers', () => {
    const replies: AgentReply[] = [[{ kind: 'prose', text: 'And **`npm test`** runs it.\nDone.' }]];
    expect(cleanCopyText('And npm test runs it.\n  Done.', replies)).toBe('And npm test runs it.\nDone.');
  });

  it('headings copy without their #', () => {
    expect(copy('headings.60', '⏺', 'third.')).toBe(
      'Top heading\n\nIntro line.\n\nSecond heading\n\nBody under second.\n\nThird heading\n\nBody under third.',
    );
  });

  it('a blockquote copies without the bar the TUI draws on each row', () => {
    expect(copy('quote.60', 'A quoted', 'Second quoted line.')).toBe(
      'A quoted line that is rather long so that it wraps at sixty columns at least once, here.\nSecond quoted line.',
    );
  });

  it('links copy as the TUI shows them: text (url), autolinks bare', () => {
    expect(copy('links.60', '⏺', 'auto.'))
      .toBe('See the docs page (https://example.com/docs/page) for more, or https://example.com/auto.');
  });

  it('bullets, top-level numbers and rules copy as written', () => {
    expect(copy('lists.60', '- first', '- third')).toBe(
      '- first bullet item\n- second bullet item that is rather long so that it wraps at sixty columns at least once\n  - nested bullet one\n  - nested bullet two\n- third',
    );
    expect(copy('hr.60', '⏺', 'Below the rule.')).toBe('Above the rule.\n\n---\n\nBelow the rule.');
  });
});

describe('cleanCopyText: the pane width does not change the copy', () => {
  // The whole one-reply screen: from the reply marker to the reply's last row.
  function wholeReply(fx: Fixture): string {
    const first = fx.rows.findIndex((row) => row.startsWith('⏺'));
    const chrome = fx.rows.findIndex((row) => row.includes('/effort'));
    let last = chrome - 1;
    while (fx.rows[last].trim() === '') last--;
    return fx.rows.slice(first, last + 1).map((row) => row.trimEnd()).join('\n');
  }

  it.each(['basic', 'headings', 'quote', 'links', 'hr', 'emph', 'inline', 'fence_lang', 'fence_nolang', 'url', 'longcode', 'wrapcmd'])(
    '%s at 100 and 60 columns',
    (name) => {
      const wide = fixture(`${name}.100`);
      const narrow = fixture(`${name}.60`);
      const copied = cleanCopyText(wholeReply(wide), wide.replies);
      expect(copied).not.toBeNull();
      expect(cleanCopyText(wholeReply(narrow), narrow.replies)).toBe(copied);
    },
  );
});

describe('cleanCopyText: anything uncertain copies the selection as it is', () => {
  it('the same passage in two replies', () => {
    expect(copy('dup.60', 'shared', 'replies.')).toBeNull();
    expect(copy('dup.100', 'shared', 'replies.')).toBeNull();
  });

  it('output that is not from an agent', () => {
    const fx = fixture('basic.60');
    expect(cleanCopyText('total 8\ndrwxr-xr-x  3 me  staff  96 Nov  1 09:00 .', fx.replies)).toBeNull();
    expect(cleanCopyText('Here is bold text', [])).toBeNull();
  });

  it('a selection that spills into the prompt', () => {
    expect(copy('basic.60', 'show me things', 'Here is')).toBeNull();
    expect(copy('basic.60', 'Done.', '❯')).toBeNull();
  });

  it('text spaced unlike the reply: a line break or a space the screen does not show', () => {
    const replies: AgentReply[] = [[{ kind: 'prose', text: 'Run it with:' }, { kind: 'code', body: 'npm\ntest' }]];
    // Elsewhere on screen (a tool's output, the prompt): one command, not the reply's two lines.
    expect(cleanCopyText('npm test', replies)).toBeNull();
    // The reply's own lines, as the TUI draws them with its margin.
    expect(cleanCopyText('  npm\n  test', replies)).toBe('npm\ntest');
    // A space where the reply has none.
    expect(cleanCopyText('Run it wi th:', replies)).toBeNull();
    // A wrap inside a word is the TUI's, not a space.
    expect(cleanCopyText('Run it wi\n  th:', replies)).toBe('Run it with:');
  });

  it('a one-row selection with a margin still cleans; one with nothing added at its ends is its own copy', () => {
    const replies: AgentReply[] = [[{ kind: 'prose', text: 'All set.\nDone.' }]];
    expect(cleanCopyText('  Done.', replies)).toBe('Done.');
    expect(cleanAsIs('  Done.')).toBe(false);
    expect(cleanAsIs('⏺ All set.')).toBe(false);
    expect(cleanAsIs('Done.')).toBe(true);
    expect(cleanAsIs('All set.\n  Done.')).toBe(false);
  });

  it('an empty or whitespace-only selection', () => {
    const fx = fixture('basic.60');
    expect(cleanCopyText(' \n  ', fx.replies)).toBeNull();
    expect(cleanCopyText('⏺ ', fx.replies)).toBeNull();
  });

  it('constructs the TUI redraws: table borders, renumbered nested lists', () => {
    for (const cols of [100, 60]) {
      expect(copy(`table.${cols}`, 'alpha', '1')).toBeNull();
      expect(copy(`lists.${cols}`, 'a. nested', 'step b')).toBeNull();
    }
  });
});
