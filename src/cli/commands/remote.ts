import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { sendRequest, sendDaemonRequest, isDefinitelyNotRunning } from '../client';
import { parseFlag, hasFlag } from '../utils';
import { resolveSelfContext, getParentPidDefault } from '../identity';
import { resolveSenderPtyId } from './channel';
import {
  A2A_SPAWN_PIPE_RPC,
  A2A_SPAWN_RPC,
  coerceSpawnPolicy,
  isSpawnableAgent,
  normalizeSpawnSub,
  spawnRuleMatches,
  SPAWN_LABEL_MAX,
  SPAWN_ROOTS_MAX,
  SPAWN_RULES_MAX,
  type A2aSpawnAskResult,
  type A2aSpawnFollowUps,
  type A2aSpawnOutgoingList,
  type A2aSpawnPermissionMode,
  type A2aSpawnPolicySetResult,
  type A2aSpawnPolicyV1,
} from '../../shared/a2aSpawn';
import { INVITE_CODE_RE, isHostId, parseInvite, type A2aPeerRecordV1, type A2aRemoteHostRecordV1, type HostId } from '../../shared/a2aRemote';
import { AGENT_ROWS, agentLauncherStem, agentRow, type AgentSlug } from '../../shared/agentIdentity';
import { NOT_FIRST_PARTY } from '../../shared/daemonFirstParty';
import { isNestingMarker } from '../../shared/envFilter';
import { getExecEnv } from '../../shared/execEnv';
import { FANOUT_WORKER_PERMISSION_MODES, isFanoutWorkerPermissionMode } from '../../shared/workerLaunch';
import type { A2aRemoteHostsRemoveResult, A2aRemoteJoinError, A2aRemoteJoinResult, RpcMethod, RpcResponse } from '../../shared/rpc';

export const REMOTE_HELP = `
wmux remote — pair with other PCs and ask them to start agents

  wmux remote spawn <pc> --agent <slug> --root <id> [--sub <path>] [--hours <1-72>] [--] <prompt…>
      Ask <pc> (its name here, or its host id) to start <slug> in folder <id>
      (and <path> under it). The agent's replies come to this pane as a task.
      That PC decides on its own card or rule; when it is off, the request
      waits for it (24 hours unless --hours says otherwise).
  wmux remote spawn-status [<spawnId>]
      Your requests and their state, and what each paired PC lets you ask for.

  wmux remote join <invite | ->
      Join the invite made on another PC (Settings → LAN there). Pass - to
      read the invite from stdin so it stays out of your shell history.
      This PC only connects out; it does not start listening.
  wmux remote peers
      PCs this PC joined (host id, name, certificate fingerprint) and PCs
      that joined this PC.
  wmux remote unpair <host-id>
      End the pairing with that PC: forget a PC this PC joined (telling it,
      when it answers) and revoke that PC if it joined this one.

  wmux remote allow --from <host-id> --root <dir> --agent <name> [--sub <path>]
                    [--follow-ups ask|direct] [--permission-mode <mode> [--bypass-permissions]]
      Let that PC start <name> in <dir> (a git repository's top level) with
      prompts it writes, without asking here each time. A rule covers exactly
      the folder given: <dir>, or <dir>/<path> with --sub, not the folders
      below it. Turns remote spawn on and sets approval to the allow list.
      Follow-ups and the permission mode apply to every allowed PC and change
      only when passed; bypassPermissions also needs --bypass-permissions.
      Asks you to type yes first, so run it in a terminal, not from an agent.
  wmux remote allowed
      What this PC lets other PCs start: the policy-wide settings, the
      folders and agents, and each PC's rules.
  wmux remote revoke --from <host-id> [--root <dir>] [--sub <path>]
      Remove that PC's rules for <dir> (only <dir>/<path> with --sub). With
      --from alone, that PC may no longer ask this PC to start agents.

  These verbs talk to the wmux daemon directly, so they work on a host that
  runs only the daemon (no desktop app). Exit code 1 on any failure. --json
  prints the raw RPC payload.
`;

/** The verified pane identity (PID walk), or ''. The env hint is not used: main resolves the caller from it. */
async function senderPtyId(): Promise<string> {
  try {
    const ctx = await resolveSelfContext({ sendRequest, env: process.env, ppid: process.ppid, getParentPid: getParentPidDefault });
    return ctx.ptyId ?? '';
  } catch {
    return '';
  }
}

