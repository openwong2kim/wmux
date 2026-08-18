import { useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { injectText } from './inject';
import Button from '../ui/Button';

export default function SnippetsMenu({ ptyId }: { ptyId: string }) {
  const t = useT();
  const snippets = useStore((s) => s.toolbarSnippets);
  const addSnippet = useStore((s) => s.addSnippet);
  const removeSnippet = useStore((s) => s.removeSnippet);
  const setPopover = useStore((s) => s.setToolbarPopover);
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');

  const insert = (body: string) => {
    void injectText(ptyId, body, false);
    setPopover(null);
  };

  return (
    <div
      className="pointer-events-auto absolute bottom-full left-2 mb-1 w-72 rounded-[7px] border border-[var(--accent-blue)] bg-[var(--bg-mantle)] shadow-xl z-50 p-2 font-mono text-xs"
      data-testid="snippets-menu"
    >
      <div className="max-h-48 overflow-y-auto">
        {snippets.length === 0 && (
          <p className="text-[var(--text-muted)] px-1 py-2">{t('toolbar.snippets')} —</p>
        )}
        {snippets.map((s) => (
          <div key={s.id} className="flex items-center gap-1 group">
            <button
              className="ui-row-ghost flex-1 text-left px-2 py-1 truncate"
              title={s.text}
              onClick={() => insert(s.text)}
            >
              {s.label}
            </button>
            <button
              className="px-1 text-[var(--text-muted)] hover:text-[var(--accent-red)] opacity-0 group-hover:opacity-100"
              title="✕"
              onClick={() => removeSnippet(s.id)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="border-t border-[var(--bg-surface)] mt-2 pt-2 flex flex-col gap-1">
        <input
          className="bg-[var(--bg-base)] border border-[var(--bg-surface)] rounded px-2 py-1"
          placeholder={t('toolbar.snippetLabel')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <textarea
          className="bg-[var(--bg-base)] border border-[var(--bg-surface)] rounded px-2 py-1 resize-none h-14"
          placeholder={t('toolbar.snippetText')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button
          variant="primary"
          className="self-end"
          disabled={!label.trim() || !text.trim()}
          onClick={() => { addSnippet(label.trim(), text.trim()); setLabel(''); setText(''); }}
        >
          {t('toolbar.addSnippet')}
        </Button>
      </div>
    </div>
  );
}
