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
import * as os from 'node:os';
import type { ManagedSession } from '../DaemonSessionManager';
import { DaemonSessionManager } from '../DaemonSessionManager';
import type { PromptEvent } from '../PromptEventLog';
import { FACTORY_DEFAULT_SCOPES, __setPolicyProbeForTests } from '../../shared/pwshExecutionPolicy';

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

/**
 * Poll the session's raw output until `pattern` matches something written
 * after `baselineBytes`.
 *
 * The prompt body is rendered by the shell itself — it is not reported as a
 * PromptEvent — so verifying what the WRAPPED prompt observed means reading
 * the PTY stream rather than promptLog.
 */
function waitForOutputAfter(
  managed: ManagedSession,
  baselineBytes: number,
  pattern: RegExp,
  label: string,
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const fresh = managed.ringBuffer.readAll().subarray(baselineBytes).toString('utf8');
      const match = fresh.match(pattern);
      if (match) {
        resolve(match);
        return;
      }
      if (Date.now() > deadline) {
        reject(
          new Error(
            `timed out waiting for ${label} — tail after baseline: ${JSON.stringify(fresh.slice(-400))}`,
          ),
        );
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
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

  // Issue #1267. The wrapper delegates to $global:__wmux_prev_prompt, so
  // whatever $? that scriptblock observes is exactly what oh-my-posh or
  // Starship would observe. Installing a probe there exercises the real
  // contract through a real ConPTY — a substring assertion on PWSH_INIT can
  // prove the restore is present but not that it actually survives to the
  // delegation, which is the half that was broken.
  it('hands the real $? to the wrapped prompt', async () => {
    manager = new DaemonSessionManager();
    const id = `rt-pwsh-status-${Date.now()}`;
    manager.createSession({
      id,
      cmd: POWERSHELL,
      cwd: path.resolve(process.cwd()),
    });

    const managed = manager.getSession(id)!;

    // Stand in for the user's prompt engine. $q must be assigned as the
    // scriptblock's first statement — reading $? later would measure this
    // probe's own bookkeeping instead of the command that just ran.
    managed.ptyProcess.write('$global:__wmux_prev_prompt = { $q = $?; "WMUXPROBE[$q]" }\r');
    await waitForOutputAfter(managed, 0, /WMUXPROBE\[(?:True|False)\]/, 'the probe prompt to render');

    // A failing native command: the wrapped prompt must see $? = False.
    const beforeFailure = managed.ringBuffer.readAll().length;
    managed.ptyProcess.write(`& "${CMD_EXE}" /c exit 7\r`);
    const afterFailure = await waitForOutputAfter(
      managed,
      beforeFailure,
      /WMUXPROBE\[(True|False)\]/,
      'a prompt render after a failing command',
    );
    expect(afterFailure[1]).toBe('False');

    // ...and True again after one that succeeds, so a fix that simply pins
    // the status to False cannot pass.
    const beforeSuccess = managed.ringBuffer.readAll().length;
    managed.ptyProcess.write(`& "${CMD_EXE}" /c exit 0\r`);
    const afterSuccess = await waitForOutputAfter(
      managed,
      beforeSuccess,
      /WMUXPROBE\[(True|False)\]/,
      'a prompt render after a successful command',
    );
    expect(afterSuccess[1]).toBe('True');
  }, EVENT_TIMEOUT_MS + 2000);

  // Issue #1270. $LASTEXITCODE is set only by NATIVE commands and is never
  // cleared, so from the session's first native command onward it is non-null
  // for good — and the exit code was taken from it whenever it was. Every
  // failing cmdlet after that point reported 0, which is what
  // agent.lifecycle.exitCode was fed.
  it('reports a failing cmdlet after a native command as non-zero', async () => {
    manager = new DaemonSessionManager();
    const id = `rt-pwsh-cmdlet-fail-${Date.now()}`;
    manager.createSession({ id, cmd: POWERSHELL, cwd: path.resolve(process.cwd()) });

    const managed = manager.getSession(id)!;
    const baseline = managed.promptLog.size;

    // A native command first — this is what puts a number in $LASTEXITCODE
    // and arms the bug. Anchored on its own command_start: the startup prompt
    // render emits a D;0 of its own, and matching that instead would leave the
    // assertion below reading the wrong command's exit code.
    managed.ptyProcess.write(`& "${CMD_EXE}" /c exit 0\r`);
    const nativeStart = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_start',
      'command_start for the native command',
    );
    await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_end' && e.byteOffset >= nativeStart.byteOffset,
      'command_end for the native command',
    );

    const afterNative = managed.promptLog.size;
    managed.ptyProcess.write('Get-Item Q:\\nope-xyz\r');
    const cmdletStart = await waitForEventAfter(
      managed,
      afterNative,
      (e) => e.type === 'command_start',
      'command_start for the failing cmdlet',
    );
    const cmdEnd = await waitForEventAfter(
      managed,
      afterNative,
      (e) => e.type === 'command_end' && e.byteOffset >= cmdletStart.byteOffset,
      'command_end for the failing cmdlet',
    );
    expect(cmdEnd.exitCode).toBe(1);
  }, EVENT_TIMEOUT_MS + 2000);

  // The other direction, and the reason "$? first, always" is not the fix
  // either: $LASTEXITCODE is still 7 after a cmdlet that succeeded, so
  // reporting it would mark a successful command failed.
  it('reports a succeeding cmdlet after a failing native command as zero', async () => {
    manager = new DaemonSessionManager();
    const id = `rt-pwsh-cmdlet-ok-${Date.now()}`;
    manager.createSession({ id, cmd: POWERSHELL, cwd: path.resolve(process.cwd()) });

    const managed = manager.getSession(id)!;
    const baseline = managed.promptLog.size;

    managed.ptyProcess.write(`& "${CMD_EXE}" /c exit 7\r`);
    await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_end' && e.exitCode === 7,
      'command_end with exitCode 7',
    );

    const afterNative = managed.promptLog.size;
    managed.ptyProcess.write('Get-Location | Out-Null\r');
    const cmdletStart = await waitForEventAfter(
      managed,
      afterNative,
      (e) => e.type === 'command_start',
      'command_start for the succeeding cmdlet',
    );
    const cmdEnd = await waitForEventAfter(
      managed,
      afterNative,
      (e) => e.type === 'command_end' && e.byteOffset >= cmdletStart.byteOffset,
      'command_end for the succeeding cmdlet',
    );
    expect(cmdEnd.exitCode).toBe(0);
  }, EVENT_TIMEOUT_MS + 2000);
});

