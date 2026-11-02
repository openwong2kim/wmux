// Project config dialog (X5 wmux.json) — the single surface for reviewing,
// trusting, and using a discovered project file. Two modes by trust state:
//
//   untrusted / stale / denied — REVIEW mode: every shell command the file
//     can run is shown VERBATIM (the security contract: the user approves
//     exactly what they read; the grant binds to the displayed bytes' hash,
//     so an edit after approval demotes back to review).
//   trusted — ACTIONS mode: run custom commands, apply the layout, revoke.
//
// Built on ui/Dialog like PermissionApprovalDialog: grouped rows, a notice for
// the trust state, and Trust as the footer's one primary.

import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { companyNeedsReview, countLayoutLeaves, prepAwaitsReview, PROJECT_SUPERVISION_DEFAULT_BURST } from '../../../shared/wmuxProjectConfig';
import type { WmuxProjectLayoutNode } from '../../../shared/wmuxProjectConfig';
import { applyProjectLayoutFresh, decideProjectTrust, probeProjectConfig } from '../../utils/projectConfigProbe';
import { runProjectCommand } from '../../utils/projectCommands';
import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import { IconWarning } from '../icons';

interface LayoutRow {
  label: string;
  index: number;
  /** X8 — effective supervision policy for this leaf, when supervised. The
   * approval screen surfaces it so the user sees the autonomous behavior they
   * are about to trust (auto-restart). */
  supervision?: { restart: 'on-failure' | 'always'; burst: number };
  /** U-PERM — this leaf declared `unattended` (restorePermissionMode), so it
   * would restore its captured permission mode on reboot IF the user gives the
   * separate unattended consent below. */
  unattended?: boolean;
  /** D2 — the orchestrator role this leaf declares. Surfaced because a bound
   * role REWRITES the command shown beside it (the operator's own Settings
   * binding supplies the model/args), so approving the command verbatim is not
   * quite approving what runs. */
  role?: string;
}

/** Layout startup commands with their pane position, depth-first. */
export function layoutRows(node: WmuxProjectLayoutNode, acc: LayoutRow[] = []): LayoutRow[] {
  const walk = (n: WmuxProjectLayoutNode): void => {
    if (n.type === 'leaf') {
      const index = acc.length + 1;
      if (n.url !== undefined) {
        acc.push({ label: `→ ${n.url}`, index });
      } else {
        const row: LayoutRow = { label: n.command ?? '(shell)', index };
        if (n.restart !== undefined) {
          // Effective burst = leaf override or the SSOT default (the funnel
          // applies the same fallback).
          row.supervision = { restart: n.restart, burst: n.restartLimit?.burst ?? PROJECT_SUPERVISION_DEFAULT_BURST };
        }
        if (n.restorePermissionMode === true) row.unattended = true;
        if (n.role !== undefined) row.role = n.role;
        acc.push(row);
      }
      return;
    }
    n.children.forEach(walk);
  };
  walk(node);
  return acc;
}

