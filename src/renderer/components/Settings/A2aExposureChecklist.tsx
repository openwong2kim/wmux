import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { activeAgentSlug, leafDisplayName } from '../../utils/paneNaming';
import Checkbox from '../ui/Checkbox';
import { moaBrainEnd } from '../../hooks/useA2aRemoteSnapshot';
import { listedWorkspaces, moaHqId } from '../../stores/slices/moaSlice';
import type { A2aExposureV1 } from '../../../shared/a2aRemote';
import { togglePaneExposure, toggleWorkspaceExposure, type ExposureLists } from '../Remote/a2aLinkModel';

// ─── "Workspaces and panes to show" for one PC that joined this one ──────────
//
// Nothing is shown by default. Every write is an explicit pane list per
// workspace: ticking a workspace lists its current panes, never "every pane,
// including future ones". The view is pure for renderToStaticMarkup tests.

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface ChecklistWorkspace {
  id: string;
  name: string;
  panes: Array<{ id: string; name: string }>;
}

export interface A2aExposureChecklistViewProps {
  pcName: string;
  workspaces: ChecklistWorkspace[];
  exposure: ExposureLists;
  busy: boolean;
  /** This PC has a Moa that is on; when false the Moa row is disabled. */
  moaAvailable: boolean;
  onToggleBrain: (on: boolean) => void;
  onToggleWorkspace: (workspaceId: string, on: boolean) => void;
  onTogglePane: (workspaceId: string, paneId: string, on: boolean) => void;
  t: T;
}

export function A2aExposureChecklistView(p: A2aExposureChecklistViewProps) {
  const { t } = p;
  const shown = (wsId: string, paneId: string): boolean => (p.exposure.paneIds[wsId] ?? []).includes(paneId);
  return (
    <div className="flex flex-col gap-2" data-testid="a2a-exposure-checklist">
      <p className="wmux-a2a-note">{t('settings.a2aExposureDesc', { name: p.pcName })}</p>
      <ul className="wmux-a2a-list">
        <li className="wmux-a2a-row" data-testid="a2a-exposure-moa">
          <label className="wmux-a2a-row-line">
            <Checkbox
              checked={p.exposure.brain === true}
              disabled={p.busy || (!p.moaAvailable && p.exposure.brain !== true)}
              onCheckedChange={p.onToggleBrain}
              aria-label={t('settings.a2aExposureMoa')}
            />
            <span className="truncate" style={{ fontWeight: 500 }}>{t('settings.a2aExposureMoa')}</span>
          </label>
          <span className="wmux-a2a-meta" style={{ paddingLeft: 24 }}>
            {t(p.moaAvailable ? 'settings.a2aExposureMoaDesc' : 'settings.a2aExposureMoaOff')}
          </span>
        </li>
      </ul>
      {p.workspaces.length === 0 ? (
        <p className="wmux-a2a-note">{t('settings.a2aExposureEmpty')}</p>
      ) : (
        <ul className="wmux-a2a-list">
          {p.workspaces.map((ws) => {
            const count = ws.panes.filter((x) => shown(ws.id, x.id)).length;
            const all = ws.panes.length > 0 && count === ws.panes.length;
            return (
              <li key={ws.id} className="wmux-a2a-row" data-workspace-id={ws.id}>
                <label className="wmux-a2a-row-line">
                  <Checkbox
                    checked={all}
                    disabled={p.busy || ws.panes.length === 0}
                    onCheckedChange={(on) => p.onToggleWorkspace(ws.id, on)}
                    aria-label={t('settings.a2aExposureWorkspace', { name: ws.name })}
                  />
                  <span className="truncate" style={{ fontWeight: 500 }}>{ws.name}</span>
                  {count > 0 && <span className="wmux-a2a-meta tabular-nums">{t('settings.a2aExposureCount', { n: count, total: ws.panes.length })}</span>}
                </label>
                {ws.panes.map((pane) => (
                  <label key={pane.id} className="wmux-a2a-row-line" style={{ paddingLeft: 24 }} data-pane-id={pane.id}>
                    <Checkbox
                      checked={shown(ws.id, pane.id)}
                      disabled={p.busy}
                      onCheckedChange={(on) => p.onTogglePane(ws.id, pane.id, on)}
                      aria-label={pane.name}
                    />
                    <span className="truncate text-[12px]">{pane.name}</span>
                  </label>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function A2aExposureChecklist({ hostId, pcName, t }: { hostId: string; pcName: string; t: T }) {
  const api = window.electronAPI?.a2aRemote;
  const [exposure, setExposure] = useState<ExposureLists>({ workspaceIds: [], paneIds: {} });
  // Nothing can be ticked until the saved exposure is read: a tick before
  // that would write over it from an empty start.
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Writes run one at a time, each applied to the latest saved exposure.
  const latest = useRef<ExposureLists>({ workspaceIds: [], paneIds: {} });
  const queue = useRef<Promise<void>>(Promise.resolve());
  const moaAvailable = useStore((s) => moaBrainEnd(s) !== null);
  const shape = useStore(useShallow((s) => listedWorkspaces(s.workspaces, moaHqId(s)).map((ws) =>
    JSON.stringify({
      id: ws.id,
      name: ws.name,
      panes: getWorkspaceLeafPanes(ws).map((l) => ({
        id: l.id,
        name: leafDisplayName(s.paneLabel, ws, l, activeAgentSlug(s.surfaceAgent, l)),
      })),
    }),
  )));
  const workspaces = useMemo(() => shape.map((x) => JSON.parse(x) as ChecklistWorkspace), [shape]);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    if (!api) return;
    void api.exposureGet(hostId).then((r) => {
      if (!live) return;
      const next = r?.exposure ? listsOf(r.exposure) : { workspaceIds: [], paneIds: {} };
      latest.current = next;
      setExposure(next);
      setLoaded(true);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [api, hostId]);

  const write = useCallback((op: (cur: ExposureLists) => ExposureLists) => {
    if (!api) return;
    setBusy(true); setFailed(false);
    queue.current = queue.current.then(async () => {
      const next = op(latest.current);
      try {
        const r = await api.exposureSet(hostId, next.workspaceIds, next.paneIds, next.brain === true);
        if (r?.exposure) {
          latest.current = listsOf(r.exposure);
          setExposure(latest.current);
        }
      } catch {
        setFailed(true);
      }
    }).finally(() => setBusy(false));
  }, [api, hostId]);

  return (
    <>
      <A2aExposureChecklistView
        pcName={pcName}
        workspaces={workspaces}
        exposure={exposure}
        busy={busy || !loaded}
        moaAvailable={moaAvailable}
        onToggleBrain={(on) => write((cur) => ({ ...cur, brain: on }))}
        onToggleWorkspace={(ws, on) => {
          const ids = workspaces.find((w) => w.id === ws)?.panes.map((x) => x.id) ?? [];
          write((cur) => toggleWorkspaceExposure(cur, ws, ids, on));
        }}
        onTogglePane={(ws, pane, on) => write((cur) => togglePaneExposure(cur, ws, pane, on))}
        t={t}
      />
      {failed && <p className="wmux-a2a-note" data-tone="danger">{t('settings.a2aRemoteActionFailed')}</p>}
    </>
  );
}

function listsOf(e: A2aExposureV1): ExposureLists {
  return { workspaceIds: e.workspaceIds, paneIds: e.paneIds ?? {}, ...(e.brain ? { brain: true } : {}) };
}
