import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fixtureTailscaleDirExec,
  judgeWhois,
  parseTailnetStatus,
  parseWhois,
  tailscaleStatus,
  tailscaleWhois,
  type TailnetWhois,
  type TailscaleExec,
} from '../tailscale';

/**
 * The reads A2A discovery makes: `status --json` for this PC and the other
 * nodes, `whois --json <ip>` for who holds an address. Every shell-out goes
 * through the injected exec seam; nothing here spawns a binary.
 */

const SELF = {
  ID: 'nSELF',
  HostName: 'laptop',
  DNSName: 'laptop.tail1.ts.net.',
  OS: 'macOS',
  UserID: 7,
  TailscaleIPs: ['100.101.0.1', 'fd7a:115c:a1e0::1'],
  Online: true,
};

function status(peers: Record<string, unknown>, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Version: '1.76.6-t1234',
    BackendState: 'Running',
    Self: SELF,
    Peer: peers,
    User: { '7': { ID: 7, LoginName: 'me@example.com', DisplayName: 'Me' } },
    ...over,
  });
}

function whoisJson(over: { node?: Record<string, unknown>; hostinfo?: Record<string, unknown>; profile?: Record<string, unknown> } = {}): string {
  return JSON.stringify({
    Node: {
      ID: 42,
      StableID: 'nDESK',
      Name: 'Desk.tail1.ts.net.',
      User: 7,
      Addresses: ['100.101.12.4/32', 'fd7a:115c:a1e0::4/128'],
      AllowedIPs: ['100.101.12.4/32', 'fd7a:115c:a1e0::4/128'],
      ComputedName: 'desk',
      Hostinfo: { OS: 'windows', Hostname: 'DESKTOP-1', ...over.hostinfo },
      ...over.node,
    },
    UserProfile: { ID: 7, LoginName: 'me@example.com', DisplayName: 'Me', ...over.profile },
  });
}

function recordingExec(answer: (args: string[]) => { stdout: string } | Error): { exec: TailscaleExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: TailscaleExec = async (_cmd, args) => {
    calls.push(args);
    const a = answer(args);
    if (a instanceof Error) throw a;
    return { stdout: a.stdout, stderr: '' };
  };
  return { exec, calls };
}

function failure(props: { code?: string; stderr?: string }): Error {
  return Object.assign(new Error('Command failed'), props);
}

const APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

describe('parseTailnetStatus', () => {
  it('reads this PC, its login and the version', () => {
    const s = parseTailnetStatus(status({}))!;
    expect(s.backendState).toBe('Running');
    expect(s.version).toBe('1.76.6-t1234');
    expect(s.self).toMatchObject({ stableId: 'nSELF', hostName: 'laptop', dnsName: 'laptop.tail1.ts.net', os: 'macOS', userId: 7, online: true });
    // IPv4 tailnet addresses only.
    expect(s.self.ipv4s).toEqual(['100.101.0.1']);
    expect(s.selfLogin).toBe('me@example.com');
  });

  it('keeps each peer kind apart: IPv4 or not, offline, shared-in, tagged', () => {
    const s = parseTailnetStatus(
      status({
        a: { ID: 'nA', HostName: 'desk', DNSName: 'desk.tail1.ts.net.', OS: 'windows', UserID: 7, TailscaleIPs: ['100.101.12.4', 'fd7a::4'], Online: true },
        b: { ID: 'nB', HostName: 'v6only', OS: 'linux', UserID: 7, TailscaleIPs: ['fd7a::5'], Online: true },
        c: { ID: 'nC', HostName: 'asleep', OS: 'macOS', UserID: 7, TailscaleIPs: ['100.101.12.6'], Online: false },
        d: { ID: 'nD', HostName: 'friend', OS: 'linux', UserID: 99, TailscaleIPs: ['100.101.12.7'], Online: true, ShareeNode: true },
        e: { ID: 'nE', HostName: 'server', OS: 'linux', UserID: 12345, TailscaleIPs: ['100.101.12.8'], Online: true, Tags: ['tag:server'] },
        f: { ID: 'nF', HostName: 'old', OS: 'linux', UserID: 7, TailscaleIPs: ['100.101.12.9'] },
      }),
    )!;
    const byId = Object.fromEntries(s.peers.map((p) => [p.stableId, p]));
    expect(byId['nA']).toMatchObject({ ipv4s: ['100.101.12.4'], online: true, userId: 7, sharee: false, tags: [], dnsName: 'desk.tail1.ts.net' });
    expect(byId['nB'].ipv4s).toEqual([]);
    expect(byId['nC'].online).toBe(false);
    expect(byId['nD']).toMatchObject({ sharee: true, userId: 99 });
    expect(byId['nE'].tags).toEqual(['tag:server']);
    // An older client omits Online: not counted as online.
    expect(byId['nF'].online).toBe(false);
  });

  it('is null for output that is not a status with a Self block', () => {
    expect(parseTailnetStatus('not json')).toBeNull();
    expect(parseTailnetStatus('[]')).toBeNull();
    expect(parseTailnetStatus(JSON.stringify({ BackendState: 'Running' }))).toBeNull();
  });

  it('is null when Self names no node ID (nothing could be told apart from it)', () => {
    expect(parseTailnetStatus(status({}, { Self: { ...SELF, ID: '' } }))).toBeNull();
    expect(parseTailnetStatus(status({}, { Self: { ...SELF, ID: 42 } }))).toBeNull();
    const { ID: _omit, ...noId } = SELF;
    expect(parseTailnetStatus(status({}, { Self: noId }))).toBeNull();
  });

  it('reads a zero or non-integer user ID as none (Go leaves 0 for unset)', () => {
    expect(parseTailnetStatus(status({}, { Self: { ...SELF, UserID: 0 } }))?.self.userId).toBeNull();
    expect(parseTailnetStatus(status({}, { Self: { ...SELF, UserID: -3 } }))?.self.userId).toBeNull();
    expect(parseTailnetStatus(status({}, { Self: { ...SELF, UserID: '7' } }))?.self.userId).toBeNull();
  });
});

