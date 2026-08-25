import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { killVerifiedDaemonPid } from '../daemonLauncherCore';

/**
 * #1025 — reproduced by execution before this fix: an unrelated program
 * whose argv carries `<anything>/daemon/index.js` was verified as wmux's
 * daemon and SIGKILLed on a recycled PID. `daemon/index.js` is an extremely
 * common layout, so that marker was never evidence of anything; identity
 * against the scripts this host would actually spawn is.
 *
 * These spawn real processes and assert on the real OS probes, the way the
 * cross-host suite does — the bug was in what the probes were compared
 * against, so a mocked cmdline would test the wrong half.
 */
describe('killVerifiedDaemonPid — daemon-script identity (#1025)', () => {
  let tmpDir = '';
  let child: ChildProcess | null = null;

  afterEach(async () => {
    if (child && child.pid && child.exitCode === null) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      await new Promise<void>((resolve) => {
        if (!child) return resolve();
        child.once('exit', () => resolve());
        setTimeout(resolve, 2000);
      });
    }
    child = null;
    if (tmpDir) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
      }
      tmpDir = '';
    }
  });

  async function spawnSleeper(scriptPath: string): Promise<number> {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, 'setTimeout(() => {}, 30000);\n');
    child = spawn(process.execPath, [scriptPath], { stdio: 'ignore' });
    expect(child.pid).toBeTruthy();
    // Let the OS register the PID before tasklist/ps is asked about it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return child.pid as number;
  }

  it("refuses an unrelated process whose argv merely ends in daemon/index.js", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-identity-innocent-'));
    // Somebody else's program, using the same everyday layout. Note the image
    // matches too (both are plain `node`), so the cmdline gate is the ONLY
    // thing standing between this process and a SIGKILL.
    const pid = await spawnSleeper(path.join(tmpDir, 'someone-elses-app', 'daemon', 'index.js'));

    const killed = killVerifiedDaemonPid(pid, { definitiveOnly: false });
    expect(killed).toBe(false);

    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(true);
  }, 15_000);

  it('kills a process running exactly one of this host\'s resolved daemon scripts', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-identity-ours-'));
    // The same everyday layout as the case above — the ONLY difference is
    // that this path is what the resolver says we spawn, which is the whole
    // point: identity, not shape.
    const scriptPath = path.join(tmpDir, 'dist', 'daemon', 'index.js');
    const pid = await spawnSleeper(scriptPath);

    const killed = killVerifiedDaemonPid(pid, {
      definitiveOnly: false,
      scriptCandidates: [path.join(tmpDir, 'dist', 'daemon-bundle', 'index.js'), scriptPath],
    });
    expect(killed).toBe(true);
  }, 15_000);
});
