// The real Windows read: the PowerShell script runs against this machine's own
// addresses and answers with one of the four categories.
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { beforeAll, describe, it, expect } from 'vitest';
import { categoryScript, parseCategoryOutput, readNetCategory, QUERY_TIMEOUT_MS, type ExecFileFn } from '../netCategory';

function firstExternalIPv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return null;
}

/** A failed PowerShell run, with how Node says it ended (killed by the timeout, an exit code, a signal). */
function surfaced(err: unknown): Error {
  const e = (err ?? {}) as { message?: unknown; killed?: unknown; code?: unknown; signal?: unknown };
  const message = typeof e.message === 'string' ? e.message : String(err);
  return new Error(`${message} [killed=${String(e.killed)} code=${String(e.code)} signal=${String(e.signal)}]`);
}

/** The product's exec without its timeout. */
const untimed: ExecFileFn = (file, args, { windowsHide }) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide, encoding: 'utf-8' }, (err, stdout) => (err ? reject(err) : resolve({ stdout })));
  });

// The reads below run under the product's timeout. An idle runner answers in
// under a second, but on a busy one (another test file creating a local
// account and starting processes as it) the first read can take longer than
// the timeout, while the reads after it answer in a second or two again. So
// one read runs to completion first, with no timeout of its own: the reads
// under test start once this machine has answered the query.
if (process.platform === 'win32') {
  beforeAll(async () => {
    const ip = firstExternalIPv4();
    if (!ip) return;
    const started = Date.now();
    const outcome = await readNetCategory(ip, { exec: untimed }).catch((err: unknown) => surfaced(err).message);
    console.log(`[netCategory] first read on this runner: ${outcome} after ${Date.now() - started} ms`);
  }, 120_000);
}

describe.runIf(process.platform === 'win32')('readNetCategory on Windows', () => {
  it('reads a category for a live external address', async () => {
    const ip = firstExternalIPv4();
    if (!ip) return; // a runner with no external IPv4 has nothing to read
    const category = await readNetCategory(ip).catch((err: unknown) => { throw surfaced(err); });
    expect(category).toMatch(/^(Private|Public|Domain|Unknown)$/);
  }, 20_000);

  it('rejects for an address this machine does not have', async () => {
    await expect(readNetCategory('203.0.113.250')).rejects.toThrow();
  }, 20_000);
});

describe.runIf(process.platform !== 'win32')('readNetCategory elsewhere', () => {
  it('is not-applicable', async () => {
    await expect(readNetCategory('192.168.1.10')).resolves.toBe('not-applicable');
  });
});

describe.runIf(process.platform === 'win32')('Windows PowerShell 5.1 output bytes', () => {
  it('writes the category line to a pipe as single-byte ASCII, not UTF-16', async () => {
    const ip = firstExternalIPv4();
    if (!ip) return;
    const psPath = path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const stdout = await new Promise<Buffer>((resolve, reject) => {
      execFile(psPath, ['-NoProfile', '-NonInteractive', '-Command', categoryScript(ip)], { encoding: 'buffer', windowsHide: true, timeout: QUERY_TIMEOUT_MS }, (err, out) =>
        err ? reject(surfaced(err)) : resolve(out),
      );
    });
    expect(stdout.includes(0)).toBe(false); // UTF-16LE would interleave NUL bytes
    expect(parseCategoryOutput(stdout.toString('utf-8'))).toMatch(/^(Private|Public|Domain|Unknown)$/);
  }, 20_000);
});
