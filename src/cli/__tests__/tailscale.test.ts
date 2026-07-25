import { describe, it, expect } from 'vitest';
import {
  classifyServeConfig,
  classifyServeError,
  classifyStatusError,
  decideTailscaleBinding,
  describeTailscaleProblem,
  errText,
  ensureTailscaleServe,
  parseTailnetIdentity,
  removeTailscaleServe,
  tailscaleCandidates,
  type TailscaleExec,
  type TailscaleProblem,
} from '../tailscale';

/**
 * Nothing in here spawns a binary: every shell-out goes through the injected
 * `exec` seam, so the tests assert on the exact argv `wmux web --tailscale`
 * would run rather than on whatever a real tailscale happens to be doing.
 */

const WEB_PORT = 7681;

const STATUS_RUNNING = JSON.stringify({
  BackendState: 'Running',
  // Trailing dot and mixed case, exactly as the real client emits it.
  Self: { HostName: 'Laptop', DNSName: 'Laptop.tail1234.ts.net.' },
  CurrentTailnet: { MagicDNSEnabled: true },
});

function serveOurs(webPort = WEB_PORT, servePort = 443): string {
  return JSON.stringify({
    TCP: { [String(servePort)]: { HTTPS: true } },
    Web: {
      [`laptop.tail1234.ts.net:${servePort}`]: {
        Handlers: { '/': { Proxy: `http://127.0.0.1:${webPort}` } },
      },
    },
  });
}

function enoent(): Error {
  const err = new Error('spawn tailscale ENOENT') as Error & { code?: string };
  err.code = 'ENOENT';
  return err;
}

function execFailure(stderr: string): Error {
  const err = new Error('Command failed') as Error & { stderr?: string };
  err.stderr = stderr;
  return err;
}

type Script = (args: string[]) => { stdout?: string; stderr?: string } | Error;

function fakeExec(script: Script) {
  const calls: string[][] = [];
  const exec: TailscaleExec = async (_cmd, args) => {
    calls.push(args);
    const out = script(args);
    if (out instanceof Error) throw out;
    return { stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  };
  return { exec, calls };
}

/** Did the fake ever get asked to write a serve config? */
function registered(calls: string[][]): boolean {
  return calls.some((a) => a[0] === 'serve' && a.includes('--bg'));
}

/** Did the fake ever get asked to tear one down? */
function deregistered(calls: string[][]): boolean {
  return calls.some((a) => a[0] === 'serve' && a.includes('off'));
}

describe('parseTailnetIdentity', () => {
  it('reads the MagicDNS name, normalised', () => {
    expect(parseTailnetIdentity(STATUS_RUNNING)).toEqual({ ok: true, magicDns: 'laptop.tail1234.ts.net' });
  });

  it.each([
    ['NeedsLogin', 'not-logged-in'],
    ['NoState', 'not-logged-in'],
    ['NeedsMachineAuth', 'needs-machine-auth'],
    ['Stopped', 'stopped'],
  ] as Array<[string, TailscaleProblem]>)('maps BackendState %s to %s', (state, problem) => {
    const json = JSON.stringify({ BackendState: state, Self: { DNSName: 'laptop.tail1234.ts.net.' } });
    expect(parseTailnetIdentity(json)).toEqual({ ok: false, problem });
  });

  it('refuses a tailnet with MagicDNS disabled even when a name is present', () => {
    const json = JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: 'laptop.tail1234.ts.net.' },
      CurrentTailnet: { MagicDNSEnabled: false },
    });
    expect(parseTailnetIdentity(json)).toEqual({ ok: false, problem: 'no-magicdns' });
  });

  it('refuses a bare hostname — there is nothing to issue a certificate for', () => {
    const json = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'laptop' } });
    expect(parseTailnetIdentity(json)).toEqual({ ok: false, problem: 'no-magicdns' });
  });

  it('refuses a missing Self block', () => {
    expect(parseTailnetIdentity(JSON.stringify({ BackendState: 'Running' }))).toEqual({
      ok: false,
      problem: 'no-magicdns',
    });
  });

  it('reports unreadable output rather than guessing', () => {
    expect(parseTailnetIdentity('not json')).toEqual({ ok: false, problem: 'status-unreadable' });
    expect(parseTailnetIdentity('null')).toEqual({ ok: false, problem: 'status-unreadable' });
  });
});

