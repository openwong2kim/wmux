// Project config dialog (X5 wmux.json) — the single surface for reviewing,
// trusting, and using a discovered project file. Two modes by trust state:
//
//   untrusted / stale / denied — REVIEW mode: every shell command the file
//     can run is shown VERBATIM (the security contract: the user approves
//     exactly what they read; the grant binds to the displayed bytes' hash,
//     so an edit after approval demotes back to review).
//   trusted — ACTIONS mode: run custom commands, apply the layout, revoke.
//
// Visual language mirrors PermissionApprovalDialog (centered modal, accent
// border, right-rail actions).

import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { countLayoutLeaves, PROJECT_SUPERVISION_DEFAULT_BURST } from '../../../shared/wmuxProjectConfig';
import type { WmuxProjectLayoutNode } from '../../../shared/wmuxProjectConfig';
import { applyProjectLayoutFresh, decideProjectTrust, probeProjectConfig } from '../../utils/projectConfigProbe';
import { runProjectCommand } from '../../utils/projectCommands';
import Button from '../ui/Button';

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
function layoutRows(node: WmuxProjectLayoutNode, acc: LayoutRow[] = []): LayoutRow[] {
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
  const layout = project.config?.layout;
  const rows = layout ? layoutRows(layout) : [];
  // Leaves that would restore their captured permission mode on reboot — the
  // subject of the separate unattended consent below (review mode only).
  const unattendedRows = rows.filter((r) => r.unattended);

  const notice = project.invalid
    ? t('project.invalid')
    : trust === 'stale'
      ? t('project.staleNotice')
      : trust === 'denied'
        ? t('project.deniedNotice')
        : trust === 'untrusted'
          ? t('project.untrustedNotice')
          : null;

  const accent = isTrusted ? 'var(--accent-blue)' : trust === 'denied' ? 'var(--text-subtle)' : 'var(--accent-yellow)';

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.65)' }}
      role="dialog"
      aria-labelledby="project-config-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        className="flex flex-col gap-4 p-5 rounded-[7px]"
        style={{
          width: 560,
          maxWidth: '92vw',
          maxHeight: '90vh',
          overflowY: 'auto',
          backgroundColor: 'var(--bg-base)',
          border: `1px solid ${accent}`,
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        <div className="flex items-center gap-2">
          <span style={{ color: accent, fontSize: 16 }}>⛭</span>
          <p id="project-config-title" className="text-sm font-semibold font-mono" style={{ color: 'var(--text-main)' }}>
            {t('project.dialogTitle')}
          </p>
        </div>

        <div className="text-xs font-mono break-all" style={{ color: 'var(--text-sub)' }}>
          <span style={{ color: 'var(--text-subtle)' }}>{t('project.file')}:</span>{' '}
          <span style={{ color: 'var(--text-main)' }}>{project.configPath}</span>
        </div>

        {notice && (
          <div
            className="text-xs p-3 rounded-md"
            style={{
              backgroundColor: 'var(--bg-mantle)',
              color: trust === 'denied' ? 'var(--text-sub2)' : 'var(--accent-yellow)',
            }}
          >
            {notice}
          </div>
        )}

        {commands.length > 0 && (
          <div className="flex flex-col gap-1 p-3 rounded-md" style={{ backgroundColor: 'var(--bg-surface)', borderLeft: `3px solid ${accent}` }}>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-main)' }}>
              {t('project.commandsHeading')}
            </div>
            <ul className="text-[11px] font-mono mt-1 flex flex-col gap-1" style={{ color: 'var(--text-sub2)' }}>
              {commands.map((cmd) => (
                <li key={cmd.id} className="flex items-center gap-2 min-w-0">
                  <span className="flex-1 min-w-0 break-all">
                    <span style={{ color: 'var(--text-main)' }}>{cmd.title}</span>
                    {' — '}
                    <span>{cmd.command}</span>
                  </span>
                  {isTrusted && (
                    <button
                      onClick={() => { void runProjectCommand(wsId, cmd.id); close(); }}
                      className="px-2 py-0.5 rounded text-[10px] font-medium shrink-0"
                      style={{ backgroundColor: 'var(--accent-blue)', color: 'var(--bg-base)' }}
                    >
                      {t('project.run')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {layout && (
          <div className="flex flex-col gap-1 p-3 rounded-md" style={{ backgroundColor: 'var(--bg-surface)', borderLeft: `3px solid ${accent}` }}>
            <div className="text-xs font-semibold flex items-center gap-2" style={{ color: 'var(--text-main)' }}>
              <span className="flex-1">{t('project.layoutHeading', { count: countLayoutLeaves(layout) })}</span>
              {isTrusted && (
                <button
                  onClick={() => { void applyProjectLayoutFresh(wsId); close(); }}
                  className="px-2 py-0.5 rounded text-[10px] font-medium shrink-0"
                  style={{ backgroundColor: 'var(--accent-blue)', color: 'var(--bg-base)' }}
                >
                  {t('project.applyLayout')}
                </button>
              )}
            </div>
            <ul className="text-[11px] font-mono mt-1" style={{ color: 'var(--text-sub2)' }}>
              {rows.map((row) => (
                <li key={row.index} className="break-all">
                  · {t('project.pane')} {row.index}: {row.label}
                  {row.role && (
                    <span className="ml-1" style={{ color: 'var(--text-sub)' }}>
                      {t('project.roleBadge', { role: row.role })}
                    </span>
                  )}
                  {row.supervision && (
                    <span className="ml-1" style={{ color: 'var(--accent-yellow)' }}>
                      {t('project.supervisionBadge', { restart: row.supervision.restart, burst: row.supervision.burst })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!isTrusted && !project.invalid && unattendedRows.length > 0 && (
          <label
            className="flex flex-col gap-2 p-3 rounded-md cursor-pointer"
            style={{ backgroundColor: 'var(--bg-surface)', borderLeft: '3px solid var(--accent-yellow)' }}
          >
            <div className="text-xs font-semibold" style={{ color: 'var(--accent-yellow)' }}>
              {t('project.unattendedHeading')}
            </div>
            <ul className="text-[11px] font-mono flex flex-col gap-0.5" style={{ color: 'var(--text-sub2)' }}>
              {unattendedRows.map((row) => (
                <li key={row.index} className="break-all">· {t('project.pane')} {row.index}: {row.label}</li>
              ))}
            </ul>
            <div className="flex items-start gap-2 text-[11px]" style={{ color: 'var(--text-sub)' }}>
              <input
                type="checkbox"
                checked={unattendedConsent}
                onChange={(e) => setUnattendedConsent(e.target.checked)}
                className="mt-0.5 shrink-0"
                aria-label={t('project.unattendedHeading')}
              />
              <span>{t('project.unattendedConsent', { count: unattendedRows.length })}</span>
            </div>
          </label>
        )}

        <div className="flex items-center justify-end gap-2">
          {isTrusted ? (
            <>
              <Button
                variant="secondary"
                onClick={() => { void decideProjectTrust(wsId, 'clear'); close(); }}
              >
                {t('project.revoke')}
              </Button>
              <Button variant="secondary" onClick={close}>
                {t('project.close')}
              </Button>
            </>
          ) : (
            <>
              {trust !== 'denied' && (
                <Button
                  variant="secondary"
                  onClick={() => { void decideProjectTrust(wsId, 'denied'); close(); }}
                >
                  {t('project.deny')}
                </Button>
              )}
              <Button variant="secondary" onClick={close}>
                {t('project.notNow')}
              </Button>
              {!project.invalid && (
                <Button
                  variant="primary"
                  onClick={() => { void decideProjectTrust(wsId, 'trusted', unattendedConsent); close(); }}
                >
                  {t('project.trust')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
