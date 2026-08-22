// End-to-end run of the #863 shortcut-hygiene pass against REAL .lnk files in
// a temp sandbox: real powershell.exe, real WScript.Shell COM, real property
// stores. This is the evidence the unit tests cannot give — that a dead
// versioned link is retargeted to the stub with the icon pinned to app.ico,
// that the legacy Start Menu link is deduped rather than retargeted, that
// foreign shortcuts are untouched, and that Save() preserves the link's
// AppUserModelID (the property Windows resolves the taskbar icon through).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  runShortcutRepairPass,
  stageRootIcon,
  type RepairLocations,
  type ShortcutRepairAction,
} from '../shortcutHygiene';

const onWindows = process.platform === 'win32';

// Every test here spawns real powershell.exe and drives real COM, and one of
// them compiles C# through Add-Type. On this developer machine that test runs
// in ~1.7 s, so the 5 s default looked fine — on a cold CI runner the csc
// invocation alone blew past it and turned main red after the change had
// already merged green. The work is IO-bound and machine-dependent, so it gets
// a ceiling that reflects the slowest realistic runner rather than the fastest
// laptop. A genuine hang still fails, just later.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

function ps(script: string): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return execFileSync(
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf-8', timeout: 30_000, windowsHide: true },
  );
}

/** Single-quoted PS literal with the apostrophe doubled — same rule the module
 *  under test uses, and required for the O'Connor sandbox below. */
