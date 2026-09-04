import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import { resolveExecuteApproval } from '../../utils/executeApproval';
import { beginApprovalCountdown } from '../../utils/executeApprovalGate';
import { renderSentence } from '../../i18n/renderSentence';
import { useT } from '../../hooks/useT';

/**
 * Approval prompt for `a2a_task_send` requests with `execute: true`.
 * Without this gate, any external MCP caller could spawn an unattended
 * Claude CLI in `--permission-mode bypassPermissions` mode in our workspace.
 */
export default function ExecuteApprovalDialog() {
  // useT(), not the module-level `t`: this dialog can be on screen when the
  // locale changes, and it is one the user cannot dismiss and reopen to pick
  // up the new language.
  const t = useT();
  const approval = useStore((s) => s.pendingExecuteApproval);
  // A1: id→name 해석만 필요 — {id,name} 투영만 구독해 metadata/surface 변경에
  // 리렌더되지 않게 한다.
  const workspaces = useStore(useShallow(selectWorkspaceIdName));
  const a2aAutoApproveExecute = useStore((s) => s.a2aAutoApproveExecute);
  const setA2aAutoApproveExecute = useStore((s) => s.setA2aAutoApproveExecute);
  const [now, setNow] = useState(() => Date.now());

  // The auto-deny countdown belongs to the prompt that is ON SCREEN. Prompts
  // queued behind this one have not started theirs, so a busy queue can no
  // longer expire an approval nobody was shown.
  const shownApprovalId = approval?.approvalId;
  useEffect(() => {
    if (shownApprovalId) beginApprovalCountdown(shownApprovalId);
  }, [shownApprovalId]);

  useEffect(() => {
    if (!approval) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [approval]);

  if (!approval) return null;

  const senderName = workspaces.find((w) => w.id === approval.senderWorkspaceId)?.name ?? approval.senderWorkspaceId ?? t('approval.unknownSender');
  const receiverName = workspaces.find((w) => w.id === approval.receiverWorkspaceId)?.name ?? approval.receiverWorkspaceId ?? t('approval.unknownReceiver');
  // Same-workspace execute (an agent asking to spawn an autonomous agent in its
  // OWN workspace). The default "remote A2A caller … in this workspace" wording
  // implies an inter-workspace handoff and reads as harmless; be explicit so the
  // user isn't social-engineered into waving through a self-spawned bypass agent.
  const sameWs = !!approval.senderWorkspaceId && approval.senderWorkspaceId === approval.receiverWorkspaceId;
  // Fan-out from the pipe/MCP surface. The A2A copy below says "in this
  // workspace", which is wrong for a fan-out (N NEW worktree workspaces) in a
  // security-relevant way — so the fan-out branch states the count and the repo
  // instead of letting the user wave through a misdescribed spawn. It also
  // hides the auto-approve checkbox, which does not apply to fan-out.
  const fanout = approval.fanout;
  // A task-lifecycle action (task.close / task.pr) from the pipe/MCP surface.
  // Neither spawns anything, so both the A2A and the fan-out copy would name an
  // action the user is not being asked about — this branch states the effect
  // main computed, plus the task, branch and worktree it will act on.
  const task = approval.task;
  // expiresAt is 0 until the countdown starts (this render starts it), so the
  // first paint would otherwise flash "auto-deny in 0s".
  const remainingMs = approval.expiresAt > 0 ? Math.max(0, approval.expiresAt - now) : null;
  const remainingSec = remainingMs === null ? null : Math.ceil(remainingMs / 1000);

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.65)' }}
      role="alertdialog"
      aria-labelledby="execute-approval-title"
    >
      <div
        className="flex flex-col gap-4 p-5 rounded-xl"
        style={{
          width: 460,
          maxWidth: '90vw',
          backgroundColor: 'var(--bg-base)',
          border: '1px solid var(--accent-red)',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--accent-red)', fontSize: 18 }}>⚠</span>
          <p
            id="execute-approval-title"
            className="text-sm font-semibold font-mono"
            style={{ color: 'var(--text-main)' }}
          >
            {task
              ? task.action === 'pr'
                ? t('approval.taskPrTitle')
                : t('approval.taskCloseTitle')
              : fanout
                ? t('approval.fanoutTitle')
                : t('approval.executeTitle')}
          </p>
        </div>
        <p className="text-xs" style={{ color: 'var(--text-sub)' }}>
          {task ? (
            renderSentence(t('approval.taskSentence'), {
              effect: <span style={{ color: 'var(--accent-red)' }}>{task.effect}</span>,
            })
          ) : fanout ? (
            renderSentence(t('approval.fanoutSentence'), {
              tasks: (
                <span style={{ color: 'var(--accent-red)' }}>
                  {fanout.taskCount === 1
                    ? t('approval.fanoutTasks', { count: fanout.taskCount })
                    : t('approval.fanoutTasksPlural', { count: fanout.taskCount })}
                </span>
              ),
            })
          ) : sameWs ? (
            renderSentence(t('approval.sameWsSentence'), {
              workspace: <span style={{ color: 'var(--accent-red)' }}>{t('approval.sameWsWorkspace')}</span>,
              mode: <span style={{ color: 'var(--accent-red)' }}>bypassPermissions</span>,
            })
          ) : (
            renderSentence(t('approval.remoteSentence'), {
              mode: <span style={{ color: 'var(--accent-red)' }}>bypassPermissions</span>,
            })
          )}
        </p>
        <div
          className="text-xs font-mono flex flex-col gap-1 p-3 rounded-md"
          style={{ backgroundColor: 'var(--bg-mantle)', color: 'var(--text-sub2)' }}
        >
          {task ? (
            <>
              <div><span style={{ color: 'var(--text-subtle)' }}>{t('approval.caller')}</span> {senderName}</div>
              <div><span style={{ color: 'var(--text-subtle)' }}>{t('approval.task')}</span> {task.taskId}</div>
              {task.branch ? (
                <div>
                  <span style={{ color: 'var(--text-subtle)' }}>{t('approval.branch')}</span> {task.branch}
                  {/* The COMMIT, not just the name: the worker owning this
                      worktree is still running, so a branch name alone does not
                      identify what a push would send. main refuses if this
                      moves before the answer lands. */}
                  {task.branchTip ? ` @ ${task.branchTip}` : ''}
                </div>
              ) : null}
              {task.worktreePath ? (
                <div><span style={{ color: 'var(--text-subtle)' }}>{t('approval.worktree')}</span> {task.worktreePath}</div>
              ) : null}
            </>
          ) : fanout ? (
            <>
              <div><span style={{ color: 'var(--text-subtle)' }}>{t('approval.caller')}</span> {senderName}</div>
              <div><span style={{ color: 'var(--text-subtle)' }}>{t('approval.repo')}</span> {fanout.repoPath}</div>
              <div><span style={{ color: 'var(--text-subtle)' }}>{t('approval.tasks')}</span> {fanout.taskCount}</div>
            </>
          ) : (
            <>
              <div><span style={{ color: 'var(--text-subtle)' }}>{t('approval.from')}</span> {senderName}</div>
              <div><span style={{ color: 'var(--text-subtle)' }}>{t('approval.to')}</span> {receiverName}</div>
              {approval.cwd ? (
                <div><span style={{ color: 'var(--text-subtle)' }}>{t('approval.cwd')}</span> {approval.cwd}</div>
              ) : null}
              <div><span style={{ color: 'var(--text-subtle)' }}>{t('approval.task')}</span> {approval.taskId}</div>
            </>
          )}
        </div>
        <div
          className="text-xs font-mono p-3 rounded-md whitespace-pre-wrap break-words"
          style={{
            backgroundColor: 'var(--bg-surface)',
            color: 'var(--text-main)',
            // A fan-out preview carries one block PER TASK — the effective
            // prompt each agent is handed, which is what the user is actually
            // approving. Eight lines of scroll would hide most of it behind a
            // gesture nobody makes under a 30s timer.
            maxHeight: fanout ? 340 : 160,
            overflowY: 'auto',
          }}
        >
          {approval.messagePreview || t('approval.emptyMessage')}
        </div>
        <div className="flex items-center justify-between">
          {fanout || task ? (
            // No auto-approve affordance on a fan-out or a task action: the
            // toggle is scoped to A2A background execution and neither rides
            // it, so offering it here would promise something it does not do.
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-subtle)' }}>
              {t('approval.fanoutAutoApproveHint')}
            </span>
          ) : (
            <label className="flex items-center gap-2 text-[10px] font-mono" style={{ color: 'var(--text-subtle)' }}>
              <input
                type="checkbox"
                checked={a2aAutoApproveExecute}
                onChange={(e) => setA2aAutoApproveExecute(e.currentTarget.checked)}
              />
              {t('fleet.approvals.a2aAutoApprove')}
            </label>
          )}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono" style={{ color: 'var(--text-subtle)' }}>
            {remainingSec === null ? '' : t('approval.autoDeny', { sec: remainingSec })}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => resolveExecuteApproval(approval.approvalId, false)}
              className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-subtle)' }}
            >
              {t('approval.deny')}
            </button>
            <button
              onClick={() => resolveExecuteApproval(approval.approvalId, true)}
              className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{ backgroundColor: 'var(--accent-red)', color: 'var(--bg-base)' }}
            >
              {t('approval.approve')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
