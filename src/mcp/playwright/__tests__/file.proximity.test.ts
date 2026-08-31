import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WMUX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-proximity-test-'));
const UPLOADS = path.join(WMUX_DIR, 'uploads');

const { mockSendRpc, getPage, resolveRef } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveRef: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    method.startsWith('browser.lease.') || method === 'browser.lifecycle.get'
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: { getInstance: () => ({ getPageForScope: getPage }) },
}));

vi.mock('../snapshot', () => ({ resolveRef }));
vi.mock('../../../daemon/config', () => ({ getWmuxDir: () => WMUX_DIR }));

import { registerFileTools } from '../tools/file';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerFileTools(server as never, { resolveWorkspaceId: vi.fn(async () => 'ws-test') });
  return tools;
}

const upload = collectTools().get('browser_file_upload');
if (!upload) throw new Error('browser_file_upload failed to register');

fs.mkdirSync(UPLOADS, { recursive: true });
fs.writeFileSync(path.join(UPLOADS, 'clip.mp4'), 'x');
// The tool hands the REAL path to the browser (/private/... on macOS), so the
// assertions compare against the resolved form.
const FILE = path.join(UPLOADS, 'clip.mp4');
const RESOLVED = fs.realpathSync(FILE);

/**
 * A ref-resolved element. `isFileInput` decides the direct-match test;
 * `nearbyInput` is what the in-page proximity walk finds (null = nothing near).
 */
function makeElement(opts: { isFileInput: boolean; nearbyInput?: { setInputFiles: unknown } | null }) {
  return {
    evaluate: vi.fn(async () => opts.isFileInput),
    evaluateHandle: vi.fn(async () => ({ asElement: () => opts.nearbyInput ?? null })),
    setInputFiles: vi.fn(async () => undefined),
  };
}

const page = { context: () => ({ newCDPSession: async () => null }), $: vi.fn(async () => null) };

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({});
  getPage.mockReset();
  getPage.mockResolvedValue(page);
  resolveRef.mockReset();
});

describe('browser_file_upload proximity search', () => {
  it('uploads straight to the input when the ref already names one', async () => {
    const el = makeElement({ isFileInput: true });
    resolveRef.mockResolvedValue(el);

    const result = await upload({ paths: [FILE], ref: '7' });

    expect(result.isError).toBeUndefined();
    expect(el.setInputFiles).toHaveBeenCalledWith([RESOLVED], expect.anything());
    expect(el.evaluateHandle).not.toHaveBeenCalled();
  });

  it('finds the hidden input near a styled upload button and uploads to that', async () => {
    const hidden = { setInputFiles: vi.fn(async () => undefined) };
    const button = makeElement({ isFileInput: false, nearbyInput: hidden });
    resolveRef.mockResolvedValue(button);

    const result = await upload({ paths: [FILE], ref: '7' });

    expect(result.isError).toBeUndefined();
    expect(button.evaluateHandle).toHaveBeenCalled();
    expect(hidden.setInputFiles).toHaveBeenCalledWith([RESOLVED], expect.anything());
    expect(button.setInputFiles).not.toHaveBeenCalled();
  });

  it('errors with the ref hint when nothing nearby is a file input', async () => {
    const button = makeElement({ isFileInput: false, nearbyInput: null });
    resolveRef.mockResolvedValue(button);

    const result = await upload({ paths: [FILE], ref: '7' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No file input found at or near ref="7"');
    expect(button.setInputFiles).not.toHaveBeenCalled();
  });

  it('points the anchorless selector path at the visible button ref', async () => {
    const result = await upload({ paths: [FILE], selector: '.dropzone' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No file input element matches selector: .dropzone');
    expect(result.content[0].text).toContain("upload button's ref");
  });
});
