import { useEffect, useRef, useCallback } from 'react';
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
  onClose: () => void;
}

export default function ContextMenu({ x, y, hasSelection, selectedText, linkUrl, onCopy, onPaste, onOpenLink, onCopyLink, onClose }: ContextMenuProps) {
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
      className="fixed z-[9999] min-w-[160px] py-1 rounded-md shadow-xl"
      style={{
        left: x,
        top: y,
        background: 'var(--bg-surface)',
        border: '1px solid var(--bg-overlay)',
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
            <div className="my-1 mx-2 border-t" style={{ borderColor: 'var(--bg-overlay)' }} />
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
    </div>
  );
}

function MenuItem({ label, shortcut, onClick }: { label: string; shortcut?: string; onClick: () => void }) {
  return (
    <button
      className="w-full flex items-center justify-between px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
      style={{ color: 'var(--text-main)' }}
      onClick={onClick}
    >
      <span>{label}</span>
      {shortcut && (
        <span className="ml-4 text-[10px]" style={{ color: 'var(--text-subtle)' }}>
          {shortcut}
        </span>
      )}
    </button>
  );
}

function isUrl(text: string): boolean {
  return /^https?:\/\/.+/i.test(text);
}
