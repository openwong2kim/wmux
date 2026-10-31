import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { generateId } from '../../../shared/types';
import { agentSlugToDisplay, isAgentSlug, type AgentSlug } from '../../../shared/agentIdentity';
import { companySeatsError, ownWorktreeSeats, type CompanyPreset, type CompanyPresetSeat } from '../../../shared/companyPreset';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { displayPath } from '../../utils/displayPath';
import { showWorkspaces } from '../../utils/showWorkspaces';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import Checkbox from '../ui/Checkbox';
import Field from '../ui/Field';
import TextArea from '../ui/TextArea';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import { FOCUS_RING } from '../focusRing';

interface AgentChoice { agent: AgentSlug; label: string; installed: boolean }

/** The agents a seat may start: what the factory finds installed here, else
 *  Claude Code and Codex as they are. */
function useAgentChoices(): AgentChoice[] {
  const [choices, setChoices] = useState<AgentChoice[]>([
    { agent: 'claude', label: 'Claude Code', installed: true },
    { agent: 'codex', label: 'Codex', installed: true },
  ]);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.factory?.workerAgents?.()
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return;
        const known = list.flatMap((o) => (isAgentSlug(o.agent) ? [{ agent: o.agent, label: o.label, installed: o.installed }] : []));
        if (known.length > 0) setChoices(known);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return choices;
}

/**
 * New company from a preset (DESIGN.md "Company presets"): a workspace with a
 * pane per seat, each named, given what it owns and started with its agent,
 * the CEO seat set, and each agent told its seat on its first turn. Opened
 * from the + menu.
 */