describe('tailscaleStatus', () => {
  it('answers the parsed status when Tailscale is running', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: status({}) }));
    const read = await tailscaleStatus({ exec });
    expect(read.ok).toBe(true);
    expect(calls[0]).toEqual(['status', '--json']);
  });

  it('reports the failed checklist item (with its fix) when Tailscale is not ready', async () => {
    const missing = await tailscaleStatus({ exec: recordingExec(() => failure({ code: 'ENOENT' })).exec });
    expect(missing).toEqual({ ok: false, check: expect.objectContaining({ id: 'installed', reason: 'not-installed', fix: 'download' }) });
    const stopped = await tailscaleStatus({ exec: recordingExec(() => ({ stdout: status({}, { BackendState: 'Stopped' }) })).exec });
    expect(stopped).toEqual({ ok: false, check: expect.objectContaining({ id: 'self', reason: 'stopped' }) });
  });

  it('names the CLI that answered, skipping one whose own daemon is not running', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: status({}) }));
    const stub: TailscaleExec = async (cmd, args, opts) => {
      if (cmd === 'tailscale') throw failure({ stderr: 'failed to connect to local tailscaled; it doesn’t appear to be running' });
      return exec(cmd, args, opts);
    };
    const read = await tailscaleStatus({ exec: stub, candidates: ['tailscale', APP_CLI] });
    expect(read).toMatchObject({ ok: true, bin: APP_CLI });
    expect(calls).toEqual([['status', '--json']]);
  });

  it('is ready with no other device online (discovery does not need the peer check)', async () => {
    const read = await tailscaleStatus({ exec: recordingExec(() => ({ stdout: status({}) })).exec });
    expect(read.ok).toBe(true);
  });
});

