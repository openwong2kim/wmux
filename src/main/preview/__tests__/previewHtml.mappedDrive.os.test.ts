// #3413 — an HTML preview's root and its requests in one path space, on a
// mapped network drive. Windows path rules on every host: `node:path` is
// path.win32 here, and realpath answers as Windows does for a mapped drive
// (the share's UNC spelling), so the drive and share spellings meet as they
// do on a real Windows machine.
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...actual.win32, default: actual.win32 };
});
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: { fromPartition: vi.fn() },
  webContents: { fromId: vi.fn() },
  net: { fetch: vi.fn() },
}));

import { resolveInsideRoot } from '../previewHtml';

/** Z: leads to \\server\my share (a share path with a space); C: is local. */
const links = new Map<string, string>();
async function realpath(p: fs.PathLike): Promise<string> {
  const s = String(p);
  const link = links.get(s.toLowerCase());
  if (link) return link;
  if (/^z:\\/i.test(s)) return `\\\\server\\my share\\${s.slice(3)}`.replace(/\\$/, '');
  if (/^c:\\/i.test(s)) return s;
  throw Object.assign(new Error(`ENOENT: ${s}`), { code: 'ENOENT' });
}

describe('resolveInsideRoot on a mapped network drive (#3413)', () => {
  beforeEach(() => {
    links.clear();
    vi.spyOn(fs.promises, 'realpath').mockImplementation(realpath as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves a file on the drive: the root is spelled from the drive, and so is the request, although its real path is the share', async () => {
    const entry = { root: 'Z:\\Team Docs\\site', pageDirSegments: ['pages'] };
    expect(await resolveInsideRoot(entry, '/pages/index.html')).toBe('Z:\\Team Docs\\site\\pages\\index.html');
    expect(await resolveInsideRoot(entry, '/assets/app.css')).toBe('Z:\\Team Docs\\site\\assets\\app.css');
  });

  it('still refuses what it refused: a link on the drive to another share, a dot-name, and a path out of the root', async () => {
    const entry = { root: 'Z:\\Team Docs\\site', pageDirSegments: ['pages'] };
    links.set('z:\\team docs\\site\\pages\\elsewhere.css', '\\\\other\\share\\x.css');
    expect(await resolveInsideRoot(entry, '/pages/elsewhere.css')).toBeNull();
    expect(await resolveInsideRoot(entry, '/.env')).toBeNull();
    expect(await resolveInsideRoot(entry, '/../secret.txt')).toBeNull();
    // A link inside the root to another folder of the same share, outside the root.
    links.set('z:\\team docs\\site\\pages\\up.css', '\\\\server\\my share\\Team Docs\\private.css');
    expect(await resolveInsideRoot(entry, '/pages/up.css')).toBeNull();
  });

  it('a local root is unchanged, and a link from it onto a share is refused', async () => {
    const entry = { root: 'C:\\work\\site', pageDirSegments: [] };
    expect(await resolveInsideRoot(entry, '/index.html')).toBe('C:\\work\\site\\index.html');
    links.set('c:\\work\\site\\shared.css', '\\\\server\\my share\\shared.css');
    expect(await resolveInsideRoot(entry, '/shared.css')).toBeNull();
  });

  it('a root in share spelling serves nothing: a share is never opened by its UNC path', async () => {
    // The share resolves, so only a refusal before any filesystem call gives null.
    const unc = '\\\\server\\my share\\Team Docs\\site';
    links.set(`${unc}\\index.html`.toLowerCase(), `${unc}\\index.html`);
    const entry = { root: unc, pageDirSegments: [] };
    expect(await resolveInsideRoot(entry, '/index.html')).toBeNull();
    expect(vi.mocked(fs.promises.realpath).mock.calls.filter(([p]) => String(p).startsWith('\\\\'))).toEqual([]);
  });
});
