// === The firewall probe, Fix and Remove scripts (Windows) and the macOS Fix ===
//
// Built here, run elsewhere: the daemon runs the read-only probe as a plain
// child process; main runs the Fix and Remove through the Windows consent
// prompt (src/main/net/elevate.ts). Both are pure functions of validated
// inputs so the exact text can be tested.
//
// Contract every script keeps:
// - Cmdlets, operators and hashtables only. No .NET type literals and no
//   method calls, so it runs under Constrained Language Mode (managed PCs).
// - One line, no double quote anywhere. The elevated script travels as
//   ShellExecuteExW's parameter string inside one pair of double quotes;
//   a `"` in it would end that argument. Inputs are single-quoted with
//   psQuote, and the few characters it cannot carry are refused.
// - The probe prints one JSON line of printable ASCII: paths and adapter
//   names are compared inside PowerShell and never come back, so a console
//   codepage (CP949 on a Korean Windows) cannot garble them.
// - Rules are named by ID (`wmux-<listener>-<h8>-allow|pubblock`) and grouped
//   `wmux`. Removal is by those IDs, or by the group filtered to rules whose
//   program no longer exists. `-Group` and `-DisplayName` are never combined.
//
// A rule scoped to wmux.exe is not a security boundary: any local code can
// run as wmux.exe (ELECTRON_RUN_AS_NODE). The scoping keeps an unrelated
// program that later binds the port from being reachable by accident.

import crypto from 'node:crypto';
import path from 'node:path';
import { FIX_STAGE_EXIT, isIpv4, type FirewallListener, type FixRefusal } from './netFirewall';

export const FIREWALL_GROUP = 'wmux';
/** The CI round trip's group and ID prefix: never the real `wmux` group. */
export const FIREWALL_CI_GROUP = 'wmux-ci';
export type FirewallGroup = typeof FIREWALL_GROUP | typeof FIREWALL_CI_GROUP;

/** DisplayNames of the rules LanLink's removed netsh code made on an elevated daemon. */
export const LEGACY_LANLINK_RULES = ['wmux LanLink (Private)', 'wmux LanLink (Public deny)'] as const;

const LISTENER_LABEL: Record<FirewallListener, string> = { a2a: 'A2A', web: 'web', lanlink: 'LanLink' };

/** A refusal to build a script: the reason the UI shows instead of the Fix. */
export class FirewallInputError extends Error {
  constructor(readonly reason: FixRefusal | 'bad-input', message: string) {
    super(message);
    this.name = 'FirewallInputError';
  }
}

