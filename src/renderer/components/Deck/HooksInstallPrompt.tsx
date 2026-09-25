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
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import type { HooksLaunchCheck } from '../Layout/firstBootSequence';

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
  launchCheck = 'check',
  deferred = false,
}: {
  api: HooksBridgeApi;
  t: (key: string) => string;
  /** The launch-time check. Disable in tests that only exercise the event path. */
  checkOnMount?: boolean;
  /** When the launch-time check may run (see hooksLaunchCheck): `wait` holds
   *  it until the first-run probe settles, `skip` drops it for this boot. It
   *  runs at most once either way. */
  launchCheck?: HooksLaunchCheck;
  /** Another first-boot dialog (the first-run wizard) owns the screen. The
   *  initial ask stays pending and is re-checked once this clears, instead of
   *  opening on top. An install or refusal already in flight stays visible. */
  deferred?: boolean;
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
        .catch(() => {
          // Fail-soft: a broken status check must never nag a user whose hooks
          // are fine.
        });
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

  // One launch check per mount, and only once the gate opens: a fresh profile
  // mounts this before the first-run probe knows the wizard is coming.
  const launchCheckDoneRef = useRef(false);
  useEffect(() => {
    if (!checkOnMount || launchCheckDoneRef.current || launchCheck === 'wait') return;
    launchCheckDoneRef.current = true;
    if (launchCheck === 'check') maybePrompt();
  }, [checkOnMount, launchCheck, maybePrompt]);

  // Deferral ended with an ask still pending: that ask is as old as the
  // wizard, which can install the hooks itself (or the user can refuse in
  // Settings meanwhile). Drop it and ask again from fresh status/preference.
  const wasDeferredRef = useRef(deferred);
  useEffect(() => {
    const was = wasDeferredRef.current;
    wasDeferredRef.current = deferred;
    if (!was || deferred || phase !== 'prompt') return;
    setPhase('hidden');
    maybePrompt();
  }, [deferred, phase, maybePrompt]);

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

  if (phase === 'hidden' || (deferred && phase === 'prompt')) return null;

  // Later, Escape, the backdrop and the post-install Close share one
  // lifetime (this modal only) — and none of them works mid-write.
  //
  // It opens by itself after an async check at launch or on a mode change, so
  // it leaves focus where the user is: a Space or Enter typed into a terminal
  // must not press Don't ask again (a durable refusal) or Install unseen.
  // Escape applies once focus is inside it.
  const dismissIfIdle = () => {
    if (!busy) dismissNow();
  };

  return (
    <div className="contents" data-hooks-install-prompt>
      <Dialog onClose={dismissIfIdle} closeOnBackdrop focusOnOpen="none" width={440}>
        {phase === 'done' ? (
          <>
            <DialogHeader
              title={t('hooks.prompt.doneTitle') || 'Hooks installed'}
              description={
                t('hooks.prompt.doneBody') ||
                'Restart the Claude sessions in your panes to activate the hooks.'
              }
            />
            <DialogFooter className="pt-5">
              <Button size="md" variant="primary" data-hooks-close onClick={dismissNow}>
                {t('hooks.prompt.close') || 'Close'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader
              title={t('hooks.prompt.title') || 'Install wmux hooks for accurate agent signals'}
            />
            <DialogBody className="!gap-2">
              <p className="m-0 text-[13px] leading-5 text-[var(--text-sub)]">
                {t('hooks.prompt.body') ||
                  'Without hooks, wmux falls back to screen-reading to guess when an agent finishes — it can miss completions and approvals. Installing the hook bridge into your Claude Code settings makes these signals exact.'}
              </p>
              {phase === 'error' && (
                <p className="ui-row-error text-[13px] leading-5" role="alert" data-hooks-error>
                  {errorKind === 'never'
                    ? t('hooks.prompt.neverError') ||
                      'Could not save that preference, so this prompt would return on the next launch.'
                    : t('hooks.prompt.error') || 'Install failed.'}
                  {errorDetail ? ` ${errorDetail}` : ''}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              {/* Only offered when it can actually persist. On an older
                  preload this control could not do what its label promises,
                  and a durable-looking button that silently acts as Later is
                  worse than no button. */}
              {api.setPromptPreference && (
                <Button
                  size="md"
                  variant="ghost"
                  className="mr-auto"
                  data-hooks-never
                  disabled={busy}
                  onClick={neverAsk}
                >
                  {t('hooks.prompt.never') || "Don't ask again"}
                </Button>
              )}
              <Button size="md" variant="secondary" data-hooks-later disabled={busy} onClick={dismissNow}>
                {t('hooks.prompt.later') || 'Later'}
              </Button>
              {/* In flight it is not the primary: nothing to press until the
                  write returns. */}
              <Button
                size="md"
                variant={phase === 'installing' ? 'secondary' : 'primary'}
                data-hooks-install
                disabled={busy}
                onClick={install}
              >
                {phase === 'installing'
                  ? t('hooks.prompt.installing') || 'Installing…'
                  : t('hooks.prompt.install') || 'Install hooks'}
              </Button>
            </DialogFooter>
          </>
        )}
      </Dialog>
    </div>
  );
}

/** Container: binds the preload bridge; renders nothing on older preloads. */
export function HooksInstallPromptContainer({
  t,
  launchCheck,
  deferred,
}: {
  t: (key: string) => string;
  launchCheck?: HooksLaunchCheck;
  deferred?: boolean;
}): React.ReactElement | null {
  const api = (window as unknown as {
    electronAPI?: { deck?: { hooksBridge?: HooksBridgeApi } };
  }).electronAPI?.deck?.hooksBridge;
  if (!api) return null;
  return <HooksInstallPrompt api={api} t={t} launchCheck={launchCheck} deferred={deferred} />;
}
