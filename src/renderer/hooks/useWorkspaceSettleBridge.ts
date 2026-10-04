import { useEffect } from 'react';
import { useStore } from '../stores';
import { t } from '../i18n';
import { formatWhen } from '../components/Schedules/format';
import {
  WORKSPACE_SETTLE_UNDO_MS,
  type WorkspaceSettleChange,
  type WorkspaceSettleChangedPayload,
  type WorkspaceSettleCommand,
  type WorkspaceSettleCommandResult,
} from '../../shared/workspaceSettle';

// ─── Workspace settle bridge ─────────────────────────────────────────────────
//
// The single owner of the `workspaceSettle` IPC subscription, mounted once in
// AppLayout. Hydrates the slice from `get()` on mount, then follows
// `onChanged`: every push replaces the snapshot, and its undoable changes
// raise one toast with an Undo action — a named one for a single change, a
// counted one for a batch (several workspaces idle-settling after a restart).

/**
 * Send one verb. Resolves the result, or null when the channel is missing or
 * the call failed. A successful result's snapshot is applied at once, so the
 * UI does not wait for the push that follows it. A refusal or a failure
 * (e.g. an undo whose window ran out) raises one toast.
 */
export function sendWorkspaceSettleCommand(command: WorkspaceSettleCommand): Promise<WorkspaceSettleCommandResult | null> {
  const api = window.electronAPI?.workspaceSettle;
  if (!api) return Promise.resolve(null);
  return api.command(command).then((res) => {
    if (res?.ok) useStore.getState().setWorkspaceSettleSnapshot(res.snapshot);
    else if (res) {
      useStore.getState().pushToast({
        level: 'warn',
        message: t(res.error === 'refused' ? 'workspaceSettle.refused'
          : res.error === 'hq' ? 'workspaceSettle.hq'
          : 'workspaceSettle.failed'),
      });
    }
    return res ?? null;
  }, (err: unknown) => {
    console.warn('[workspaceSettle] command failed', err);
    return null;
  });
}

/** How long the idle-days field waits for typing to pause before it sends. */
export const IDLE_DAYS_SEND_DELAY_MS = 600;
let idleDaysTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Send the idle-days setting once typing pauses, so "14" is one command and
 * never a passing 1.
 */
export function sendWorkspaceSettleIdleDays(days: number): void {
  if (idleDaysTimer) clearTimeout(idleDaysTimer);
  idleDaysTimer = setTimeout(() => {
    idleDaysTimer = null;
    void sendWorkspaceSettleCommand({ op: 'setIdleDays', days });
  }, IDLE_DAYS_SEND_DELAY_MS);
}

/** Apply one push: replace the snapshot, then toast its undoable changes. */
export function applyWorkspaceSettleChanges(payload: WorkspaceSettleChangedPayload): void {
  const store = useStore.getState();
  if (payload?.snapshot) store.setWorkspaceSettleSnapshot(payload.snapshot);
  const workspaces = useStore.getState().workspaces;
  const shown: { change: WorkspaceSettleChange; name: string }[] = [];
  for (const change of payload?.changes ?? []) {
    if (!change.undoable || change.kind === 'unsettled') continue;
    const name = workspaces.find((w) => w.id === change.workspaceId)?.name;
    if (name !== undefined) shown.push({ change, name });
  }
  if (shown.length === 0) return;
  let message: string;
  if (shown.length === 1) {
    const { change, name } = shown[0];
    if (change.kind === 'settled') {
      message = t('workspaceSettle.toastSettled', { name });
    } else if (change.kind === 'snoozed') {
      const until = payload.snapshot?.states?.[change.workspaceId]?.snoozedUntil;
      message = until !== undefined
        ? t('workspaceSettle.toastSnoozed', { name, time: formatWhen(until) })
        : t('workspaceSettle.toastSnoozedNoTime', { name });
    } else {
      message = t('workspaceSettle.toastBack', { name });
    }
  } else {
    const count = shown.length;
    const kind = shown[0].change.kind;
    message = shown.some((e) => e.change.kind !== kind) ? t('workspaceSettle.toastBatchMixed', { count })
      : kind === 'settled' ? t('workspaceSettle.toastBatchSettled', { count })
      : kind === 'snoozed' ? t('workspaceSettle.toastBatchSnoozed', { count })
      : t('workspaceSettle.toastBatchBack', { count });
  }
  store.pushToast({
    level: 'info',
    message,
    durationMs: WORKSPACE_SETTLE_UNDO_MS,
    action: {
      label: t('workspaceSettle.undo'),
      onClick: () => {
        for (const { change } of shown) void sendWorkspaceSettleCommand({ op: 'undo', changeId: change.id });
      },
    },
  });
}

export function useWorkspaceSettleBridge(): void {
  useEffect(() => {
    const api = window.electronAPI?.workspaceSettle;
    if (!api) return; // older preload bundles do not expose this channel
    let cancelled = false;
    // A push that lands before `get()` resolves is newer than its answer.
    let pushed = false;
    const off = api.onChanged((payload) => {
      pushed = true;
      applyWorkspaceSettleChanges(payload);
    });
    void api.get().then((snapshot) => {
      if (!cancelled && !pushed && snapshot) useStore.getState().setWorkspaceSettleSnapshot(snapshot);
    }).catch(() => { /* best-effort — the next push carries the full snapshot */ });
    return () => {
      cancelled = true;
      off();
    };
  }, []);
}
