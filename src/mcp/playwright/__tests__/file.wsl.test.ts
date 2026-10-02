import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The MCP server launched for a WSL agent runs on Windows, so its uploads root
// is a drive path the agent knows as /mnt/<drive>/…. A darwin/linux test host
// has no drive paths, so for the upload tests the translator is replaced by
// one that treats WMUX_DIR as the mounted drive — what is under test is the
// wiring: translation before the sandbox, the sandbox unchanged after it, and
// the agent's spelling in what the tool says back. The translator itself is
// covered by wslPaths.test.ts, and the download test below runs it for real.
const WMUX_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-upload-wsl-')));
const UPLOADS = path.join(WMUX_DIR, 'uploads');
const AGENT_DRIVE = '/mnt/c';

const { mockSendRpc, getPage, resolveRef, fakeTranslator } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveRef: vi.fn(),
  fakeTranslator: { on: false },
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

vi.mock('../../wslPaths', async () => {
  const actual = await vi.importActual<typeof import('../../wslPaths')>('../../wslPaths');
  return {
    ...actual,
    wslMountRoot: (env?: NodeJS.ProcessEnv) => (fakeTranslator.on ? '/mnt/' : actual.wslMountRoot(env)),
    toAgentPath: (p: string, env?: NodeJS.ProcessEnv) => {
      if (!fakeTranslator.on) return actual.toAgentPath(p, env);
      // Like the real translator, the agent's spelling uses / only (a Windows
      // host's path.join gives \).
      return p.startsWith(WMUX_DIR) ? AGENT_DRIVE + p.slice(WMUX_DIR.length).split(path.sep).join('/') : p;
    },
    fromAgentPath: (p: string, env?: NodeJS.ProcessEnv) => {
      if (!fakeTranslator.on) return actual.fromAgentPath(p, env);
      if (p.startsWith(`${AGENT_DRIVE}/`)) return WMUX_DIR + p.slice(AGENT_DRIVE.length).split('/').join(path.sep);
      return p.startsWith('/') ? null : p;
    },
  };
});

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

const tools = collectTools();
const upload = tools.get('browser_file_upload') as ToolHandler;
const download = tools.get('browser_download') as ToolHandler;
const waitForDownload = tools.get('browser_wait_for_download') as ToolHandler;

const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

/** A page whose CDP session accepts a by-path upload and records the files. */
function makeUploadPage() {
  const handed: string[][] = [];
  const client = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 42 };
      if (method === 'DOM.setFileInputFiles') handed.push(params?.files as string[]);
      return {};
    }),
    detach: vi.fn(async () => undefined),
  };
  const page = {
    context: () => ({ newCDPSession: async () => client }),
    $: vi.fn(async () => ({ setInputFiles: vi.fn(async () => undefined) })),
  };
  return { page, handed };
}

/** A page whose next click produces a download Playwright saved on Windows. */
function makeDownloadPage() {
  const dl = {
    path: async () => 'C:\\Users\\me\\AppData\\Local\\Temp\\playwright-artifacts-x\\abc-123',
    suggestedFilename: () => 'report.csv',
    url: () => 'https://cdn.test/report.csv',
    saveAs: async () => undefined,
  };
  return {
    url: () => 'https://app.test/',
    waitForEvent: vi.fn(async () => dl),
  };
}

afterAll(() => {
  fs.rmSync(WMUX_DIR, { recursive: true, force: true });
});

describe('browser_file_upload for a WSL caller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeTranslator.on = true;
    fs.mkdirSync(UPLOADS, { recursive: true });
  });
  afterEach(() => {
    fakeTranslator.on = false;
  });

  it('translates a drive-mount path before the sandbox and hands the browser the host path', async () => {
    const file = path.join(UPLOADS, 'a.png');
    fs.writeFileSync(file, 'x');
    const { page, handed } = makeUploadPage();
    getPage.mockResolvedValue(page);

    const res = await upload({ paths: [`${AGENT_DRIVE}/uploads/a.png`] });

    expect(res.isError).toBeFalsy();
    expect(handed).toEqual([[file]]);
    expect(text(res)).toContain(`Uploaded 1 file(s) from ${AGENT_DRIVE}/uploads`);
  });

  it('rejects a distro path and names the uploads root as the agent sees it', async () => {
    const { page, handed } = makeUploadPage();
    getPage.mockResolvedValue(page);

    const res = await upload({ paths: ['/home/me/a.png'] });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('"/home/me/a.png"');
    expect(text(res)).toContain(`${AGENT_DRIVE}/uploads`);
    expect(handed).toEqual([]);
  });

  it('keeps the sandbox on the translated path: .. out of the root is still refused', async () => {
    fs.writeFileSync(path.join(WMUX_DIR, 'secret.txt'), 'x');
    const { page, handed } = makeUploadPage();
    getPage.mockResolvedValue(page);

    const res = await upload({ paths: [`${AGENT_DRIVE}/uploads/../secret.txt`] });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain(`outside the allowed upload root (${AGENT_DRIVE}/uploads)`);
    expect(handed).toEqual([]);
  });
});

// The real translator: Playwright's download paths are Windows paths whatever
// the test host, so the WSL view can be checked end to end.
describe('download paths for a WSL caller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WMUX_WSL_DISTRO = 'Ubuntu';
    process.env.WMUX_WSL_MOUNT = '/mnt/c/';
  });
  afterEach(() => {
    delete process.env.WMUX_WSL_DISTRO;
    delete process.env.WMUX_WSL_MOUNT;
  });

  it('browser_download reports the saved path under the drive mount', async () => {
    getPage.mockResolvedValue(makeDownloadPage());
    resolveRef.mockResolvedValue({ click: vi.fn(async () => undefined) });

    const res = await download({ ref: 'e1' });

    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('Downloaded: /mnt/c/Users/me/AppData/Local/Temp/playwright-artifacts-x/abc-123');
  });

  it('browser_wait_for_download reports the saved path under the drive mount', async () => {
    getPage.mockResolvedValue(makeDownloadPage());

    const res = await waitForDownload({});

    expect(JSON.parse(text(res)).path).toBe('/mnt/c/Users/me/AppData/Local/Temp/playwright-artifacts-x/abc-123');
  });

  it('leaves the same paths in Windows form without the WSL env', async () => {
    delete process.env.WMUX_WSL_DISTRO;
    getPage.mockResolvedValue(makeDownloadPage());
    resolveRef.mockResolvedValue({ click: vi.fn(async () => undefined) });

    const res = await download({ ref: 'e1' });

    expect(text(res)).toContain('Downloaded: C:\\Users\\me\\AppData\\Local\\Temp\\playwright-artifacts-x\\abc-123');
  });
});
