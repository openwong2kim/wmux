// The service worker is evaluated from its shipped bytes against fake caches
// and fetch, to pin which responses may become an offline shell entry.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const src = readFileSync(join(__dirname, '..', 'frontend', 'sw.js'), 'utf8');

function load(respond: (url: string) => Response) {
  const stored = new Map<string, Response>();
  const listeners: Record<string, (e: unknown) => void> = {};
  const cache = {
    put: async (key: string | { url: string }, res: Response) => { stored.set(typeof key === 'string' ? key : new URL(key.url).pathname, res); },
    addAll: async () => undefined,
  };
  const sandbox = {
    self: { addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; }, skipWaiting: () => undefined },
    caches: { open: async () => cache, match: async () => undefined, keys: async () => [] },
    fetch: async (req: { url: string }) => respond(req.url),
    URL, Response, Promise,
  };
  runInNewContext(src, sandbox);
  const dispatch = async (url: string, mode: string) => {
    let out: Promise<Response> | undefined;
    listeners.fetch({ request: { url, method: 'GET', mode }, respondWith: (p: Promise<Response>) => { out = p; } });
    await out;
    await new Promise((r) => setTimeout(r, 0));
  };
  return { stored, dispatch };
}

const html = () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const font = () => new Response('FONT', { status: 200, headers: { 'content-type': 'font/woff2' } });

describe('sw.js shell cache', () => {
  it('stores / and /app under their own keys', async () => {
    const { stored, dispatch } = load(() => html());
    await dispatch('http://h/', 'navigate');
    await dispatch('http://h/app', 'navigate');
    expect([...stored.keys()].sort()).toEqual(['/', '/app']);
  });

  it('a navigation to a font URL never overwrites the offline copy of /', async () => {
    const { stored, dispatch } = load(() => font());
    await dispatch('http://h/app/assets/Inter-x.woff2', 'navigate');
    expect(stored.has('/')).toBe(false);
    expect(stored.has('/app/assets/Inter-x.woff2')).toBe(true);
  });

  it('a navigation to some other path, or a failed shell load, is not stored as a shell', async () => {
    const { stored, dispatch } = load((url) => (url.endsWith('/nope') ? html() : new Response('down', { status: 503, headers: { 'content-type': 'text/html' } })));
    await dispatch('http://h/nope', 'navigate');
    await dispatch('http://h/', 'navigate');
    expect(stored.size).toBe(0);
  });
});
