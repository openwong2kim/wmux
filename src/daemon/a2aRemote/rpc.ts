import type { A2aPeerRecordV1, A2aRemoteHostRecordV1, HostId, PeerCredential } from '../../shared/a2aRemote';
import type { A2aRemoteHostsRemoveResult } from '../../shared/rpc';
import type { A2aRemoteController } from './controller';
import { coerceA2aRemotePatch } from './controller';
import { joinRemoteHost, unpairRemoteHost, type JoinDeps } from './joiner';
import type { NewRemoteHost } from './remoteHostStore';
import type { A2aServer } from './server';

/**
 * `a2a.remote.*` — the machine-local control-pipe RPCs behind Settings → LAN.
 * Never registered on the A2A listener itself, and `wmux.internal` in the
 * capability map, so no plugin or MCP caller reaches them.
 */

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

export interface A2aRemoteRpcDeps {
  controller: A2aRemoteController;
  server: A2aServer;
  peers: { list(): A2aPeerRecordV1[]; revoke(peerId: string): boolean };
  remoteHosts: {
    list(): A2aRemoteHostRecordV1[];
    get(hostId: HostId): A2aRemoteHostRecordV1 | undefined;
    credentialFor(hostId: HostId): PeerCredential | null;
    remove(hostId: HostId): boolean;
    add(input: NewRemoteHost, credential: PeerCredential): A2aRemoteHostRecordV1;
  };
  /** End every link to `hostId` and drop what it could see (`forgetHostCascade`). */
  cascade: (hostId: HostId) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Test seam for the joiner. */
  joinOverrides?: Partial<JoinDeps>;
  /** Test seam; default `unpairRemoteHost`. */
  unpair?: (host: A2aRemoteHostRecordV1, credential: PeerCredential) => Promise<boolean>;
}

/**
 * The revoke cascade for one host, used wherever a pairing ends (peer revoke,
 * re-pair, unpair, host remove). Each step on its own, so a failed write in
 * one does not hide the other.
 */
export function forgetHostCascade(
  stores: { links: { forgetHost(hostId: HostId): number }; exposures: { forgetHost(hostId: HostId): boolean } },
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): (hostId: HostId) => void {
  return (hostId) => {
    try {
      stores.links.forgetHost(hostId);
    } catch (err) {
      log('error', `[a2a-remote] revoke cascade: links for ${hostId}: ${errMsg(err)}`);
    }
    try {
      stores.exposures.forgetHost(hostId);
    } catch (err) {
      log('error', `[a2a-remote] revoke cascade: exposure for ${hostId}: ${errMsg(err)}`);
    }
  };
}

export function registerA2aRemoteRpc(onRpc: (method: string, handler: RpcHandler) => void, deps: A2aRemoteRpcDeps): void {
  const { controller, server } = deps;
  const str = (params: Record<string, unknown>, key: string): string =>
    typeof params[key] === 'string' ? (params[key] as string) : '';

  onRpc('a2a.remote.status', async () => server.status());
  onRpc('a2a.remote.configure', async (params) => {
    controller.configure(coerceA2aRemotePatch(params));
    // Answer with the listener's state after the start/stop/rebind ran.
    await server.whenIdle();
    return server.status();
  });

  onRpc('a2a.remote.pair.begin', async () => server.beginPairing());
  onRpc('a2a.remote.pair.cancel', async () => {
    server.cancelPairing();
    return { ok: true };
  });
  onRpc('a2a.remote.pair.status', async () => server.pairingStatus());

  onRpc('a2a.remote.join', async (params) =>
    joinRemoteHost(str(params, 'invite'), {
      self: () => server.ensureIdentity(),
      selfName: server.name(),
      remoteHosts: deps.remoteHosts,
      ...deps.joinOverrides,
    }),
  );

  onRpc('a2a.remote.hosts.list', async () => ({ hosts: deps.remoteHosts.list() }));
  onRpc('a2a.remote.hosts.remove', async (params): Promise<A2aRemoteHostsRemoveResult> => {
    const hostId = str(params, 'hostId');
    const host = deps.remoteHosts.get(hostId);
    const credential = deps.remoteHosts.credentialFor(hostId);
    if (!host || !credential) return { ok: false, remoteRevoked: false };
    // Tell the other PC first (best effort); remove here whatever it answers.
    const remoteRevoked = await (deps.unpair ?? unpairRemoteHost)(host, credential).catch(() => false);
    const ok = deps.remoteHosts.remove(hostId);
    deps.cascade(hostId);
    return { ok, remoteRevoked };
  });

  onRpc('a2a.remote.peers.list', async () => ({ peers: deps.peers.list() }));
  onRpc('a2a.remote.peers.revoke', async (params) => {
    const peerId = str(params, 'peerId');
    const rec = deps.peers.list().find((p) => p.peerId === peerId);
    if (!rec) return { ok: false };
    const revoked = deps.peers.revoke(peerId);
    // Revoke cascade: end every link to that host and drop what it could see.
    deps.cascade(rec.hostId);
    return { ok: revoked };
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
