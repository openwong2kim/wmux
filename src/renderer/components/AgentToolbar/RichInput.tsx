import { useEffect, useRef } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { injectText } from './inject';

export default function RichInput({ ptyId }: { ptyId: string }) {
  const t = useT();
  const draft = useStore((s) => s.richDraftByPane[ptyId] ?? '');
  const setRichDraft = useStore((s) => s.setRichDraft);
  const clearRichDraft = useStore((s) => s.clearRichDraft);
  const setPopover = useStore((s) => s.setToolbarPopover);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { ref.current?.focus(); }, []);

  const send = async () => {
    const text = useStore.getState().richDraftByPane[ptyId] ?? '';
    if (!text.trim()) return;
    await injectText(ptyId, text, true);
    clearRichDraft(ptyId);
    setPopover(null);
  };

  return (
    <div
      className="absolute bottom-full right-2 mb-1 w-96 rounded-lg border border-[var(--accent-blue)] bg-[var(--bg-mantle)] shadow-xl z-50 p-2 font-mono text-xs"
      data-testid="rich-input"
    >
      <textarea
        ref={ref}
        className="w-full h-32 bg-[var(--bg-base)] border border-[var(--bg-surface)] rounded px-2 py-1.5 resize-none outline-none text-[var(--text-main)]"
        placeholder={t('toolbar.richPlaceholder')}
        value={draft}
        onChange={(e) => setRichDraft(ptyId, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); setPopover(null); }
          // Enter inserts a newline (default textarea behavior) — no special-casing.
        }}
      />
      <div className="flex items-center justify-end gap-2 mt-1.5">
        <button
          className="px-3 py-1 rounded bg-[var(--accent-blue)] text-[var(--bg-base)] disabled:opacity-40"
          disabled={!draft.trim()}
          onClick={send}
        >
          {t('toolbar.send')} ▸
        </button>
      </div>
    </div>
  );
}
