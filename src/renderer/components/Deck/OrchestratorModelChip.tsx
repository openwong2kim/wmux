// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/features/sessions/ui/ModelPicker.tsx), MIT License, Copyright (c) 2026 Nick
// The chip is the filled 26px picker chip with a turning chevron; the menu is
// a 12px popover with rounded-lg rows.
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
import { IconCheck, IconChevron } from '../icons';
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
        className={`ui-chip-boxless inline-flex h-[26px] max-w-[160px] items-center gap-1 px-1.5 text-[11px] ${FOCUS_RING}`}
        {...tokenAttrs('textMain', 'text')}
      >
        <span className="truncate">{model === '' ? t('deck.orchestratorModelDefault') : claudeModelLabel(model)}</span>
        <span
          aria-hidden="true"
          className={`inline-flex shrink-0 text-[color-mix(in_srgb,var(--text-main)_50%,transparent)] transition-transform ${open ? '-rotate-90' : 'rotate-90'}`}
        >
          <IconChevron size={12} />
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t('deck.orchestratorModelTitle')}
          // 컨트롤 바(하단)에 살 땐 위로 열어 composer를 덮지 않게 한다.
          className={`absolute right-0 ${openUp ? 'bottom-full mb-1' : 'top-full mt-1'} z-50 min-w-[160px] rounded-xl border border-[var(--line)] bg-[var(--bg-base)] shadow-[var(--shadow-popover)] p-1.5`}
          {...tokenAttrs('bgBase', 'bg')}
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
                className={`flex items-center justify-between w-full rounded-lg px-2 py-1.5 text-left text-[13px] text-[var(--text-main)] transition-colors ${
                  sel ? 'bg-[var(--selection)]' : 'hover:bg-[var(--selection)]'
                }`}
              >
                <span>{o.value === '' ? t('deck.orchestratorModelDefault') : o.label}</span>
                {sel && (
                  <span aria-hidden="true" className="inline-flex text-[var(--accent)]" {...tokenAttrs('accent', 'text')}>
                    <IconCheck size={14} />
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
