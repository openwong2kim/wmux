import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadWebState,
  saveWebState,
  clearWebState,
  coerceWebState,
  getWebStatePath,
  WEB_STATE_DISABLED,
  type WebPersistedState,
} from '../webStateStore';

// Disk-IO → `.runtime.test.ts` so it runs serially (vitest.runtime.config sets
// fileParallelism:false) and the tmp+rename dance never races another file.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-webstate-'));
});
afterEach(() => {
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
  allowedHosts: ['box.tail-scale.ts.net'],
  token: 'tok-abc',
  ...over,
});

describe('webStateStore (#596 — wmux web survives a daemon restart)', () => {
  it('round-trips the full operator decision, options included', () => {
    expect(saveWebState(dir, enabled())).toBe(true);
    expect(loadWebState(dir)).toEqual(enabled());
  });

  it('no file → disabled, so a fresh install still has nothing listening', () => {
    expect(loadWebState(dir)).toEqual({ ...WEB_STATE_DISABLED });
    expect(fs.existsSync(getWebStatePath(dir))).toBe(false);
  });

  it('clearWebState revokes the token — the file is gone, not just flagged off', () => {
    saveWebState(dir, enabled());
    clearWebState(dir);
    expect(fs.existsSync(getWebStatePath(dir))).toBe(false);
    expect(loadWebState(dir).token).toBe('');
    // Clearing an already-absent file is the desired end state either way.
    expect(() => clearWebState(dir)).not.toThrow();
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

  it('leaves no .tmp behind after a successful write', () => {
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