describe('parseWhois / tailscaleWhois', () => {
  it('reads the node, its device name and its login', () => {
    expect(parseWhois(whoisJson(), '100.101.12.4')).toEqual({
      nodeName: 'desk.tail1.ts.net',
      deviceName: 'desk',
      os: 'windows',
      stableId: 'nDESK',
      userId: 7,
      tags: [],
      addresses: ['100.101.12.4/32', 'fd7a:115c:a1e0::4/128'],
      allowedIps: ['100.101.12.4/32', 'fd7a:115c:a1e0::4/128'],
      routableIps: [],
      primaryRoutes: [],
      loginName: 'me@example.com',
      displayName: 'Me',
    });
    // No ComputedName: the host name.
    expect(parseWhois(whoisJson({ node: { ComputedName: '' } }), '100.101.12.4')?.deviceName).toBe('DESKTOP-1');
  });

  it('is null unless AllowedIPs, like Addresses, lists the address (Tailscale always does)', () => {
    expect(parseWhois(whoisJson({ node: { AllowedIPs: undefined } }), '100.101.12.4')).toBeNull();
    expect(parseWhois(whoisJson({ node: { AllowedIPs: 'x' } }), '100.101.12.4')).toBeNull();
    expect(parseWhois(whoisJson({ node: { AllowedIPs: ['fd7a:115c:a1e0::4/128'] } }), '100.101.12.4')).toBeNull();
    expect(parseWhois(whoisJson({ node: { Addresses: undefined } }), '100.101.12.4')).toBeNull();
  });

  it('asks whois through the CLI that answered status', async () => {
    const seen: string[] = [];
    const exec: TailscaleExec = async (cmd, args) => {
      seen.push(cmd);
      // A Homebrew stub beside the app: its own daemon is not running.
      if (cmd === 'tailscale') throw failure({ stderr: 'failed to connect to local tailscaled' });
      return { stdout: args[0] === 'status' ? status({}) : whoisJson(), stderr: '' };
    };
    const read = await tailscaleStatus({ exec, candidates: ['tailscale', APP_CLI] });
    if (!read.ok) throw new Error('status failed');
    seen.length = 0;
    expect(await tailscaleWhois('100.101.12.4', { exec, bin: read.bin, candidates: ['tailscale', APP_CLI] })).toMatchObject({ stableId: 'nDESK' });
    expect(seen).toEqual([APP_CLI]);
    // Unpinned, it still moves past a CLI whose daemon is not running, as status does.
    seen.length = 0;
    expect(await tailscaleWhois('100.101.12.4', { exec, candidates: ['tailscale', APP_CLI] })).toMatchObject({ stableId: 'nDESK' });
    expect(seen).toEqual(['tailscale', APP_CLI]);
  });

  it('refuses an argument that is not a canonical tailnet IPv4 without running anything', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: whoisJson() }));
    for (const bad of ['192.168.1.4', '100.128.0.1', '100.101.012.4', '100.101.12.4 ', '-h', '100.101.12.4/32', 'desk', '']) {
      expect(await tailscaleWhois(bad, { exec }), bad).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it('asks whois --json for the address', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: whoisJson() }));
    expect(await tailscaleWhois('100.101.12.4', { exec })).toMatchObject({ stableId: 'nDESK' });
    expect(calls).toEqual([['whois', '--json', '100.101.12.4']]);
  });

  it('is null on a non-zero exit, unparsable output, a CLI without --json, or another address', async () => {
    const cases: Array<[string, (args: string[]) => { stdout: string } | Error]> = [
      ['non-zero exit', () => failure({ stderr: 'no match for IP:port 100.101.12.4' })],
      ['unparsable', () => ({ stdout: '{"Node":' })],
      ['flag unknown', () => failure({ stderr: 'flag provided but not defined: -json' })],
      ['text output', () => ({ stdout: 'Machine:\n  Name: desk.tail1.ts.net\n' })],
      ['address mismatch', () => ({ stdout: whoisJson({ node: { Addresses: ['100.101.12.5/32'] } }) })],
      ['no stable id', () => ({ stdout: whoisJson({ node: { StableID: '' } }) })],
    ];
    for (const [name, answer] of cases) {
      expect(await tailscaleWhois('100.101.12.4', { exec: recordingExec(answer).exec }), name).toBeNull();
    }
  });

  it('gives up after its timeout, aborting the read', async () => {
    let aborted = false;
    const exec: TailscaleExec = (_cmd, _args, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    expect(await tailscaleWhois('100.101.12.4', { exec, timeoutMs: 20 })).toBeNull();
    expect(aborted).toBe(true);
  });
});

