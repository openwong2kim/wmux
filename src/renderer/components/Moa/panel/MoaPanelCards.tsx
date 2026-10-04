// The short cards the right panel shows instead of a conversation: Moa is
// off, Moa's workspace has a problem, or (today's per-workspace chat kept)
// Moa is not set up yet. Each says one thing and offers the one action that
// changes it: Settings › Moa.
import Button from '../../ui/Button';
import type { MoaHqState } from '../../../../shared/moa';

type T = (key: string) => string;

const HQ_PROBLEM_KEY: Record<Exclude<MoaHqState, 'ok' | 'unset'>, { title: string; body: string }> = {
  'hq-missing': { title: 'moa.panel.hqMissingTitle', body: 'moa.panel.hqMissingBody' },
  'hq-unknown': { title: 'moa.panel.hqCheckingTitle', body: 'moa.panel.hqCheckingBody' },
  'hq-store-corrupt': { title: 'moa.panel.hqCorruptTitle', body: 'moa.panel.hqCorruptBody' },
};

function Card({ kind, title, body, action, onAction }: {
  kind: string; title: string; body: string; action: string; onAction: () => void;
}) {
  return (
    <div className="flex flex-col flex-1 min-h-0 p-3" data-moa-panel-card={kind}>
      <div className="ui-notice flex flex-col items-start gap-2 px-3 py-3" role="status">
        <p className="m-0 text-[13px] font-medium text-[var(--text-main)]">{title}</p>
        <p className="m-0 text-[12px] leading-5 text-[var(--text-sub)]">{body}</p>
        <Button variant="secondary" size="sm" onClick={onAction} data-moa-open-settings>
          {action}
        </Button>
      </div>
    </div>
  );
}

/** Moa is switched off: the panel holds only this. */
export function MoaOffCard({ onOpenSettings, t }: { onOpenSettings: () => void; t: T }) {
  return <Card kind="off" title={t('moa.panel.offTitle')} body={t('moa.panel.offBody')} action={t('moa.panel.openSettings')} onAction={onOpenSettings} />;
}

/** Moa is on but its workspace is gone, not seen yet, or unreadable. */
export function MoaHqProblemCard({ state, onOpenSettings, t }: {
  state: Exclude<MoaHqState, 'ok' | 'unset'>; onOpenSettings: () => void; t: T;
}) {
  const keys = HQ_PROBLEM_KEY[state];
  return <Card kind={state} title={t(keys.title)} body={t(keys.body)} action={t('moa.panel.openSettings')} onAction={onOpenSettings} />;
}

/** One quiet line above today's per-workspace chat: Moa can take over. */
export function MoaSetupHint({ onOpenSettings, t }: { onOpenSettings: () => void; t: T }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-sub)] shrink-0" data-moa-setup-hint>
      <span className="min-w-0 flex-1 truncate">{t('moa.panel.setupHint')}</span>
      <Button variant="ghost" size="sm" onClick={onOpenSettings} data-moa-open-settings>
        {t('moa.panel.setupAction')}
      </Button>
    </div>
  );
}
