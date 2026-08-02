import fs from 'node:fs';
import path from 'node:path';
import { secureWriteTokenFile } from '../../shared/security';
import type { WebTlsConfig } from '../../shared/web';

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
 * `daemon-auth-token`, including synchronous filesystem hardening for every
 * secret-bearing write. Keeping it separate also means a malformed web state
 * can never take config.json's core structure down with it.
 */
export interface WebPersistedState {
  version: 1;
  /** The operator's explicit intent. False (or no file) → nothing listens. */
  enabled: boolean;
  port: number;
  host: string;
  allowInput: boolean;
  /**
   * Whether `POST /api/upload` was opted into (`--allow-upload`).
   *
   * A separate grant from `allowInput`: input writes bytes into a pane the
   * operator is watching, an upload writes a FILE into their home directory.
   * Absent in files written before this field existed, so it reads as false —
   * a restored server never gains a permission the operator did not ask for.
   */
  allowUpload: boolean;
  /** Native HTTPS PEM paths. Key bytes are never persisted here. */
  tls?: WebTlsConfig;
  allowedHosts: string[];
  /**
   * Whether the operator asked for a `tailscale serve` front.
   *
   * The daemon never acts on this — the main process owns the serve. It is
   * recorded so a restored server can report which transport it is actually
   * running, which is the only way the GUI checkbox can come back checked.
   * Absent in files written before this field existed, so it reads as false.
   */
  tailscale: boolean;
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
  allowUpload: false,
  allowedHosts: [] as string[],
  tailscale: false,
  token: '',
});

const WEB_STATE_DISABLED_JSON = JSON.stringify(WEB_STATE_DISABLED, null, 2);

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
  const tlsField = o['tls'];
  const tls = coerceTlsConfig(tlsField);
  const tlsIsValidOrAbsent = tlsField === undefined || tls !== undefined;
  const tailscale = o['tailscale'] === true;

  return {
    version: 1,
    // A malformed TLS record must never restore as plaintext. Likewise, the
    // current Tailscale front always proxies HTTP, so replaying both modes
    // would produce an HTTPS backend the front cannot reach.
    enabled:
      o['enabled'] === true &&
      token !== '' &&
      tlsIsValidOrAbsent &&
      !(tailscale && tls !== undefined),
    port,
    host,
    allowInput: o['allowInput'] === true,
    allowUpload: o['allowUpload'] === true,
    ...(tls ? { tls } : {}),
    allowedHosts,
    tailscale,
    token,
  };
}

function coerceTlsConfig(value: unknown): WebTlsConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const certPath = typeof o['certPath'] === 'string' ? o['certPath'].trim() : '';
  const keyPath = typeof o['keyPath'] === 'string' ? o['keyPath'].trim() : '';
  if (!certPath || !keyPath || !path.isAbsolute(certPath) || !path.isAbsolute(keyPath)) {
    return undefined;
  }
  return { certPath, keyPath };
}

/**
 * Secure direct write. This deliberately gives up tmp+rename atomicity so the
 * SAME inode can be hardened before it receives the reusable bearer token:
 *
 *   1. write a disabled placeholder containing no credential;
 *   2. synchronously harden that inode;
 *   3. overwrite the already-hardened inode with the enabled record.
 *
 * Writing the token before ACL hardening left an unsafe failure window when
 * both hardening and its best-effort cleanup failed. The placeholder closes
 * that window without reintroducing a secret-bearing temporary inode.
 * Populate opens with `r+` and verifies the path still names that open inode,
 * so an external deletion can fail the save but can never make this step
 * create a new, unhardened token file.
 *
 * Best-effort for start: a failure to persist must never fail the RPC the
 * operator just made. A failed reconfiguration may deliberately destroy the
 * previous valid record — including a crash while Windows is hardening the
 * disabled placeholder. That availability window is the fail-closed trade-off
 * for never retaining a credential on an inode we could not harden. Returns
 * false so the caller can log that the requested durable state was not
 * installed; onError receives the original persistence exception after
 * neutralisation. Diagnostic callback failures are ignored so logging cannot
 * turn this best-effort start path into an RPC failure.
 */
