// The review of a folder's company before it first starts on this PC (DESIGN.md
// "This folder's company"): each seat with the agent wmux starts for it and
// where it works, the mission and standing orders verbatim, and, while the file
// is not trusted, what else approving trusts. It renders the store's copy of
// the file, so what it shows is what the grant binds.

import { useEffect, useRef, useState } from 'react';
import { agentLauncherStem, agentRow, agentSlugToDisplay, type AgentSlug } from '../../../shared/agentIdentity';
import { ownWorktreeSeats } from '../../../shared/companyPreset';
import { companyNeedsReview, prepAwaitsReview } from '../../../shared/wmuxProjectConfig';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { renderSentence } from '../../i18n/renderSentence';
import { displayPath } from '../../utils/displayPath';
import { companyFileFolder, makeCompany } from '../../utils/makeCompany';
import { decideProjectTrust } from '../../utils/projectConfigProbe';
import { layoutRows } from '../Project/ProjectConfigDialog';
import { useAgentChoices } from './CompanyPresetDialog';
import Button from '../ui/Button';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import { IconWarning } from '../icons';

function GroupLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <p className="ui-group-label flex-1 !mb-0">{label}</p>
      {hint && <span className="text-[11px] text-[var(--text-muted)]">{hint}</span>}
    </div>
  );
}

function Quote({ text }: { text: string }) {
  return (
    <p className="m-0 whitespace-pre-wrap break-words border-l-2 border-[var(--line)] py-0.5 pl-2.5 text-[13px] text-[var(--text-sub)]">
      {text}
    </p>
  );
}

