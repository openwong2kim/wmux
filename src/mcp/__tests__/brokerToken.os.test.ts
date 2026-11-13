import { execFileSync, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real timingSafeEqual, observed: the comparison must go through it.
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import { brokerTokenSource, readTokenFile, tokenMatches } from '../brokerToken';

const isWin = process.platform === 'win32';
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
// Root reads a 000 file anyway, so the unreadable case cannot be made there.
const canMakeUnreadable = !isWin && uid !== 0;
const SECRET = 'token-text-0f3c9a';

let dir = '';
let file = '';

function write(content: string, mode = 0o600): void {
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btok-'));
  file = path.join(dir, 'token');
});

afterEach(() => {
  try { fs.chmodSync(file, 0o600); } catch { /* absent */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readTokenFile', () => {
  it('reads a 0600 file owned by this user, trimmed', () => {
    write(`${SECRET}\n`);
    expect(readTokenFile(file, uid)).toEqual({ ok: true, token: SECRET });
  });

  it('a missing file', () => {
    expect(readTokenFile(file, uid)).toEqual({ ok: false, problem: 'missing' });
  });

  it('an empty or blank file', () => {
    write('');
    expect(readTokenFile(file, uid)).toEqual({ ok: false, problem: 'empty' });
    write(' \n');
    expect(readTokenFile(file, uid)).toEqual({ ok: false, problem: 'empty' });
  });

  it('a directory in its place', () => {
    fs.mkdirSync(file);
    expect(readTokenFile(file, uid)).toEqual({ ok: false, problem: 'not-a-file' });
    fs.rmdirSync(file);
  });

  it.runIf(canMakeUnreadable)('an unreadable file', () => {
    write(SECRET, 0o000);
    expect(readTokenFile(file, uid)).toEqual({ ok: false, problem: 'unreadable' });
  });

  it.runIf(!isWin)('group or other permission bits', () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      write(SECRET, mode);
      expect(readTokenFile(file, uid), mode.toString(8)).toEqual({ ok: false, problem: 'mode' });
    }
  });

  it.runIf(!isWin)('a file owned by another user', () => {
    write(SECRET);
    expect(readTokenFile(file, (uid ?? 0) + 1)).toEqual({ ok: false, problem: 'owner' });
  });

  it.runIf(!isWin)('a FIFO in its place is refused at once, without blocking', () => {
    execFileSync('mkfifo', [file]);
    // A blocking open would wait for a writer forever: this one arrives after
    // 2 s, so a regression fails on the time below instead of hanging the run.
    const watchdog = spawn('sh', ['-c', 'sleep 2; exec 3>"$0"', file], { stdio: 'ignore' });
    try {
      const started = Date.now();
      expect(readTokenFile(file, uid)).toEqual({ ok: false, problem: 'not-a-file' });
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      watchdog.kill();
    }
  });

  it('a file over 4096 bytes', () => {
    write('x'.repeat(4097));
    expect(readTokenFile(file, uid)).toEqual({ ok: false, problem: 'too-large' });
    write('x'.repeat(4096));
    expect(readTokenFile(file, uid)).toEqual({ ok: true, token: 'x'.repeat(4096) });
  });

  it('modes are not checked on Windows', () => {
    write(SECRET, 0o644);
    expect(readTokenFile(file, null, 'win32')).toEqual({ ok: true, token: SECRET });
  });

  it('a refusal never carries token text', () => {
    const results = [];
    write(SECRET.repeat(400));
    results.push(readTokenFile(file, uid));
    if (!isWin) {
      write(SECRET, 0o644);
      results.push(readTokenFile(file, uid));
      write(SECRET);
      results.push(readTokenFile(file, (uid ?? 0) + 1));
    }
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
  });
});

describe('brokerTokenSource', () => {
  it('a usable file at start: read again on every call, never the environment token', () => {
    write('first');
    const { read, startProblem } = brokerTokenSource(file, 'from-env', uid);
    expect(startProblem).toBeNull();
    expect(read?.()).toEqual({ ok: true, token: 'first' });
    write('second');
    expect(read?.()).toEqual({ ok: true, token: 'second' });
    fs.unlinkSync(file);
    expect(read?.()).toEqual({ ok: false, problem: 'missing' });
    write('third');
    expect(read?.()).toEqual({ ok: true, token: 'third' });
  });

  it('no usable file at start: the environment token until the file is usable, then the file for good', () => {
    const { read, startProblem } = brokerTokenSource(file, 'from-env', uid);
    expect(startProblem).toBe('missing');
    expect(read?.()).toEqual({ ok: true, token: 'from-env' });
    write('later');
    expect(read?.()).toEqual({ ok: true, token: 'later' });
    fs.unlinkSync(file);
    expect(read?.()).toEqual({ ok: false, problem: 'missing' });
  });

  it.runIf(!isWin)('a file too open at start is named, and the environment token stands in', () => {
    write('loose', 0o644);
    const { read, startProblem } = brokerTokenSource(file, 'from-env', uid);
    expect(startProblem).toBe('mode');
    expect(read?.()).toEqual({ ok: true, token: 'from-env' });
    fs.chmodSync(file, 0o600);
    expect(read?.()).toEqual({ ok: true, token: 'loose' });
  });

  it('neither: no source', () => {
    expect(brokerTokenSource(file, undefined, uid).read).toBeNull();
    expect(brokerTokenSource(file, '', uid).read).toBeNull();
  });
});

describe('tokenMatches', () => {
  it('matches only the same token', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('abcd', 'abc')).toBe(false);
    expect(tokenMatches('', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
    expect(tokenMatches(123, 'abc')).toBe(false);
  });

  it('compares with crypto.timingSafeEqual on fixed-length digests, whatever the lengths', () => {
    const spy = vi.mocked(crypto.timingSafeEqual);
    for (const presented of ['abc', 'abd', 'a', 'a-much-longer-token-than-expected']) {
      spy.mockClear();
      tokenMatches(presented, 'abc');
      expect(spy).toHaveBeenCalledTimes(1);
      const [a, b] = spy.mock.calls[0] as unknown as [Buffer, Buffer];
      expect(a.length).toBe(32);
      expect(b.length).toBe(32);
    }
  });
});
