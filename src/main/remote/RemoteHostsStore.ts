// Persisted registry of remote wmux web hosts (main process only).
//
// Each record carries a long-term bearer token that grants scrollback read +
// keystroke injection on another machine, so it is persisted exclusively via
// secureWriteTokenFile (owner-only perms/DACL, fail-closed) and re-hardened on
// every load with reHardenTokenFileAcl — mirroring the daemon/lanlink/peers.ts
// precedent. Plain fs.writeFileSync is forbidden for this file.

import * as crypto from 'crypto';
import * as fs from 'fs';
import type { RemoteHost, RemoteHostPublic } from '../../shared/remoteHosts';
import { parseWebUrl } from '../../shared/remoteHosts';
import { reHardenTokenFileAcl, secureWriteTokenFile } from '../../shared/security';
import type { PcRailTokenKind } from '../../shared/pcRail';

/**
 * A stored host plus how its credential was issued: `operator` for a pasted
 * `wmux web` link (the host's own token, not a paired device over there),
 * `device` for a code exchange. Absent on records written before this was
 * recorded. Not a secret; it reaches the renderer with the rest of the row.
 */
export type StoredRemoteHost = RemoteHost & { tokenKind?: PcRailTokenKind };

function isTokenKind(v: unknown): v is PcRailTokenKind {
  return v === 'device' || v === 'operator';
}

function toPublic(host: RemoteHost): RemoteHostPublic {
  const { token: _token, ...rest } = host;
  void _token;
  return rest;
}

/** Structural validation for a loaded file — malformed/foreign shapes are
 *  treated the same as a missing file (empty list, never throw). */
function isRemoteHostArray(v: unknown): v is RemoteHost[] {
  if (!Array.isArray(v)) return false;
  return v.every((r) => {
    if (typeof r !== 'object' || r === null) return false;
    const rec = r as Record<string, unknown>;
    return (
      typeof rec.id === 'string' &&
      typeof rec.label === 'string' &&
      typeof rec.origin === 'string' &&
      typeof rec.token === 'string' &&
      typeof rec.addedAt === 'number'
    );
  });
}

export class RemoteHostsStore {
  private readonly filePath: string;
  private hosts: StoredRemoteHost[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  list(): RemoteHostPublic[] {
    return this.hosts.map(toPublic);
  }

  /** Returns the full record (token included) — main-internal callers only. */
  get(id: string): StoredRemoteHost | null {
    return this.hosts.find((h) => h.id === id) ?? null;
  }

  add(rawUrl: string, label?: string): { ok: true; host: RemoteHostPublic } | { ok: false; error: string } {
    const parsed = parseWebUrl(rawUrl);
    if (!parsed) {
      return { ok: false, error: 'invalid wmux web URL' };
    }
    if (this.hosts.some((h) => h.origin === parsed.origin)) {
      return { ok: false, error: 'already registered' };
    }

    let hostname: string;
    try {
      hostname = new URL(parsed.origin).hostname;
    } catch {
      hostname = parsed.origin;
    }

    const host: StoredRemoteHost = {
      id: crypto.randomUUID(),
      label: label ?? hostname,
      origin: parsed.origin,
      token: parsed.token,
      addedAt: Date.now(),
      tokenKind: 'operator',
    };

    const next: StoredRemoteHost[] = [...this.hosts, host];
    this.persist(next);
    this.hosts = next;
    return { ok: true, host: toPublic(host) };
  }

  /** Registers a host from an already-exchanged origin + token — the
   *  pair-with-code path (REMOTE_HOSTS_PAIR), which never has a pasted URL
   *  to parse. Same duplicate-origin refusal and persist-before-mutate
   *  discipline as add(). */
  addDirect(origin: string, token: string, label?: string): { ok: true; host: RemoteHostPublic } | { ok: false; error: string } {
    if (this.hosts.some((h) => h.origin === origin)) {
      return { ok: false, error: 'already registered' };
    }

    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      hostname = origin;
    }

    const host: StoredRemoteHost = {
      id: crypto.randomUUID(),
      label: label ?? hostname,
      origin,
      token,
      addedAt: Date.now(),
      tokenKind: 'device',
    };

    const next: StoredRemoteHost[] = [...this.hosts, host];
    this.persist(next);
    this.hosts = next;
    return { ok: true, host: toPublic(host) };
  }

  /** Swaps the credential (and, if the operator typed a different address,
   *  the origin) of an existing host IN PLACE — re-pairing a host that stopped
   *  accepting the old token. The id is kept on purpose: every attachment
   *  descriptor and sidebar row is keyed by it, so they all survive. Same
   *  duplicate-origin refusal and persist-before-mutate discipline as add(). */
  replaceCredential(
    id: string,
    origin: string,
    token: string,
    label?: string,
  ): { ok: true; host: RemoteHostPublic } | { ok: false; error: string } {
    const prev = this.hosts.find((h) => h.id === id);
    if (!prev) return { ok: false, error: 'unknown host' };
    if (this.hosts.some((h) => h.id !== id && h.origin === origin)) {
      return { ok: false, error: 'already registered' };
    }
    // Only the pair-with-code path re-pairs, so the new credential is a device's.
    const host: StoredRemoteHost = { ...prev, origin, token, tokenKind: 'device', ...(label ? { label } : {}) };
    const next = this.hosts.map((h) => (h.id === id ? host : h));
    this.persist(next);
    this.hosts = next;
    return { ok: true, host: toPublic(host) };
  }

  remove(id: string): boolean {
    const next = this.hosts.filter((h) => h.id !== id);
    if (next.length === this.hosts.length) return false;
    this.persist(next);
    this.hosts = next;
    return true;
  }

  private persist(hosts: StoredRemoteHost[]): void {
    secureWriteTokenFile(this.filePath, JSON.stringify(hosts));
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.hosts = [];
        return;
      }
      reHardenTokenFileAcl(this.filePath);
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      // An unknown tokenKind is dropped from that record, never the record.
      this.hosts = isRemoteHostArray(parsed)
        ? parsed.map((h: StoredRemoteHost) => {
          if (h.tokenKind === undefined || isTokenKind(h.tokenKind)) return h;
          const { tokenKind: _bad, ...rest } = h;
          void _bad;
          return rest;
        })
        : [];
    } catch {
      // Missing/corrupt file → empty list, never throw (load-on-construct contract).
      this.hosts = [];
    }
  }
}
