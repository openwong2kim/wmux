// Remote approvals on the Remote page: per paired PC, whether agents on that
// PC can allow or deny the permission prompts in the tasks they sent to a
// linked pane here (`wmux remote approvals`). The daemon takes the setting
// only from the app where the app runs; main passes it on as the app's own
// call. The rules live here, apart from React, so a test drives them:
//   - raising a PC (off to anything, or anything to `command`) waits for a
//     confirmation, which reads the setting again and refuses when it changed
//     meanwhile; Cancel, even while that read is out, saves nothing;
//   - lowering it or turning it off is saved at once;
//   - every save carries the level it started from (`expected`): the daemon
//     saves only while the PC is still there, else the row shows the level
//     now and a person chooses again;
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
  approvalsSet: (hostId: string, exposure: ApprovalLevel, expected: ApprovalLevel) => Promise<{ ok: true; hosts: Record<string, unknown> } | { ok: false; error: string; conflict?: true }>;
}

export class ApprovalsController {
  levels: Record<string, ApprovalLevel> = {};
  damaged = false;
  /** False until the first read answered. */
  loaded = false;
  /** Raises waiting for their confirmation, by PC: one PC's choice never touches another's. */
  pending: Record<string, { level: ApprovalLevel; from: ApprovalLevel }> = {};
  /** PCs with a confirmation or a save in flight, by the token of the call that owns it. */
  busy: Record<string, object> = {};
  /** The last failure, by PC. */
  errors: Record<string, string> = {};

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
    delete this.errors[hostId];
    delete this.pending[hostId];
    if (level !== before && raisesApproval(before, level)) {
      this.pending[hostId] = { level, from: before };
    } else if (level !== before) {
      await this.save(hostId, level, before);
      return;
    }
    this.changed();
  }

  cancel(hostId: string): void {
    delete this.pending[hostId];
    this.changed();
  }

  async confirm(hostId: string): Promise<void> {
    const p = this.pending[hostId];
    if (!p) return;
    this.busy[hostId] = p;
    this.changed();
    try {
      // The level the confirmation was about must still be the one saved.
      const now = await this.api.approvalsGet();
      // Cancelled (or chosen again) while the read was out: this confirmation is gone.
      if (this.pending[hostId] !== p) return;
      const current = now.damaged === true ? 'off' : approvalLevelOf(now.hosts?.[hostId]);
      delete this.pending[hostId];
      if (current !== p.from) {
        this.read(now);
        this.errors[hostId] = this.words.changed;
        return;
      }
      await this.save(hostId, p.level, p.from);
    } catch {
      this.errors[hostId] = this.words.failed;
    } finally {
      // Only its own: a confirmation that ended early leaves a newer one's busy alone.
      if (this.busy[hostId] === p) delete this.busy[hostId];
      this.changed();
    }
  }

  private async save(hostId: string, level: ApprovalLevel, expected: ApprovalLevel): Promise<void> {
    const token = {};
    this.busy[hostId] = token;
    this.changed();
    try {
      const res = await this.api.approvalsSet(hostId, level, expected);
      if (res.ok) {
        // What the save itself returned: no second read that could fail after it was saved.
        this.read({ hosts: res.hosts, damaged: false });
      } else {
        this.errors[hostId] = res.conflict ? this.words.changed : `${this.words.failed} (${res.error})`;
        // The level there now; a failed read keeps what was shown.
        this.read(await this.api.approvalsGet().catch(() => ({ hosts: this.levels, damaged: this.damaged })));
      }
    } catch {
      this.errors[hostId] = this.words.failed;
    } finally {
      if (this.busy[hostId] === token) delete this.busy[hostId];
      this.changed();
    }
  }
}