async function call(method: RpcMethod, params: Record<string, unknown>, jsonMode: boolean): Promise<Record<string, unknown>> {
  let response: RpcResponse;
  try {
    response = await sendRequest(method, params);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!response.ok) {
    console.error(`Error: ${response.error}`);
    process.exit(1);
  }
  const result = (response.result ?? {}) as Record<string, unknown>;
  if (result['ok'] === false && jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  if (result['ok'] === false) {
    const err = result['error'];
    const text = typeof err === 'string'
      ? `${err}${typeof result['message'] === 'string' ? `: ${result['message']}` : ''}`
      : `[${(err as { code?: string })?.code ?? 'UNKNOWN'}] ${(err as { message?: string })?.message ?? 'refused'}`;
    console.error(`Error: ${text}`);
    process.exit(1);
  }
  return result;
}

const DAEMON_NOT_RUNNING = 'wmux daemon is not running. Start it with `wmux daemon start`.';

/**
 * Calls the daemon may work on for longer than the CLI's default wait: pairing
 * contacts the other PC, and a policy save checks every folder (its own budget
 * is 25 s). Matches the desktop app's wait.
 */
const SLOW_DAEMON_CALL_MS = 30_000;

/**
 * One call on the daemon control pipe (no desktop app needed). Exits 1 with a
 * readable line on a transport or pipe-level failure; a timeout is passed to
 * `onTimeout` when given, because the daemon may still finish the call.
 */
/** What a `not_first_party` refusal means, by whether the call came from a pane. */
export const REFUSED_FROM_PANE = 'these commands are not accepted from inside a wmux pane. Run them in a terminal outside wmux.';
export const REFUSED_APP_ONLY = 'this wmux daemon takes pairing and remote spawn settings only from the desktop app. On a PC that runs the desktop app, pairing and the allow rules are managed from the app\'s Remote page.';

/** This command's pane identity (PID walk, then the env hint), resolved once per command. */
let senderPty: Promise<string> | null = null;

async function daemonCall(method: RpcMethod, rawParams: Record<string, unknown>, onTimeout?: () => never, timeoutMs?: number): Promise<unknown> {
  // From inside a pane, say so: the daemon refuses these calls from one.
  senderPty ??= resolveSenderPtyId();
  const pty = await senderPty;
  const params = pty ? { ...rawParams, senderPtyId: pty } : rawParams;
  let response: RpcResponse;
  try {
    response = await (timeoutMs === undefined ? sendDaemonRequest(method, params) : sendDaemonRequest(method, params, timeoutMs));
  } catch (err) {
    if (isDefinitelyNotRunning(err)) console.error(`Error: ${DAEMON_NOT_RUNNING}`);
    else if (onTimeout && err instanceof Error && /timed out/i.test(err.message)) onTimeout();
    else console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!response.ok) {
    console.error(/^Unknown method/.test(response.error ?? '')
      ? 'Error: pairing between PCs is not available in this wmux daemon (it is older, or that part failed to start; see its log).'
      : response.code === NOT_FIRST_PARTY || (response.error ?? '').startsWith(`${NOT_FIRST_PARTY}:`)
        // The daemon's text is the same for both refusals; what this call sent tells them apart.
        ? `Error: ${pty ? REFUSED_FROM_PANE : REFUSED_APP_ONLY}`
        : `Error: ${response.error}`);
    process.exit(1);
  }
  return response.result ?? {};
}

const JOIN_ERRORS: Record<A2aRemoteJoinError, string> = {
  'invite-invalid': 'that is not a wmux invite. Copy the whole wmux-a2a://… line again',
  self: 'the invite was made on this PC',
  'fingerprint-mismatch': 'the PC answered with another certificate. Make a new invite there',
  'connect-refused': 'the PC refused the connection. Check that its invite is still open and the port is reachable',
  timeout: 'the PC did not answer in time. Check the network or a firewall between the two PCs',
  'not-found': 'the host name in the invite does not resolve from here',
  'code-expired': 'the invite expired or was cancelled. Make a new invite',
  'code-invalid': 'the invite code does not match the PC\'s open invite. Make a new invite',
  'already-paired': 'another pairing for this PC was in progress there. Try again',
  'rate-limited': 'too many failed attempts from this PC',
  protocol: 'the PC answered something this version does not understand. Update wmux on both PCs',
  failed: 'pairing failed',
};

/** Text with the invite, and its code, cut out: neither is ever printed back. */
function redactInvite(text: string, invite: string): string {
  const parsed = parseInvite(invite);
  const code = parsed.ok ? parsed.invite.code : /\/([A-HJ-NP-Z2-9]{8})(?=[#/?\s]|$)/.exec(invite)?.[1];
  let out = text.split(invite).join('<invite>');
  if (code && INVITE_CODE_RE.test(code)) out = out.split(code).join('<code>');
  return out;
}

function joinErrorText(r: Extract<A2aRemoteJoinResult, { ok: false }>, invite: string): string {
  const base = JOIN_ERRORS[r.error] ?? `pairing failed (${String(r.error)})`;
  const wait = r.error === 'rate-limited' && typeof r.retryAfterMs === 'number'
    ? `. Try again in ${Math.max(1, Math.ceil(r.retryAfterMs / 1000))} s` : '';
  // `invite-invalid` details name only the field that failed to parse, never its value.
  const detail = r.detail && r.error !== 'invite-invalid' ? ` (${redactInvite(r.detail, invite)})` : '';
  return `${base}${wait}${detail}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

async function remoteJoin(args: string[], jsonMode: boolean): Promise<void> {
  const arg = args.find((a) => a === '-' || !a.startsWith('-'));
  if (!arg) {
    console.error('Usage: wmux remote join <invite | ->');
    process.exit(1);
  }
  const invite = (arg === '-' ? await readStdin() : arg).trim();
  if (!invite) {
    console.error('Error: no invite given.');
    process.exit(1);
  }
  const result = (await daemonCall('a2a.remote.join', { invite }, () => {
    console.error('Error: no answer from the daemon in time. The pairing may still have completed: run `wmux remote peers` before trying again.');
    process.exit(1);
  }, SLOW_DAEMON_CALL_MS)) as A2aRemoteJoinResult;
  if (jsonMode) {
    console.log(redactInvite(JSON.stringify(result, null, 2), invite));
    if (!result.ok) process.exit(1);
    return;
  }
  if (!result.ok) {
    console.error(`Error: ${joinErrorText(result, invite)}`);
    process.exit(1);
  }
  console.log(`Paired with ${result.host.name || result.host.hostId} (${result.host.hostId}).`);
  console.log(`Fingerprint: ${result.host.fingerprint256}`);
}

async function remotePeers(jsonMode: boolean): Promise<void> {
  const [{ hosts }, { peers }] = (await Promise.all([
    daemonCall('a2a.remote.hosts.list', {}),
    daemonCall('a2a.remote.peers.list', {}),
  ])) as [{ hosts?: A2aRemoteHostRecordV1[] }, { peers?: A2aPeerRecordV1[] }];
  const joined = hosts ?? [];
  const joinedUs = peers ?? [];
  if (jsonMode) {
    console.log(JSON.stringify({ hosts: joined, peers: joinedUs }, null, 2));
    return;
  }
  console.log('PCs this PC joined:');
  if (joined.length === 0) console.log('  none');
  for (const h of joined) {
    console.log(`  ${h.hostId}  ${h.name || '-'}  ${h.fingerprint256}${h.lastSeenAt ? `  last seen ${h.lastSeenAt}` : ''}`);
  }
  console.log('PCs that joined this PC:');
  if (joinedUs.length === 0) console.log('  none');
  for (const p of joinedUs) {
    console.log(`  ${p.hostId}  ${p.name || '-'}${p.revokedAt ? '  (revoked)' : ''}${p.lastSeenAt ? `  last seen ${p.lastSeenAt}` : ''}`);
  }
}

async function remoteUnpair(args: string[], jsonMode: boolean): Promise<void> {
  const hostId = args.find((a) => !a.startsWith('-'))?.toLowerCase();
  if (!hostId || !isHostId(hostId)) {
    console.error('Usage: wmux remote unpair <host-id>   (the host id `wmux remote peers` shows)');
    process.exit(1);
  }
  // Revoke that PC's access here first: it is local and quick, while the host
  // removal below contacts the other PC and may outlast the CLI's wait.
  const { peers } = (await daemonCall('a2a.remote.peers.list', {})) as { peers?: A2aPeerRecordV1[] };
  let peersRevoked = 0;
  for (const p of (peers ?? []).filter((x) => x.hostId === hostId && !x.revokedAt)) {
    const r = (await daemonCall('a2a.remote.peers.revoke', { peerId: p.peerId })) as { ok?: boolean };
    if (r.ok) peersRevoked += 1;
  }
  const removed = (await daemonCall('a2a.remote.hosts.remove', { hostId }, () => {
    console.error(`Error: no answer from the daemon in time${peersRevoked > 0 ? ` (${hostId}'s access to this PC is already revoked)` : ''}. Run \`wmux remote peers\` to see whether the pairing is gone.`);
    process.exit(1);
  }, SLOW_DAEMON_CALL_MS)) as A2aRemoteHostsRemoveResult;
  const ok = removed.ok === true || peersRevoked > 0;
  const out = { ok, hostId, hostRemoved: removed.ok === true, remoteRevoked: removed.remoteRevoked === true, peersRevoked };
  if (jsonMode) {
    console.log(JSON.stringify(out, null, 2));
    if (!ok) process.exit(1);
    return;
  }
  if (!ok) {
    console.error(`Error: ${hostId} is not paired with this PC.`);
    process.exit(1);
  }
  if (out.hostRemoved) {
    console.log(out.remoteRevoked
      ? `Unpaired from ${hostId}; that PC removed this one too.`
      : `Unpaired from ${hostId} here. That PC did not confirm (off or unreachable); remove this PC there as well.`);
  }
  if (peersRevoked > 0) console.log(`Revoked ${hostId}'s access to this PC.`);
}

