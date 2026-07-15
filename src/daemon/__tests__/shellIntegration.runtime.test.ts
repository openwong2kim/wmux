/**
 * Runtime integration tests for OSC 133 shell integration.
 *
 * Unlike DaemonSessionManager.test.ts (which mocks node-pty), this suite
 * spawns real ConPTY / Git Bash processes to verify the end-to-end flow:
 *
 *   shell init → OSC 133 markers → OscParser → PromptEventLog
 *
 * Skipped when the shell is unavailable so the suite degrades cleanly on
 * Linux CI runners where only one of pwsh/bash exists.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ManagedSession } from '../DaemonSessionManager';
import { DaemonSessionManager } from '../DaemonSessionManager';
import type { PromptEvent } from '../PromptEventLog';

const SYS = process.env.SystemRoot || 'C:\\Windows';
const PF = process.env.ProgramFiles || 'C:\\Program Files';

const POWERSHELL = `${SYS}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const CMD_EXE = `${SYS}\\System32\\cmd.exe`;
const GIT_BASH = `${PF}\\Git\\bin\\bash.exe`;

const hasPowerShell = process.platform === 'win32' && fs.existsSync(POWERSHELL);
const hasGitBash = process.platform === 'win32' && fs.existsSync(GIT_BASH);

// Allow ConPTY boot + prompt render + command echo round trip. Generous
// because a loaded GitHub Windows runner can be slow to cold-start
// powershell.exe and flush its first OSC 133 markers — at 8s this test
// intermittently timed out with "captured after baseline: []" (nothing
// emitted yet), a pure runner-speed flake, not a real regression. The happy
// path still resolves the instant the event arrives, so the higher ceiling
// only costs wall-clock on genuine failures.
const EVENT_TIMEOUT_MS = 30000;

/**
 * Wait for a PromptEvent that was recorded AFTER `baselineLength` events.
 * Using the baseline avoids matching stale initial markers (e.g. the D;0
 * from a fresh prompt render before the test's command was even issued).
 */
function waitForEventAfter(
  managed: ManagedSession,
  baselineLength: number,
  predicate: (e: PromptEvent) => boolean,
  label: string,
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<PromptEvent> {
  // Check already-captured events past the baseline first.
  const snap = managed.promptLog.snapshot();
  const existing = snap.slice(baselineLength).find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      managed.bridge.off('prompt', onPrompt);
      const captured = managed.promptLog
        .snapshot()
        .slice(baselineLength)
        .map((e) => `${e.type}${e.exitCode !== undefined ? `(${e.exitCode})` : ''}`)
        .join(',');
      reject(
        new Error(
          `timed out waiting for ${label} — captured after baseline: [${captured}]`,
        ),
      );
    }, timeoutMs);

    const onPrompt = (payload: { sessionId: string; event: PromptEvent }) => {
      if (predicate(payload.event)) {
        clearTimeout(timer);
        managed.bridge.off('prompt', onPrompt);
        resolve(payload.event);
      }
    };
    managed.bridge.on('prompt', onPrompt);
  });
}

describe.runIf(hasPowerShell)('OSC 133 runtime — powershell.exe', () => {
  let manager: DaemonSessionManager;

  afterEach(() => {
    if (manager) manager.disposeAll();
  });

  it('captures command_start / command_end with exitCode 0 when echo is run', async () => {
    manager = new DaemonSessionManager();
    const id = `rt-pwsh-${Date.now()}`;
    manager.createSession({
      id,
      cmd: POWERSHELL,
      cwd: path.resolve(process.cwd()),
    });

    const managed = manager.getSession(id)!;
    const baseline = managed.promptLog.size;

    // PowerShell 5.1 with -NoExit + PSReadLine renders its first prompt
    // lazily — waiting for an initial marker would hang. Writing directly
    // is fine: the init script has already defined prompt + registered
    // the PSReadLine Enter hook before the REPL loop starts.
    managed.ptyProcess.write('echo wmux-osc-probe\r');

    const cmdStart = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_start',
      'command_start',
    );
    expect(cmdStart.byteOffset).toBeGreaterThan(0);

    const cmdEnd = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_end' && e.byteOffset >= cmdStart.byteOffset,
      'command_end after command_start',
    );
    expect(cmdEnd.exitCode).toBe(0);
    expect(cmdEnd.byteOffset).toBeGreaterThanOrEqual(cmdStart.byteOffset);

    const range = managed.promptLog.lastCompletedCommandRange();
    expect(range).not.toBeNull();
    expect(range!.exitCode).toBe(0);
    expect(range!.endOffset).toBeGreaterThanOrEqual(range!.startOffset);
  }, EVENT_TIMEOUT_MS + 2000);

  it('records a non-zero exit code when the command fails', async () => {
    manager = new DaemonSessionManager();
    const id = `rt-pwsh-fail-${Date.now()}`;
    manager.createSession({
      id,
      cmd: POWERSHELL,
      cwd: path.resolve(process.cwd()),
    });

    const managed = manager.getSession(id)!;
    const baseline = managed.promptLog.size;

    // Use the absolute path to cmd.exe — ConPTY's child doesn't always
    // inherit a PATH that includes System32 on every machine. `& "..."`
    // invokes it as an external command, so $LASTEXITCODE picks up the
    // exit status directly.
    managed.ptyProcess.write(`& "${CMD_EXE}" /c exit 7\r`);

    const cmdStart = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_start',
      'command_start',
    );
    const cmdEnd = await waitForEventAfter(
      managed,
      baseline,
      (e) =>
        e.type === 'command_end' &&
        e.byteOffset >= cmdStart.byteOffset &&
        e.exitCode !== undefined &&
        e.exitCode !== 0,
      'command_end with non-zero exitCode',
    );
    expect(cmdEnd.exitCode).toBe(7);
  }, EVENT_TIMEOUT_MS + 2000);
});

