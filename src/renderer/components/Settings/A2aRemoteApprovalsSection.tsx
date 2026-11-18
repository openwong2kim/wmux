import { useCallback, useEffect, useRef, useState } from 'react';
import { isA2aApprovalExposure, type A2aApprovalExposure } from '../../../shared/a2aRemote';
import { useT } from '../../hooks/useT';
import UiButton from '../ui/Button';
import SegmentedControl from '../ui/SegmentedControl';
import { SettingsSection, SettingRow, SettingNote } from './SettingsLayout';

// ─── Remote approvals ───────────────────────────────────────────────────────
//
// Settings › LAN, below the A2A listener: one row per paired PC, saying
// whether agents on that PC can allow or deny the permission prompts in the
// tasks they sent to a linked pane here (`wmux remote approvals`). The daemon
// takes this setting only from the app where the app runs; main passes it on
// as the app's own call.
//
// Raising a PC (off to anything, or anything to `command`) waits for a
// confirmation under its row, as the CLI waits for a typed yes; lowering it or
// turning it off is saved at once. The VIEW is pure (props only) so it renders
// under renderToStaticMarkup in a node test.

type T = (key: string, vars?: Record<string, string | number>) => string;

export type ApprovalLevel = 'off' | A2aApprovalExposure;

export const APPROVAL_LEVELS: readonly ApprovalLevel[] = ['off', 'tool-only', 'command'];

/** Whether going from `before` to `after` widens what that PC may do, and so asks first. */
export function raisesApproval(before: ApprovalLevel, after: ApprovalLevel): boolean {
  return (before === 'off' && after !== 'off') || (after === 'command' && before !== 'command');
}

export function approvalLevelOf(v: unknown): ApprovalLevel {
  return isA2aApprovalExposure(v) ? v : 'off';
}

export interface ApprovalPc {
  hostId: string;
  name: string;
}

export interface A2aApprovalsViewProps {
  pcs: readonly ApprovalPc[];
  levels: Readonly<Record<string, ApprovalLevel>>;
  /** The settings file was damaged: every PC reads off until one is set again. */
  damaged: boolean;
  /** A raise waiting for its confirmation. */
  pending: { hostId: string; level: ApprovalLevel } | null;
  busy: boolean;
  error: string | null;
  onChange: (hostId: string, level: ApprovalLevel) => void;
  onConfirm: () => void;
  onCancel: () => void;
  t: T;
}

export function pcLabel(pc: ApprovalPc): string {
  return pc.name || pc.hostId.slice(0, 8);
}

export function A2aApprovalsView(props: A2aApprovalsViewProps) {
  const { pcs, levels, damaged, pending, busy, error, onChange, onConfirm, onCancel, t } = props;
  const options = APPROVAL_LEVELS.map((value) => ({ value, label: t(`settings.a2aApprovals.level.${value}`) }));
  return (
    <SettingsSection id="a2aapprovals" title={t('settings.a2aApprovals')} description={t('settings.a2aApprovalsDesc')} data-testid="a2a-approvals-section">
      {damaged && <SettingNote tone="warning" data-testid="a2a-approvals-damaged">{t('settings.a2aApprovalsDamaged')}</SettingNote>}
      {pcs.length === 0 && <SettingNote>{t('settings.a2aApprovalsNoPcs')}</SettingNote>}
      {pcs.map((pc) => {
        const name = pcLabel(pc);
        const waiting = pending?.hostId === pc.hostId ? pending : null;
        return (
          <div key={pc.hostId} data-a2a-approvals-pc={pc.hostId}>
            <SettingRow label={name} description={t('settings.a2aApprovalsRow', { pc: name })}>
              <SegmentedControl
                value={waiting ? waiting.level : levels[pc.hostId] ?? 'off'}
                options={options.map((o) => ({ ...o, disabled: busy }))}
                onValueChange={(v) => onChange(pc.hostId, v)}
                ariaLabel={t('settings.a2aApprovalsRow', { pc: name })}
                data-testid={`a2a-approvals-level-${pc.hostId}`}
              />
            </SettingRow>
            {waiting && (
              <SettingNote tone="warning" role="alert" className="flex items-center justify-between gap-3" data-testid="a2a-approvals-confirm">
                <span>{t(waiting.level === 'command' ? 'settings.a2aApprovalsConfirmCommand' : 'settings.a2aApprovalsConfirmToolOnly', { pc: name })}</span>
                <span className="flex shrink-0 gap-2">
                  <UiButton variant="ghost" size="sm" onClick={onCancel} data-testid="a2a-approvals-cancel">{t('settings.a2aApprovalsCancel')}</UiButton>
                  <UiButton variant="secondary" size="sm" disabled={busy} onClick={onConfirm} data-testid="a2a-approvals-ok">
                    {t('settings.a2aApprovalsAllow')}
                  </UiButton>
                </span>
              </SettingNote>
            )}
          </div>
        );
      })}
      {error && <SettingNote tone="danger" role="alert" data-testid="a2a-approvals-error">{error}</SettingNote>}
    </SettingsSection>
  );
}

