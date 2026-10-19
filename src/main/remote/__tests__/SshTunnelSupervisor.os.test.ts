import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { once: vi.fn() } }));

import {
  SshTunnelRegistry,
  createSshAwareFetch,
  socketPathFor,
  sshHostIdOf,
} from '../SshTunnelSupervisor';
import {
  bootstrapArgs,
  classifySshFailure,
  isValidSshAlias,
  parseServerHostKey,
  tunnelArgs,
} from '../sshCommand';
import type { SshHostBinding } from '../../../shared/sshPcContract';

const FP = 'SHA256:abcdefABCDEF0123456789+/abcdefABCDEF012345';

class FakeChild extends EventEmitter {
  stderr = new PassThrough();
  args: string[] = [];
  exitCode: number | null = null;
  kill = vi.fn(() => {
    this.exitCode = 143;
    this.emit('exit', 143);
    return true;
  });
  /** What ssh -v prints before auth. */
  sayHostKey(fp = FP): void {
    this.stderr.write(`debug1: Server host key: ssh-ed25519 ${fp}\n`);
  }
  /** What ssh -v prints once the -L forward is bound. */
  sayListening(b: SshHostBinding): void {
    const ep = b.localEndpoint;
    this.stderr.write('socketPath' in ep
      ? `debug1: Local forwarding listening on path ${ep.socketPath}.\n`
      : `debug1: Local forwarding listening on 127.0.0.1 port ${ep.port}.\n`);
  }
  die(stderr: string): void {
    this.stderr.write(stderr);
    this.exitCode = 255;
    setImmediate(() => this.emit('exit', 255));
  }
}

describe('ssh argv', () => {
  it('tunnel: -N, hardened options, the unix forward, `--` before the alias', () => {
    const args = tunnelArgs('office', { socketPath: '/d/h.sock' }, 7681);
    expect(args).toContain('-N');
    for (const opt of ['BatchMode=yes', 'RemoteCommand=none', 'RequestTTY=no', 'ExitOnForwardFailure=yes',
      'ForwardAgent=no', 'ForwardX11=no', 'ControlMaster=no', 'ControlPath=none', 'StreamLocalBindUnlink=yes']) {
      expect(args).toContain(opt);
    }
    // ClearAllForwardings would clear our own -L too.
    expect(args).not.toContain('ClearAllForwardings=yes');
    expect(args.slice(args.indexOf('-L'), args.indexOf('-L') + 2)).toEqual(['-L', '/d/h.sock:127.0.0.1:7681']);
    // A config `StrictHostKeyChecking accept-new|no` cannot turn this into trust-on-first-use.
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('FingerprintHash=sha256');
    expect(args.indexOf('StrictHostKeyChecking=yes')).toBeLessThan(args.indexOf('--'));
    expect(args.slice(-2)).toEqual(['--', 'office']);
  });

  it('tunnel on Windows forwards a pinned loopback port', () => {
    const args = tunnelArgs('office', { port: 49152 }, 7681);
    expect(args).toContain('127.0.0.1:49152:127.0.0.1:7681');
  });

  it('bootstrap clears config forwards and runs the command after the alias', () => {
    const args = bootstrapArgs('me@box', ['sh', '-s']);
    expect(args).toContain('ClearAllForwardings=yes');
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args.slice(-4)).toEqual(['--', 'me@box', 'sh', '-s']);
  });

  it('refuses an alias that ssh would read as an option or that carries spaces', () => {
    expect(isValidSshAlias('-oProxyCommand=evil')).toBe(false);
    expect(isValidSshAlias('a b')).toBe(false);
    expect(isValidSshAlias('a\nb')).toBe(false);
    expect(isValidSshAlias('user@host.example')).toBe(true);
    expect(() => tunnelArgs('-x', { port: 1 }, 7681)).toThrow();
  });

  it('classifies what ssh says', () => {
    expect(classifySshFailure('user@h: Permission denied (publickey).')).toBe('auth');
    expect(classifySshFailure('No ED25519 host key is known for h and you have requested strict checking.\nHost key verification failed.')).toBe('host-key-unknown');
    expect(classifySshFailure('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@')).toBe('host-key-changed');
    expect(classifySshFailure('bind [127.0.0.1]:8080: Address already in use\nCould not request local forwarding.')).toBe('forward-conflict');
    expect(classifySshFailure('ssh: Could not resolve hostname nope: nodename nor servname provided')).toBe('unreachable');
    expect(classifySshFailure('debug1: Permission denied is only in debug noise')).toBe('failed');
  });

  it('reads the presented host key from -v output', () => {
    expect(parseServerHostKey(`debug1: Server host key: ssh-ed25519 ${FP}\n`)).toBe(FP);
    expect(parseServerHostKey('nothing')).toBeNull();
  });
});