// ─── Remote spawn policy: allow | allowed | revoke ──────────────────────────
//
// The same policy the desktop's Settings › LAN edits, read and saved on the
// daemon pipe. A save carries the version it read; the daemon refuses it as a
// `conflict` when anything else saved meanwhile, and these verbs then read it
// again and re-apply their change.

/** Terminal input, replaced in tests. */
export const policyIo = {
  stdinIsTty: (): boolean => process.stdin.isTTY === true,
  ask: async (question: string, toStderr = false): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: toStderr ? process.stderr : process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
};

const CONFIRM_WORD = 'yes';
const SAVE_ATTEMPTS = 3;

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

/** A name another PC chose, safe to print: control characters removed. */
function printable(s: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

interface KnownPc {
  hostId: HostId;
  name: string;
  /** Known for a PC this PC joined; a PC that joined this one has none recorded here. */
  fingerprint?: string;
}

/** Every PC `wmux remote peers` lists (not revoked), one per host id. */
async function knownPcs(): Promise<KnownPc[]> {
  const [{ hosts }, { peers }] = (await Promise.all([
    daemonCall('a2a.remote.hosts.list', {}),
    daemonCall('a2a.remote.peers.list', {}),
  ])) as [{ hosts?: A2aRemoteHostRecordV1[] }, { peers?: A2aPeerRecordV1[] }];
  const byId = new Map<string, KnownPc>();
  for (const h of hosts ?? []) byId.set(h.hostId, { hostId: h.hostId, name: h.name, fingerprint: h.fingerprint256 });
  for (const p of peers ?? []) {
    if (!p.revokedAt && !byId.has(p.hostId)) byId.set(p.hostId, { hostId: p.hostId, name: p.name });
  }
  return [...byId.values()];
}

/**
 * The PC `--from` names. A host id is taken only as an id. A name (chosen by
 * the other PC) must match exactly one listed PC, and is reported as `byName`
 * so the caller shows its host id and fingerprint before going on.
 */
function resolvePc(from: string, pcs: KnownPc[], alsoIds: readonly string[] = []): { pc: KnownPc; byName: boolean } {
  const id = from.toLowerCase();
  if (isHostId(id)) {
    const pc = pcs.find((p) => p.hostId === id) ?? (alsoIds.includes(id) ? { hostId: id, name: '' } : undefined);
    if (!pc) fail(`${id} is not a PC paired with this one. Run \`wmux remote peers\` for the host ids.`);
    return { pc, byName: false };
  }
  const matches = pcs.filter((p) => p.name === from);
  if (matches.length === 0) fail(`no paired PC has the host id or name "${printable(from)}". Run \`wmux remote peers\` and pass the host id.`);
  if (matches.length > 1) fail(`${matches.length} paired PCs are named "${printable(from)}". Pass the host id instead (\`wmux remote peers\`).`);
  return { pc: matches[0], byName: true };
}

function pcLabel(pc: KnownPc): string {
  const name = printable(pc.name);
  return name ? `${name} (${pc.hostId})` : pc.hostId;
}

async function readPolicy(): Promise<A2aSpawnPolicyV1> {
  const r = (await daemonCall(A2A_SPAWN_RPC.policyGet, {})) as { policy?: unknown };
  const policy = coerceSpawnPolicy(r.policy);
  if (!policy) fail('the daemon returned a remote spawn policy this version does not understand. Update wmux.');
  return policy;
}

async function savePolicy(policy: A2aSpawnPolicyV1, check: string): Promise<A2aSpawnPolicySetResult> {
  return (await daemonCall(A2A_SPAWN_RPC.policySet, { policy }, () => {
    console.error(`Error: no answer from the daemon in time. The change may still have been saved: run \`wmux remote allowed\` to ${check}.`);
    process.exit(1);
  }, SLOW_DAEMON_CALL_MS)) as A2aSpawnPolicySetResult;
}

/** Same folder: exact, except on Windows whose file systems ignore case. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => path.resolve(p);
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** The repository top level of `dir` (as git prints it), or null when it is not in one or git cannot run. */
function gitToplevel(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-C', dir, 'rev-parse', '--show-toplevel'], { env: getExecEnv(), timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
}

/** `--root` as the daemon will store it (realpath), checked to be a git top level. */
async function resolveRoot(dir: string): Promise<string> {
  let real: string;
  try {
    real = fs.realpathSync.native(path.resolve(dir));
  } catch {
    fail(`${dir} does not exist.`);
  }
  if (!fs.statSync(real).isDirectory()) fail(`${dir} is not a folder.`);
  const top = await gitToplevel(real);
  let topReal: string | null = null;
  try {
    topReal = top ? fs.realpathSync.native(top) : null;
  } catch { /* treated as not a top level */ }
  if (!topReal || !samePath(topReal, real)) {
    fail(`${dir} is not the top level of a git repository. Agents started from another PC work in a fresh worktree of one; pass the repository's top folder${topReal ? ` (${topReal})` : ''}.`);
  }
  return real;
}

/**
 * An id for a new folder: its name, with a random suffix so a folder added
 * later never takes the id (and so the rules) of one removed.
 */
function newRootId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 25).replace(/-+$/, '') || 'folder';
  for (;;) {
    const suffix = Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[randomInt(36)]).join('');
    const id = `${base}-${suffix}`;
    if (!taken.includes(id)) return id;
  }
}

