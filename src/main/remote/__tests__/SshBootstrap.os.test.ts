import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { once: vi.fn() } }));

import {
  BootstrapError,
  bootstrapHost,
  compareRelease,
  issuePairCode,
  reviveHost,
  sshStep,
  lastJsonObject,
  parsePairResult,
  parseProbe,
  parseServiceResult,
  planInstall,
  type HostProbe,
  type SshRun,
} from '../SshBootstrap';
import { addSshHost } from '../sshAddFlow';
import { listSshConfigHosts } from '../sshConfigHosts';
import { SshTunnelRegistry } from '../SshTunnelSupervisor';
import type { ServerArtifactManifest } from '../../../shared/sshPcContract';
import { serverArtifactUrl } from '../../../shared/sshPcContract';

const SHA = 'a'.repeat(64);
const FP = 'SHA256:hostkeyhostkeyhostkeyhostkeyhostkeyhostke';
const MANIFEST: ServerArtifactManifest = {
  version: '3.70.0',
  node: '24.15.0',
  glibcMin: '2.28',
  artifacts: { x64: { name: 'wmux-server-3.70.0-linux-x64.tar.gz', sha256: SHA, size: 1 } },
};

function probe(over: Partial<HostProbe> = {}): HostProbe {
  return {
    os: 'Linux', arch: 'x64', rawArch: 'x86_64', glibc: '2.35', musl: false, desktop: [],
    hasDownloader: true, hasSha256: true, hasTar: true, installed: [], current: null, status: null, hostKey: FP,
    ...over,
  };
}

describe('planInstall', () => {
  it('installs the manifest version from its pinned URL', () => {
    expect(planInstall(probe(), MANIFEST)).toEqual({
      kind: 'install', version: '3.70.0', arch: 'x64', sha256: SHA, url: serverArtifactUrl('3.70.0', 'x64'), size: 1,
    });
  });
  it('is ready when that version is current', () => {
    expect(planInstall(probe({ installed: ['3.70.0'], current: '3.70.0' }), MANIFEST)).toEqual({ kind: 'ready', version: '3.70.0' });
  });
  it.each([
    [{ desktop: ['/usr/lib/wmux'] }, 'desktop-installed'],
    [{ os: 'Darwin' }, 'unsupported-os'],
    [{ musl: true, glibc: null }, 'musl'],
    [{ arch: null, rawArch: 'riscv64' }, 'unsupported-arch'],
    [{ glibc: '2.17' }, 'glibc-too-old'],
    [{ hasSha256: false }, 'missing-tools'],
  ] as Array<[Partial<HostProbe>, string]>)('refuses %j as %s', (over, refusal) => {
    expect(() => planInstall(probe(over), MANIFEST)).toThrow(expect.objectContaining({ refusal }));
  });
  it('refuses a fresh install without a manifest, but uses an installed runtime', () => {
    expect(() => planInstall(probe(), null)).toThrow(BootstrapError);
    expect(planInstall(probe({ current: '3.69.0', installed: ['3.69.0'] }), null)).toEqual({ kind: 'ready', version: '3.69.0' });
  });
});

describe('parsers', () => {
  it('reads the probe output and ignores values that are not versions', () => {
    const p = parseProbe(
      'os=Linux\narch=aarch64\nglibc=2.36\ndesktop=/home/u/.config/wmux\ninstalled=3.69.0\ninstalled=../evil\ncurrent=3.69.0\n' +
      'status={"ok":true,"running":true,"version":"3.69.0","liveSessions":2,"web":{"running":true,"port":7681,"allowInput":true}}\n',
      `debug1: Server host key: ssh-ed25519 ${FP}\n`,
    );
    expect(p).toMatchObject({ arch: 'arm64', glibc: '2.36', installed: ['3.69.0'], current: '3.69.0', hostKey: FP, desktop: ['/home/u/.config/wmux'] });
    expect(p.status).toEqual({ running: true, version: '3.69.0', liveSessions: 2, web: { running: true, port: 7681, allowInput: true } });
  });
  it('takes the pairing JSON even after other output, and never anything token-shaped', () => {
    expect(parsePairResult('starting daemon…\n{\n  "code": "ABCD2345",\n  "expiresAt": 5,\n  "port": 7681,\n  "allowInput": true\n}\n'))
      .toEqual({ code: 'ABCD2345', expiresAt: 5, port: 7681, allowInput: true });
    expect(parsePairResult('{"code":"abc","port":7681}')).toBeNull();
    expect(lastJsonObject('no json')).toBeNull();
  });
});

