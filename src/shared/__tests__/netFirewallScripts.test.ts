import { describe, it, expect } from 'vitest';
import {
  FirewallInputError,
  buildFixScript,
  buildMacFixAppleScript,
  buildProbeScript,
  buildRemoveScript,
  elevatedPowerShellParameters,
  exeRefusal,
  firewallRuleIds,
  installRootOf,
  macExeRefusal,
  psQuote,
  ruleHash,
  windowsPowerShellPath,
  type FixScriptInput,
  type PathFacts,
  type RuleScope,
} from '../netFirewallScripts';
import type { FirewallListener } from '../netFirewall';

const EXE = 'C:\\Users\\me\\AppData\\Local\\wmux\\app-4.10.0\\wmux.exe';
const SCOPE: RuleScope = { dataSuffix: '', user: 'DESK\\me', group: 'wmux' };
const facts: PathFacts = { exists: () => true, onLocalFixedDrive: () => true };

function fix(over: Partial<FixScriptInput> = {}): string {
  const exe = over.exe ?? EXE;
  return buildFixScript({ listener: 'a2a', port: 45660, exe, reportedExe: exe, tailnet: false, scope: SCOPE, facts, ...over });
}
function refusalOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof FirewallInputError ? err.reason : `other: ${String(err)}`;
  }
}

// Every script must run under Constrained Language Mode: no .NET type
// literal (`[System.IO.Path]::…`) and no method call (`.StartsWith(`).
const DOTNET_TYPE = /\[[A-Za-z][A-Za-z.]*\]::/;
const METHOD_CALL = /\.[A-Za-z_]\w*\(/;

const ALL_SCRIPTS = (): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (const listener of ['a2a', 'web', 'lanlink'] as FirewallListener[]) {
    for (const tailnet of [false, true]) out.push([`fix ${listener} tailnet=${tailnet}`, fix({ listener, tailnet })]);
    out.push([`remove ${listener}`, buildRemoveScript({ listener, exe: EXE, reportedExe: EXE, scope: SCOPE, facts })]);
    out.push([
      `probe ${listener}`,
      buildProbeScript({ exe: EXE, port: 45660, ips: ['192.168.1.10', '100.88.120.107'], ruleIds: firewallRuleIds(listener, EXE, SCOPE), legacyScan: listener === 'lanlink' }),
    ]);
  }
  return out;
};