export function rootLabel(real: string): string {
  // Whole code points, within the daemon's limit in UTF-16 units: a character
  // outside the BMP is never cut in half, and the label never runs long.
  let label = '';
  for (const ch of printable(path.basename(real)).trim()) {
    if (label.length + ch.length > SPAWN_LABEL_MAX) break;
    label += ch;
  }
  return label || 'folder';
}

/** Whether `agent`'s launcher is on this shell's PATH; undefined when that cannot be told (Windows). */
function agentOnPath(agent: AgentSlug): boolean | undefined {
  const row = agentRow(agent);
  if (!row || process.platform === 'win32') return undefined;
  const stem = agentLauncherStem(row);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    try {
      fs.accessSync(path.join(dir, stem), fs.constants.X_OK);
      if (fs.statSync(path.join(dir, stem)).isFile()) return true;
    } catch { /* not here */ }
  }
  return false;
}

interface AllowChange {
  hostId: HostId;
  rootPath: string;
  agent: AgentSlug;
  sub: string;
  followUps?: A2aSpawnFollowUps;
  permissionMode?: A2aSpawnPermissionMode;
}

/** `policy` with the allow-list rule added, as the desktop writes it; the root reused when listed. */
export function withAllowRule(policy: A2aSpawnPolicyV1, c: AllowChange, makeRootId = newRootId): A2aSpawnPolicyV1 {
  let root = policy.roots.find((r) => samePath(r.path, c.rootPath));
  const roots = [...policy.roots];
  if (!root) {
    const label = rootLabel(c.rootPath);
    root = { id: makeRootId(label, roots.map((r) => r.id)), label, path: c.rootPath };
    roots.push(root);
  }
  const rootId = root.id;
  const hasRule = policy.rules.some((r) => spawnRuleMatches(r, c.hostId, rootId, c.agent, c.sub));
  return {
    ...policy,
    enabled: true,
    approval: 'allow-list',
    followUps: c.followUps ?? policy.followUps,
    permissionMode: c.permissionMode ?? policy.permissionMode,
    hosts: { ...policy.hosts, [c.hostId]: { allowed: true } },
    roots,
    agents: policy.agents.includes(c.agent) ? policy.agents : [...policy.agents, c.agent],
    rules: hasRule ? policy.rules : [...policy.rules, { hostId: c.hostId, rootId, agent: c.agent, ...(c.sub ? { sub: c.sub } : {}) }],
  };
}