/** A scripted host: answers each ssh invocation by what it is asked to run. */
function fakeHost(state: {
  installed?: string[];
  current?: string | null;
  status?: Record<string, unknown> | null;
  desktop?: boolean;
  downloadFails?: boolean;
  codes?: string[];
  /** `daemon install-service --json` output; absent = a CLI without the verb. */
  service?: Record<string, unknown>;
}) {
  const calls: string[][] = [];
  const cliLog: string[] = [];
  const codes = [...(state.codes ?? ['ABCD2345'])];
  const run: SshRun = vi.fn(async (args: string[], opts?: { stdin?: unknown }) => {
    calls.push(args);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: `debug1: Server host key: ssh-ed25519 ${FP}\n` });
    if (args[0] === '-G') return ok('hostname office.lan\nuser me\nport 22\n');
    const tail = args.slice(args.indexOf('--') + 2);
    const script = typeof opts?.stdin === 'string' ? opts.stdin : '';
    if (script.includes('uname -s')) {
      return ok([
        'os=Linux', 'arch=x86_64', 'glibc=2.35', 'downloader=curl', 'sha256=1', 'tar=1',
        ...(state.desktop ? ['desktop=/usr/lib/wmux'] : []),
        ...(state.installed ?? []).map((v) => `installed=${v}`),
        ...(state.current ? [`current=${state.current}`] : []),
        ...(state.status ? [`status=${JSON.stringify(state.status)}`] : []),
      ].join('\n'));
    }
    if (script.includes('VER="$1"')) {
      if (tail[5] === 'download' && state.downloadFails) return { code: 3, stdout: 'error=download-failed\n', stderr: '' };
      state.installed = [...(state.installed ?? []), tail[3]];
      state.current = tail[3];
      return ok(`installed=${tail[3]}\n`);
    }
    if (tail[0] === 'sh' && tail[1] === '-c') return ok('');
    // CLI_SCRIPT: sh -s -- <version> <cli args…>
    const cli = tail.slice(4);
    cliLog.push(cli.join(' '));
    if (cli[0] === 'daemon' && cli[1] === 'status') return ok(JSON.stringify(state.status ?? { ok: false, running: false }));
    if (cli[0] === 'daemon' && cli[1] === 'start') {
      state.status = { running: true, version: state.current, liveSessions: 0, web: { running: false } };
      return ok('{"ok":true}');
    }
    if (cli[0] === 'daemon' && cli[1] === 'stop') {
      state.status = { running: false };
      return ok('{"ok":true}');
    }
    if (cli[0] === 'daemon' && cli[1] === 'install-service' && state.service) {
      return { ...ok(JSON.stringify(state.service, null, 2)), code: state.service.ok ? 0 : 1 };
    }
    if (cli[0] === 'web' && cli[1] === 'pair') {
      return ok(JSON.stringify({ code: codes.shift() ?? 'ZZZZ2345', expiresAt: 1, port: 7681, allowInput: true }));
    }
    if (cli[0] === 'web') {
      state.status = { ...(state.status ?? {}), running: true, version: state.current, liveSessions: 0, web: { running: true, port: 7681 } };
      return ok('{}');
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  }) as unknown as SshRun;
  const cliCalls = () => cliLog;
  return { run, calls, cliCalls, state };
}