describe('buildFixScript', () => {
  it('the A2A Fix, exactly', () => {
    expect(fix()).toBe(
      "$ErrorActionPreference='Stop'; $exe='C:\\Users\\me\\AppData\\Local\\wmux\\app-4.10.0\\wmux.exe'; $root='C:\\Users\\me\\AppData\\Local\\wmux'; $g='wmux'; " +
        "try { Import-Module -Name (Join-Path $PSHOME 'Modules\\NetSecurity\\NetSecurity.psd1') -ErrorAction Stop; " +
        "NetSecurity\\Remove-NetFirewallRule -Name 'wmux-a2a-1451d14d-allow','wmux-a2a-1451d14d-pubblock' -ErrorAction SilentlyContinue; " +
        "NetSecurity\\Get-NetFirewallRule -Group $g -ErrorAction SilentlyContinue | Where-Object { $p=($_ | NetSecurity\\Get-NetFirewallApplicationFilter).Program; ($p -match '^[A-Za-z]:\\\\') -and (Test-Path -LiteralPath (Split-Path -Qualifier $p)) -and -not (Test-Path -LiteralPath $p) } | NetSecurity\\Remove-NetFirewallRule -ErrorAction Stop; " +
        "NetSecurity\\Get-NetFirewallRule -DisplayName 'wmux LanLink (Private)','wmux LanLink (Public deny)' -ErrorAction SilentlyContinue | Where-Object { $p=($_ | NetSecurity\\Get-NetFirewallApplicationFilter).Program; ($p -match '^[A-Za-z]:\\\\') -and (((Test-Path -LiteralPath (Split-Path -Qualifier $p)) -and -not (Test-Path -LiteralPath $p)) -or ((Split-Path -Parent $p) -eq $root) -or ((Split-Path -Parent (Split-Path -Parent $p)) -eq $root)) } | NetSecurity\\Remove-NetFirewallRule -ErrorAction Stop } catch { exit 10 }; " +
        "try { NetSecurity\\New-NetFirewallRule -Name 'wmux-a2a-1451d14d-allow' -Group $g -DisplayName 'wmux A2A inbound (TCP 45660)' -Description ('Created by wmux (' + $root + ') when you pressed Allow through firewall. Remove it from wmux: Remote > Details.') -Direction Inbound -Action Allow -Protocol TCP -LocalPort 45660 -Program $exe -Profile Private -RemoteAddress 'LocalSubnet' -EdgeTraversalPolicy Block -ErrorAction Stop | Out-Null } catch { exit 11 }; " +
        "try { NetSecurity\\New-NetFirewallRule -Name 'wmux-a2a-1451d14d-pubblock' -Group $g -DisplayName 'wmux A2A block on public networks (TCP 45660)' -Description ('Created by wmux (' + $root + ') when you pressed Allow through firewall. Remove it from wmux: Remote > Details.') -Direction Inbound -Action Block -Protocol TCP -LocalPort 45660 -Program $exe -Profile Public -ErrorAction Stop | Out-Null } catch { exit 12 }; exit 0",
    );
  });

  it('adds the tailnet range only when offered, and names each listener', () => {
    expect(fix({ tailnet: true })).toContain("-RemoteAddress 'LocalSubnet','100.64.0.0/10'");
    expect(fix({ tailnet: false })).not.toContain('100.64.0.0/10');
    expect(fix({ listener: 'web', port: 7681 })).toContain("-DisplayName 'wmux web inbound (TCP 7681)'");
    expect(fix({ listener: 'lanlink', port: 45651 })).toContain("-DisplayName 'wmux LanLink block on public networks (TCP 45651)'");
  });

  it('exits 10, 11 and 12 per stage, in that order', () => {
    const s = fix();
    const at = (n: number) => s.indexOf(`exit ${n} }`);
    expect(at(10)).toBeGreaterThan(0);
    expect(at(11)).toBeGreaterThan(at(10));
    expect(at(12)).toBeGreaterThan(at(11));
    expect(s.endsWith('exit 0')).toBe(true);
  });

  it('the Allow is Private + LocalSubnet without edge traversal; the Block is Public; Domain is never named', () => {
    const s = fix();
    expect(s).toMatch(/-Action Allow -Protocol TCP -LocalPort 45660 -Program \$exe -Profile Private -RemoteAddress 'LocalSubnet' -EdgeTraversalPolicy Block/);
    expect(s).toMatch(/-Action Block -Protocol TCP -LocalPort 45660 -Program \$exe -Profile Public /);
    expect(s).not.toMatch(/Domain|-Profile Any/);
  });
});

