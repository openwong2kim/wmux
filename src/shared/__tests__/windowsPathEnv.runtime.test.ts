import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readRegistryEnvPath } from '../windowsPathEnv';

// The real reader has an intentional 800 ms startup deadline. Run serially in
// the runtime lane, with one retry for transient host load, not a wider deadline.
/**
 * The parser/cache tests inject `deps.readRegistryPath`; these exercise the
 * real reader that held the encoding bug. They spawn the real
 * reg.exe against a scratch key under HKCU\Software. It never touches
 * HKCU\Environment.
 */
describe.runIf(process.platform === 'win32')('readRegistryEnvPath (live reg.exe)', { retry: 1 }, () => {
  const KEY = `HKCU\\Software\\wmux-test-849-${process.pid}`;
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const drop = () => {
    try {
      execFileSync(reg, ['delete', KEY, '/f'], { stdio: 'ignore' });
    } catch {
      /* not present */
    }
  };

  it('round-trips a non-ASCII REG_EXPAND_SZ value byte for byte', () => {
    const value = 'D:\\软件\\Python312;D:\\héllo;%SystemRoot%\\System32';
    try {
      drop();
      execFileSync(reg, ['add', KEY, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', value, '/f'], {
        stdio: 'ignore',
      });
      expect(readRegistryEnvPath(KEY)).toBe(value);
    } finally {
      drop();
    }
  });

  it('leaves no temp file behind', () => {
    // Point os.tmpdir() at a private directory for the duration. Counting
    // `wmux-regpath-*` in the shared temp dir instead would go flaky the moment
    // a real wmux is running alongside the suite — it writes the same prefix.
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-849-tmp-'));
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TEMP = sandbox;
    process.env.TMP = sandbox;
    try {
      drop();
      execFileSync(reg, ['add', KEY, '/v', 'Path', '/t', 'REG_SZ', '/d', 'C:\\a', '/f'], {
        stdio: 'ignore',
      });
      expect(readRegistryEnvPath(KEY)).toBe('C:\\a'); // it really ran
      expect(fs.readdirSync(sandbox)).toEqual([]);
    } finally {
      for (const key of ['TEMP', 'TMP'] as const) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      fs.rmSync(sandbox, { recursive: true, force: true });
      drop();
    }
  });

  it('fails open (null) for a key that does not exist', () => {
    expect(readRegistryEnvPath(`${KEY}-absent-xyz`)).toBeNull();
  });
});

