// ─── Multi-Account — new-account config dir provisioning (hybrid share) ──────
//
// When a user adds an account, its config dir defaults to a fresh, empty
// profile — CLAUDE_CONFIG_DIR partitions the ENTIRE config (credentials AND
// settings/hooks/plugins/skills/MCP), so a naive new dir has no skills/MCP and
// the user would "have to reinstall everything". To avoid that we set up a
// HYBRID SHARE: the login stays per-account (real files), while read-mostly
// assets are shared from the default dir.
//
// Share strategy (which asset shares which way) follows the community-standard
// approach documented by claude-profile-manager (MIT,
// https://github.com/JakubKontra/claude-profile-manager) and the KMJ-007 gist:
//   - Directories the CLI reads but does not atomic-rewrite (commands, skills,
//     agents, plugins) → symlink/junction to the source so a newly-installed
//     skill appears in every account instantly (live share, no divergence).
//   - Files the CLI rewrites in place (settings.json, CLAUDE.md) → COPY, not
//     symlink: an atomic rename-replace would break a symlink or clobber the
//     shared original (3-way review, Codex: config-dir-semantics / symlink risk).
//   - Credentials + history stay per-account (never touched here).
// On Windows the directory links use `junction` type, which needs no elevation
// or developer mode (unlike file symlinks) — the Windows-first constraint.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Vendor } from './accountStore';

// Per-vendor share manifests. Codex stores user settings + MCP in config.toml
// (NOT settings.json/CLAUDE.md) and its login lives in auth.json, which must
// NEVER be shared (Codex review P2). Directories that the CLI reads but doesn't
// atomic-rewrite are LINKED (live share); rewritten files are COPIED (snapshot).
const SHARE_MANIFEST: Record<Vendor, { linkDirs: readonly string[]; copyFiles: readonly string[] }> = {
  claude: {
    linkDirs: ['commands', 'skills', 'agents', 'plugins'],
    copyFiles: ['settings.json', 'CLAUDE.md'],
  },
  codex: {
    // Codex keeps prompts/ shareable; config.toml holds settings + MCP servers.
    linkDirs: ['prompts'],
    copyFiles: ['config.toml', 'AGENTS.md'],
  },
};
/** Back-compat export for tests / callers that referenced the claude manifest. */
const SHARED_LINK_DIRS = SHARE_MANIFEST.claude.linkDirs;
const SHARED_COPY_FILES = SHARE_MANIFEST.claude.copyFiles;

/** The vendor's account folders hold their own copy of `settings.json` (Claude
 *  Code's settings, where its hooks are registered). */
export function copiesSettingsJson(vendor: Vendor): boolean {
  return SHARE_MANIFEST[vendor].copyFiles.includes('settings.json');
}

/** Default source config dir per vendor (where the user's existing setup lives). */
export function defaultSourceDir(vendor: Vendor): string {
  return vendor === 'codex'
    ? path.join(os.homedir(), '.codex')
    : path.join(os.homedir(), '.claude');
}

/** Returns true only when the link now exists — a swallowed failure must not be
 *  reported as a successful share (Codex review P3). */
function linkDir(target: string, linkPath: string): boolean {
  // Directory junction on Windows (no elevation), symlink elsewhere.
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (err) {
    // best-effort — a failed share must not block account creation.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      console.warn(`[account] hybrid-share: could not link ${linkPath} → ${target}: ${String(err)}`);
    }
    return false;
  }
}

export interface ProvisionResult {
  configDir: string;
  linked: string[];
  copied: string[];
}

/**
 * Create `configDir` and, when `share` is true, set up the hybrid share from
 * `sourceDir` (default: the vendor's `~/.<vendor>`). Idempotent-ish: existing
 * links/files are left as-is. Returns what was shared for the UI to report.
 */
export function provisionAccountDir(opts: {
  configDir: string;
  vendor: Vendor;
  share: boolean;
  sourceDir?: string;
}): ProvisionResult {
  const { configDir, vendor, share } = opts;
  const sourceDir = opts.sourceDir ?? defaultSourceDir(vendor);
  fs.mkdirSync(configDir, { recursive: true });

  const linked: string[] = [];
  const copied: string[] = [];
  if (!share) return { configDir, linked, copied };

  const manifest = SHARE_MANIFEST[vendor];
  for (const name of manifest.linkDirs) {
    const src = path.join(sourceDir, name);
    const dst = path.join(configDir, name);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      // Record only on VERIFIED creation — a swallowed link failure is not a share.
      if (linkDir(src, dst)) linked.push(name);
    }
  }
  for (const name of manifest.copyFiles) {
    const src = path.join(sourceDir, name);
    const dst = path.join(configDir, name);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.copyFileSync(src, dst);
        copied.push(name);
      } catch (err) {
        console.warn(`[account] hybrid-share: could not copy ${name}: ${String(err)}`);
      }
    }
  }
  return { configDir, linked, copied };
}

export const HYBRID_SHARE = { SHARED_LINK_DIRS, SHARED_COPY_FILES } as const;