describe('classifyServeConfig', () => {
  const opts = { servePort: 443, webPort: WEB_PORT };

  it('treats no output and an empty object as a free slot', () => {
    expect(classifyServeConfig('', opts)).toBe('free');
    expect(classifyServeConfig('   ', opts)).toBe('free');
    expect(classifyServeConfig('{}', opts)).toBe('free');
  });

  it('recognises its own registration', () => {
    expect(classifyServeConfig(serveOurs(), opts)).toBe('ours');
  });

  it('accepts localhost and bracketed IPv6 loopback spellings', () => {
    for (const host of ['localhost', '[::1]']) {
      const json = JSON.stringify({
        Web: { 'laptop.ts.net:443': { Handlers: { '/': { Proxy: `http://${host}:${WEB_PORT}` } } } },
      });
      expect(classifyServeConfig(json, opts)).toBe('ours');
    }
  });

  it('calls a proxy to another port foreign', () => {
    expect(classifyServeConfig(serveOurs(3000), opts)).toBe('foreign');
  });

  it('calls a proxy to another machine foreign', () => {
    const json = JSON.stringify({
      Web: { 'laptop.ts.net:443': { Handlers: { '/': { Proxy: `http://192.168.1.9:${WEB_PORT}` } } } },
    });
    expect(classifyServeConfig(json, opts)).toBe('foreign');
  });

  it('calls a config with extra handler paths foreign', () => {
    const json = JSON.stringify({
      Web: {
        'laptop.ts.net:443': {
          Handlers: { '/': { Proxy: `http://127.0.0.1:${WEB_PORT}` }, '/blog': { Path: '/srv/blog' } },
        },
      },
    });
    expect(classifyServeConfig(json, opts)).toBe('foreign');
  });

  it('calls a bare TCP forward on the same port foreign', () => {
    expect(classifyServeConfig(JSON.stringify({ TCP: { '443': { TCPForward: 'localhost:22' } } }), opts)).toBe(
      'foreign',
    );
  });

  it('ignores a config on a different serve port', () => {
    expect(classifyServeConfig(serveOurs(WEB_PORT, 8443), opts)).toBe('free');
  });

  it('reports unreadable output rather than assuming the slot is free', () => {
    expect(classifyServeConfig('<html>', opts)).toBe('unreadable');
  });
});

describe('decideTailscaleBinding', () => {
  it('binds loopback on its own', () => {
    expect(decideTailscaleBinding({ expose: false })).toEqual({ ok: true, host: '127.0.0.1', warnings: [] });
  });

  it.each(['127.0.0.1', 'localhost', '::1', 'LOCALHOST'])('accepts the loopback host %s silently', (h) => {
    const out = decideTailscaleBinding({ explicitHost: h, expose: false });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.warnings).toEqual([]);
  });

  it('honours --expose but warns that the port is now directly reachable', () => {
    const out = decideTailscaleBinding({ expose: true });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.host).toBe('0.0.0.0');
      expect(out.warnings).toHaveLength(1);
      expect(out.warnings[0]).toMatch(/plaintext/);
    }
  });

  it.each(['0.0.0.0', '::'])('honours the wildcard host %s with the same warning', (h) => {
    const out = decideTailscaleBinding({ explicitHost: h, expose: false });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.host).toBe(h);
      expect(out.warnings).toHaveLength(1);
    }
  });

  it('refuses a pinned non-loopback bind instead of silently ignoring a flag', () => {
    const out = decideTailscaleBinding({ explicitHost: '192.168.1.9', expose: false });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain('192.168.1.9');
      expect(out.error).toContain('127.0.0.1');
    }
  });
});

describe('describeTailscaleProblem', () => {
  const problems: TailscaleProblem[] = [
    'not-installed',
    'not-logged-in',
    'needs-machine-auth',
    'stopped',
    'no-magicdns',
    'status-unreadable',
    'serve-status-unreadable',
    'port-taken',
    'needs-elevation',
    'no-https-certs',
    'serve-failed',
  ];

  it.each(problems)('gives %s actionable copy that ends with the no-op promise', (problem) => {
    const lines = describeTailscaleProblem(problem);
    expect(lines[0]).toMatch(/^Error: /);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[lines.length - 1]).toContain('no serve configuration was left behind');
  });

  it('quotes what tailscale said, minus the exec wrapper line', () => {
    // Dogfooding: `tailscale serve` failed with "Serve is not enabled on your
    // tailnet" plus a one-click URL to enable it — and only the first line was
    // printed, which is the exec wrapper naming the command. The operator was
    // left with a failure and no next step while the answer sat one line below.
    const detail = [
      'Command failed: C:\\Program Files\\Tailscale\\tailscale.exe serve --bg --https=443',
      'Serve is not enabled on your tailnet.',
      'To enable, visit:',
      'https://login.tailscale.com/f/serve?node=abc123',
    ].join('\n');
    const lines = describeTailscaleProblem('serve-failed', detail);
    const text = lines.join('\n');
    expect(text).toContain('Serve is not enabled on your tailnet.');
    expect(text).toContain('https://login.tailscale.com/f/serve?node=abc123');
    // the wrapper names the command we just ran and helps nobody
    expect(text).not.toContain('Command failed:');
    // the rollback statement must still be the last thing they read
    expect(lines[lines.length - 1]).toContain('no serve configuration was left behind');
  });

  it('caps a pathological stderr so it cannot bury the rollback line', () => {
    const detail = Array.from({ length: 40 }, (_, i) => 'noise line ' + i).join('\n');
    const lines = describeTailscaleProblem('serve-failed', detail);
    expect(lines.filter((l) => l.includes('noise line')).length).toBeLessThanOrEqual(8);
    expect(lines[lines.length - 1]).toContain('no serve configuration was left behind');
  });
});

