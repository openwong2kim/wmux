/**
 * Process-scoped execution policy for Windows PowerShell 5.1 panes (#1620).
 *
 * On a Windows client where no scope has ever set an execution policy, the
 * effective policy is `Restricted` (about_Execution_Policies: "If the execution
 * policy in all scopes is Undefined, the effective execution policy is
 * Restricted for Windows clients"). That is the state of every fresh install
 * and every reinstall. Under it, powershell.exe refuses to load ANY .ps1 file,
 * which breaks three things wmux relies on:
 *
 *   - the interactive pane cannot dot-source wmux-shell-init.ps1, so no OSC 133
 *     or OSC 7 is ever emitted (daemon path, shell-integration.ts);
 *   - the local-mode pane cannot dot-source shell-hooks/pwsh.ps1 (PTYManager);
 *   - an exec pane running an npm-installed agent resolves `codex` to the
 *     `codex.ps1` shim before `codex.cmd`, and the shim is blocked.
 *
 * The fix passes `-ExecutionPolicy RemoteSigned` to that one process, and ONLY
 * when every policy scope is unset. Deliberate choices are left alone: an
 * explicit AllSigned/Restricted at CurrentUser or LocalMachine, and anything
 * set by Group Policy (which outranks the Process scope anyway).
 *
 * Why only powershell.exe (5.1): pwsh 7 ships $PSHOME/powershell.config.json
 * with LocalMachine=RemoteSigned, so it does not have this bug out of the box.
 * On pwsh the flag could only ever weaken a policy the user chose.
 *
 * Why RemoteSigned and not Bypass: Norton Behavioral Protection flags the
 * `-ExecutionPolicy Bypass -EncodedCommand` shape (GHSA-8fj2-47w9-jxq3, see
 * docs/SECURITY.md §1.2). RemoteSigned is the least permissive policy that
 * works: wmux writes its init scripts locally, so they carry no
 * Zone.Identifier stream and need no signature.
 *
 * The Process-scope env var PSExecutionPolicyPreference is deliberately NOT
 * consulted. Only the four persisted scopes decide. That keeps the decision a
 * property of the machine, and it lets tests reproduce a Restricted machine by
 * setting that env var on a pane.
 */
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';

export type ScopeState = 'unset' | 'set' | 'unknown';

export interface PolicyScopes {
  machinePolicy: ScopeState;
  userPolicy: ScopeState;
  currentUser: ScopeState;
  localMachine: ScopeState;
}

interface ScopeQuery {
  scope: keyof PolicyScopes;
  key: string;
  /** Group Policy keys count as set if either value is present. */
  values: readonly string[];
}

const SHELL_IDS = 'Software\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell';
const GPO = 'Software\\Policies\\Microsoft\\Windows\\PowerShell';

export const POLICY_QUERIES: readonly ScopeQuery[] = [
  { scope: 'machinePolicy', key: `HKLM\\${GPO}`, values: ['EnableScripts', 'ExecutionPolicy'] },
  { scope: 'userPolicy', key: `HKCU\\${GPO}`, values: ['EnableScripts', 'ExecutionPolicy'] },
  { scope: 'currentUser', key: `HKCU\\${SHELL_IDS}`, values: ['ExecutionPolicy'] },
  { scope: 'localMachine', key: `HKLM\\${SHELL_IDS}`, values: ['ExecutionPolicy'] },
];

/** Per-query cap. The whole probe is also bounded by PROBE_BUDGET_MS. */
const REG_TIMEOUT_MS = 800;
/** Upper bound on the one synchronous probe that can sit on a spawn path. */
const PROBE_BUDGET_MS = 1000;
/** After this, a spawn still uses the cached answer but refreshes it in the background. */
const CACHE_TTL_MS = 60_000;

export const REMOTE_SIGNED_ARGS: readonly string[] = ['-ExecutionPolicy', 'RemoteSigned'];

/**
 * True only for Windows PowerShell 5.1 (`powershell.exe`), never pwsh 7.
 * Splits on both separators and drops `.exe`, the same way buildExecArgs
 * classifies a shell, so a Windows path is recognised on any host.
 */
