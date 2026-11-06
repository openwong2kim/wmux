import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * browser_file_upload on the builtin backend: main sets the files, so the
 * upload no longer depends on a Playwright page being attached. The tool still
 * runs its own path check first, for its wording, and sends main host paths.
 */

const WMUX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-upload-builtin-'));
const UPLOADS = path.join(WMUX_DIR, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
fs.writeFileSync(path.join(UPLOADS, 'clip.mp4'), 'x');
const CLIP = fs.realpathSync(path.join(UPLOADS, 'clip.mp4'));

const { mockSendRpc, getPage, resolveRef, backend, frameRefs } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveRef: vi.fn(),
  backend: { value: 'builtin' as string | undefined },
  frameRefs: new Set<string>(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    method.startsWith('browser.lease.') || method === 'browser.lifecycle.get'
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({ getPageForScope: getPage, resolveWorkspaceBackend: async () => backend.value }),
  },
}));

vi.mock('../snapshot', async () => ({
  ...(await vi.importActual<object>('../snapshot')),
  resolveRef,
  isOutstandingFrameRef: (_scope: string, ref: string) => frameRefs.has(ref),
}));

vi.mock('../../../daemon/config', async () => ({
  ...(await vi.importActual<object>('../../../daemon/config')),
  getWmuxDir: () => WMUX_DIR,
}));

import { registerFileTools } from '../tools/file';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const tools = new Map<string, ToolHandler>();
registerFileTools(
  { tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => tools.set(name, handler) } as never,
  { resolveWorkspaceId: vi.fn(async () => 'ws-test') },
);
const upload = tools.get('browser_file_upload') as ToolHandler;
const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');
const run = (args: Record<string, unknown>) => upload({ surfaceId: 'surface-1', paths: [CLIP], ...args });

/** The browser.upload.cdp calls made, params only. */
const uploads = () =>
  mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.upload.cdp').map((c) => c[1] as Record<string, unknown>);

/** A Playwright element handle that records what the page was asked to run. */
function handle(opts: { isFileInput: boolean }) {
  const attrs = new Map<string, string>();
  const node = {
    tagName: opts.isFileInput ? 'INPUT' : 'BUTTON',
    getAttribute: (name: string) => (name === 'type' && opts.isFileInput ? 'file' : attrs.get(name) ?? null),
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    removeAttribute: (name: string) => attrs.delete(name),
  };
  return {
    attrs,
    evaluate: vi.fn(async (fn: (n: unknown, a?: unknown) => unknown, arg?: unknown) => fn(node, arg)),
    evaluateHandle: vi.fn(async () => null),
    setInputFiles: vi.fn(),
  };
}

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({ uploaded: true, count: 1 });
  getPage.mockReset();
  getPage.mockResolvedValue(null);
  resolveRef.mockReset();
  backend.value = 'builtin';
  frameRefs.clear();
});

afterAll(() => {
  fs.rmSync(WMUX_DIR, { recursive: true, force: true });
});

