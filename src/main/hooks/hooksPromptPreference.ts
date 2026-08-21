// ─── Durable "don't ask again" for the hook-install prompt ───────────────────
//
// The prompt (renderer: Deck/HooksInstallPrompt) fires on TWO triggers — app
// launch with hooks missing, and every raise of agent mode off → assist/danger.
// Dismissing it only ever set the component's local phase back to `hidden`,
// which is process-local AND does not survive the next trigger: `maybePrompt`
// re-enters from `hidden`, so raising the mode after clicking "Later" showed
// the same modal again inside one session. An operator who has decided not to
// install hooks had no way to say so, and said no again on every launch.
//
// Two refusals, deliberately different in lifetime:
//   Later           — the rest of THIS app session. Renderer-local; nothing is
//                     written to disk, and the next launch asks again.
//   Don't ask again — durable. Stored here, survives restart and upgrade, and
//                     is reversible from Settings → integration setup.
//
// Only the durable half needs main. One JSON file (`hooks-prompt.json`) in the
// wmux data dir, atomic-written and WMUX_DATA_SUFFIX-isolated — the same
// storage shape as deck-autonomy.json / deck-schedules.json.
//
// DEFAULT ON DOUBT IS "ASK", where doubt means "no trustworthy answer survives".
// A missing file, an unparsable one with nothing behind it, a non-object, or
// anything that is not a literal `true` resolves to `suppressed: false`: a
// corrupt store resurrects the prompt rather than silently disabling onboarding
// for someone who never asked for that. The recovery is one click; the opposite
// failure is invisible.
//
// A torn primary WITH a valid `.bak` is deliberately NOT doubt.
// `atomicReadJSONSync` walks `BACKUP_SUFFIXES` when the primary yields nothing,
// and that backup is the last value the operator actually chose — recovering it
// is the entire point of writing one. Re-asking there would discard a real
// refusal because of an unrelated write tear, which is the regression the
// backup exists to prevent. Pinned by a test, because the mismatch between this
// paragraph and a naive reading of "torn resolves to ask" is exactly what an
// automated reviewer flagged.

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';

export interface HooksPromptPreference {
  /** True once the operator chose "Don't ask again". Never set by any
   *  automatic path — only by that explicit click, or cleared from Settings. */
  suppressed: boolean;
}

/** The posture every uncertain read falls back to. */
export const DEFAULT_HOOKS_PROMPT_PREFERENCE: HooksPromptPreference = { suppressed: false };

export function getHooksPromptPreferencePath(dir?: string): string {
  return path.join(dir ?? getWmuxDir(), 'hooks-prompt.json');
}

/** Read the stored preference. Never throws; any doubt resolves to "ask". */
export function loadHooksPromptPreference(dir?: string): HooksPromptPreference {
  let raw: unknown;
  try {
    raw = atomicReadJSONSync<unknown>(getHooksPromptPreferencePath(dir));
  } catch {
    return { ...DEFAULT_HOOKS_PROMPT_PREFERENCE };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_HOOKS_PROMPT_PREFERENCE };
  }
  const suppressed = (raw as Record<string, unknown>).suppressed;
  // Only a literal `true` suppresses. A string "true", a 1, or a future field
  // shape must not silently mute the prompt.
  return { suppressed: suppressed === true };
}

/** Write the stored preference. Returns what a subsequent read will resolve to,
 *  so the caller can echo the effective state instead of assuming the write
 *  landed. Propagates write errors — the renderer surfaces the failure rather
 *  than showing a refusal that was never persisted. */
export async function setHooksPromptSuppressed(
  suppressed: boolean,
  dir?: string,
): Promise<HooksPromptPreference> {
  const next: HooksPromptPreference = { suppressed };
  await atomicWriteJSON(getHooksPromptPreferencePath(dir), next);
  return next;
}
