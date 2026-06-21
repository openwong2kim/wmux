// === LanLink shared types (PR-2: inbound durable inbox + cursor-pull) ===
//
// Lives in `src/shared` so the daemon (lanlink/inbox.ts), the main process
// (DaemonClient, RemoteInboxBridge) and the renderer (remoteInboxSlice) all
// bind the SAME wire shapes without crossing a process boundary — and so the
// daemon's tsconfig.daemon.json (rootDir: src, include src/daemon + src/shared)
// keeps compiling without ever reaching into src/main.
//
// **No network code in PR-2.** These shapes describe a remote message AFTER it
// has been synthetically injected (PR-2 test/dev path) or, in a future PR,
// decoded + sanitized off the LAN transport (PR-4). The message is ALWAYS
// `origin: 'remote'` and is treated as untrusted (G3): it is rendered as React
// text and NEVER pasted into a PTY or routed to the a2a execute path.

import { isTaskState, type TaskState } from './types';

/**
 * Fixed non-session sentinel for the `lanlink.remote.received` DaemonEvent.
 * A remote message is not backed by any PTY session, but `DaemonEvent.sessionId`
 * is a required string — so the daemon stamps this constant and the main-side
 * DaemonClient `case` ignores it, reading only `data.seq`.
 */
export const LANLINK_SENTINEL_SESSION_ID = 'lanlink';

/** Hard length clamp for a peer's display name (mirrors validateName default). */
export const PEER_NAME_MAX = 100;
/** Hard length clamp for a message body (the inbox holds the full text, not a preview). */
export const BODY_MAX = 4000;
/** FIFO bound on the on-disk inbox (PromptEventLog cap-256 precedent, doubled). */
export const INBOX_CAP = 512;

/**
 * Durable, append-only inbox record (the on-disk + cursor-pull unit).
 *
 * `id` vs `seq` are deliberately distinct:
 *   - `id`  — stable record id, the renderer's DEDUP key. PR-2: supplied by the
 *             synthetic inject (a uuid). PR-4 transport assigns it at receipt.
 *             NEVER derived from content, so a re-pull yields a byte-identical
 *             id and projection stays idempotent.
 *   - `seq` — daemon-assigned monotonic DELIVERY cursor. seq >= 1, strictly
 *             increasing, never reused (even after FIFO eviction), never rewound.
 */
export interface InboxRecord {
  id: string;
  seq: number;
  /** Always 'remote' in PR-2 — off-machine peer messages, untrusted (G3). */
  origin: 'remote';
  /** Sending peer's display name. Length-clamped to PEER_NAME_MAX. */
  peerName: string;
  /**
   * Message body. TEXT ONLY (PR-2 scope) and length-clamped to BODY_MAX. It is
   * NOT control-char sanitized in PR-2 (inject is text-only by assumption); the
   * full ingress sanitizer is PR-4. Any surface that renders it MUST treat it as
   * plain text (never paste it into a terminal).
   */
  text: string;
  /** Receipt time (epoch ms), daemon-assigned. */
  receivedAt: number;
  /**
   * Optional A2A-reuse: the conceptual task state for status rendering without
   * execute. Reuses `TaskState` from shared/types.ts as the CONCEPTUAL model
   * only — the inbox stores a text-only subset, never a full `Task` (whose
   * open-ended metadata would over-widen the deserialization surface). PR-2
   * inject defaults this to undefined; it is not required for delivery.
   */
  state?: TaskState;
}

/**
 * On-disk inbox file shape. `nextSeq` is the monotonic counter persisted WITH
 * the records so seq never resets across a daemon restart and is never reused.
 */
export interface InboxFile {
  version: 1;
  nextSeq: number;
  /** Append-only, oldest-first. FIFO-evicted at INBOX_CAP. */
  records: InboxRecord[];
}

/** Result of `LanLinkInbox.poll(cursor)` / `daemon.inbox.poll`. */
export interface LanLinkInboxPollResult {
  /** Records with `seq > cursor`, oldest-first. */
  items: InboxRecord[];
  /** `max(cursor, highest seq returned)` — never rewinds, even on empty. */
  nextCursor: number;
}

/**
 * Input to `LanLinkInbox.injectSynthetic`. The future PR-4 LAN receive path and
 * the channels `deliver()` remote endpoint (roadmap §11) BOTH bottleneck on the
 * same `LanLinkInbox.append()` — this synthetic input is merely the dev/test
 * wrapper that fabricates the same record without a real peer.
 */
export interface SyntheticInjectInput {
  /** Stable id; a uuid is minted when omitted. */
  id?: string;
  peerName: string;
  text: string;
  state?: TaskState;
}

/**
 * Renderer-facing materialized item pushed over `IPC.LANLINK_REMOTE`. Distinct
 * from `InboxRecord` (the durable wire/disk shape): the renderer only needs the
 * display fields, and `recordId` is the slice dedup key.
 */
