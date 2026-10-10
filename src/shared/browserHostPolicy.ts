// Host allow/block matching for protected browser panes.
//
// Pure and dependency-free: main's filtering proxy, main's navigation gate and
// the MCP lane's cookie filter all decide with this one module, so a host that
// one of them lets through is never refused by another (or the reverse).
//
// Rules are HOSTS, not URLs:
//   example.com          exactly example.com, any port
//   *.example.com        example.com and every subdomain of it, any port
//   example.com:8443     exactly example.com, port 8443 only
//   127.0.0.1, [::1]     an IP literal, exactly (never wildcarded)
// A leading `http://` / `https://` and one trailing `/` are tolerated so a
// pasted origin works; credentials, paths, queries and fragments are refused.
//
// Matching runs on the WHATWG-parsed host, so every spelling of one host is
// one host: case, IDNA (Unicode and punycode compare equal), one terminal dot,
// and the decimal / hex / octal IPv4 forms. Subdomain matching is on a label
// boundary: `*.example.com` never matches `evil-example.com`.
//
// Schemes (navigation targets — see `navigationVerdict`): http, https, ws and
// wss are matched on their host. `about:blank` is the one controlled bootstrap
// page and is allowed. Every other scheme — file, javascript, data, blob,
// chrome, devtools, view-source, about:<anything else>, unknown — is refused as
// a navigation target on a protected pane, and an unparseable URL is refused.
// data: and blob: SUBRESOURCES never reach the network, so the proxy has
// nothing to decide about them; they inherit the page that made them, which
// the proxy already allowed.

export type HostPolicyMode = 'off' | 'allowlist';

/** A pane's site policy. `allowlist` with an empty `allow` blocks every host;
 *  `block` always wins over `allow` (and applies in `off` mode too). */
export interface HostPolicy {
  mode: HostPolicyMode;
  allow: string[];
  block: string[];
}

/** One parsed rule. `host` is canonical (lowercase ASCII, no terminal dot,
 *  IPv6 in brackets). */
export interface HostRule {
  host: string;
  /** `*.host`: the host itself and every subdomain. Never set on an IP. */
  wildcard: boolean;
  /** Absent = any port. */
  port?: number;
  ip: boolean;
}

/** The deny-everything policy (used for an unconfirmed or rebound pane). */
export const DENY_ALL_HOST_POLICY: Readonly<HostPolicy> = Object.freeze({
  mode: 'allowlist' as const,
  allow: Object.freeze([]) as unknown as string[],
  block: Object.freeze([]) as unknown as string[],
});

const MAX_RULE_LENGTH = 260;
const MAX_RULES = 500;
const DNS_HOST = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function stripTerminalDot(host: string): string {
  return host.endsWith('.') && !host.endsWith('..') ? host.slice(0, -1) : host;
}

/**
 * The canonical form of a bare host (`example.com`, `[::1]`, `0x7f.1`), or null
 * when it is not a valid host. No port, no wildcard, no userinfo.
 */
export function canonicalHost(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RULE_LENGTH) return null;
  if (/[\s/?#@\\*%]/.test(raw)) return null;
  // A port, even a default one the parser would drop silently.
  if (raw.replace(/^\[[^\]]*\]$/, '').includes(':')) return null;
  let parsed: URL;
  try {
    parsed = new URL(`http://${raw}`);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password || parsed.port) return null;
  return validHostname(parsed.hostname);
}

/** Validate a hostname the WHATWG parser already produced (lowercase, IDNA). */
function validHostname(hostname: string): string | null {
  const host = stripTerminalDot(hostname);
  if (host.startsWith('[') && host.endsWith(']')) return host;
  if (IPV4.test(host)) return host;
  return DNS_HOST.test(host) ? host : null;
}

function isIpLiteral(host: string): boolean {
  return host.startsWith('[') || IPV4.test(host);
}

/** Parse one rule; `{ error }` says why it was refused. */
export function parseHostRule(raw: unknown): HostRule | { error: string } {
  if (typeof raw !== 'string') return { error: 'a host rule must be a string' };
  let rule = raw.trim();
  if (rule.length === 0) return { error: 'empty host rule' };
  if (rule.length > MAX_RULE_LENGTH) return { error: 'host rule is too long' };
  const scheme = /^(https?):\/\//i.exec(rule);
  if (scheme) {
    rule = rule.slice(scheme[0].length);
    if (rule.endsWith('/')) rule = rule.slice(0, -1);
  }
  if (rule.includes('@')) return { error: `host rule "${raw}" must not carry credentials` };
  if (/[/?#\\\s]/.test(rule)) return { error: `host rule "${raw}" must be a host, not a URL path` };
  let wildcard = false;
  if (rule.startsWith('*.')) {
    wildcard = true;
    rule = rule.slice(2);
  }
  if (rule.includes('*')) return { error: `host rule "${raw}" may use "*." only as a prefix` };
  let parsed: URL;
  try {
    parsed = new URL(`http://${rule}`);
  } catch {
    return { error: `host rule "${raw}" is not a valid host` };
  }
  if (parsed.username || parsed.password) {
    return { error: `host rule "${raw}" must not carry credentials` };
  }
  const host = validHostname(parsed.hostname);
  if (!host) return { error: `host rule "${raw}" is not a valid host` };
  // `new URL('http://x:80')` drops the default port, so read it from the text.
  const portText = /:(\d{1,5})$/.exec(rule)?.[1];
  let port: number | undefined;
  if (portText !== undefined) {
    port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: `host rule "${raw}" has an invalid port` };
    }
  } else if (parsed.port) {
    return { error: `host rule "${raw}" has an invalid port` };
  }
  const ip = isIpLiteral(host);
  if (ip && wildcard) return { error: `host rule "${raw}" cannot wildcard an IP address` };
  return { host, wildcard, ip, ...(port !== undefined && { port }) };
}

