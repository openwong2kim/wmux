import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../hooks/useT';

interface ContextMenuProps {
  x: number;
  y: number;
  hasSelection: boolean;
  selectedText: string;
  linkUrl: string | null;
  onCopy: () => void;
  onPaste: () => void;
  onOpenLink: (url: string) => void;
  onCopyLink: (url: string) => void;
  /** X8 — supervision status of this surface's pty. `undefined` for
   *  unsupervised panes (both supervision items hidden). */
  supervisionStatus?: 'armed' | 'stopped';
  onSupervisionStop?: () => void;
  onSupervisionRearm?: () => void;
  onClose: () => void;
}

export default function ContextMenu({ x, y, hasSelection, selectedText, linkUrl, onCopy, onPaste, onOpenLink, onCopyLink, supervisionStatus, onSupervisionStop, onSupervisionRearm, onClose }: ContextMenuProps) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [onClose]);

  // Clamp position to viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const el = menuRef.current;
    if (rect.right > window.innerWidth) {
      el.style.left = `${window.innerWidth - rect.width - 4}px`;
    }
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${window.innerHeight - rect.height - 4}px`;
    }
  }, [x, y]);

  const handleAction = useCallback((action: () => void) => {
    action();
    onClose();
  }, [onClose]);

  // Portalled to document.body (#957). The menu is viewport-positioned, so it
  // never needed to be a descendant of the pane — and being one was the last
  // thing inside a pane that had to out-z its siblings to be seen, which is
  // what kept the pane root from owning a stacking context. Two things it
  // fixes on its own: a `position: fixed` element resolves against a
  // transformed ancestor rather than the viewport, and panes carry animated
  // rings; and a menu clipped by an `overflow` ancestor is a bug waiting for
  // whoever adds one to a pane.
  return createPortal((
    <div
      ref={menuRef}
      className="fixed z-[var(--z-popover-top)] min-w-[168px] p-[5px]"
      style={{
        left: x,
        top: y,
        background: 'var(--bg-surface)',
        border: '1px solid color-mix(in srgb, var(--text-main) 9%, transparent)',
        borderRadius: 8,
        boxShadow:
          '0 12px 32px rgba(0, 0, 0, 0.45), inset 0 1px 0 color-mix(in srgb, var(--text-main) 5%, transparent)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {hasSelection && (
        <MenuItem
          label={t('contextMenu.copy')}
          shortcut="Ctrl+C"
          onClick={() => handleAction(onCopy)}
        />
      )}

      {/* Paste is handled inline by right-click when no link/selection;
          only surface it here if no link is present (legacy callers) */}
      {!linkUrl && (
        <MenuItem
          label={t('contextMenu.paste')}
          shortcut="Ctrl+V"
          onClick={() => handleAction(onPaste)}
        />
      )}

      {linkUrl && (
        <>
          {hasSelection && (
            <div
              className="my-1 mx-1 border-t"
              style={{ borderColor: 'color-mix(in srgb, var(--text-main) 8%, transparent)' }}
            />
          )}
          <MenuItem
            label={t('contextMenu.openLink')}
            onClick={() => handleAction(() => onOpenLink(linkUrl))}
          />
          <MenuItem
            label={t('contextMenu.copyLink')}
            onClick={() => handleAction(() => onCopyLink(linkUrl))}
          />
        </>
      )}

      {hasSelection && !linkUrl && isUrl(selectedText.trim()) && (
        <>
          <div className="my-1 mx-2 border-t" style={{ borderColor: 'var(--bg-overlay)' }} />
          <MenuItem
            label={t('contextMenu.openLink')}
            onClick={() => handleAction(() => onOpenLink(selectedText.trim()))}
          />
        </>
      )}

      {/* X8 supervision controls — only for a supervised pane. Armed → stop;
          guard-tripped (stopped) → rearm. */}
      {supervisionStatus !== undefined && (
        <>
          <div className="my-1 mx-2 border-t" style={{ borderColor: 'var(--bg-overlay)' }} />
          {supervisionStatus === 'armed' ? (
            <MenuItem
              label={t('supervision.stop')}
              onClick={() => handleAction(() => onSupervisionStop?.())}
            />
          ) : (
            <MenuItem
              label={t('supervision.rearm')}
              onClick={() => handleAction(() => onSupervisionRearm?.())}
            />
          )}
        </>
      )}
    </div>
  ), document.body);
}

function MenuItem({ label, shortcut, onClick }: { label: string; shortcut?: string; onClick: () => void }) {
  return (
    <button
      className="w-full flex items-center justify-between gap-4 px-2.5 py-1.5 text-xs text-left rounded-[5px] transition-colors hover:bg-[color-mix(in_srgb,var(--accent-blue)_14%,transparent)]"
      style={{ color: 'var(--text-main)' }}
      onClick={onClick}
    >
      <span>{label}</span>
      {shortcut && (
        <span className="ml-4 text-[10px] font-mono tabular-nums" style={{ color: 'var(--text-subtle)' }}>
          {shortcut}
        </span>
      )}
    </button>
  );
}

function isUrl(text: string): boolean {
  return /^https?:\/\/.+/i.test(text);
}