describe('every script', () => {
  it('is one CLM-safe line under 4 KB with no double quote', () => {
    for (const [name, s] of ALL_SCRIPTS()) {
      expect(DOTNET_TYPE.test(s), name).toBe(false);
      expect(METHOD_CALL.test(s), name).toBe(false);
      expect(/[\r\n]/.test(s), name).toBe(false);
      expect(s.includes('"'), name).toBe(false);
      expect(s.length, name).toBeLessThanOrEqual(4096);
    }
  });

  it('never encodes, uses netsh, flips a network profile or opens Any profile', () => {
    for (const [name, s] of ALL_SCRIPTS()) {
      expect(s, name).not.toMatch(/EncodedCommand|netsh|Set-NetConnectionProfile|-Profile Any|ExecutionPolicy/i);
    }
  });

  it('removes only by our IDs, or from a -Group/-DisplayName pipeline filtered by Where-Object', () => {
    const BY_NAME = /NetSecurity\\Remove-NetFirewallRule -Name 'wmux-(a2a|web|lanlink)-([0-9a-f]{8})-allow','wmux-\1-\2-pubblock' -ErrorAction SilentlyContinue/g;
    const PIPED = /NetSecurity\\Get-NetFirewallRule -(?:Group \$g|DisplayName 'wmux LanLink \(Private\)','wmux LanLink \(Public deny\)') -ErrorAction SilentlyContinue \| Where-Object \{ [^}]+ \} \| NetSecurity\\Remove-NetFirewallRule -ErrorAction Stop/g;
    for (const [name, s] of ALL_SCRIPTS()) {
      const removes = s.match(/Remove-NetFirewallRule/g)?.length ?? 0;
      const allowed = (s.match(BY_NAME)?.length ?? 0) + (s.match(PIPED)?.length ?? 0);
      expect(allowed, name).toBe(removes);
      // -Group and -DisplayName mix parameter sets and abort under Stop when nothing matches.
      for (const cmd of s.matchAll(/Get-NetFirewallRule [^|;]*/g)) {
        expect(/-Group\b/.test(cmd[0]) && /-DisplayName\b/.test(cmd[0]), `${name}: ${cmd[0]}`).toBe(false);
      }
      // Both pipelines take only drive-letter programs (never Any, never a
      // share), and judge a program gone only on a drive the elevated session
      // sees; the group one removes nothing else.
      for (const m of s.matchAll(/Get-NetFirewallRule -(?:Group \$g|DisplayName [^|]*) [^|]*\| Where-Object \{ ([^}]*) \}/g)) {
        expect(m[1].startsWith("$p=($_ | NetSecurity\\Get-NetFirewallApplicationFilter).Program; ($p -match '^[A-Za-z]:\\\\') -and "), m[1]).toBe(true);
        expect(m[1]).toContain('(Test-Path -LiteralPath (Split-Path -Qualifier $p)) -and -not (Test-Path -LiteralPath $p)');
      }
    }
  });

  it('the elevated scripts load NetSecurity from $PSHOME first and call only its module-qualified cmdlets', () => {
    for (const [name, s] of ALL_SCRIPTS()) {
      if (name.startsWith('probe')) continue;
      const load = s.indexOf("Import-Module -Name (Join-Path $PSHOME 'Modules\\NetSecurity\\NetSecurity.psd1') -ErrorAction Stop");
      expect(load, name).toBeGreaterThan(0);
      expect(s.indexOf('-NetFirewall'), name).toBeGreaterThan(load);
      for (const m of s.matchAll(/(\S*)(?:New|Get|Remove)-NetFirewall\w+/g)) expect(m[1], `${name}: ${m[0]}`).toMatch(/NetSecurity\\$/);
    }
  });

  it('the Remove script touches only this listener\'s pair', () => {
    const s = buildRemoveScript({ listener: 'web', exe: EXE, reportedExe: EXE, scope: SCOPE, facts });
    const ids = firewallRuleIds('web', EXE, SCOPE);
    expect(s).toBe(
      "$ErrorActionPreference='Stop'; try { Import-Module -Name (Join-Path $PSHOME 'Modules\\NetSecurity\\NetSecurity.psd1') -ErrorAction Stop; " +
        `NetSecurity\\Remove-NetFirewallRule -Name '${ids.allow}','${ids.pubblock}' -ErrorAction SilentlyContinue } catch { exit 10 }; exit 0`,
    );
  });
});

