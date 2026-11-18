import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: { fromPartition: vi.fn() },
  webContents: { fromId: vi.fn() },
  net: { fetch: vi.fn() },
}));

import { htmlPreviewUrl } from '../../../shared/filePreview';
import { FAR_IDS, fakeFileIds } from '../../../test-utils/fileIds';
import {
  chooseHtmlRoot,
  closeHtmlPreview,
  htmlNavigationVerdict,
  htmlPreviewStatsForTests,
  openHtmlPreview,
  resolveInsideRoot,
  serveHtmlPreview,
  setHtmlPreviewNetwork,
} from '../previewHtml';

class FakeSender extends EventEmitter {
  static next = 100;
  id = FakeSender.next++;
  isDestroyed() { return false; }
  send() { /* not observed here */ }
}
const asSender = (s: FakeSender) => s as unknown as Electron.WebContents;
const get = (url: string) => serveHtmlPreview(new Request(url));

let dir: string;
let home: string;
let repo: string;
const senders: FakeSender[] = [];
const sender = () => { const s = new FakeSender(); senders.push(s); return s; };

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-html-')));
  home = path.join(dir, 'home');
  repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs', 'api'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs', '_static'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'api', 'foo.html'), '<link rel="stylesheet" href="../_static/x.css"><h1>foo</h1>');
  fs.writeFileSync(path.join(repo, 'docs', '_static', 'x.css'), 'h1{color:red}');
  fs.writeFileSync(path.join(repo, 'docs', 'index.html'), '<h1>docs</h1>');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(home, 'outside.txt'), 'outside the repo');
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'key');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
  for (const s of senders.splice(0)) s.emit('destroyed');
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('html preview root', () => {
  it('is the git worktree, or the folder outside one, never home or a filesystem root', () => {
    expect(chooseHtmlRoot(path.join(repo, 'docs', 'api'))).toBe(repo);
    const loose = path.join(dir, 'loose');
    fs.mkdirSync(loose);
    expect(chooseHtmlRoot(loose)).toBe(loose);
    expect(chooseHtmlRoot(home)).toBeNull();
    // Third-party pages get only their own package, never the project.
    const scoped = path.join(repo, 'node_modules', '@scope', 'pkg', 'docs');
    fs.mkdirSync(scoped, { recursive: true });
    expect(chooseHtmlRoot(scoped)).toBe(path.join(repo, 'node_modules', '@scope', 'pkg'));
    const plain = path.join(repo, 'node_modules', 'lib', 'coverage');
    fs.mkdirSync(plain, { recursive: true });
    expect(chooseHtmlRoot(plain)).toBe(path.join(repo, 'node_modules', 'lib'));
    expect(chooseHtmlRoot(path.parse(dir).root)).toBeNull();
  });
});

describe('resolving a request inside the root', () => {
  const entry = () => ({ root: repo, pageDirSegments: ['docs', 'api'] });

  it('serves files below the root, including the page’s ../ neighbours', async () => {
    expect(await resolveInsideRoot(entry(), '/docs/_static/x.css')).toBe(path.join(repo, 'docs', '_static', 'x.css'));
  });

  it('refuses traversal, backslashes, colons and NUL on the raw path', async () => {
    for (const raw of ['/../outside.txt', '/docs/../../outside.txt', '/docs\\..\\..\\outside.txt', '/C:/x', '/docs/a\0b']) {
      expect(await resolveInsideRoot(entry(), raw), raw).toBeNull();
    }
  });

  it('refuses a symlink that leaves the root or reaches a credential store', async () => {
    fs.symlinkSync(path.join(home, 'outside.txt'), path.join(repo, 'docs', 'leak.txt'));
    fs.symlinkSync(path.join(home, '.ssh'), path.join(repo, 'docs', 'keys'));
    expect(await resolveInsideRoot(entry(), '/docs/leak.txt')).toBeNull();
    expect(await resolveInsideRoot(entry(), '/docs/keys/id_rsa')).toBeNull();
  });

  it('refuses dot-names, also behind an innocent-looking symlink, except along the page’s own folders', async () => {
    expect(await resolveInsideRoot(entry(), '/.env')).toBeNull();
    expect(await resolveInsideRoot(entry(), '/.git')).toBeNull();
    fs.symlinkSync(path.join(repo, '.env'), path.join(repo, 'docs', 'config.txt'));
    expect(await resolveInsideRoot(entry(), '/docs/config.txt')).toBeNull();

    fs.mkdirSync(path.join(repo, '.github'));
    fs.writeFileSync(path.join(repo, '.github', 'report.css'), 'x');
    expect(await resolveInsideRoot({ root: repo, pageDirSegments: ['.github'] }, '/.github/report.css'))
      .toBe(path.join(repo, '.github', 'report.css'));
  });
});