function folderText(rootPath: string, sub: string): string {
  return sub ? path.join(rootPath, ...sub.split('/')) : rootPath;
}

/**
 * What saving `next` over `before` means, in plain words: the statement a
 * person confirms. Built from the difference, so a policy-wide change the
 * flags did not name (turning the feature or the allow list on) is stated too.
 */
export function allowStatement(before: A2aSpawnPolicyV1, next: A2aSpawnPolicyV1, c: AllowChange, pc: KnownPc, pcs: KnownPc[]): string[] {
  const user = (() => {
    try { return os.userInfo().username; } catch { return 'the user running the wmux daemon'; }
  })();
  const lines = [
    `${pcLabel(pc)} will be able to start ${c.agent} in ${folderText(c.rootPath, c.sub)} with prompts it writes,`,
    'without a per-request approval on this PC. This rule covers that exact folder, not the folders below it.',
    `The agent runs as ${user}, with that account's access to this machine.`,
    `Agents started from another PC run in permission mode ${next.permissionMode}, and follow-ups from that PC ${next.followUps === 'direct' ? 'reach the agent directly' : 'wait for approval here'}.`,
  ];
  const wide: string[] = [];
  if (!before.enabled) wide.push('remote spawn turns on');
  if (before.approval !== next.approval) wide.push(`approval changes from ${before.approval} to ${next.approval}`);
  if (before.permissionMode !== next.permissionMode) wide.push(`permission mode changes from ${before.permissionMode} to ${next.permissionMode}`);
  if (before.followUps !== next.followUps) wide.push(`follow-ups change from ${before.followUps} to ${next.followUps}`);
  if (wide.length > 0) lines.push(`Policy-wide, applying to every allowed PC: ${wide.join('; ')}.`);
  const label = (id: string): string => pcLabel(pcs.find((p) => p.hostId === id) ?? { hostId: id, name: '' });
  const othersAllowed = Object.entries(next.hosts).filter(([id, h]) => h.allowed && id !== c.hostId).map(([id]) => id);
  if (!before.enabled && othersAllowed.length > 0) {
    lines.push(`These PCs, already allowed here, can send requests again: ${othersAllowed.map(label).join(', ')}.`);
  }
  if (!before.enabled || before.approval !== 'allow-list') {
    const ruled = othersAllowed.filter((id) => next.rules.some((r) => r.hostId === id));
    if (ruled.length > 0) lines.push(`The rules already saved for these PCs take effect too: ${ruled.map(label).join(', ')}.`);
  }
  const newRoot = next.roots.find((r) => !before.roots.some((b) => b.id === r.id));
  const newAgent = !before.agents.includes(c.agent);
  const otherAllowed = Object.entries(next.hosts).some(([id, h]) => h.allowed && id !== c.hostId);
  if ((newRoot || newAgent) && otherAllowed) {
    lines.push(`Every allowed PC will see ${[newRoot ? `the folder "${newRoot.label}"` : '', newAgent ? `the agent ${c.agent}` : ''].filter(Boolean).join(' and ')} in what it may ask for (still with approval here unless it has a rule).`);
  }
  return lines;
}

/** The policy without its version: what a save changes. */
function sameContent(a: A2aSpawnPolicyV1, b: A2aSpawnPolicyV1): boolean {
  return JSON.stringify({ ...a, version: 0 }) === JSON.stringify({ ...b, version: 0 });
}

/**
 * Who is at the keyboard is not something a CLI can prove; this keeps an
 * agent from writing the policy on its own initiative, and the typed
 * confirmation below needs a person in any case.
 */
function agentSessionMarker(env: NodeJS.ProcessEnv): string | undefined {
  if (env.WMUX_PTY_ID) return 'WMUX_PTY_ID';
  return Object.keys(env).find((k) => env[k] !== undefined && isNestingMarker(k));
}

