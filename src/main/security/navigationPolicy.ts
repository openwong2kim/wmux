import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { validateNavigationUrl } from '../../shared/types';

/**
 * Ceiling on the SSRF guard's DNS lookup (#756).
 *
 * `dns.lookup` inherits the OS resolver's own retry schedule, which on Windows
 * can exceed ten seconds before it gives up — longer than any RPC deadline in
 * front of it. An unbounded lookup here meant a slow or dead hostname surfaced
 * to the caller as `RPC timeout: browser.navigate`, naming the transport
 * instead of the actual failure, while the resolver was still grinding.
 *
 * Must stay comfortably below the tightest client deadline that can sit in
 * front of a navigate (the CLI's, see src/cli/client.ts) so the guard always
 * loses the race to its own error rather than to the socket's.
 */
export const DNS_LOOKUP_TIMEOUT_MS = 3_000;

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * A rejected lookup and a lookup that never answers are the same answer here:
 * we could not prove the destination is safe, so navigation must not proceed.
 * They are reported differently because only one of them is worth retrying.
 */
async function lookupWithTimeout(
  hostname: string,
  timeoutMs: number,
): Promise<{ ok: true; addresses: Array<{ address: string }> } | { ok: false; reason: string }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: false; reason: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({
        ok: false,
        reason:
          `DNS lookup for "${hostname}" did not answer within ${timeoutMs}ms. ` +
          `The address could not be verified as safe, so navigation was refused.`,
      }),
      timeoutMs,
    );
    // Never hold the event loop open on this guard alone.
    timer.unref?.();
  });

  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }).then(
        (addresses) => ({ ok: true as const, addresses }),
        (error: unknown) => ({
          ok: false as const,
          reason: `Failed to resolve hostname "${hostname}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateIpv4Address(address: string): ValidationResult {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return { valid: false, reason: `Invalid IPv4 address: ${address}` };
  }

  if (octets.every((octet) => octet === 0)) {
    return { valid: false, reason: 'Blocked null address (0.0.0.0)' };
  }
  if (octets[0] === 10) {
    return { valid: false, reason: 'Blocked private IP address (10.0.0.0/8)' };
  }
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
    return { valid: false, reason: 'Blocked private IP address (172.16.0.0/12)' };
  }
  if (octets[0] === 192 && octets[1] === 168) {
    return { valid: false, reason: 'Blocked private IP address (192.168.0.0/16)' };
  }
  if (octets[0] === 169 && octets[1] === 254) {
    return { valid: false, reason: 'Blocked link-local/cloud metadata address (169.254.0.0/16)' };
  }
  if (octets[0] === 127) {
    return { valid: true };
  }

  return { valid: true };
}

function expandIpv6Address(address: string): string[] | null {
  let normalized = address.toLowerCase();
  const lastColon = normalized.lastIndexOf(':');
  if (normalized.includes('.') && lastColon !== -1) {
    const embeddedIpv4 = normalized.slice(lastColon + 1);
    const ipv4Validation = validateIpv4Address(embeddedIpv4);
    if (ipv4Validation.reason?.startsWith('Invalid IPv4 address:')) {
      return null;
    }

    const octets = embeddedIpv4.split('.').map((part) => Number.parseInt(part, 10));
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const [head, tail] = normalized.split('::');

  if (normalized.split('::').length > 2) return null;

  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];

  if ([...headParts, ...tailParts].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }

  if (!normalized.includes('::')) {
    return headParts.length === 8 ? headParts.map((part) => part.padStart(4, '0')) : null;
  }

  const missingGroups = 8 - (headParts.length + tailParts.length);
  if (missingGroups < 1) return null;

  return [
    ...headParts.map((part) => part.padStart(4, '0')),
    ...Array.from({ length: missingGroups }, () => '0000'),
    ...tailParts.map((part) => part.padStart(4, '0')),
  ];
}

function validateIpv6Address(address: string): ValidationResult {
  const expanded = expandIpv6Address(address);
  if (!expanded) {
    return { valid: false, reason: `Invalid IPv6 address: ${address}` };
  }

  if (expanded.slice(0, 5).every((group) => group === '0000') && expanded[5] === 'ffff') {
    const hi = Number.parseInt(expanded[6], 16);
    const lo = Number.parseInt(expanded[7], 16);
    const ipv4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    return validateIpv4Address(ipv4);
  }

  const compact = expanded.join(':');
  if (compact === '0000:0000:0000:0000:0000:0000:0000:0000') {
    return { valid: false, reason: 'Blocked null IPv6 address (equivalent to 0.0.0.0)' };
  }
  if (compact === '0000:0000:0000:0000:0000:0000:0000:0001') {
    return { valid: true };
  }

  const firstGroup = Number.parseInt(expanded[0], 16);
  if ((firstGroup & 0xfe00) === 0xfc00) {
    return { valid: false, reason: 'Blocked private IPv6 address (fc00::/7)' };
  }
  if ((firstGroup & 0xffc0) === 0xfe80) {
    return { valid: false, reason: 'Blocked link-local IPv6 address (fe80::/10)' };
  }

  return { valid: true };
}

function validateResolvedAddress(address: string): ValidationResult {
  const family = isIP(address);
  if (family === 4) return validateIpv4Address(address);
  if (family === 6) return validateIpv6Address(address);
  return { valid: false, reason: `Resolved non-IP address: ${address}` };
}

export async function validateResolvedNavigationUrl(url: string): Promise<ValidationResult> {
  const basic = validateNavigationUrl(url);
  if (!basic.valid) return basic;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Invalid URL' };
  }

  const hostname = parsed.hostname;
  if (hostname === 'localhost') {
    return { valid: true };
  }

  if (isIP(hostname)) {
    return validateResolvedAddress(hostname);
  }

  // Bounded: see DNS_LOOKUP_TIMEOUT_MS. The guard must fail with its own
  // reason before the caller's socket deadline fires with a misleading one.
  const resolution = await lookupWithTimeout(hostname, DNS_LOOKUP_TIMEOUT_MS);
  if (!resolution.ok) {
    return { valid: false, reason: resolution.reason };
  }
  const addresses = resolution.addresses;

  if (addresses.length === 0) {
    return { valid: false, reason: `Hostname "${hostname}" did not resolve to an IP address` };
  }

  for (const { address } of addresses) {
    const resolved = validateResolvedAddress(address);
    if (!resolved.valid) {
      return { valid: false, reason: `Blocked resolved address ${address}: ${resolved.reason}` };
    }
  }

  return { valid: true };
}
