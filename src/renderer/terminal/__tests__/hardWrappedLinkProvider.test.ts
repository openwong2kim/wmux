import { describe, it, expect, vi } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { ILink } from '@xterm/xterm';
import { applyUnicodeWidthModel, terminalCharWidth } from '../../../shared/terminalUnicode';
import type { AgentSlug } from '../../../shared/agentIdentity';
import { createHardWrappedLinkProvider, findHardWrappedLinks } from '../hardWrappedLinkProvider';
import { CLAUDE_WRAPPED_REPLY_80x30 } from './fixtures/claudeWrappedReply';

// Claude Code's fullscreen renderer wraps its own text: it moves the cursor to
// the next row and indents it, so a long URL or path lands on two rows that
// xterm does not know belong together. These tests build such screens and
// check which rows join into one link.

const COLS = 80;

function headless(): HeadlessTerminal {
  const term = new HeadlessTerminal({ cols: COLS, rows: 30, allowProposedApi: true });
  applyUnicodeWidthModel(term);
  return term;
}

function write(term: HeadlessTerminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

const cells = (s: string): number =>
  [...s].reduce((n, ch) => n + terminalCharWidth(ch.codePointAt(0) ?? 0), 0);

/** Pads `head` with prose so `tail` ends at column `COLS - 1 - short`. */
function toMargin(head: string, tail: string, short = 0): string {
  const filler = COLS - short - cells(head) - cells(tail);
  if (filler < 0) throw new Error('row too long');
  return head + 'x'.repeat(filler) + tail;
}

/** Paints rows the way Claude does: cursor moves, no newlines between rows. */
async function screen(rows: string[]): Promise<HeadlessTerminal> {
  const term = headless();
  await write(term, rows.map((row, i) => `\x1b[${i + 1};1H${row}`).join(''));
  return term;
}

function linksAt(term: HeadlessTerminal, y: number, platform: NodeJS.Platform = 'darwin') {
  return findHardWrappedLinks(term.buffer.active, COLS, y, platform);
}

function provide(term: HeadlessTerminal, y: number, slug: AgentSlug | undefined, handlers = {
  activateUrl: vi.fn(),
  openPath: vi.fn(),
}): { links: ILink[] | undefined; handlers: typeof handlers } {
  const provider = createHardWrappedLinkProvider(term, {
    getAgentSlug: () => slug,
    platform: 'darwin',
    ...handlers,
  });
  let links: ILink[] | undefined;
  provider.provideLinks(y + 1, (reply) => { links = reply; });
  return { links, handlers };
}

describe('findHardWrappedLinks', () => {
  it("joins the owner's URL and stops at the closing parenthesis", async () => {
    const term = await screen([
      toMargin('⏺ 그리고 ', ' 목업(https://claude.ai/artifact/LDGd85Xb'),
      '  69ZumnNkPAggHT)도 이 안이 더 낫습니다.',
    ]);
    const url = 'https://claude.ai/artifact/LDGd85Xb69ZumnNkPAggHT';
    for (const y of [0, 1]) {
      const links = linksAt(term, y);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        kind: 'url',
        text: url,
        range: {
          start: { x: COLS - 'https://claude.ai/artifact/LDGd85Xb'.length + 1, y: 1 },
          end: { x: 2 + '69ZumnNkPAggHT'.length, y: 2 },
        },
      });
    }
  });

  it('joins the wrapped URL and path in a real Claude Code capture', async () => {
    const term = headless();
    await write(term, Buffer.from(CLAUDE_WRAPPED_REPLY_80x30, 'base64'));
    const url = 'https://claude.ai/artifact/LDGd85Xb69ZumnNkPAggHTqwertyuiopasdfghjklzxcvbnm1234567890';
    expect(linksAt(term, 17)).toEqual([expect.objectContaining({ kind: 'url', text: url })]);
    expect(linksAt(term, 18)).toEqual([expect.objectContaining({ kind: 'url', text: url })]);
    const path = '/var/folders/_2n8b2_x28ldyspmqm_mbm7r0000gn/T/claude-501/some-session/scratchpad/output-file.txt';
    const pathLinks = linksAt(term, 21);
    expect(pathLinks).toEqual([expect.objectContaining({ kind: 'path', text: path })]);
    // Korean before the path on row 20: the range is in cells, not characters.
    expect(pathLinks[0].range).toEqual({
      start: { x: cells('  임시 파일 경로는 ') + 1, y: 21 },
      end: { x: cells('  -session/scratchpad/output-file.txt'), y: 22 },
    });
    // The URL that fits on row 14 is left to WebLinksAddon.
    expect(linksAt(term, 14)).toEqual([]);
  });

  it('joins a path that wraps mid-segment under a tool-output row', async () => {
    const term = await screen([
      toMargin('  ⎿  Wrote ', ' /Users/me/project/src/components/'),
      '     SettingsPanel.tsx (12 lines)',
    ]);
    expect(linksAt(term, 1)).toEqual([expect.objectContaining({
      kind: 'path',
      text: '/Users/me/project/src/components/SettingsPanel.tsx',
    })]);
  });

  it('joins at most three rows', async () => {
    const tail = 'a1'.repeat(39);
    const rows = [toMargin('  see ', ' https://example.com/'), `  ${tail}`, `  ${tail}`];
    const threeRows = await screen([...rows, '  and more']);
    for (const y of [0, 2]) {
      expect(linksAt(threeRows, y)).toEqual([expect.objectContaining({
        text: `https://example.com/${tail}${tail}`,
      })]);
    }
    // A fourth row would make the link longer than the rows read: no link,
    // rather than a cut-off one.
    const fourRows = await screen([...rows, `  ${tail}`]);
    for (const y of [0, 1, 2, 3]) expect(linksAt(fourRows, y)).toEqual([]);
  });

  describe('does not join', () => {
    it('(a) a URL that ends at the margin, followed by an ordinary word', async () => {
      for (const next of ['  and then we are done.', '  에서 확인하세요.', '  그리고 끝.']) {
        const term = await screen([toMargin('  open ', ' https://example.com/docs'), next]);
        expect(linksAt(term, 0)).toEqual([]);
        expect(linksAt(term, 1)).toEqual([]);
      }
    });

    it('(b) two paths on consecutive rows', async () => {
      for (const second of ['  /Users/me/project/README.md', '  ~/notes/today.md']) {
        const term = await screen([toMargin('  ', ' /Users/me/project/src/index.ts'), second]);
        expect(linksAt(term, 0)).toEqual([]);
        expect(linksAt(term, 1)).toEqual([]);
      }
    });

    it('(c) a list or tool-output row whose next row starts prose', async () => {
      const list = await screen([
        toMargin('  - ', ' https://example.com/a/b'),
        '  - next-item.md is the other one',
      ]);
      expect(linksAt(list, 0)).toEqual([]);
      const listProse = await screen([
        toMargin('  - ', ' https://example.com/a/b'),
        '    see the docs above',
      ]);
      expect(linksAt(listProse, 0)).toEqual([]);
      const numbered = await screen([
        toMargin('  ', ' /Users/me/project/src/index.ts'),
        '  2. run the tests',
      ]);
      expect(linksAt(numbered, 0)).toEqual([]);
      const tool = await screen([
        toMargin('  ⎿  ', ' /Users/me/project/src/index.ts'),
        '     Read 3 files',
      ]);
      expect(linksAt(tool, 0)).toEqual([]);
      const nextTool = await screen([
        toMargin('  ⎿  ', ' /Users/me/project/src/'),
        '  ⎿  index.ts:12',
      ]);
      expect(linksAt(nextTool, 0)).toEqual([]);
    });

    it('(d) a wide character pushed past the margin', async () => {
      // `도` does not fit in the last column, so the row stops one short and
      // the next row starts with it: prose, not the rest of the token.
      const url = await screen([toMargin('  ', ' https://example.com/abc', 1), '  도 확인하세요.']);
      expect(linksAt(url, 0)).toEqual([]);
      const path = await screen([toMargin('  ', ' /Users/me/notes', 1), '  도 보세요.']);
      expect(linksAt(path, 0)).toEqual([]);
      // A row that ends with a wide character at the margin is prose too.
      const prose = await screen([toMargin('  https://example.com/a ', '가나'), '  b/c.txt']);
      expect(linksAt(prose, 0)).toEqual([]);
    });

    it('a token that stops two columns short of the margin', async () => {
      const term = await screen([toMargin('  ', ' https://example.com/abc', 2), '  def/ghi']);
      expect(linksAt(term, 0)).toEqual([]);
    });

    it('a continuation row at a different indent or soft-wrapped', async () => {
      const deeper = await screen([toMargin('  ', ' https://example.com/abc'), '    def/ghi']);
      expect(linksAt(deeper, 0)).toEqual([]);
      const soft = headless();
      // Printing past the margin soft-wraps: WebLinksAddon owns that join.
      await write(soft, `${toMargin('  ', ' https://example.com/abc')}def/ghi`);
      expect(soft.buffer.active.getLine(1)?.isWrapped).toBe(true);
      expect(linksAt(soft, 0)).toEqual([]);
    });
  });

  it('accepts one column of slack when a wide character could not fit', async () => {
    const term = await screen([toMargin('  목업 ', ' https://example.com/abc', 1), '  def1/ghi 입니다']);
    expect(linksAt(term, 1)).toEqual([expect.objectContaining({ text: 'https://example.com/abcdef1/ghi' })]);
  });
});