describe('errText', () => {
  it('prefers stderr', () => {
    const err = Object.assign(new Error('Command failed'), { stderr: 'boom', stdout: 'ignored' });
    expect(errText(err)).toBe('boom');
  });

  it('falls back to stdout, which is where tailscale puts the useful failure', () => {
    // Verified against the real client: `tailscale serve` writes "Serve is not
    // enabled on your tailnet." and the URL to enable it to STDOUT, leaving
    // stderr empty. Reading stderr only reduced the operator's output to the
    // exec wrapper naming the command.
    const err = Object.assign(new Error('Command failed: tailscale serve --bg'), {
      stderr: '',
      stdout: 'Serve is not enabled on your tailnet.\nTo enable, visit:\nhttps://login.tailscale.com/f/serve?node=abc',
    });
    expect(errText(err)).toContain('Serve is not enabled');
    expect(errText(err)).toContain('login.tailscale.com/f/serve');
  });

  it('falls back to the message when the process said nothing', () => {
    expect(errText(Object.assign(new Error('spawn ENOENT'), { stderr: '', stdout: '' }))).toBe('spawn ENOENT');
  });
});

describe('error classification', () => {
  it('maps a missing binary to not-installed', () => {
    expect(classifyStatusError(enoent())).toBe('not-installed');
  });

  it('maps a logged-out client', () => {
    expect(classifyStatusError(execFailure('Logged out. Please run: tailscale up'))).toBe('not-logged-in');
  });

  it('maps a stopped client', () => {
    expect(classifyStatusError(execFailure('Tailscale is stopped.'))).toBe('stopped');
  });

  it('falls back to status-unreadable for anything else', () => {
    expect(classifyStatusError(execFailure('weird'))).toBe('status-unreadable');
  });

  it('recognises a certificate problem ahead of a privilege one', () => {
    expect(classifyServeError('HTTPS is not enabled on this tailnet')).toBe('no-https-certs');
  });

  it('recognises a privilege problem', () => {
    expect(classifyServeError('Access is denied.')).toBe('needs-elevation');
    expect(classifyServeError('use --operator=$USER to allow this')).toBe('needs-elevation');
  });

  it('falls back to serve-failed', () => {
    expect(classifyServeError('something else entirely')).toBe('serve-failed');
  });
});

