import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A real binary that ignores SIGTERM (and so does its child): the probe must
// escalate to the process group and settle only after everything is gone.
describe.skipIf(process.platform === 'win32')('probeOpenCodeVersion against a hung opencode', () => {
  it('kills a SIGTERM-ignoring process tree before reporting the timeout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-oc-probe-'));
    const pids = path.join(dir, 'pids');
    fs.writeFileSync(path.join(dir, 'opencode'), `#!/bin/sh\ntrap '' TERM\nsleep 30 &\necho "$$ $!" > '${pids}'\nwait\n`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath}`;
    vi.resetModules();
    try {
      const { probeOpenCodeVersion } = await import('../openCodeTerminalChatIntegration');
      expect(await probeOpenCodeVersion(3000, 500)).toMatchObject({ state: 'timeout' });
      const [shell, sleeper] = fs.readFileSync(pids, 'utf8').trim().split(' ').map(Number);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(alive(shell)).toBe(false);
      expect(alive(sleeper)).toBe(false);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
