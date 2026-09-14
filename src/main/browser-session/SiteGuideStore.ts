import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getWmuxDir } from '../../daemon/config';
import {
  SITE_GUIDES_DIR_NAME,
  SITE_GUIDE_HEAD_BYTES,
  SITE_GUIDE_MAX_FILES,
  SITE_GUIDE_MAX_FILE_BYTES,
  SITE_GUIDE_MAX_HINTS,
  isSafeGuideDisplayPath,
  isSafeGuideFilename,
  parseGuideFrontmatter,
  rankGuideMatches,
  scoreGuideForUrl,
  type SiteGuideFrontmatter,
  type SiteGuideMatch,
} from '../../shared/browserGuides/siteGuides';

// ---------------------------------------------------------------------------
// Read side of site guide pointers: `<wmuxDir>/site-guides/*.md`.
//
// Read-only and never-throw. wmux never writes here; the user or an agent does,
// with its own file tools. getWmuxDir() folds in WMUX_DATA_SUFFIX, so an
// isolated instance reads its own directory.
//
// This runs synchronously on the main process on every landing, so file system
// work is bounded by one TTL: the directory listing and each file's (realpath,
// stat) are reused for SITE_GUIDE_LISTING_TTL_MS, keyed by path, and dropped
// when the setting is switched on. Containment is still judged on EVERY match
// call, against a resolution at most one TTL old: a guide swapped for a
// symlink pointing out of the directory stops matching within that window.
// The parsed frontmatter is cached by (path, mtimeMs, size) of the resolved file.
// ---------------------------------------------------------------------------

export function getSiteGuidesDir(dir: string = getWmuxDir()): string {
  return path.join(dir, SITE_GUIDES_DIR_NAME);
}

/** Listing and per-file resolution TTL. Short: a note written mid-session should surface soon. */
export const SITE_GUIDE_LISTING_TTL_MS = 2_000;

function homeRelative(file: string, realHome: string): string {
  const rel = path.relative(realHome, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file;
  return `~/${rel.split(path.sep).join('/')}`;
}

function resolveHome(home: string): string {
  try {
    return fs.realpathSync(home);
  } catch {
    // Unresolvable home — compare against what we were given.
    return home;
  }
}

/**
 * How a guide path is spelled in the hint: home-relative when it can be, the
 * same way file.ts displays the uploads root, so the login name and home
 * layout are not parked in every landing.
 */
export function displayGuidePath(file: string, home: string = os.homedir()): string {
  return homeRelative(file, resolveHome(home));
}

interface ParsedEntry {
  mtimeMs: number;
  size: number;
  frontmatter: SiteGuideFrontmatter | null;
}

interface ResolvedEntry {
  at: number;
  real: string | null;
  stat: fs.Stats | null;
}

interface Listing {
  at: number;
  realDir: string | null;
  names: string[];
}

export class SiteGuideStore {
  private readonly baseDir: string;
  private readonly home: string | undefined;
  private realHome: string | null = null;
  private listing: Listing | null = null;
  private readonly resolved = new Map<string, ResolvedEntry>();
  private readonly parsed = new Map<string, ParsedEntry>();

  constructor(dir?: string, opts: { home?: string } = {}) {
    this.baseDir = getSiteGuidesDir(dir);
    this.home = opts.home;
  }

  /** Force the next match to re-read the directory and every file (setting just turned on). */
  invalidateListing(): void {
    this.listing = null;
    this.resolved.clear();
  }

  /** Guides matching a page URL, best first, at most the hint budget. Never throws. */
  match(url: string, now: number = Date.now()): SiteGuideMatch[] {
    try {
      const listing = this.list(now);
      if (!listing.realDir) return [];
      const matches: SiteGuideMatch[] = [];
      for (const name of listing.names) {
        const match = this.matchOne(listing.realDir, name, url, now);
        if (match) matches.push(match);
      }
      return rankGuideMatches(matches).slice(0, SITE_GUIDE_MAX_HINTS);
    } catch {
      return [];
    }
  }

  private list(now: number): Listing {
    if (this.listing && now - this.listing.at < SITE_GUIDE_LISTING_TTL_MS) return this.listing;
    let realDir: string | null = null;
    let names: string[] = [];
    try {
      realDir = fs.realpathSync(this.baseDir);
      names = fs
        .readdirSync(realDir)
        .filter(isSafeGuideFilename)
        .sort()
        .slice(0, SITE_GUIDE_MAX_FILES);
    } catch {
      realDir = null;
      names = [];
    }
    this.listing = { at: now, realDir, names };
    // Drop entries for files no longer listed so both caches stay bounded.
    const live = new Set(realDir ? names.map((n) => path.join(realDir as string, n)) : []);
    for (const key of this.parsed.keys()) if (!live.has(key)) this.parsed.delete(key);
    for (const key of this.resolved.keys()) if (!live.has(key)) this.resolved.delete(key);
    return this.listing;
  }

  private resolve(file: string, now: number): ResolvedEntry {
    const cached = this.resolved.get(file);
    if (cached && now - cached.at < SITE_GUIDE_LISTING_TTL_MS) return cached;
    let entry: ResolvedEntry;
    try {
      const real = fs.realpathSync(file);
      entry = { at: now, real, stat: fs.statSync(real) };
    } catch {
      entry = { at: now, real: null, stat: null };
    }
    this.resolved.set(file, entry);
    return entry;
  }

  private matchOne(realDir: string, name: string, url: string, now: number): SiteGuideMatch | null {
    try {
      const file = path.join(realDir, name);
      const { real, stat } = this.resolve(file, now);
      // Judged on every call, whether the resolution is fresh or reused.
      if (!real || !stat || !real.startsWith(realDir + path.sep)) return null;
      if (!stat.isFile() || stat.size > SITE_GUIDE_MAX_FILE_BYTES) return null;

      let entry = this.parsed.get(file);
      if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
        entry = { mtimeMs: stat.mtimeMs, size: stat.size, frontmatter: this.readFrontmatter(real) };
        this.parsed.set(file, entry);
      }
      const fm = entry.frontmatter;
      if (!fm) return null;
      const score = scoreGuideForUrl(fm.urls, url);
      if (score === null) return null;
      if (this.realHome === null) this.realHome = resolveHome(this.home ?? os.homedir());
      const display = homeRelative(file, this.realHome);
      if (!isSafeGuideDisplayPath(display)) return null;
      return { title: fm.title, path: display, urls: fm.urls, updated: fm.updated, score };
    } catch {
      return null;
    }
  }

  private readFrontmatter(file: string): SiteGuideFrontmatter | null {
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(SITE_GUIDE_HEAD_BYTES);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      return parseGuideFrontmatter(buf.subarray(0, read).toString('utf8'));
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* nothing to recover */
        }
      }
    }
  }
}

let sharedStore: SiteGuideStore | null = null;

export function getSiteGuideStore(): SiteGuideStore {
  if (!sharedStore) sharedStore = new SiteGuideStore();
  return sharedStore;
}