describe('bootstrapHost', () => {
  it('fresh host: installs, starts web with --allow-input, mints a code', async () => {
    const host = fakeHost({});
    const r = await bootstrapHost('office', { run: host.run, manifest: MANIFEST, deviceName: 'my laptop' });
    expect(r).toMatchObject({ resolvedHost: 'office.lan', hostKeyFingerprint: FP, version: '3.70.0', upgradePending: false, pair: { code: 'ABCD2345', port: 7681 } });
    expect(host.cliCalls()).toEqual([
      'daemon status --json',
      'daemon start --json',
      'daemon status --json',
      'web --allow-input --json',
      'web pair --name my-laptop --kind desktop --json',
    ]);
    // Every remote step names the destination after `--`.
    for (const args of host.calls) expect(args[args.indexOf('--') + 1]).toBe('office');
  });

  it('never restarts or re-runs a web server that is already up (another laptop stays paired)', async () => {
    const host = fakeHost({ installed: ['3.70.0'], current: '3.70.0', status: { running: true, version: '3.70.0', liveSessions: 3, web: { running: true, port: 9000, allowInput: true } } });
    await bootstrapHost('office', { run: host.run, manifest: MANIFEST, deviceName: 'b' });
    expect(host.cliCalls()).toEqual(['daemon status --json', 'web pair --name b --kind desktop --json']);
  });

  it('upgrade with live sessions keeps the old daemon and reports it', async () => {
    const host = fakeHost({ installed: ['3.69.0'], current: '3.69.0', status: { running: true, version: '3.69.0', liveSessions: 2, web: { running: true, port: 7681 } } });
    const r = await bootstrapHost('office', { run: host.run, manifest: MANIFEST, deviceName: 'b' });
    expect(r.upgradePending).toBe(true);
    expect(host.cliCalls().some((c) => c.startsWith('daemon stop'))).toBe(false);
  });

  it('upgrade with no live sessions stops the old daemon and restarts web WITHOUT new flags', async () => {
    const host = fakeHost({ installed: ['3.69.0'], current: '3.69.0', status: { running: true, version: '3.69.0', liveSessions: 0, web: { running: true, port: 7681 } } });
    const r = await bootstrapHost('office', { run: host.run, manifest: MANIFEST, deviceName: 'b' });
    expect(r.upgradePending).toBe(false);
    expect(host.cliCalls()).toEqual([
      'daemon status --json',
      'daemon status --json',
      'daemon stop --json',
      'daemon start --json',
      'daemon status --json',
      'web --json',
      'web pair --name b --kind desktop --json',
    ]);
  });

  it('keeps the web shape of a daemon it did not start (no --allow-input)', async () => {
    const host = fakeHost({ installed: ['3.70.0'], current: '3.70.0', status: { running: true, version: '3.70.0', liveSessions: 1, web: { running: false } } });
    await bootstrapHost('office', { run: host.run, manifest: MANIFEST, deviceName: 'b' });
    expect(host.cliCalls()).toEqual(['daemon status --json', 'web --json', 'web pair --name b --kind desktop --json']);
  });

  it('never runs `web pair` on a runtime that predates it (it would restart web)', async () => {
    const host = fakeHost({ installed: ['3.70.0'], current: '3.70.0', status: { running: true, version: '3.70.0', liveSessions: 0 } });
    await expect(bootstrapHost('office', { run: host.run, manifest: MANIFEST, deviceName: 'b' })).rejects.toMatchObject({ refusal: 'pair-unsupported' });
    expect(host.cliCalls()).toEqual(['daemon status --json']);
  });

  it('refuses a host with the desktop app before touching anything', async () => {
    const host = fakeHost({ desktop: true });
    await expect(bootstrapHost('office', { run: host.run, manifest: MANIFEST, deviceName: 'b' })).rejects.toMatchObject({ refusal: 'desktop-installed' });
    expect(host.cliCalls()).toEqual([]);
  });

  it('falls back to uploading over ssh when the host cannot download', async () => {
    const host = fakeHost({ downloadFails: true });
    const openArtifact = vi.fn(async () => fs.createReadStream(__filename));
    await bootstrapHost('office', { run: host.run, manifest: MANIFEST, deviceName: 'b', openArtifact });
    expect(openArtifact).toHaveBeenCalledWith('3.70.0', 'x64', SHA, undefined);
    const modes = host.calls.map((a) => a[a.length - 1]);
    expect(modes).toContain('upload');
  });
});