describe('psQuote and the inputs it refuses', () => {
  it('doubles ASCII and smart single quotes; Hangul passes unchanged', () => {
    expect(psQuote("C:\\Users\\O'Brien\\wmux.exe")).toBe("'C:\\Users\\O''Brien\\wmux.exe'");
    expect(psQuote('C:\\Users\\O\u2019Brien\\wmux.exe')).toBe("'C:\\Users\\O\u2019\u2019Brien\\wmux.exe'");
    expect(psQuote('C:\\Users\\a\u2018b\u201ac\u201bd')).toBe("'C:\\Users\\a\u2018\u2018b\u201a\u201ac\u201b\u201bd'");
    expect(psQuote('C:\\Users\\홍길동\\wmux.exe')).toBe("'C:\\Users\\홍길동\\wmux.exe'");
  });

  it('refuses $, backtick, double quotes (ASCII and smart), CR, LF and tab', () => {
    for (const bad of ['a$b', 'a`b', 'a"b', 'a\rb', 'a\nb', 'a\tb', 'a\u201cb', 'a\u201db', 'a\u201eb']) {
      expect(refusalOf(() => psQuote(bad)), JSON.stringify(bad)).toBe('bad-path');
    }
  });

  it('the Fix carries quoted fixtures intact and refuses the bad ones', () => {
    const obrien = 'C:\\Users\\O\'Brien\\AppData\\Local\\wmux\\app-1.2.3\\wmux.exe';
    expect(fix({ exe: obrien })).toContain("$exe='C:\\Users\\O''Brien\\AppData\\Local\\wmux\\app-1.2.3\\wmux.exe'");
    expect(fix({ exe: obrien })).toContain("$root='C:\\Users\\O''Brien\\AppData\\Local\\wmux'");
    const hangul = 'C:\\Users\\홍길동\\AppData\\Local\\wmux\\app-1.2.3\\wmux.exe';
    expect(fix({ exe: hangul })).toContain(`$exe='${hangul}'`);
    const smart = 'C:\\Users\\O\u2019Brien\\wmux\\wmux.exe';
    expect(fix({ exe: smart })).toContain("$exe='C:\\Users\\O\u2019\u2019Brien\\wmux\\wmux.exe'");
    for (const bad of ['C:\\Users\\$me\\wmux.exe', 'C:\\Users\\a`b\\wmux.exe', 'C:\\Users\\a"b\\wmux.exe', 'C:\\Users\\a\rb\\wmux.exe', 'C:\\Users\\a\nb\\wmux.exe', 'C:\\Users\\a\u201cb\\wmux.exe']) {
      expect(refusalOf(() => fix({ exe: bad })), JSON.stringify(bad)).toBe('bad-path');
    }
  });

  it('refuses a program that is not the daemon\'s reported execPath', () => {
    expect(refusalOf(() => fix({ exe: EXE, reportedExe: 'C:\\Other\\wmux.exe' }))).toBe('bad-input');
  });

  it('refuses node.exe, a non-wmux program, a relative or missing path, and a bad port', () => {
    expect(refusalOf(() => fix({ exe: 'C:\\Program Files\\nodejs\\node.exe' }))).toBe('node-daemon');
    expect(refusalOf(() => fix({ exe: 'D:\\wmux\\node_modules\\electron\\dist\\electron.exe' }))).toBe('not-wmux-exe');
    expect(refusalOf(() => fix({ exe: 'wmux.exe' }))).toBe('exe-missing');
    expect(refusalOf(() => fix({ exe: '\\\\server\\share\\wmux.exe' }))).toBe('exe-missing');
    expect(refusalOf(() => fix({ facts: { ...facts, exists: () => false } }))).toBe('exe-missing');
    for (const port of [0, 80, 1023, 65536, 45660.5]) expect(refusalOf(() => fix({ port })), String(port)).toBe('bad-input');
    expect(exeRefusal('C:\\x\\NODE.EXE', facts)).toBe('node-daemon');
    expect(exeRefusal(EXE, facts)).toBeNull();
  });

  it('refuses a program on a network, SUBST or removable drive', () => {
    const notLocal: PathFacts = { exists: () => true, onLocalFixedDrive: () => false };
    expect(exeRefusal('Z:\\apps\\wmux\\wmux.exe', notLocal)).toBe('not-local-drive');
    expect(refusalOf(() => fix({ facts: notLocal }))).toBe('not-local-drive');
    expect(refusalOf(() => buildRemoveScript({ listener: 'a2a', exe: EXE, reportedExe: EXE, scope: SCOPE, facts: notLocal }))).toBe('not-local-drive');
  });

  it('refuses an 8.3 short-name path, which New-NetFirewallRule -Program rejects (error 87)', () => {
    for (const short of [
      'C:\\Users\\RUNNER~1\\AppData\\Local\\wmux\\app-1.2.3\\wmux.exe',
      'C:\\PROGRA~1\\wmux\\wmux.exe',
      'C:\\Users\\me\\AppData\\Local\\wmux\\APP-12~1.3\\wmux.exe',
    ]) {
      expect(exeRefusal(short, facts), short).toBe('short-path');
      expect(refusalOf(() => fix({ exe: short })), short).toBe('short-path');
    }
    // A long name that merely holds a tilde is not an alias.
    expect(exeRefusal('C:\\apps\\my~tools\\wmux.exe', facts)).toBeNull();
    expect(exeRefusal('C:\\apps\\release~2026\\wmux.exe', facts)).toBeNull();
  });

  it('refuses the wildcards the by-program query would read as a pattern', () => {
    for (const bad of ['C:\\apps\\[x]\\wmux.exe', 'C:\\apps\\x]\\wmux.exe', 'C:\\apps\\x*\\wmux.exe', 'C:\\apps\\x?\\wmux.exe']) {
      expect(exeRefusal(bad, facts), bad).toBe('bad-path');
      expect(refusalOf(() => fix({ exe: bad })), bad).toBe('bad-path');
    }
  });
});