// Issue #1941. The integration reported the cwd only from the prompt, so on
// 'cd X; <program>' the session's tracked cwd stayed at the folder of the last
// prompt for as long as the program ran. A daemon that died in that window
// recovered the pane there (recovery replays meta.cwd).
describe.runIf(hasPowerShell)('mid-line cwd report — powershell.exe (#1941)', () => {
  let manager: DaemonSessionManager;
  let root: string;

  afterEach(() => {
    if (manager) manager.disposeAll();
    // The killed shell can hold its cwd open for a moment after disposeAll.
    try {
      if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch { /* a leftover temp folder is not a test failure */ }
  });

  function startPane(tag: string): { managed: ManagedSession; start: string; target: string } {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-1941-'));
    const start = path.join(root, 'start');
    // A space and a percent sign: the payload must survive the percent-decode.
    const target = path.join(root, 'proj one%20x');
    fs.mkdirSync(start);
    fs.mkdirSync(target);
    manager = new DaemonSessionManager();
    const id = `rt-pwsh-${tag}-${Date.now()}`;
    manager.createSession({ id, cmd: POWERSHELL, cwd: start });
    return { managed: manager.getSession(id)!, start, target };
  }

  // os.tmpdir() can be an 8.3 short path (C:\Users\RUNNER~1\...) while the
  // shell may report the long form, so compare the real paths.
  const real = (p: string): string => {
    try { return fs.realpathSync.native(p).toLowerCase(); } catch { return p.toLowerCase(); }
  };

  function waitForCwd(managed: ManagedSession, cwd: string, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + EVENT_TIMEOUT_MS;
      const tick = () => {
        if (real(managed.meta.cwd) === real(cwd)) return resolve();
        if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}; meta.cwd=${managed.meta.cwd}`));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  it('reports the new folder while the program on the same line still runs', async () => {
    const { managed, start, target } = startPane('cdline');
    await waitForCwd(managed, start, 'the first prompt to report the spawn folder');
    const baseline = managed.promptLog.size;

    // The program must still be running when the assertion is made: a prompt
    // after it would report the folder anyway, which is the old behaviour.
    managed.ptyProcess.write(`cd '${target}'; & "${CMD_EXE}" /c "ping -n 8 127.0.0.1 > nul"\r`);
    const cmdStart = await waitForEventAfter(managed, baseline, (e) => e.type === 'command_start', 'command_start');
    await waitForCwd(managed, target, 'the mid-line report of the cd target');
    const ended = managed.promptLog.snapshot().slice(baseline)
      .some((e) => e.type === 'command_end' && e.byteOffset >= cmdStart.byteOffset);
    expect(ended).toBe(false);
  }, EVENT_TIMEOUT_MS * 2 + 2000);

  it('disarms on a program launch and inside a function, and keeps a user action', async () => {
    const { managed, start } = startPane('arm');
    await waitForCwd(managed, start, 'the first prompt');
    const probe = (line: string, label: string) => {
      const before = managed.ringBuffer.readAll().length;
      managed.ptyProcess.write(line);
      return waitForOutputAfter(managed, before, /ARMED\[(\w+)\]/, label);
    };
    const armed = 'Write-Output "ARMED[$($ExecutionContext.InvokeCommand.PostCommandLookupAction -eq $global:__wmux_lookup)]"';

    // Cmdlets typed on the line keep it armed until the line ends...
    expect((await probe(`${armed}\r`, 'armed during a line'))[1]).toBe('True');
    // ...a program launch disarms it...
    expect((await probe(`& "${CMD_EXE}" /c rem; ${armed}\r`, 'after a program'))[1]).toBe('False');
    // ...and so does the first lookup inside a function body, so a
    // command-heavy function does not pay for the hook on every call.
    expect((await probe(`function F { Get-Date > $null }; F; ${armed}\r`, 'after a function'))[1]).toBe('False');

    // An action the user installed is chained while ours is armed and is the
    // one left in place afterwards.
    managed.ptyProcess.write('$global:userAction = { $global:userHits++ }; $ExecutionContext.InvokeCommand.PostCommandLookupAction = $global:userAction\r');
    const kept = 'Write-Output "ARMED[$(($ExecutionContext.InvokeCommand.PostCommandLookupAction -eq $global:userAction) -and $global:userHits -gt 0)]"';
    expect((await probe(`& "${CMD_EXE}" /c rem; ${kept}\r`, 'the user action after ours disarmed'))[1]).toBe('True');

    // ...and it keeps running while ours is armed. The property hands back a
    // delegate, which '&' cannot invoke, so the chained call failed silently
    // and the user's action missed every lookup of the armed window.
    const chained = '$h = $global:userHits; Get-Date > $null; Get-Date > $null; Write-Output "ARMED[$($global:userHits - $h -ge 2)]"';
    expect((await probe(`${chained}\r`, 'the user action while ours is armed'))[1]).toBe('True');
  }, EVENT_TIMEOUT_MS * 5 + 2000);

  // A user action that runs commands of its own: those lookups land in our
  // action while it is armed and must be absorbed there, not chained into the
  // user's action again. The counter bounds the user's own recursion once ours
  // has disarmed (PowerShell itself does not guard a lookup action).
  it('runs a chained user action once per lookup when it makes lookups itself', async () => {
    const { managed, start } = startPane('reentry');
    await waitForCwd(managed, start, 'the first prompt');
    managed.ptyProcess.write('$ExecutionContext.InvokeCommand.PostCommandLookupAction = { $global:userHits++; if ($global:userHits -lt 50) { Get-Date > $null; Get-Date > $null } }\r');
    // Two lookups between the reset and the snapshot: the two Get-Date calls.
    managed.ptyProcess.write('$global:userHits = 0; Get-Date > $null; Get-Date > $null; $global:snap = $global:userHits\r');
    const before = managed.ringBuffer.readAll().length;
    managed.ptyProcess.write('Write-Output "HITS[$global:snap]"\r');
    const hits = await waitForOutputAfter(managed, before, /HITS\[(\d+)\]/, 'the user action hit count');
    expect(hits[1]).toBe('2');
  }, EVENT_TIMEOUT_MS * 2 + 2000);

  // A for/foreach loop typed at the prompt makes top-level lookups, so nothing
  // in its body disarmed the hook and the loop paid for it on every command.
  // The hook now disarms after 64 lookups on one line. A cd before that is
  // still reported at once; a cd after it waits for the next prompt.
  it('disarms after 64 lookups on one line and reports a later cd at the prompt', async () => {
    const { managed, start, target } = startPane('cap');
    await waitForCwd(managed, start, 'the first prompt');
    const probe = (line: string, label: string) => {
      const before = managed.ringBuffer.readAll().length;
      managed.ptyProcess.write(line);
      return waitForOutputAfter(managed, before, /CAP\[(\w+)\]/, label);
    };
    const isOurs = '$($ExecutionContext.InvokeCommand.PostCommandLookupAction -eq $global:__wmux_lookup)';

    // Below the cap the hook stays armed for the whole line...
    expect((await probe(`for ($i = 0; $i -lt 20; $i++) { Get-Date > $null }; Write-Output "CAP[${isOurs}]"\r`, 'armed below the cap'))[1]).toBe('True');
    // ...and the cap disarms it inside a long loop typed at the prompt.
    expect((await probe(`for ($i = 0; $i -lt 200; $i++) { Get-Date > $null }; Write-Output "CAP[${isOurs}]"\r`, 'disarmed by the cap'))[1]).toBe('False');

    // The line's status survives the cap: the prompt reports the failure.
    const baseline = managed.promptLog.size;
    managed.ptyProcess.write("for ($i = 0; $i -lt 200; $i++) { Get-Date > $null }; throw 'wmux-cap'\r");
    const cmdStart = await waitForEventAfter(managed, baseline, (e) => e.type === 'command_start', 'command_start');
    const cmdEnd = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_end' && e.byteOffset >= cmdStart.byteOffset,
      'command_end after the cap',
    );
    expect(cmdEnd.exitCode).toBe(1);

    // A user action set before the line ran on every lookup, armed or not, and
    // is the one left in place when the cap disarms ours.
    managed.ptyProcess.write('$global:userAction = { $global:userHits++ }; $ExecutionContext.InvokeCommand.PostCommandLookupAction = $global:userAction\r');
    const restored = `$global:userHits = 0; for ($i = 0; $i -lt 200; $i++) { Get-Date > $null }; $h = $global:userHits; Get-Date > $null; Write-Output "CAP[$(($ExecutionContext.InvokeCommand.PostCommandLookupAction -eq $global:userAction) -and $global:userHits -gt $h -and $h -ge 200)]"\r`;
    expect((await probe(restored, 'the user action after the cap'))[1]).toBe('True');

    // A cd after the cap, then a program that is still running: meta.cwd
    // stays put until the prompt after the program reports the new folder.
    const base1 = managed.promptLog.size;
    managed.ptyProcess.write('$ExecutionContext.InvokeCommand.PostCommandLookupAction = $null\r');
    const end1 = await waitForEventAfter(managed, base1, (e) => e.type === 'command_end', 'command_end of the reset');
    await waitForEventAfter(managed, base1, (e) => e.type === 'prompt_end' && e.byteOffset >= end1.byteOffset, 'the prompt after the reset');
    const base2 = managed.promptLog.size;
    managed.ptyProcess.write(`for ($i = 0; $i -lt 200; $i++) { Get-Date > $null }; cd '${target}'; & "${CMD_EXE}" /c "ping -n 8 127.0.0.1 > nul"\r`);
    const start2 = await waitForEventAfter(managed, base2, (e) => e.type === 'command_start', 'command_start of the capped line');
    // ping -n 8 runs about 7 s; the loop itself well under 1 s.
    await new Promise((r) => setTimeout(r, 2000));
    const running = !managed.promptLog.snapshot().slice(base2)
      .some((e) => e.type === 'command_end' && e.byteOffset >= start2.byteOffset);
    expect(running).toBe(true);
    expect(real(managed.meta.cwd)).toBe(real(start));
    await waitForEventAfter(managed, base2, (e) => e.type === 'command_end' && e.byteOffset >= start2.byteOffset, 'command_end of the capped line');
    await waitForCwd(managed, target, 'the prompt report after the capped line');
  }, EVENT_TIMEOUT_MS * 8 + 2000);

  // The action runs statements, and every statement sets $? to true. After a
  // terminating error the host looks up Out-Default and prompt with the action
  // still armed, so the prompt read $? = true and reported D;0.
  it('reports a line that ends in a terminating error as failed', async () => {
    const { managed, start } = startPane('status');
    await waitForCwd(managed, start, 'the first prompt');
    const baseline = managed.promptLog.size;
    managed.ptyProcess.write("throw 'wmux-1942'\r");
    const cmdStart = await waitForEventAfter(managed, baseline, (e) => e.type === 'command_start', 'command_start');
    const cmdEnd = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_end' && e.byteOffset >= cmdStart.byteOffset,
      'command_end for the throw',
    );
    expect(cmdEnd.exitCode).toBe(1);

    // The status is re-created without an extra record in $Error: the user's
    // own error stays $Error[0].
    const before = managed.ringBuffer.readAll().length;
    managed.ptyProcess.write('$Error.Clear(); Get-Item Q:\\nope-1942 2>$null; Get-Date > $null; Write-Output "ERRS[$($Error.Count)]"\r');
    const errs = await waitForOutputAfter(managed, before, /ERRS\[(\d+)\]/, 'the $Error count');
    expect(errs[1]).toBe('1');
  }, EVENT_TIMEOUT_MS * 3 + 2000);
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

// #1620: a Windows client that never set an execution policy runs Restricted,
// and a Restricted powershell.exe refuses to load ANY .ps1 — wmux's own init,
// and the npm .ps1 shim an agent like `codex` resolves to. CI runners ship a
// permissive machine policy, so the Restricted default is reproduced per pane
// with the Process-scope env var PSExecutionPolicyPreference. The probe is
// pinned so the host's real registry cannot decide the outcome.
describe.runIf(hasPowerShell)('execution policy on a factory-default machine — powershell.exe (#1620)', () => {
  // createSession's env REPLACES the child environment (powershell.exe cannot
  // even load without SystemRoot), so overlay onto the real one. Windows env
  // names are case-insensitive but a spread copy is not: an inherited
  // PSEXECUTIONPOLICYPREFERENCE=Bypass (a parent started with -ExecutionPolicy
  // Bypass, e.g. an AI coding agent's shell) would survive next to ours and
  // win, so the controls time out and the fix cases pass vacuously. Drop every
  // case variant before overlaying.
  const RESTRICTED_ENV: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => e[1] !== undefined && e[0].toLowerCase() !== 'psexecutionpolicypreference',
      ),
    ),
    PSExecutionPolicyPreference: 'Restricted',
  };
  const BLOCKED = /UnauthorizedAccess/;
  let manager: DaemonSessionManager;
  let tmp: string | undefined;

  afterEach(() => {
    if (manager) manager.disposeAll();
    __setPolicyProbeForTests(null);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  // Native PowerShell/PSReadLine startup occasionally stalls before the policy error.
  // Retry this live-OS control once in the runtime lane, keeping its assertions.
  it('control: with no policy arg, Restricted blocks the init script and no markers arrive', { retry: 1, timeout: EVENT_TIMEOUT_MS * 2 + 2000 }, async () => {
    __setPolicyProbeForTests({ scopes: { ...FACTORY_DEFAULT_SCOPES, currentUser: 'set' }, platform: 'win32' });
    manager = new DaemonSessionManager();
    const id = `rt-policy-control-${Date.now()}`;
    manager.createSession({ id, cmd: POWERSHELL, cwd: path.resolve(process.cwd()), env: RESTRICTED_ENV });
    const managed = manager.getSession(id)!;

    // Proves the env var reached the pane AND that this setup reproduces the bug.
    await waitForOutputAfter(managed, 0, BLOCKED, 'the Restricted policy error');

    managed.ptyProcess.write('echo wmux-policy-control\r');
    await waitForOutputAfter(managed, 0, /wmux-policy-control[\s\S]*wmux-policy-control/, 'echo output');
    expect(managed.promptLog.size).toBe(0);
  });

  it('fix: RemoteSigned lets the init script load, so OSC 133 command markers arrive', async () => {
    __setPolicyProbeForTests({ scopes: FACTORY_DEFAULT_SCOPES, platform: 'win32' });
    manager = new DaemonSessionManager();
    const id = `rt-policy-fix-${Date.now()}`;
    manager.createSession({ id, cmd: POWERSHELL, cwd: path.resolve(process.cwd()), env: RESTRICTED_ENV });
    const managed = manager.getSession(id)!;
    const baseline = managed.promptLog.size;

    managed.ptyProcess.write('echo wmux-policy-fix\r');
    const cmdStart = await waitForEventAfter(managed, baseline, (e) => e.type === 'command_start', 'command_start');
    const cmdEnd = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_end' && e.byteOffset >= cmdStart.byteOffset,
      'command_end after command_start',
    );
    expect(cmdEnd.exitCode).toBe(0);
    expect(managed.ringBuffer.readAll().toString('utf8')).not.toMatch(BLOCKED);
  }, EVENT_TIMEOUT_MS * 2 + 2000);

  // Stand-in for an npm agent shim (codex.ps1) that PowerShell prefers over
  // the .cmd: any .ps1 run by an exec unit hits the same policy gate.
  function writeProbeScript(): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-policy-'));
    const script = path.join(tmp, 'wmuxprobe.ps1');
    fs.writeFileSync(script, "Write-Output 'wmux-ps1-ran'\n");
    return script;
  }

  it('exec unit control: Restricted blocks a .ps1 agent shim', async () => {
    __setPolicyProbeForTests({ scopes: { ...FACTORY_DEFAULT_SCOPES, currentUser: 'set' }, platform: 'win32' });
    const script = writeProbeScript();
    manager = new DaemonSessionManager();
    const id = `rt-policy-exec-control-${Date.now()}`;
    manager.createSession({
      id, cmd: POWERSHELL, cwd: path.resolve(process.cwd()), env: RESTRICTED_ENV,
      exec: { command: `& '${script.replace(/'/g, "''")}'` },
    });
    const managed = manager.getSession(id)!;
    await waitForOutputAfter(managed, 0, BLOCKED, 'the Restricted policy error');
    expect(managed.ringBuffer.readAll().toString('utf8')).not.toContain('wmux-ps1-ran');
  }, EVENT_TIMEOUT_MS + 2000);

  it('exec unit fix: RemoteSigned lets the .ps1 agent shim run', async () => {
    __setPolicyProbeForTests({ scopes: FACTORY_DEFAULT_SCOPES, platform: 'win32' });
    const script = writeProbeScript();
    manager = new DaemonSessionManager();
    const id = `rt-policy-exec-fix-${Date.now()}`;
    manager.createSession({
      id, cmd: POWERSHELL, cwd: path.resolve(process.cwd()), env: RESTRICTED_ENV,
      exec: { command: `& '${script.replace(/'/g, "''")}'` },
    });
    const managed = manager.getSession(id)!;
    await waitForOutputAfter(managed, 0, /wmux-ps1-ran/, 'the script output');
    expect(managed.ringBuffer.readAll().toString('utf8')).not.toMatch(BLOCKED);
  }, EVENT_TIMEOUT_MS + 2000);
});