describe('addSshHost', () => {
  function deps(host: ReturnType<typeof fakeHost>, exchange: (o: string, c: string) => Promise<{ ok: true; token: string } | { ok: false; reason: 'invalid-code' | 'unreachable' }>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsa-'));
    const registry = new SshTunnelRegistry({ socketDir: dir });
    const persist = vi.fn((id: string, binding: unknown, token: string, label: string) => ({ ok: true as const, host: { id, label, origin: `wmux-ssh://${id}`, addedAt: 1, ssh: binding } as never, token }));
    return {
      registry,
      persist,
      d: {
        registry, manifest: MANIFEST, deviceName: 'b', run: host.run, platform: 'darwin' as const,
        exchange, probe: async () => true, persist, isRegistered: () => false, newId: () => 'host-1',
      },
    };
  }

  it('redeems through the new host id, retries a rejected code with a fresh one, then persists', async () => {
    const host = fakeHost({ codes: ['AAAA2345', 'BBBB2345'] });
    const exchange = vi.fn(async (_o: string, c: string) => (c === 'BBBB2345' ? { ok: true as const, token: 'tok' } : { ok: false as const, reason: 'invalid-code' as const }));
    const { d, persist, registry } = deps(host, exchange);
    const r = await addSshHost('office', undefined, d);
    expect(r.ok).toBe(true);
    expect(exchange.mock.calls.map((c) => c.slice(0, 2))).toEqual([['wmux-ssh://host-1', 'AAAA2345'], ['wmux-ssh://host-1', 'BBBB2345']]);
    expect(persist).toHaveBeenCalledWith('host-1', expect.objectContaining({ alias: 'office', resolvedHost: 'office.lan', hostKeyFingerprint: FP, remotePort: 7681 }), 'tok', 'office', true);
    expect(registry.pendingBinding('host-1')).toBeUndefined();
  });

  it('persists nothing and drops the tunnel when pairing cannot reach the host', async () => {
    const host = fakeHost({});
    const { d, persist, registry } = deps(host, async () => ({ ok: false, reason: 'unreachable' }));
    const stop = vi.spyOn(registry, 'stop');
    const r = await addSshHost('office', undefined, d);
    expect(r).toMatchObject({ ok: false, kind: 'web-failed' });
    expect(persist).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith('host-1');
  });

  it('Start after reboot: installs the service after the host is saved, never touching web', async () => {
    const host = fakeHost({ service: { ok: true, manager: 'systemd', enabled: true, active: false, linger: false, hint: 'Linger is off. Run once: sudo loginctl enable-linger me' } });
    const { d, persist } = deps(host, async () => ({ ok: true, token: 'tok' }));
    const recordService = vi.fn(() => true);
    const r = await addSshHost('office', undefined, { ...d, startAfterReboot: true, recordService });
    expect(r).toMatchObject({ ok: true, host: { startAfterReboot: true }, service: { ok: true, on: true, lingerCommand: 'sudo loginctl enable-linger me' } });
    expect(persist).toHaveBeenCalled();
    expect(recordService).toHaveBeenCalledWith('host-1');
    const cli = host.cliCalls();
    expect(cli[cli.length - 1]).toBe('daemon install-service --json');
    expect(cli.filter((c) => c.startsWith('web ') && !c.startsWith('web pair'))).toEqual(['web --allow-input --json']);
  });

  it('Start after reboot: a host that cannot run the service is still added', async () => {
    const host = fakeHost({});
    const { d, persist } = deps(host, async () => ({ ok: true, token: 'tok' }));
    const recordService = vi.fn(() => true);
    const r = await addSshHost('office', undefined, { ...d, startAfterReboot: true, recordService });
    expect(r).toMatchObject({ ok: true, service: { ok: false, kind: 'failed' } });
    expect(persist).toHaveBeenCalled();
    expect(recordService).not.toHaveBeenCalled();
  });

  it('rejects an option-shaped alias without running ssh', async () => {
    const host = fakeHost({});
    const { d } = deps(host, async () => ({ ok: true, token: 't' }));
    expect(await addSshHost('-oProxyCommand=x', undefined, d)).toMatchObject({ ok: false, kind: 'invalid-alias' });
    expect(host.calls).toHaveLength(0);
  });
});