describe('serving a page', () => {
  it('opens a page under its worktree and serves it and its assets with inert headers', async () => {
    const opened = await openHtmlPreview(asSender(sender()), path.join(repo, 'docs', 'api', 'foo.html'));
    expect(opened).toMatchObject({ ok: true, kind: 'html', path: 'docs/api/foo.html' });
    if (!opened.ok) return;
    const page = await get(htmlPreviewUrl(opened.token, 'docs/api/foo.html'));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('x-dns-prefetch-control')).toBe('off');
    expect(page.headers.get('content-security-policy')).toBe("default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:");
    // The online session serves the token only once its tab allowed the network.
    expect((await serveHtmlPreview(new Request(htmlPreviewUrl(opened.token, 'docs/api/foo.html')), true)).status).toBe(404);
    const css = await get(htmlPreviewUrl(opened.token, 'docs/_static/x.css'));
    expect(await css.text()).toBe('h1{color:red}');
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect((await get(htmlPreviewUrl(opened.token, '.env'))).status).toBe(404);
  });

  it('refuses a served file whose 64-bit ID differs from the opened one only below Number precision', async () => {
    const opened = await openHtmlPreview(asSender(sender()), path.join(repo, 'docs', 'api', 'foo.html'));
    if (!opened.ok) throw new Error('open failed');
    const css = path.join(repo, 'docs', '_static', 'x.css');
    expect((await get(htmlPreviewUrl(opened.token, 'docs/_static/x.css'))).status).toBe(200);
    fakeFileIds({ [css]: { byPath: () => FAR_IDS[0], byHandle: () => FAR_IDS[1] } });
    expect((await get(htmlPreviewUrl(opened.token, 'docs/_static/x.css'))).status).toBe(404);
  });

  it('follows a latest.html symlink on every request, so retargeting it shows the new page', async () => {
    const out = path.join(repo, 'docs');
    fs.writeFileSync(path.join(out, 'v1.html'), 'one');
    fs.writeFileSync(path.join(out, 'v2.html'), 'two');
    fs.symlinkSync('v1.html', path.join(out, 'latest.html'));
    const opened = await openHtmlPreview(asSender(sender()), path.join(out, 'latest.html'));
    if (!opened.ok) throw new Error('open failed');
    expect(opened.path).toBe('docs/latest.html');
    expect(await (await get(htmlPreviewUrl(opened.token, 'docs/latest.html'))).text()).toBe('one');
    fs.unlinkSync(path.join(out, 'latest.html'));
    fs.symlinkSync('v2.html', path.join(out, 'latest.html'));
    expect(await (await get(htmlPreviewUrl(opened.token, 'docs/latest.html'))).text()).toBe('two');
  });

  it('redirects a folder URL to its slash form, then serves its index.html', async () => {
    const opened = await openHtmlPreview(asSender(sender()), path.join(repo, 'docs', 'index.html'));
    if (!opened.ok) throw new Error('open failed');
    const bare = await get(`wmux-html://${opened.token}/docs`);
    expect(bare.status).toBe(301);
    expect(bare.headers.get('location')).toBe('/docs/');
    expect(await (await get(`wmux-html://${opened.token}/docs/`)).text()).toBe('<h1>docs</h1>');
  });

  it.each(['//host/share/x.html', '\\\\host\\share\\x.html', '\\\\?\\UNC\\host\\share\\x.html'])(
    'refuses the network path %s without touching it',
    async (p) => {
      const exists = vi.spyOn(fs, 'existsSync');
      const realpath = vi.spyOn(fs.promises, 'realpath');
      expect(await openHtmlPreview(asSender(sender()), p)).toEqual({ ok: false, reason: 'denied' });
      expect(exists).not.toHaveBeenCalled();
      expect(realpath).not.toHaveBeenCalled();
    },
  );

  it('refuses a page in a credential store or directly in home', async () => {
    fs.writeFileSync(path.join(home, '.ssh', 'x.html'), 'x');
    expect(await openHtmlPreview(asSender(sender()), path.join(home, '.ssh', 'x.html'))).toEqual({ ok: false, reason: 'denied' });
    fs.writeFileSync(path.join(home, 'page.html'), 'x');
    expect(await openHtmlPreview(asSender(sender()), path.join(home, 'page.html'))).toEqual({ ok: false, reason: 'denied' });
  });

  it('lets only the owning tab switch the network on, and forgets closed tokens', async () => {
    const owner = sender();
    const opened = await openHtmlPreview(asSender(owner), path.join(repo, 'docs', 'index.html'));
    if (!opened.ok) throw new Error('open failed');
    expect(setHtmlPreviewNetwork(asSender(sender()), opened.token, true)).toBe(false);
    expect(setHtmlPreviewNetwork(asSender(owner), opened.token, true)).toBe(true);
    const before = htmlPreviewStatsForTests().tokens;
    closeHtmlPreview(asSender(sender()), opened.token); // not the owner: no effect
    expect(htmlPreviewStatsForTests().tokens).toBe(before);
    closeHtmlPreview(asSender(owner), opened.token);
    expect(htmlPreviewStatsForTests().tokens).toBe(before - 1);
    expect((await get(htmlPreviewUrl(opened.token, 'docs/index.html'))).status).toBe(404);
  });
});

describe('where a previewed page may go', () => {
  const page = `wmux-html://${'a'.repeat(32)}/docs/index.html`;
  it('stays inside its own token; web links are handed to the person; everything else is refused', () => {
    expect(htmlNavigationVerdict(page, `wmux-html://${'a'.repeat(32)}/docs/b.html`, true)).toBe('allow');
    expect(htmlNavigationVerdict(page, `wmux-html://${'b'.repeat(32)}/x.html`, true)).toBe('deny');
    expect(htmlNavigationVerdict(page, 'https://example.com/', true)).toBe('hand-off');
    expect(htmlNavigationVerdict(page, 'file:///etc/hosts', true)).toBe('deny');
    expect(htmlNavigationVerdict(page, 'javascript:alert(1)', true)).toBe('deny');
    expect(htmlNavigationVerdict(page, 'about:blank', true)).toBe('deny');
    expect(htmlNavigationVerdict(page, 'about:srcdoc', false)).toBe('allow');
    expect(htmlNavigationVerdict(page, 'data:text/html,hi', false)).toBe('allow');
    expect(htmlNavigationVerdict(page, 'wmux-preview://x/y', false)).toBe('deny');
  });
});