describe('rule IDs', () => {
  it('Squirrel app-X.Y.Z maps to its parent; other layouts keep the exe folder', () => {
    expect(installRootOf(EXE)).toBe('C:\\Users\\me\\AppData\\Local\\wmux');
    expect(installRootOf('C:\\Users\\me\\AppData\\Local\\wmux\\app-4.11.0-beta.1\\wmux.exe')).toBe('C:\\Users\\me\\AppData\\Local\\wmux');
    expect(installRootOf('D:\\portable\\wmux\\wmux.exe')).toBe('D:\\portable\\wmux');
  });

  it('a staged daemon copy maps to its daemon-runtime folder, the same across builds', () => {
    const root = 'C:\\Users\\me\\.wmux\\daemon-runtime';
    expect(installRootOf(`${root}\\4.14.0-1793650000123\\wmux.exe`)).toBe(root);
    expect(installRootOf(`${root}\\4.15.0-beta.1-1793650000999\\wmux.exe`)).toBe(root);
    // A copy in progress or a folder that is not a stage key keeps its own folder.
    expect(installRootOf(`${root}\\4.14.0-1793650000123.partial-42\\wmux.exe`)).toBe(`${root}\\4.14.0-1793650000123.partial-42`);
    expect(installRootOf('C:\\other\\4.14.0-1793650000123\\wmux.exe')).toBe('C:\\other\\4.14.0-1793650000123');
  });

  it('is stable across updates, case-insensitive on the root, and differs by instance and user', () => {
    const a = firewallRuleIds('a2a', EXE, SCOPE);
    expect(a).toEqual({ base: 'wmux-a2a-1451d14d', allow: 'wmux-a2a-1451d14d-allow', pubblock: 'wmux-a2a-1451d14d-pubblock' });
    expect(firewallRuleIds('a2a', EXE.replace('app-4.10.0', 'app-4.11.0'), SCOPE)).toEqual(a);
    expect(ruleHash('C:\\USERS\\ME\\APPDATA\\LOCAL\\WMUX', '', 'DESK\\me')).toBe(ruleHash('c:\\users\\me\\appdata\\local\\wmux', '', 'DESK\\me'));
    expect(firewallRuleIds('a2a', EXE, { ...SCOPE, dataSuffix: '-dev' }).base).not.toBe(a.base);
    expect(firewallRuleIds('a2a', EXE, { ...SCOPE, user: 'DESK\\other' }).base).not.toBe(a.base);
    expect(firewallRuleIds('web', EXE, SCOPE).base).toBe('wmux-web-1451d14d');
    expect(firewallRuleIds('a2a', EXE, { ...SCOPE, group: 'wmux-ci' }).base).toBe('wmux-ci-a2a-1451d14d');
  });
});

