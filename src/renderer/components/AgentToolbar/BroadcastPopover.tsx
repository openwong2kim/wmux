// ─── Broadcast popover────────────────────────────────────────────────────────
//
// Injects the same text simultaneously into every terminal surface in the active
// workspace (including plain, non-agent shells). It used to prompt via window.prompt,
// but there's no prompt polyfill in preload, so it was effectively dead (Electron) —
// restored as an inline recessed popover.
//
// Scope stays as-is: "every terminal pane in the current workspace" (no isolation or
// worktree creation like fan-out). The target count is shown up front as
// "N terminals" so it isn't misread as "fleet only" (Codex review). Sends are wrapped
// in Promise.allSettled so that one pane failing doesn't stop the rest, and a
// success/failure count is displayed.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { selectActiveWorkspace } from '../../stores/selectors/workspaceProjections';
import { useT } from '../../hooks/useT';
import { findLeafPanes } from '../../hooks/a2aAddressing';
import type { Workspace } from '../../../shared/types';
import { injectText } from './inject';

interface BroadcastPopoverProps {
  onClose: () => void;
  /** The trigger button — excluded from the outside-click test so its own click can toggle (not double-toggle). */
  triggerRef?: React.RefObject<HTMLElement | null>;
}

/** Collect every terminal surface ptyId in the active workspace without duplicates (pure — for tests). */
export function collectBroadcastPtyIds(workspace: Workspace): string[] {
  const seen = new Set<string>();
  for (const leaf of findLeafPanes(workspace.rootPane)) {
    for (const s of leaf.surfaces) {
      if (s.ptyId && (s.surfaceType ?? 'terminal') === 'terminal') seen.add(s.ptyId);
    }
  }
  return [...seen];
}

export default function BroadcastPopover({ onClose, triggerRef }: BroadcastPopoverProps): React.ReactElement {
  const t = useT();
  const activeWorkspace = useStore(selectActiveWorkspace);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: number; fail: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Prevent double submit: React state is async, so a second click in the same tick
  // sees a stale `sending` and slips through — lock it with a synchronous ref.
  const sendingRef = useRef(false);

  const ptyIds = useMemo(
    () => (activeWorkspace ? collectBroadcastPtyIds(activeWorkspace) : []),
    [activeWorkspace],
  );

  // Focus the textarea on open.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Close on Esc / outside click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      // The trigger button lives outside this popover; if we treated a click on it
      // as "outside" we'd close here on mousedown and the button's own onClick would
      // immediately re-toggle it back open. Exclude it and let onClick own the toggle.
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose, triggerRef]);

  const handleSend = useCallback(async () => {
    if (sendingRef.current) return;
    const body = text.trim();
    if (body.length === 0 || ptyIds.length === 0) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const settled = await Promise.allSettled(ptyIds.map((id) => injectText(id, text, true)));
      const ok = settled.filter((r) => r.status === 'fulfilled').length;
      setResult({ ok, fail: settled.length - ok });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [text, ptyIds]);

  const targetCount = ptyIds.length;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t('toolbar.broadcastTitle')}
      data-testid="broadcast-popover"
      className="pointer-events-auto absolute bottom-full right-2 mb-2 z-50 w-80 rounded-[7px] border border-[var(--bg-overlay)] bg-[var(--bg-mantle)] p-3 shadow-xl"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] font-semibold text-[var(--text-main)]">{t('toolbar.broadcastTitle')}</span>
        <span className="text-[10px] text-[var(--text-muted)]" data-testid="broadcast-targets">
          {t('toolbar.broadcastTargets', { n: targetCount })}
        </span>
      </div>
      <textarea
        ref={textareaRef}
        className="ui-input h-20 resize-none font-mono text-[12px]"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Send with ⌘/Ctrl+Enter (plain Enter inserts a newline).
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void handleSend();
          }
        }}
        placeholder={t('toolbar.broadcastPlaceholder')}
        data-testid="broadcast-input"
      />
      <div className="flex items-center justify-between mt-2">
        <span className="text-[10px] text-[var(--text-muted)]" data-testid="broadcast-result">
          {result ? t('toolbar.broadcastResult', { ok: result.ok, fail: result.fail }) : ''}
        </span>
        <button
          type="button"
          disabled={sending || targetCount === 0 || text.trim().length === 0}
          onClick={() => void handleSend()}
          data-testid="broadcast-send"
          className="px-2.5 py-1 rounded-[5px] text-[11px] font-semibold bg-[var(--accent)] text-[var(--bg-base)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {sending ? t('toolbar.broadcastSending') : t('toolbar.broadcastSend')}
        </button>
      </div>
    </div>
  );
}
