/**
 * LocalUpdateFeed — the loopback Squirrel.Mac feed that serves an
 * already-verified update ZIP during a macOS install.
 *
 * What must hold: the feed JSON points Squirrel at the token-scoped ZIP route,
 * the ZIP is served byte-for-byte (a truncated body would make Squirrel install
 * a corrupt bundle), unknown/mistyped token paths 404, and stop() actually
 * closes the socket so the server never outlives the install.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { get } from 'node:http';
import { LocalUpdateFeed } from '../LocalUpdateFeed';

const dirs: string[] = [];
const feeds: LocalUpdateFeed[] = [];

afterEach(async () => {
  for (const feed of feeds.splice(0)) await feed.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Write a throwaway "ZIP" and return its path plus its exact bytes. */
function makeZip(): { path: string; bytes: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'wmux-local-feed-test-'));
  dirs.push(dir);
  const bytes = randomBytes(4096); // binary, so any text-mangling shows up
  const path = join(dir, 'wmux-darwin-arm64-9.9.9.zip');
  writeFileSync(path, bytes);
  return { path, bytes };
}

function fetchUrl(url: string): Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks),
        headers: res.headers as Record<string, unknown>,
      }));
    }).on('error', reject);
  });
}

async function startFeed() {
  const { path, bytes } = makeZip();
  const feed = new LocalUpdateFeed();
  feeds.push(feed);
  const { feedUrl } = await feed.start(path);
  return { feed, feedUrl, bytes };
}

describe('LocalUpdateFeed', () => {
  it('serves a Squirrel JSON feed on loopback pointing at the token-scoped zip', async () => {
    const { feedUrl } = await startFeed();

    expect(feedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}\/feed\.json$/);

    const res = await fetchUrl(feedUrl);
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body.toString()) as { url: string };
    expect(json.url).toBe(feedUrl.replace('/feed.json', '/update.zip'));
  });

  it('serves the zip byte-for-byte with a Content-Length', async () => {
    const { feedUrl, bytes } = await startFeed();

    const res = await fetchUrl(feedUrl.replace('/feed.json', '/update.zip'));
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(res.body.equals(bytes)).toBe(true);
  });

  it('404s any path outside the random token (no unauthenticated zip reads)', async () => {
    const { feedUrl } = await startFeed();
    const origin = new URL(feedUrl).origin;
    const wrongToken = 'f'.repeat(32);

    for (const path of ['/', '/feed.json', '/update.zip', `/${wrongToken}/update.zip`, `/${wrongToken}/feed.json`]) {
      const res = await fetchUrl(`${origin}${path}`);
      expect(res.status).toBe(404);
    }
  });

  it('is unreachable after stop() (the server never outlives the install)', async () => {
    const { feed, feedUrl } = await startFeed();

    await feed.stop();

    await expect(fetchUrl(feedUrl)).rejects.toThrow();
    await expect(feed.stop()).resolves.toBeUndefined(); // idempotent
  });

  it('refuses a double start (one feed serves exactly one install)', async () => {
    const { feed } = await startFeed();
    const { path } = makeZip();
    await expect(feed.start(path)).rejects.toThrow(/already started/);
  });
});
