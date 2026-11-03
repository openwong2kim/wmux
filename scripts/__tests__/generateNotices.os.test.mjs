// Drift guard for THIRD_PARTY_NOTICES, mirroring the one on docs/api/reference.md.
//
// We ship signed, notarized binaries, so the notices file is a compliance
// artifact — and it had drifted to 110 packages against 128 actually shipping,
// with @modelcontextprotocol/sdk attributed at a version we no longer install.
// Nothing caught that for two months because nothing ever ran the generator.
// This is that something: it fails the suite whenever package-lock.json moves
// without `npm run notices` being run.
//
// It only works because the generator is deterministic — no wall-clock stamp,
// package set resolved from the lockfile rather than the installed tree, LF
// normalization on vendored license text. If any of that regresses, this test
// goes permanently red rather than silently stopping to guard.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'generate-notices.mjs');

function runGenerator(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    timeout: 120_000,
    encoding: 'utf8',
  });
}

describe('THIRD_PARTY_NOTICES drift guard', () => {
  it('names the .NET SDK the Windows helper is built with', () => {
    // The helper's runtime notices are this SDK's runtime. global.json makes the
    // build use exactly that SDK, and the workflows install it from global.json.
    const sdk = /const HELPER_DOTNET_SDK = '([^']+)'/.exec(readFileSync(SCRIPT, 'utf8'))?.[1];
    expect(sdk).toMatch(/^\d+\.\d+\.\d+$/);
    const pin = JSON.parse(readFileSync(path.join(REPO_ROOT, 'global.json'), 'utf8')).sdk;
    expect(pin).toEqual({ version: sdk, rollForward: 'disable' });
    for (const workflow of ['release.yml', 'ci.yml']) {
      const text = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', workflow), 'utf8');
      expect(text, workflow).not.toMatch(/dotnet-version:/);
      expect(text, workflow).toMatch(/global-json-file:\s*global\.json/);
    }
  });

  it('normalizes CRLF in the vendored connector license', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wmux-notices-'));
    try {
      const preload = path.join(dir, 'crlf.cjs');
      writeFileSync(preload, `
        const fs = require('node:fs');
        const read = fs.readFileSync;
        fs.readFileSync = function(file, ...args) {
          const result = read.call(this, file, ...args);
          return String(file).endsWith('LICENSE.LibreChat') && typeof result === 'string'
            ? result.replace(/\\r?\\n/g, '\\r\\n') : result;
        };
        require('node:module').syncBuiltinESMExports();
      `);
      const crlf = execFileSync(process.execPath, ['--require', preload, SCRIPT, '--stdout-digest'], {
        cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000,
      });
      expect(crlf).toBe(runGenerator(['--stdout-digest']));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('is up to date with package-lock.json (generate-notices --check)', () => {
    try {
      runGenerator(['--check']);
    } catch (err) {
      const detail = [err.stdout, err.stderr]
        .filter(Boolean)
        .map((b) => b.toString())
        .join('\n');
      expect.fail(
        `THIRD_PARTY_NOTICES is stale — run \`npm run notices\` and commit the result.\n${detail}`,
      );
    }
  });

  it('regenerates byte-identically on a second run', () => {
    // A generator that is merely "correct" is not enough: if the output varied
    // between runs the check above would flap, and the usual response to a
    // flaky guard is to delete it.
    const first = runGenerator(['--stdout-digest']);
    const second = runGenerator(['--stdout-digest']);
    expect(first).toBe(second);
    expect(first.trim()).toMatch(/^[0-9a-f]{64}$/);
  });
});
