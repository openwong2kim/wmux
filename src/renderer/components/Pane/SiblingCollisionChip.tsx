// Pane-header chip for a pane whose worktree touches the same file as a
// sibling worktree of the same repo (main/git/siblingCollision.ts). In the tab
// strip's flow beside the stuck-turn chip, shown only while the collision
// lasts: "Same file as #w1-2", the words in the caution colour when a merge of
// the two would conflict, muted when both only changed the file (uncommitted
// work, or git too old to dry-run a merge). Its tooltip lists the files; a
// click opens a small card with the list and one action, Start merge, which
// opens the Git page's existing merge session for this worktree.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { placePopover } from '../AgentToolbar/placePopover';
import Popover, { PopoverSection } from '../ui/Popover';
import Button from '../ui/Button';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { paneCollision, type PaneCollision } from '../../utils/siblingCollisionWatch';
import { saveGitTab } from '../Git/gitPageState';
import { showWorkspaces } from '../../utils/showWorkspaces';
import type { Workspace } from '../../../shared/types';
import type { TranslationKey } from '../../i18n/locales/en';

export const SIBLING_COLLISION_CARD_WIDTH = 300;
/** Files listed per sibling in the card and the tooltip; the rest is a count. */
const MAX_FILES = 8;

type Anchor = { top: number; left: number; right: number; bottom: number };
type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** The chip's words: the first sibling's tag, "+N" for the others. */
export function collisionLabel(t: T, c: PaneCollision): string {
  const tags = c.peers.flatMap((p) => p.tags);
  const extra = tags.length - 1;
  return extra > 0 ? t('siblingCollision.labelMore', { tag: tags[0], count: extra }) : t('siblingCollision.label', { tag: tags[0] });
}

/** Whether any sibling would conflict (vs only changed the same file). */
export function collisionConflicts(c: PaneCollision): boolean {
  return c.peers.some((p) => p.conflicts.length > 0);
}

function fileLines(files: string[]): string[] {
  return files.length > MAX_FILES ? [...files.slice(0, MAX_FILES), `+${files.length - MAX_FILES}`] : files;
}

/** The tooltip: per sibling, its tag and kind, then its files. */
export function collisionTooltip(t: T, c: PaneCollision): string {
  const out: string[] = [];
  for (const p of c.peers) {
    if (p.conflicts.length) out.push(t('siblingCollision.wouldConflict', { tags: p.tags.join(' ') }), ...fileLines(p.conflicts).map((f) => `  ${f}`));
    if (p.overlaps.length) out.push(t('siblingCollision.bothChanged', { tags: p.tags.join(' ') }), ...fileLines(p.overlaps).map((f) => `  ${f}`));
  }
  return out.join('\n');
}

function FileList({ files }: { files: string[] }) {
  return (
    <ul className="mt-0.5 mb-1 font-mono text-[11px] text-[var(--text-sub)]">
      {fileLines(files).map((f) => <li key={f} className="truncate" title={f}>{f}</li>)}
    </ul>
  );
}

