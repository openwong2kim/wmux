// "Who acts next" on a PR, in the detail header's reserved slot: from the most
// recently updated active work link on the PR (main owns links; the renderer
// reads them and re-reads when they change). You, with why; the agent or
// workspace doing the work, working or with why it stopped; nothing when no
// work is linked or it is finished.
import { agentSlugToDisplay, isAgentSlug } from '../../../shared/agentIdentity';
import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { prUrlParts } from '../../../shared/prDragRef';
import { whoActsNext } from '../../../shared/prReview';
import type { WorkLink, WorkLinkState } from '../../../shared/workLink';

const ACTIVE: WorkLinkState[] = ['queued', 'running', 'needs-you', 'blocked', 'review'];

export function WhoActsNext({ url }: { url: string }): React.ReactElement | null {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const [link, setLink] = useState<WorkLink | null>(null);

  useEffect(() => {
    const api = (window as Partial<Window>).electronAPI?.workLinks;
    const pr = prUrlParts(url);
    setLink(null);
    if (!api?.list || !pr) return;
    let alive = true;
    let req = 0;
    const read = async () => {
      const mine = ++req;
      try {
        const links = await api.list({ pr, states: ACTIVE });
        if (!alive || mine !== req) return;
        setLink(links.reduce<WorkLink | null>((best, l) => (!best || l.updatedAt > best.updatedAt ? l : best), null));
      } catch {
        // No links readable: say nothing rather than something stale.
        if (alive && mine === req) setLink(null);
      }
    };
    void read();
    const off = api.onChanged?.(() => void read());
    return () => {
      alive = false;
      off?.();
    };
  }, [url]);

  const next = link ? whoActsNext(link) : null;
  if (!link || !next) return null;
  let text: string;
  if (next.actor === 'you') {
    text = t('git.next.you', { reason: t(`git.next.reason.${next.reason}`) });
  } else {
    const agent = link.agent ? (isAgentSlug(link.agent) ? agentSlugToDisplay(link.agent) : link.agent) : '';
    const name = agent || workspaces.find((w) => w.id === link.owner.workspaceId)?.name || t('git.next.agent');
    const status = next.working ? t('git.next.working') : t(`git.next.reason.${next.reason ?? 'other'}`);
    text = t('git.next.owner', { name, status });
  }
  return <span className="wmux-git-next" data-git-next={next.actor}>{text}</span>;
}