export default function ProjectConfigDialog() {
  const t = useT();
  const wsId = useStore((s) => s.projectDialogWsId);
  const setWsId = useStore((s) => s.setProjectDialogWsId);
  const project = useStore((s) => (wsId ? s.projectConfigs[wsId] : undefined));
  // U-PERM: unattended reboot-survival consent — a SEPARATE opt-in from base
  // trust. Defaults UNCHECKED on every open (incl. re-trust of new/stale bytes)
  // so consent is re-affirmed for exactly the bytes shown, never carried forward.
  const [unattendedConsent, setUnattendedConsent] = useState(false);

  // Re-probe on open so the dialog reflects the LIVE file — a wmux.json
  // edited since the last probe shows as 'stale' here, not as still-trusted.
  useEffect(() => {
    if (wsId) void probeProjectConfig(wsId);
    setUnattendedConsent(false);
  }, [wsId]);

  if (!wsId || !project || !project.found) return null;

  const close = () => setWsId(null);
  const trust = project.trust;
  const isTrusted = trust === 'trusted';
  const commands = project.config?.commands ?? [];
  // New workspace setup: runs (and copies secrets) on the same grant, so the
  // review lists it verbatim beside the commands and the layout.
  const prepSetup = project.config?.fanout?.setup;
  const prepCopy = project.config?.fanout?.copy ?? [];
  const prepCopyAutomated = project.config?.fanout?.copyIntoAutomated === true;
  // Trusted by a decision that never showed the setup command or the copy
  // settings: they wait for this one re-approval (the rest stays approved).
  const prepNeedsReview = prepAwaitsReview(project);
  const layout = project.config?.layout;
  const rows = layout ? layoutRows(layout) : [];
  // Leaves that would restore their captured permission mode on reboot — the
  // subject of the separate unattended consent below (review mode only).
  const unattendedRows = rows.filter((r) => r.unattended);
  // The folder's company starts from the + menu, never from this dialog.
  const company = project.config?.company;

  const notice = project.invalid
    ? t('project.invalid')
    : trust === 'stale'
      ? t('project.staleNotice')
      : trust === 'denied'
        ? t('project.deniedNotice')
        : trust === 'untrusted'
          ? t('project.untrustedNotice')
          : null;

  const noticeColor = trust === 'denied' ? 'var(--text-sub)' : 'var(--accent-yellow)';

  return (
    <Dialog onClose={close} closeOnBackdrop width={560} data-testid="project-config-dialog">
      <DialogHeader
        title={t('project.dialogTitle')}
        description={
          <>
            {t('project.file')}: <span className="ui-code">{project.configPath}</span>
          </>
        }
        closeLabel={t('project.close')}
      />
      <DialogBody>
        {prepNeedsReview && (
          <div className="ui-notice flex items-start gap-2.5 px-3.5 py-3 text-[13px] leading-5" data-testid="project-prep-review-needed">
            <span className="shrink-0 pt-[3px]" style={{ color: 'var(--accent-yellow)' }} aria-hidden="true">
              <IconWarning size={14} />
            </span>
            <span className="text-[var(--text-main)]">{t('project.prepReviewNotice')}</span>
          </div>
        )}

        {notice && (
          <div className="ui-notice flex items-start gap-2.5 px-3.5 py-3 text-[13px] leading-5">
            <span className="shrink-0 pt-[3px]" style={{ color: noticeColor }} aria-hidden="true">
              <IconWarning size={14} />
            </span>
            <span className="text-[var(--text-main)]">{notice}</span>
          </div>
        )}

        {commands.length > 0 && (
          <section>
            <p className="ui-group-label">{t('project.commandsHeading')}</p>
            <div className="ui-group">
              {commands.map((cmd) => (
                <div key={cmd.id} className="ui-row">
                  <div className="ui-row-text">
                    <p className="ui-row-title">{cmd.title}</p>
                    <p className="ui-row-detail font-mono break-all">{cmd.command}</p>
                  </div>
                  {isTrusted && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="shrink-0"
                      onClick={() => { void runProjectCommand(wsId, cmd.id); close(); }}
                    >
                      {t('project.run')}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {layout && (
          <section>
            <div className="flex items-center gap-2 mb-2">
              <p className="ui-group-label flex-1 !mb-0">{t('project.layoutHeading', { count: countLayoutLeaves(layout) })}</p>
              {isTrusted && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="shrink-0"
                  onClick={() => { void applyProjectLayoutFresh(wsId); close(); }}
                >
                  {t('project.applyLayout')}
                </Button>
              )}
            </div>
            <div className="ui-group">
              {rows.map((row) => (
                <div key={row.index} className="ui-row">
                  <span className="w-12 shrink-0 text-[13px] text-[var(--text-sub)]">
                    {t('project.pane')} {row.index}
                  </span>
                  <div className="ui-row-text">
                    <p className="ui-row-title font-mono !text-[12px] break-all">{row.label}</p>
                    {row.role && <p className="ui-row-detail">{t('project.roleBadge', { role: row.role })}</p>}
                    {row.supervision && (
                      <p className="ui-row-detail" style={{ color: 'var(--accent-yellow)' }}>
                        {t('project.supervisionBadge', { restart: row.supervision.restart, burst: row.supervision.burst })}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {(prepSetup !== undefined || prepCopy.length > 0) && (
          <section data-testid="project-prep-review">
            <div className="flex items-center gap-2 mb-2">
              <p className="ui-group-label flex-1 !mb-0">{t('project.prepHeading')}</p>
              {isTrusted && project.prepReviewed === true && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="shrink-0"
                  onClick={() => { close(); useStore.getState().setPrepDialogWsId(wsId); }}
                >
                  {t('project.editPrep')}
                </Button>
              )}
            </div>
            <div className="ui-group">
              {prepSetup !== undefined && (
                <div className="ui-row">
                  <div className="ui-row-text">
                    <p className="ui-row-title font-mono !text-[12px] break-all">{prepSetup}</p>
                    <p className="ui-row-detail">{t('project.prepSetup')}</p>
                  </div>
                </div>
              )}
              {prepCopy.length > 0 && (
                <div className="ui-row">
                  <div className="ui-row-text">
                    <p className="ui-row-title font-mono !text-[12px] break-all">{prepCopy.join(', ')}</p>
                    <p className="ui-row-detail">
                      {t('project.prepCopy')} · {t(prepCopyAutomated ? 'project.prepCopyAutomated' : 'project.prepCopyHumanOnly')}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {(company || project.config?.companyInvalid) && (
          <section data-testid="project-company">
            <p className="ui-group-label">{t('companyFile.projectHeading')}</p>
            <div className="ui-group">
              <div className="ui-row">
                {company ? (
                  <>
                    <div className="ui-row-text">
                      <p className="ui-row-title break-words">{company.name}</p>
                      <p className="ui-row-detail">
                        {t(companyNeedsReview(project) ? 'companyFile.projectNotReviewed' : 'companyFile.projectReviewed')}
                      </p>
                    </div>
                    <span className="shrink-0 text-[12px] text-[var(--text-muted)]">
                      {company.seats.length === 1 ? t('companyFile.seatsOne') : t('companyFile.seats', { count: company.seats.length })}
                    </span>
                  </>
                ) : (
                  <div className="ui-row-text">
                    <p className="ui-row-title">{t('companyFile.projectInvalid')}</p>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {!isTrusted && !project.invalid && unattendedRows.length > 0 && (
          <section className="ui-notice flex flex-col gap-2 px-3.5 py-3 text-[13px]">
            <p className="m-0 flex items-center gap-2 font-medium" style={{ color: 'var(--accent-yellow)' }}>
              <IconWarning size={14} />
              {t('project.unattendedHeading')}
            </p>
            <ul className="m-0 p-0 list-none flex flex-col gap-0.5">
              {unattendedRows.map((row) => (
                <li key={row.index} className="break-all text-[var(--text-sub)]">
                  {t('project.pane')} {row.index}: <span className="font-mono text-[12px] text-[var(--text-main)]">{row.label}</span>
                </li>
              ))}
            </ul>
            <label className="flex items-start gap-2 cursor-pointer text-[var(--text-sub)]">
              <Checkbox
                checked={unattendedConsent}
                onCheckedChange={setUnattendedConsent}
                className="mt-0.5"
                aria-label={t('project.unattendedHeading')}
              />
              <span>{t('project.unattendedConsent', { count: unattendedRows.length })}</span>
            </label>
          </section>
        )}
      </DialogBody>

      <DialogFooter>
        {isTrusted ? (
          <>
            <Button
              size="md"
              variant="secondary"
              onClick={() => { void decideProjectTrust(wsId, 'clear'); close(); }}
            >
              {t('project.revoke')}
            </Button>
            <Button size="md" variant="secondary" onClick={close}>
              {t('project.close')}
            </Button>
            {prepNeedsReview && (
              <Button
                size="md"
                variant="primary"
                // Same bytes, same unattended consent: only the setup and copy settings are newly approved.
                // The company is not shown here, so this approval never marks it reviewed.
                onClick={() => { void decideProjectTrust(wsId, 'trusted', project.unattended === true); close(); }}
              >
                {t('project.approvePrep')}
              </Button>
            )}
          </>
        ) : (
          <>
            {trust !== 'denied' && (
              <Button
                size="md"
                variant="secondary"
                onClick={() => { void decideProjectTrust(wsId, 'denied'); close(); }}
              >
                {t('project.deny')}
              </Button>
            )}
            <Button size="md" variant="secondary" onClick={close}>
              {t('project.notNow')}
            </Button>
            {!project.invalid && (
              <Button
                size="md"
                variant="primary"
                onClick={() => { void decideProjectTrust(wsId, 'trusted', unattendedConsent); close(); }}
              >
                {t('project.trust')}
              </Button>
            )}
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
