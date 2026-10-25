// A table main maintains (the bot approvals or prompts waiting on the owner),
// turned into pushes: each change of the table pushes the rows that appeared
// and retracts the rows that left. See shared/botApprovalPush.ts for why main
// sends whole tables rather than events.

import type { PushPayload } from '../../shared/push/pushEnvelope';

export interface PushTableRouterDeps {
  /** Is presence holding this payload back? */
  suppress: (payload: PushPayload) => boolean;
  send: (payload: PushPayload, opts: { collapseId: string; requires: string }) => void;
  park: (key: string, payload: PushPayload, collapseId: string, requires: string) => void;
  forget: (key: string) => void;
  log?: (level: 'info' | 'warn', message: string) => void;
}

export interface PushTableKind<Row> {
  /** Park-queue key prefix, kept apart from every other kind's keys. */
  parkPrefix: string;
  /** The device capability every push of this kind requires. */
  requires: string;
  /** What the log calls one row. */
  noun: string;
  idOf: (row: Row) => string;
  build: (row: Row) => PushPayload;
  collapseId: (id: string) => string;
  retraction: (id: string) => PushPayload;
}

/**
 * The daemon's copy of one of main's tables, and what was done with each row:
 *   - parked   held by presence under `<parkPrefix><id>`
 *   - sent     on the phone; retract when it leaves the table
 *   - dropped  the park queue evicted it unsent; nothing to retract
 */
export class PushTableRouter<Row> {
  private readonly rows = new Map<string, 'parked' | 'sent' | 'dropped'>();

  constructor(
    private readonly kind: PushTableKind<Row>,
    private readonly deps: PushTableRouterDeps,
  ) {}

  /** Main's whole table. New rows are pushed, rows that left are retracted. */
  set(table: readonly Row[]): void {
    const { kind, deps } = this;
    const next = new Map(table.map((row) => [kind.idOf(row), row]));
    for (const [id, state] of [...this.rows]) {
      if (next.has(id)) continue;
      this.rows.delete(id);
      if (state === 'parked') deps.forget(kind.parkPrefix + id);
      if (state === 'sent') {
        deps.log?.('info', `[push] retracting the push for ${kind.noun} ${id}`);
        deps.send(kind.retraction(id), { collapseId: kind.collapseId(id), requires: kind.requires });
      }
    }
    for (const [id, row] of next) {
      if (this.rows.has(id)) continue;
      const payload = kind.build(row);
      const collapseId = kind.collapseId(id);
      if (deps.suppress(payload)) {
        deps.park(kind.parkPrefix + id, payload, collapseId, kind.requires);
        this.rows.set(id, 'parked');
      } else {
        deps.send(payload, { collapseId, requires: kind.requires });
        this.rows.set(id, 'sent');
      }
    }
  }

  /**
   * The main process that published the table went away. A push presence still
   * holds would be released by that same exit ("desktop went away") for a row
   * nobody can answer: answering goes through the desktop. So held pushes are
   * forgotten, and their rows dropped from the table, so the next main's table
   * pushes them once (they were never delivered). Sent rows stay: their
   * banners are not retracted on a quit.
   */
  forgetParked(): void {
    for (const [id, state] of [...this.rows]) {
      if (state !== 'parked') continue;
      this.deps.forget(this.kind.parkPrefix + id);
      this.rows.delete(id);
    }
  }

  /** Is this park-queue key one of ours? */
  owns(key: string): boolean {
    return key.startsWith(this.kind.parkPrefix);
  }

  /** The park queue released or evicted one of ours. */
  onParkedOutcome(key: string, outcome: 'delivered' | 'dropped'): void {
    const id = key.slice(this.kind.parkPrefix.length);
    if (this.rows.get(id) !== 'parked') return;
    this.rows.set(id, outcome === 'delivered' ? 'sent' : 'dropped');
  }
}
