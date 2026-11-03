// #3049 — main's record of the panes it created as user shells (the
// passthrough env policy), and how main starts such a pane again after a
// restart with the credential values it inherits.
//
// sessions.json never holds credential values, and the daemon never takes them
// from its own env or from disk. So the daemon holds a restored user shell as a
// placeholder (ids on the hold list, shared/userShellHolds.ts) until main
// starts it, passing `pickCredentialEnv(process.env)`: the set a new tab gets.
//
// The record lives in userData and holds ids, each with the shell's cmd and
// incarnation, never a value. Main grants credentials only to a session its
// own record names, whose cmd and incarnation match the daemon's listing, and
// that is still a passthrough pane by resolveEnvPolicy with the exec and
// supervision the daemon lists. The daemon's data can only take a grant away,
// never add one. The hold list is the same ids, written where the daemon reads
// it at boot; editing it can only delay a start.

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../shared/settingsFile';
import { pickCredentialEnv } from '../../shared/envFilter';
import { resolveEnvPolicy } from '../../shared/spawnKind';
import { HELD_START_CONCURRENCY, USER_SHELL_HOLDS_FILE, userShellHoldsContent } from '../../shared/userShellHolds';
import { runLimited } from '../../shared/runLimited';
import { getWmuxDir } from '../../daemon/config';

/** The record's file name, in userData. */
export const USER_SHELL_RECORD_FILE = 'user-shell-record.json';

/** Longest main holds daemon:connected for the held shells' start: the renderer reads resume offers only then. */
export const HELD_START_CONNECTED_WAIT_MS = 5_000;

export interface UserShellEntry {
  cmd: string;
  incarnationId: string;
}

/** A daemon.listSessions row, as far as the grant reads it. */
export interface ListedSession {
  id: string;
  cmd?: string;
  state?: string;
  incarnationId?: string;
  exec?: unknown;
  supervision?: unknown;
  /** A user shell the daemon holds for main to start (#3049). */
  startPending?: boolean;
}

export class UserShellRecord {
  private entries: Map<string, UserShellEntry> | null = null;
  /** Ids whose shell this process started with credentials. */
  private readonly granted = new Set<string>();

  constructor(
    private readonly recordFile: string,
    private readonly holdsFile: string,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
  ) {}

  get(id: string): UserShellEntry | undefined {
    return this.load().get(id);
  }

  ids(): string[] {
    return [...this.load().keys()];
  }

  /** Record `id` as a user shell (a passthrough create). */
  set(id: string, entry: UserShellEntry): void {
    const entries = this.load();
    const prev = entries.get(id);
    if (prev && prev.cmd === entry.cmd && prev.incarnationId === entry.incarnationId) return;
    entries.set(id, { cmd: entry.cmd, incarnationId: entry.incarnationId });
    this.save();
  }

  /** Forget `id` (a close, a death, or a create that was not a user shell). */
  remove(id: string): void {
    this.granted.delete(id);
    if (this.load().delete(id)) this.save();
  }

  /** Keep only the ids the daemon still has. */
  prune(keep: ReadonlySet<string>): void {
    const entries = this.load();
    let changed = false;
    for (const id of [...entries.keys()]) {
      if (keep.has(id)) continue;
      entries.delete(id);
      this.granted.delete(id);
      changed = true;
    }
    if (changed) this.save();
  }

  noteGranted(id: string): void {
    this.granted.add(id);
  }

  wasGranted(id: string): boolean {
    return this.granted.has(id);
  }

