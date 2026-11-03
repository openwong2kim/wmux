import { A2A_REMOTE_DEFAULT_PORT, type A2aPeerRecordV1, type A2aRemoteHostRecordV1, type HostId, type PeerCredential } from '../../shared/a2aRemote';
import type {
  A2aDiscoverCloseResult,
  A2aDiscoverOutgoingCancelResult,
  A2aDiscoverOutgoingConfirmResult,
  A2aRemoteHostsRemoveResult,
} from '../../shared/rpc';
import type { A2aRemoteController } from './controller';
import { coerceA2aRemotePatch } from './controller';
import { DiscoverClient, type DiscoverClientDeps } from './discoverClient';
import { joinRemoteHost, unpairRemoteHost, type JoinDeps } from './joiner';
import type { NewRemoteHost } from './remoteHostStore';
import type { A2aServer } from './server';

/**
 * `a2a.remote.*` — the machine-local control-pipe RPCs behind Settings → LAN.
 * Never registered on the A2A listener itself, and `wmux.internal` in the
 * capability map, so no plugin or MCP caller reaches them.
 */

/** `ctx.clientId`: the control-pipe connection the call arrived on. */
type RpcHandler = (params: Record<string, unknown>, ctx?: { clientId: string }) => Promise<unknown>;

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
  /** Test seams for the requesting side of tailnet discovery. */
  discoverOverrides?: Partial<DiscoverClientDeps>;
}

/**
 * The revoke cascade for one host, used wherever a pairing ends (peer revoke,
 * re-pair, unpair, host remove). Each step on its own, so a failed write in
 * one does not hide the other.
 */
export function forgetHostCascade(
  stores: { links: { forgetHost(hostId: HostId): number }; exposures: { forgetHost(hostId: HostId): boolean }; offers?: { forgetHost(hostId: HostId): void } },
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): (hostId: HostId) => void {
  return (hostId) => {
    try {
      stores.offers?.forgetHost(hostId);
    } catch (err) {
      log('error', `[a2a-remote] revoke cascade: offers for ${hostId}: ${errMsg(err)}`);
    }
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

/** Registers the RPCs; answers the requesting side of tailnet discovery, whose requests end with the connection that made them. */
export function registerA2aRemoteRpc(onRpc: (method: string, handler: RpcHandler) => void, deps: A2aRemoteRpcDeps): { discover: DiscoverClient } {
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

  // Tailnet discovery, receiving side. `wmux.internal` keeps MCP and plugin
  // callers out; like `pair.begin`, any same-user process holding the daemon
  // auth token can call these. The window ends with the connection that
  // opened it (the app's dialog).
  onRpc('a2a.remote.discover.open', async (params, ctx) =>
    server.discovery.open({ turnOn: params['turnOn'] === true }, ctx?.clientId ?? null),
  );
  onRpc('a2a.remote.discover.close', async (): Promise<A2aDiscoverCloseResult> => {
    server.discovery.close('stopped');
    // Answer once a listener the window turned on has stopped again.
    await server.whenIdle();
    return server.discovery.status();
  });
  onRpc('a2a.remote.discover.status', async () => server.discovery.status());
  onRpc('a2a.remote.discover.decide', async (params) => {
    if (typeof params['allow'] !== 'boolean') throw new Error('a2a.remote.discover.decide: allow must be boolean');
    return server.discovery.decide(str(params, 'requestId'), params['allow']);
  });

  // Tailnet discovery, requesting side. `connect` takes only an IP from the
  // last scan; the port and the certificate to pin are what the scan saw.
  const discover = new DiscoverClient({
    tailnet: server.tailnet,
    self: () => server.ensureIdentity(),
    selfName: () => server.name(),
    ports: () => {
      const own = controller.effectivePort();
      return own === A2A_REMOTE_DEFAULT_PORT ? [own] : [A2A_REMOTE_DEFAULT_PORT, own];
    },
    remoteHosts: deps.remoteHosts,
    log: deps.log,
    ...deps.discoverOverrides,
  });
  onRpc('a2a.remote.discover.scan', async () => discover.scan());
  onRpc('a2a.remote.discover.connect', async (params, ctx) => discover.connect(str(params, 'ip'), ctx?.clientId ?? null));
  onRpc('a2a.remote.discover.outgoing.status', async () => discover.outgoingStatus());
  onRpc('a2a.remote.discover.outgoing.cancel', async (): Promise<A2aDiscoverOutgoingCancelResult> => discover.cancel());
  // This PC's human confirmed the code matches: only then does it pair.
  onRpc('a2a.remote.discover.outgoing.confirm', async (): Promise<A2aDiscoverOutgoingConfirmResult> => discover.confirm());

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

  return { discover };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
