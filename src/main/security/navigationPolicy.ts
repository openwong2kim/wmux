import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { validateNavigationUrl } from '../../shared/types';

interface ValidationResult {
  valid: boolean;
  reason?: string;
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
  const normalized = address.toLowerCase();
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

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, reason: `Failed to resolve hostname "${hostname}": ${message}` };
  }

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
