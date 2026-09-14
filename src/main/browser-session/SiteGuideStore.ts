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
// Containment is re-checked on EVERY match call, not only when a file is first
// parsed: a guide that is swapped for a symlink pointing out of the directory
// after it was cached must stop matching immediately. Only the parsed
// frontmatter is cached, keyed by (path, mtimeMs, size) of the resolved file.
// ---------------------------------------------------------------------------

export function getSiteGuidesDir(dir: string = getWmuxDir()): string {
  return path.join(dir, SITE_GUIDES_DIR_NAME);
}

/** Directory listing TTL. Short: a note written mid-session should surface soon. */
export const SITE_GUIDE_LISTING_TTL_MS = 2_000;

/**
 * How a guide path is spelled in the hint: home-relative when it can be, the
 * same way file.ts displays the uploads root, so the login name and home
 * layout are not parked in every landing.
 */
export function displayGuidePath(file: string, home: string = os.homedir()): string {
  let realHome = home;
  try {
    realHome = fs.realpathSync(home);
  } catch {
    // Unresolvable home — compare against what we were given.
  }
  const rel = path.relative(realHome, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file;
  return `~/${rel.split(path.sep).join('/')}`;
}

interface ParsedEntry {
  mtimeMs: number;
  size: number;
  frontmatter: SiteGuideFrontmatter | null;
}

export class SiteGuideStore {
  private readonly baseDir: string;
  private readonly home: string | undefined;
  private listing: { at: number; names: string[] } | null = null;
  private readonly parsed = new Map<string, ParsedEntry>();

  constructor(dir?: string, opts: { home?: string } = {}) {
    this.baseDir = getSiteGuidesDir(dir);
    this.home = opts.home;
  }

  /** Force the next match to re-list the directory (setting just turned on). */
  invalidateListing(): void {
    this.listing = null;
  }

  /** Guides matching a page URL, best first, at most the hint budget. Never throws. */
  match(url: string, now: number = Date.now()): SiteGuideMatch[] {
    try {
      let realDir: string;
      try {
        realDir = fs.realpathSync(this.baseDir);
      } catch {
        return [];
      }
      const matches: SiteGuideMatch[] = [];
      for (const name of this.names(realDir, now)) {
        const match = this.matchOne(realDir, name, url);
        if (match) matches.push(match);
      }
      return rankGuideMatches(matches).slice(0, SITE_GUIDE_MAX_HINTS);
    } catch {
      return [];
    }
  }

  private names(realDir: string, now: number): string[] {
    if (this.listing && now - this.listing.at < SITE_GUIDE_LISTING_TTL_MS) {
      return this.listing.names;
    }
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(realDir)
        .filter(isSafeGuideFilename)
        .sort()
        .slice(0, SITE_GUIDE_MAX_FILES);
    } catch {
      names = [];
    }
    this.listing = { at: now, names };
    // Drop parse entries for files no longer listed so the cache stays bounded.
    const live = new Set(names.map((n) => path.join(realDir, n)));
    for (const key of this.parsed.keys()) if (!live.has(key)) this.parsed.delete(key);
    return names;
  }

  private matchOne(realDir: string, name: string, url: string): SiteGuideMatch | null {
    try {
      const file = path.join(realDir, name);
      const real = fs.realpathSync(file);
      if (!real.startsWith(realDir + path.sep)) return null;
      const stat = fs.statSync(real);
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
      const display = displayGuidePath(file, this.home);
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
