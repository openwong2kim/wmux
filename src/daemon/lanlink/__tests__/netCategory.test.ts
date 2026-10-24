// @wmux-lane unit
// Every OS call here is injected (platform and exec are fakes); nothing spawns.
// The real powershell.exe read runs in netCategory.os.test.ts.
import { describe, it, expect, vi } from 'vitest';
import {
  categoryScript,
  parseCategoryOutput,
  readNetCategory,
  QUERY_TIMEOUT_MS,
  type ExecFileFn,
} from '../netCategory';
import { DAEMON_RPC_TIMEOUT_MS } from '../../../shared/timeouts';

describe('categoryScript', () => {
  it('maps the address to its interface index, then reads that index\'s profile', () => {
    const script = categoryScript('192.168.1.10');
    expect(script).toContain("Get-NetIPAddress -IPAddress '192.168.1.10' -AddressFamily IPv4");
    expect(script).toContain('Get-NetConnectionProfile -InterfaceIndex $a[0].InterfaceIndex');
    expect(script).not.toMatch(/InterfaceAlias/);
  });

  it.each([
    "1.2.3.4'; Remove-Item x; '",
    '1.2.3.4 ',
    '256.1.1.1',
    '1.2.3',
    '::1',
    '',
  ])('refuses %j, so nothing but a dotted quad reaches the script', (ip) => {
    expect(() => categoryScript(ip)).toThrow(/not an IPv4 address/);
  });
});

describe('parseCategoryOutput', () => {
  it.each([
    ['category=Private\r\n', 'Private'],
    ['category=Public\n', 'Public'],
    ['category=DomainAuthenticated', 'Domain'],
    ['category=none\r\n', 'Unknown'],
  ] as const)('reads %j as %s', (out, expected) => {
    expect(parseCategoryOutput(out)).toBe(expected);
  });

  it.each([
    ['', /expected one category line, got 0/],
    ['category=Private\ncategory=Public\n', /expected one category line, got 2/],
    ['category=Privat\n', /unrecognized network category/],
  ])('throws on %j', (out, err) => {
    expect(() => parseCategoryOutput(out)).toThrow(err);
  });
});

describe('readNetCategory', () => {
  it('is not-applicable on macOS and Linux, and spawns nothing there', async () => {
    const exec = vi.fn<ExecFileFn>();
    await expect(readNetCategory('192.168.1.10', { platform: 'darwin', exec })).resolves.toBe('not-applicable');
    await expect(readNetCategory('192.168.1.10', { platform: 'linux', exec })).resolves.toBe('not-applicable');
    expect(exec).not.toHaveBeenCalled();
  });

  it('runs Windows PowerShell by absolute path, hidden, bounded under the RPC ceiling', async () => {
    const exec = vi.fn<ExecFileFn>(async () => ({ stdout: 'category=Private\r\n' }));
    await expect(readNetCategory('192.168.1.10', { platform: 'win32', exec })).resolves.toBe('Private');
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args, opts] = exec.mock.calls[0];
    expect(file).toMatch(/[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args).not.toContain('-ExecutionPolicy');
    expect(args).not.toContain('-EncodedCommand');
    expect(opts.windowsHide).toBe(true);
    expect(opts.timeout).toBe(QUERY_TIMEOUT_MS);
    expect(QUERY_TIMEOUT_MS).toBeLessThan(DAEMON_RPC_TIMEOUT_MS);
  });

  it('rejects when PowerShell fails, so the caller does not listen', async () => {
    const exec = vi.fn<ExecFileFn>(async () => { throw new Error('Command failed: exit 1'); });
    await expect(readNetCategory('192.168.1.10', { platform: 'win32', exec })).rejects.toThrow(/exit 1/);
  });

  it('rejects on output it cannot read', async () => {
    const exec = vi.fn<ExecFileFn>(async () => ({ stdout: '' }));
    await expect(readNetCategory('192.168.1.10', { platform: 'win32', exec })).rejects.toThrow(/category line/);
  });
});