/** A flag's value; exits when the flag is given without one (never read as "not given"). */
function flagValue(args: string[], flag: string): string | undefined {
  const v = parseFlag(args, flag);
  if (v === undefined && hasFlag(args, flag)) fail(`${flag} needs a value.`);
  return v;
}

const ALLOW_USAGE = 'Usage: wmux remote allow --from <host-id> --root <dir> --agent <name> [--sub <path>] [--follow-ups ask|direct] [--permission-mode <mode> [--bypass-permissions]]';

async function remoteAllow(args: string[], jsonMode: boolean): Promise<void> {
  const marker = agentSessionMarker(process.env);
  if (marker) fail(`\`wmux remote allow\` is not run from an agent session or a wmux pane (${marker} is set). A person must run it, in a terminal outside wmux.`);
  if (!policyIo.stdinIsTty()) fail('`wmux remote allow` asks for a typed confirmation. Run it in a terminal.');
  const from = flagValue(args, '--from');
  const rootArg = flagValue(args, '--root');
  const agentArg = flagValue(args, '--agent');
  if (!from || !rootArg || !agentArg) fail(ALLOW_USAGE.replace(/^Usage: /, 'usage: '));
  const sub = normalizeSpawnSub(flagValue(args, '--sub'));
  if (sub === null) fail('--sub must be a relative path below the root, without `..`, a drive or a backslash.');
  // An explicit --sub that names the root itself (`""`, `./`, an empty variable) is a mistake, not a grant of the root.
  if (sub === '' && hasFlag(args, '--sub')) fail('--sub names no folder below the root. Leave it out to allow the root itself.');
  if (!isSpawnableAgent(agentArg)) {
    const ok = AGENT_ROWS.filter((a) => isSpawnableAgent(a.slug)).map((a) => a.slug).join(', ');
    fail(`${agentArg} cannot be started from another PC. Agents that can: ${ok}.`);
  }
  const agent = agentArg;
  const followArg = flagValue(args, '--follow-ups');
  if (hasFlag(args, '--follow-ups') && followArg !== 'ask' && followArg !== 'direct') fail('--follow-ups takes ask or direct.');
  const modeArg = flagValue(args, '--permission-mode');
  if (hasFlag(args, '--permission-mode') && !isFanoutWorkerPermissionMode(modeArg)) {
    fail(`--permission-mode takes one of: ${FANOUT_WORKER_PERMISSION_MODES.join(', ')}.`);
  }
  if (modeArg === 'bypassPermissions' && !hasFlag(args, '--bypass-permissions')) {
    fail('bypassPermissions lets the agent run every tool without asking. To use it, pass --bypass-permissions as well.');
  }
  if (hasFlag(args, '--bypass-permissions') && modeArg !== 'bypassPermissions') fail('--bypass-permissions goes with --permission-mode bypassPermissions.');
  const rootPath = await resolveRoot(rootArg);
  const installed = agentOnPath(agent);
  if (installed === false) console.error(`Warning: ${agent} was not found on this shell's PATH. A request for it is refused until it is installed for the account the daemon runs as.`);

  // With --json, stdout carries only the result: what a person reads goes to stderr.
  const say = jsonMode ? console.error : console.log;
  const pcs = await knownPcs();
  const { pc, byName } = resolvePc(from, pcs);
  if (byName) {
    say(`"${printable(from)}" is ${pc.hostId}.`);
    say(`Certificate fingerprint: ${pc.fingerprint ?? 'none recorded here (that PC joined this one)'}`);
  }
  const change: AllowChange = {
    hostId: pc.hostId, rootPath, agent, sub,
    ...(followArg === 'ask' || followArg === 'direct' ? { followUps: followArg } : {}),
    ...(isFanoutWorkerPermissionMode(modeArg) ? { permissionMode: modeArg } : {}),
  };

  let confirmed: string | null = null;
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- each attempt needs the previous answer
    const before = await readPolicy();
    const next = withAllowRule(before, change);
    if (sameContent(before, next)) {
      if (jsonMode) console.log(JSON.stringify({ ok: true, changed: false, policy: before }, null, 2));
      else console.log(`Already allowed: ${pcLabel(pc)} may start ${agent} in ${folderText(rootPath, sub)}.`);
      return;
    }
    if (next.roots.length > SPAWN_ROOTS_MAX) fail(`this PC already lists ${SPAWN_ROOTS_MAX} folders, the most it can. Remove one in the desktop app first.`);
    if (next.rules.length > SPAWN_RULES_MAX) fail(`this PC already holds ${SPAWN_RULES_MAX} rules, the most it can. Revoke some first.`);
    const statement = allowStatement(before, next, change, pc, pcs).join('\n');
    if (confirmed === null) {
      say(statement);
      // eslint-disable-next-line no-await-in-loop -- one question, then the save
      const answer = (await policyIo.ask(`Type ${CONFIRM_WORD} to save this: `, jsonMode)).trim().toLowerCase();
      if (answer !== CONFIRM_WORD) fail('not confirmed; nothing was saved.');
      confirmed = statement;
    } else if (statement !== confirmed) {
      fail('the remote spawn settings changed while you were confirming, so what you confirmed no longer describes the change. Run the command again.');
    }
    // eslint-disable-next-line no-await-in-loop -- a retry needs the first answer
    const res = await savePolicy(next, 'check whether the rule is there');
    if (res.ok) {
      if (jsonMode) console.log(JSON.stringify({ ok: true, changed: true, policy: res.policy }, null, 2));
      else console.log(`Saved. ${pcLabel(pc)} may start ${agent} in ${folderText(rootPath, sub)} without approval here.`);
      return;
    }
    if (!res.conflict) fail(`the daemon did not save it: ${res.error}`);
  }
  fail('the remote spawn settings kept changing while saving. Run the command again.');
}