  private load(): Map<string, UserShellEntry> {
    if (this.entries) return this.entries;
    const entries = new Map<string, UserShellEntry>();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.recordFile, 'utf8')) as { panes?: unknown };
      const panes = parsed?.panes;
      if (panes && typeof panes === 'object' && !Array.isArray(panes)) {
        for (const [id, raw] of Object.entries(panes as Record<string, unknown>)) {
          const entry = raw as Partial<UserShellEntry> | null;
          if (typeof entry?.cmd === 'string' && typeof entry.incarnationId === 'string') {
            entries.set(id, { cmd: entry.cmd, incarnationId: entry.incarnationId });
          }
        }
      }
    } catch {
      /* missing or unreadable: no user shells recorded */
    }
    this.entries = entries;
    return entries;
  }

  private save(): void {
    const entries = this.load();
    try {
      writeJsonAtomic(this.recordFile, { version: 1, panes: Object.fromEntries(entries) });
      writeJsonAtomic(this.holdsFile, userShellHoldsContent(entries.keys()));
    } catch (err) {
      this.warn(`[env] user shell record not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

let shared: UserShellRecord | null = null;

/** The process's record: in `userDataDir`, its hold list in the wmux data dir. */
export function getUserShellRecord(userDataDir: string): UserShellRecord {
  shared ??= new UserShellRecord(path.join(userDataDir, USER_SHELL_RECORD_FILE), path.join(getWmuxDir(), USER_SHELL_HOLDS_FILE));
  return shared;
}

/**
 * The credential env main passes when it starts `listed`, or undefined to
 * start it without: only for a session the record names with the same cmd and
 * incarnation, that is still a passthrough pane given what the daemon lists.
 */
export function credentialEnvFor(
  listed: ListedSession,
  entry: UserShellEntry | undefined,
  liveEnv: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!entry || entry.cmd !== listed.cmd || entry.incarnationId !== listed.incarnationId) return undefined;
  const policy = resolveEnvPolicy({ spawnKind: 'user-shell', hasExec: !!listed.exec, hasSupervision: !!listed.supervision });
  return policy === 'passthrough' ? pickCredentialEnv(liveEnv) : undefined;
}

export interface PromoteClient {
  rpc(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>;
}

export interface PromoteAnswer {
  ok: boolean;
  alreadyActive?: boolean;
  joined?: boolean;
  notInFlight?: boolean;
  credentialsApplied?: true;
  error?: { code?: string; message: string };
}

/**
 * daemon.promoteSession for a suspended session, with its credentials when
 * main grants them. Given only an id, the grant reads the daemon's listing of
 * it. A promote that sent credentials but whose shell runs without them (it
 * joined the daemon's fallback start, or found the shell already started by
 * it) is logged once. A join-only call never carries credentials.
 */
export async function promoteRecoveredSession(
  client: PromoteClient,
  record: UserShellRecord,
  session: ListedSession | string,
  opts: { fresh?: boolean; joinOnly?: boolean; timeoutMs?: number; liveEnv?: NodeJS.ProcessEnv; log?: (line: string) => void } = {},
): Promise<PromoteAnswer> {
  const listed = typeof session === 'string' ? await listedSession(client, session) : session;
  const credentialEnv = opts.joinOnly ? undefined : credentialEnvFor(listed, record.get(listed.id), opts.liveEnv ?? process.env);
  const result = await client.rpc('daemon.promoteSession', {
    id: listed.id,
    ...(opts.fresh ? { fresh: true } : {}),
    ...(opts.joinOnly ? { joinOnly: true } : {}),
    ...(credentialEnv ? { credentialEnv } : {}),
  }, opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined) as PromoteAnswer;
  if (credentialEnv && result?.ok) {
    if (result.credentialsApplied) record.noteGranted(listed.id);
    else if (!record.wasGranted(listed.id)) (opts.log ?? console.log)(`[env] pane ${listed.id} restored without credentials (the daemon started it before the app did)`);
  }
  return result;
}

async function listedSession(client: PromoteClient, id: string): Promise<ListedSession> {
  const rows = await client.rpc('daemon.listSessions', { includeSuspended: true });
  return (Array.isArray(rows) ? (rows as ListedSession[]).find((s) => s?.id === id) : undefined) ?? { id };
}

/**
 * On (re)connecting to the daemon: drop the record's ids the daemon no longer
 * has, then start every user shell the daemon holds, with its credentials, a
 * few at a time. Returns how many it asked to start.
 */
export async function startHeldUserShells(
  client: PromoteClient,
  record: UserShellRecord,
  opts: { timeoutMs?: number; liveEnv?: NodeJS.ProcessEnv; log?: (line: string) => void } = {},
): Promise<number> {
  const rows = await client.rpc('daemon.listSessions', { includeSuspended: true });
  if (!Array.isArray(rows)) return 0;
  const listed = rows.filter((r): r is ListedSession => !!r && typeof (r as ListedSession).id === 'string');
  record.prune(new Set(listed.filter((s) => s.state !== 'dead').map((s) => s.id)));
  const held = listed.filter((s) => s.startPending === true);
  await runLimited(held, HELD_START_CONCURRENCY, async (s) => {
    const result = await promoteRecoveredSession(client, record, s, opts);
    if (!result?.ok) (opts.log ?? console.log)(`[env] pane ${s.id}: restored user shell did not start: ${result?.error?.message ?? 'unknown error'}`);
  });
  return held.length;
}
