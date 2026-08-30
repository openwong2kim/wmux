import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// One temp tree stands in for ~/.wmux, so the sandbox tests can build the
// escape routes they are about (a junction out of the root, a sibling drive)
// without touching the developer's real home.
const WMUX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-upload-test-'));
const UPLOADS = path.join(WMUX_DIR, 'uploads');
const OUTSIDE = path.join(WMUX_DIR, 'outside');

const { mockSendRpc, getPage, resolveRef } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveRef: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get')
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
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerFileTools(server as never, { resolveWorkspaceId: vi.fn(async () => 'ws-test') });
  return tools;
}

const upload = collectTools().get('browser_file_upload');
if (!upload) throw new Error('browser_file_upload failed to register');

/** The CDP traffic uploadViaCdp makes, and what it was handed. */
interface CdpLog {
  setFiles: { files: string[]; nodeId: number } | null;
  selector: string | null;
  detached: boolean;
}

/**
 * A page whose CDP session answers the three-call by-path upload. `nodeId: 0`
 * models CDP's "no match" reply, which is not an error and must fall back.
 */
function makePage(opts: { cdp?: 'ok' | 'nomatch' | 'unavailable' | 'refuses'; domHandle?: boolean } = {}) {
  const mode = opts.cdp ?? 'ok';
  const log: CdpLog = { setFiles: null, selector: null, detached: false };
  const setInputFiles = vi.fn(async () => undefined);

  const client = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') {
        log.selector = String(params?.selector);
        return { nodeId: mode === 'nomatch' ? 0 : 42 };
      }
      if (method === 'DOM.setFileInputFiles') {
        if (mode === 'refuses') throw new Error('Node is not a file input element');
        log.setFiles = { files: params?.files as string[], nodeId: params?.nodeId as number };
        return {};
      }
      return {};
    }),
    detach: vi.fn(async () => { log.detached = true; }),
  };

  const page = {
    context: () => ({
      newCDPSession: async () => {
        if (mode === 'unavailable') throw new Error('no CDP');
        return client;
      },
    }),
    $: vi.fn(async () => (opts.domHandle === false ? null : { setInputFiles })),
  };
  return { page, log, setInputFiles };
}

function write(file: string, bytes = 8): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  return file;
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
});