describe('parseServiceResult', () => {
  it('reads what install-service and uninstall-service answered', () => {
    const json = (o: Record<string, unknown>) => `note\n${JSON.stringify(o, null, 2)}\n`;
    expect(parseServiceResult(json({ ok: true, manager: 'systemd', enabled: true, linger: true }), true)).toEqual({ ok: true, on: true });
    expect(parseServiceResult(json({ ok: true, manager: 'systemd', enabled: true, linger: null, hint: 'Run once: sudo loginctl enable-linger dev.user' }), true))
      .toEqual({ ok: true, on: true, lingerCommand: 'sudo loginctl enable-linger dev.user' });
    expect(parseServiceResult(json({ ok: false, manager: 'launchd', hint: 'A login service is not supported on macOS yet.' }), true))
      .toEqual({ ok: false, kind: 'service-unsupported', message: 'A login service is not supported on macOS yet.' });
    expect(parseServiceResult(json({ ok: true, manager: 'launchd', hint: 'No service is installed on macOS.' }), false)).toEqual({ ok: true, on: false });
    expect(parseServiceResult(json({ ok: false, manager: 'systemd', error: 'enable failed' }), true)).toMatchObject({ ok: false, kind: 'failed', message: 'enable failed' });
    // A CLI from before install-service: usage text, or `unknown subcommand` with no manager.
    expect(parseServiceResult('Usage: wmux daemon start | stop | status', true)).toMatchObject({ ok: false, kind: 'failed' });
    expect(parseServiceResult(json({ ok: false, error: 'unknown subcommand: install-service' }), true))
      .toMatchObject({ ok: false, kind: 'failed', message: expect.stringContaining('no install-service') });
  });
});