describe('the probe', () => {
  it('quotes the exe and validates the address list', () => {
    const s = buildProbeScript({ exe: EXE, port: 45660, ips: [], ruleIds: firewallRuleIds('a2a', EXE, SCOPE), legacyScan: false });
    expect(s).toContain(`$exe='${EXE}'`);
    expect(s).toContain('$ips=@()');
    expect(s).toContain("$o['legacy']=0");
    // Our rules say whether their remote addresses reach the tailnet range.
    expect(s).toContain("$tailnetRanges=@('Any','100.64.0.0/10','100.64.0.0/255.192.0.0')");
    expect(s).toContain("$own=($ids -contains $r.Name); $tn=0; if ($own) { $af=@($r | Get-NetFirewallAddressFilter -PolicyStore ActiveStore -ErrorAction SilentlyContinue); if ($af.Count -ge 1) { foreach ($ra in @($af[0].RemoteAddress)) { if ($tailnetRanges -contains ('' + $ra)) { $tn=1 } } } };");
    // Every read in the rule loop is from the ActiveStore, like the filter query it starts from.
    expect(s).toContain('foreach ($r in @($f | Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction SilentlyContinue))');
    expect(s).toContain('$pf=@($r | Get-NetFirewallPortFilter -PolicyStore ActiveStore -ErrorAction SilentlyContinue)');
    expect(s.match(/\| Get-NetFirewall\w+ -ErrorAction/g)).toBeNull();
    // A registered firewall product counts only while it is on.
    expect(s).toContain("ClassName FirewallProduct -ErrorAction SilentlyContinue | Where-Object { ((($_.productState -shr 12) -band 0xF) -eq 1) })");
    expect(s).toContain('tn=$tn;');
    expect(refusalOf(() => buildProbeScript({ exe: EXE, port: 45660, ips: ["1.2.3.4'; Remove-Item x; '"], ruleIds: firewallRuleIds('a2a', EXE, SCOPE), legacyScan: false }))).toBe('bad-input');
  });

  it('scans for the legacy LanLink rules only when asked', () => {
    const s = buildProbeScript({ exe: EXE, port: 45651, ips: ['10.0.0.5'], ruleIds: firewallRuleIds('lanlink', EXE, SCOPE), legacyScan: true });
    expect(s).toContain("Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName $legacyNames");
  });
});

describe('elevation command line', () => {
  it('passes the script as one double-quoted -Command argument, hidden, no profile', () => {
    expect(elevatedPowerShellParameters('exit 0')).toBe('-NoProfile -NonInteractive -WindowStyle Hidden -Command "exit 0"');
    expect(refusalOf(() => elevatedPowerShellParameters('exit "0"'))).toBe('bad-input');
  });

  it('runs the absolute Windows PowerShell under the System32 it is given', () => {
    expect(windowsPowerShellPath('C:\\Windows\\System32')).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });
});

describe('macOS Fix (unverified on a Mac)', () => {
  it('quotes the app path for the shell inside AppleScript', () => {
    expect(buildMacFixAppleScript('/Applications/wmux.app/Contents/MacOS/wmux')).toBe(
      "do shell script \"/usr/libexec/ApplicationFirewall/socketfilterfw --add '/Applications/wmux.app/Contents/MacOS/wmux' --unblockapp '/Applications/wmux.app/Contents/MacOS/wmux'\" with administrator privileges",
    );
    for (const bad of ["/A/b'c", '/A/b"c', '/A/b\\c', '/A/b\nc', '/A/$x']) {
      expect(refusalOf(() => buildMacFixAppleScript(`${bad}/wmux.app/Contents/MacOS/wmux`)), JSON.stringify(bad)).toBe('bad-path');
    }
  });

  it('allows only the packaged wmux binary, never node or a development Electron', () => {
    expect(macExeRefusal('/Applications/wmux.app/Contents/MacOS/wmux')).toBeNull();
    expect(macExeRefusal('/usr/local/bin/node')).toBe('node-daemon');
    expect(macExeRefusal('/Users/me/wmux/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')).toBe('not-wmux-exe');
    expect(macExeRefusal('relative/wmux')).toBe('exe-missing');
    expect(refusalOf(() => buildMacFixAppleScript('/usr/local/bin/node'))).toBe('node-daemon');
    expect(refusalOf(() => buildMacFixAppleScript('/Applications/Electron.app/Contents/MacOS/Electron'))).toBe('not-wmux-exe');
  });
});