export interface RemoteInboxItem {
  recordId: string;
  origin: 'remote';
  peerName: string;
  text: string;
  seq: number;
  receivedAt: number;
}

/**
 * Payload of the `lanlink.remote.received` DaemonEvent. FIRE-AND-FORGET NUDGE
 * ONLY ("a remote message landed, re-pull"); it is NOT a delivery guarantee.
 * Durability + exactly-once come from the disk inbox + `daemon.inbox.poll`
 * cursor-pull, so a message that arrives while main is dead survives on disk
 * and replays on reconnect.
 */
export interface LanLinkRemoteReceivedData {
  seq: number;
}

/** Truncate `s` to at most `max` chars. Length clamp only (no content sanitize). */
export function clampText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// === LanLink control plane (PR-3: config-reload + bind guard + NIC/Settings) ===
//
// network-0: these shapes describe the CONTROL plane only. No listener, PAKE, or
// AEAD is built in PR-3 — they are the contract a future LAN listener (PR-4) and
// the Settings UI bind against. `enabled` defaults OFF; the NIC is persisted as
// an IDENTITY (name + MAC), never a raw IP, so PR-4 re-resolves the live IPv4 via
// os.networkInterfaces() at listen time (a stored IP would go stale on DHCP renew
// and let the renderer dictate the bind address).

/** Lowest valid LanLink listen port (privileged ports 1-1023 are rejected). */
export const LANLINK_PORT_MIN = 1024;
/** Highest valid LanLink listen port. */
export const LANLINK_PORT_MAX = 65535;

/**
 * Persisted NIC identity. NOT a raw IP — the interface display name plus MAC, so
 * the same physical NIC is re-resolvable across reboots / DHCP renewals (C2). The
 * live IPv4 is recomputed from this identity at listen time by PR-4's bindGuard.
 */
export interface LanLinkNic {
  name: string;
  mac: string;
}

/**
 * A LAN-capable network interface as surfaced to the Settings dropdown. `addresses`
 * are the interface's external (non-internal) IPv4 strings — informational only;
 * the persisted identity is the name+mac.
 */
export interface NicInfo {
  name: string;
  mac: string;
  addresses: string[];
}

/**
 * Persisted LanLink config slice (lives inside DaemonConfig.lanlink in config.json).
 * `enabled` default false (explicit opt-in). `nic` null until the user picks one.
 * `port` optional — PR-4 chooses a default when absent.
 */
export interface LanLinkConfig {
  enabled: boolean;
  nic: LanLinkNic | null;
  port?: number;
}

/** Result of `lanlink.status` (and the echo of `lanlink.configure`). */
export interface LanLinkStatus {
  enabled: boolean;
  nic: LanLinkNic | null;
  port: number | null;
  /** Live LAN-capable NICs (re-enumerated each call); drives the Settings dropdown. */
  nics: NicInfo[];
}

/**
 * Partial update for `lanlink.configure`. A field absent from the object means
 * "leave unchanged"; `nic: null` explicitly clears the selection. The trust
 * boundary (`coerceLanLinkPatch`) rejects malformed fields rather than silently
 * dropping them, since this is renderer-supplied RPC input.
 */
export interface LanLinkConfigurePatch {
  enabled?: boolean;
  nic?: LanLinkNic | null;
  port?: number;
}

/** Default (OFF) LanLink config. Single source the config backfill falls back to. */
export function defaultLanLinkConfig(): LanLinkConfig {
  return { enabled: false, nic: null };
}

/**
 * Canonical MAC-48 form as reported by os.networkInterfaces(): six colon-separated
 * hex octets (e.g. 'aa:bb:cc:dd:ee:ff'). The all-zero placeholder of an internal
 * NIC matches the shape but those interfaces are filtered out before enumeration.
 */
const MAC_RE = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/;

/**
 * Type guard for a persisted NIC identity. Array.isArray-first (#269 lesson) and
 * — crucially — the `mac` must be a well-formed MAC-48 string, not just any string:
 * the identity is what PR-4 re-resolves the live IPv4 from, so a junk value like
 * `{ name:'Ethernet', mac:'x' }` (hand-edited config or a hostile configure call)
 * is rejected here rather than persisted as a seemingly-valid-but-unusable NIC.
 */
export function isLanLinkNic(v: unknown): v is LanLinkNic {
  if (Array.isArray(v) || typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['name'] === 'string' &&
    o['name'].length > 0 &&
    typeof o['mac'] === 'string' &&
    MAC_RE.test(o['mac'])
  );
}

/** True iff `n` is a finite integer within the valid LanLink port range. */
function isValidPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= LANLINK_PORT_MIN && n <= LANLINK_PORT_MAX;
}

