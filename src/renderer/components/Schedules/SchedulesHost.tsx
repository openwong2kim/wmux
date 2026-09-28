import { useEffect, useRef } from 'react';
import { useStore } from '../../stores';
import { t } from '../../i18n';
import { ErrorBoundary } from '../ErrorBoundary';
import SchedulesView from './SchedulesView';
import { openAutomationRun } from './openRun';

/** The localized words main puts after "<name> · " in a scheduled-run toast. */
export function toastLabels() {
  return {
    awaiting: t('schedules.toast.awaiting'),
    failed: t('schedules.toast.failed'),
    proposed: t('schedules.toast.proposed'),
    grantRaised: t('schedules.toast.grantRaised'),
  };
}

/**
 * Wires the renderer to main's scheduled-run feed (pushes, toast clicks,
 * daemon reconnects) and pulls once on mount — a reloaded renderer must not
 * wait for the next reconnect snapshot. Hosted by WorkspaceCenter, which is
 * always mounted; renders the Schedules view over the pane grid when open.
 */
export function useAutomationBridge(): void {
  const locale = useStore((s) => s.locale);
  useEffect(() => {
    const api = window.electronAPI?.automation;
    if (!api) return undefined;
    const st = useStore.getState;
    const offPush = api.onPush((push) => st().applyAutomationPush(push));
    const offOpen = api.onOpenRun((request) => {
      if (request.runId) void openAutomationRun(request.runId);
      else st().openSchedulesView(request.automationId);
    });
    const offConnected = window.electronAPI?.daemon?.onConnected?.(() => { void st().refreshSchedules(); });
    void st().refreshSchedules();
    return () => {
      offPush();
      offOpen();
      offConnected?.();
    };
  }, []);
  useEffect(() => {
    window.electronAPI?.automation?.setToastLabels(toastLabels());
  }, [locale]);
}

export default function SchedulesHost() {
  useAutomationBridge();
  const open = useStore((s) => s.schedulesViewOpen);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  // Picking a workspace in the sidebar means "show me that workspace": the
  // view gives the main area back.
  const lastWs = useRef(activeWorkspaceId);
  useEffect(() => {
    if (lastWs.current === activeWorkspaceId) return;
    lastWs.current = activeWorkspaceId;
    useStore.getState().closeSchedulesView();
  }, [activeWorkspaceId]);
  if (!open) return null;
  return (
    <ErrorBoundary name="SchedulesView">
      <SchedulesView />
    </ErrorBoundary>
  );
}
