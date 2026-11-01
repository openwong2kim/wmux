import { useEffect, useMemo, useRef, useState } from 'react';
import { isAgentSlug, type AgentSlug } from '../../../shared/agentIdentity';
import { freeSeatLabels } from '../../../shared/companyPreset';
import { normalizePaneLabel, paneLabelShapeError } from '../../../shared/paneLabelRules';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { PANE_METADATA_LABEL_MAX, type PaneLeaf, type Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { MAX_PANES_PER_WORKSPACE } from '../../stores/slices/paneSlice';
import { useT } from '../../hooks/useT';
import { watchHireNotice } from '../../hooks/companyHireNotice';
import { displayPath } from '../../utils/displayPath';
import { paneLabelRejectionKey, paneTag } from '../../utils/paneNaming';
import { showWorkspaces } from '../../utils/showWorkspaces';
import { localPaneName } from '../Remote/a2aLinkModel';
import { useAgentChoices } from '../Sidebar/CompanyPresetDialog';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import UiButton from '../ui/Button';
import Field from '../ui/Field';
import Input from '../ui/Input';
import Select from '../ui/Select';

// ─── "Add a seat on this PC…" ────────────────────────────────────────────────
//
// A seat added to a company that already runs, made the way a preset makes
// one: main gives it its own worktree when the company folder is a
// repository, and its brief as the agent's first prompt (hireSeat); the store
// opens it as a new pane in the company (hireCompanySeat); the CEO pane hears
// of it once its agent is up (watchHireNotice).

/** What main checks owns against (seatLaunch.ts TEXT_MAX.owns). */
const OWNS_MAX = 200;

/** The name a brief addresses a pane by (`#<name>`): its label, else its coordinate. */
function paneAddress(ws: Workspace, leaf: PaneLeaf, paneLabel: Record<string, string>): string {
  const label = (paneLabel[leaf.id] ?? leaf.metadata?.label)?.trim();
  return label && !/\s/.test(label) ? label : paneTag(ws, leaf).slice(1);
}

/** The folder the company works in: the one it was made in, else where its CEO works. */
function companyFolder(ws: Workspace, ceo: PaneLeaf | undefined): string | undefined {
  return ws.profile?.startupCwd || ceo?.surfaces.find((sf) => (sf.surfaceType ?? 'terminal') === 'terminal' && sf.cwd)?.cwd || undefined;
}

export default function HireSeatDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const paneLabel = useStore((s) => s.paneLabel);
  const paneRole = useStore((s) => s.paneRole);
  const surfaceAgent = useStore((s) => s.surfaceAgent);
  const agents = useAgentChoices();
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const company = workspace?.company;
  const leaves = useMemo(() => (workspace ? getWorkspaceLeafPanes(workspace) : []), [workspace]);
  // The CEO's seat while it is a pane of the workspace: the new seat takes briefs from it.
  const ceoLeaf = company?.coordinatorPaneId ? leaves.find((l) => l.id === company.coordinatorPaneId) : undefined;
  const ceoName = workspace && ceoLeaf
    ? localPaneName(workspaces, { kind: 'pane', workspaceId, paneId: ceoLeaf.id }, paneLabel, surfaceAgent).pane
    : '';
  const folder = workspace ? companyFolder(workspace, ceoLeaf) : undefined;
  const staff = useMemo(() => (workspace && ceoLeaf ? leaves.filter((l) => l.id !== ceoLeaf.id).map((l) => ({
    label: paneAddress(workspace, l, paneLabel),
    owns: (paneRole[l.id] ?? '').slice(0, OWNS_MAX),
    agent: l.surfaces.some((sf) => !!sf.ptyId && !!surfaceAgent[sf.ptyId]?.name),
  })) : []), [workspace, ceoLeaf, leaves, paneLabel, paneRole, surfaceAgent]);

  // Whether the folder is a repository, so the seat gets a worktree of it;
  // null while it is read. Main decides again when it makes the seat.
  const [repo, setRepo] = useState<boolean | null>(null);
  useEffect(() => {
    if (!folder) return undefined;
    let cancelled = false;
    setRepo(null);
    const resolve = window.electronAPI?.diff?.resolveRepo;
    if (!resolve) return undefined;
    resolve(folder).then((r) => { if (!cancelled) setRepo(r?.ok === true); }, () => undefined);
    return () => { cancelled = true; };
  }, [folder]);

  const taken = useMemo(() => new Set(Object.values(paneLabel).map(normalizePaneLabel)), [paneLabel]);
  const [typedName, setTypedName] = useState<string | null>(null);
  const name = (typedName ?? freeSeatLabels(['dev'], taken)[0]).trim();
  const nameShape = name ? paneLabelShapeError(name) : null;
  const nameError = nameShape
    ? t(paneLabelRejectionKey(nameShape))
    : typedName !== null && taken.has(normalizePaneLabel(name)) ? t('company.addSeat.nameTaken') : null;
  const [owns, setOwns] = useState('');
  const [agentPick, setAgentPick] = useState<AgentSlug | null>(null);
  const installed = agents.filter((a) => a.installed);
  // The first installed agent, in the order the preset offers them.
  const agent = agentPick ?? installed[0]?.agent;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A seat made after the dialog was closed is one the user backed out of.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => { open.current = false; };
  }, []);

  const stashed = (workspace?.stashedPanes ?? []).length;
  const atCap = leaves.length >= MAX_PANES_PER_WORKSPACE;
  // Outside a repository the seat shares the folder, and two agents in one
  // checkout overwrite each other's changes (main refuses it too).
  const shared = (!folder || repo === false) && staff.some((s) => s.agent);
  const canAdd = !!ceoLeaf && !!name && !nameError && !!agent && owns.length <= OWNS_MAX && !atCap && !shared && !busy;
  const edited = (): void => setError(null);
  const close = (): void => { if (!busy) onClose(); };

  const onAdd = async (): Promise<void> => {
    const hire = window.electronAPI?.company?.hireSeat;
    if (!hire || !canAdd || !workspace || !ceoLeaf || !agent) return;
    setBusy(true);
    setError(null);
    const res = await hire({
      workspaceId,
      company: workspace.name,
      ...(company?.mission ? { mission: company.mission } : {}),
      ...(company?.standingOrders ? { standingOrders: company.standingOrders } : {}),
      ...(folder ? { folder } : {}),
      ceo: { label: paneAddress(workspace, ceoLeaf, paneLabel) },
      staff,
      seat: { label: name, owns: owns.trim(), agent },
    }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    if (!open.current) return;
    setBusy(false);
    if (!res.ok) {
      setError(t('company.hireSeat.failed', { error: res.error }));
      return;
    }
    const paneId = useStore.getState().hireCompanySeat(workspaceId, {
      label: res.label,
      owns,
      command: res.command,
      ...(res.cwd ? { cwd: res.cwd } : {}),
    });
    if (!paneId) {
      setError(t('company.hireSeat.paneFailed'));
      return;
    }
    watchHireNotice({ workspaceId, paneId, label: res.label, owns, ...(res.branch ? { branch: res.branch } : {}) });
    showWorkspaces(useStore.getState());
    onClose();
  };

  const worksIn = !folder
    ? t('company.hireSeat.worksInDefault')
    : repo === true
      ? t('company.hireSeat.worksInWorktree', { folder: displayPath(folder) })
      : repo === false ? t('company.hireSeat.worksInFolder', { folder: displayPath(folder) }) : displayPath(folder);

  return (
    <Dialog onClose={close} width={560} data-testid="hire-seat">
      <DialogHeader
        title={t('company.hireSeat.title')}
        description={ceoLeaf && workspace ? t('company.hireSeat.description', { company: workspace.name, ceo: ceoName }) : undefined}
        closeLabel={t('company.close')}
      />
      <DialogBody className="flex flex-col gap-3">
        {!ceoLeaf ? (
          <p className="wmux-a2a-note" data-testid="hire-seat-no-ceo">{t('company.hireSeat.noCeo')}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('company.addSeat.name')} layout="stacked">
                <Input
                  value={typedName ?? name}
                  maxLength={PANE_METADATA_LABEL_MAX}
                  disabled={busy}
                  spellCheck={false}
                  aria-invalid={!!nameError || !name || undefined}
                  onChange={(e) => { setTypedName(e.target.value); edited(); }}
                  className="w-full"
                  data-testid="hire-seat-name"
                />
              </Field>
              <Field label={t('companyPreset.agent')} layout="stacked">
                <Select
                  value={agent ?? ''}
                  disabled={busy}
                  onChange={(e) => { if (isAgentSlug(e.target.value)) setAgentPick(e.target.value); edited(); }}
                  data-testid="hire-seat-agent"
                >
                  {agents.map((a) => (
                    <option key={a.agent} value={a.agent} disabled={!a.installed}>
                      {a.installed ? a.label : t('companyPreset.notInstalled', { agent: a.label })}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {nameError && <p className="wmux-a2a-note" data-tone="danger" data-testid="hire-seat-name-error">{nameError}</p>}
            <Field label={t('company.addSeat.owns')} description={t('company.addSeat.ownsHint')} layout="stacked">
              <Input
                value={owns}
                maxLength={OWNS_MAX}
                disabled={busy}
                placeholder={t('companyPreset.ownsPlaceholder')}
                onChange={(e) => { setOwns(e.target.value); edited(); }}
                className="w-full"
                data-testid="hire-seat-owns"
              />
            </Field>
            <div className="flex flex-col gap-0.5 text-[12px]" data-testid="hire-seat-works-in">
              <span className="text-[11px] text-[var(--text-muted)]">{t('company.hireSeat.worksIn')}</span>
              <span className="truncate text-[var(--text-sub)]" title={folder}>{worksIn}</span>
            </div>
            {shared && <p className="wmux-a2a-note" data-tone="danger" data-testid="hire-seat-shared">{t('company.hireSeat.shared')}</p>}
            {atCap && (
              <p className="wmux-a2a-note" data-tone="danger" data-testid="hire-seat-cap">
                {stashed > 0
                  ? t('pane.maxLeavesReachedWithStash', { count: MAX_PANES_PER_WORKSPACE, stashed })
                  : t('pane.maxLeavesReached', { count: MAX_PANES_PER_WORKSPACE })}
              </p>
            )}
            {error && <p className="wmux-a2a-note" data-tone="danger" role="alert" data-testid="hire-seat-error">{error}</p>}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <UiButton variant="ghost" size="md" disabled={busy} onClick={close}>{t('a2aLink.cancel')}</UiButton>
        {ceoLeaf && (
          <UiButton variant="primary" size="md" disabled={!canAdd} onClick={() => void onAdd()} data-testid="hire-seat-add">
            {busy ? t('company.hireSeat.adding') : t('company.hireSeat.add')}
          </UiButton>
        )}
      </DialogFooter>
    </Dialog>
  );
}
