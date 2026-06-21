import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  atomicReadJSONSync,
  atomicWriteJSONSync,
  createMigrator,
  type MigrationRegistry,
} from '../util/atomicWrite';
import {
  BODY_MAX,
  clampText,
  INBOX_CAP,
  isInboxFile,
  PEER_NAME_MAX,
  type InboxFile,
  type InboxRecord,
  type LanLinkInboxPollResult,
  type SyntheticInjectInput,
} from '../../shared/lanlink';

// Identity migration registry (v1, no steps) — behaviour-neutral today, but the
// hook means a future inbox schema change lands without touching `load()`.
// Mirrors DAEMON_STATE_REGISTRY (StateWriter.ts:9 / migrate.ts:300).
const LANLINK_INBOX_REGISTRY: MigrationRegistry = { currentVersion: 1, steps: [] };

/**
 * LanLink durable inbound inbox (PR-2). The single source of truth for remote
 * peer messages, owned by the DAEMON process so it survives main/renderer death
 * (C3). Append-only, monotonic `seq`, FIFO-bounded, atomic-write + `.bak`
 * recovery.
 *
 * Mirrors `StateWriter`'s persistence shape with one deliberate correction:
 * `StateWriter.saveDebounced` COALESCES same-key writes through `AsyncQueue`
 * (only the latest snapshot matters), which would silently DROP a message that
 * arrived just before a crash. An inbox must persist EVERY append, so `append()`
 * follows the `saveImmediate` discipline — a synchronous atomic write on every
 * record — and there is no debounce/coalesce path.
 *
 * **ACK ordering (non-negotiable):** the caller learns a record's `seq` ONLY
 * after the durable write completes. `append()` returns `{seq}` physically after
 * `atomicWriteJSONSync` + a best-effort `fsync`, so there is no code path where
 * an "acked" message is not yet on stable storage (no ack-before-durable race).
 *
 * **Execute wall:** this module imports 0 of ClaudeWorker / RpcRouter / a2a.rpc
 * — enforced by `daemonExecuteWall.test.ts`, which auto-scans `src/daemon/**`
 * (the strongest, structural layer of "remote messages can never execute").
 */
export class LanLinkInbox {
  private readonly filePath: string;
  /** In-memory authoritative copy, loaded at construction. */
  private file: InboxFile;

  /**
   * @param baseDir suffix-aware wmux dir (the sessions.json sibling).
   * @param cap     FIFO bound on retained records. Defaults to INBOX_CAP (512).
   *                Tests inject a small cap so the FIFO-eviction invariant can be
   *                exercised without thousands of synchronous disk writes — the
   *                eviction logic itself is cap-agnostic.
   */
  constructor(baseDir: string, private readonly cap: number = INBOX_CAP) {
    this.filePath = path.join(baseDir, 'lanlink-inbox.json');
    this.file = this.load();
  }

  /**
   * Append a remote record durably and return its assigned `seq`. SYNCHRONOUS:
   * the atomic write (and a best-effort fsync) complete before this returns, so
   * the return value IS the durable ACK.
   */
  append(rec: Omit<InboxRecord, 'seq'>): { seq: number } {
    const seq = this.file.nextSeq + 1;
    const records = [...this.file.records, { ...rec, seq }];
    // FIFO bound. nextSeq keeps climbing so an evicted seq is never reused.
    if (records.length > this.cap) {
      records.splice(0, records.length - this.cap);
    }
    const next: InboxFile = { version: 1, nextSeq: seq, records };
    // SYNC atomic write (rename-atomic durability + `.bak` rotation) against the
    // CANDIDATE snapshot — this.file is NOT mutated yet. The validator guards our
    // own write too, so a logic bug can't persist a file that would later fail
    // to load.
    atomicWriteJSONSync(this.filePath, next, {
      validate: isInboxFile,
      rotationEnabled: true,
    });
    // Belt-and-suspenders: flush the renamed file to stable storage before we
    // ACK, closing the ack-before-durable window against the OS write-back cache
    // (atomicWrite relies on rename atomicity and does not fsync). The C3 threat
    // model — main process kill, daemon alive — is already covered by the sync
    // rename; this additionally hardens against a daemon-host crash.
    this.fsyncBestEffort();
    // Commit in-memory state ONLY after the durable write succeeded. If the
    // write throws, this.file (and thus poll()/nextSeq) stays byte-identical to
    // the last persisted state — no phantom record can be polled, no consumed-
    // but-unpersisted seq leaks, and a record the caller was told failed is
    // never resurrected by the next append.
    this.file = next;
    return { seq };
  }

  /**
   * Inject a synthetic record (test/dev). Validates + length-clamps, then calls
   * the SAME `append()` the future PR-4 LAN listener (and the channels
   * `deliver()` remote endpoint) will call — the shared seam (roadmap §11).
   */
  injectSynthetic(input: SyntheticInjectInput): { seq: number } {
    const rec: Omit<InboxRecord, 'seq'> = {
      id: input.id ?? randomUUID(),
      origin: 'remote',
      peerName: clampText(input.peerName, PEER_NAME_MAX),
      text: clampText(input.text, BODY_MAX),
      receivedAt: Date.now(),
      ...(input.state ? { state: input.state } : {}),
    };
    return this.append(rec);
  }

  /**
   * Return every record with `seq > cursor`, oldest-first (the cursor-pull read
   * shape, mirroring `PromptEventLog.since`). `nextCursor` never rewinds — even
   * on an empty result it echoes the caller's cursor. Degrades gracefully (no
   * throw) on a bogus cursor.
   */
  poll(cursor: number): LanLinkInboxPollResult {
    const c = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0;
    const items = this.file.records.filter((r) => r.seq > c);
    const highest = items.length > 0 ? items[items.length - 1].seq : c;
    return { items, nextCursor: Math.max(c, highest) };
  }

  /** Current record count (test/diagnostics aid). */
  get size(): number {
    return this.file.records.length;
  }

  /**
   * Process-exit drain. `append()` is synchronous + fsync'd, so there is never
   * unflushed pending state — this is a no-op kept for symmetry with
   * `StateWriter.flushSync` and as a forward hook if a write fast-path is added.
   */
  flushSync(): void {
    /* intentionally empty — every append is already durable */
  }

  dispose(): void {
    /* no timers/handles to release */
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private load(): InboxFile {
    const empty: InboxFile = { version: 1, nextSeq: 0, records: [] };
    try {
      const migrator = createMigrator<InboxFile>(LANLINK_INBOX_REGISTRY, this.filePath);
      const loaded = atomicReadJSONSync<InboxFile>(this.filePath, {
        validate: isInboxFile,
        migrator,
      });
      // A corrupt/array-shaped/torn primary fails `isInboxFile` inside the
      // atomic read, which walks the `.bak` chain; a total miss returns null.
      if (loaded) return loaded;
    } catch (err) {
      console.error('[LanLinkInbox] Failed to load inbox:', err);
    }
    return empty;
  }

  /** Reopen the renamed primary and fsync it. Best-effort: a failure (e.g. a
   *  platform that rejects the open) leaves us relying on rename atomicity. */
  private fsyncBestEffort(): void {
    try {
      const fd = fs.openSync(this.filePath, 'r+');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* best-effort — the sync atomic rename already provides atomicity */
    }
  }
}