export function saveWebState(
  wmuxDir: string,
  state: WebPersistedState,
  onError?: (error: unknown) => void,
): boolean {
  const target = getWebStatePath(wmuxDir);
  try {
    secureWriteTokenFile(target, WEB_STATE_DISABLED_JSON);
    populateExistingWebState(target, JSON.stringify(state, null, 2));
    return true;
  } catch (error) {
    // The placeholder normally means there is already no credential to clean
    // up. Still neutralise best-effort in case the final overwrite wrote data
    // before reporting an I/O failure, or the placeholder write never began
    // and an older enabled record remains.
    try {
      fs.unlinkSync(target);
    } catch (unlinkError) {
      if (!isNotFoundError(unlinkError)) {
        try {
          // No hardening is required for this emergency overwrite: it contains
          // no secret and the only promise here is that the next boot sees off.
          fs.writeFileSync(target, WEB_STATE_DISABLED_JSON, {
            encoding: 'utf8',
            mode: 0o600,
          });
        } catch {
          // The caller receives false. At this point the filesystem rejected
          // every available neutralisation, so an older record may remain.
        }
      }
    }
    try {
      onError?.(error);
    } catch {
      // Diagnostics must not make an already best-effort start fail its RPC.
    }
    return false;
  }
}

/**
 * Populate only the inode the secure placeholder left behind.
 *
 * `writeFileSync(path)` implicitly carries O_CREAT: if AV or an operator
 * deletes the placeholder between hardening and population, it would silently
 * create a fresh inherited-DACL/umask inode and put the token there. `r+`
 * makes absence an error, while the fd keeps a deletion after open from
 * redirecting the write to a replacement path.
 */
function populateExistingWebState(target: string, contents: string): void {
  const fd = fs.openSync(target, 'r+');
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const current = fs.statSync(target, { bigint: true });
    if (!sameFileIdentity(opened, current)) {
      throw new Error('web state inode changed before population');
    }
    // Refuse an unrelated replacement that landed before open. The only inode
    // this step is allowed to populate is the disabled placeholder we wrote.
    if (fs.readFileSync(fd, 'utf8') !== WEB_STATE_DISABLED_JSON) {
      throw new Error('web state placeholder changed before population');
    }

    fs.ftruncateSync(fd, 0);
    const data = Buffer.from(contents, 'utf8');
    let offset = 0;
    // readFileSync(fd) leaves the descriptor at EOF and ftruncateSync does not
    // rewind it. Keep every write positional: offset is both buffer and file
    // position, so short writes resume at the exact byte that remains.
    while (offset < data.length) {
      const written = fs.writeSync(fd, data, offset, data.length - offset, offset);
      if (written === 0) throw new Error('web state population made no progress');
      offset += written;
    }

    const after = fs.statSync(target, { bigint: true });
    if (!sameFileIdentity(opened, after)) {
      throw new Error('web state inode changed during population');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function sameFileIdentity(opened: fs.BigIntStats, current: fs.BigIntStats): boolean {
  // Node reports st_dev as the Windows volume serial for fstat but zero for
  // stat(path); st_ino is the stable file ID in both forms. POSIX needs both
  // device and inode because inode numbers are only unique within a device.
  return (
    opened.ino === current.ino &&
    (process.platform === 'win32' || opened.dev === current.dev)
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function persistedWebStateIsAbsent(target: string): boolean {
  try {
    fs.lstatSync(target);
    return false;
  } catch (error) {
    return isNotFoundError(error);
  }
}

/**
 * Forget everything, including the token. This is the revocation path: after
 * `wmux web --stop`, a phone still holding the old token can never use it
 * again, and the next start mints a fresh one.
 */
export function clearWebState(wmuxDir: string): void {
  const target = getWebStatePath(wmuxDir);
  let deletionError: unknown;
  try {
    fs.unlinkSync(target);
    return;
  } catch (error) {
    if (isNotFoundError(error)) return;
    deletionError = error;
  }

  // Windows can refuse deletion while an AV scanner or another process holds
  // the file. Overwriting the intent and token is an equally durable revoke,
  // provided the replacement is hardened before we acknowledge success.
  try {
    secureWriteTokenFile(target, WEB_STATE_DISABLED_JSON);
  } catch (disableError) {
    // secureWriteTokenFile removes a file it could not harden. Absence is the
    // exact revocation outcome we wanted, even though the helper had to throw
    // while getting there.
    if (persistedWebStateIsAbsent(target)) return;

    const deletionReason =
      deletionError instanceof Error ? deletionError.message : String(deletionError);
    const disableReason =
      disableError instanceof Error ? disableError.message : String(disableError);
    throw new Error(
      `Could not revoke persisted web state: deletion failed (${deletionReason}) ` +
        `and secure disablement failed (${disableReason})`,
    );
  }
}
