import { describe, expect, it, vi } from 'vitest';
import { generateScopedSnapshot, generateSnapshot } from '../snapshot';

// A rich-text field is a `<div contenteditable>`, and the a11y tree may report
// it under any role at all. YouTube Studio's title and description came back
// under no interactive role, so `browser_snapshot({filter:'interactive'})` told
// an agent the upload dialog had none of the two fields it came for, and
// `selector: "[role=dialog]"` listed one button (dogfood 2026-09-04). The
// snapshot now reads `contenteditable` DOM-side and counts the HOST — never its
// descendants — as interactive.

interface CdpAX {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  childIds?: string[];
}

interface CdpDom {
  backendNodeId?: number;
  attributes?: string[];
  children?: CdpDom[];
}

const role = (value: string) => ({ type: 'role', value });
const name = (value: string) => ({ type: 'name', value });

function ax(id: number, r: string, n: string, children: number[] = []): CdpAX {
  return {
    nodeId: String(id),
    backendDOMNodeId: id,
    role: role(r),
    name: name(n),
    childIds: children.map(String),
  };
}

// The upload dialog: two contenteditable hosts under a role the interactive
// filter does not know, each wrapping a paragraph of its own text.
const UPLOAD_DIALOG: CdpAX[] = [
  ax(1, 'RootWebArea', 'Upload', [2]),
  ax(2, 'dialog', 'Upload details', [3, 5, 7, 9]),
  ax(3, 'generic', '제목', [4]),
  ax(4, 'paragraph', 'My video'),
  ax(5, 'generic', '설명', [6]),
  ax(6, 'paragraph', 'Line one'),
  ax(7, 'generic', 'Read-only note', [8]),
  ax(8, 'paragraph', 'Not editable'),
  ax(9, 'button', 'Next'),
];

const UPLOAD_DOM: CdpDom[] = [
  { backendNodeId: 3, attributes: ['id', 'title-textbox', 'contenteditable', 'true'] },
  { backendNodeId: 5, attributes: ['id', 'description-textbox', 'contenteditable', ''] },
  { backendNodeId: 7, attributes: ['id', 'note', 'contenteditable', 'false'] },
  { backendNodeId: 9, attributes: ['id', 'next-button'] },
];

// selector → backendNodeId, as DOM.querySelector would answer it.
const SELECTORS: Record<string, number> = { '[role=dialog]': 2 };

function makePage(nodes: CdpAX[], domNodes: CdpDom[]) {
  const page = {
    url: () => 'https://studio.example.test/upload',
    title: async () => 'Upload',
    innerText: async () => 'body text',
    on: () => undefined,
    mainFrame: () => ({ id: 'main' }),
    context: () => ({
      newCDPSession: async () => ({
        send: vi.fn(async (method: string, params?: { selector?: string; nodeId?: number }) => {
          switch (method) {
            case 'Accessibility.getFullAXTree':
              return { nodes };
            case 'DOM.getDocument':
              // One answer serves both readers: `nodeId` for the selector
              // resolution, `children` for the contenteditable pass.
              return { root: { nodeId: 1, backendNodeId: 0, children: domNodes } };
            case 'DOM.querySelector':
              return { nodeId: SELECTORS[params?.selector ?? ''] ?? 0 };
            case 'DOM.describeNode':
              return { node: { backendNodeId: params?.nodeId } };
            default:
              return {};
          }
        }),
        detach: vi.fn(() => Promise.resolve()),
      }),
    }),
    evaluate: vi.fn(async () => ''),
    locator: vi.fn(),
    getByRole: vi.fn(),
  };
  return page as never;
}

describe('contenteditable hosts are interactive', () => {
  it('keeps both editable fields under filter:"interactive" and gives each a ref', async () => {
    const out = await generateSnapshot(makePage(UPLOAD_DIALOG, UPLOAD_DOM), {
      format: 'ai',
      filter: 'interactive',
    });

    expect(out).toContain('generic "제목" ref=');
    // A bare `contenteditable` attribute means true, exactly as in HTML.
    expect(out).toContain('generic "설명" ref=');
    expect(out).toContain('button "Next" ref=');
  });

  it('mints a ref for the host only, not for the text inside it', async () => {
    const out = await generateSnapshot(makePage(UPLOAD_DIALOG, UPLOAD_DOM), {
      format: 'ai',
      filter: 'interactive',
    });

    // Every paragraph inside a region is `editable` in the a11y tree, so
    // trusting that would mint one ref per paragraph of a long document. The
    // text stays visible under its host — it just is not separately addressable.
    expect(out).not.toMatch(/paragraph[^\n]*ref=/);
    expect((out.match(/ref="/g) ?? []).length).toBe(3);
  });

  it('leaves contenteditable="false" out — only an explicit false opts out', async () => {
    const out = await generateSnapshot(makePage(UPLOAD_DIALOG, UPLOAD_DOM), {
      format: 'ai',
      filter: 'interactive',
    });

    expect(out).not.toContain('Read-only note');
  });

  it('keeps them inside a scoped snapshot too, which used to list the button alone', async () => {
    const out = await generateScopedSnapshot(makePage(UPLOAD_DIALOG, UPLOAD_DOM), '[role=dialog]', {
      format: 'ai',
      filter: 'interactive',
    });

    expect(out).toContain('generic "제목" ref=');
    expect(out).toContain('generic "설명" ref=');
    expect(out).toContain('button "Next" ref=');
  });
});
