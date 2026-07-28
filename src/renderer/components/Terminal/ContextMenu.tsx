import { useEffect, useRef, useCallback } from 'react';
import { useT } from '../../hooks/useT';

/** Chat View toggle for the surface this menu was opened on. Absent when the
 *  surface has nothing to project (no pty, or an agent that publishes no
 *  transcript) — a control that can never do anything does not belong in a
 *  menu at all. `disabled` is the transient no ("after the first turn"), which
 *  states its own reason instead of disappearing. */
export interface ContextMenuViewMode {
  /** True while the surface renders as Chat — the item then offers terminal. */
  chatOn: boolean;
  disabled?: boolean;
  /** Tooltip for a disabled item — the projector's own reason string. */
  disabledReason?: string;
  /** Pre-rendered chord shown next to the label, e.g. "⇧⌘J". */
  shortcut?: string;
  onToggle: () => void;
}

/** Every item group is optional: the terminal body passes the copy/paste/link
 *  handlers, the surface tab strip passes only `viewMode`. One menu, two
 *  callers — not two menu systems. */
interface ContextMenuProps {
  x: number;
  y: number;
  hasSelection?: boolean;
  selectedText?: string;
  linkUrl?: string | null;
  onCopy?: () => void;
  onPaste?: () => void;
  onOpenLink?: (url: string) => void;
  onCopyLink?: (url: string) => void;
  /** X8 — supervision status of this surface's pty. `undefined` for
   *  unsupervised panes (both supervision items hidden). */
  supervisionStatus?: 'armed' | 'stopped';
  onSupervisionStop?: () => void;
  onSupervisionRearm?: () => void;
  viewMode?: ContextMenuViewMode;
  onClose: () => void;
}

export default function ContextMenu({ x, y, hasSelection = false, selectedText = '', linkUrl = null, onCopy, onPaste, onOpenLink, onCopyLink, supervisionStatus, onSupervisionStop, onSupervisionRearm, viewMode, onClose }: ContextMenuProps) {
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

  return (
    <div
      ref={menuRef}
      data-context-menu
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
      {hasSelection && onCopy && (
        <MenuItem
          label={t('contextMenu.copy')}
          shortcut="Ctrl+C"
          onClick={() => handleAction(onCopy)}
        />
      )}

      {/* Paste is handled inline by right-click when no link/selection;
          only surface it here if no link is present (legacy callers) */}
      {!linkUrl && onPaste && (
        <MenuItem
          label={t('contextMenu.paste')}
          shortcut="Ctrl+V"
          onClick={() => handleAction(onPaste)}
        />
      )}

      {linkUrl && onOpenLink && onCopyLink && (
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

      {hasSelection && !linkUrl && onOpenLink && isUrl(selectedText.trim()) && (
        <>
          <div className="my-1 mx-2 border-t" style={{ borderColor: 'var(--bg-overlay)' }} />
          <MenuItem
            label={t('contextMenu.openLink')}
            onClick={() => handleAction(() => onOpenLink(selectedText.trim()))}
          />
        </>
      )}

      {/* Chat View toggle — the per-surface view mode. Carries the same chord
          the keyboard binds, so the menu also teaches the shortcut. */}
      {viewMode && (
        <MenuItem
          label={viewMode.chatOn ? t('chat.menu.showTerminal') : t('chat.menu.showChat')}
          {...(viewMode.shortcut ? { shortcut: viewMode.shortcut } : {})}
          {...(viewMode.disabled ? { disabled: true } : {})}
          {...(viewMode.disabled && viewMode.disabledReason
            ? { title: viewMode.disabledReason }
            : {})}
          onClick={() => handleAction(viewMode.onToggle)}
        />
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
  );
}

function MenuItem({ label, shortcut, disabled, title, onClick }: { label: string; shortcut?: string; disabled?: boolean; title?: string; onClick: () => void }) {
  return (
    <button
      className={`w-full flex items-center justify-between gap-4 px-2.5 py-1.5 text-xs text-left rounded-[5px] transition-colors ${
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : 'hover:bg-[color-mix(in_srgb,var(--accent-blue)_14%,transparent)]'
      }`}
      style={{ color: 'var(--text-main)' }}
      disabled={disabled}
      {...(title ? { title } : {})}
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
