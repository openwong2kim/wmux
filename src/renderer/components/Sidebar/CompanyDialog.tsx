import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Workspace } from '../../../shared/types';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { useStore, type StoreState } from '../../stores';
import { useT } from '../../hooks/useT';
import { paneTag } from '../../utils/paneNaming';
import { displayPath } from '../../utils/displayPath';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Field from '../ui/Field';
import TextArea from '../ui/TextArea';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import { FOCUS_RING } from '../focusRing';

/** One pane the CEO radio list offers. */
interface CeoCandidate {
  paneId: string;
  /** The pane's label, else its agent, else its tab title. */
  title: string;
  tag: string;
  /** The detected agent's name; a pane without one cannot be the CEO. */
  agent?: string;
  cwd?: string;
}

/** Every pane of the workspace, stashed ones included, in layout order. */
function ceoCandidates(
  ws: Workspace,
  surfaceAgent: StoreState['surfaceAgent'],
  paneLabel: StoreState['paneLabel'],
): CeoCandidate[] {
  return getWorkspaceLeafPanes(ws).map((leaf) => {
    const agentSurface = leaf.surfaces.find((sf) => (sf.surfaceType ?? 'terminal') === 'terminal' && !!sf.ptyId && !!surfaceAgent[sf.ptyId]?.name);
    const surface = agentSurface ?? leaf.surfaces.find((sf) => sf.id === leaf.activeSurfaceId) ?? leaf.surfaces[0];
    const agent = agentSurface ? surfaceAgent[agentSurface.ptyId].name : undefined;
    return {
      paneId: leaf.id,
      title: paneLabel[leaf.id]?.trim() || agent || surface?.title || '',
      tag: paneTag(ws, leaf),
      agent,
      cwd: surface?.cwd,
    };
  });
}

/**
 * Make company / Company settings: the mission, the CEO pane and the standing
 * orders, written as the workspace's company record. Opened from the
 * workspace row's menu.
 */
export default function CompanyDialog({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const t = useT();
  const setWorkspaceCompany = useStore((s) => s.setWorkspaceCompany);
  const surfaceAgent = useStore((s) => s.surfaceAgent);
  const paneLabel = useStore((s) => s.paneLabel);
  const company = workspace.company;
  const candidates = useMemo(() => ceoCandidates(workspace, surfaceAgent, paneLabel), [workspace, surfaceAgent, paneLabel]);
  // The seated CEO stays pickable while its agent is between runs.
  const eligible = (c: CeoCandidate) => !!c.agent || c.paneId === company?.coordinatorPaneId;
  const [mission, setMission] = useState(company?.mission ?? '');
  const [standingOrders, setStandingOrders] = useState(company?.standingOrders ?? '');
  // A company whose CEO pane is gone opens with the seat empty: saving another
  // field must not hand the seat to a pane nobody picked.
  const [ceo, setCeo] = useState<string | null>(() => {
    if (company) return candidates.find((c) => c.paneId === company.coordinatorPaneId)?.paneId ?? null;
    return candidates.find(eligible)?.paneId ?? null;
  });
  const missionRef = useRef<HTMLInputElement>(null);
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const ceoLabelId = useId();
  const ceoHintId = useId();

  const picked = candidates.some((c) => c.paneId === ceo && eligible(c)) ? ceo : null;
  const tabStop = candidates.findIndex((c) => (picked ? c.paneId === picked : eligible(c)));

  // Arrow keys move the choice through the panes that can take the seat.
  const onRadioKey = (from: number, e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    for (let i = 1; i <= candidates.length; i += 1) {
      const next = (from + step * i + candidates.length) % candidates.length;
      if (eligible(candidates[next])) {
        setCeo(candidates[next].paneId);
        radioRefs.current[next]?.focus();
        return;
      }
    }
  };

  // A new company needs a CEO; an existing one may keep its seat vacant.
  const canSave = !!picked || !!company;
  const save = () => {
    if (!canSave) return;
    setWorkspaceCompany(workspace.id, { coordinatorPaneId: picked, mission, standingOrders });
    onClose();
  };

  return (
    <Dialog onClose={onClose} closeOnBackdrop width={480} initialFocusRef={missionRef} zIndexClassName="z-[var(--z-modal-top)]" data-testid="company-dialog">
      <DialogHeader
        title={company ? t('company.settingsTitle') : t('company.makeTitle')}
        description={t('company.dialogDescription', { name: workspace.name })}
        closeLabel={t('company.close')}
      />
      <DialogBody>
        <Field label={t('company.mission')} layout="stacked">
          <Input
            ref={missionRef}
            className="w-full"
            placeholder={t('company.missionPlaceholder')}
            value={mission}
            onChange={(e) => setMission(e.target.value)}
          />
        </Field>

        {/* A stacked Field's text, around a radio group a <label for> cannot name. */}
        <div className="ui-field" data-layout="stacked">
          <div className="ui-field-text">
            <span className="ui-field-label" id={ceoLabelId}>{t('company.ceo')}</span>
            <span className="ui-field-description" id={ceoHintId}>{t('company.ceoHint')}</span>
          </div>
          <div className="ui-group" role="radiogroup" aria-labelledby={ceoLabelId} aria-describedby={ceoHintId}>
            {candidates.map((c, i) => {
              const on = c.paneId === picked;
              const enabled = eligible(c);
              return (
                <button
                  key={c.paneId}
                  ref={(el) => { radioRefs.current[i] = el; }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={!enabled}
                  tabIndex={i === tabStop ? 0 : -1}
                  className={`ui-row w-full text-left ${enabled ? 'hover:bg-[var(--surface-fill-hover)]' : 'opacity-50'} ${FOCUS_RING}`}
                  onClick={() => setCeo(c.paneId)}
                  onKeyDown={(e) => onRadioKey(i, e)}
                  data-ceo-pane={c.paneId}
                >
                  <span
                    className="flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full border"
                    style={{ borderColor: on ? 'var(--text-main)' : 'var(--text-sub)' }}
                    aria-hidden="true"
                  >
                    {on && <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-main)]" />}
                  </span>
                  <span className="ui-row-text">
                    <span className="ui-row-title flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate">{c.title || t('surface.terminal')}</span>
                      <span className="flex-none text-[11px] font-normal text-[var(--text-muted)]">{c.tag}</span>
                    </span>
                    <span className="ui-row-detail truncate">
                      {c.agent
                        ? [c.title !== c.agent ? c.agent : '', displayPath(c.cwd)].filter(Boolean).join(' · ')
                        : t('company.noAgent')}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {!candidates.some(eligible) && <p className="ui-note">{t('company.noAgentAnywhere')}</p>}
        </div>

        <Field
          label={<>{t('company.standingOrders')} <span className="font-normal text-[var(--text-muted)]">{t('company.optional')}</span></>}
          layout="stacked"
        >
          <TextArea
            rows={3}
            className="w-full"
            placeholder={t('company.standingOrdersPlaceholder')}
            value={standingOrders}
            onChange={(e) => setStandingOrders(e.target.value)}
          />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button size="md" variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button size="md" variant={canSave ? 'primary' : 'secondary'} disabled={!canSave} onClick={save}>
          {company ? t('company.save') : t('company.make')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
