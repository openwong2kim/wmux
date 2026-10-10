import { describe, expect, it } from 'vitest';
import {
  canonicalHost,
  compileHostPolicy,
  cookieDomainAllowed,
  navigationVerdict,
  parseHostRule,
  type HostPolicy,
} from '../browserHostPolicy';

const allow = (...rules: string[]): HostPolicy => ({ mode: 'allowlist', allow: rules, block: [] });

describe('parseHostRule', () => {
  it('canonicalizes case, one terminal dot and IDNA', () => {
    expect(parseHostRule('EXAMPLE.com.')).toEqual({ host: 'example.com', wildcard: false, ip: false });
    expect(parseHostRule('bücher.de')).toEqual(parseHostRule('xn--bcher-kva.de'));
  });

  it('accepts a pasted origin and a port', () => {
    expect(parseHostRule('https://Example.com/')).toEqual({ host: 'example.com', wildcard: false, ip: false });
    expect(parseHostRule('example.com:8443')).toEqual({ host: 'example.com', wildcard: false, ip: false, port: 8443 });
    expect(parseHostRule('example.com:80')).toMatchObject({ port: 80 });
  });

  it('refuses credentials, paths, misplaced wildcards and wildcarded IPs', () => {
    for (const bad of ['user@example.com', 'https://u:p@example.com', 'example.com/path', 'ex*ample.com', '*.1.2.3.4', 'a..b', '', '   ', 'exa mple.com', 'example.com:0', 'example.com:70000']) {
      expect(parseHostRule(bad)).toHaveProperty('error');
    }
  });

  it('canonicalizes every IPv4 spelling and brackets IPv6', () => {
    for (const form of ['127.0.0.1', '0x7f.1', '0177.0.0.1', '2130706433']) {
      expect(parseHostRule(form)).toMatchObject({ host: '127.0.0.1', ip: true });
    }
    expect(parseHostRule('[::1]')).toMatchObject({ host: '[::1]', ip: true });
  });
});

describe('compileHostPolicy', () => {
  it('matches exact hosts on a label boundary only', () => {
    const m = compileHostPolicy(allow('example.com'));
    expect(m.allows('example.com', 443)).toBe(true);
    expect(m.allows('EXAMPLE.COM.', 443)).toBe(true);
    expect(m.allows('sub.example.com', 443)).toBe(false);
    expect(m.allows('evil-example.com', 443)).toBe(false);
    expect(m.allows('example.com.evil.net', 443)).toBe(false);
  });

  it('a *. rule admits the host and its subdomains, never a look-alike', () => {
    const m = compileHostPolicy(allow('*.example.com'));
    expect(m.allows('example.com', 443)).toBe(true);
    expect(m.allows('a.b.example.com', 443)).toBe(true);
    expect(m.allows('evil-example.com', 443)).toBe(false);
    expect(m.allows('notexample.com', 443)).toBe(false);
  });

  it('IDN spellings are one host', () => {
    expect(compileHostPolicy(allow('bücher.de')).allows('xn--bcher-kva.de', 443)).toBe(true);
    expect(compileHostPolicy(allow('xn--bcher-kva.de')).allows('BÜCHER.de', 443)).toBe(true);
  });

  it('a rule without a port matches any port; with one, only that port', () => {
    expect(compileHostPolicy(allow('a.test')).allows('a.test', 8080)).toBe(true);
    const pinned = compileHostPolicy(allow('a.test:8443'));
    expect(pinned.allows('a.test', 8443)).toBe(true);
    expect(pinned.allows('a.test', 443)).toBe(false);
  });

  it('IP literals match exactly in any spelling and never by wildcard', () => {
    const m = compileHostPolicy(allow('127.0.0.1', '[::1]'));
    expect(m.allows('0x7f.0.0.1', 80)).toBe(true);
    expect(m.allows('2130706433', 80)).toBe(true);
    expect(m.allows('127.0.0.2', 80)).toBe(false);
    expect(m.allows('[0:0:0:0:0:0:0:1]', 80)).toBe(true);
    expect(compileHostPolicy(allow('*.0.0.1')).allows('127.0.0.1', 80)).toBe(false);
  });

  it('an IPv4-mapped IPv6 address is the IPv4 address', () => {
    expect(canonicalHost('[::ffff:127.0.0.1]')).toBe('127.0.0.1');
    expect(canonicalHost('[0:0:0:0:0:FFFF:7F00:1]')).toBe('127.0.0.1');
    const blockLoopback: HostPolicy = { mode: 'off', allow: [], block: ['127.0.0.1'] };
    expect(compileHostPolicy(blockLoopback).allows('[::ffff:7f00:1]', 80)).toBe(false);
    expect(compileHostPolicy(allow('[::ffff:10.0.0.1]')).allows('10.0.0.1', 80)).toBe(true);
  });

  it('an empty allowlist blocks everything, block wins, off allows the rest', () => {
    expect(compileHostPolicy(allow()).allows('example.com', 443)).toBe(false);
    const both = compileHostPolicy({ mode: 'allowlist', allow: ['*.example.com'], block: ['ads.example.com'] });
    expect(both.allows('www.example.com', 443)).toBe(true);
    expect(both.allows('ads.example.com', 443)).toBe(false);
    const off = compileHostPolicy({ mode: 'off', allow: [], block: ['blocked.test'] });
    expect(off.allows('anything.test', 443)).toBe(true);
    expect(off.allows('blocked.test', 443)).toBe(false);
  });

  it('a stored rule that does not parse compiles to deny-all', () => {
    const m = compileHostPolicy({ mode: 'off', allow: [], block: ['user@bad'] });
    expect(m.allows('example.com', 443)).toBe(false);
    expect(compileHostPolicy(null).allows('example.com', 443)).toBe(false);
  });
});

