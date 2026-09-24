import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import { resolveExecuteApproval } from '../../utils/executeApproval';
import { beginApprovalCountdown, pauseApprovalCountdown } from '../../utils/executeApprovalGate';
import { renderSentence } from '../../i18n/renderSentence';
import { useT } from '../../hooks/useT';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import { IconWarning } from '../icons';
import { useActivationGuard } from '../Approval/useActivationGuard';

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
  // `now` only ticks while a prompt is shown, so between prompts it keeps its
  // last value. Refresh it during render whenever the prompt changes (a new one,
  // or its countdown starting), before anything commits: otherwise the next
  // prompt's first paint counts down from a stale clock ("auto-deny in 129s").
  const [clockFor, setClockFor] = useState(approval);
  if (clockFor !== approval) {
    setClockFor(approval);
    setNow(Date.now());
  }
  // A click already on its way when a prompt appears must not answer it.
  const guard = useActivationGuard(approval?.approvalId ?? '');

  // The auto-deny countdown belongs to the prompt that is ON SCREEN. Prompts
  // queued behind this one have not started theirs, so a busy queue can no
  // longer expire an approval nobody was shown.
  const shownApprovalId = approval?.approvalId;
  // Re-armed whenever the shown prompt's clock is not running, including after
  // the Fleet inbox paused it on its way out (#1462).
  const countdownStopped = approval ? approval.expiresAt <= 0 : false;
  useEffect(() => {
    if (shownApprovalId && countdownStopped) beginApprovalCountdown(shownApprovalId);
  }, [shownApprovalId, countdownStopped]);
  // And it stops when this dialog goes away (the Fleet inbox took over), so a
  // prompt nobody is looking at does not keep counting down. Unmount only: the
  // shown prompt changes only once the previous one has settled.
  const shownRef = useRef(shownApprovalId);
  useEffect(() => {
    shownRef.current = shownApprovalId;
  }, [shownApprovalId]);
  useEffect(() => () => {
    if (shownRef.current) pauseApprovalCountdown(shownRef.current);
  }, []);

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

  const title = task
    ? task.action === 'pr'
      ? t('approval.taskPrTitle')
      : t('approval.taskCloseTitle')
    : fanout
      ? t('approval.fanoutTitle')
      : t('approval.executeTitle');
  const danger = (text: string) => <span style={{ color: 'var(--accent-red)' }}>{text}</span>;
  // Machine evidence (ids, paths, branch tips) in mono; the labels stay Inter.
  const evidence = (label: string, value: ReactNode) => (
    <div className="flex gap-3 min-w-0 px-3.5 py-2">
      <span className="w-[72px] shrink-0 text-[var(--text-sub)]">{label}</span>
      <span className="min-w-0 break-all font-mono text-[12px] text-[var(--text-main)]">{value}</span>
    </div>
  );

  // No Escape, no backdrop, no close button: the prompt is answered with
  // Approve or Deny, or it auto-denies when the countdown runs out. It opens by
  // itself, so it leaves focus where the user is (a terminal, another dialog):
  // their next Enter or Space cannot answer a prompt they have not read. Keyed
  // by request id so each queued prompt starts fresh — without focus carried
  // over from the one before, and with its own activation guard.
  return (
    <Dialog
      key={approval.approvalId}
      role="alertdialog"
      onClose={() => resolveExecuteApproval(approval.approvalId, false)}
      closeOnEscape={false}
      focusOnOpen="none"
      width={480}
    >
      <DialogHeader
        title={
          <span className="flex items-center gap-2">
            <span className="shrink-0" style={{ color: 'var(--accent-red)' }}>
              <IconWarning size={16} />
            </span>
            {title}
          </span>
        }
        description={
          task
            ? renderSentence(t('approval.taskSentence'), { effect: danger(task.effect) })
            : fanout
              ? renderSentence(t('approval.fanoutSentence'), {
                  tasks: danger(
                    fanout.taskCount === 1
                      ? t('approval.fanoutTasks', { count: fanout.taskCount })
                      : t('approval.fanoutTasksPlural', { count: fanout.taskCount }),
                  ),
                })
              : sameWs
                ? renderSentence(t('approval.sameWsSentence'), {
                    workspace: danger(t('approval.sameWsWorkspace')),
                    mode: danger('bypassPermissions'),
                  })
                : renderSentence(t('approval.remoteSentence'), { mode: danger('bypassPermissions') })
        }
      />
      <DialogBody className="!gap-3">
        <div className="ui-group text-[13px]" data-approval-evidence>
          {task ? (
            <>
              {evidence(t('approval.caller'), senderName)}
              {evidence(t('approval.task'), task.taskId)}
              {task.branch
                ? evidence(
                    t('approval.branch'),
                    // The COMMIT, not just the name: the worker owning this
                    // worktree is still running, so a branch name alone does not
                    // identify what a push would send. main refuses if this
                    // moves before the answer lands.
                    `${task.branch}${task.branchTip ? ` @ ${task.branchTip}` : ''}`,
                  )
                : null}
              {task.worktreePath ? evidence(t('approval.worktree'), task.worktreePath) : null}
            </>
          ) : fanout ? (
            <>
              {evidence(t('approval.caller'), senderName)}
              {evidence(t('approval.repo'), fanout.repoPath)}
              {evidence(t('approval.tasks'), fanout.taskCount)}
            </>
          ) : (
            <>
              {evidence(t('approval.from'), senderName)}
              {evidence(t('approval.to'), receiverName)}
              {approval.cwd ? evidence(t('approval.cwd'), approval.cwd) : null}
              {evidence(t('approval.task'), approval.taskId)}
            </>
          )}
        </div>
        <div
          className="ui-group px-3.5 py-3 font-mono text-[12px] whitespace-pre-wrap break-words text-[var(--text-main)]"
          style={{
            // A fan-out preview carries one block PER TASK — the effective
            // prompt each agent is handed, which is what the user is actually
            // approving. Eight lines of scroll would hide most of it behind a
            // gesture nobody makes under a 30s timer.
            maxHeight: fanout ? 340 : 160,
            overflowY: 'auto',
          }}
          data-approval-message
        >
          {approval.messagePreview || t('approval.emptyMessage')}
        </div>
        {fanout || task ? (
          // No auto-approve affordance on a fan-out or a task action: the
          // toggle is scoped to A2A background execution and neither rides
          // it, so offering it here would promise something it does not do.
          <p className="m-0 text-[11px] text-[var(--text-sub)]">{t('approval.fanoutAutoApproveHint')}</p>
        ) : (
          <label className="flex items-center gap-2 text-[13px] text-[var(--text-sub)] cursor-pointer">
            <Checkbox
              checked={a2aAutoApproveExecute}
              onCheckedChange={(next) => guard(() => setA2aAutoApproveExecute(next))()}
              data-approval-auto-approve
            />
            {t('fleet.approvals.a2aAutoApprove')}
          </label>
        )}
      </DialogBody>
      <DialogFooter>
        {/* The countdown stays in view next to the answer it is counting down to. */}
        <span className="mr-auto text-[11px] tabular-nums text-[var(--text-sub)]" data-approval-countdown>
          {remainingSec === null ? '' : t('approval.autoDeny', { sec: remainingSec })}
        </span>
        <Button
          size="md"
          variant="secondary"
          onClick={guard(() => resolveExecuteApproval(approval.approvalId, false))}
        >
          {t('approval.deny')}
        </Button>
        {/* Solid red: this is the final confirm of an autonomous spawn or a
            push, the one place DESIGN.md allows the full danger fill. */}
        <Button
          size="md"
          variant="danger"
          className="gap-1.5"
          onClick={guard(() => resolveExecuteApproval(approval.approvalId, true))}
        >
          {/* Severity is not colour alone: in themes whose accent is red, the
              danger and primary fills look alike. */}
          <IconWarning size={12} />
          {t('approval.approve')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
