// Work between this PC's Moa and other PCs' Moa (cross-host A2A brain links),
// under the delegated work. Read-only and neutral: one line per task with its
// title, then its state, which way it went and the other PC. Colour carries
// state only: needs-input is the attention orange, failed is red.
import type { MoaRemoteTask } from '../../../../shared/a2aRemoteDelivery';
import type { TaskState } from '../../../../shared/types';
import { useMoaRemoteTasks, type MoaRemoteTasksApi } from './useMoaPanelData';

type T = (key: string, vars?: Record<string, string | number>) => string;

const STATE_CLASS: Partial<Record<TaskState, string>> = {
  'input-required': 'text-[var(--attention-text)]',
  failed: 'text-[var(--accent-red)]',
};

export function MoaRemoteTasks({ api, t }: { api: MoaRemoteTasksApi | undefined; t: T }): React.ReactElement | null {
  const tasks = useMoaRemoteTasks(api);
  return <MoaRemoteTaskList tasks={tasks} t={t} />;
}

export function MoaRemoteTaskList({ tasks, t }: { tasks: readonly MoaRemoteTask[]; t: T }): React.ReactElement | null {
  if (tasks.length === 0) return null;
  return (
    <section data-moa-remote-tasks aria-labelledby="moa-remote-tasks-title" className="px-3 pt-2 pb-1">
      <h3 id="moa-remote-tasks-title" className="m-0 mb-1 flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-main)]">
        {t('moa.panel.remoteTitle')}
        <span className="tabular-nums text-[var(--text-sub)] font-normal">{tasks.length}</span>
      </h3>
      <ul className="m-0 p-0 list-none flex flex-col">
        {tasks.map((task) => (
          <li key={task.taskId} data-moa-remote-task={task.taskId} data-direction={task.direction} className="px-1.5 py-1.5">
            <span className="block truncate text-[13px] text-[var(--text-main)]">{task.title || t('moa.panel.untitledTask')}</span>
            <span className="block truncate text-[11px] text-[var(--text-sub)]">
              <span className={STATE_CLASS[task.state]}>{t(`moa.panel.a2a.${task.state}`)}</span>
              {' · '}
              {t(task.direction === 'sent' ? 'moa.panel.remoteSent' : 'moa.panel.remoteReceived', { pc: task.host })}
              {/* While a sent task is open: did the other Moa get it, read it, or is it still on its way. */}
              {task.direction === 'sent' && (task.state === 'submitted' || task.state === 'working') && (
                <span data-moa-remote-receipt={task.receipt ?? 'none'}>
                  {' · '}
                  {t(task.receipt === 'read' ? 'moa.panel.remoteRead' : task.receipt === 'delivered' ? 'moa.panel.remoteGot' : 'moa.panel.remoteOnItsWay')}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
