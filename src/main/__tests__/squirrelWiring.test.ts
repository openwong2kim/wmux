import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SQUIRREL_INSTALLER_EVENTS } from '../squirrel';

// Source-level WIRING invariants for the Squirrel firstrun zombie fix.
//
// The original zombie was a *wiring* bug in index.ts, not a logic bug in the
// predicate: a bare `startsWith('--squirrel-')` guard set isSquirrelEvent=true
// for '--squirrel-firstrun', matched none of the install/updated/uninstall/
// obsolete handlers (so never quit), and then `if (!isSquirrelEvent) appInit()`
// skipped init — an invisible, never-quitting main process that lazily spawned
// its own gpu-process + network utility (duplicate GPU -> UI stutter).
//
// squirrel.test.ts proves the PREDICATE is correct, but a green predicate test
// would NOT catch a regression where index.ts stops calling it, reverts to
// startsWith, or moves the single-instance lock below subprocess construction.
// These invariants pin the wiring. index.ts can't be imported (it runs appInit()
// at module load), so we assert over its source text — the repo's established
// source-invariant pattern (see beforeQuitDisconnectRace.test.ts).

describe('Squirrel firstrun fix — index.ts wiring invariants', () => {
  const indexPath = path.join(__dirname, '..', 'index.ts');
  const indexSrc = fs.readFileSync(indexPath, 'utf-8');

  it('classifies the Squirrel arg via isSquirrelInstallerEvent, not a bare startsWith', () => {
    // The predicate must be the gate that sets isSquirrelEvent.
    expect(indexSrc).toMatch(/if\s*\(\s*isSquirrelInstallerEvent\(\s*squirrelCmd\s*\)\s*\)\s*\{/);
    // Regression lock: the exact original shape — a startsWith('--squirrel-')
    // guard that swallows firstrun by setting the flag — must not come back.
    const startsWithSwallowsFirstrun =
      /startsWith\(\s*['"]--squirrel-['"]\s*\)\s*\)\s*\{\s*isSquirrelEvent\s*=\s*true/;
    expect(indexSrc).not.toMatch(startsWithSwallowsFirstrun);
  });

  it('gates appInit() on !isSquirrelEvent so firstrun (predicate=false) falls through', () => {
    expect(indexSrc).toMatch(/if\s*\(\s*!isSquirrelEvent\s*\)\s*\{\s*appInit\(\)/);
  });

  it('takes the single-instance lock BEFORE registering the ready handler (the real GPU gate)', () => {
    // The duplicate gpu-process + network.mojom utility (the actual reported
    // symptom) spawn from Chromium's runtime gated on app.on('ready') / window
    // creation — NOT from PTYManager/PipeServer. So the invariant that actually
    // prevents the zombie's subprocesses is: the lock loser returns before the
    // ready handler is even registered. Pin that ordering directly.
    const lockPos = indexSrc.indexOf('app.requestSingleInstanceLock()');
    const readyPos = indexSrc.indexOf("app.on('ready'");
    expect(lockPos).toBeGreaterThan(0);
    expect(readyPos).toBeGreaterThan(lockPos);
  });

  it('takes the single-instance lock BEFORE constructing any subprocess/IPC owner', () => {
    // Secondary: PTYManager / PipeServer (pipe + pty-host children) must also
    // come after the lock so the loser leaks none of them either.
    const lockPos = indexSrc.indexOf('app.requestSingleInstanceLock()');
    const ptyPos = indexSrc.indexOf('new PTYManager(');
    const pipePos = indexSrc.indexOf('new PipeServer(');
    expect(ptyPos).toBeGreaterThan(lockPos);
    expect(pipePos).toBeGreaterThan(lockPos);
  });

  it('calls appInit() exactly once (no unconditional or duplicate init)', () => {
    // The !isSquirrelEvent gate is worthless if a second, ungated appInit() call
    // exists. Pin the call-site count (the `function appInit()` declaration is
    // `appInit(): void` and does not match the `appInit();` call form).
    const callSites = indexSrc.match(/appInit\(\);/g) || [];
    expect(callSites.length).toBe(1);
  });

  it('the lock loser quits and returns before any heavy init', () => {
    // !gotLock -> app.quit(); return — the early-out that prevents the zombie.
    const start = indexSrc.indexOf('const gotLock');
    expect(start).toBeGreaterThan(0);
    const guard = indexSrc.slice(start, start + 400);
    expect(guard).toMatch(/if\s*\(\s*!gotLock\s*\)\s*\{[\s\S]*app\.quit\(\)[\s\S]*return/);
  });

  it('does not list --squirrel-firstrun as an installer event', () => {
    expect([...SQUIRREL_INSTALLER_EVENTS]).not.toContain('--squirrel-firstrun');
  });

  // #502 — installer-time takeover of a running instance. Same rationale as
  // the invariants above: the behavior lives in index.ts's module-load-time
  // squirrel branch, which cannot be imported in tests, so pin the wiring at
  // source level. The kill semantics themselves are unit-tested in
  // squirrelTeardown.test.ts.
  it('#502: terminates running app instances inside the squirrel branch, before any Update.exe work', () => {
    const gatePos = indexSrc.indexOf('if (isSquirrelInstallerEvent(squirrelCmd))');
    const killPos = indexSrc.indexOf('terminateRunningAppInstances()');
    const shortcutPos = indexSrc.indexOf("'--createShortcut'");
    expect(gatePos).toBeGreaterThan(0);
    // The kill runs inside the installer-event branch (after the gate)…
    expect(killPos).toBeGreaterThan(gatePos);
    // …and BEFORE the first Update.exe shortcut spawn, so old-version locks
    // are released before Squirrel's remaining install work touches them.
    expect(shortcutPos).toBeGreaterThan(killPos);
  });

  it('#502: --squirrel-obsolete never runs the takeover (the newer version\'s hook owns it)', () => {
    // The kill is gated on `squirrelCmd !== '--squirrel-obsolete'` — obsolete
    // fires on the version being superseded mid-update, and killing from
    // there would race the newer version's own hook.
    expect(indexSrc).toMatch(/if\s*\(\s*squirrelCmd\s*!==\s*'--squirrel-obsolete'\s*\)\s*\{[\s\S]{0,600}?terminateRunningAppInstances\(\)/);
  });

  it('#502: the --squirrel-updated branch relaunches the app after its shortcut work', () => {
    const updatedPos = indexSrc.indexOf("squirrelCmd === '--squirrel-updated'");
    const uninstallPos = indexSrc.indexOf("squirrelCmd === '--squirrel-uninstall'");
    expect(updatedPos).toBeGreaterThan(0);
    expect(uninstallPos).toBeGreaterThan(updatedPos);
    const updatedBranch = indexSrc.slice(updatedPos, uninstallPos);
    // Same relaunch shape the --squirrel-install branch uses; the
    // single-instance lock dedupes any double-launch.
    expect(updatedBranch).toMatch(
      /spawn\(process\.execPath, \[\], \{ detached: true, stdio: 'ignore', windowsHide: true \}\)\.unref\(\)/,
    );
  });

  it('the predicate classifies by exact membership, never a startsWith prefix', () => {
    // The most realistic regression is moving the logic into squirrel.ts and
    // using `startsWith('--squirrel-')` there — which would re-swallow firstrun.
    // The index.ts source lock can't see that (wrong file), so pin squirrel.ts
    // directly: exact-match membership, no prefix matching. (squirrel.test.ts
    // already catches this behaviourally; this is the cheap source-level twin.)
    const squirrelSrc = fs.readFileSync(path.join(__dirname, '..', 'squirrel.ts'), 'utf-8');
    expect(squirrelSrc).toMatch(/\.includes\(\s*argv1\s*\)/);
    expect(squirrelSrc).not.toMatch(/startsWith/);
  });
});
