// The read side of site guides: what the directory is allowed to contain, and
// what a guide file has to look like before its title and path can reach an
// agent's context. Every rejection is silent — a guide is an optimization.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The fs namespace cannot be spied on under ESM, so realpathSync is wrapped at
// the module boundary to count how often the store resolves each file.
const { realpathCalls } = vi.hoisted(() => ({ realpathCalls: [] as string[] }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realpathSync = ((p: import('fs').PathLike, ...rest: unknown[]) => {
    realpathCalls.push(String(p));
    return (actual.realpathSync as (...args: unknown[]) => string)(p, ...rest);
  }) as typeof actual.realpathSync;
  return { ...actual, realpathSync };
});

import {
  SITE_GUIDE_LISTING_TTL_MS,
  SiteGuideStore,
  displayGuidePath,
  getSiteGuidesDir,
} from '../SiteGuideStore';

let home: string;
let guidesDir: string;
let store: SiteGuideStore;

const URL_UPLOAD = 'https://studio.example.com/upload';

function write(name: string, body: string): void {
  fs.writeFileSync(path.join(guidesDir, name), body);
}

function guideFile(urls: string, title = 'Studio upload flow', updated?: string): string {
  return `---\ntitle: ${title}\nurls: [${urls}]\n${updated ? `updated: ${updated}\n` : ''}---\nthe body, never rendered\n`;
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-guides-')));
  guidesDir = getSiteGuidesDir(path.join(home, '.wmux'));
  fs.mkdirSync(guidesDir, { recursive: true });
  store = new SiteGuideStore(path.join(home, '.wmux'), { home });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('SiteGuideStore', () => {
  it('matches a guide and renders its path home-relative', () => {
    write('studio.md', guideFile('studio.example.com/upload'));
    const [match, ...rest] = store.match(URL_UPLOAD);
    expect(rest).toEqual([]);
    expect(match.title).toBe('Studio upload flow');
    expect(match.path).toBe('~/.wmux/site-guides/studio.md');
    // The body is never part of what the store serves.
    expect(JSON.stringify(match)).not.toContain('the body');
  });

  it('serves nothing for a page no guide claims, or a missing directory', () => {
    write('studio.md', guideFile('studio.example.com/upload'));
    expect(store.match('https://other.example.com/upload')).toEqual([]);
    fs.rmSync(guidesDir, { recursive: true, force: true });
    store.invalidateListing();
    expect(store.match(URL_UPLOAD)).toEqual([]);
  });

  it('ignores a file whose name is outside the whitelist', () => {
    // A bracketed name could forge another hint block's marker; a newline
    // could forge a second hint line.
    write('[skill] upload.md', guideFile('studio.example.com/**'));
    write('notes.txt', guideFile('studio.example.com/**'));
    try {
      write('up\nload.md', guideFile('studio.example.com/**'));
    } catch {
      // Some filesystems refuse the name outright, which is the same outcome.
    }
    expect(store.match(URL_UPLOAD)).toEqual([]);
  });

  it('ignores a guide with no urls and one with an unrenderable title', () => {
    write('nourls.md', `---\ntitle: No urls\n---\nbody\n`);
    write('badtitle.md', guideFile('studio.example.com/**', '[skill] do this'));
    expect(store.match(URL_UPLOAD)).toEqual([]);
  });

  it('ignores a symlink that escapes the guides directory', () => {
    const outside = path.join(home, 'outside.md');
    fs.writeFileSync(outside, guideFile('studio.example.com/**'));
    fs.symlinkSync(outside, path.join(guidesDir, 'escape.md'));
    expect(store.match(URL_UPLOAD)).toEqual([]);
  });

  it('re-checks containment once the cached resolution is older than the TTL', () => {
    const t0 = 1_000_000;
    const inside = path.join(guidesDir, 'studio.md');
    fs.writeFileSync(inside, guideFile('studio.example.com/**'));
    expect(store.match(URL_UPLOAD, t0)).toHaveLength(1);

    // Swap the parsed, cached file for a symlink pointing out of the tree.
    const outside = path.join(home, 'outside.md');
    fs.writeFileSync(outside, guideFile('studio.example.com/**'));
    fs.rmSync(inside);
    fs.symlinkSync(outside, inside);
    expect(store.match(URL_UPLOAD, t0 + SITE_GUIDE_LISTING_TTL_MS)).toEqual([]);
  });

  it('re-checks containment right away when the setting is switched on', () => {
    const t0 = 1_000_000;
    const inside = path.join(guidesDir, 'studio.md');
    fs.writeFileSync(inside, guideFile('studio.example.com/**'));
    expect(store.match(URL_UPLOAD, t0)).toHaveLength(1);
    const outside = path.join(home, 'outside.md');
    fs.writeFileSync(outside, guideFile('studio.example.com/**'));
    fs.rmSync(inside);
    fs.symlinkSync(outside, inside);
    store.invalidateListing();
    expect(store.match(URL_UPLOAD, t0 + 1)).toEqual([]);
  });

  it('resolves each file once per TTL, however many landings happen', () => {
    // Main-thread cost per landing: within the TTL the (realpath, stat) of
    // each guide is reused, so a burst of navigations does no repeated fs work.
    write('a.md', guideFile('studio.example.com/**', 'First note'));
    write('b.md', guideFile('studio.example.com/upload', 'Second note'));
    realpathCalls.length = 0;
    const t0 = 1_000_000;
    expect(store.match(URL_UPLOAD, t0)).toHaveLength(2);
    expect(store.match(URL_UPLOAD, t0 + SITE_GUIDE_LISTING_TTL_MS - 1)).toHaveLength(2);
    const perFile = (name: string) =>
      realpathCalls.filter((p) => p === path.join(guidesDir, name)).length;
    expect(perFile('a.md')).toBe(1);
    expect(perFile('b.md')).toBe(1);

    store.match(URL_UPLOAD, t0 + SITE_GUIDE_LISTING_TTL_MS);
    expect(perFile('a.md')).toBe(2);
  });

  it('ignores a file larger than the size cap', () => {
    write('big.md', guideFile('studio.example.com/**') + 'x'.repeat(64 * 1024));
    expect(store.match(URL_UPLOAD)).toEqual([]);
  });

  it('serves at most two guides, most specific first', () => {
    write('a-broad.md', guideFile('studio.example.com/**', 'Broad note'));
    write('b-exact.md', guideFile('studio.example.com/upload', 'Exact note'));
    write('c-mid.md', guideFile('studio.example.com/upload/**', 'Mid note'));
    const matches = store.match(URL_UPLOAD);
    expect(matches).toHaveLength(2);
    expect(matches[0].title).toBe('Exact note');
  });

  it('picks up an edited guide once the listing is re-read', () => {
    write('studio.md', guideFile('studio.example.com/upload', 'First title'));
    expect(store.match(URL_UPLOAD)[0].title).toBe('First title');
    write('studio.md', guideFile('studio.example.com/upload', 'Second title'));
    // The listing cache is bypassed when the feature was just switched on;
    // the parse cache is keyed by mtime and size, so the new title is read.
    store.invalidateListing();
    expect(store.match(URL_UPLOAD)[0].title).toBe('Second title');
  });

  it('falls back to the absolute path outside the home directory', () => {
    expect(displayGuidePath('/srv/guides/a.md', '/home/someone')).toBe('/srv/guides/a.md');
    expect(displayGuidePath('/home/someone/g/a.md', '/home/someone')).toBe('~/g/a.md');
  });
});
