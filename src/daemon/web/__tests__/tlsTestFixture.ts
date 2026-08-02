import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let cachedOpenSsl: string | null | undefined;

/** Find a usable OpenSSL without assuming Git for Windows is on PATH. */
export function findOpenSsl(): string | undefined {
  if (cachedOpenSsl !== undefined) return cachedOpenSsl ?? undefined;

  const candidates = [
    process.env['OPENSSL'],
    'openssl',
    ...(process.platform === 'win32'
      ? [
          'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
          'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
        ]
      : []),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of [...new Set(candidates)]) {
    const version = spawnSync(candidate, ['version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (!version.error && version.status === 0) {
      cachedOpenSsl = candidate;
      return candidate;
    }
  }

  cachedOpenSsl = null;
  return undefined;
}

export interface TlsTestFixture {
  dir: string;
  certPath: string;
  keyPath: string;
  cleanup(): void;
}

/** Generate a short-lived localhost certificate without committing key bytes. */
export function createTlsTestFixture(): TlsTestFixture {
  const openssl = findOpenSsl();
  if (!openssl) throw new Error('OpenSSL is unavailable');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-web-tls-'));
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  const generated = spawnSync(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      // Git for Windows otherwise rewrites `/CN=localhost` as an MSYS path.
      env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*' },
    },
  );

  if (generated.error || generated.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    const detail = generated.error?.message ?? generated.stderr.trim() ?? 'unknown error';
    throw new Error(`OpenSSL could not generate the TLS test fixture: ${detail}`);
  }

  return {
    dir,
    certPath,
    keyPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
