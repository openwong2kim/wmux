// ─── Claude Code hook-bridge install prompt ──────────────────────────────────
//
// Completion/approval detection is HOOK-PRIMARY: without the wmux hook bridge
// every lifecycle signal degrades to the regex detector, which can miss a real
// stop behind a TUI redraw ("the orchestrator never noticed my agent finished").
// wmux deliberately does NOT edit ~/.claude/settings.json behind the operator's
// back (owner decision 2026-07-17) — instead this ONE modal nudges at the two
// moments the gap actually bites:
//
//   1. App launch: hooks missing → prompt once per session.
//   2. Agent mode raised off → assist/auto: the orchestrator is about to rely
//      on lifecycle signals, so the same prompt fires again (even if it was
//      dismissed at launch — raising the mode is a fresh reason to care).
//
// Mounted ONCE (AppLayout). Both triggers arrive via a window CustomEvent so
// the mode chip doesn't need to own modal state or an extra prop chain:
//   window.dispatchEvent(new CustomEvent('wmux:hooks-install-prompt'))
//
// Self-contained IPC via injected api (jsdom-testable), defaulting to
// window.electronAPI.deck.hooksBridge in the container.

import { useCallback, useEffect, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';

export const HOOKS_PROMPT_EVENT = 'wmux:hooks-install-prompt';

export interface HooksBridgeApi {
  status: () => Promise<{ installed: boolean }>;
  install: () => Promise<{ ok: boolean; error: string | null }>;
}

/** Fire the shared prompt (no-op if hooks are already installed — the mounted
 *  prompt re-checks status before showing). */
export function requestHooksInstallPrompt(): void {
  window.dispatchEvent(new CustomEvent(HOOKS_PROMPT_EVENT));
}

type Phase = 'hidden' | 'prompt' | 'installing' | 'done' | 'error';

export function HooksInstallPrompt({
  api,
  t,
  checkOnMount = true,
}: {
  api: HooksBridgeApi;
  t: (key: string) => string;
  /** The launch-time check. Disable in tests that only exercise the event path. */
  checkOnMount?: boolean;
}): React.ReactElement | null {
  const [phase, setPhase] = useState<Phase>('hidden');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  // Both triggers funnel here: verify hooks are actually missing, then show.
  // Status errors fail-soft to "don't prompt" — a broken status check must
  // never nag a user whose hooks are fine.
  const maybePrompt = useCallback(() => {
    api
      .status()
      .then((s) => {
        if (!s.installed) setPhase((p) => (p === 'hidden' ? 'prompt' : p));
      })
      .catch(() => {});
  }, [api]);

  useEffect(() => {
    if (checkOnMount) maybePrompt();
  }, [checkOnMount, maybePrompt]);

  useEffect(() => {
    const onRequest = () => maybePrompt();
    window.addEventListener(HOOKS_PROMPT_EVENT, onRequest);
    return () => window.removeEventListener(HOOKS_PROMPT_EVENT, onRequest);
  }, [maybePrompt]);

  const install = useCallback(() => {
    setPhase('installing');
    api
      .install()
      .then((r) => {
        if (r.ok) {
          setPhase('done');
        } else {
          setErrorDetail(r.error);
          setPhase('error');
        }
      })
      .catch(() => {
        setErrorDetail(null);
        setPhase('error');
      });
  }, [api]);

  if (phase === 'hidden') return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
      data-hooks-install-prompt
      onClick={(e) => {
        // Backdrop dismiss — but never mid-install (the write is in flight).
        if (e.target === e.currentTarget && phase !== 'installing') setPhase('hidden');
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('hooks.prompt.title') || 'Install wmux hooks'}
        className="w-[420px] max-w-[90vw] bg-[var(--bg-overlay)] border border-[var(--bg-surface)] rounded-lg shadow-xl p-4 text-[13px] text-[var(--text-main)]"
        {...tokenAttrs('textMain', 'text')}
      >
        {phase === 'done' ? (
          <>
            <div className="font-semibold mb-2">{t('hooks.prompt.doneTitle') || 'Hooks installed'}</div>
            <p className="text-[var(--text-sub)] mb-3">
              {t('hooks.prompt.doneBody') ||
                'Restart the Claude sessions in your panes to activate the hooks.'}
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                data-hooks-close
                onClick={() => setPhase('hidden')}
                className={`px-3 py-1 rounded-md bg-[var(--accent)] text-[var(--bg-base)] font-semibold hover:opacity-90 ${FOCUS_RING}`}
              >
                {t('hooks.prompt.close') || 'Close'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="font-semibold mb-2">
              {t('hooks.prompt.title') || 'Install wmux hooks for accurate agent signals'}
            </div>
            <p className="text-[var(--text-sub)] mb-2">
              {t('hooks.prompt.body') ||
                'Without hooks, wmux falls back to screen-reading to guess when an agent finishes — it can miss completions and approvals. Installing the hook bridge into your Claude Code settings makes these signals exact.'}
            </p>
            {phase === 'error' && (
              <p className="text-[var(--accent)] mb-2" data-hooks-error>
                {t('hooks.prompt.error') || 'Install failed.'}
                {errorDetail ? ` ${errorDetail}` : ''}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-hooks-later
                disabled={phase === 'installing'}
                onClick={() => setPhase('hidden')}
                className={`px-3 py-1 rounded-md text-[var(--text-sub)] hover:text-[var(--text-main)] disabled:opacity-50 ${FOCUS_RING}`}
              >
                {t('hooks.prompt.later') || 'Later'}
              </button>
              <button
                type="button"
                data-hooks-install
                disabled={phase === 'installing'}
                onClick={install}
                className={`px-3 py-1 rounded-md bg-[var(--accent)] text-[var(--bg-base)] font-semibold hover:opacity-90 disabled:opacity-50 ${FOCUS_RING}`}
              >
                {phase === 'installing'
                  ? t('hooks.prompt.installing') || 'Installing…'
                  : t('hooks.prompt.install') || 'Install hooks'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Container: binds the preload bridge; renders nothing on older preloads. */
export function HooksInstallPromptContainer({
  t,
}: {
  t: (key: string) => string;
}): React.ReactElement | null {
  const api = (window as unknown as {
    electronAPI?: { deck?: { hooksBridge?: HooksBridgeApi } };
  }).electronAPI?.deck?.hooksBridge;
  if (!api) return null;
  return <HooksInstallPrompt api={api} t={t} />;
}
