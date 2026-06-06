import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  treeToMarkdown,
  extractMarkdown,
  extractStructuredData,
} from '../markdown-extractor';

vi.mock('../../wmux-client', () => ({
  sendRpc: vi.fn(),
}));
import { sendRpc } from '../../wmux-client';
const mockSendRpc = sendRpc as unknown as ReturnType<typeof vi.fn>;

// SerializedNode-shaped helpers (type 1 = element, 3 = text). SerializedNode is
// internal to markdown-extractor, so we mirror its structure with a local type.
type SNode = {
  type: number;
  tag?: string;
  attrs?: Record<string, string>;
  text?: string;
  children?: SNode[];
};
const text = (t: string): SNode => ({ type: 3, text: t });
const el = (tag: string, children: SNode[] = [], attrs: Record<string, string> = {}): SNode => ({
  type: 1,
  tag,
  attrs,
  children,
});

describe('treeToMarkdown', () => {
  it('returns empty string for a null tree', () => {
    expect(treeToMarkdown(null)).toBe('');
  });

  it('converts headings and paragraphs', () => {
    const tree = el('DIV', [
      el('H1', [text('Title')]),
      el('P', [text('Body text')]),
    ]);
    const md = treeToMarkdown(tree);
    expect(md).toContain('# Title');
    expect(md).toContain('Body text');
  });

  it('honors includeLinks', () => {
    const tree = el('P', [
      text('see '),
      el('A', [text('here')], { href: 'https://x.test' }),
    ]);
    expect(treeToMarkdown(tree, { includeLinks: true })).toContain('[here](https://x.test)');
    const plain = treeToMarkdown(tree, { includeLinks: false });
    expect(plain).toContain('here');
    expect(plain).not.toContain('https://x.test');
  });

  it('renders tables', () => {
    const tree = el('TABLE', [
      el('TR', [el('TH', [text('A')]), el('TH', [text('B')])]),
      el('TR', [el('TD', [text('1')]), el('TD', [text('2')])]),
    ]);
    const md = treeToMarkdown(tree);
    expect(md).toContain('| A | B |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| 1 | 2 |');
  });

  it('truncates at maxLength', () => {
    const tree = el('P', [text('x'.repeat(100))]);
    const md = treeToMarkdown(tree, { maxLength: 20 });
    expect(md).toContain('... (truncated)');
    // body slice (20) + suffix
    expect(md.length).toBeLessThan(60);
  });
});

describe('extractMarkdown', () => {
  it('runs the serialise script through the evaluator and converts the tree', async () => {
    const tree = el('H1', [text('Hello')]);
    const evaluate = vi.fn().mockResolvedValue(tree);
    const md = await extractMarkdown(evaluate, {});
    // the injected script is a string that strips noise + serialises the DOM
    const script = evaluate.mock.calls[0][0] as string;
    expect(typeof script).toBe('string');
    expect(script).toContain('serialise');
    expect(md).toContain('# Hello');
  });

  it('returns empty string when the evaluator yields null (no root)', async () => {
    const evaluate = vi.fn().mockResolvedValue(null);
    expect(await extractMarkdown(evaluate, {})).toBe('');
  });
});

describe('extractStructuredData', () => {
  beforeEach(() => mockSendRpc.mockReset());

  it('returns [] for empty fields without touching the page', async () => {
    const page = { evaluate: vi.fn() };
    const out = await extractStructuredData(page as never, undefined, 'goal', {});
    expect(out).toEqual([]);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('returns table data (strategy 1) from the native page path', async () => {
    const rows = [{ name: 'a', price: '1' }];
    const page = { evaluate: vi.fn().mockResolvedValueOnce(rows) };
    const out = await extractStructuredData(page as never, undefined, 'goal', {
      name: 'string',
      price: 'number',
    });
    expect(out).toEqual(rows);
    expect(page.evaluate).toHaveBeenCalledTimes(1); // stopped at first non-empty
  });

  it('falls through table -> list -> repeated until a strategy yields data', async () => {
    const repeated = [{ title: 'card' }];
    const page = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce([]) // tables
        .mockResolvedValueOnce([]) // lists
        .mockResolvedValueOnce(repeated), // repeated
    };
    const out = await extractStructuredData(page as never, undefined, 'goal', { title: 'string' });
    expect(out).toEqual(repeated);
    expect(page.evaluate).toHaveBeenCalledTimes(3);
  });

  it('uses the RPC fallback when no page is available', async () => {
    mockSendRpc.mockResolvedValueOnce({ value: [{ name: 'rpc' }] });
    const out = await extractStructuredData(null, 'surf', 'goal', { name: 'string' });
    expect(out).toEqual([{ name: 'rpc' }]);
    const [method, params] = mockSendRpc.mock.calls[0];
    expect(method).toBe('browser.evaluate');
    expect(params.surfaceId).toBe('surf');
    expect(params.expression).toContain('querySelectorAll'); // stringified table fn
  });
});
