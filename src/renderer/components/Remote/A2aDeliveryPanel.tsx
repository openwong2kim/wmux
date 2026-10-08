import { useCallback, useEffect, useState } from 'react';
import type { A2aRemoteTaskState } from '../../../shared/a2aRemoteDelivery';
import type { A2aRemoteHostStatus } from '../../../shared/rpc';
import type { Task } from '../../../shared/types';
import { useT } from '../../hooks/useT';
import UiButton from '../ui/Button';
import Badge from '../ui/Badge';

// ─── Cross-PC delivery on the Remote page ────────────────────────────────────
//
// Each paired PC's connection (connected / connecting / disconnected / its
// certificate changed) with the messages still owed to it, and the remote
// work held for a person: the target pane is gone or another agent holds it
// now. Held work is never re-routed on its own; the person delivers it to the
// pane as it is now, or rejects it (the other PC is told). Draws nothing
// while there is no paired PC and nothing held.

type T = (key: string, vars?: Record<string, string | number>) => string;

const STATE_TONE = { connected: 'success', connecting: 'neutral', disconnected: 'neutral', 'identity-changed': 'warning' } as const;

/** Why a task (or its newest held reply) is held. */
export function heldReason(task: Task): string | undefined {
  const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
  if (!marker) return undefined;
  return marker.held ?? marker.inbox?.find((i) => i.held)?.held;
}

/** The PC a held task came from or went to: the alias' first part. */
export function heldPeer(task: Task): string {
  const remoteEnd = task.metadata.from.workspaceId.startsWith('remote:') ? task.metadata.from : task.metadata.to;
  return (remoteEnd.name ?? '').split('/')[0] || '?';
}

export interface A2aDeliveryViewProps {
  hosts: A2aRemoteHostStatus[];
  held: Task[];
  busy: string | null;
  error: string | null;
  onRetry: (taskId: string) => void;
  onReject: (taskId: string) => void;
  t: T;
}

export function A2aDeliveryView(p: A2aDeliveryViewProps) {
  const { t } = p;
  if (p.hosts.length === 0 && p.held.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="a2a-delivery-title" data-testid="a2a-delivery">
      <h2 id="a2a-delivery-title" className="wmux-remote-section-title">{t('a2aDelivery.sectionTitle')}</h2>
      {p.hosts.length > 0 && (
        <ul className="wmux-a2a-list" aria-label={t('a2aDelivery.pcs')} data-testid="a2a-delivery-hosts">
          {p.hosts.map((h) => (
            <li key={h.hostId} className="wmux-a2a-row" data-host-id={h.hostId}>
              <span className="wmux-a2a-row-line">
                <span className="truncate flex-1" style={{ fontWeight: 500 }}>{h.name || h.hostId.slice(0, 6)}</span>
                <Badge tone={STATE_TONE[h.state]} data-state={h.state}>{t(`a2aDelivery.state.${h.state}`)}</Badge>
              </span>
              {h.state === 'identity-changed' && (
                <p className="wmux-a2a-note" data-tone="warning" data-testid="a2a-delivery-identity">{t('a2aDelivery.identityChanged')}</p>
              )}
              {h.pending > 0 && (
                <span className="wmux-a2a-meta" data-testid="a2a-delivery-pending">
                  {h.state === 'connected'
                    ? t('a2aDelivery.sending', { count: h.pending })
                    : t('a2aDelivery.waiting', { count: h.pending })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {p.held.length > 0 && (
        <ul className="wmux-a2a-list" aria-label={t('a2aDelivery.held')} data-testid="a2a-delivery-held">
          {p.held.map((task) => {
            const reason = heldReason(task) ?? 'pane-missing';
            // Work for Moa is never handed to a pane; a brain-unavailable hold goes by itself once Moa can take it.
            const brain = reason === 'brain-delivery-pending' || reason === 'brain-unavailable';
            return (
              <li key={task.id} className="wmux-a2a-row" data-task-id={task.id}>
                <span className="wmux-a2a-row-line">
                  <span className="truncate flex-1" style={{ fontWeight: 500 }}>{task.metadata.title}</span>
                  <Badge tone="warning">{t('a2aDelivery.heldBadge')}</Badge>
                </span>
                <span className="wmux-a2a-meta">{t('a2aDelivery.heldFrom', { pc: heldPeer(task) })}</span>
                <span className="wmux-a2a-meta" data-testid="a2a-delivery-reason">{t(`a2aDelivery.reason.${reason}`)}</span>
                <span className="wmux-a2a-row-line" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
                  <UiButton variant="ghost" size="md" disabled={p.busy === task.id} onClick={() => p.onReject(task.id)}>
                    {t('a2aDelivery.reject')}
                  </UiButton>
                  {!brain && (
                    <UiButton variant="primary" size="md" disabled={p.busy === task.id} onClick={() => p.onRetry(task.id)} data-testid="a2a-delivery-retry">
                      {t('a2aDelivery.retry')}
                    </UiButton>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {p.error && <p className="wmux-a2a-note" data-tone="danger">{p.error}</p>}
    </section>
  );
}

/** How often the panel re-reads while the Remote page is open (status also arrives as a nudge). */
export const A2A_DELIVERY_POLL_MS = 10_000;

export default function A2aDeliveryPanel() {
  const t = useT();
  const api = window.electronAPI?.a2aRemote;
  const [hosts, setHosts] = useState<A2aRemoteHostStatus[]>([]);
  const [held, setHeld] = useState<Task[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!api?.hostsStatus) return;
    try {
      const [s, h] = await Promise.all([api.hostsStatus(), api.heldList()]);
      if (Array.isArray(s?.hosts)) setHosts(s.hosts);
      if (Array.isArray(h?.tasks)) setHeld(h.tasks);
    } catch {
      // The daemon is away; the next poll or nudge tries again.
    }
  }, [api]);

  useEffect(() => {
    void reload();
    const offStatus = api?.onHostStatus?.(() => void reload());
    const offLink = api?.onLinkEvent?.(() => void reload());
    const poll = setInterval(() => void reload(), A2A_DELIVERY_POLL_MS);
    return () => { offStatus?.(); offLink?.(); clearInterval(poll); };
  }, [api, reload]);

  const act = useCallback(async (taskId: string, run: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(taskId); setError(null);
    try {
      const r = await run();
      if (!r.ok) setError(t('a2aDelivery.failed'));
    } catch {
      setError(t('a2aDelivery.failed'));
    } finally {
      setBusy(null);
      void reload();
    }
  }, [reload, t]);

  if (!api?.hostsStatus) return null;
  return (
    <A2aDeliveryView
      hosts={hosts}
      held={held}
      busy={busy}
      error={error}
      onRetry={(id) => void act(id, () => api.heldRetry(id))}
      onReject={(id) => void act(id, () => api.heldReject(id))}
      t={t}
    />
  );
}