async function remoteAllowed(jsonMode: boolean): Promise<void> {
  if (jsonMode) {
    console.log(JSON.stringify({ policy: await readPolicy() }, null, 2));
    return;
  }
  const [policy, pcs] = await Promise.all([readPolicy(), knownPcs()]);
  const rootOf = (id: string): string => policy.roots.find((r) => r.id === id)?.path ?? id;
  console.log(`Remote spawn: ${policy.enabled ? 'on' : 'off'}`);
  console.log('For every allowed PC:');
  console.log(`  approval: ${policy.approval === 'allow-list' ? 'allow list (a matching rule starts the agent without asking here)' : 'ask here for each request'}`);
  console.log(`  follow-ups: ${policy.followUps === 'direct' ? 'reach the agent directly' : 'wait for approval here'}`);
  console.log(`  permission mode: ${policy.permissionMode}`);
  console.log('Folders:');
  if (policy.roots.length === 0) console.log('  none');
  for (const r of policy.roots) console.log(`  ${r.path}  (${printable(r.label)}, id ${r.id})`);
  console.log(`Agents: ${policy.agents.join(', ') || 'none'}`);
  console.log('PCs:');
  const ids = [...new Set([...Object.keys(policy.hosts), ...policy.rules.map((r) => r.hostId)])];
  if (ids.length === 0) console.log('  none');
  for (const id of ids) {
    const pc = pcs.find((p) => p.hostId === id) ?? { hostId: id, name: '' };
    console.log(`  ${pcLabel(pc)}: ${policy.hosts[id]?.allowed ? 'allowed' : 'not allowed'}`);
    const rules = policy.rules.filter((r) => r.hostId === id);
    if (rules.length === 0) console.log('    no rules');
    for (const r of rules) console.log(`    ${r.agent} in ${folderText(rootOf(r.rootId), r.sub ?? '')}`);
  }
}

/** `policy` without what `revoke` names; null when nothing matches. */
export function withoutRules(policy: A2aSpawnPolicyV1, hostId: HostId, rootIds: readonly string[] | null, sub: string | null): A2aSpawnPolicyV1 | null {
  if (rootIds === null) {
    if (!(hostId in policy.hosts) && !policy.rules.some((r) => r.hostId === hostId)) return null;
    const hosts = { ...policy.hosts };
    delete hosts[hostId];
    return { ...policy, hosts, rules: policy.rules.filter((r) => r.hostId !== hostId) };
  }
  const drop = (r: A2aSpawnPolicyV1['rules'][number]): boolean =>
    r.hostId === hostId && rootIds.includes(r.rootId) && (sub === null || (r.sub ?? '') === sub);
  if (!policy.rules.some(drop)) return null;
  return { ...policy, rules: policy.rules.filter((r) => !drop(r)) };
}

async function remoteRevoke(args: string[], jsonMode: boolean): Promise<void> {
  const from = flagValue(args, '--from');
  if (!from) fail('usage: wmux remote revoke --from <host-id> [--root <dir>] [--sub <path>]');
  const rootArg = flagValue(args, '--root');
  const subArg = flagValue(args, '--sub');
  if (subArg !== undefined && !rootArg) fail('--sub goes with --root.');
  const sub = subArg === undefined ? null : normalizeSpawnSub(subArg);
  if (sub === null && subArg !== undefined) fail('--sub must be a relative path below the root, without `..`, a drive or a backslash.');
  if (sub === '') fail('--sub names no folder below the root. Leave it out to revoke the rules for the whole folder.');
  const [pcs, firstRead] = await Promise.all([knownPcs(), readPolicy()]);
  let first = firstRead;
  const inPolicy = [...Object.keys(first.hosts), ...first.rules.map((r) => r.hostId)];
  const { pc, byName } = resolvePc(from, pcs, inPolicy);
  if (byName) (jsonMode ? console.error : console.log)(`"${printable(from)}" is ${pc.hostId}.`);
  // A folder that is gone from disk can still be named by the path it was saved under.
  let wanted: string | null = null;
  if (rootArg) {
    try { wanted = fs.realpathSync.native(path.resolve(rootArg)); } catch { wanted = path.resolve(rootArg); }
  }
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- each attempt needs the previous answer
    const policy = attempt === 0 ? first : await readPolicy();
    first = policy;
    const rootIds = wanted === null ? null : policy.roots.filter((r) => samePath(r.path, wanted as string) || r.id === rootArg).map((r) => r.id);
    const next = withoutRules(policy, pc.hostId, rootIds, sub);
    if (!next) fail(`nothing to revoke: ${pcLabel(pc)} has no ${rootArg ? `rule for ${rootArg}${sub ? ` (${sub})` : ''}` : 'allowance'} here.`);
    // eslint-disable-next-line no-await-in-loop -- a retry needs the first answer
    const res = await savePolicy(next, 'check whether it is gone');
    if (res.ok) {
      if (jsonMode) {
        console.log(JSON.stringify({ ok: true, policy: res.policy }, null, 2));
        return;
      }
      const removed = policy.rules.length - next.rules.length;
      console.log(rootIds === null
        ? `${pcLabel(pc)} may no longer ask this PC to start agents (${removed} rule${removed === 1 ? '' : 's'} removed).`
        : `Removed ${removed} rule${removed === 1 ? '' : 's'} for ${pcLabel(pc)}.`);
      // The last rule went (with --from alone, often with the last allowed PC too).
      if (removed > 0 && res.policy.approval === 'allow-list' && res.policy.rules.length === 0) {
        const stillAllowed = res.policy.enabled && Object.values(res.policy.hosts).some((h) => h.allowed);
        console.log(stillAllowed
          ? 'Approval is still "allow list", and no rule is left: a request from a PC still allowed here waits for approval on this PC until it expires.'
          : 'Approval is still "allow list", and no rule is left: a PC allowed again later has its requests wait for approval on this PC until they expire, until a rule is added.');
      }
      return;
    }
    if (!res.conflict) fail(`the daemon did not save it: ${res.error}`);
  }
  fail('the remote spawn settings kept changing while saving. Run the command again.');
}

