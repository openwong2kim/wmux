// Remote approvals on the Remote page: per paired PC, whether agents on that
// PC can allow or deny the permission prompts in the tasks they sent to a
// linked pane here (`wmux remote approvals`). The daemon takes the setting
// only from the app where the app runs; main passes it on as the app's own
// call. The rules live here, apart from React, so a test drives them:
//   - raising a PC (off to anything, or anything to `command`) waits for a
//     confirmation, which reads the setting again and refuses when it changed
//     meanwhile;
//   - lowering it or turning it off is saved at once;
//   - a damaged settings file reads as off for every PC.

import { isA2aApprovalExposure, type A2aApprovalExposure } from '../../../shared/a2aRemote';

export type ApprovalLevel = 'off' | A2aApprovalExposure;

export const APPROVAL_LEVELS: readonly ApprovalLevel[] = ['off', 'tool-only', 'command'];

/** Whether going from `before` to `after` widens what that PC may do, and so asks first. */
export function raisesApproval(before: ApprovalLevel, after: ApprovalLevel): boolean {
  return (before === 'off' && after !== 'off') || (after === 'command' && before !== 'command');
}

export function approvalLevelOf(v: unknown): ApprovalLevel {
  return isA2aApprovalExposure(v) ? v : 'off';
}

export interface ApprovalsApi {
  approvalsGet: () => Promise<{ hosts?: Record<string, unknown>; damaged?: boolean }>;
  approvalsSet: (hostId: string, exposure: ApprovalLevel) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export class ApprovalsController {
  levels: Record<string, ApprovalLevel> = {};
  damaged = false;
  /** False until the first read answered. */
  loaded = false;
  /** A raise waiting for its confirmation. */
  pending: { hostId: string; level: ApprovalLevel; from: ApprovalLevel } | null = null;
  /** The PC whose save is in flight. */
  busy: string | null = null;
  error: { hostId: string; message: string } | null = null;

  constructor(
    private readonly api: ApprovalsApi,
    private readonly words: { failed: string; changed: string },
    private readonly changed: () => void,
  ) {}

  levelOf(hostId: string): ApprovalLevel {
    return this.levels[hostId] ?? 'off';
  }

  /** A failed read keeps what was shown. */
  async load(): Promise<void> {
    try {
      this.read(await this.api.approvalsGet());
      this.loaded = true;
    } catch {
      // Kept.
    }
    this.changed();
  }

  private read(approvals: { hosts?: Record<string, unknown>; damaged?: boolean }): void {
    this.damaged = approvals.damaged === true;
    const levels: Record<string, ApprovalLevel> = {};
    for (const [hostId, v] of Object.entries(approvals.hosts ?? {})) levels[hostId] = approvalLevelOf(v);
    this.levels = this.damaged ? {} : levels;
  }

  async choose(hostId: string, level: ApprovalLevel): Promise<void> {
    const before = this.levelOf(hostId);
    if (this.error?.hostId === hostId) this.error = null;
    if (level === before) {
      this.pending = null;
    } else if (raisesApproval(before, level)) {
      this.pending = { hostId, level, from: before };
    } else {
      this.pending = null;
      await this.save(hostId, level);
      return;
    }
    this.changed();
  }

  cancel(): void {
    this.pending = null;
    this.changed();
  }

  async confirm(): Promise<void> {
    const p = this.pending;
    if (!p) return;
    this.busy = p.hostId;
    this.changed();
    try {
      // The level the confirmation was about must still be the one saved.
      const now = await this.api.approvalsGet();
      const current = now.damaged === true ? 'off' : approvalLevelOf(now.hosts?.[p.hostId]);
      this.pending = null;
      if (current !== p.from) {
        this.read(now);
        this.error = { hostId: p.hostId, message: this.words.changed };
        return;
      }
      await this.save(p.hostId, p.level);
    } catch {
      this.error = { hostId: p.hostId, message: this.words.failed };
    } finally {
      this.busy = null;
      this.changed();
    }
  }

  private async save(hostId: string, level: ApprovalLevel): Promise<void> {
    this.busy = hostId;
    this.changed();
    try {
      const res = await this.api.approvalsSet(hostId, level);
      if (!res.ok) this.error = { hostId, message: `${this.words.failed} (${res.error})` };
      this.read(await this.api.approvalsGet());
    } catch {
      this.error = { hostId, message: this.words.failed };
    } finally {
      this.busy = null;
      this.changed();
    }
  }
}