function q(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

function makeLnk(lnkPath: string, target: string): void {
  ps([
    `$sh = New-Object -ComObject WScript.Shell`,
    `$l = $sh.CreateShortcut(${q(lnkPath)})`,
    `$l.TargetPath = ${q(target)}`,
    `$l.Save()`,
  ].join('\n'));
  // Save() is synchronous, but this suite's whole job is to catch the cases
  // where the shell layer disagrees with the filesystem. If the link is not
  // there, say THAT rather than letting the pass report "nothing to repair"
  // three lines later (#962).
  if (!fs.existsSync(lnkPath)) throw new Error(`.lnk was not written: ${lnkPath}`);
}

function readLnk(lnkPath: string): { target: string; icon: string; workdir: string } {
  const out = ps([
    `$sh = New-Object -ComObject WScript.Shell`,
    `$l = $sh.CreateShortcut(${q(lnkPath)})`,
    `@{ target = $l.TargetPath; icon = $l.IconLocation; workdir = $l.WorkingDirectory } | ConvertTo-Json -Compress`,
  ].join('\n'));
  return JSON.parse(out.trim());
}

describe.skipIf(!onWindows)('shortcutHygiene end-to-end (real .lnk, real PowerShell)', () => {
  let sandbox: string;
  let root: string;
  let execPath: string;
  let programs: string;
  let pinDir: string;
  let loc: RepairLocations;

  beforeEach(() => {
    // realpathSync.native expands 8.3 short components: CI runners hand back
    // `C:\Users\RUNNER~1\...` from os.tmpdir() while the shell/COM layer
    // resolves the long form, so raw mkdtemp paths fail every string compare.
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hygiene-')));
    // Fake install root: <root>\wmux.exe stub + <root>\app-1.0.0\wmux.exe (the
    // "current version" the hook process runs from) + resources\icon.ico.
    root = path.join(sandbox, 'wmux');
    const appDir = path.join(root, 'app-1.0.0');
    fs.mkdirSync(path.join(appDir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(root, 'wmux.exe'), 'stub');
    execPath = path.join(appDir, 'wmux.exe');
    fs.writeFileSync(execPath, 'exe');
    fs.writeFileSync(path.join(appDir, 'resources', 'icon.ico'), 'icon-bytes');

    programs = path.join(sandbox, 'Programs');
    pinDir = path.join(sandbox, 'TaskBar');
    fs.mkdirSync(path.join(programs, 'someauthor'), { recursive: true });
    fs.mkdirSync(pinDir, { recursive: true });
    loc = {
      legacyLnks: [path.join(programs, 'wmux.lnk')],
      pinDirs: [pinDir],
      publisherLnk: path.join(programs, '*', 'wmux.lnk'),
    };
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /**
   * Run the pass and surface WHY it produced nothing.
   *
   * `repairInstalledShortcuts` returns `[]` both when nothing needed repair
   * and when the pass could not run at all, and a CI flake landed on the
   * second (#962): the failure read as `expected [] to deeply equal [...]`
   * with nothing to go on. Every assertion below goes through here, so a
   * refused COM object or a powershell that died says so instead.
   */
  const repair = (exec = execPath, at = loc): ShortcutRepairAction[] => {
    const { actions, failure } = runShortcutRepairPass(exec, at);
    if (failure) throw new Error(`shortcut repair pass did not run: ${failure}`);
    return actions;
  };

  it('retargets a dead versioned pin to the stub and pins its icon to app.ico', () => {
    const pin = path.join(pinDir, 'wmux-pin.lnk');
    makeLnk(pin, path.join(root, 'app-0.9.0', 'wmux.exe')); // dir never existed → dead
    const iconPath = stageRootIcon(execPath);
    expect(iconPath).toBe(path.join(root, 'app.ico'));
    expect(fs.existsSync(iconPath ?? '')).toBe(true);

    const actions = repair();
    expect(actions).toEqual([{ path: pin, action: 'retargeted' }]);

    const after = readLnk(pin);
    expect(after.target.toLowerCase()).toBe(path.join(root, 'wmux.exe').toLowerCase());
    expect(after.workdir.toLowerCase()).toBe(root.toLowerCase());
    expect(after.icon.toLowerCase()).toBe(`${path.join(root, 'app.ico')},0`.toLowerCase());
  });

  it('retargets a live-but-versioned pin (it would die on the next update)', () => {
    const pin = path.join(pinDir, 'wmux-pin.lnk');
    makeLnk(pin, execPath); // app-1.0.0 exists today
    const actions = repair();
    expect(actions).toEqual([{ path: pin, action: 'retargeted' }]);
    expect(readLnk(pin).target.toLowerCase()).toBe(path.join(root, 'wmux.exe').toLowerCase());
  });

  it('removes a dead legacy Start Menu link when the publisher link exists', () => {
    const legacy = loc.legacyLnks[0];
    makeLnk(legacy, path.join(root, 'app-0.5.0', 'wmux.exe'));
    makeLnk(path.join(programs, 'someauthor', 'wmux.lnk'), path.join(root, 'wmux.exe'));

    const actions = repair();
    expect(actions).toEqual([{ path: legacy, action: 'removed' }]);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('retargets (not removes) a dead legacy link when no publisher link exists', () => {
    const legacy = loc.legacyLnks[0];
    makeLnk(legacy, path.join(root, 'app-0.5.0', 'wmux.exe'));

    const actions = repair();
    expect(actions).toEqual([{ path: legacy, action: 'retargeted' }]);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(readLnk(legacy).target.toLowerCase()).toBe(path.join(root, 'wmux.exe').toLowerCase());
  });

  it('leaves healthy stub-targeted links and foreign shortcuts alone', () => {
    const healthy = path.join(pinDir, 'wmux-good.lnk');
    makeLnk(healthy, path.join(root, 'wmux.exe'));
    const foreign = path.join(pinDir, 'other-app.lnk');
    const foreignTarget = path.join(sandbox, 'other', 'other.exe');
    fs.mkdirSync(path.dirname(foreignTarget), { recursive: true });
    fs.writeFileSync(foreignTarget, 'x');
    makeLnk(foreign, foreignTarget);

    const actions = repair();
    expect(actions).toEqual([]);
    expect(readLnk(foreign).target.toLowerCase()).toBe(foreignTarget.toLowerCase());
  });

  it('leaves IconLocation empty when app.ico was never staged', () => {
    // Regression guard: writing an IconLocation that resolves to nothing is
    // exactly the #863 symptom. With no icon staged the link must fall back to
    // the stub's embedded icon instead of pointing at a missing app.ico.
    const pin = path.join(pinDir, 'wmux-pin.lnk');
    makeLnk(pin, path.join(root, 'app-0.9.0', 'wmux.exe'));
    expect(fs.existsSync(path.join(root, 'app.ico'))).toBe(false); // not staged

    const actions = repair();
    expect(actions).toEqual([{ path: pin, action: 'retargeted' }]);

    const after = readLnk(pin);
    expect(after.target.toLowerCase()).toBe(path.join(root, 'wmux.exe').toLowerCase());
    expect(after.icon).toBe(',0'); // empty → shell resolves the target's icon
  });

  it('does not report a retarget it could not write to disk', () => {
    // Save() on a read-only .lnk fails without flipping $?, so a naive
    // implementation reports success for an edit that never landed. The caller
    // (and the next person debugging a blank icon) would be misled.
    const pin = path.join(pinDir, 'wmux-pin.lnk');
    const deadTarget = path.join(root, 'app-0.9.0', 'wmux.exe');
    makeLnk(pin, deadTarget);
    fs.chmodSync(pin, 0o444);
    ps(`Set-ItemProperty -LiteralPath ${q(pin)} -Name IsReadOnly -Value $true`);
    try {
      expect(repair()).toEqual([]);
      expect(readLnk(pin).target.toLowerCase()).toBe(deadTarget.toLowerCase());
    } finally {
      ps(`Set-ItemProperty -LiteralPath ${q(pin)} -Name IsReadOnly -Value $false`);
    }
  });

  it("repairs under a profile path containing an apostrophe and a dollar sign", () => {
    // C:\Users\O'Connor and a folder named $app are legal Windows paths. An
    // over-strict quoting guard would make the repair a silent no-op for those
    // users — the same class of invisible failure this module removes.
    const oddSandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hyg-odd-')));
    try {
      const oddRoot = path.join(oddSandbox, "O'Connor $app", 'wmux');
      const oddAppDir = path.join(oddRoot, 'app-1.0.0');
      fs.mkdirSync(path.join(oddAppDir, 'resources'), { recursive: true });
      fs.writeFileSync(path.join(oddRoot, 'wmux.exe'), 'stub');
      const oddExec = path.join(oddAppDir, 'wmux.exe');
      fs.writeFileSync(oddExec, 'exe');
      fs.writeFileSync(path.join(oddAppDir, 'resources', 'icon.ico'), 'icon-bytes');

      const oddPins = path.join(oddSandbox, "O'Connor $app", 'TaskBar');
      const oddPrograms = path.join(oddSandbox, "O'Connor $app", 'Programs');
      fs.mkdirSync(oddPins, { recursive: true });
      fs.mkdirSync(oddPrograms, { recursive: true });
      const oddLoc: RepairLocations = {
        legacyLnks: [path.join(oddPrograms, 'wmux.lnk')],
        pinDirs: [oddPins],
        publisherLnk: path.join(oddPrograms, '*', 'wmux.lnk'),
      };

      const pin = path.join(oddPins, 'wmux-pin.lnk');
      makeLnk(pin, path.join(oddRoot, 'app-0.9.0', 'wmux.exe'));
      expect(stageRootIcon(oddExec)).toBe(path.join(oddRoot, 'app.ico'));

      expect(repair(oddExec, oddLoc)).toEqual([
        { path: pin, action: 'retargeted' },
      ]);
      const after = readLnk(pin);
      expect(after.target.toLowerCase()).toBe(path.join(oddRoot, 'wmux.exe').toLowerCase());
      expect(after.icon.toLowerCase()).toBe(`${path.join(oddRoot, 'app.ico')},0`.toLowerCase());
    } finally {
      fs.rmSync(oddSandbox, { recursive: true, force: true });
    }
  });

  it('does nothing when the root stub is missing (burned root — nothing sane to point at)', () => {
    fs.rmSync(path.join(root, 'wmux.exe'));
    const pin = path.join(pinDir, 'wmux-pin.lnk');
    makeLnk(pin, path.join(root, 'app-0.9.0', 'wmux.exe'));
    expect(repair()).toEqual([]);
    expect(readLnk(pin).target.toLowerCase()).toContain('app-0.9.0');
  });

  it('preserves the AppUserModelID across a retargeting Save()', () => {
    // Stamp an AUMID on a fresh link via the shell property store, repair it,
    // then read the AUMID back. This is the property the taskbar icon
    // resolution hangs off — losing it would break pin grouping (#863).
    const pin = path.join(pinDir, 'wmux-aumid.lnk');
    makeLnk(pin, path.join(root, 'app-0.9.0', 'wmux.exe'));
    ps([
      `$code = @'`,
      `using System;`,
      `using System.Runtime.InteropServices;`,
      `namespace H {`,
      `  [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PROPERTYKEY { public Guid fmtid; public uint pid; }`,
      `  [StructLayout(LayoutKind.Explicit)] public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }`,
      `  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]`,
      `  public interface IPropertyStore { void GetCount(out uint c); void GetAt(uint i, out PROPERTYKEY k); void GetValue(ref PROPERTYKEY k, ref PROPVARIANT v); void SetValue(ref PROPERTYKEY k, ref PROPVARIANT v); void Commit(); }`,
      `  [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]`,
      `  public interface IPersistFile { void GetClassID(out Guid p); [PreserveSig] int IsDirty(); void Load([MarshalAs(UnmanagedType.LPWStr)] string f, uint m); void Save([MarshalAs(UnmanagedType.LPWStr)] string f, [MarshalAs(UnmanagedType.Bool)] bool r); void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f); void GetCurFile(out IntPtr p); }`,
      `  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]`,
      `  public class ShellLink { }`,
      `  public static class Api {`,
      `    public static void SetAumid(string lnk, string aumid) {`,
      `      object sl = new ShellLink();`,
      `      ((IPersistFile)sl).Load(lnk, 2);`, // 2 = STGM_READWRITE — 0 loads a read-only store (STG_E_ACCESSDENIED on SetValue)
      `      IPropertyStore store = (IPropertyStore)sl;`,
      `      PROPERTYKEY k = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };`,
      `      PROPVARIANT v = new PROPVARIANT { vt = 31, p = Marshal.StringToCoTaskMemUni(aumid) };`,
      `      store.SetValue(ref k, ref v);`,
      `      store.Commit();`,
      `      ((IPersistFile)sl).Save(lnk, true);`,
      `      Marshal.ReleaseComObject(sl);`,
      `    }`,
      `  }`,
      `}`,
      `'@`,
      `Add-Type -TypeDefinition $code`,
      `[H.Api]::SetAumid(${q(pin)}, 'com.squirrel.wmux.wmux')`,
    ].join('\n'));

    const actions = repair();
    expect(actions).toEqual([{ path: pin, action: 'retargeted' }]);

    const aumid = ps([
      `$sh = New-Object -ComObject Shell.Application`,
      `$item = $sh.NameSpace(${q(pinDir)}).ParseName(${q(path.basename(pin))})`,
      `$item.ExtendedProperty('System.AppUserModel.ID')`,
    ].join('\n')).trim();
    expect(aumid).toBe('com.squirrel.wmux.wmux');
  });
});

describe.skipIf(!onWindows)('stageRootIcon', () => {
  it('returns null when the packaged icon is missing, without touching the root', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hygiene-'));
    try {
      const appDir = path.join(sandbox, 'wmux', 'app-1.0.0');
      fs.mkdirSync(appDir, { recursive: true });
      const exec = path.join(appDir, 'wmux.exe');
      fs.writeFileSync(exec, 'exe');
      expect(stageRootIcon(exec)).toBeNull();
      expect(fs.existsSync(path.join(sandbox, 'wmux', 'app.ico'))).toBe(false);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
