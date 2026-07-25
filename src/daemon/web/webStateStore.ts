import fs from 'node:fs';
import path from 'node:path';

/**
 * Durable record of the operator's "yes, serve this" for `wmux web` (#596).
 *
 * Sessions survive a daemon restart by design; before this, the server that
 * serves them did not. The web server is started ONLY by an explicit
 * `daemon.web.start` (CLI or titlebar popover), and nothing remembered that
 * across a crash, a reboot, or the one-click updater's restart — so phone
 * access died silently and could only be revived by a human at the desktop,
 * which is precisely the situation phone access exists for.
 *
 * The lazy-init default is deliberately NOT changed here: with no state file
 * (a fresh install, or an operator who never ran `wmux web`) nothing listens.
 * What is restored is an explicit operator decision, nothing more.
 *
 * ── Why its own file, not `config.json` ────────────────────────────────────
 * The record carries the web bearer token, and config.json is hand-edited and
 * routinely pasted into bug reports. This file is 0600 and holds nothing an
 * operator would want to edit by hand — the same posture as the sibling
 * `daemon-auth-token`, which already persists a long-lived bearer token in
 * this directory. Keeping it separate also means a malformed web state can
 * never take config.json's core structure down with it.
 */
export interface WebPersistedState {
  version: 1;
  /** The operator's explicit intent. False (or no file) → nothing listens. */
  enabled: boolean;
  port: number;
  host: string;
  allowInput: boolean;
  allowedHosts: string[];
  /**
   * The web bearer token to reuse on restore.
   *
   * Persisted because rotating it would produce a server that is up but
   * unreachable from the very device that was using it — the phone holds the
   * old token in sessionStorage and would get a 401 with no human nearby.
   * Restoring the listener without this would be worse than the honest
   * failure it replaces.
   *
   * Lifetime: minted on the first start, reused across restarts AND across
   * operator re-starts (so `wmux web --allow-host …` no longer locks out a
   * paired phone), and destroyed on an explicit `wmux web --stop` or
   * `wmux web --new-token`. The pairing code is deliberately NOT persisted —
   * it is short-lived and single-use by design, so a restore mints a fresh one.
   */
  token: string;
}

const STATE_FILE = 'web-state.json';

/** Same shape the rest of the daemon uses for a "nothing here" answer. */
export const WEB_STATE_DISABLED: Readonly<WebPersistedState> = Object.freeze({
  version: 1 as const,
  enabled: false,
  port: 7681,
  host: '127.0.0.1',
  allowInput: false,
  allowedHosts: [] as string[],
  token: '',
});

export function getWebStatePath(wmuxDir: string): string {
  return path.join(wmuxDir, STATE_FILE);
}

/**
 * Read the persisted state. Any failure — missing file, unreadable, malformed
 * JSON, wrong types — degrades to "disabled" rather than throwing: a corrupt
 * state file must never keep the daemon from booting, and the safe direction
 * for a serve-to-the-network toggle is off.
 */
export function loadWebState(wmuxDir: string): WebPersistedState {
  let raw: string;
  try {
    raw = fs.readFileSync(getWebStatePath(wmuxDir), 'utf-8');
  } catch {
    return { ...WEB_STATE_DISABLED };
  }

  try {
    const parsed: unknown = JSON.parse(raw, (key, value) => {
      // Prototype pollution guard (mirrors config.ts / SessionManager).
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return value;
    });
    return coerceWebState(parsed);
  } catch {
    return { ...WEB_STATE_DISABLED };
  }
}

/**
 * Per-field coercion to a usable state. Anything unrecognised falls back to
 * the disabled default for THAT field only — the discipline `coerceLanLinkConfig`
 * uses, for the same reason: one bad field must not discard the rest.
 *
 * `enabled` is fail-closed twice over: it must be literally `true`, and a
 * record with no token is treated as disabled (an enabled server whose token
 * we cannot reproduce would 401 the paired device, which is the outcome this
 * whole change exists to prevent).
 */
export function coerceWebState(parsed: unknown): WebPersistedState {
  if (typeof parsed !== 'object' || parsed === null) return { ...WEB_STATE_DISABLED };
  const o = parsed as Record<string, unknown>;

  const port =
    typeof o['port'] === 'number' && Number.isInteger(o['port']) && o['port'] > 0 && o['port'] < 65536
      ? o['port']
      : WEB_STATE_DISABLED.port;
  const host = typeof o['host'] === 'string' && o['host'] ? o['host'] : WEB_STATE_DISABLED.host;
  const token = typeof o['token'] === 'string' ? o['token'] : '';
  const allowedHosts = Array.isArray(o['allowedHosts'])
    ? o['allowedHosts'].filter((h): h is string => typeof h === 'string' && h.trim() !== '')
    : [];

  return {
    version: 1,
    enabled: o['enabled'] === true && token !== '',
    port,
    host,
    allowInput: o['allowInput'] === true,
    allowedHosts,
    token,
  };
}

/**
 * Atomic write (tmp + rename, mirroring saveConfig). Best-effort: a failure to
 * persist must never fail the start RPC the operator just made — the server IS
 * running, it simply will not come back on its own. Returns false so the caller
 * can log the degraded outcome.
 */
export function saveWebState(wmuxDir: string, state: WebPersistedState): boolean {
  const target = getWebStatePath(wmuxDir);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(wmuxDir, { recursive: true });
    // mode is a no-op on Windows (NTFS ACLs govern); it still matters on
    // POSIX, where this file is as sensitive as daemon-auth-token.
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup errors */
    }
    return false;
  }
}

/**
 * Forget everything, including the token. This is the revocation path: after
 * `wmux web --stop`, a phone still holding the old token can never use it
 * again, and the next start mints a fresh one.
 */
export function clearWebState(wmuxDir: string): void {
  try {
    fs.unlinkSync(getWebStatePath(wmuxDir));
  } catch {
    /* already gone — the desired end state either way */
  }
}
