import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { secureWriteTokenFileMock } = vi.hoisted(() => ({
  secureWriteTokenFileMock: vi.fn(),
}));

vi.mock('../../../shared/security', () => ({
  secureWriteTokenFile: secureWriteTokenFileMock,
}));

import {
  loadWebState,
  loadWebStateWithDiagnostics,
  saveWebState,
  clearWebState,
  coerceWebState,
  coerceWebStateWithDiagnostics,
  getWebStatePath,
  WEB_STATE_DISABLED,
  type WebPersistedState,
} from '../webStateStore';

// Disk-IO → `.runtime.test.ts` so it runs serially (vitest.runtime.config sets
// fileParallelism:false). The expensive OS ACL primitive is mocked here; the
// shared security tests cover its native behavior.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-webstate-'));
  secureWriteTokenFileMock.mockReset();
  secureWriteTokenFileMock.mockImplementation((filePath: string, contents: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const enabled = (over: Partial<WebPersistedState> = {}): WebPersistedState => ({
  version: 1,
  enabled: true,
  port: 7681,
  host: '0.0.0.0',
  allowInput: true,
  allowUpload: false,
  allowedHosts: ['box.tail-scale.ts.net'],
  tailscale: false,
  token: 'tok-abc',
  ...over,
});

describe('webStateStore (#596 — wmux web survives a daemon restart)', () => {
  it('round-trips the full operator decision, options included', () => {
    expect(saveWebState(dir, enabled())).toBe(true);
    expect(loadWebState(dir)).toEqual(enabled());
  });

  it('round-trips native TLS paths without persisting private-key bytes', () => {
    const certPath = path.join(dir, 'certificate.pem');
    const keyPath = path.join(dir, 'private-key.pem');
    const privateKeyMarker = 'PRIVATE-KEY-MATERIAL-MUST-NOT-ENTER-STATE';
    fs.writeFileSync(certPath, 'certificate material', 'utf8');
    fs.writeFileSync(keyPath, privateKeyMarker, 'utf8');
    const state = enabled({
      tls: { certPath, keyPath },
      allowedHosts: ['box.example.test'],
    });

    expect(saveWebState(dir, state)).toBe(true);
    expect(loadWebState(dir)).toEqual(state);
    const raw = fs.readFileSync(getWebStatePath(dir), 'utf8');
    expect(raw).not.toContain(privateKeyMarker);
  });

  it('hardens a disabled inode before either create or overwrite receives the token', () => {
    const first = enabled();
    const second = enabled({ token: 'tok-reconfigured', port: 8765 });
    const target = getWebStatePath(dir);

    expect(saveWebState(dir, first)).toBe(true);
    expect(saveWebState(dir, second)).toBe(true);

    expect(secureWriteTokenFileMock).toHaveBeenNthCalledWith(
      1,
      target,
      JSON.stringify(WEB_STATE_DISABLED, null, 2),
    );
    expect(secureWriteTokenFileMock).toHaveBeenNthCalledWith(
      2,
      target,
      JSON.stringify(WEB_STATE_DISABLED, null, 2),
    );
    expect(loadWebState(dir)).toEqual(second);
  });

  it('never leaves the active token when placeholder hardening and cleanup both fail', () => {
    const target = getWebStatePath(dir);
    const persistenceError = new Error('ACL hardening denied; cleanup was busy');
    const onError = vi.fn();
    secureWriteTokenFileMock.mockImplementationOnce((filePath: string, contents: string) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
      // The real helper throws after ACL failure. Omitting its own deletion
      // models the review case where AV holds the file during cleanup too.
      throw persistenceError;
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EBUSY: retry was busy too'), { code: 'EBUSY' });
    });

    expect(saveWebState(dir, enabled(), onError)).toBe(false);
    expect(onError).toHaveBeenCalledWith(persistenceError);
    expect(fs.readFileSync(target, 'utf8')).toBe(JSON.stringify(WEB_STATE_DISABLED, null, 2));
    expect(fs.readFileSync(target, 'utf8')).not.toContain('tok-abc');
    expect(loadWebState(dir)).toEqual({ ...WEB_STATE_DISABLED });
  });

  it('does not let a diagnostic callback failure turn best-effort save into a throw', () => {
    secureWriteTokenFileMock.mockImplementationOnce(() => {
      throw new Error('disk denied persistence');
    });

    expect(
      saveWebState(dir, enabled(), () => {
        throw new Error('logger failed too');
      }),
    ).toBe(false);
  });

  it('does not recreate an unhardened inode when the placeholder disappears before populate', () => {
    const target = getWebStatePath(dir);
    secureWriteTokenFileMock.mockImplementationOnce((filePath: string, contents: string) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
      // External deletion in the harden → populate window. The populate step
      // must open existing-only; path-based writeFileSync would recreate it.
      fs.unlinkSync(filePath);
    });

    expect(saveWebState(dir, enabled())).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    expect(secureWriteTokenFileMock).toHaveBeenCalledWith(
      target,
      JSON.stringify(WEB_STATE_DISABLED, null, 2),
    );
  });

  it('no file → disabled, so a fresh install still has nothing listening', () => {
    expect(loadWebState(dir)).toEqual({ ...WEB_STATE_DISABLED });
    expect(fs.existsSync(getWebStatePath(dir))).toBe(false);
  });

  it('normal deletion revokes the token and removes the file', () => {
    saveWebState(dir, enabled());
    clearWebState(dir);
    expect(fs.existsSync(getWebStatePath(dir))).toBe(false);
    expect(loadWebState(dir).token).toBe('');
  });

  it('clearing an absent file succeeds only through ENOENT', () => {
    secureWriteTokenFileMock.mockClear();
    expect(() => clearWebState(dir)).not.toThrow();
    expect(secureWriteTokenFileMock).not.toHaveBeenCalled();
  });

  it.each(['EPERM', 'EBUSY'])(
    'falls back to a securely written disabled record when unlink fails with %s',
    (code) => {
      saveWebState(dir, enabled());
      secureWriteTokenFileMock.mockClear();
      vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
        throw Object.assign(new Error(`${code}: file is busy`), { code });
      });

      expect(() => clearWebState(dir)).not.toThrow();

      expect(secureWriteTokenFileMock).toHaveBeenCalledWith(
        getWebStatePath(dir),
        JSON.stringify(WEB_STATE_DISABLED, null, 2),
      );
      expect(loadWebState(dir)).toEqual({ ...WEB_STATE_DISABLED });
      expect(loadWebState(dir).token).toBe('');
    },
  );

  it('cannot report success when deletion and secure disablement both fail', () => {
    saveWebState(dir, enabled());
    secureWriteTokenFileMock.mockImplementationOnce(() => {
      throw new Error('ACL hardening denied');
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EACCES: deletion denied'), { code: 'EACCES' });
    });

    expect(() => clearWebState(dir)).toThrow(
      'Could not revoke persisted web state: deletion failed (EACCES: deletion denied) ' +
        'and secure disablement failed (ACL hardening denied)',
    );
    expect(loadWebState(dir)).toEqual(enabled());
  });

  it('accepts helper failure when its fail-closed cleanup already deleted the file', () => {
    saveWebState(dir, enabled());
    const target = getWebStatePath(dir);
    secureWriteTokenFileMock.mockImplementationOnce((filePath: string) => {
      fs.unlinkSync(filePath);
      throw new Error('ACL hardening denied after cleanup');
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EBUSY: first deletion denied'), { code: 'EBUSY' });
    });

    expect(() => clearWebState(dir)).not.toThrow();
    expect(fs.existsSync(target)).toBe(false);
    expect(loadWebState(dir)).toEqual({ ...WEB_STATE_DISABLED });
  });

  it('a corrupt state file degrades to disabled instead of blocking daemon boot', () => {
    fs.writeFileSync(getWebStatePath(dir), '{ this is not json', 'utf-8');
    expect(loadWebState(dir).enabled).toBe(false);
  });

  it('enabled without a token is treated as disabled (a restore would 401 the phone)', () => {
    saveWebState(dir, enabled({ token: '' }));
    expect(loadWebState(dir).enabled).toBe(false);
  });

  it('enabled must be literally true — fail-closed on a truthy impostor', () => {
    expect(coerceWebState({ ...enabled(), enabled: 'yes' }).enabled).toBe(false);
    expect(coerceWebState({ ...enabled(), enabled: 1 }).enabled).toBe(false);
  });

  it('keeps a pre-TLS state enabled as plaintext for backward compatibility', () => {
    const loaded = coerceWebStateWithDiagnostics(enabled());
    expect(loaded.state.enabled).toBe(true);
    expect(loaded.state.tls).toBeUndefined();
    expect(loaded.transportInvalid).toBe(false);
  });

  it.each([
    null,
    {},
    { certPath: 'relative-cert.pem', keyPath: 'relative-key.pem' },
    { certPath: path.resolve('certificate.pem') },
    { keyPath: path.resolve('private-key.pem') },
  ])('disables restore for malformed TLS state instead of downgrading to HTTP (%j)', (tls) => {
    const loaded = coerceWebStateWithDiagnostics({ ...enabled(), tls });
    expect(loaded.state.enabled).toBe(false);
    expect(loaded.state.tls).toBeUndefined();
    expect(loaded.transportInvalid).toBe(true);
  });

  it('disables the unsupported native-TLS plus Tailscale combination', () => {
    const loaded = coerceWebStateWithDiagnostics({
      ...enabled(),
      tailscale: true,
      tls: {
        certPath: path.join(dir, 'certificate.pem'),
        keyPath: path.join(dir, 'private-key.pem'),
      },
    });
    expect(loaded.state.enabled).toBe(false);
    expect(loaded.transportInvalid).toBe(true);
  });

  it('retains invalid-transport diagnostics when loading from disk', () => {
    fs.writeFileSync(
      getWebStatePath(dir),
      JSON.stringify({ ...enabled(), tls: { certPath: 'relative.pem' } }),
      'utf8',
    );
    const loaded = loadWebStateWithDiagnostics(dir);
    expect(loaded.state.enabled).toBe(false);
    expect(loaded.transportInvalid).toBe(true);
  });

  it('coerces per-field: one bad value never discards the rest', () => {
    const s = coerceWebState({
      version: 1,
      enabled: true,
      port: 99999, // out of range → default
      host: '', // empty → default
      allowInput: true,
      allowedHosts: ['ok.example', 42, '  ', 'also.ok'],
      token: 'tok-abc',
    });
    expect(s.port).toBe(WEB_STATE_DISABLED.port);
    expect(s.host).toBe(WEB_STATE_DISABLED.host);
    // The surviving fields are untouched — including the ones that matter for
    // reproducing the operator's exact intent.
    expect(s.enabled).toBe(true);
    expect(s.allowInput).toBe(true);
    expect(s.token).toBe('tok-abc');
    expect(s.allowedHosts).toEqual(['ok.example', 'also.ok']);
  });

  it('ignores __proto__ in the on-disk payload (no prototype pollution)', () => {
    fs.writeFileSync(
      getWebStatePath(dir),
      '{"version":1,"enabled":true,"token":"t","__proto__":{"polluted":"yes"}}',
      'utf-8',
    );
    loadWebState(dir);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('never creates a secret-bearing .tmp file', () => {
    saveWebState(dir, enabled());
    expect(fs.existsSync(`${getWebStatePath(dir)}.tmp`)).toBe(false);
  });

  it('reports failure instead of throwing when the directory cannot be written', () => {
    // A path whose parent is a FILE can never be mkdir'd — a portable stand-in
    // for "the disk said no". The start RPC must not fail because of this.
    const blocked = path.join(dir, 'a-file', 'nested');
    fs.writeFileSync(path.join(dir, 'a-file'), 'x', 'utf-8');
    expect(saveWebState(blocked, enabled())).toBe(false);
  });
});