export default function CompanyPresetDialog({ preset, onClose }: { preset: CompanyPreset; onClose: () => void }) {
  const t = useT();
  const addCompanyWorkspace = useStore((s) => s.addCompanyWorkspace);
  const agents = useAgentChoices();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [mission, setMission] = useState('');
  const [standingOrders, setStandingOrders] = useState(preset.standingOrders);
  const [seats, setSeats] = useState<CompanyPresetSeat[]>(() => preset.seats.map((s) => ({ ...s })));
  const [ceo, setCeo] = useState(preset.ceo);
  const [tellSeats, setTellSeats] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const seatsLabelId = useId();
  // A company made after the dialog was closed is one the user backed out of.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => { open.current = false; };
  }, []);

  const trimmed = useMemo(() => seats.map((s) => ({ ...s, label: s.label.trim(), owns: s.owns.trim() })), [seats]);
  const installed = (agent: AgentSlug) => agents.some((a) => a.agent === agent && a.installed);
  const seatsError = companySeatsError(trimmed, ceo)
    ?? (trimmed.some((s) => s.agent && !installed(s.agent)) ? 'agent' : null)
    ?? (!folder && ownWorktreeSeats(trimmed, ceo).length > 1 ? 'folder' : null);
  const folderName = folder?.split(/[/\\]/).filter(Boolean).pop();
  const companyName = name.trim() || folderName || t('companyPreset.defaultName');

  const editSeat = (i: number, patch: Partial<CompanyPresetSeat>) =>
    setSeats((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  // Main makes the worktrees and briefs before the workspace exists, so the
  // dialog stays until Make has finished.
  const close = () => { if (!busy) onClose(); };

  const pickFolder = async () => {
    const picked = await window.electronAPI?.dialog?.pickFolder?.();
    if (picked && picked.length > 0) setFolder(picked[0]);
  };

  const make = async () => {
    if (seatsError || busy) return;
    setBusy(true);
    setFailed(null);
    const id = generateId('ws');
    // Main settles each seat's pane name (it holds every label) and writes the
    // briefs with those names.
    const res = await window.electronAPI?.company?.seatLaunches?.({
      workspaceId: id,
      company: companyName,
      mission,
      standingOrders,
      ceo,
      tellSeats,
      ...(folder ? { folder } : {}),
      seats: trimmed.map((s) => ({ label: s.label, owns: s.owns, ...(s.agent ? { agent: s.agent } : {}) })),
    }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    if (!open.current) return;
    if (!res?.ok) {
      setBusy(false);
      setFailed(res?.error ?? 'unavailable');
      return;
    }
    const ok = addCompanyWorkspace({
      id,
      name: companyName,
      ...(folder ? { cwd: folder } : {}),
      mission,
      standingOrders,
      ceo,
      seats: trimmed.map((s, i) => {
        const cwd = res.cwds[i];
        return { label: res.labels[i], owns: s.owns, command: res.commands[i] ?? null, ...(cwd ? { cwd } : {}) };
      }),
    });
    setBusy(false);
    if (!ok) {
      setFailed('invalid');
      return;
    }
    showWorkspaces(useStore.getState());
    onClose();
  };

  return (
    <Dialog onClose={close} closeOnBackdrop width={600} initialFocusRef={nameRef} zIndexClassName="z-[var(--z-modal-top)]" data-testid="company-preset-dialog">
      <DialogHeader
        title={t('companyPreset.title', { preset: t(`companyPreset.${preset.id}.name`) })}
        description={t('companyPreset.description')}
        closeLabel={t('company.close')}
      />
      <DialogBody>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('companyPreset.name')} layout="stacked">
            <Input ref={nameRef} className="w-full" placeholder={folderName || t('companyPreset.defaultName')} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('companyPreset.folder')} layout="stacked">
            <Button size="md" variant="secondary" className="w-full justify-start truncate" onClick={() => void pickFolder()} data-preset-folder>
              {folder ? displayPath(folder) : t('companyPreset.chooseFolder')}
            </Button>
          </Field>
        </div>

        <Field label={<>{t('company.mission')} <span className="font-normal text-[var(--text-muted)]">{t('company.optional')}</span></>} layout="stacked">
          <Input className="w-full" placeholder={t('company.missionPlaceholder')} value={mission} onChange={(e) => setMission(e.target.value)} />
        </Field>

        <Field label={t('company.standingOrders')} layout="stacked">
          <TextArea rows={2} className="w-full" value={standingOrders} onChange={(e) => setStandingOrders(e.target.value)} />
        </Field>

        <div className="ui-field" data-layout="stacked">
          <div className="ui-field-text">
            <span className="ui-field-label" id={seatsLabelId}>{t('companyPreset.seats')}</span>
            <span className="ui-field-description">{t('companyPreset.seatsHint')}</span>
          </div>
          <table className="w-full text-[13px]" aria-labelledby={seatsLabelId}>
            <thead>
              <tr className="text-left text-[11px] text-[var(--text-muted)]">
                <th className="py-1 pr-2 font-normal">{t('company.ceo')}</th>
                <th className="py-1 pr-2 font-normal">{t('companyPreset.seat')}</th>
                <th className="py-1 pr-2 font-normal">{t('companyPreset.owns')}</th>
                <th className="py-1 font-normal">{t('companyPreset.agent')}</th>
              </tr>
            </thead>
            <tbody>
              {seats.map((seat, i) => (
                <tr key={i} className="border-t border-[var(--stroke)]" data-preset-seat={i}>
                  <td className="py-1.5 pr-2">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={ceo === i}
                      aria-label={t('companyPreset.makeCeo', { seat: seat.label })}
                      className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${FOCUS_RING}`}
                      style={{ borderColor: ceo === i ? 'var(--text-main)' : 'var(--text-sub)' }}
                      onClick={() => setCeo(i)}
                    >
                      {ceo === i && <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-main)]" />}
                    </button>
                  </td>
                  <td className="py-1.5 pr-2"><Input className="w-full" aria-label={t('companyPreset.seat')} value={seat.label} onChange={(e) => editSeat(i, { label: e.target.value })} /></td>
                  <td className="py-1.5 pr-2"><Input className="w-full" aria-label={t('companyPreset.owns')} placeholder={t('companyPreset.ownsPlaceholder')} value={seat.owns} onChange={(e) => editSeat(i, { owns: e.target.value })} /></td>
                  <td className="py-1.5">
                    <Select
                      aria-label={t('companyPreset.agent')}
                      value={seat.agent ?? ''}
                      onChange={(e) => editSeat(i, { agent: isAgentSlug(e.target.value) ? e.target.value : undefined })}
                    >
                      {agents.map((a) => (
                        <option key={a.agent} value={a.agent} disabled={!a.installed}>
                          {a.installed ? a.label : t('companyPreset.notInstalled', { agent: a.label })}
                        </option>
                      ))}
                      {seat.agent && !agents.some((a) => a.agent === seat.agent) && (
                        <option value={seat.agent} disabled>{t('companyPreset.notInstalled', { agent: agentSlugToDisplay(seat.agent) })}</option>
                      )}
                      <option value="">{t('companyPreset.noAgent')}</option>
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {seatsError && <p className="ui-note">{t(`companyPreset.error.${seatsError}`)}</p>}
        </div>

        <Field label={t('companyPreset.tellSeats')} description={t('companyPreset.tellSeatsHint')}>
          <Checkbox checked={tellSeats} onCheckedChange={setTellSeats} />
        </Field>
        {failed && <p className="ui-note">{t('companyPreset.failed', { error: failed })}</p>}
      </DialogBody>
      <DialogFooter>
        <Button size="md" variant="secondary" disabled={busy} onClick={close}>{t('common.cancel')}</Button>
        <Button size="md" variant={seatsError ? 'secondary' : 'primary'} disabled={!!seatsError || busy} onClick={() => void make()}>
          {t('company.make')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