describe('SshTunnel: pinned TCP port (Windows shape)', () => {
  it('refuses a pinned port something else already answers on, before spawning ssh', async () => {
    const children: unknown[] = [];
    const registry = new SshTunnelRegistry({
      socketDir: os.tmpdir(),
      resolveHostname: async () => 'office.lan',
      endpointExists: async () => true,
      spawnImpl: (() => { children.push(1); return new FakeChild(); }) as never,
    });
    const host = { ssh: { alias: 'office', resolvedHost: 'office.lan', hostKeyFingerprint: FP, remotePort: 7681, localEndpoint: { port: 49152 } } };
    const f = createSshAwareFetch(vi.fn() as never, registry, () => host);
    await expect(f('wmux-ssh://h1/api/config')).rejects.toMatchObject({ kind: 'forward-conflict' });
    expect(children).toHaveLength(0);
  });
});

// Unix-socket forwards: macOS and Linux only (Node cannot listen on a socket path on Windows).
describe.skipIf(process.platform === 'win32')('SshTunnel', () => {
  let dir: string;
  let servers: http.Server[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-'));
    servers = [];
  });
  afterEach(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function binding(over: Partial<SshHostBinding> = {}): SshHostBinding {
    return {
      alias: 'office',
      resolvedHost: 'office.lan',
      hostKeyFingerprint: FP,
      remotePort: 7681,
      localEndpoint: { socketPath: socketPathFor(dir, 'h1') },
      ...over,
    };
  }

  /** The "remote" web server, standing in at the forward's local end. */
  function listen(socketPath: string, handler: http.RequestListener): Promise<void> {
    const srv = http.createServer(handler);
    servers.push(srv);
    return new Promise((r) => srv.listen(socketPath, () => r()));
  }

  function setup(opts: { onSpawn?: (c: FakeChild, b: SshHostBinding) => void; hostname?: string; revive?: () => Promise<void> } = {}) {
    const children: FakeChild[] = [];
    let clock = 1_000_000;
    const host = { ssh: binding() };
    const registry = new SshTunnelRegistry({
      socketDir: dir,
      now: () => clock,
      resolveHostname: async () => opts.hostname ?? 'office.lan',
      revive: opts.revive,
      spawnImpl: ((_cmd: string, args: string[]) => {
        const c = new FakeChild();
        c.args = args;
        children.push(c);
        opts.onSpawn?.(c, host.ssh);
        return c;
      }) as never,
    });
    const base = vi.fn(async () => new Response('plain'));
    const f = createSshAwareFetch(base as never, registry, (id) => (id === 'h1' ? host : null));
    return { registry, f, base, children, host, advance: (ms: number) => { clock += ms; } };
  }

  it('passes non-ssh URLs to the base fetch untouched', async () => {
    const { f, base } = setup();
    await f('https://example.test/api/config');
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('parses only wmux-ssh URLs as host ids', () => {
    expect(sshHostIdOf('wmux-ssh://abc/api/x')).toBe('abc');
    expect(sshHostIdOf('http://abc/api/x')).toBeNull();
  });

  it('sends a credentialed request only once the forward exists and the key matched', async () => {
    const seen: Array<{ url?: string; auth?: string; host?: string }> = [];
    const { f, host } = setup({
      onSpawn: (c, b) => {
        // ssh shows the key first, says the forward is bound, and the socket answers.
        setTimeout(() => c.sayHostKey(), 5);
        setTimeout(() => {
          c.sayListening(b);
          void listen((b.localEndpoint as { socketPath: string }).socketPath, (req, res) => {
            seen.push({ url: req.url, auth: req.headers.authorization, host: req.headers.host });
            res.setHeader('content-type', 'application/json');
            res.end('{"ok":true}');
          });
        }, 30);
      },
    });
    const res = await f('wmux-ssh://h1/api/config?x=1', { headers: { Authorization: 'Bearer t' }, redirect: 'error' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual([{ url: '/api/config?x=1', auth: 'Bearer t', host: `127.0.0.1:${host.ssh.remotePort}` }]);
  });

  it('refuses when the presented host key differs from the confirmed one, and never retries on its own', async () => {
    const { f, registry, children, advance } = setup({
      onSpawn: (c, b) => setTimeout(() => { c.sayHostKey('SHA256:somethingElse'); c.sayListening(b); }, 1),
    });
    await expect(f('wmux-ssh://h1/api/config')).rejects.toMatchObject({ kind: 'needs-confirmation' });
    expect(children[0].kill).toHaveBeenCalled();
    advance(10 * 60_000);
    await expect(f('wmux-ssh://h1/api/config')).rejects.toMatchObject({ kind: 'needs-confirmation' });
    expect(children).toHaveLength(1);
    expect(registry.state('h1')).toMatchObject({ state: 'failed', kind: 'needs-confirmation' });
  });

  it('checks the destination key, not a ProxyJump hop printed before it', async () => {
    const { f } = setup({
      onSpawn: (c, b) => {
        c.sayHostKey('SHA256:theJumpHostsOwnKey');
        c.sayHostKey();
        c.sayListening(b);
        void listen((b.localEndpoint as { socketPath: string }).socketPath, (_req, res) => res.end('{}'));
      },
    });
    expect((await f('wmux-ssh://h1/api/config')).status).toBe(200);
  });

  it('never treats a socket that appears without ssh saying so as ready', async () => {
    const { f, children } = setup({
      onSpawn: (c, b) => {
        c.sayHostKey();
        void listen((b.localEndpoint as { socketPath: string }).socketPath, (_req, res) => res.end('{}'));
        // No "listening" line: ssh then fails the forward.
        setTimeout(() => c.die('Could not request local forwarding.\n'), 300);
      },
    });
    await expect(f('wmux-ssh://h1/api/config')).rejects.toMatchObject({ kind: 'forward-conflict' });
    expect(children).toHaveLength(1);
  });

  it('a host removed while its tunnel is starting never spawns ssh', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const children: FakeChild[] = [];
    const registry = new SshTunnelRegistry({
      socketDir: dir,
      resolveHostname: async () => { await gate; return 'office.lan'; },
      spawnImpl: (() => { const c = new FakeChild(); children.push(c); return c; }) as never,
    });
    const host = { ssh: binding() };
    const f = createSshAwareFetch(vi.fn() as never, registry, () => host);
    const pending = f('wmux-ssh://h1/api/config');
    registry.stop('h1');
    release();
    await expect(pending).rejects.toThrow(/stopped/);
    expect(children).toHaveLength(0);
  });

  it('revives the host before opening the tunnel, and spawns nothing when that fails', async () => {
    const revive = vi.fn(async () => { throw new Error('could not start the wmux daemon'); });
    const { f, children } = setup({ revive });
    await expect(f('wmux-ssh://h1/api/config')).rejects.toThrow(/could not start/);
    expect(revive).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(0);
  });

  it('web stopped on the host is a refusal for the person, not a retry loop', async () => {
    const revive = vi.fn(async () => { throw Object.assign(new Error('wmux web was stopped on that computer'), { refusal: 'web-stopped' }); });
    const { f, registry, advance } = setup({ revive });
    await expect(f('wmux-ssh://h1/api/config')).rejects.toMatchObject({ kind: 'web-stopped' });
    advance(10 * 60_000);
    await expect(f('wmux-ssh://h1/api/config')).rejects.toMatchObject({ kind: 'web-stopped' });
    expect(revive).toHaveBeenCalledTimes(1);
    expect(registry.state('h1')).toMatchObject({ state: 'failed', kind: 'web-stopped' });
  });

  it('a live tunnel whose server stopped answering is dropped, so the next request revives it', async () => {
    const revive = vi.fn(async () => undefined);
    const { f, registry, advance } = setup({
      revive,
      onSpawn: (c, b) => {
        c.sayHostKey();
        c.sayListening(b);
        // A bare socket that accepts and hangs up: what ssh does when the remote port is closed.
        const srv = net.createServer((sock) => sock.destroy());
        servers.push(srv as unknown as http.Server);
        srv.listen((b.localEndpoint as { socketPath: string }).socketPath);
      },
    });
    await expect(f('wmux-ssh://h1/api/config')).rejects.toThrow(/fetch failed/);
    expect(registry.state('h1')).toMatchObject({ state: 'failed', kind: 'unreachable' });
    advance(1_001);
    await f('wmux-ssh://h1/api/config').catch(() => undefined);
    expect(revive).toHaveBeenCalledTimes(2);
  });

  it('refuses when the alias now resolves to another hostname', async () => {
    const { f, children } = setup({ hostname: 'elsewhere.lan' });
    await expect(f('wmux-ssh://h1/api/config')).rejects.toMatchObject({ kind: 'needs-confirmation' });
    expect(children).toHaveLength(0);
  });

  it('aborts an in-flight stream when ssh exits, unlinks the socket, then backs off', async () => {
    let streamOpen!: () => void;
    const opened = new Promise<void>((r) => { streamOpen = r; });
    const { f, children, registry, advance } = setup({
      onSpawn: (c, b) => {
        c.sayHostKey();
        c.sayListening(b);
        void listen((b.localEndpoint as { socketPath: string }).socketPath, (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: x\ndata: 1\n\n');
          streamOpen();
        });
      },
    });
    const res = await f('wmux-ssh://h1/api/stream');
    const body = res.body;
    if (!body) throw new Error('no body');
    const reader = body.getReader();
    await opened;
    await reader.read();
    const pending = reader.read();
    children[0].die('Connection closed by remote host\n');
    await expect(pending).rejects.toBeTruthy();
    const sock = socketPathFor(dir, 'h1');
    expect(fs.existsSync(sock)).toBe(false);
    expect(registry.state('h1')).toMatchObject({ state: 'failed', kind: 'unreachable' });
    // Inside the backoff window nothing is spawned and the call fails fast.
    await expect(f('wmux-ssh://h1/api/config')).rejects.toMatchObject({ kind: 'unreachable' });
    expect(children).toHaveLength(1);
    advance(1_001);
    // After it, a fresh tunnel is started.
    const next = f('wmux-ssh://h1/api/config').catch(() => undefined);
    await vi.waitFor(() => expect(children).toHaveLength(2), { timeout: 5_000 });
    children[1].die('Permission denied (publickey).\n');
    await next;
  });

  it('caps the backoff', async () => {
    const { f, children, registry, advance } = setup({
      onSpawn: (c) => c.die('Connection closed by 10.0.0.2 port 22\n'),
    });
    for (let i = 0; i < 12; i += 1) {
      await f('wmux-ssh://h1/api/config').catch(() => undefined);
      advance(60_001);
    }
    expect(children).toHaveLength(12);
    const st = registry.state('h1') as { retryAt: number };
    expect(st).toMatchObject({ state: 'failed', kind: 'unreachable' });
    // retryAt is at most one cap ahead of "now" (clock was advanced after the last call).
    expect(st.retryAt).toBeLessThanOrEqual(1_000_000 + 12 * 60_001 + 60_000);
  });

  it('a refused login is not retried on its own (no endless failed logins), until reset', async () => {
    const { f, children, registry, advance, host } = setup({
      onSpawn: (c) => c.die('dev@h: Permission denied (publickey).\n'),
    });
    await expect(f('wmux-ssh://h1/api/config')).rejects.toMatchObject({ kind: 'auth' });
    advance(10 * 60_000);
    await expect(f('wmux-ssh://h1/api/config')).rejects.toMatchObject({ kind: 'auth' });
    expect(children).toHaveLength(1);
    registry.reset('h1', host.ssh);
    await f('wmux-ssh://h1/api/config').catch(() => undefined);
    expect(children).toHaveLength(2);
  });

  it('never uses a stored socket path: it is re-derived from the host id', async () => {
    const { f, children, host } = setup({
      onSpawn: (c) => c.die('Connection closed\n'),
    });
    host.ssh = { ...host.ssh, localEndpoint: { socketPath: '/etc/passwd' } };
    await f('wmux-ssh://h1/api/config').catch(() => undefined);
    expect(children).toHaveLength(1);
    const forward = children[0].args[children[0].args.indexOf('-L') + 1];
    expect(forward).toBe(`${socketPathFor(dir, 'h1')}:127.0.0.1:7681`);
    expect(fs.existsSync('/etc/passwd')).toBe(true);
  });

  it('fails closed for an unknown ssh host id', async () => {
    const { f, children } = setup();
    await expect(f('wmux-ssh://nope/api/config')).rejects.toThrow(/unknown ssh host/);
    expect(children).toHaveLength(0);
  });
});