/**
 * LENIENT backfill for config LOAD (mirrors clampLifecycle's tolerant fallback in
 * config.ts). Never throws — a hand-edited/garbage `lanlink` slice degrades to the
 * default WITHOUT touching sibling config fields. Each sub-field is coerced
 * independently: a bad `port` does not nuke a good `enabled`. Array.isArray-first
 * so an array-shaped value can't masquerade as an object.
 */
export function coerceLanLinkConfig(raw: unknown, def: LanLinkConfig): LanLinkConfig {
  if (Array.isArray(raw) || typeof raw !== 'object' || raw === null) return { ...def };
  const o = raw as Record<string, unknown>;
  const out: LanLinkConfig = {
    enabled: typeof o['enabled'] === 'boolean' ? o['enabled'] : def.enabled,
    nic: isLanLinkNic(o['nic']) ? { name: o['nic'].name, mac: o['nic'].mac } : null,
  };
  if (isValidPort(o['port'])) out.port = o['port'];
  return out;
}

/**
 * STRICT validation for `lanlink.configure` RPC input (the renderer→main→daemon
 * trust boundary). Returns a patch carrying ONLY the keys actually present in
 * `raw`; throws on any malformed field so the renderer surfaces a clear error
 * rather than persisting garbage. `nic: null` is preserved as an explicit clear;
 * an absent `nic` key leaves the selection unchanged.
 */
export function coerceLanLinkPatch(raw: unknown): LanLinkConfigurePatch {
  if (Array.isArray(raw) || typeof raw !== 'object' || raw === null) {
    throw new Error('lanlink.configure: params must be an object');
  }
  const o = raw as Record<string, unknown>;
  const patch: LanLinkConfigurePatch = {};
  if ('enabled' in o) {
    if (typeof o['enabled'] !== 'boolean') throw new Error('lanlink.configure: enabled must be boolean');
    patch.enabled = o['enabled'];
  }
  if ('nic' in o) {
    if (o['nic'] === null) {
      patch.nic = null;
    } else if (isLanLinkNic(o['nic'])) {
      patch.nic = { name: o['nic'].name, mac: o['nic'].mac };
    } else {
      throw new Error('lanlink.configure: nic must be null or { name, mac }');
    }
  }
  if ('port' in o) {
    if (!isValidPort(o['port'])) {
      throw new Error(`lanlink.configure: port must be an integer in [${LANLINK_PORT_MIN}, ${LANLINK_PORT_MAX}]`);
    }
    patch.port = o['port'];
  }
  return patch;
}

/**
 * Load-time validator / type guard for the inbox file.
 *
 * #269 lesson (codex P1): a naive `typeof v === 'object'` map-check passes an
 * ARRAY (`typeof [] === 'object'`), letting a corrupt/array-shaped file load as
 * "healthy" and defeating the `.bak` recovery chain. So we **reject
 * `Array.isArray(v)` FIRST**, then validate the object shape AND each record
 * row (including strictly-increasing seq and `seq <= nextSeq`). A torn file with
 * a rewound/duplicate seq, an array container, or a malformed row fails the
 * guard → `atomicReadJSON*` falls through to `.bak`/`.bak.1..3`.
 */
export function isInboxFile(v: unknown): v is InboxFile {
  if (Array.isArray(v)) return false; // #269 fix: an array is NOT a healthy file
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o['version'] !== 1) return false;
  if (
    typeof o['nextSeq'] !== 'number' ||
    !Number.isInteger(o['nextSeq']) ||
    (o['nextSeq'] as number) < 0
  ) {
    return false;
  }
  if (!Array.isArray(o['records'])) return false;
  let prevSeq = 0;
  for (const r of o['records'] as unknown[]) {
    if (typeof r !== 'object' || r === null) return false;
    const rec = r as Record<string, unknown>;
    if (typeof rec['id'] !== 'string' || rec['id'].length === 0) return false;
    if (typeof rec['seq'] !== 'number' || !Number.isInteger(rec['seq'])) return false;
    if (rec['origin'] !== 'remote') return false;
    if (typeof rec['peerName'] !== 'string') return false;
    if (typeof rec['text'] !== 'string') return false;
    if (typeof rec['receivedAt'] !== 'number' || !Number.isFinite(rec['receivedAt'])) return false;
    // Strictly-increasing seq — drops a rewound/duplicate seq (replay defense).
    if ((rec['seq'] as number) <= prevSeq) return false;
    // seq can never exceed the persisted counter.
    if ((rec['seq'] as number) > (o['nextSeq'] as number)) return false;
    // PR-4 (C10): the LAN listener now attaches `state` from an UNTRUSTED wire
    // message. A present-but-invalid state must reject the whole record at the
    // disk boundary so a hostile value can never become a VALID_TRANSITIONS[state]
    // lookup key on any downstream consumer. Absent state stays valid (optional).
    if ('state' in rec && !isTaskState(rec['state'])) return false;
    prevSeq = rec['seq'] as number;
  }
  return true;
}
