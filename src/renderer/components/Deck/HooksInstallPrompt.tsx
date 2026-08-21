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
// TWO refusals, deliberately different in lifetime. Dismissing used to set the
// local phase back to `hidden`, which did not even survive the NEXT trigger in
// the same session: `maybePrompt` re-enters from `hidden`, so raising the agent
// mode after clicking Later showed the identical modal again, and every launch
// asked again forever.
//
//   Later           — unchanged: hide THIS modal, and let trigger 2 ask again.
//                     Raising agent mode IS a fresh reason to care (see above),
//                     and a snooze must not be read as a refusal of a warning
//                     the user has not yet been given in the context where it
//                     matters. Nothing is written to disk.
//   Don't ask again — durable, via main's hooks-prompt.json. Survives restart
//                     and upgrade; cleared from Settings -> integration setup.
//
// The durable preference is re-read on EVERY trigger rather than cached at
// mount, so clearing it in Settings takes effect without a broadcast or a
// restart. Both the read failing and the bridge being too old to have it fall
// back to asking — the store's own default — because a silently muted prompt
// is invisible while an extra prompt is one click to dismiss.
//
// Self-contained IPC via injected api (jsdom-testable), defaulting to
// window.electronAPI.deck.hooksBridge in the container.

import { useCallback, useEffect, useRef, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';

export const HOOKS_PROMPT_EVENT = 'wmux:hooks-install-prompt';

export interface HooksBridgeApi {
  status: () => Promise<{ installed: boolean }>;
  install: () => Promise<{ ok: boolean; error: string | null }>;
  /** Durable "Don't ask again". Optional: a renderer running against an older
   *  preload keeps the previous ask-every-time behaviour rather than crashing. */
  getPromptPreference?: () => Promise<{ suppressed: boolean }>;
  setPromptPreference?: (suppressed: boolean) => Promise<{ suppressed: boolean }>;
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
  // Which failure the error line is describing. The install failing and the
  // durable refusal failing to save are different problems and must not share
  // one message.
  const [errorKind, setErrorKind] = useState<'install' | 'never' | null>(null);

  // The last durable answer we actually READ. Not a short-circuit: a refusal
  // must never stop us consulting the disk, or Settings -> "Ask again" would be
  // dead until the next launch — the reversal this whole change advertises.
  // It is consulted ONLY when a read fails, so a transient IPC error cannot
  // resurrect a refusal the user already gave. `null` = never read one.
  const lastKnownSuppressedRef = useRef<boolean | null>(null);

  // Monotonic id for the preference read. The epoch below orders reads against
  // ANSWERS; this orders them against each other. Two triggers with no dismissal
  // between them can resolve out of order, and without this the older read wins
  // the cache: a launch read issued before a Settings clear could overwrite the
  // fresh `false` with its stale `true`, and the next failed read would then
  // stand on it and stay quiet when it should ask.
  const prefSeqRef = useRef(0);

  // Bumped by every dismissal. A status probe that was already in flight when
  // the user answered must not reopen the modal on top of that answer: two
  // triggers can overlap, and the loser used to win by resolving last.
  const dismissEpochRef = useRef(0);

  // True while the durable refusal is being written. Distinct from
  // `installing` — same "no second action mid-write" rule, different label.
  const [savingRefusal, setSavingRefusal] = useState(false);
  const busy = phase === 'installing' || savingRefusal;

  // Both triggers funnel here: consult the durable refusal, then verify hooks
  // are actually missing, then show. Status errors fail-soft to "don't prompt"
  // — a broken status check must never nag a user whose hooks are fine.
  const maybePrompt = useCallback(() => {
    const epoch = dismissEpochRef.current;
    const seq = ++prefSeqRef.current;
    const checkStatus = () =>
      api
        .status()
        .then((s) => {
          if (s.installed) return;
          // Answered while this was in flight — that answer stands.
          if (dismissEpochRef.current !== epoch) return;
          setPhase((p) => (p === 'hidden' ? 'prompt' : p));
        })
        .catch(() => {});
    // Older preload: no durable preference to consult, behave as before.
    if (!api.getPromptPreference) {
      void checkStatus();
      return;
    }
    api
      .getPromptPreference()
      .then((pref) => {
        // Superseded by a newer read — that one owns the cache and will run
        // its own status check, so this result is not just stale, it is noise.
        if (seq !== prefSeqRef.current) return;
        // This read STARTED before the user answered, so what it saw may be
        // what the answer has since overwritten. Caching it would poison the
        // fallback below: a later failed read would then stand on `false` and
        // re-nag someone who had already refused durably.
        if (dismissEpochRef.current !== epoch) return;
        lastKnownSuppressedRef.current = pref.suppressed;
        return pref.suppressed ? undefined : checkStatus();
      })
      .catch(() => {
        if (seq !== prefSeqRef.current) return;
        // The user answered while this read was failing. Their answer stands,
        // and probing status here would be an IPC call whose result is already
        // guaranteed to be discarded.
        if (dismissEpochRef.current !== epoch) return;
        // Read failed. Only ASK when we have never successfully read an answer;
        // otherwise stand on the last one, so an IPC hiccup cannot re-nag
        // someone who already refused.
        if (lastKnownSuppressedRef.current === true) return;
        void checkStatus();
      });
  }, [api]);

  /** Every dismissal that is not a durable refusal — Later, the backdrop, and
   *  the post-install Close. Hides this one modal and nothing more.
   *  Deliberately NOT a session mute — trigger 2 is the moment the missing
   *  hooks become operationally true, and the user who wants silence has the
   *  button next to this one. */
  const dismissNow = useCallback(() => {
    dismissEpochRef.current += 1;
    setPhase('hidden');
  }, []);

  /** Durable dismissal. Stays open on a write failure: a refusal reported as
   *  saved but never persisted would silently re-nag on the next launch. */
  const neverAsk = useCallback(() => {
    // Unreachable from the UI — the button is not rendered without the bridge —
    // but never silently pretend to persist if that ever changes.
    if (!api.setPromptPreference) return;
    setSavingRefusal(true);
    api
      .setPromptPreference(true)
      .then((pref) => {
        setSavingRefusal(false);
        if (pref.suppressed) {
          lastKnownSuppressedRef.current = true;
          dismissEpochRef.current += 1;
          setPhase('hidden');
          return;
        }
        setErrorKind('never');
        setErrorDetail(null);
        setPhase('error');
      })
      .catch((err: unknown) => {
        setSavingRefusal(false);
        setErrorKind('never');
        setErrorDetail(err instanceof Error ? err.message : null);
        setPhase('error');
      });
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
          setErrorKind('install');
          setErrorDetail(r.error);
          setPhase('error');
        }
      })
      .catch(() => {
        setErrorKind('install');
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
        // Same lifetime as Later: this session only.
        if (e.target === e.currentTarget && !busy) dismissNow();
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
                onClick={dismissNow}
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
                {errorKind === 'never'
                  ? t('hooks.prompt.neverError') ||
                    'Could not save that preference, so this prompt would return on the next launch.'
                  : t('hooks.prompt.error') || 'Install failed.'}
                {errorDetail ? ` ${errorDetail}` : ''}
              </p>
            )}
            <div className="flex justify-end gap-2">
              {/* Only offered when it can actually persist. On an older
                  preload this control could not do what its label promises,
                  and a durable-looking button that silently acts as Later is
                  worse than no button. */}
              {api.setPromptPreference && (
              <button
                type="button"
                data-hooks-never
                disabled={busy}
                onClick={neverAsk}
                className={`px-3 py-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-50 ${FOCUS_RING}`}
              >
                {t('hooks.prompt.never') || "Don't ask again"}
              </button>
              )}
              <button
                type="button"
                data-hooks-later
                disabled={busy}
                onClick={dismissNow}
                className={`px-3 py-1 rounded-md text-[var(--text-sub)] hover:text-[var(--text-main)] disabled:opacity-50 ${FOCUS_RING}`}
              >
                {t('hooks.prompt.later') || 'Later'}
              </button>
              <button
                type="button"
                data-hooks-install
                disabled={busy}
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