export function SiblingCollisionCard({ collision, workspaceId, paneId, anchor, triggerRef, onClose }: {
  collision: PaneCollision;
  workspaceId: string;
  paneId: string;
  anchor: Anchor;
  triggerRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const t = useT();
  const cardRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(160);
  const [busy, setBusy] = useState(false);
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight;
    if (h && h !== height) setHeight(h);
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || triggerRef?.current?.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
      }
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || triggerRef?.current?.contains(target)) return;
      onClose();
    };
    // Capture on keydown: the terminal swallows keys.
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, triggerRef]);

  const api = (window as unknown as {
    electronAPI?: { worktree?: { mergeStart?: (repoPath: string, sourcePath: string) => Promise<{ ok: true } | { ok: false; error: string }> } };
  }).electronAPI?.worktree;
  // The existing merge session (Git page › Worktrees): this worktree into the
  // base branch, in its own folder. A refusal (uncommitted changes, a session
  // already open) is a toast; the page opens either way, showing any session.
  const startMerge = async () => {
    if (!api?.mergeStart || busy) return;
    setBusy(true);
    const res = await api.mergeStart(collision.worktreePath, collision.worktreePath)
      .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    setBusy(false);
    const st = useStore.getState();
    if (!res.ok) st.pushToast({ level: 'warn', message: `${t('git.mergeFailed')}: ${res.error}` });
    // The Git page follows the active pane: bring this one forward first.
    if (st.activeWorkspaceId !== workspaceId) st.setActiveWorkspace(workspaceId);
    useStore.getState().setActivePane(paneId);
    showWorkspaces(useStore.getState());
    saveGitTab('worktrees');
    st.setGitPage({ scope: 'repo', pick: null, tab: 'worktrees' });
    st.setAppRoute('git');
    onClose();
  };

  const pos = placePopover(anchor, { width: SIBLING_COLLISION_CARD_WIDTH, height });
  return createPortal(
    <Popover
      ref={cardRef}
      padded
      aria-label={t('siblingCollision.cardTitle')}
      data-sibling-collision-card
      className="fixed"
      style={{ top: pos.top, left: pos.left, width: SIBLING_COLLISION_CARD_WIDTH, zIndex: 'var(--z-popover-top)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <PopoverSection title={t('siblingCollision.cardTitle')}>
        {collision.peers.map((p) => (
          <div key={p.worktreePath} data-sibling-collision-peer>
            {p.conflicts.length > 0 && (
              <>
                <p className="text-[12px] text-[var(--text-main)]">{t('siblingCollision.wouldConflict', { tags: p.tags.join(' ') })}</p>
                <FileList files={p.conflicts} />
              </>
            )}
            {p.overlaps.length > 0 && (
              <>
                <p className="text-[12px] text-[var(--text-main)]">{t('siblingCollision.bothChanged', { tags: p.tags.join(' ') })}</p>
                <FileList files={p.overlaps} />
              </>
            )}
          </div>
        ))}
        <p className="text-[11px] text-[var(--text-muted)]">{t('siblingCollision.cardNote')}</p>
        <div className="mt-2 flex flex-col gap-1">
          <Button
            size="sm"
            className="justify-start"
            disabled={!api?.mergeStart || busy}
            title={t('siblingCollision.startMergeTitle')}
            onClick={() => { void startMerge(); }}
            data-sibling-collision-action="merge"
          >
            {t('siblingCollision.startMerge')}
          </Button>
        </div>
      </PopoverSection>
    </Popover>,
    document.body,
  );
}

export default function SiblingCollisionChip({ workspace, paneId, readOnly = false }: {
  workspace: Workspace;
  paneId: string;
  readOnly?: boolean;
}) {
  const t = useT();
  // A string, so the chip re-renders only when what it shows changes.
  const json = useStore((s) => {
    if (!s.siblingCollisionWatch || Object.keys(s.siblingCollisions.byCwd).length === 0) return '';
    const leaf = getWorkspaceLeafPanes(workspace).find((l) => l.id === paneId);
    const c = leaf ? paneCollision(s.siblingCollisions, s.workspaces, workspace, leaf) : null;
    return c ? JSON.stringify(c) : '';
  });
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  // The card belongs to one collision: it goes when the collision clears.
  useEffect(() => { if (!json) setAnchor(null); }, [json]);
  if (!json) return null;
  const collision = JSON.parse(json) as PaneCollision;
  const label = collisionLabel(t, collision);
  const tooltip = collisionTooltip(t, collision);
  const conflict = collisionConflicts(collision);
  const word = (
    <span className={`truncate ${conflict ? 'text-[var(--accent-yellow)]' : ''}`} aria-hidden="true">{label}</span>
  );
  return (
    <span
      data-pane-sibling-collision={conflict ? 'conflict' : 'overlap'}
      className="shrink min-w-0 overflow-hidden flex items-center text-[11px] text-[var(--text-muted)] select-none"
      onClick={(e) => e.stopPropagation()}
    >
      {readOnly ? (
        <span className="flex items-center min-w-0 px-1" title={tooltip} aria-label={`${label}: ${tooltip}`} role="img">{word}</span>
      ) : (
        <button
          ref={btnRef}
          type="button"
          className={`${FOCUS_RING} flex items-center min-w-0 px-1 h-6 rounded-[var(--chip-radius)] hover:bg-[var(--selection-hover)] hover:[--text-muted:var(--text-subtle)]`}
          title={tooltip}
          aria-label={`${t('siblingCollision.openCard')}: ${label}`}
          aria-haspopup="dialog"
          aria-expanded={!!anchor}
          onClick={(e) => {
            if (anchor) { setAnchor(null); return; }
            setAnchor(e.currentTarget.getBoundingClientRect());
          }}
          data-sibling-collision-action="card"
        >
          {word}
        </button>
      )}
      {anchor && !readOnly && (
        <SiblingCollisionCard
          collision={collision}
          workspaceId={workspace.id}
          paneId={paneId}
          anchor={anchor}
          triggerRef={btnRef}
          onClose={() => setAnchor(null)}
        />
      )}
    </span>
  );
}
