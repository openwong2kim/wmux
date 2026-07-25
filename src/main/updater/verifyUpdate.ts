/**
 * NN2-T4 — pure, electron-free verification logic for the auto-updater.
 *
 * Before v2.14.x the updater handed the user an UNVERIFIED binary: it called
 * shell.openExternal(url) on a URL taken verbatim from the update server, with
 * no integrity check at all. A compromised release artifact or a redirect MITM
 * was undetectable client-side — the single biggest supply-chain gap for a tool
 * that auto-edits ~/.claude.json and drives a logged-in browser.
 *
 * This module holds the security decisions (URL allowlist, manifest validation,
 * constant-time digest comparison) as pure functions so they can be unit-tested
 * without electron. AutoUpdater wires the download/launch plumbing around them.
 * The contract is FAIL-CLOSED: any uncertainty rejects the install.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export interface UpdateManifest {
  version: string;
  /**
   * Artifact file name, normalized across platforms: the Windows manifest
   * publishes it as `setupExe` (unchanged, for backward compatibility with
   * already-shipped clients), the darwin manifest as `file`.
   */
  fileName: string;
  sha256: string;
  url: string;
}

export type ManifestResult =
  | { ok: true; manifest: UpdateManifest }
  | { ok: false; reason: string };

/** Strip a leading "v" so "v2.14.0" and "2.14.0" compare equal. */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, '');
}

/**
 * Only https downloads from github.com (the release host) are accepted. The
 * release asset 302-redirects to objects.githubusercontent.com; we validate the
 * INITIAL url here and let the HTTP client follow the redirect.
 */
export function isAllowedDownloadUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'github.com' || host.endsWith('.github.com');
}

/** Constant-time, case-insensitive comparison of two hex digests. */
export function digestsEqual(a: string, b: string): boolean {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na.length === 0 || na.length !== nb.length) return false;
  try {
    return timingSafeEqual(Buffer.from(na, 'utf8'), Buffer.from(nb, 'utf8'));
  } catch {
    return false;
  }
}

/** SHA-256 hex digest of a buffer. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Validate a fetched manifest is well-formed, points at an allowlisted https
 * github.com URL, carries a 64-char hex SHA-256, and matches the version the
 * update server offered (defends against a stale/wrong manifest). Returns a
 * typed, trusted manifest or a rejection reason.
 */
export function validateManifest(raw: unknown, offeredVersion: string): ManifestResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'manifest is not an object' };
  const o = raw as Record<string, unknown>;
  // `setupExe` (Windows manifest) or `file` (darwin manifest) — either one names
  // the artifact; everything else is validated identically on both platforms.
  const fileName = typeof o.setupExe === 'string' ? o.setupExe
    : typeof o.file === 'string' ? o.file
      : null;
  if (
    typeof o.version !== 'string' ||
    fileName === null ||
    typeof o.sha256 !== 'string' ||
    typeof o.url !== 'string'
  ) {
    return { ok: false, reason: 'manifest missing required string fields (version/setupExe|file/sha256/url)' };
  }
  if (!/^[a-f0-9]{64}$/i.test(o.sha256.trim())) {
    return { ok: false, reason: 'sha256 is not a 64-char hex digest' };
  }
  if (!isAllowedDownloadUrl(o.url)) {
    return { ok: false, reason: `download url is not an allowed https github.com url: ${o.url}` };
  }
  if (normalizeVersion(o.version) !== normalizeVersion(offeredVersion)) {
    return { ok: false, reason: `manifest version "${o.version}" does not match offered update "${offeredVersion}"` };
  }
  return {
    ok: true,
    manifest: { version: o.version, fileName, sha256: o.sha256.trim(), url: o.url },
  };
}
