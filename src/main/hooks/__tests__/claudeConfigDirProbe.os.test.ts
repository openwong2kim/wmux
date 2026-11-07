/**
 * The real login-shell runner (POSIX only: Windows never asks a shell). A stand-in
 * "shell" script plays the user's rc files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROBE_TIMEOUT_MS, claudeConfigDirEnv, resetClaudeConfigDirProbe } from '../claudeConfigDirProbe';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-probe-')); vi.stubEnv('CLAUDE_CONFIG_DIR', ''); });
afterEach(() => { vi.unstubAllEnvs(); resetClaudeConfigDirProbe(); fs.rmSync(tmp, { recursive: true, force: true }); });

function fakeShell(lines: string[]): string {
  const file = path.join(tmp, 'shell.sh');
  fs.writeFileSync(file, ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 });
  return file;
}

describe.skipIf(process.platform === 'win32')('the login-shell probe', () => {
  it('answers as soon as the marked line is in, even when an rc-spawned process keeps stdout open', async () => {
    vi.stubEnv('SHELL', fakeShell([
      "printf 'motd\\n__WMUX_CLAUDE_CONFIG_DIR__=/x/claude-alt\\n'",
      'sleep 30 &',
      'exit 0',
    ]));
    const started = Date.now();
    await expect(claudeConfigDirEnv()).resolves.toBe('/x/claude-alt');
    expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS);
  });

  it('gives up at the bound with no answer when the shell never prints one', async () => {
    vi.stubEnv('SHELL', fakeShell(['sleep 30']));
    const started = Date.now();
    await expect(claudeConfigDirEnv()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS + 1500);
  });
});
