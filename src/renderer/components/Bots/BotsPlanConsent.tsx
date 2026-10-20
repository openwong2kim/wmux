// "Bots run on your Claude account" (owner decision 2026-10-15): bots think
// with the Claude Agent SDK on this computer's Claude Code sign-in and their
// workers run the owner's own Claude Code, so turning bots on asks the owner
// to confirm that once per consent version. Main refuses a turn-on without
// it (main/factory/factorySettings.ts); this is the ask.
//
//   on     turning bots on: Turn on bots / Cancel (Cancel changes nothing)
//   keep   bots already on from before the consent (the Bots page asks once
//          when it opens): Keep bots on / Turn bots off; Escape decides later
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import { refreshRoomStatus } from '../../hooks/useRoomSync';
import { BOTS_PLAN_CONSENT_VERSION, hasBotsPlanConsent, type BotsPlanConsent } from '../../../shared/factorySettings';
import type { FactorySettingsPort, FactorySettingsView } from '../Room/factoryPorts';

type T = (key: string, vars?: Record<string, string | number>) => string;

export type BotsPlanConsentMode = 'on' | 'keep';
/** confirm: the primary; cancel: the secondary; dismiss: Escape. */
export type BotsPlanConsentAnswer = 'confirm' | 'cancel' | 'dismiss';

/** The consent the owner gives now (main stamps its own time on it). */
export function botsPlanConsentNow(): BotsPlanConsent {
  return { version: BOTS_PLAN_CONSENT_VERSION, at: new Date().toISOString() };
}

/** The patch that turns bots on: with the consent when `current` has none
 *  at this version, after `confirm` said yes. null: the owner declined. */
export async function botsOnPatch(
  current: Pick<FactorySettingsView, 'planConsent'> | null,
  confirm: () => Promise<boolean>,
): Promise<Partial<FactorySettingsView> | null> {
  if (hasBotsPlanConsent(current)) return { enabled: true };
  return (await confirm()) ? { enabled: true, planConsent: botsPlanConsentNow() } : null;
}

/** Bots on from before the consent: ask once, then record the consent
 *  (Keep bots on) or turn the bots off (Turn bots off). Escape changes
 *  nothing; the page asks again the next time it opens. */
export async function confirmBotsAlreadyOn(
  settings: FactorySettingsPort,
  ask: (mode: BotsPlanConsentMode) => Promise<BotsPlanConsentAnswer>,
  /** Told what the write answered after Turn bots off (it says what work
   *  stopped). */
  onTurnedOff?: (result: unknown) => void,
): Promise<void> {
  if (!settings.available) return;
  const current = await settings.get().catch(() => null);
  if (!current?.enabled || hasBotsPlanConsent(current)) return;
  const answer = await ask('keep');
  if (answer === 'dismiss') return;
  const result = await settings.set(answer === 'confirm' ? { planConsent: botsPlanConsentNow() } : { enabled: false });
  if (answer === 'cancel') {
    onTurnedOff?.(result);
    await refreshRoomStatus();
  }
}

export function BotsPlanConsentDialog({ t, mode, onAnswer }: {
  t: T;
  mode: BotsPlanConsentMode;
  onAnswer: (a: BotsPlanConsentAnswer) => void;
}): ReactElement {
  const keep = mode === 'keep';
  // Focus lands on the text, not a button: a stray Enter answers nothing,
  // while Escape (focus is inside) still closes it.
  const textRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog
      role="alertdialog"
      width={440}
      onClose={() => onAnswer('dismiss')}
      initialFocusRef={textRef}
      data-testid="bots-plan-consent"
    >
      <DialogHeader title={t('botsPage.consent.title')} />
      <DialogBody>
        <div ref={textRef} tabIndex={-1} className="flex flex-col gap-2 text-[13px] leading-snug text-[var(--text-sub)] outline-none">
          <p className="m-0">{t('botsPage.consent.engine')}</p>
          <p className="m-0">{t('botsPage.consent.usage')}</p>
          <p className="m-0">{t('botsPage.consent.terms')}</p>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="md" variant="secondary" data-testid="bots-plan-consent-cancel" onClick={() => onAnswer('cancel')}>
          {t(keep ? 'botsPage.consent.turnOff' : 'botsPage.consent.cancel')}
        </Button>
        <Button size="md" variant="primary" data-testid="bots-plan-consent-confirm" onClick={() => onAnswer('confirm')}>
          {t(keep ? 'botsPage.consent.keepOn' : 'botsPage.consent.turnOn')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** The consent dialog as a promise: `ask(mode)` shows it and resolves with
 *  the answer; `confirmOn()` is the turn-on ask as a yes/no. Render
 *  `dialog` once in the page that asks. */
export function useBotsPlanConsent(t: T): {
  ask: (mode: BotsPlanConsentMode) => Promise<BotsPlanConsentAnswer>;
  confirmOn: () => Promise<boolean>;
  dialog: ReactElement | null;
} {
  const [mode, setMode] = useState<BotsPlanConsentMode | null>(null);
  const pending = useRef<((a: BotsPlanConsentAnswer) => void) | null>(null);
  const answer = useCallback((a: BotsPlanConsentAnswer) => {
    const resolve = pending.current;
    pending.current = null;
    setMode(null);
    resolve?.(a);
  }, []);
  // A page that goes away mid-ask leaves the bots as they were.
  useEffect(() => () => { pending.current?.('dismiss'); pending.current = null; }, []);
  const ask = useCallback((m: BotsPlanConsentMode) => new Promise<BotsPlanConsentAnswer>((resolve) => {
    pending.current?.('dismiss');
    pending.current = resolve;
    setMode(m);
  }), []);
  const confirmOn = useCallback(async () => (await ask('on')) === 'confirm', [ask]);
  return { ask, confirmOn, dialog: mode ? <BotsPlanConsentDialog t={t} mode={mode} onAnswer={answer} /> : null };
}
