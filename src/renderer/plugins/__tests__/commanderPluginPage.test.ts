// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const bundle = path.resolve('examples/plugins/commander');
interface Request { id: string; method: string; params: Record<string, unknown> }
let requests: Request[] = [];
let entries: { name: string; kind: string; size: number; mtimeMs: number; mode: number }[];
let port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage(r: Request): void; start(): void; close(): void };
const entry = (name: string, kind = 'file') => ({ name, kind, size: 2048, mtimeMs: 1600000000000, mode: 0o755 });
let running = false;
let cancelled = false;
const page = () => document.querySelector<HTMLElement>('#page') as HTMLElement;
function key(value: string, extra = {}) { (document.querySelector('.overlay') ? document.activeElement : page())?.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra })); }
function click(label: string) {
  const b = [...document.querySelectorAll<HTMLButtonElement>('button')].find((e) => e.textContent === label);
  if (!b) throw new Error(`Missing button ${label}`); b.click();
}
async function idle() { await vi.waitFor(() => expect(document.querySelector('#notice')?.textContent).toContain('Tab switches'), { timeout: 5_000 }); }
async function requested(method: string) { await vi.waitFor(() => expect(requests.some((r) => r.method === method)).toBe(true), { timeout: 5_000 }); return requests.find((r) => r.method === method) as Request; }
beforeAll(() => {
  const html = fs.readFileSync(path.join(bundle, 'index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script'));
  vi.stubGlobal('ResizeObserver', class { observe() { /* Layout is fixed in jsdom. */ } });
  new Function(fs.readFileSync(path.join(bundle, 'commander.js'), 'utf8')).call(window);
});
beforeEach(async () => {
  requests = []; entries = [entry('zeta.bin'), entry('folder', 'dir'), entry('alpha.txt')]; running = false; cancelled = false;
  document.querySelector('.overlay button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  port = {
    onmessage: null,
    postMessage(r) {
      requests.push(r);
      let result: unknown = { ok: true };
      if (r.method === 'pane.list') result = { panes: [{ cwd: '/first' }, { cwd: '/work', active: true }] };
      if (r.method === 'fs.list') result = { ok: true, path: r.params.path, parent: '/', entries, truncated: false };
      if (r.method === 'fs.readText') result = { ok: true, text: '<script>literal text</script>', truncated: true };
      if (['fs.copy', 'fs.move', 'fs.trash'].includes(r.method)) result = { ok: true, jobId: 'job' };
      if (r.method === 'fs.job.cancel') cancelled = true;
      if (r.method === 'fs.job.status') result = { ok: true, job: { state: running && !cancelled ? 'running' : cancelled ? 'cancelled' : 'done', totalBytes: 10, doneBytes: 10, totalItems: 1, doneItems: 1, current: 'alpha.txt', errors: [] } };
      queueMicrotask(() => port.onmessage?.({ data: { v: 1, kind: 'response', id: r.id, result } }));
    },
    start() { /* Fake bridge has no queued messages. */ }, close() { /* No handles. */ },
  };
  const event = new MessageEvent('message', { data: { v: 1, kind: 'init' } });
  Object.defineProperty(event, 'source', { value: window.parent }); Object.defineProperty(event, 'ports', { value: [port] });
  window.dispatchEvent(event); await idle();
  key('2', { ctrlKey: true, code: 'Digit2' });
});
describe('Commander page over the plugin bridge', () => {
  it('starts both panels at the active cwd, sorts folders first and displays owner modes', () => {
    expect(document.querySelectorAll('.panel')).toHaveLength(2);
    expect([...document.querySelectorAll('.path')].map((p) => p.textContent)).toEqual(['/work', '/work']);
    expect([...document.querySelectorAll('.panel:first-child .name')].map((p) => p.textContent)).toEqual(['..', 'folder', 'alpha.txt', 'zeta.bin']);
    expect(document.querySelectorAll('.permissions')[1].textContent).toBe('drwx');
    expect(page().classList.contains('colours')).toBe(false);
  });
  it('switches layouts and active panels and jumps to quick slots', async () => {
    key('3', { ctrlKey: true, code: 'Digit3' }); expect(document.querySelectorAll('.panel')).toHaveLength(3);
    key('Tab'); expect(document.querySelectorAll('.panel')[1].classList.contains('active')).toBe(true);
    key('Tab', { shiftKey: true }); expect(document.querySelectorAll('.panel')[0].classList.contains('active')).toBe(true);
    key('¡', { altKey: true, code: 'Digit1' }); // macOS Option+1
    await vi.waitFor(() => expect(document.querySelector('.path')?.textContent).toBe('/first'), { timeout: 5_000 });
  });
  it('goes to a typed folder with F10, relative to the panel', async () => {
    key('F10'); const input = document.querySelector<HTMLInputElement>('.dialog input') as HTMLInputElement;
    expect(input.value).toBe('/work');
    input.value = 'folder'; click('OK');
    await vi.waitFor(() => expect(document.querySelector('.path')?.textContent).toBe('/work/folder'), { timeout: 5_000 });
    key('F10'); (document.querySelector('.dialog input') as HTMLInputElement).value = '/elsewhere'; click('OK');
    await vi.waitFor(() => expect(document.querySelector('.path')?.textContent).toBe('/elsewhere'), { timeout: 5_000 });
    key('F10'); (document.querySelector('.dialog input') as HTMLInputElement).value = '~/notes'; click('OK');
    await vi.waitFor(() => expect(document.querySelector('.path')?.textContent).toBe('~/notes'), { timeout: 5_000 });
  });
  it('hands an unused chord back to the host', () => {
    const sent: unknown[] = []; const original = port.postMessage;
    port.postMessage = (m) => { sent.push(m); };
    key('f', { ctrlKey: true, altKey: true, code: 'KeyF' }); key('Control', { ctrlKey: true });
    port.postMessage = original;
    expect(sent).toEqual([{ v: 1, kind: 'key', key: 'f', code: 'KeyF', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false, repeat: false }]);
  });
  it('marks entries and sends only those sources after copy confirmation', async () => {
    key('Home'); key('ArrowDown'); key(' '); key('F5');
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('1 items to');
    click('Continue'); const r = await requested('fs.copy');
    expect(r.params).toEqual({ sources: ['/work/folder'], destDir: '/work', conflict: 'skip' });
    await requested('fs.job.status'); await vi.waitFor(() => expect(document.querySelector('.dialog')?.textContent).toContain('done'), { timeout: 5_000 });
    key('Escape'); expect(document.querySelector('.overlay')).toBeNull();
  });
  it('views text safely and gives a truncation notice', async () => {
    key('End'); key('F3'); await requested('fs.readText');
    await vi.waitFor(() => expect(document.querySelector('pre')?.textContent).toContain('<script>literal text</script>'), { timeout: 5_000 });
    expect(document.querySelector('.dialog')?.textContent).toContain('first 1 MB'); expect(document.querySelector('.dialog script')).toBeNull(); key('Escape');
  });
  it('renames with an in-page prompt and confirms named Trash items', async () => {
    key('End'); key('F2'); const input = document.querySelector('input') as HTMLInputElement; input.value = 'renamed'; key('Enter');
    expect((await requested('fs.rename')).params).toEqual({ path: '/work/zeta.bin', newName: 'renamed' });
    await vi.waitFor(() => expect(requests.filter((r) => r.method === 'fs.list').length).toBeGreaterThan(3), { timeout: 5_000 });
    key('F8'); expect(document.querySelector('.dialog')?.textContent).toContain('zeta.bin'); click('Move to Trash'); await requested('fs.trash');
    await vi.waitFor(() => expect(document.querySelector('.dialog')?.textContent).toContain('done'), { timeout: 5_000 }); key('Escape');
  });
  it('cancels running jobs through Escape and leaves the progress visible until stopped', async () => {
    running = true; key('End'); key('F6'); click('Continue'); await requested('fs.job.status'); key('Escape'); await requested('fs.job.cancel');
    await vi.waitFor(() => expect(document.querySelector('.dialog')?.textContent).toContain('cancelled'), { timeout: 5_000 }); key('Escape');
  });
  it('applies host theme tokens and windows large folders', async () => {
    port.onmessage?.({ data: { v: 1, kind: 'theme', colorScheme: 'light', variables: { '--bg-base': '#ffffff', '--text-main': '#111111' } } });
    expect(document.documentElement.style.getPropertyValue('--bg-base')).toBe('#ffffff');
    expect(document.documentElement.style.colorScheme).toBe('light');
    entries = Array.from({ length: 3000 }, (_, n) => entry(`file-${n}`)); key('r', { ctrlKey: true });
    await vi.waitFor(() => expect(document.querySelector('.summary')?.textContent).toContain('3000 items'), { timeout: 5_000 });
    expect(document.querySelectorAll('.row').length).toBeLessThan(200);
    key('End'); expect(document.querySelector('.cursor .name')?.textContent).toBe('file-999');
  });
});
