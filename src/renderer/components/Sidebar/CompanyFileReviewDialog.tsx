// The review of a folder's company before it first starts on this PC (DESIGN.md
// "This folder's company"): each seat with the agent wmux starts for it and
// where it works, the mission and standing orders verbatim, while the file is
// not trusted what else approving trusts, and on request the whole file. It
// renders the store's copy of the file, so what it shows is what the grant
// binds.

import { Fragment, memo, useEffect, useRef, useState } from 'react';
import { agentLauncherStem, agentRow, agentSlugToDisplay, type AgentSlug } from '../../../shared/agentIdentity';
import { splitHiddenCharacters } from '../../../shared/companyFile';
import { ownWorktreeSeats } from '../../../shared/companyPreset';
import { companyNeedsReview, prepAwaitsReview, type ProjectConfigText } from '../../../shared/wmuxProjectConfig';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { renderSentence } from '../../i18n/renderSentence';
import { displayPath } from '../../utils/displayPath';
import { companyFileFolder, makeCompany } from '../../utils/makeCompany';
import { decideProjectTrust, probeProjectConfig } from '../../utils/projectConfigProbe';
import { layoutRows } from '../Project/ProjectConfigDialog';
import { useAgentChoices } from './CompanyPresetDialog';
import { FOCUS_RING } from '../focusRing';
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

/** Marks drawn as their own element; past them the rest of the file is one
 *  string with its marks inline, so a file dense in them stays a few nodes. */
const MARKS_STYLED_MAX = 2000;

const mark = (c: string) => `⟨U+${c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}⟩`;

/** The file's text as it is, drawn left to right in byte order: each
 *  character a reader would not see, and each run of bytes that is not UTF-8
 *  (U+FFFD), is shown as its code point where it sits and counted above the
 *  text. Memoized: a re-render of the dialog does not split the text again. */
const WholeFile = memo(function WholeFile({ text }: { text: string }) {
  const t = useT();
  const parts = splitHiddenCharacters(text);
  const hidden = (parts.length - 1) / 2;
  // parts alternate text, mark, text…: the styled ones end on a text entry.
  const styled = parts.slice(0, 2 * MARKS_STYLED_MAX + 1);
  const rest = parts.slice(2 * MARKS_STYLED_MAX + 1).map((part, i) => (i % 2 === 0 ? mark(part) : part)).join('');
  return (
    <>
      {hidden > 0 && <p className="ui-note" data-company-review-hidden>{t('companyFile.wholeFileHidden', { count: hidden })}</p>}
      <pre
        dir="ltr"
        className="m-0 mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap break-words border-l-2 border-[var(--line)] py-0.5 pl-2.5 font-mono text-[12px] text-[var(--text-sub)] [unicode-bidi:bidi-override]"
        data-company-review-file
      >
        {styled.map((part, i) => (i % 2 === 0
          ? <Fragment key={i}>{part}</Fragment>
          : <span key={i} className="font-semibold text-[var(--text-main)]" data-hidden-char>{mark(part)}</span>))}
        {rest}
      </pre>
    </>
  );
});

export default function CompanyFileReviewDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useT();
  // What the dialog shows and what Approve grants: the file as it was when the
  // dialog opened. A later read of another file (an edit, a save, the
  // workspace moving to another folder) never replaces it on screen; it turns
  // Approve off until the dialog is opened again.
  const [state] = useState(() => useStore.getState().projectConfigs[workspaceId]);
  const live = useStore((s) => s.projectConfigs[workspaceId]);
  // A read of the whole file that found other bytes counts as a move too.
  const [textMoved, setTextMoved] = useState(false);
  const moved = textMoved || live?.contentHash !== state?.contentHash || live?.configPath !== state?.configPath;
  const [whole, setWhole] = useState<ProjectConfigText | 'reading' | null>(null);
  const showing = whole !== null && whole !== 'reading';
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
    if (busy || missing.length > 0 || moved) return;
    const shownHash = state.contentHash;
    // A re-approval of trusted bytes keeps their unattended consent.
    const unattendedCarry = state.trust === 'trusted' && state.unattended === true;
    // The grant binds to the store's bytes as decideProjectTrust reads them,
    // in this same turn: they must be the ones on screen.
    const now = useStore.getState().projectConfigs[workspaceId];
    if (now?.contentHash !== shownHash || now?.configPath !== configPath) {
      setNote(t('companyFile.changed'));
      return;
    }
    setBusy(true);
    setNote(null);
    // Approving trusts the file's layout too, but this workspace asked for a
    // company, not for its pane to be replaced: the layout stays a manual apply.
    useStore.getState().markProjectLayoutAutoApplied(workspaceId);
    const decided = await decideProjectTrust(workspaceId, 'trusted', unattendedCarry, true);
    if (!open.current) return;
    if (!decided) {
      setBusy(false);
      return;
    }
    // Decided on the file as main reads it now, never on a copy.
    const fresh = await probeProjectConfig(workspaceId);
    if (!open.current) return;
    const made = fresh?.config?.company;
    if (!fresh?.configPath || !made || companyNeedsReview(fresh) || fresh.contentHash !== shownHash || fresh.configPath !== configPath) {
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

  // The whole file is read on request and shown only when it is the one on screen.
  const toggleWhole = async () => {
    if (showing) {
      setWhole(null);
      return;
    }
    setWhole('reading');
    const read = await (window.electronAPI?.projectConfig?.text(companyFileFolder(configPath)) ?? Promise.resolve(null)).catch(() => null);
    if (!open.current) return;
    if (!read || read.contentHash !== state.contentHash || read.configPath !== configPath) {
      setWhole(null);
      setTextMoved(true);
      void probeProjectConfig(workspaceId);
      return;
    }
    setWhole(read);
  };

  const deny = () => {
    void decideProjectTrust(workspaceId, 'denied');
    onClose();
  };

  const blocked = missing.length > 0 || moved;

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
            {moved && <span className="font-semibold" data-company-review-moved>{t('companyFile.changedWhileOpen')}</span>}
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
            <GroupLabel label={t('companyFile.alsoInFile')} hint={t(rows.length > 0 ? 'companyFile.alsoInFileHintLayout' : 'companyFile.alsoInFileHint')} />
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

        <section data-company-review-whole>
          <div className="flex items-baseline gap-2">
            <button
              type="button"
              className={`rounded-sm text-[12px] text-[var(--text-sub)] underline decoration-[var(--line)] underline-offset-[3px] enabled:hover:text-[var(--text-main)] disabled:cursor-default disabled:opacity-50 ${FOCUS_RING}`}
              disabled={whole === 'reading' || (moved && !showing)}
              aria-expanded={showing}
              onClick={() => void toggleWhole()}
              data-company-review-whole-toggle
            >
              {t(showing ? 'companyFile.hideWholeFile' : 'companyFile.showWholeFile')}
            </button>
            <span className="text-[11px] text-[var(--text-muted)]">{t('companyFile.wholeFileHint')}</span>
          </div>
          {showing && <WholeFile text={whole.text} />}
        </section>

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