export function isWindowsPowerShell(shellPath: string): boolean {
  const stem = (shellPath.split(/[\\/]/).pop() ?? '')
    .toLowerCase()
    .replace(/^-/, '')
    .replace(/\.exe$/, '');
  return stem === 'powershell';
}

/**
 * Classify one `reg query <key>` stdout against the value names that make a
 * scope "set". A value of `Undefined` means nothing is set at that scope.
 */
export function parseRegQuery(stdout: string, values: readonly string[]): ScopeState {
  for (const name of values) {
    const re = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(\\S+)\\s*$`, 'im');
    const m = re.exec(stdout);
    if (m && m[1].toLowerCase() !== 'undefined') return 'set';
  }
  return 'unset';
}

/** Factory default = every scope positively known to be unset. Unknown is never default. */
export function isFactoryDefault(scopes: PolicyScopes): boolean {
  return Object.values(scopes).every((s) => s === 'unset');
}

function regExe(): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
}

function classifyRegFailure(err: unknown): ScopeState {
  // reg.exe exits 1 when the key does not exist. Anything else (timeout kill,
  // spawn failure, access denied) is a real "cannot tell".
  const e = err as { status?: unknown; code?: unknown; killed?: boolean; signal?: unknown };
  if ((e.status === 1 || e.code === 1) && !e.killed && !e.signal) return 'unset';
  return 'unknown';
}

function readScopesSync(): PolicyScopes {
  const started = Date.now();
  const out = {} as PolicyScopes;
  for (const q of POLICY_QUERIES) {
    const remaining = PROBE_BUDGET_MS - (Date.now() - started);
    if (remaining <= 0) {
      out[q.scope] = 'unknown';
      continue;
    }
    try {
      const stdout = execFileSync(regExe(), ['query', q.key], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: Math.min(REG_TIMEOUT_MS, remaining),
        windowsHide: true,
      });
      out[q.scope] = parseRegQuery(stdout, q.values);
    } catch (err) {
      out[q.scope] = classifyRegFailure(err);
    }
  }
  return out;
}

async function readScopesAsync(): Promise<PolicyScopes> {
  const entries = await Promise.all(POLICY_QUERIES.map((q) => new Promise<[keyof PolicyScopes, ScopeState]>((resolve) => {
    execFile(regExe(), ['query', q.key], { encoding: 'utf8', timeout: REG_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => resolve([q.scope, err ? classifyRegFailure(err) : parseRegQuery(stdout, q.values)]));
  })));
  return Object.fromEntries(entries) as unknown as PolicyScopes;
}

interface TestOverride {
  scopes: PolicyScopes;
  platform?: NodeJS.Platform;
}

let override: TestOverride | null = null;
let cached: { factoryDefault: boolean; at: number } | null = null;
let refreshing = false;

function platform(): NodeJS.Platform {
  return override?.platform ?? process.platform;
}

function currentFactoryDefault(): boolean {
  if (override) return isFactoryDefault(override.scopes);
  const now = Date.now();
  if (!cached) {
    cached = { factoryDefault: isFactoryDefault(readScopesSync()), at: now };
    return cached.factoryDefault;
  }
  if (now - cached.at > CACHE_TTL_MS && !refreshing) {
    refreshing = true;
    void readScopesAsync()
      .then((scopes) => { cached = { factoryDefault: isFactoryDefault(scopes), at: Date.now() }; })
      .catch(() => { /* keep the previous answer */ })
      .finally(() => { refreshing = false; });
  }
  return cached.factoryDefault;
}

/**
 * Extra argv for a PowerShell spawn. Must be placed BEFORE `-Command`: every
 * token after `-Command` is part of the command string.
 */
export function windowsPowerShellPolicyArgs(shellPath: string): string[] {
  if (platform() !== 'win32' || !isWindowsPowerShell(shellPath)) return [];
  return currentFactoryDefault() ? [...REMOTE_SIGNED_ARGS] : [];
}

/** Test seam: pin the probed scopes (and optionally the platform). `null` restores the real probe. */
export function __setPolicyProbeForTests(next: TestOverride | null): void {
  override = next;
  cached = null;
  refreshing = false;
}

export const FACTORY_DEFAULT_SCOPES: PolicyScopes = Object.freeze({
  machinePolicy: 'unset', userPolicy: 'unset', currentUser: 'unset', localMachine: 'unset',
}) as PolicyScopes;