describe('listSshConfigHosts', () => {
  it('lists concrete Host names from the config and its Includes, skipping patterns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-'));
    fs.mkdirSync(path.join(dir, 'config.d'));
    fs.writeFileSync(path.join(dir, 'config'), 'Include config.d/*\nHost office build-*\n  HostName 1.2.3.4\nHost * !bad\nMatch host x\nHost=lab\n');
    fs.writeFileSync(path.join(dir, 'config.d', 'a'), 'Host vps "quoted"\n');
    expect(listSshConfigHosts(path.join(dir, 'config'))).toEqual(['vps', 'quoted', 'office', 'lab']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('pairing and revive verbs', () => {
  const cliRun = (answers: Record<string, { code: number; stdout: string }>) => {
    const calls: string[] = [];
    const run = vi.fn(async (args: string[]) => {
      const cli = args.slice(args.indexOf('--') + 2).slice(4).join(' ');
      calls.push(cli);
      const hit = Object.entries(answers).find(([k]) => cli.startsWith(k));
      return { code: hit ? hit[1].code : 0, stdout: hit ? hit[1].stdout : '{}', stderr: '' };
    }) as unknown as SshRun;
    return { run, calls };
  };

  it('a busy pairing slot is its own refusal, not "too old"', async () => {
    const { run } = cliRun({ 'web pair': { code: 1, stdout: '{"ok":false,"error":"another pairing is in progress — cancel it first"}' } });
    await expect(issuePairCode(run, 'office', 'b')).rejects.toMatchObject({ refusal: 'pair-busy' });
    const other = cliRun({ 'web pair': { code: 1, stdout: '{"ok":false,"error":"wmux web is not running"}' } });
    await expect(issuePairCode(other.run, 'office', 'b')).rejects.toMatchObject({ refusal: 'web-failed' });
  });

  it('revive: an idled-out daemon is started and restores web itself; nothing re-applies a grant', async () => {
    let up = false;
    let webOn = true;
    const calls: string[] = [];
    const run = vi.fn(async (args: string[]) => {
      const cli = args.slice(args.indexOf('--') + 2).slice(4).join(' ');
      calls.push(cli);
      if (cli === 'daemon start --json') up = true;
      if (cli === 'daemon status --json') {
        return { code: up ? 0 : 1, stdout: JSON.stringify(up ? { running: true, web: { running: webOn, port: 9000 } } : { ok: false, running: false }), stderr: '' };
      }
      return { code: 0, stdout: '{}', stderr: '' };
    }) as unknown as SshRun;
    await reviveHost(run, 'office', 9000);
    expect(calls).toEqual(['daemon status --json', 'daemon start --json', 'daemon status --json']);
    up = false;
    webOn = false;
    await expect(reviveHost(run, 'office', 9000)).rejects.toMatchObject({ refusal: 'web-stopped' });
    expect(calls.some((c) => c.startsWith('web'))).toBe(false);
  });

  it('revive leaves a running web alone, and refuses one that moved port', async () => {
    const same = cliRun({ 'daemon status': { code: 0, stdout: '{"running":true,"web":{"running":true,"port":9000}}' } });
    await reviveHost(same.run, 'office', 9000);
    expect(same.calls).toEqual(['daemon status --json']);
    const moved = cliRun({ 'daemon status': { code: 0, stdout: '{"running":true,"web":{"running":true,"port":7681}}' } });
    await expect(reviveHost(moved.run, 'office', 9000)).rejects.toMatchObject({ refusal: 'web-failed' });
  });

  it('refuses a remote-shell argument that is not a plain word', async () => {
    const run = vi.fn() as unknown as SshRun;
    expect(() => sshStep(run, 'office', 'true', ['ok', 'a;b'])).toThrow(BootstrapError);
    expect(() => sshStep(run, 'office', 'true', ['$(id)'])).toThrow(BootstrapError);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('never moving a host backward', () => {
  it('compares releases, prereleases below their release', () => {
    expect(compareRelease('3.71.0', '3.70.0')).toBeGreaterThan(0);
    expect(compareRelease('4.0.0', '4.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareRelease('4.0.0-beta.10', '4.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareRelease('3.70.0', '3.70.0')).toBe(0);
    // semver: a numeric identifier ranks below an alphanumeric one, whatever the locale.
    expect(compareRelease('4.0.0-1', '4.0.0-alpha')).toBeLessThan(0);
  });

  it('an older app against a newer host installs nothing and stops nothing', async () => {
    const host = fakeHost({ installed: ['3.70.0', '3.71.0'], current: '3.71.0', status: { running: true, version: '3.71.0', liveSessions: 0, web: { running: true, port: 7681 } } });
    const r = await bootstrapHost('office', { run: host.run, manifest: MANIFEST, deviceName: 'b' });
    expect(r.version).toBe('3.71.0');
    expect(r.upgradePending).toBe(false);
    expect(host.cliCalls()).toEqual(['daemon status --json', 'web pair --name b --kind desktop --json']);
    expect(host.state.current).toBe('3.71.0');
  });

  it('a newer daemon still running over an older current is left alone', async () => {
    const host = fakeHost({ installed: ['3.70.0'], current: '3.70.0', status: { running: true, version: '3.72.0', liveSessions: 0, web: { running: true, port: 7681 } } });
    await bootstrapHost('office', { run: host.run, manifest: MANIFEST, deviceName: 'b' });
    expect(host.cliCalls().some((c) => c.startsWith('daemon stop'))).toBe(false);
  });

  it('web starts throw their stdout away on the host (the operator token)', async () => {
    const host = fakeHost({});
    await bootstrapHost('office', { run: host.run, manifest: MANIFEST, deviceName: 'b' });
    const webStart = (host.run as unknown as { mock: { calls: Array<[string[], { stdin?: string }]> } }).mock.calls
      .find(([args]) => args.includes('--allow-input'));
    expect(webStart?.[1].stdin).toContain('> /dev/null');
  });
});

describe('cancel', () => {
  it('an aborted add kills its ssh and stores nothing', async () => {
    const controller = new AbortController();
    const host = fakeHost({});
    const persist = vi.fn();
    const run: SshRun = async (args, opts) => {
      if (args.some((a) => a === 'pair')) controller.abort();
      return host.run(args, opts);
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-'));
    const r = await addSshHost('office', undefined, {
      registry: new SshTunnelRegistry({ socketDir: dir }), manifest: MANIFEST, deviceName: 'b', run, platform: 'darwin',
      exchange: async () => ({ ok: true, token: 't' }), probe: async () => true, persist, isRegistered: () => false,
      newId: () => 'h', signal: controller.signal,
    });
    expect(r).toMatchObject({ ok: false, kind: 'cancelled' });
    expect(persist).not.toHaveBeenCalled();
  });
});

