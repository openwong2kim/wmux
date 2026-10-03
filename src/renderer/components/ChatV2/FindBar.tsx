// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/features/sessions/ui/TranscriptFind.tsx), MIT License, Copyright (c) 2026 Nick
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Block } from '../../../shared/chatv2/session';
import { findTranscriptBlocks } from './find';
import { S } from './strings';

/** Find in the loaded transcript. Calls `onNavigate` with the selected block id (null on close). */
export function FindBar({ blocks, onNavigate, onClose }: {
  blocks: readonly Block[];
  onNavigate: (blockId: string | null) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = useMemo(() => findTranscriptBlocks(blocks, query), [blocks, query]);
  const index = matches.length ? Math.min(active, matches.length - 1) : -1;
  const selected = index >= 0 ? matches[index] : null;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  useEffect(() => { onNavigate(selected); }, [selected, onNavigate]);

  const step = (direction: number) => {
    if (!matches.length) return;
    setActive((current) => (Math.min(current, matches.length - 1) + direction + matches.length) % matches.length);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  };

  return (
    <div className="wmux-chatv2-find" role="search" aria-label={S.find}>
      <input
        ref={input}
        className="wmux-chatv2-input-line"
        aria-label={S.find}
        placeholder={S.findPlaceholder}
        value={query}
        onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={onKeyDown}
      />
      <span className="wmux-chatv2-find-count" aria-live="polite">{query.trim() ? S.findCount(index + 1, matches.length) : ''}</span>
      <button type="button" className="wmux-chatv2-icon" aria-label={S.findPrev} disabled={!matches.length} onClick={() => step(-1)}>↑</button>
      <button type="button" className="wmux-chatv2-icon" aria-label={S.findNext} disabled={!matches.length} onClick={() => step(1)}>↓</button>
      <button type="button" className="wmux-chatv2-icon" aria-label={S.findClose} onClick={onClose}>✕</button>
    </div>
  );
}