// `$` and the backtick are PowerShell's expansion and escape characters; a
// double quote (ASCII or the smart U+201C-U+201E PowerShell also honours)
// would end the elevated argument; a line break or tab would end or split the
// one-line script.
const FORBIDDEN = /[$`"\r\n\t\u201c-\u201e]/;

/**
 * A PowerShell single-quoted literal. Inside one, the only special
 * characters are the single quotes: ASCII `'` and the smart U+2018-U+201B,
 * which PowerShell also treats as quotes. Each is doubled. Everything else
 * passes through, Hangul included: the command line reaches PowerShell as
 * UTF-16, so a path is not re-encoded on the way in.
 */
export function psQuote(value: string): string {
  if (FORBIDDEN.test(value)) {
    throw new FirewallInputError('bad-path', `refusing a value with $, a backtick, a double quote or a line break: ${JSON.stringify(value)}`);
  }
  return `'${value.replace(/['\u2018-\u201b]/g, (q) => q + q)}'`;
}

/**
 * The folder that identifies an install: the parent of `app-X.Y.Z` for the
 * Squirrel layout (`…\wmux\app-4.8.0\wmux.exe` → `…\wmux`, the same across
 * updates), the `daemon-runtime` folder for the daemon's staged copy
 * (`…\.wmux\daemon-runtime\4.14.0-<mtime>\wmux.exe`, daemonRuntimeStage.ts),
 * otherwise the exe's own folder.
 */
export function installRootOf(exe: string): string {
  const dir = path.win32.dirname(exe);
  const name = path.win32.basename(dir);
  if (/^app-\d+\.\d+\.\d+/i.test(name)) return path.win32.dirname(dir);
  const parent = path.win32.dirname(dir);
  // `<version>-<mtime>`; a copy still in progress is `<key>.partial-<pid>`.
  if (/^\d+\.\d+\.\d+\S*-\d+$/.test(name) && !name.includes('.partial-') && path.win32.basename(parent).toLowerCase() === 'daemon-runtime') return parent;
  return dir;
}

/** First 8 hex of sha256(lower(installRoot) | dataSuffix | DOMAIN\user): one per install, instance and user. */
export function ruleHash(installRoot: string, dataSuffix: string, user: string): string {
  return crypto.createHash('sha256').update(`${installRoot.toLowerCase()}|${dataSuffix}|${user}`).digest('hex').slice(0, 8);
}

export interface RuleScope {
  /** WMUX_DATA_SUFFIX of the instance ('' for the default one). */
  dataSuffix: string;
  /** `USERDOMAIN\USERNAME`. */
  user: string;
  group: FirewallGroup;
}

export interface RuleIds {
  /** `wmux-a2a-1a2b3c4d`: no port, so a port change replaces the same pair. */
  base: string;
  allow: string;
  pubblock: string;
}

export function firewallRuleIds(listener: FirewallListener, exe: string, scope: RuleScope): RuleIds {
  const base = `${scope.group}-${listener}-${ruleHash(installRootOf(exe), scope.dataSuffix, scope.user)}`;
  return { base, allow: `${base}-allow`, pubblock: `${base}-pubblock` };
}

/** `DOMAIN\user` from the environment, the same in main and the daemon it spawned. */
export function currentRuleUser(env: NodeJS.ProcessEnv = process.env): string {
  return `${env['USERDOMAIN'] ?? ''}\\${env['USERNAME'] ?? env['USER'] ?? ''}`;
}

function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new FirewallInputError('bad-input', `port must be an integer in 1024-65535, got ${port}`);
  }
}

// `Get-NetFirewallApplicationFilter -Program` reads these as a pattern
// (checked: `svch?st.exe`, `svch*.exe` and `svc[h]ost.exe` all find
// svchost's rules), so the probe would not find our rule by its path.
const WILDCARD = /[[\]*?]/;

// An 8.3 alias segment: up to six characters, `~`, a number, an optional
// extension of up to three. New-NetFirewallRule refuses such a path in
// -Program with error 87; callers pass the long form (netWinPaths.ts
// canonicalExePath), so one here means it could not be expanded.
const SHORT_NAME_SEGMENT = /(^|\\)[^\\~]{1,6}~\d+(\.[^\\.]{0,3})?(?=\\|$)/;

/** What the caller knows about a path: it exists, and it is on a local fixed disk (netWinPaths.ts). */
export interface PathFacts {
  exists: (p: string) => boolean;
  onLocalFixedDrive: (p: string) => boolean;
}

/**
 * Why `exe` may not get a rule, or null. The program must be an absolute
 * drive path named wmux.exe, free of the characters the scripts refuse,
 * exist, and sit on a local fixed disk (`facts` is the caller's, so this
 * stays pure).
 */
export function exeRefusal(exe: string, facts: PathFacts): FixRefusal | null {
  if (!/^[A-Za-z]:\\/.test(exe) || !path.win32.isAbsolute(exe)) return 'exe-missing';
  const base = path.win32.basename(exe).toLowerCase();
  // A program rule for node.exe would open the port to every Node script on the PC.
  if (base === 'node.exe' || base === 'node') return 'node-daemon';
  if (base !== 'wmux.exe') return 'not-wmux-exe';
  if (FORBIDDEN.test(exe) || WILDCARD.test(exe)) return 'bad-path';
  if (SHORT_NAME_SEGMENT.test(exe)) return 'short-path';
  if (!facts.exists(exe)) return 'exe-missing';
  if (!facts.onLocalFixedDrive(exe)) return 'not-local-drive';
  return null;
}

