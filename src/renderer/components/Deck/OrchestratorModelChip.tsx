// ─── Orchestrator model chip ────────────────────────────────────────────────
//
// A compact badge in the deck header showing which model the orchestrator brain
// runs as, with an inline picker on click — so the current model is visible
// right next to the orchestrator's name and switchable without digging through
// Settings. The value is the same store field the Settings picker writes
// (`deckBrainModel`, a claude alias; '' = the subscription default), applied
// between turns (main swaps the brain adapter on the next send; the session id
// persists the conversation). See SettingsPanel's OrchestratorSection.
//
// Color: the model name is informational, so it stays in the muted/sub tones —
// amber is reserved for "alive + focus" (DESIGN.md). Only the selected row in
// the open popover gets a single small accent dot (that IS a focus mark).

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { CLAUDE_MODEL_OPTIONS, claudeModelLabel, type ClaudeModelOption } from '../../../shared/claudeModels';

// The list lives in shared/claudeModels (one source for every Claude picker).
// Re-exported under the old name so DeckTabs / ChannelDock keep their import.
export const MODEL_OPTIONS: readonly ClaudeModelOption[] = CLAUDE_MODEL_OPTIONS;

export function OrchestratorModelChip({ openUp = false }: { openUp?: boolean } = {}): React.ReactElement {
  const t = useT();
  const model = useStore((s) => s.deckBrainModel);
  const setModel = useStore((s) => s.setDeckBrainModel);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);


  return (
    <div ref={ref} className="relative" data-orchestrator-model-chip>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('deck.orchestratorModelTitle')}
        data-model-chip-button
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-[var(--text-sub)] hover:text-[var(--text-main)] transition-colors ${FOCUS_RING}`}
        {...tokenAttrs('textSub', 'text')}
      >
        <span>{model === '' ? t('deck.orchestratorModelDefault') : claudeModelLabel(model)}</span>
        <span aria-hidden="true" className="text-[10px] opacity-70">▾</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t('deck.orchestratorModelTitle')}
          // 컨트롤 바(하단)에 살 땐 위로 열어 composer를 덮지 않게 한다.
          className={`absolute right-0 ${openUp ? 'bottom-full mb-1' : 'top-full mt-1'} z-50 min-w-[128px] rounded-md border py-1 shadow-lg bg-[var(--bg-surface)]`}
          style={{ borderColor: 'var(--border-soft)' }}
          {...tokenAttrs('bgSurface', 'bg')}
        >
          {MODEL_OPTIONS.map((o) => {
            const sel = o.value === model;
            return (
              <button
                key={o.value || 'default'}
                type="button"
                role="option"
                aria-selected={sel}
                onClick={() => {
                  setModel(o.value);
                  setOpen(false);
                }}
                className={`flex items-center justify-between w-full px-2.5 py-1 text-left text-[11px] transition-colors ${
                  sel
                    ? 'text-[var(--text-main)] font-semibold'
                    : 'text-[var(--text-sub)] hover:text-[var(--text-main)]'
                }`}
              >
                <span>{o.value === '' ? t('deck.orchestratorModelDefault') : o.label}</span>
                {sel && (
                  <span
                    aria-hidden="true"
                    className="text-[var(--accent-blue)] text-[10px]"
                    {...tokenAttrs('accent', 'text')}
                  >
                    ●
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default OrchestratorModelChip;