describe('browser_file_upload on builtin goes through main', () => {
  it('sends main the checked host path and the selector, with no Playwright page', async () => {
    const res = await run({ selector: '#pick' });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain('Uploaded 1 file(s)');
    expect(text(res)).toContain('effect_state: committed');
    expect(uploads()).toEqual([
      { files: [CLIP], selector: '#pick', near: false, timeoutMs: 120_000, surfaceId: 'surface-1', workspaceId: 'ws-test' },
    ]);
    expect(getPage).not.toHaveBeenCalled();
  });

  it('passes its timeout to main, and gives the client room for main\'s own answer', async () => {
    await run({ timeout: 4_000 });
    const call = mockSendRpc.mock.calls.find((c) => c[0] === 'browser.upload.cdp');
    expect(call?.[1]).toMatchObject({ timeoutMs: 4_000 });
    expect(call?.[2]).toBe(9_000);
  });

  it('refuses a missing file and a directory itself, before calling main', async () => {
    const missing = await run({ paths: [path.join(UPLOADS, 'later.mp4')] });
    expect(text(missing)).toContain('does not exist');
    fs.mkdirSync(path.join(UPLOADS, 'folder'), { recursive: true });
    const folder = await run({ paths: [path.join(UPLOADS, 'folder')] });
    expect(text(folder)).toContain('is not a regular file');
    expect(uploads()).toEqual([]);
  });

  it('names a selector the page could not parse, as nothing happened', async () => {
    mockSendRpc.mockResolvedValue({ uploaded: false, missing: 'invalid', detail: 'SyntaxError: bad' });
    const res = await run({ selector: 'input >> nth=1' });
    expect(text(res)).toContain('Invalid selector "input >> nth=1": the built-in browser takes CSS selectors only (SyntaxError: bad).');
    expect(text(res)).toContain('error_code: invalid_params');
    expect(text(res)).toContain('effect_state: none');
  });

  it('a lookup the page never answered is a timeout where nothing happened', async () => {
    mockSendRpc.mockResolvedValue({ uploaded: false, missing: 'unanswered' });
    const res = await run({ timeout: 50 });
    expect(text(res)).toContain('did not answer within 50 ms');
    expect(text(res)).toContain('effect_state: none');
  });

  it('a wait that ran out after the files were sent warns that the upload may have landed', async () => {
    for (const message of [
      'browser.upload.cdp: the page did not take the files within 50 ms',
      'RPC timeout: browser.upload.cdp (5050ms)',
    ]) {
      mockSendRpc.mockRejectedValueOnce(new Error(message));
      const res = await run({ timeout: 50 });
      expect(text(res), message).toContain('a blind retry then uploads the same file twice');
      expect(text(res), message).toContain('effect_state: unknown');
    }
  });

  it('does not take a refusal that merely mentions that wording for a timeout', async () => {
    mockSendRpc.mockRejectedValue(
      new Error('browser.upload.cdp blocked: "/x/the page did not take the files within 50 ms" does not exist'),
    );
    const res = await run({});
    expect(text(res)).not.toContain('uploads the same file twice');
  });

  it('defaults to the page\'s first file input', async () => {
    await run({});
    expect(uploads()[0]).toMatchObject({ selector: 'input[type="file"]', near: false });
  });

  it('also when the backend has not been learned yet', async () => {
    backend.value = undefined;
    await run({});
    expect(uploads()).toHaveLength(1);
  });

  it('refuses a path outside the root itself, before calling main', async () => {
    const res = await run({ paths: [path.join(WMUX_DIR, 'elsewhere.txt')] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('outside the allowed upload root');
    expect(text(res)).toContain('effect_state: none');
    expect(uploads()).toEqual([]);
  });

  it('keeps the no-input wording when main finds nothing, and reports that nothing happened', async () => {
    mockSendRpc.mockResolvedValue({ uploaded: false, missing: 'match' });
    const plain = await run({});
    expect(text(plain)).toContain('No file input element found on the page.');
    expect(text(plain)).toContain('effect_state: none');
    const named = await run({ selector: '#nope' });
    expect(text(named)).toContain('No file input element matches selector: #nope');
  });

  it('reports a refusal from main as a failure that may have reached the page', async () => {
    mockSendRpc.mockRejectedValue(new Error('browser.upload.cdp: Node is not a file input element'));
    const res = await run({ selector: 'div' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Node is not a file input element');
    expect(text(res)).toContain('effect_state: unknown');
  });

  it('leaves the Chrome backend on the Playwright route', async () => {
    backend.value = 'chrome';
    await run({});
    expect(uploads()).toEqual([]);
    expect(getPage).toHaveBeenCalled();
  });
});

describe('browser_file_upload by ref on builtin', () => {
  it('with no page, points main at the DOM-snapshot tag and has it search nearby', async () => {
    await run({ ref: '7' });
    expect(uploads()[0]).toMatchObject({ selector: '[data-wmux-ref="7"]', near: true });
  });

  it('with no page, names both misses honestly', async () => {
    mockSendRpc.mockResolvedValue({ uploaded: false, missing: 'match' });
    const gone = await run({ ref: '7' });
    expect(text(gone)).toContain('Could not resolve ref="7" to an element.');
    expect(text(gone)).toContain('effect_state: none');
    mockSendRpc.mockResolvedValue({ uploaded: false, missing: 'near' });
    const far = await run({ ref: '7' });
    expect(text(far)).toContain('No file input found at or near ref="7".');
    expect(text(far)).toContain('effect_state: none');
  });

  it('with a page, resolves the ref there, marks that element, and leaves the input search to main', async () => {
    const button = handle({ isFileInput: false });
    getPage.mockResolvedValue({ url: () => 'https://app.test/' });
    resolveRef.mockResolvedValue(button);
    let markedDuringCall = '';
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'browser.upload.cdp') markedDuringCall = button.attrs.get('data-wmux-upload') ?? '';
      return { uploaded: true, count: 1 };
    });
    const res = await run({ ref: '12' });
    expect(res.isError).toBeUndefined();
    expect(markedDuringCall).toMatch(/^[0-9a-f]{16}$/);
    expect(uploads()[0]).toMatchObject({ selector: `[data-wmux-upload="${markedDuringCall}"]`, near: true });
    expect(button.attrs.has('data-wmux-upload')).toBe(false);
    // The nearby-input search is main's, in its isolated world: none runs here.
    expect(button.evaluateHandle).not.toHaveBeenCalled();
  });

  it('refuses a ref whose mark main found on more than one element', async () => {
    mockSendRpc.mockResolvedValue({ uploaded: false, missing: 'ambiguous' });
    const res = await run({ ref: '7' });
    expect(text(res)).toContain('ref="7" now names more than one element');
    expect(text(res)).toContain('effect_state: none');
  });

  it('unmarks the input even when main fails', async () => {
    const input = handle({ isFileInput: true });
    getPage.mockResolvedValue({ url: () => 'https://app.test/' });
    resolveRef.mockResolvedValue(input);
    mockSendRpc.mockRejectedValue(new Error('browser.upload.cdp: WebContents unavailable'));
    expect((await run({ ref: '12' })).isError).toBe(true);
    expect(input.attrs.has('data-wmux-upload')).toBe(false);
  });

  it('with a page, a ref it cannot resolve is refused without calling main', async () => {
    getPage.mockResolvedValue({ url: () => 'https://app.test/' });
    resolveRef.mockResolvedValue(null);
    const res = await run({ ref: '12' });
    expect(text(res)).toContain('Could not resolve ref="12" to an element.');
    expect(uploads()).toEqual([]);
  });

  it('refuses a frame ref instead of trying a main-document tag', async () => {
    frameRefs.add('9');
    const res = await run({ ref: '9' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('minted inside an iframe');
    expect(uploads()).toEqual([]);
  });
});
