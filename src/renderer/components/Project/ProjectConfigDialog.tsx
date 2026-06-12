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

import { useEffect } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { countLayoutLeaves } from '../../../shared/wmuxProjectConfig';
import type { WmuxProjectLayoutNode } from '../../../shared/wmuxProjectConfig';
import { applyProjectLayoutFresh, decideProjectTrust, probeProjectConfig } from '../../utils/projectConfigProbe';
import { runProjectCommand } from '../../utils/projectCommands';

/** Layout startup commands with their pane position, depth-first. */
function layoutRows(node: WmuxProjectLayoutNode, acc: { label: string; index: number }[] = []): { label: string; index: number }[] {
  const walk = (n: WmuxProjectLayoutNode): void => {
    if (n.type === 'leaf') {
      const index = acc.length + 1;
      if (n.url !== undefined) acc.push({ label: `→ ${n.url}`, index });
      else acc.push({ label: n.command ?? '(shell)', index });
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

  // Re-probe on open so the dialog reflects the LIVE file — a wmux.json
  // edited since the last probe shows as 'stale' here, not as still-trusted.
  useEffect(() => {
    if (wsId) void probeProjectConfig(wsId);
  }, [wsId]);

  if (!wsId || !project || !project.found) return null;

  const close = () => setWsId(null);
  const trust = project.trust;
  const isTrusted = trust === 'trusted';
  const commands = project.config?.commands ?? [];
  const layout = project.config?.layout;

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
      className="fixed inset-0 z-[70] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.65)' }}
      role="dialog"
      aria-labelledby="project-config-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        className="flex flex-col gap-4 p-5 rounded-xl"
        style={{
          width: 560,
          maxWidth: '92vw',
          maxHeight: '90vh',
          overflowY: 'auto',
          backgroundColor: 'var(--bg-base)',
          border: `1px solid ${accent}`,
          boxShadow: '0 25px 60px rgba(0,0,0,0.75)',
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
              {layoutRows(layout).map((row) => (
                <li key={row.index} className="break-all">· {t('project.pane')} {row.index}: {row.label}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {isTrusted ? (
            <>
              <button
                onClick={() => { void decideProjectTrust(wsId, 'clear'); close(); }}
                className="px-4 py-1.5 rounded-lg text-xs font-medium"
                style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-subtle)' }}
              >
                {t('project.revoke')}
              </button>
              <button
                onClick={close}
                className="px-4 py-1.5 rounded-lg text-xs font-medium"
                style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-main)' }}
              >
                {t('project.close')}
              </button>
            </>
          ) : (
            <>
              {trust !== 'denied' && (
                <button
                  onClick={() => { void decideProjectTrust(wsId, 'denied'); close(); }}
                  className="px-4 py-1.5 rounded-lg text-xs font-medium"
                  style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-subtle)' }}
                >
                  {t('project.deny')}
                </button>
              )}
              <button
                onClick={close}
                className="px-4 py-1.5 rounded-lg text-xs font-medium"
                style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-main)' }}
              >
                {t('project.notNow')}
              </button>
              {!project.invalid && (
                <button
                  onClick={() => { void decideProjectTrust(wsId, 'trusted'); close(); }}
                  className="px-4 py-1.5 rounded-lg text-xs font-medium"
                  style={{ backgroundColor: 'var(--accent-yellow)', color: 'var(--bg-base)' }}
                >
                  {t('project.trust')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
