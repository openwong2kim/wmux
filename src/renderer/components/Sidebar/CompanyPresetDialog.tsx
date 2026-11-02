import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { agentSlugToDisplay, isAgentSlug, type AgentSlug } from '../../../shared/agentIdentity';
import { companySeatsError, ownWorktreeSeats, type CompanyPreset, type CompanyPresetSeat } from '../../../shared/companyPreset';
import {
  companyFileJson,
  normalizeCompanyFile,
  type CompanyFileSaveBlock,
  type CompanyFileView,
  type WmuxProjectCompany,
} from '../../../shared/companyFile';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { displayPath } from '../../utils/displayPath';
import { makeCompany } from '../../utils/makeCompany';
import { companyNeedsReview } from '../../../shared/wmuxProjectConfig';
import { probeProjectConfig } from '../../utils/projectConfigProbe';
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
export function useAgentChoices(): AgentChoice[] {
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

type CompanyPresetDialogProps = { onClose: () => void } & (
  | { preset: CompanyPreset; fromFile?: undefined }
  /** The folder's company from its wmux.json; `folder` holds that file. */
  | { preset?: undefined; fromFile: { company: WmuxProjectCompany; folder: string } }
);

/**
 * New company from a preset (DESIGN.md "Company presets"): a workspace with a
 * pane per seat, each named, given what it owns and started with its agent,
 * the CEO seat set, and each agent told its seat on its first turn. Opened
 * from the + menu, from a preset or from the folder's company in its
 * wmux.json, which the dialog can also save there.
 */
export default function CompanyPresetDialog({ preset, fromFile, onClose }: CompanyPresetDialogProps) {
  const t = useT();
  const agents = useAgentChoices();
  const file = fromFile?.company;
  const [name, setName] = useState(file?.name ?? '');
  const [folder, setFolder] = useState<string | null>(fromFile?.folder ?? null);
  const [mission, setMission] = useState(file?.mission ?? '');
  const [standingOrders, setStandingOrders] = useState((file ? file.standingOrders : preset?.standingOrders) ?? '');
  const [seats, setSeats] = useState<CompanyPresetSeat[]>(() => (file?.seats ?? preset?.seats ?? []).map((s) => ({ ...s })));
  const [ceo, setCeo] = useState(file?.ceo ?? preset?.ceo ?? 0);
  const [tellSeats, setTellSeats] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Save as this folder's company: the file as read for the confirm, and the
  // line the last read or save left.
  const [confirm, setConfirm] = useState<{ view: CompanyFileView; folder: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const seatsLabelId = useId();
  // The confirm opens below the seats, often past the body's fold: bring it
  // into view and onto its first action.
  useEffect(() => {
    if (!confirm) return;
    confirmRef.current?.scrollIntoView?.({ block: 'nearest' });
    confirmRef.current?.querySelector<HTMLButtonElement>('button:last-of-type')?.focus();
  }, [confirm]);
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
  // The company as the folder's wmux.json would hold it; null while it cannot be saved.
  const fileCompany = folder && companySeatsError(trimmed, ceo) === null
    ? normalizeCompanyFile(companyFileJson({ name: companyName, mission, standingOrders, ceo, seats: trimmed }))
    : null;

  const editSeat = (i: number, patch: Partial<CompanyPresetSeat>) =>
    setSeats((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  // Main makes the worktrees and briefs before the workspace exists, so the
  // dialog stays until Make has finished.
  const close = () => { if (!busy) onClose(); };

  const pickFolder = async () => {
    const picked = await window.electronAPI?.dialog?.pickFolder?.();
    if (picked && picked.length > 0) {
      setFolder(picked[0]);
      // A confirm names the folder it read.
      setConfirm(null);
      setSaveNote(null);
    }
  };

  const blockedText = (reason: CompanyFileSaveBlock, dir: string) =>
    t(`companyFile.blocked.${reason}`, { dir: displayPath(dir) });

  const askSave = async () => {
    if (!folder || !fileCompany || saving) return;
    setSaving(true);
    setSaveNote(null);
    setConfirm(null);
    try {
      const view = await window.electronAPI.projectConfig.companyGet(folder);
      setConfirm({ view, folder });
    } catch {
      setSaveNote(blockedText('invalid', folder));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!confirm || confirm.view.saveBlocked || !fileCompany || saving) return;
    const dir = confirm.view.dir ?? confirm.folder;
    setSaving(true);
    let note: string;
    try {
      const r = await window.electronAPI.projectConfig.companySave(confirm.folder, companyFileJson(fileCompany), confirm.view.contentHash);
      if (r.ok) {
        note = t('companyFile.saved', { dir: displayPath(dir) });
        for (const ws of useStore.getState().workspaces) void probeProjectConfig(ws.id);
      } else if (r.error === 'changed' || r.error === 'invalid-input') {
        note = t(`companyFile.error.${r.error}`);
      } else if (r.error === 'write-failed') {
        note = t('companyFile.error.write-failed', { detail: r.detail ?? 'unknown' });
      } else {
        note = blockedText(r.error, dir);
      }
    } catch (err) {
      note = t('companyFile.error.write-failed', { detail: err instanceof Error ? err.message : String(err) });
    }
    // Saved or not, the confirm is done: another try reads the file again.
    setConfirm(null);
    setSaveNote(note);
    setSaving(false);
  };

  const make = async () => {
    if (seatsError || busy) return;
    setBusy(true);
    setFailed(null);
    // Filled from a folder's wmux.json: made only while that file's company is
    // approved here, as main reads it now.
    if (fromFile) {
      const fresh = await (window.electronAPI?.projectConfig?.get(fromFile.folder) ?? Promise.resolve(null)).catch(() => null);
      if (!open.current) return;
      if (!fresh || companyNeedsReview(fresh) || !fresh.config?.company) {
        setBusy(false);
        setFailed(null);
        setSaveNote(t('companyFile.makeChanged'));
        return;
      }
    }
    const res = await makeCompany(
      { name: companyName, ...(folder ? { folder } : {}), mission, standingOrders, ceo, tellSeats, seats: trimmed },
      () => open.current,
    );
    if (!res) return;
    setBusy(false);
    if (!res.ok) {
      setFailed(res.error);
      return;
    }
    onClose();
  };

  return (
    <Dialog onClose={close} closeOnBackdrop width={600} initialFocusRef={nameRef} zIndexClassName="z-[var(--z-modal-top)]" data-testid="company-preset-dialog">
      <DialogHeader
        title={t('companyPreset.title', { preset: file ? file.name : t(`companyPreset.${preset?.id}.name`) })}
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
        {confirm && (
          <div ref={confirmRef} className="flex flex-col gap-2 rounded-xl border border-[var(--surface-hairline)] px-3.5 py-3 text-[13px]" data-company-file-confirm>
            <p className="m-0 font-semibold text-[var(--text-main)]">
              {t('companyFile.confirmTitle', { dir: displayPath(confirm.view.dir ?? confirm.folder) })}
            </p>
            <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-[12px] text-[var(--text-sub)]">
              <li>{t('companyFile.confirmHolds')}</li>
              <li>{t('companyFile.confirmNever')}</li>
              <li>{t('companyFile.confirmShare')}</li>
              {confirm.view.company && <li>{t('companyFile.confirmReplaces', { name: confirm.view.company.name })}</li>}
            </ul>
            {confirm.view.saveBlocked && (
              <p className="ui-note" data-company-file-blocked>{blockedText(confirm.view.saveBlocked, confirm.view.dir ?? confirm.folder)}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" disabled={saving} onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
              {!confirm.view.saveBlocked && (
                <Button size="sm" variant="secondary" disabled={saving || !fileCompany} onClick={() => void save()}>{t('companyFile.confirmSave')}</Button>
              )}
            </div>
          </div>
        )}
        {saveNote && <p className="ui-note" data-company-file-note>{saveNote}</p>}
        {/* Valid seats and a folder, and still no save: the text is what the file can't keep. */}
        {folder && !fileCompany && companySeatsError(trimmed, ceo) === null && (
          <p className="ui-note" data-company-file-unsavable>{t('companyFile.unsavable')}</p>
        )}
        {failed && <p className="ui-note">{t('companyPreset.failed', { error: failed })}</p>}
      </DialogBody>
      <DialogFooter>
        <button
          type="button"
          className={`mr-auto rounded-sm text-[12px] text-[var(--text-sub)] underline decoration-[var(--line)] underline-offset-[3px] enabled:hover:text-[var(--text-main)] disabled:cursor-default disabled:opacity-50 ${FOCUS_RING}`}
          disabled={!fileCompany || saving || busy}
          onClick={() => void askSave()}
          data-company-file-save
        >
          {t('companyFile.save')}
        </button>
        <Button size="md" variant="secondary" disabled={busy} onClick={close}>{t('common.cancel')}</Button>
        <Button size="md" variant={seatsError ? 'secondary' : 'primary'} disabled={!!seatsError || busy} onClick={() => void make()}>
          {t('company.make')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