export interface ApprovalsApi {
  hostsList: () => Promise<{ hosts?: Array<{ hostId: string; name: string }> }>;
  peersList: () => Promise<{ peers?: Array<{ hostId: string; name: string; revokedAt?: string }> }>;
  approvalsGet: () => Promise<{ hosts?: Record<string, unknown>; damaged?: boolean }>;
  approvalsSet: (hostId: string, exposure: ApprovalLevel) => Promise<{ ok: true } | { ok: false; error: string }>;
}

/** Paired PCs: those this PC joined, then those that joined it and were not revoked. */
export function pairedPcs(hosts: ReadonlyArray<{ hostId: string; name: string }>, peers: ReadonlyArray<{ hostId: string; name: string; revokedAt?: string }>): ApprovalPc[] {
  const byId = new Map<string, ApprovalPc>();
  for (const h of hosts) byId.set(h.hostId, { hostId: h.hostId, name: h.name });
  for (const p of peers) if (!p.revokedAt && !byId.has(p.hostId)) byId.set(p.hostId, { hostId: p.hostId, name: p.name });
  return [...byId.values()];
}

/**
 * The section's state and its rules, apart from React so a test drives it:
 * a raise waits for `confirm` (which reads the setting again and refuses when
 * it changed meanwhile); anything else is saved at once.
 */
export class ApprovalsModel {
  pcs: ApprovalPc[] = [];
  levels: Record<string, ApprovalLevel> = {};
  damaged = false;
  pending: { hostId: string; level: ApprovalLevel; from: ApprovalLevel } | null = null;
  busy = false;
  error: string | null = null;

  constructor(private readonly api: ApprovalsApi, private readonly words: { failed: string; changed: string }, private readonly changed: () => void) {}

  async load(): Promise<boolean> {
    const [hosts, peers, approvals] = await Promise.all([this.api.hostsList(), this.api.peersList(), this.api.approvalsGet()]);
    this.pcs = pairedPcs(hosts.hosts ?? [], peers.peers ?? []);
    this.read(approvals);
    this.changed();
    return true;
  }

  private read(approvals: { hosts?: Record<string, unknown>; damaged?: boolean }): void {
    this.damaged = approvals.damaged === true;
    const levels: Record<string, ApprovalLevel> = {};
    for (const [hostId, v] of Object.entries(approvals.hosts ?? {})) levels[hostId] = approvalLevelOf(v);
    this.levels = this.damaged ? {} : levels;
  }

  async choose(hostId: string, level: ApprovalLevel): Promise<void> {
    const before = this.levels[hostId] ?? 'off';
    this.error = null;
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
    this.busy = true;
    this.changed();
    try {
      // The level the confirmation was about must still be the one saved.
      const now = await this.api.approvalsGet();
      const current = now.damaged === true ? 'off' : approvalLevelOf(now.hosts?.[p.hostId]);
      if (current !== p.from) {
        this.read(now);
        this.pending = null;
        this.error = this.words.changed;
        return;
      }
      this.pending = null;
      await this.save(p.hostId, p.level);
    } catch {
      this.error = this.words.failed;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  private async save(hostId: string, level: ApprovalLevel): Promise<void> {
    this.busy = true;
    this.changed();
    try {
      const res = await this.api.approvalsSet(hostId, level);
      if (!res.ok) this.error = `${this.words.failed} (${res.error})`;
      this.read(await this.api.approvalsGet());
    } catch {
      this.error = this.words.failed;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}

export function A2aRemoteApprovalsSection() {
  const t = useT();
  const api = window.electronAPI?.a2aRemote;
  const [, setTick] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const model = useRef<ApprovalsModel | null>(null);
  if (!model.current && api) {
    model.current = new ApprovalsModel(api as ApprovalsApi, {
      failed: t('settings.a2aRemoteActionFailed'),
      changed: t('settings.a2aApprovalsChanged'),
    }, () => setTick((n) => n + 1));
  }

  const refresh = useCallback(async () => {
    if (!model.current) { setUnavailable(true); return; }
    try {
      await model.current.load();
      setUnavailable(false);
      setLoaded(true);
    } catch {
      setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (unavailable || !loaded || !model.current) {
    return (
      <SettingsSection id="a2aapprovals" title={t('settings.a2aApprovals')} data-testid="a2a-approvals-section">
        <SettingNote>{unavailable ? t('settings.a2aRemoteUnavailable') : t('settings.a2aRemoteLoading')}</SettingNote>
      </SettingsSection>
    );
  }
  const m = model.current;
  return (
    <A2aApprovalsView
      pcs={m.pcs}
      levels={m.levels}
      damaged={m.damaged}
      pending={m.pending}
      busy={m.busy}
      error={m.error}
      onChange={(hostId, level) => void m.choose(hostId, level)}
      onConfirm={() => void m.confirm()}
      onCancel={() => m.cancel()}
      t={t}
    />
  );
}