afterAll(() => {
  fs.rmSync(WMUX_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The sandbox. The transport changed from "Node reads the bytes" to "Chrome
// opens the path", so these are the tests that matter most: the check is now
// the only thing between a page and an arbitrary file.
// ---------------------------------------------------------------------------

describe('browser_file_upload sandbox', () => {
  it('accepts a file inside the uploads root and hands the browser that exact path', async () => {
    const file = write(path.join(UPLOADS, 'clip.mp4'));
    const { page, log } = makePage();
    getPage.mockResolvedValue(page);

    const res = await upload({ paths: [file] });

    expect(res.isError).toBeUndefined();
    expect(log.setFiles?.files).toEqual([fs.realpathSync(file)]);
  });

  it('rejects a path outside the root', async () => {
    const file = write(path.join(OUTSIDE, 'id_rsa'));
    const { page, log } = makePage();
    getPage.mockResolvedValue(page);

    const res = await upload({ paths: [file] });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('outside the allowed upload root');
    expect(log.setFiles).toBeNull();
  });

  it('rejects `..` traversal out of the root', async () => {
    write(path.join(OUTSIDE, 'secret.txt'));
    const { page, log } = makePage();
    getPage.mockResolvedValue(page);

    const res = await upload({ paths: [path.join(UPLOADS, '..', 'outside', 'secret.txt')] });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('outside the allowed upload root');
    expect(log.setFiles).toBeNull();
  });

  it('rejects a symlink INSIDE the root that points out of it', async () => {
    // The escape the new transport would make cheap if realpath were skipped:
    // the path is lexically inside uploads, the bytes are not.
    write(path.join(OUTSIDE, 'secret.txt'));
    const link = path.join(UPLOADS, 'escape');
    fs.rmSync(link, { recursive: true, force: true });
    try {
      fs.symlinkSync(OUTSIDE, link, 'junction');
    } catch {
      return; // unprivileged environment without link support — nothing to assert
    }
    const { page, log } = makePage();
    getPage.mockResolvedValue(page);

    const res = await upload({ paths: [path.join(link, 'secret.txt')] });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('outside the allowed upload root');
    expect(log.setFiles).toBeNull();
  });

  it('rejects a UNC path', async () => {
    const { page, log } = makePage();
    getPage.mockResolvedValue(page);

    const res = await upload({ paths: ['\\\\attacker\\share\\payload.mp4'] });

    expect(res.isError).toBe(true);
    expect(log.setFiles).toBeNull();
  });

  it('rejects the uploads root itself and an empty path', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    expect((await upload({ paths: [UPLOADS] })).isError).toBe(true);
    expect((await upload({ paths: [''] })).isError).toBe(true);
  });

  it('rejects the whole call when any one path escapes', async () => {
    const good = write(path.join(UPLOADS, 'ok.mp4'));
    const bad = write(path.join(OUTSIDE, 'bad.mp4'));
    const { page, log } = makePage();
    getPage.mockResolvedValue(page);

    const res = await upload({ paths: [good, bad] });

    expect(res.isError).toBe(true);
    expect(log.setFiles).toBeNull();
  });

  it('names the real uploads root on success, suffix included', async () => {
    // The message used to say "~/.wmux/uploads/" unconditionally, which is the
    // wrong directory on every suffixed instance.
    const file = write(path.join(UPLOADS, 'clip.mp4'));
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    expect(text(await upload({ paths: [file] }))).toContain(fs.realpathSync(UPLOADS));
  });
});

// ---------------------------------------------------------------------------
// Which transport a call takes. The by-path route is what removes the 50MB cap,
// so "did it actually take that route" is the behaviour to pin.
// ---------------------------------------------------------------------------

describe('browser_file_upload transport', () => {
  it('uploads by path over CDP, without copying the file through Playwright', async () => {
    const file = write(path.join(UPLOADS, 'big.mp4'));
    const { page, log, setInputFiles } = makePage();
    getPage.mockResolvedValue(page);

    await upload({ paths: [file] });

    expect(log.selector).toBe('input[type="file"]');
    expect(log.setFiles?.nodeId).toBe(42);
    expect(setInputFiles).not.toHaveBeenCalled();
    expect(log.detached).toBe(true);
  });

  it('scopes to a caller-supplied selector', async () => {
    const file = write(path.join(UPLOADS, 'clip.mp4'));
    const { page, log } = makePage();
    getPage.mockResolvedValue(page);

    await upload({ paths: [file], selector: '#video-upload input' });

    expect(log.selector).toBe('#video-upload input');
  });

  it('falls back to the DOM handle when there is no CDP session', async () => {
    const file = write(path.join(UPLOADS, 'clip.mp4'));
    const { page, setInputFiles } = makePage({ cdp: 'unavailable' });
    getPage.mockResolvedValue(page);

    const res = await upload({ paths: [file] });

    expect(res.isError).toBeUndefined();
    expect(setInputFiles).toHaveBeenCalledWith([fs.realpathSync(file)], { timeout: 120_000 });
  });

  it('falls back when CDP reports no match, then reports the selector that missed', async () => {
    const file = write(path.join(UPLOADS, 'clip.mp4'));
    const { page } = makePage({ cdp: 'nomatch', domHandle: false });
    getPage.mockResolvedValue(page);

    const res = await upload({ paths: [file], selector: '#nope' });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('No file input element matches selector: #nope');
  });

  it('keeps the plain "no file input" error when no selector was given', async () => {
    // A drop-zone-only uploader: the loud failure is the honest one.
    const file = write(path.join(UPLOADS, 'clip.mp4'));
    const { page } = makePage({ cdp: 'nomatch', domHandle: false });
    getPage.mockResolvedValue(page);

    expect(text(await upload({ paths: [file] }))).toContain('No file input element found on the page.');
  });

  it('surfaces a browser refusal instead of retrying it on the slow path', async () => {
    const file = write(path.join(UPLOADS, 'clip.mp4'));
    const { page, setInputFiles } = makePage({ cdp: 'refuses' });
    getPage.mockResolvedValue(page);

    const res = await upload({ paths: [file] });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('not a file input');
    expect(setInputFiles).not.toHaveBeenCalled();
  });

  it('sends a ref down the Playwright path with an explicit timeout', async () => {
    const file = write(path.join(UPLOADS, 'clip.mp4'));
    const setInputFiles = vi.fn(async () => undefined);
    const { page, log } = makePage();
    getPage.mockResolvedValue(page);
    resolveRef.mockResolvedValue({ setInputFiles });

    await upload({ paths: [file], ref: '3', timeout: 5_000 });

    expect(setInputFiles).toHaveBeenCalledWith([fs.realpathSync(file)], { timeout: 5_000 });
    expect(log.setFiles).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The measured bug: a timed-out upload that actually landed.
// ---------------------------------------------------------------------------

describe('browser_file_upload timeout honesty', () => {
  it('warns that a timed-out upload may have succeeded', async () => {
    const file = write(path.join(UPLOADS, 'clip.mp4'));
    const { page } = makePage({ cdp: 'unavailable' });
    page.$ = vi.fn(async () => ({
      setInputFiles: vi.fn(async () => {
        throw new Error('Timeout 30000ms exceeded.');
      }),
    })) as never;
    getPage.mockResolvedValue(page);

    const res = await upload({ paths: [file] });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Timeout 30000ms exceeded.');
    expect(text(res)).toContain('may have reached the page anyway');
    expect(text(res)).toContain('same file twice');
  });

  it('leaves a non-timeout error alone', async () => {
    const file = write(path.join(UPLOADS, 'clip.mp4'));
    const { page } = makePage({ cdp: 'nomatch', domHandle: false });
    getPage.mockResolvedValue(page);

    expect(text(await upload({ paths: [file] }))).not.toContain('may have reached the page');
  });
});