describe.runIf(hasGitBash)('OSC 133 runtime — bash.exe (Git Bash)', () => {
  let manager: DaemonSessionManager;

  afterEach(() => {
    if (manager) manager.disposeAll();
  });

  it('emits initial prompt markers on shell startup', async () => {
    manager = new DaemonSessionManager();
    const id = `rt-bash-${Date.now()}`;
    manager.createSession({
      id,
      cmd: GIT_BASH,
      cwd: path.resolve(process.cwd()),
    });

    const managed = manager.getSession(id)!;

    // Bash's PROMPT_COMMAND fires when the initial prompt is rendered —
    // no user interaction required, so we can wait straight away.
    const promptStart = await waitForEventAfter(
      managed,
      0,
      (e) => e.type === 'prompt_start',
      'prompt_start',
    );
    expect(promptStart.byteOffset).toBeGreaterThanOrEqual(0);
  }, EVENT_TIMEOUT_MS + 2000);

  it('captures command_start / command_end with exitCode 0 when echo runs', async () => {
    manager = new DaemonSessionManager();
    const id = `rt-bash-exec-${Date.now()}`;
    manager.createSession({
      id,
      cmd: GIT_BASH,
      cwd: path.resolve(process.cwd()),
    });

    const managed = manager.getSession(id)!;
    await waitForEventAfter(managed, 0, (e) => e.type === 'prompt_end', 'initial prompt_end');

    const baseline = managed.promptLog.size;
    managed.ptyProcess.write('echo wmux-osc-probe\r');

    const cmdStart = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_start',
      'command_start',
    );
    const cmdEnd = await waitForEventAfter(
      managed,
      baseline,
      (e) =>
        e.type === 'command_end' &&
        e.byteOffset >= cmdStart.byteOffset &&
        e.exitCode === 0,
      'command_end with exitCode 0',
    );
    expect(cmdEnd.byteOffset).toBeGreaterThanOrEqual(cmdStart.byteOffset);

    const range = managed.promptLog.lastCompletedCommandRange();
    expect(range).not.toBeNull();
    expect(range!.exitCode).toBe(0);
  }, EVENT_TIMEOUT_MS + 2000);

  it('records non-zero exit code from a failing command', async () => {
    manager = new DaemonSessionManager();
    const id = `rt-bash-fail-${Date.now()}`;
    manager.createSession({
      id,
      cmd: GIT_BASH,
      cwd: path.resolve(process.cwd()),
    });

    const managed = manager.getSession(id)!;
    await waitForEventAfter(managed, 0, (e) => e.type === 'prompt_end', 'initial prompt_end');

    const baseline = managed.promptLog.size;
    managed.ptyProcess.write('false\r');

    const cmdStart = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_start',
      'command_start',
    );
    const cmdEnd = await waitForEventAfter(
      managed,
      baseline,
      (e) =>
        e.type === 'command_end' &&
        e.byteOffset >= cmdStart.byteOffset &&
        e.exitCode !== undefined &&
        e.exitCode !== 0,
      'command_end with non-zero exitCode',
    );
    expect(cmdEnd.exitCode).toBe(1);
  }, EVENT_TIMEOUT_MS + 2000);
});
