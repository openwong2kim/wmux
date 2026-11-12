import { sendRequest, sendDaemonRequest, isDefinitelyNotRunning } from '../client';
import { parseFlag } from '../utils';
import { resolveSelfContext, getParentPidDefault } from '../identity';
import { A2A_SPAWN_PIPE_RPC, type A2aSpawnAskResult, type A2aSpawnOutgoingList } from '../../shared/a2aSpawn';
import { INVITE_CODE_RE, isHostId, type A2aPeerRecordV1, type A2aRemoteHostRecordV1 } from '../../shared/a2aRemote';
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

  join, peers and unpair talk to the wmux daemon directly, so they work on
  a host that runs only the daemon (no desktop app). Exit code 1 on any
  failure. --json prints the raw RPC payload.
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
 * One call on the daemon control pipe (no desktop app needed). Exits 1 with a
 * readable line on a transport or pipe-level failure; a timeout is passed to
 * `onTimeout` when given, because the daemon may still finish the call.
 */
async function daemonCall(method: RpcMethod, params: Record<string, unknown>, onTimeout?: () => never): Promise<unknown> {
  let response: RpcResponse;
  try {
    response = await sendDaemonRequest(method, params);
  } catch (err) {
    if (isDefinitelyNotRunning(err)) console.error(`Error: ${DAEMON_NOT_RUNNING}`);
    else if (onTimeout && err instanceof Error && /timed out/i.test(err.message)) onTimeout();
    else console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!response.ok) {
    console.error(/^Unknown method/.test(response.error ?? '')
      ? 'Error: pairing between PCs is not available in this wmux daemon (it is older, or that part failed to start; see its log).'
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
  const code = /\/([^/#?\s]+)#sha256=/.exec(invite)?.[1];
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
  })) as A2aRemoteJoinResult;
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
  const { hosts } = (await daemonCall('a2a.remote.hosts.list', {})) as { hosts?: A2aRemoteHostRecordV1[] };
  const { peers } = (await daemonCall('a2a.remote.peers.list', {})) as { peers?: A2aPeerRecordV1[] };
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
  const hostId = args.find((a) => !a.startsWith('-'));
  if (!hostId || !isHostId(hostId)) {
    console.error('Usage: wmux remote unpair <host-id>   (the host id `wmux remote peers` shows)');
    process.exit(1);
  }
  const removed = (await daemonCall('a2a.remote.hosts.remove', { hostId }, () => {
    console.error('Error: no answer from the daemon in time. Run `wmux remote peers` to see whether the pairing is gone.');
    process.exit(1);
  })) as A2aRemoteHostsRemoveResult;
  const { peers } = (await daemonCall('a2a.remote.peers.list', {})) as { peers?: A2aPeerRecordV1[] };
  let peersRevoked = 0;
  for (const p of (peers ?? []).filter((x) => x.hostId === hostId && !x.revokedAt)) {
    const r = (await daemonCall('a2a.remote.peers.revoke', { peerId: p.peerId })) as { ok?: boolean };
    if (r.ok) peersRevoked += 1;
  }
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
  console.log(REMOTE_HELP);
}
