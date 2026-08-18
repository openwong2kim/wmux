import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { injectText } from './inject';
import Button from '../ui/Button';

export default function RichInput({ ptyId }: { ptyId: string }) {
  const t = useT();
  const draft = useStore((s) => s.richDraftByPane[ptyId] ?? '');
  const setRichDraft = useStore((s) => s.setRichDraft);
  const clearRichDraft = useStore((s) => s.clearRichDraft);
  const setPopover = useStore((s) => s.setToolbarPopover);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Notepad-style drag. The popover is anchored bottom-right of the toolbar;
  // dragging the header applies a translate offset so it can be moved freely.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  useEffect(() => { ref.current?.focus(); }, []);

  const onHeaderMouseDown = (e: React.MouseEvent) => {
    // Ignore drags that start on the close button.
    if ((e.target as HTMLElement).closest('[data-rich-close]')) return;
    e.preventDefault();
    drag.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
    const onMove = (ev: MouseEvent) => {
      if (!drag.current) return;
      setOffset({
        x: drag.current.baseX + (ev.clientX - drag.current.startX),
        y: drag.current.baseY + (ev.clientY - drag.current.startY),
      });
    };
    const onUp = () => {
      drag.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // submit=true → paste + Enter (Send). submit=false → paste only (Add to prompt).
  const dispatch = async (submit: boolean) => {
    const text = useStore.getState().richDraftByPane[ptyId] ?? '';
    if (!text.trim()) return;
    await injectText(ptyId, text, submit);
    clearRichDraft(ptyId);
    setPopover(null);
  };

  return (
    <div
      className="pointer-events-auto absolute bottom-full right-2 mb-1 w-[30rem] rounded-[7px] border border-[var(--accent-blue)] bg-[var(--bg-mantle)] shadow-xl z-50 font-mono text-xs"
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      data-testid="rich-input"
    >
      {/* Drag handle / header */}
      <div
        className="flex items-center justify-between px-2.5 py-1.5 border-b border-[var(--bg-surface)] cursor-move select-none rounded-t-[7px] bg-[var(--bg-surface)]"
        onMouseDown={onHeaderMouseDown}
      >
        <span className="text-[var(--text-sub)]">⌨ {t('toolbar.richInput')}</span>
        <button
          data-rich-close
          className="text-[var(--text-muted)] hover:text-[var(--text-main)] px-1 leading-none"
          title={t('toolbar.close')}
          aria-label={t('toolbar.close')}
          onClick={() => setPopover(null)}
        >
          ✕
        </button>
      </div>

      <div className="p-2">
        <textarea
          ref={ref}
          className="ui-input h-52 min-h-[8rem] resize-y"
          placeholder={t('toolbar.richPlaceholder')}
          value={draft}
          onChange={(e) => setRichDraft(ptyId, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); setPopover(null); }
            // Enter inserts a newline (default textarea behavior) — no special-casing.
          }}
        />
        <div className="flex items-center justify-end gap-2 mt-1.5">
          <Button
            variant="secondary"
            disabled={!draft.trim()}
            onClick={() => void dispatch(false)}
          >
            {t('toolbar.addToPrompt')}
          </Button>
          <Button
            variant="primary"
            disabled={!draft.trim()}
            onClick={() => void dispatch(true)}
          >
            {t('toolbar.send')} ▸
          </Button>
        </div>
      </div>
    </div>
  );
}