/** Validate a whole rule list (the IPC write path). */
export function parseHostRules(list: unknown): { rules: HostRule[] } | { error: string } {
  if (!Array.isArray(list)) return { error: 'host rules must be an array' };
  if (list.length > MAX_RULES) return { error: `at most ${MAX_RULES} host rules` };
  const rules: HostRule[] = [];
  for (const raw of list) {
    const r = parseHostRule(raw);
    if ('error' in r) return r;
    rules.push(r);
  }
  return { rules };
}

function ruleMatches(rule: HostRule, host: string, port: number): boolean {
  if (rule.port !== undefined && rule.port !== port) return false;
  if (rule.host === host) return true;
  if (!rule.wildcard || rule.ip) return false;
  return host.endsWith(`.${rule.host}`);
}

/** A compiled policy: one parse, many decisions (the proxy's hot path). */
export interface HostMatcher {
  /** `host` may be any spelling the WHATWG parser accepts (bracketed IPv6). */
  allows(host: string, port: number): boolean;
}

const DENY_ALL_MATCHER: HostMatcher = Object.freeze({ allows: () => false });

/**
 * Compile a policy. A policy carrying any rule that does not parse compiles to
 * deny-all: a stored rule the matcher cannot read is not a rule it may guess at.
 */
export function compileHostPolicy(policy: HostPolicy | null | undefined): HostMatcher {
  if (!policy || (policy.mode !== 'off' && policy.mode !== 'allowlist')) return DENY_ALL_MATCHER;
  const allow = parseHostRules(policy.allow ?? []);
  const block = parseHostRules(policy.block ?? []);
  if ('error' in allow || 'error' in block) return DENY_ALL_MATCHER;
  const mode = policy.mode;
  return Object.freeze({
    allows(rawHost: string, port: number): boolean {
      const host = canonicalHost(rawHost);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return false;
      if (block.rules.some((r) => ruleMatches(r, host, port))) return false;
      if (mode === 'off') return true;
      return allow.rules.some((r) => ruleMatches(r, host, port));
    },
  });
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };

/** The one controlled bootstrap page a protected pane may sit on. */
export const PROTECTED_BOOTSTRAP_URL = 'about:blank';

export type NavigationVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'invalid-url' | 'scheme' | 'host' };

/**
 * Whether a protected pane may be sent to `url` by a tool or an opener path.
 * The proxy decides again on every request; this refuses up front what the
 * proxy cannot see (non-network schemes) and gives the agent a clear answer
 * for a blocked host instead of a proxy error page.
 */
export function navigationVerdict(matcher: HostMatcher, url: string): NavigationVerdict {
  if (typeof url !== 'string') return { allowed: false, reason: 'invalid-url' };
  const trimmed = url.trim();
  if (trimmed === PROTECTED_BOOTSTRAP_URL) return { allowed: true };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { allowed: false, reason: 'invalid-url' };
  }
  const port = DEFAULT_PORTS[parsed.protocol];
  if (port === undefined) return { allowed: false, reason: 'scheme' };
  if (parsed.username || parsed.password) return { allowed: false, reason: 'invalid-url' };
  const effectivePort = parsed.port ? Number(parsed.port) : port;
  return matcher.allows(parsed.hostname, effectivePort) ? { allowed: true } : { allowed: false, reason: 'host' };
}

/**
 * Whether a cookie for `domain` (a cookie's `domain` attribute, with or without
 * the leading dot) belongs to an allowed host. A cookie has no port, so a rule
 * pinned to a port still admits its host's cookies. A domain cookie
 * (`.example.com`) is visible to every subdomain, so it is admitted only when
 * the apex itself is allowed.
 */
export function cookieDomainAllowed(policy: HostPolicy, domain: string): boolean {
  if (typeof domain !== 'string' || domain.length === 0) return false;
  const host = canonicalHost(domain.startsWith('.') ? domain.slice(1) : domain);
  if (!host) return false;
  const portless: HostPolicy = {
    mode: policy.mode,
    allow: (policy.allow ?? []).map(stripRulePort),
    block: (policy.block ?? []).map(stripRulePort),
  };
  return compileHostPolicy(portless).allows(host, 443);
}

function stripRulePort(rule: string): string {
  const parsed = parseHostRule(rule);
  if ('error' in parsed) return rule; // keeps the compile failing closed
  const host = parsed.wildcard ? `*.${parsed.host}` : parsed.host;
  return host;
}