describe('judgeWhois', () => {
  const self = { stableId: 'nSELF', userId: 7 };
  const who = (over: Parameters<typeof whoisJson>[0] = {}): TailnetWhois => parseWhois(whoisJson(over), '100.101.12.4')!;

  it('accepts another untagged node of the same user that routes only its own addresses', () => {
    expect(judgeWhois(who(), self)).toEqual({ ok: true });
  });

  it('refuses this PC itself', () => {
    expect(judgeWhois(who({ node: { StableID: 'nSELF' } }), self)).toEqual({ ok: false, reason: 'self' });
  });

  it('refuses everything when this PC’s own node ID is unknown', () => {
    expect(judgeWhois(who(), { stableId: '', userId: 7 })).toEqual({ ok: false, reason: 'unidentified' });
  });

  it('compares numeric user IDs, not login names', () => {
    expect(judgeWhois(who({ node: { User: 8 } }), self)).toEqual({ ok: false, reason: 'other-user' });
    // Same login string, other user ID (another tailnet, another identity provider).
    expect(judgeWhois(who({ node: { User: 8 }, profile: { LoginName: 'me@example.com' } }), self)).toEqual({ ok: false, reason: 'other-user' });
    expect(judgeWhois(who(), { stableId: 'nSELF', userId: null })).toEqual({ ok: false, reason: 'other-user' });
    // User 0 is Go's unset value, never a match.
    expect(judgeWhois(who({ node: { User: 0 } }), { stableId: 'nSELF', userId: null })).toEqual({ ok: false, reason: 'other-user' });
    expect(who({ node: { User: 0 } }).userId).toBeNull();
  });

  it('refuses a tagged node', () => {
    expect(judgeWhois(who({ node: { Tags: ['tag:ci'] } }), self)).toEqual({ ok: false, reason: 'tagged' });
  });

  it('refuses a subnet router or exit node, active or standby', () => {
    const v4 = '100.101.12.4/32';
    const v6 = 'fd7a:115c:a1e0::4/128';
    // Standby router: the route is allowed but not primary.
    expect(judgeWhois(who({ node: { AllowedIPs: [v4, v6, '192.168.1.0/24'] } }), self)).toEqual({ ok: false, reason: 'subnet-router' });
    // Advertised but not approved yet.
    expect(judgeWhois(who({ hostinfo: { RoutableIPs: ['10.0.0.0/8'] } }), self)).toEqual({ ok: false, reason: 'subnet-router' });
    expect(judgeWhois(who({ hostinfo: { RoutableIPs: ['0.0.0.0/0', '::/0'] } }), self)).toEqual({ ok: false, reason: 'subnet-router' });
    expect(judgeWhois(who({ node: { PrimaryRoutes: ['192.168.1.0/24'] } }), self)).toEqual({ ok: false, reason: 'subnet-router' });
    // A wider prefix among Addresses is not the node's own address.
    const wide = { Addresses: [v4, v6, '100.101.12.0/24'], AllowedIPs: [v4, v6, '100.101.12.0/24'] };
    expect(judgeWhois(who({ node: wide }), self)).toEqual({ ok: false, reason: 'subnet-router' });
  });
});

describe('fixtureTailscaleDirExec', () => {
  const dir = path.join('fixtures', 'tailnet');
  const files: Record<string, string> = {
    [path.join(dir, 'status.json')]: status({}),
    [path.join(dir, 'whois', '100.101.12.4.json')]: whoisJson(),
  };
  const readFile = async (p: string): Promise<string> => {
    const text = files[p];
    if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return text;
  };
  const exec = fixtureTailscaleDirExec(dir, readFile);
  const opts = { timeout: 1, windowsHide: true, maxBuffer: 1 };

  it('answers status and whois from the directory', async () => {
    expect((await exec('tailscale', ['status', '--json'], opts)).stdout).toBe(files[path.join(dir, 'status.json')]);
    expect(await tailscaleWhois('100.101.12.4', { exec })).toMatchObject({ stableId: 'nDESK' });
    expect((await tailscaleStatus({ exec })).ok).toBe(true);
  });

  it('fails a whois it has no file for', async () => {
    await expect(exec('tailscale', ['whois', '--json', '100.101.12.9'], opts)).rejects.toMatchObject({ stderr: expect.stringContaining('no whois') });
  });

  it('refuses serve, other commands and an address that is not a canonical IPv4', async () => {
    for (const args of [
      ['serve', 'status', '--json'],
      ['serve', '--bg', '--https=443', 'http://127.0.0.1:1'],
      ['up'],
      ['whois', '100.101.12.4'],
      ['whois', '--json', '../status'],
      ['whois', '--json', '100.101.12.4/../../x'],
      // Canonical, but not a tailnet address.
      ['whois', '--json', '192.168.1.4'],
    ]) {
      await expect(exec('tailscale', args, opts), args.join(' ')).rejects.toMatchObject({ stderr: 'fixture: refused' });
    }
  });
});
