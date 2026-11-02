// End-to-end run of the #863 shortcut-hygiene pass against REAL .lnk files in
// a temp sandbox: real powershell.exe, real WScript.Shell COM, real property
// stores. This is the evidence the unit tests cannot give — that a dead
// versioned link is retargeted to the stub with the icon pinned to app.ico,
// that Squirrel's publisher-folder Start Menu link is removed while the
// top-level entry is kept (#2971), that foreign shortcuts are untouched, and
// that Save() preserves the link's AppUserModelID (the property Windows
// resolves the taskbar icon through). The uninstall pass is run the same way.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  removeSecondStartMenuEntry,
  removeToastEntries,
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
      pinDirs: [pinDir],
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

  // #2971: Electron's toast setup is the one writer of the top-level entry;
  // the repair pass must not become a second one.
  it('never touches the Start Menu, not even a dead top-level link', () => {
    const top = path.join(programs, 'wmux.lnk');
    const dead = path.join(root, 'app-0.5.0', 'wmux.exe');
    makeLnk(top, dead);
    const pub = path.join(programs, 'someauthor', 'wmux.lnk');
    makeLnk(pub, path.join(root, 'wmux.exe'));

    expect(repair()).toEqual([]);
    expect(readLnk(top).target.toLowerCase()).toBe(dead.toLowerCase());
    expect(fs.existsSync(pub)).toBe(true);
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
        pinDirs: [oddPins],
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

// #2971: at startup, Squirrel's publisher-folder link from installs before
// #2971 goes once the top-level entry exists and points into the install.
describe.skipIf(!onWindows)('removeSecondStartMenuEntry end-to-end (real .lnk, real PowerShell)', () => {
  let sandbox: string;
  let root: string;
  let execPath: string;
  let top: string;
  let pubDir: string;
  let pub: string;

  beforeEach(() => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-second-entry-')));
    root = path.join(sandbox, 'wmux');
    fs.mkdirSync(path.join(root, 'app-1.0.0'), { recursive: true });
    fs.writeFileSync(path.join(root, 'wmux.exe'), 'stub');
    execPath = path.join(root, 'app-1.0.0', 'wmux.exe');
    fs.writeFileSync(execPath, 'exe');
    const programs = path.join(sandbox, 'Programs');
    pubDir = path.join(programs, 'someauthor');
    fs.mkdirSync(pubDir, { recursive: true });
    top = path.join(programs, 'wmux.lnk');
    pub = path.join(pubDir, 'wmux.lnk');
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const run = async () => {
    const { actions, failure } = await removeSecondStartMenuEntry(execPath, 'someauthor', { topLevelLnk: top, publisherLnk: pub });
    if (failure) throw new Error(`second entry removal did not run: ${failure}`);
    return actions;
  };

  it('removes the publisher link and its emptied folder once the top-level entry points into the install', async () => {
    makeLnk(top, path.join(root, 'wmux.exe'));
    makeLnk(pub, path.join(root, 'wmux.exe'));
    expect(await run()).toEqual([{ path: pub, action: 'removed' }]);
    expect(fs.existsSync(pub)).toBe(false);
    expect(fs.existsSync(pubDir)).toBe(false);
    expect(fs.existsSync(top)).toBe(true);
  });

  it('keeps a publisher folder that holds anything else', async () => {
    makeLnk(top, path.join(root, 'wmux.exe'));
    makeLnk(pub, execPath);
    fs.writeFileSync(path.join(pubDir, 'other.lnk'), 'not ours');
    expect(await run()).toEqual([{ path: pub, action: 'removed' }]);
    expect(fs.existsSync(path.join(pubDir, 'other.lnk'))).toBe(true);
  });

  it('keeps the publisher link while there is no top-level entry, so the app always has one', async () => {
    makeLnk(pub, path.join(root, 'wmux.exe'));
    expect(await run()).toEqual([]);
    expect(fs.existsSync(pub)).toBe(true);
  });

  it('keeps it while the top-level entry points at a removed version', async () => {
    // An install upgraded from 3.3.x: the top-level link still names the
    // deleted app-3.3.0\wmux.exe until Electron rewrites it.
    makeLnk(top, path.join(root, 'app-0.9.0', 'wmux.exe'));
    makeLnk(pub, path.join(root, 'wmux.exe'));
    expect(await run()).toEqual([]);
    expect(fs.existsSync(pub)).toBe(true);
  });

  it('keeps it while the top-level entry points at another install', async () => {
    const other = path.join(sandbox, 'other', 'wmux.exe');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'x');
    makeLnk(top, other);
    makeLnk(pub, path.join(root, 'wmux.exe'));
    expect(await run()).toEqual([]);
    expect(fs.existsSync(pub)).toBe(true);
  });

  it("keeps a publisher-folder link that is not this install's", async () => {
    makeLnk(top, path.join(root, 'wmux.exe'));
    const other = path.join(sandbox, 'other', 'wmux.exe');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'x');
    makeLnk(pub, other);
    expect(await run()).toEqual([]);
    expect(fs.existsSync(pub)).toBe(true);
  });
});

// #2971: the uninstall hook removes what Electron's toast setup wrote for this
// install. The class key lives under a throwaway HKCU key, never the real
// HKCU\Software\Classes\CLSID.
describe.skipIf(!onWindows)('removeToastEntries end-to-end (real .lnk, real registry under a temp key)', () => {
  let sandbox: string;
  let root: string;
  let execPath: string;
  let top: string;
  let regRoot: string;
  let clsidKey: string;

  const setDefault = (key: string, value: string) => ps([
    `New-Item -Path ${q(key)} -Force | Out-Null`,
    `Set-Item -LiteralPath ${q(key)} -Value ${q(value)}`,
  ].join('\n'));
  const activator = (clsid: string, name: string, server: string) => {
    setDefault(`${clsidKey}\\${clsid}`, name);
    setDefault(`${clsidKey}\\${clsid}\\LocalServer32`, server);
  };
  const keyExists = (clsid: string) => ps(`Test-Path -LiteralPath ${q(`${clsidKey}\\${clsid}`)}`).trim() === 'True';

  beforeEach(() => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-toast-entries-')));
    root = path.join(sandbox, 'wmux');
    fs.mkdirSync(path.join(root, 'app-1.0.0'), { recursive: true });
    fs.writeFileSync(path.join(root, 'wmux.exe'), 'stub');
    execPath = path.join(root, 'app-1.0.0', 'wmux.exe');
    fs.writeFileSync(execPath, 'exe');
    fs.mkdirSync(path.join(sandbox, 'Programs'), { recursive: true });
    top = path.join(sandbox, 'Programs', 'wmux.lnk');
    regRoot = `HKCU:\\Software\\wmux-hygiene-test-${process.pid}-${Date.now()}`;
    clsidKey = `${regRoot}\\CLSID`;
  });

  afterEach(() => {
    ps(`if (Test-Path -LiteralPath ${q(regRoot)}) { Remove-Item -LiteralPath ${q(regRoot)} -Recurse -Force }`);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const remove = () => {
    const { actions, failure } = removeToastEntries(execPath, { topLevelLnk: top, clsidKey });
    if (failure) throw new Error(`toast entry removal did not run: ${failure}`);
    return actions;
  };

  it("removes this install's Start Menu entry and activator classes, and nothing else", () => {
    makeLnk(top, path.join(root, 'wmux.exe'));
    const ours = '{11111111-2222-3333-4444-555555555555}';
    const oursOld = '{66666666-2222-3333-4444-555555555555}';
    const otherApp = '{77777777-2222-3333-4444-555555555555}';
    const notActivator = '{88888888-2222-3333-4444-555555555555}';
    activator(ours, 'Electron Notification Activator', execPath);
    activator(oursOld, 'Electron Notification Activator', path.join(root, 'app-0.9.0', 'wmux.exe'));
    activator(otherApp, 'Electron Notification Activator', path.join(sandbox, 'other', 'other.exe'));
    activator(notActivator, 'Something Else', execPath);

    const actions = remove();
    expect(actions.map((a) => a.path).sort()).toEqual(
      [top, `HKEY_CURRENT_USER${clsidKey.slice('HKCU:'.length)}\\${ours}`, `HKEY_CURRENT_USER${clsidKey.slice('HKCU:'.length)}\\${oursOld}`].sort(),
    );
    expect(fs.existsSync(top)).toBe(false);
    expect(keyExists(ours)).toBe(false);
    expect(keyExists(oursOld)).toBe(false);
    expect(keyExists(otherApp)).toBe(true);
    expect(keyExists(notActivator)).toBe(true);
  });

  it("keeps a top-level entry that belongs to another install", () => {
    const foreign = path.join(sandbox, 'other', 'wmux.exe');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, 'x');
    makeLnk(top, foreign);
    expect(remove()).toEqual([]);
    expect(fs.existsSync(top)).toBe(true);
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
