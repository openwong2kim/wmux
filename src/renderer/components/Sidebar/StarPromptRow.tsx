import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { HIT_TARGET_24 } from '../hitArea';
import { IconStar, IconX } from '../icons';
import { anyAgentReady } from '../../../shared/agentSetup';
import { starPromptEligible } from '../../../shared/starPrompt';
import { useAgentSetup } from '../../utils/agentSetupRuns';
import { checkStarredOnce, runStarAction } from '../../utils/starPrompt';

/** How long "Starred — thank you" stays before the row goes for good. */
export const STAR_THANKS_MS = 2_500;

/**
 * "Enjoying wmux? · Star on GitHub ×": one muted row at the sidebar's foot,
 * the only place wmux asks for a star (owner-approved 2026-10-21; rules in
 * shared/starPrompt.ts). Neutral text, no fill, no accent: nothing is waiting
 * on the user.
 *
 * Below "Agent not set up" in priority: it shows only once the agent check
 * has run and found an agent ready, so the two rows never show together and
 * the star row never flashes in before the setup row. Right before it first
 * shows in an app session, gh is asked (only when signed in) whether wmux is
 * already starred; a yes ends the prompt without showing it.
 */
export default function StarPromptRow() {
  const t = useT();
  const { statuses } = useAgentSetup();
  const paneGate = useStore((s) => s.paneGate);
  const starPrompt = useStore((s) => s.starPrompt);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [thanking, setThanking] = useState(false);

  // The time half of the rule is read at render: the sidebar re-renders often
  // enough, and no timer may wake the app for this.
  const eligible = paneGate === 'ready'
    && statuses !== null && anyAgentReady(statuses)
    && starPromptEligible(starPrompt, Date.now());

  useEffect(() => {
    if (!eligible) return;
    let live = true;
    void checkStarredOnce().then(() => { if (live) setChecked(true); });
    return () => { live = false; };
  }, [eligible]);

  useEffect(() => {
    if (!thanking) return;
    const timer = setTimeout(() => setThanking(false), STAR_THANKS_MS);
    return () => clearTimeout(timer);
  }, [thanking]);

  if (thanking) {
    return (
      <div className="wmux-star-prompt" role="status" data-testid="sidebar-star-prompt-thanks">
        <span className="wmux-star-prompt-glyph" aria-hidden="true"><IconStar size={12} /></span>
        <span className="wmux-star-prompt-text">{t('starPrompt.thanks')}</span>
      </div>
    );
  }
  if (!eligible || !checked) return null;

  const star = async () => {
    if (busy) return;
    setBusy(true);
    const result = await runStarAction();
    setBusy(false);
    if (result === 'starred') setThanking(true);
  };

  return (
    <div className="wmux-star-prompt" data-testid="sidebar-star-prompt" aria-busy={busy || undefined}>
      <span className="wmux-star-prompt-glyph" aria-hidden="true"><IconStar size={12} /></span>
      <span className="wmux-star-prompt-text">{t('starPrompt.enjoying')}</span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        className={`wmux-star-prompt-action ${FOCUS_RING}`}
        onClick={() => { void star(); }}
        disabled={busy}
        data-testid="sidebar-star-prompt-star"
      >
        {t('starPrompt.star')}
      </button>
      <button
        type="button"
        className={`wmux-star-prompt-dismiss ${HIT_TARGET_24} ${FOCUS_RING}`}
        onClick={() => useStore.getState().dismissStarPrompt(Date.now())}
        disabled={busy}
        aria-label={t('starPrompt.notNow')}
        title={t('starPrompt.notNow')}
        data-testid="sidebar-star-prompt-dismiss"
      >
        <IconX size={10} />
      </button>
    </div>
  );
}