describe('createHardWrappedLinkProvider', () => {
  const rows = [toMargin('  주소 ', ' https://claude.ai/artifact/LDGd85Xb'), '  69ZumnNkPAggHT)도 보세요.'];

  it('opens the joined URL from either row in a Claude pane', async () => {
    const term = await screen(rows);
    for (const y of [0, 1]) {
      const { links, handlers } = provide(term, y, 'claude');
      const link = links?.[0];
      expect(links).toHaveLength(1);
      const event = { button: 0 } as MouseEvent;
      link?.activate(event, link.text);
      expect(handlers.activateUrl).toHaveBeenCalledWith(event, 'https://claude.ai/artifact/LDGd85Xb69ZumnNkPAggHT');
      expect(handlers.openPath).not.toHaveBeenCalled();
    }
  });

  it('opens a joined path through openPath', async () => {
    const term = await screen([toMargin('  ', ' /Users/me/project/src/'), '  index.ts:12 에서']);
    const { links, handlers } = provide(term, 1, 'claude');
    const link = links?.[0];
    link?.activate({ button: 0 } as MouseEvent, link.text);
    expect(handlers.openPath).toHaveBeenCalledWith('/Users/me/project/src/index.ts');
  });

  it.each([
    [0, true],
    [1, false],
    [2, false],
  ])('mouse button %i opens a joined URL and a joined path: %s (#2901)', async (button, opens) => {
    const event = { button } as MouseEvent;
    const url = provide(await screen(rows), 1, 'claude');
    expect(url.links).toHaveLength(1);
    url.links?.[0].activate(event, url.links[0].text);
    expect(url.handlers.activateUrl).toHaveBeenCalledTimes(opens ? 1 : 0);
    const path = provide(await screen([toMargin('  ', ' /Users/me/project/src/'), '  index.ts:12 에서']), 1, 'claude');
    expect(path.links).toHaveLength(1);
    path.links?.[0].activate(event, path.links[0].text);
    expect(path.handlers.openPath).toHaveBeenCalledTimes(opens ? 1 : 0);
  });

  it('(e) never joins outside a Claude pane', async () => {
    const term = await screen(rows);
    for (const slug of [undefined, 'codex'] as const) {
      expect(provide(term, 0, slug).links).toBeUndefined();
      expect(provide(term, 1, slug).links).toBeUndefined();
    }
  });

  it('answers undefined for a row with no wrapped link, leaving it to the other providers', async () => {
    const term = await screen(['  short https://example.com/x row', '  next row']);
    expect(provide(term, 0, 'claude').links).toBeUndefined();
  });
});
