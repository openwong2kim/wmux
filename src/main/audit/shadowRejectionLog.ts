// Shadow rejection log — append-only JSONL file at
// `~/.wmux/shadow-rejections.log` that captures what the Phase 2.2
// permission enforcer WOULD have rejected during the v3.0 dogfood window
// before enforcement flips on.
//
// Why a dedicated log, NOT a field on PluginIdentityRecord (plan D7 step 3):
//   - PluginTrustStore caps the DB at MAX_PLUGIN_TRUST_ENTRIES = 1024 with
//     LRU eviction. A hostile or buggy client that re-handshakes under
//     fresh names could push real shadow evidence out of the trust DB
//     before v3.1 ever reads it.
//   - The trust DB is per-plugin-name; shadow evidence is per-call. Mixing
//     them dilutes both. Better to keep the trust DB as user-curated state
//     and put audit traffic in its own file.
//
// File format: JSONL (one JSON record per line). Easy to `tail -f`, easy
// to ingest with `jq`, and the v3.1 surfacing UI can stream-parse it
// without loading the whole file.
//
// Rotation: when the live file exceeds `maxBytes`, rename it to `.1` (over-
// writing any previous backup) and start fresh. Single-generation rotation
// — shadow telemetry is ephemeral, multi-generation backup chain is
// over-engineering. If rename fails (Windows file-lock race), we truncate
// to keep the file bounded; losing shadow data is preferable to growing
// disk usage unbounded.
//
// Writes are SYNC (`appendFileSync`). Each shadow entry is <1 KB so the
// fs hit is well under 1 ms — well below the noise floor of RPC dispatch.
// All writes are wrapped in try/catch: shadow logging must NEVER affect
// RPC throughput or surface errors to plugins.

import * as fs from 'fs';
import * as path from 'path';
import { getWmuxHomeDir } from '../../shared/constants';
import type { RpcMethod, RpcRejection } from '../../shared/rpc';

/**
 * Discriminated union of audit entries written to the shadow log. v3.0
 * starts with two kinds:
 *
 *   - 'rejection'       — would-be permission rejection (shadow mode)
 *   - 'legacy-traffic'  — per-method legacy (envelope-less) call counts,
 *                          emitted at threshold milestones (1, 10, 100, ...)
 *
 * Read-back of pre-2.2-pre-commit-4 entries (no `entryKind` field) is not
 * needed because this log is only meaningful inside a single dogfood
 * window; rotation eats older entries. New entries always carry `entryKind`.
 */
export type ShadowAuditEntry = ShadowRejectionEntry | LegacyTrafficEntry;

export interface ShadowRejectionEntry {
  entryKind: 'rejection';
  /** Unix ms timestamp. */
  ts: number;
  /** Caller's declared clientName, or undefined for envelope-less callers. */
  clientName: string | undefined;
  /** RPC method that triggered the (would-be) rejection. */
  method: RpcMethod;
  /** The structured rejection the enforcer produced. */
  rejection: RpcRejection;
}

/**
 * Legacy traffic milestone — emitted by LegacyTrafficCounter when an
 * envelope-less RPC method count crosses one of its threshold values.
 * `count` is the running total at the moment the milestone fired.
 */
export interface LegacyTrafficEntry {
  entryKind: 'legacy-traffic';
  ts: number;
  method: RpcMethod;
  count: number;
}

export interface ShadowRejectionLoggerOptions {
  /** Override the log file path (tests). Default: `~/.wmux/shadow-rejections.log`. */
  path?: string;
  /** Rotation threshold in bytes. Default: 1 MiB. */
  maxBytes?: number;
  /**
   * Override the time source for deterministic tests. Default: Date.now.
   * Production callers should NOT pass this — the live clock is the right
   * source of truth for an audit log.
   */
  now?: () => number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;

export class ShadowRejectionLogger {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(options: ShadowRejectionLoggerOptions = {}) {
    this.filePath =
      options.path ?? `${getWmuxHomeDir()}/shadow-rejections.log`;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a would-be rejection. Best-effort: any I/O failure is silently
   * swallowed so the RPC dispatch loop is never penalised by a full disk,
   * locked file, or missing parent directory.
   */
  append(input: {
    clientName: string | undefined;
    method: RpcMethod;
    rejection: RpcRejection;
  }): void {
    this.writeEntry({
      entryKind: 'rejection',
      ts: this.now(),
      clientName: input.clientName,
      method: input.method,
      rejection: input.rejection,
    });
  }

  /**
   * Record a legacy-traffic milestone crossing. Same best-effort guarantees
   * as `append`. Called by LegacyTrafficCounter at threshold counts.
   */
  appendLegacyTraffic(input: { method: RpcMethod; count: number }): void {
    this.writeEntry({
      entryKind: 'legacy-traffic',
      ts: this.now(),
      method: input.method,
      count: input.count,
    });
  }

  private writeEntry(entry: ShadowAuditEntry): void {
    try {
      this.ensureDir();
      this.rotateIfNeeded();
      // JSONL: one record per line. JSON.stringify on a typed object never
      // throws for our shape, so the try/catch above only covers fs errors.
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', {
        encoding: 'utf8',
      });
    } catch {
      // Swallow. Shadow telemetry must not affect RPC throughput.
    }
  }

  /** Test-only: read the log back as parsed entries. */
  readAll(): ShadowAuditEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out: ShadowAuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as ShadowAuditEntry);
      } catch {
        // Tolerate partial writes / hand-edits: skip malformed lines.
      }
    }
    return out;
  }

  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  private rotateIfNeeded(): void {
    let size = 0;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return; // file doesn't exist yet — nothing to rotate
    }
    if (size < this.maxBytes) return;
    const backupPath = `${this.filePath}.1`;
    try {
      fs.renameSync(this.filePath, backupPath);
    } catch {
      // Windows file-lock race or permissions issue. Truncate as fallback
      // so the log doesn't grow forever; data loss is acceptable for
      // shadow-mode audit.
      try {
        fs.truncateSync(this.filePath, 0);
      } catch {
        /* swallow */
      }
    }
  }
}