export default function CompanyFileReviewDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useT();
  const state = useStore((s) => s.projectConfigs[workspaceId]);
  const agents = useAgentChoices();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // A company made after the dialog was closed is one the user backed out of.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => { open.current = false; };
  }, []);

  const company = state?.config?.company;
  // The file no longer holds a company: there is nothing to review.
  useEffect(() => {
    if (!company && !busy) onClose();
  }, [company, busy, onClose]);
  if (!state?.configPath || !company) return null;

  const configPath = state.configPath;
  const close = () => { if (!busy) onClose(); };
  const worktreeSeats = new Set(ownWorktreeSeats(company.seats, company.ceo));
  const installed = (agent: AgentSlug) => agents.some((a) => a.agent === agent && a.installed);
  // Named as the New company dialog names it.
  const agentName = (agent: AgentSlug) => agents.find((a) => a.agent === agent)?.label ?? agentSlugToDisplay(agent);
  const missing = [...new Set(company.seats.flatMap((s) => (s.agent && !installed(s.agent) ? [s.agent] : [])))];

  const commands = state.config?.commands ?? [];
  const rows = state.config?.layout ? layoutRows(state.config.layout) : [];
  const setup = state.config?.fanout?.setup;
  const copy = state.config?.fanout?.copy ?? [];
  const copyAutomated = state.config?.fanout?.copyIntoAutomated === true;
  // Approving also approves these: shown unless the grant on these bytes
  // already covers them (a grant without the setup review does not).
  const alsoInFile = (state.trust !== 'trusted' || prepAwaitsReview(state))
    && (commands.length > 0 || rows.length > 0 || setup !== undefined || copy.length > 0);

  const approve = async () => {
    if (busy || missing.length > 0) return;
    const shownHash = state.contentHash;
    // A re-approval of trusted bytes keeps their unattended consent.
    const unattendedCarry = state.trust === 'trusted' && state.unattended === true;
    // The grant binds to the store's bytes as decideProjectTrust reads them,
    // in this same turn: they must be the ones on screen.
    if (useStore.getState().projectConfigs[workspaceId]?.contentHash !== shownHash) {
      setNote(t('companyFile.changed'));
      return;
    }
    setBusy(true);
    setNote(null);
    const decided = await decideProjectTrust(workspaceId, 'trusted', unattendedCarry, true);
    if (!open.current) return;
    if (!decided) {
      setBusy(false);
      return;
    }
    const fresh = useStore.getState().projectConfigs[workspaceId];
    const made = fresh?.config?.company;
    if (!fresh?.configPath || !made || companyNeedsReview(fresh) || fresh.contentHash !== shownHash) {
      setBusy(false);
      setNote(t('companyFile.changed'));
      return;
    }
    const res = await makeCompany(
      {
        name: made.name,
        folder: companyFileFolder(fresh.configPath),
        mission: made.mission ?? '',
        standingOrders: made.standingOrders ?? '',
        ceo: made.ceo,
        tellSeats: true,
        seats: made.seats,
      },
      () => open.current,
    );
    if (!res) return;
    setBusy(false);
    if (!res.ok) {
      setNote(t('companyPreset.failed', { error: res.error }));
      return;
    }
    onClose();
  };

  const deny = () => {
    void decideProjectTrust(workspaceId, 'denied');
    onClose();
  };

  const blocked = missing.length > 0;

  return (
    <Dialog onClose={close} closeOnBackdrop width={720} zIndexClassName="z-[var(--z-modal-top)]" data-testid="company-file-review-dialog">
      <DialogHeader
        title={t('companyFile.reviewTitle', { name: company.name })}
        description={renderSentence(t('companyFile.reviewFrom'), { path: <span className="ui-code">{displayPath(configPath)}</span> })}
        closeLabel={t('company.close')}
      />
      <DialogBody>
        <div className="ui-notice flex items-start gap-2.5 px-3.5 py-3 text-[13px] leading-5" data-company-review-notice>
          <span className="shrink-0 pt-[3px]" style={{ color: 'var(--accent-yellow)' }} aria-hidden="true">
            <IconWarning size={14} />
          </span>
          <span className="flex flex-col gap-1 text-[var(--text-main)]">
            <span>{t('companyFile.reviewNotice')}</span>
            {state.trust === 'denied' && <span>{t('companyFile.reviewDenied')}</span>}
            {state.trust === 'stale' && <span>{t('companyFile.reviewStale')}</span>}
          </span>
        </div>

        <section>
          <GroupLabel label={t('companyFile.reviewSeats', { count: company.seats.length })} hint={t('companyFile.reviewSeatsHint')} />
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] text-[var(--text-muted)]">
                <th className="py-1 pr-2 font-normal">{t('companyPreset.seat')}</th>
                <th className="py-1 pr-2 font-normal">{t('companyPreset.owns')}</th>
                <th className="py-1 pr-2 font-normal">{t('companyPreset.agent')}</th>
                <th className="py-1 pr-2 font-normal">{t('companyFile.starts')}</th>
                <th className="py-1 font-normal">{t('companyFile.worksIn')}</th>
              </tr>
            </thead>
            <tbody>
              {company.seats.map((seat, i) => {
                const row = agentRow(seat.agent);
                return (
                  <tr key={i} className="border-t border-[var(--stroke)] text-[var(--text-main)]" data-review-seat={i}>
                    <td className="py-1.5 pr-2 break-all">
                      <span className="font-semibold">{seat.label}</span>
                      {i === company.ceo && <span className="ml-1.5 text-[11px] text-[var(--text-muted)]">{t('company.ceo')}</span>}
                    </td>
                    <td className="py-1.5 pr-2 break-words">{seat.owns}</td>
                    <td className="py-1.5 pr-2">{seat.agent ? agentName(seat.agent) : t('companyPreset.noAgent')}</td>
                    <td className="py-1.5 pr-2">{row ? <span className="ui-code">{agentLauncherStem(row)}</span> : t('companyFile.plainShell')}</td>
                    <td className="py-1.5 text-[var(--text-sub)]">{worktreeSeats.has(i) ? t('companyFile.ownWorktree') : t('companyFile.thisFolder')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {missing.map((agent) => (
            <p key={agent} className="ui-note mt-2" data-company-review-install>
              {t('companyFile.install', { agent: agentName(agent) })}
            </p>
          ))}
        </section>

        {company.mission && (
          <section data-company-review-mission>
            <GroupLabel label={t('company.mission')} />
            <Quote text={company.mission} />
          </section>
        )}

        {company.standingOrders && (
          <section data-company-review-orders>
            <GroupLabel label={t('company.standingOrders')} />
            <Quote text={company.standingOrders} />
          </section>
        )}

        {alsoInFile && (
          <section data-company-review-also>
            <GroupLabel label={t('companyFile.alsoInFile')} hint={t('companyFile.alsoInFileHint')} />
            <div className="ui-group">
              {commands.map((cmd) => (
                <div key={cmd.id} className="ui-row">
                  <div className="ui-row-text">
                    <p className="ui-row-title">{cmd.title}</p>
                    <p className="ui-row-detail font-mono break-all">{cmd.command}</p>
                  </div>
                </div>
              ))}
              {rows.map((row) => (
                <div key={`pane-${row.index}`} className="ui-row">
                  <div className="ui-row-text">
                    <p className="ui-row-title font-mono !text-[12px] break-all">{row.label}</p>
                    <p className="ui-row-detail">{t('project.pane')} {row.index}</p>
                    {row.role && <p className="ui-row-detail">{t('project.roleBadge', { role: row.role })}</p>}
                    {row.supervision && (
                      <p className="ui-row-detail">
                        {t('project.supervisionBadge', { restart: row.supervision.restart, burst: row.supervision.burst })}
                      </p>
                    )}
                  </div>
                </div>
              ))}
              {setup !== undefined && (
                <div className="ui-row">
                  <div className="ui-row-text">
                    <p className="ui-row-title font-mono !text-[12px] break-all">{setup}</p>
                    <p className="ui-row-detail">{t('project.prepSetup')}</p>
                  </div>
                </div>
              )}
              {copy.length > 0 && (
                <div className="ui-row">
                  <div className="ui-row-text">
                    <p className="ui-row-title font-mono !text-[12px] break-all">{copy.join(', ')}</p>
                    <p className="ui-row-detail">
                      {t('project.prepCopy')} · {t(copyAutomated ? 'project.prepCopyAutomated' : 'project.prepCopyHumanOnly')}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {note && <p className="ui-note" data-company-review-note>{note}</p>}
      </DialogBody>
      <DialogFooter>
        {state.trust !== 'denied' && (
          <Button size="md" variant="secondary" className="mr-auto" disabled={busy} onClick={deny}>
            {t('project.deny')}
          </Button>
        )}
        <Button size="md" variant="secondary" disabled={busy} onClick={close}>{t('project.notNow')}</Button>
        <Button size="md" variant={blocked ? 'secondary' : 'primary'} disabled={blocked || busy} onClick={() => void approve()} data-company-review-approve>
          {t('companyFile.approve')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