describe('navigationVerdict', () => {
  const m = compileHostPolicy(allow('a.test'));

  it('matches http(s) and ws(s) on the host, with the scheme default port', () => {
    expect(navigationVerdict(m, 'https://a.test/x')).toEqual({ allowed: true });
    expect(navigationVerdict(m, 'http://A.TEST./')).toEqual({ allowed: true });
    expect(navigationVerdict(m, 'wss://a.test/socket')).toEqual({ allowed: true });
    expect(navigationVerdict(m, 'https://blocked.test/')).toEqual({ allowed: false, reason: 'host' });
  });

  it('reads the real hostname past userinfo, and refuses URLs that carry credentials', () => {
    expect(navigationVerdict(m, 'https://a.test@blocked.test/')).toEqual({ allowed: false, reason: 'invalid-url' });
    expect(navigationVerdict(compileHostPolicy(allow('blocked.test')), 'https://a.test@blocked.test/')).toEqual({
      allowed: false,
      reason: 'invalid-url',
    });
  });

  it('allows only the about:blank bootstrap among non-network schemes', () => {
    expect(navigationVerdict(m, 'about:blank')).toEqual({ allowed: true });
    for (const url of [
      'about:srcdoc',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'blob:https://a.test/uuid',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'view-source:https://a.test/',
      'ftp://a.test/',
      'chrome-extension://abc/x.html',
    ]) {
      expect(navigationVerdict(m, url)).toEqual({ allowed: false, reason: 'scheme' });
    }
    expect(navigationVerdict(m, 'not a url')).toEqual({ allowed: false, reason: 'invalid-url' });
  });
});

describe('cookieDomainAllowed', () => {
  it('admits a host cookie of an allowed host regardless of a pinned port', () => {
    expect(cookieDomainAllowed(allow('a.test:8443'), 'a.test')).toBe(true);
    expect(cookieDomainAllowed(allow('a.test'), '.a.test')).toBe(true);
    expect(cookieDomainAllowed(allow('a.test'), 'b.test')).toBe(false);
    expect(cookieDomainAllowed(allow('sub.a.test'), '.a.test')).toBe(false);
  });
});

describe('canonicalHost', () => {
  it('refuses userinfo, ports and wildcards', () => {
    expect(canonicalHost('user@a.test')).toBeNull();
    expect(canonicalHost('a.test:80')).toBeNull();
    expect(canonicalHost('*.a.test')).toBeNull();
    expect(canonicalHost('A.Test.')).toBe('a.test');
  });
});