describe('ensureTailscaleServe', () => {
  it('registers the proxy and reports the tailnet origin', async () => {
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === 'status') return { stdout: STATUS_RUNNING };
      if (args[0] === 'serve' && args[1] === 'status') return { stdout: '{}' };
      return { stdout: '' };
    });

    const out = await ensureTailscaleServe({ webPort: WEB_PORT, exec });
    expect(out).toEqual({
      ok: true,
      magicDns: 'laptop.tail1234.ts.net',
      servePort: 443,
      url: 'https://laptop.tail1234.ts.net',
    });
    expect(calls).toContainEqual(['serve', '--bg', '--https=443', `http://127.0.0.1:${WEB_PORT}`]);
  });

  it('spells out a non-default serve port in the URL', async () => {
    const { exec } = fakeExec((args) => {
      if (args[0] === 'status') return { stdout: STATUS_RUNNING };
      return { stdout: '{}' };
    });
    const out = await ensureTailscaleServe({ webPort: WEB_PORT, servePort: 8443, exec });
    expect(out.ok && out.url).toBe('https://laptop.tail1234.ts.net:8443');
  });

  it('reports a missing binary without touching serve', async () => {
    const { exec, calls } = fakeExec(() => enoent());
    const out = await ensureTailscaleServe({ webPort: WEB_PORT, exec });
    expect(out).toMatchObject({ ok: false, problem: 'not-installed' });
    expect(registered(calls)).toBe(false);
  });

  it('reports a logged-out client without touching serve', async () => {
    const { exec, calls } = fakeExec(() => execFailure('Logged out. Please run: tailscale up'));
    const out = await ensureTailscaleServe({ webPort: WEB_PORT, exec });
    expect(out).toMatchObject({ ok: false, problem: 'not-logged-in' });
    expect(registered(calls)).toBe(false);
  });

  it('REFUSES to clobber a foreign serve config', async () => {
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === 'status') return { stdout: STATUS_RUNNING };
      if (args[0] === 'serve' && args[1] === 'status') return { stdout: serveOurs(3000) };
      return { stdout: '' };
    });

    const out = await ensureTailscaleServe({ webPort: WEB_PORT, exec });
    expect(out).toMatchObject({ ok: false, problem: 'port-taken' });
    expect(registered(calls)).toBe(false);
    expect(deregistered(calls)).toBe(false);
  });

  it('fails closed when the serve config cannot be read', async () => {
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === 'status') return { stdout: STATUS_RUNNING };
      if (args[0] === 'serve' && args[1] === 'status') return { stdout: '<html>' };
      return { stdout: '' };
    });

    const out = await ensureTailscaleServe({ webPort: WEB_PORT, exec });
    expect(out).toMatchObject({ ok: false, problem: 'serve-status-unreadable' });
    expect(registered(calls)).toBe(false);
  });

  it('re-registers over its own existing config', async () => {
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === 'status') return { stdout: STATUS_RUNNING };
      if (args[0] === 'serve' && args[1] === 'status') return { stdout: serveOurs() };
      return { stdout: '' };
    });

    const out = await ensureTailscaleServe({ webPort: WEB_PORT, exec });
    expect(out.ok).toBe(true);
    expect(registered(calls)).toBe(true);
  });

  it('rolls back a failed registration when the slot had been free', async () => {
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === 'status') return { stdout: STATUS_RUNNING };
      if (args[0] === 'serve' && args[1] === 'status') return { stdout: '{}' };
      if (args.includes('--bg')) return execFailure('Access is denied.');
      return { stdout: '' };
    });

    const out = await ensureTailscaleServe({ webPort: WEB_PORT, exec });
    expect(out).toMatchObject({ ok: false, problem: 'needs-elevation' });
    expect(calls).toContainEqual(['serve', '--https=443', 'off']);
  });

  it('does NOT roll back over a config that was already ours', async () => {
    // Tearing down here would delete a working setup the operator had, in
    // response to a failure that did not create anything.
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === 'status') return { stdout: STATUS_RUNNING };
      if (args[0] === 'serve' && args[1] === 'status') return { stdout: serveOurs() };
      if (args.includes('--bg')) return execFailure('HTTPS is not enabled on this tailnet');
      return { stdout: '' };
    });

    const out = await ensureTailscaleServe({ webPort: WEB_PORT, exec });
    expect(out).toMatchObject({ ok: false, problem: 'no-https-certs' });
    expect(deregistered(calls)).toBe(false);
  });
});

describe('removeTailscaleServe', () => {
  it('removes its own registration', async () => {
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === 'serve' && args[1] === 'status') return { stdout: serveOurs() };
      return { stdout: '' };
    });

    expect(await removeTailscaleServe({ webPort: WEB_PORT, exec })).toEqual({ removed: true, reason: 'removed' });
    expect(calls).toContainEqual(['serve', '--https=443', 'off']);
  });

  it("leaves someone else's registration alone", async () => {
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === 'serve' && args[1] === 'status') return { stdout: serveOurs(3000) };
      return { stdout: '' };
    });

    expect(await removeTailscaleServe({ webPort: WEB_PORT, exec })).toEqual({ removed: false, reason: 'not-ours' });
    expect(deregistered(calls)).toBe(false);
  });

  it('does nothing when there is no config at all', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '{}' }));
    expect(await removeTailscaleServe({ webPort: WEB_PORT, exec })).toEqual({ removed: false, reason: 'nothing' });
    expect(deregistered(calls)).toBe(false);
  });

  it('stays silent on a machine with no tailscale', async () => {
    const { exec, calls } = fakeExec(() => enoent());
    expect(await removeTailscaleServe({ webPort: WEB_PORT, exec })).toEqual({
      removed: false,
      reason: 'unavailable',
    });
    expect(deregistered(calls)).toBe(false);
  });
});

describe('tailscaleCandidates', () => {
  it('offers the Windows install path as a fallback for a PATH-less shell', () => {
    const candidates = tailscaleCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    if (process.platform === 'win32') {
      expect(candidates[0]).toBe('tailscale.exe');
      expect(candidates[1]).toMatch(/Tailscale[\\/]tailscale\.exe$/);
    } else {
      expect(candidates).toEqual(['tailscale']);
    }
  });
});