/** The prompt: everything after a bare `--`, else the words that are not flags or flag values. */
function promptOf(args: string[]): string {
  const dash = args.indexOf('--');
  if (dash !== -1) return args.slice(dash + 1).join(' ');
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (['--agent', '--root', '--sub', '--hours'].includes(args[i])) i += 1;
    else words.push(args[i]);
  }
  return words.join(' ');
}

export async function handleRemote(sub: string | undefined, args: string[], jsonMode: boolean): Promise<void> {
  senderPty = null;
  if (sub === 'spawn') {
    const pc = args[0] && !args[0].startsWith('-') ? args[0] : '';
    const rest = pc ? args.slice(1) : args;
    // Flags are read only before a bare `--`: the prompt may hold flag-like words.
    const before = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
    const agent = parseFlag(before, '--agent');
    const root = parseFlag(before, '--root');
    const prompt = promptOf(rest).trim();
    const hours = parseFlag(before, '--hours');
    if (!pc || !agent || !root || !prompt || (hours !== undefined && !/^\d+$/.test(hours))) {
      console.error('Usage: wmux remote spawn <pc> --agent <slug> --root <id> [--sub <path>] [--hours <1-72>] [--] <prompt…>');
      process.exit(1);
    }
    const pty = await senderPtyId();
    if (!pty) {
      console.error('Error: not inside a wmux pane (no resolvable pane identity). The replies go to the pane that asks, so run this from one.');
      process.exit(1);
    }
    const subPath = parseFlag(before, '--sub');
    const result = (await call(A2A_SPAWN_PIPE_RPC.spawn, {
      pc, agent, root, prompt, senderPtyId: pty,
      ...(subPath ? { sub: subPath } : {}),
      ...(hours ? { expiresInHours: Number(hours) } : {}),
    }, jsonMode)) as A2aSpawnAskResult;
    if (jsonMode || !result.ok) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const name = result.spawn.hostName ?? result.spawn.hostId;
    console.log(result.online
      ? `Sent to ${name} (${result.spawn.spawnId}). It answers once it decides.`
      : `${name} is off. wmux will try to deliver the request before ${new Date(result.spawn.expiresAt).toLocaleString()}; ${name} decides whether the agent starts. (${result.spawn.spawnId})`);
    return;
  }
  if (sub === 'spawn-status') {
    const spawnId = args[0] && !args[0].startsWith('-') ? args[0] : undefined;
    const result = (await call(A2A_SPAWN_PIPE_RPC.status, spawnId ? { spawnId } : {}, jsonMode)) as unknown as A2aSpawnOutgoingList;
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    for (const r of result.requests) {
      console.log(`${r.spawnId}  ${r.hostName ?? r.hostId}  ${r.agent} in ${r.rootId}${r.sub ? `/${r.sub}` : ''}  ${r.state}${r.code ? ` (${r.code})` : ''}`);
    }
    if (!spawnId) {
      for (const p of result.places) {
        const what = !p.supported ? 'cannot take requests'
          : !p.targets ? 'has not said what you may ask for'
          : `folders: ${p.targets.roots.map((x) => x.id).join(', ') || 'none'}; agents: ${p.targets.agents.join(', ') || 'none'}`;
        console.log(`${p.name ?? p.hostId}${p.online ? '' : ' (off)'}: ${what}`);
      }
    }
    return;
  }
  if (sub === 'join') return remoteJoin(args, jsonMode);
  if (sub === 'peers') return remotePeers(jsonMode);
  if (sub === 'unpair') return remoteUnpair(args, jsonMode);
  if (sub === 'allow') return remoteAllow(args, jsonMode);
  if (sub === 'allowed') return remoteAllowed(jsonMode);
  if (sub === 'revoke') return remoteRevoke(args, jsonMode);
  console.log(REMOTE_HELP);
}
