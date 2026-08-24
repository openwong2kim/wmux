import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { killVerifiedDaemonPid } from '../daemonLauncherCore';

/**
 * CodeRabbit finding on #1019 (critical): the pre-#1001 image-name check
 * assumed a genuine wmux daemon always shares THIS process's own
 * `process.execPath` basename — true when only Electron could spawn one.
 * Since #1001 a daemon may be spawned by a different host (Electron vs the
 * headless `wmux daemon` CLI, each with a different execPath), so a
 * mismatch must no longer be read as "not our daemon" — only the
 * command-line marker check is host-independent.
 *
 * This reproduces a genuine cross-host mismatch portably: copy this test
 * runner's own node binary to a DIFFERENTLY NAMED file and spawn the real
 * daemon-marker process through that copy. The OS-reported image name for
 * the child is then the renamed file, never equal to this test process's
 * own `path.basename(process.execPath)` — exactly the shape of "a daemon
 * some other host spawned."
 */
describe('killVerifiedDaemonPid — cross-host image mismatch (#1019)', () => {
  let tmpDir: string;
  let child: ChildProcess | null = null;

  afterEach(async () => {
    if (child && child.pid && child.exitCode === null) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      await new Promise<void>((resolve) => {
        if (!child) return resolve();
        child.once('exit', () => resolve());
        setTimeout(resolve, 2000); // don't hang the suite if 'exit' never fires
      });
    }
    // Windows can hold the renamed binary's file lock for a beat after the
    // process exits — retry the cleanup instead of failing the whole run
    // on what is filesystem timing, not a test failure.
    if (tmpDir) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    }
  });

  it('still verifies and kills a live process whose image differs from this host\'s own execPath, via the cmdline marker', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-crosshost-'));
    const renamedNodeName = process.platform === 'win32' ? 'other-host-node.exe' : 'other-host-node';
    const renamedNodePath = path.join(tmpDir, renamedNodeName);
    fs.copyFileSync(process.execPath, renamedNodePath);
    if (process.platform !== 'win32') fs.chmodSync(renamedNodePath, 0o755);

    // The command line must carry a daemon-script marker for the cmdline
    // check to accept it — 'daemon-bundle' is one of the markers this
    // module looks for verbatim.
    const scriptPath = path.join(tmpDir, 'daemon-bundle-fake-index.js');
    fs.writeFileSync(scriptPath, 'setTimeout(() => {}, 30000);\n');

    child = spawn(renamedNodePath, [scriptPath], { stdio: 'ignore' });
    const pid = child.pid;
    expect(pid).toBeTruthy();
    // Give the OS a moment to register the process before probing it —
    // tasklist/ps can race a just-spawned PID on a loaded CI box.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // This test process's own image is `node`/`node.exe` (unrenamed) — the
    // spawned child's image is the renamed copy, so this IS the mismatch
    // the fix must tolerate.
    const killed = killVerifiedDaemonPid(pid as number, { definitiveOnly: true });
    expect(killed).toBe(true);
  }, 15_000);

  it('still refuses an unrelated process even when definitiveOnly is false, via the cmdline marker mismatch', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-crosshost-unrelated-'));
    const renamedNodeName = process.platform === 'win32' ? 'other-host-node.exe' : 'other-host-node';
    const renamedNodePath = path.join(tmpDir, renamedNodeName);
    fs.copyFileSync(process.execPath, renamedNodePath);
    if (process.platform !== 'win32') fs.chmodSync(renamedNodePath, 0o755);

    // No daemon-script marker in this command line — an unrelated process
    // that merely happens to reuse a renamed node binary must still be
    // refused, proving the relaxed image check didn't also relax the
    // cmdline gate.
    const scriptPath = path.join(tmpDir, 'totally-unrelated-script.js');
    fs.writeFileSync(scriptPath, 'setTimeout(() => {}, 30000);\n');

    child = spawn(renamedNodePath, [scriptPath], { stdio: 'ignore' });
    const pid = child.pid;
    expect(pid).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const killed = killVerifiedDaemonPid(pid as number, { definitiveOnly: false });
    expect(killed).toBe(false);
  }, 15_000);
});