/** `exe` when it may get a rule and is exactly the daemon's execPath as read at click time; throws otherwise. */
function checkedExe(exe: string, reportedExe: string, facts: PathFacts): string {
  if (exe !== reportedExe) {
    throw new FirewallInputError('bad-input', `the program changed since the check: ${JSON.stringify(exe)} is not ${JSON.stringify(reportedExe)}`);
  }
  const refusal = exeRefusal(exe, facts);
  if (refusal) throw new FirewallInputError(refusal, `no firewall rule for ${JSON.stringify(exe)}: ${refusal}`);
  return exe;
}

function oneLine(statements: string[]): string {
  const script = statements.join('; ');
  // Belt and braces for the contract above: the template itself never has these.
  if (/["\r\n]/.test(script)) throw new FirewallInputError('bad-input', 'internal: the script would carry a double quote or a line break');
  return script;
}

// ── Probe (read-only, not elevated) ──────────────────────────────────────────

/**
 * A FirewallProduct registered with Windows Security Center counts only while
 * it is on: a product that stays registered after it was turned off (an
 * expired trial) would otherwise hide the Fix behind "another firewall
 * controls this PC". `productState` is not documented by Microsoft; the
 * decoding used here is the one security tools commonly use (bits 12-15 of
 * the 24-bit value are 1 when the product is on, 0 when off). Checked on a
 * Windows 11 PC: Microsoft Defender Antivirus reports 0x061100 (on).
 */
export const FIREWALL_PRODUCT_ON = '((($_.productState -shr 12) -band 0xF) -eq 1)';

export interface ProbeScriptInput {
  exe: string;
  port: number;
  /** The IPv4 addresses the listener offers to other PCs. */
  ips: string[];
  ruleIds: Pick<RuleIds, 'allow' | 'pubblock'>;
  /**
   * Look for the legacy `wmux LanLink (…)` rules by DisplayName. That query
   * enumerates every rule (2-3 s), so only LanLink's probe makes it: the
   * rules were LanLink's, and A2A's probe is the one people wait on.
   */
  legacyScan: boolean;
}

/**
 * The probe. Reads the effective (ActiveStore: local + Group Policy + MDM)
 * profile switches, each offered address's network category, every rule for
 * this program (one by-program query: ours, the prompt's Allows and Blocks,
 * the legacy LanLink pair; for ours also whether the remote addresses reach
 * the tailnet range), whether legacy LanLink rules exist at all, and a
 * registered third-party firewall that is turned on. Whether an adapter is a Hyper-V virtual
 * switch is read from its name in Node (`vEthernet (…)`), which saves loading
 * the NetAdapter module (about 1.3 s).
 */
export function buildProbeScript(input: ProbeScriptInput): string {
  checkPort(input.port);
  for (const ip of input.ips) if (!isIpv4(ip)) throw new FirewallInputError('bad-input', `not an IPv4 address: ${JSON.stringify(ip)}`);
  const ips = input.ips.length > 0 ? `@(${input.ips.map((ip) => `'${ip}'`).join(',')})` : '@()';
  const legacy = LEGACY_LANLINK_RULES.map((n) => psQuote(n)).join(',');
  return oneLine([
    "$ErrorActionPreference='Stop'",
    `$exe=${psQuote(input.exe)}`,
    `$port=${input.port}`,
    `$ids=@(${psQuote(input.ruleIds.allow)},${psQuote(input.ruleIds.pubblock)})`,
    `$ips=${ips}`,
    `$legacyNames=@(${legacy})`,
    '$o=@{}',
    "$o['v']=1",
    '$pr=@{}',
    "foreach ($p in @(Get-NetFirewallProfile -PolicyStore ActiveStore)) { $pr[$p.Name]=@{en=$(if ($p.Enabled -eq 'False') {0} else {1}); inb=$(if ($p.AllowInboundRules -eq 'False') {0} else {1}); loc=$(if ($p.AllowLocalFirewallRules -eq 'False') {0} else {1})} }",
    "$o['prof']=$pr",
    '$ad=@()',
    // A Public (or profile-less) address also says its adapter's medium, so
    // Open network settings can go to that adapter's page: NdisPhysicalMedium
    // 9 is Native 802.11 (Wi-Fi), 14 is 802.3 (Ethernet), a number in every
    // display language. Read only then (the NetAdapter module costs a load),
    // and a failed read is only an unknown medium, never a failed probe.
    "foreach ($ip in $ips) { $c=-1; $m=0; $a=@(Get-NetIPAddress -IPAddress $ip -AddressFamily IPv4 -ErrorAction SilentlyContinue); if ($a.Count -eq 1) { $cp=@(Get-NetConnectionProfile -InterfaceIndex $a[0].InterfaceIndex -ErrorAction SilentlyContinue); if ($cp.Count -ge 1) { $n=$cp[0].NetworkCategory; $c=$(if ($n -eq 'Public') {0} elseif ($n -eq 'Private') {1} elseif ($n -eq 'DomainAuthenticated') {2} else {-1}) }; if ($c -le 0) { try { $na=@(Get-NetAdapter -InterfaceIndex $a[0].InterfaceIndex -ErrorAction SilentlyContinue); if ($na.Count -eq 1) { $pm=$na[0].NdisPhysicalMedium; $m=$(if ($pm -eq 9) {1} elseif ($pm -eq 14) {2} else {0}) } } catch { $m=0 } } }; $ad+=@{ip=$ip; cat=$c; med=$m} }",
    "$o['addr']=$ad",
    '$rs=@()',
    // Our rules' remote addresses: does the Allow reach tailnet peers? Windows may
    // store the range as a prefix or a mask, so both spellings count, and Any.
    "$tailnetRanges=@('Any','100.64.0.0/10','100.64.0.0/255.192.0.0')",
    "foreach ($f in @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -Program $exe -ErrorAction SilentlyContinue)) { foreach ($r in @($f | Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction SilentlyContinue)) { if ($r.Direction -ne 'Inbound' -or $r.Enabled -ne 'True') { continue }; $pf=@($r | Get-NetFirewallPortFilter -PolicyStore ActiveStore -ErrorAction SilentlyContinue); $proto='Any'; $hit=0; $any=0; if ($pf.Count -ge 1) { $proto='' + $pf[0].Protocol; foreach ($lp in @($pf[0].LocalPort)) { if ($lp -eq 'Any') { $hit=1; $any=1 } elseif ($lp -eq ('' + $port)) { $hit=1 } elseif ($lp -match '^(\\d+)-(\\d+)$') { if ((0 + $matches[1]) -le $port -and (0 + $matches[2]) -ge $port) { $hit=1 } } } } else { $hit=1; $any=1 }; $own=($ids -contains $r.Name); $tn=0; if ($own) { $af=@($r | Get-NetFirewallAddressFilter -PolicyStore ActiveStore -ErrorAction SilentlyContinue); if ($af.Count -ge 1) { foreach ($ra in @($af[0].RemoteAddress)) { if ($tailnetRanges -contains ('' + $ra)) { $tn=1 } } } }; $rs+=@{act=('' + $r.Action); prof=('' + $r.Profile); proto=$proto; hit=$hit; anyPort=$any; ours=$(if ($own) {1} else {0}); tn=$tn; legacy=$(if ($legacyNames -contains $r.DisplayName) {1} else {0}); src=('' + $r.PolicyStoreSourceType)} } }",
    "$o['rules']=$rs",
    input.legacyScan
      ? "$o['legacy']=$(if (@(Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName $legacyNames -ErrorAction SilentlyContinue).Count -gt 0) {1} else {0})"
      : "$o['legacy']=0",
    `$tp=@(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName FirewallProduct -ErrorAction SilentlyContinue | Where-Object { ${FIREWALL_PRODUCT_ON} })`,
    "$o['tp']=$(if ($tp.Count -gt 0) {1} else {0})",
    "$o['tpName']=$null",
    "if ($tp.Count -gt 0 -and $tp[0].displayName -cmatch '^[ -~]{1,64}$') { $o['tpName']=$tp[0].displayName }",
    '$o | ConvertTo-Json -Compress -Depth 6',
  ]);
}

// ── Fix and Remove (elevated) ────────────────────────────────────────────────

export interface FixScriptInput {
  listener: FirewallListener;
  port: number;
  /** The program path, as the probe the person looked at reported it. */
  exe: string;
  /** The daemon's execPath, read again at click time. Must equal `exe`. */
  reportedExe: string;
  /** Also allow 100.64.0.0/10: the listener offers a tailnet address (CGNAT is not LocalSubnet). */
  tailnet: boolean;
  scope: RuleScope;
  facts: PathFacts;
}

/**
 * The elevated scripts load NetSecurity from Windows PowerShell's own folder
 * and call its cmdlets by their module-qualified names. `-NoProfile` stops
 * profiles, not module autoload, and autoload searches the user's Documents
 * modules first: a module there exporting `New-NetFirewallRule` must not run
 * elevated in its place.
 */
export const IMPORT_NETSECURITY = "Import-Module -Name (Join-Path $PSHOME 'Modules\\NetSecurity\\NetSecurity.psd1') -ErrorAction Stop";

/**
 * A rule program that is gone, judged where the elevated session can see:
 * a drive-letter path (never `Any`, never a share) whose drive is present
 * and whose file is not. A drive the elevated session does not see (a mapped
 * or SUBST letter, an unplugged disk) says nothing, so its rules stay.
 */
export const PROGRAM_GONE = "(Test-Path -LiteralPath (Split-Path -Qualifier $p)) -and -not (Test-Path -LiteralPath $p)";
export const ON_A_DRIVE = "($p -match '^[A-Za-z]:\\\\')";

/**
 * Stage 10 (exit 10 on failure): load NetSecurity, then remove this
 * listener's pair for this install (by ID, whatever port it had), every rule
 * in our group whose program is gone (uninstalled or updated-away installs,
 * any listener), and the legacy `wmux LanLink (…)` rules whose program is
 * gone or belongs to this install. A legacy rule of another live install, or
 * one for any program, is left alone.
 */
function cleanupStage(ids: RuleIds): string {
  const legacy = LEGACY_LANLINK_RULES.map((n) => psQuote(n)).join(',');
  return [
    'try {',
    `${IMPORT_NETSECURITY};`,
    `NetSecurity\\Remove-NetFirewallRule -Name ${psQuote(ids.allow)},${psQuote(ids.pubblock)} -ErrorAction SilentlyContinue;`,
    `NetSecurity\\Get-NetFirewallRule -Group $g -ErrorAction SilentlyContinue | Where-Object { $p=($_ | NetSecurity\\Get-NetFirewallApplicationFilter).Program; ${ON_A_DRIVE} -and ${PROGRAM_GONE} } | NetSecurity\\Remove-NetFirewallRule -ErrorAction Stop;`,
    `NetSecurity\\Get-NetFirewallRule -DisplayName ${legacy} -ErrorAction SilentlyContinue | Where-Object { $p=($_ | NetSecurity\\Get-NetFirewallApplicationFilter).Program; ${ON_A_DRIVE} -and ((${PROGRAM_GONE}) -or ((Split-Path -Parent $p) -eq $root) -or ((Split-Path -Parent (Split-Path -Parent $p)) -eq $root)) } | NetSecurity\\Remove-NetFirewallRule -ErrorAction Stop`,
    `} catch { exit ${FIX_STAGE_EXIT.cleanup} }`,
  ].join(' ');
}

/**
 * The Fix: cleanup, then a Private Allow (LocalSubnet, plus the tailnet range
 * when offered; no edge traversal) and a Public Block, both TCP on this port
 * for this program. The Block beats any Allow an earlier Windows prompt made
 * for Public, so "private networks only" holds for this port. Domain is not
 * touched in either direction: company policy decides there.
 */
export function buildFixScript(input: FixScriptInput): string {
  checkPort(input.port);
  const exe = checkedExe(input.exe, input.reportedExe, input.facts);
  const root = installRootOf(exe);
  const ids = firewallRuleIds(input.listener, exe, input.scope);
  const label = LISTENER_LABEL[input.listener];
  const remote = input.tailnet ? "'LocalSubnet','100.64.0.0/10'" : "'LocalSubnet'";
  const description = "('Created by wmux (' + $root + ') when you pressed Allow through firewall. Remove it from wmux: Remote > Details.')";
  return oneLine([
    "$ErrorActionPreference='Stop'",
    `$exe=${psQuote(exe)}`,
    `$root=${psQuote(root)}`,
    `$g=${psQuote(input.scope.group)}`,
    cleanupStage(ids),
    `try { NetSecurity\\New-NetFirewallRule -Name ${psQuote(ids.allow)} -Group $g -DisplayName ${psQuote(`wmux ${label} inbound (TCP ${input.port})`)} -Description ${description} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${input.port} -Program $exe -Profile Private -RemoteAddress ${remote} -EdgeTraversalPolicy Block -ErrorAction Stop | Out-Null } catch { exit ${FIX_STAGE_EXIT.allow} }`,
    `try { NetSecurity\\New-NetFirewallRule -Name ${psQuote(ids.pubblock)} -Group $g -DisplayName ${psQuote(`wmux ${label} block on public networks (TCP ${input.port})`)} -Description ${description} -Direction Inbound -Action Block -Protocol TCP -LocalPort ${input.port} -Program $exe -Profile Public -ErrorAction Stop | Out-Null } catch { exit ${FIX_STAGE_EXIT.pubblock} }`,
    'exit 0',
  ]);
}

export type RemoveScriptInput = Omit<FixScriptInput, 'port' | 'tailnet'>;

/** Details › Remove: this listener's pair for this install, by ID. Nothing else. Exit 10 when NetSecurity cannot load. */
export function buildRemoveScript(input: RemoveScriptInput): string {
  const exe = checkedExe(input.exe, input.reportedExe, input.facts);
  const ids = firewallRuleIds(input.listener, exe, input.scope);
  return oneLine([
    "$ErrorActionPreference='Stop'",
    `try { ${IMPORT_NETSECURITY}; NetSecurity\\Remove-NetFirewallRule -Name ${psQuote(ids.allow)},${psQuote(ids.pubblock)} -ErrorAction SilentlyContinue } catch { exit ${FIX_STAGE_EXIT.cleanup} }`,
    'exit 0',
  ]);
}

/**
 * ShellExecuteExW's parameter string for a script: the whole script is one
 * double-quoted argument, so runs of spaces in a path survive the command
 * line split. Safe because the script never holds a double quote.
 */
export function elevatedPowerShellParameters(script: string): string {
  if (script.includes('"')) throw new FirewallInputError('bad-input', 'internal: the script holds a double quote');
  return `-NoProfile -NonInteractive -WindowStyle Hidden -Command "${script}"`;
}

/** Absolute Windows PowerShell 5.1 under System32 (netWinPaths.ts `systemDirectory()`): never a PATH lookup. */
export function windowsPowerShellPath(system32: string): string {
  return path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// ── macOS (verify on Mac) ────────────────────────────────────────────────────

export const SOCKETFILTERFW = '/usr/libexec/ApplicationFirewall/socketfilterfw';

/**
 * Why the macOS daemon's program may not be allowed, or null. As on Windows,
 * only wmux itself: the packaged binary inside its .app bundle. Node would
 * open the port to every Node script, and a development build's Electron
 * binary to every Electron app. Unverified on a Mac.
 */
export function macExeRefusal(exe: string): FixRefusal | null {
  if (!exe.startsWith('/')) return 'exe-missing';
  if (path.posix.basename(exe) === 'node') return 'node-daemon';
  if (!/\.app\/Contents\/MacOS\/wmux$/.test(exe)) return 'not-wmux-exe';
  return null;
}

/**
 * The AppleScript that asks for an administrator and allows `app` in the
 * application firewall. The path goes inside a shell single-quoted string
 * inside an AppleScript string, so `'`, `"`, `\` and line breaks are refused
 * rather than escaped twice. Unverified on a Mac.
 */
export function buildMacFixAppleScript(app: string): string {
  const refusal = macExeRefusal(app);
  if (refusal) throw new FirewallInputError(refusal, `no firewall entry for ${JSON.stringify(app)}: ${refusal}`);
  if (/['"\\\r\n$`]/.test(app)) {
    throw new FirewallInputError('bad-path', `refusing an app path with a quote, a backslash or a line break: ${JSON.stringify(app)}`);
  }
  return `do shell script "${SOCKETFILTERFW} --add '${app}' --unblockapp '${app}'" with administrator privileges`;
}
