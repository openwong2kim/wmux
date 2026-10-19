// Adding a bot from the Bots page: the way to the factory's settings (a
// build whose bot port cannot create bots in place), turning the bots on as
// part of adding one, and the create itself.
import { useStore } from '../../stores';
import { refreshRoomStatus } from '../../hooks/useRoomSync';
import type { FactoryBotCreateRequest, FactoryBotCreateResult } from '../../../shared/botCreate';
import type { FactoryBotPort, FactorySettingsPort } from '../Room/factoryPorts';
import { botsOnPatch } from './BotsPlanConsent';

/** The factory's settings page (Settings › Bots), by its tab id. */
export const FACTORY_SETTINGS_TAB = 'factory';

export function openFactorySettings(): void {
  useStore.getState().openSettingsTab(FACTORY_SETTINGS_TAB);
}

/** on: the bots are on. declined: the owner said no to the plan consent
 *  (nothing changed). failed: main did not take it (not started). */
export type TurnBotsOnResult = 'on' | 'declined' | 'failed';

/** Turn the bots on (the setting Settings' switch writes), asking the plan
 *  consent first when it is not stored yet (`confirm`), and re-read the
 *  page's gate. */
export async function turnBotsOn(
  settings: Pick<FactorySettingsPort, 'get' | 'set'>,
  confirm: () => Promise<boolean>,
): Promise<TurnBotsOnResult> {
  const patch = await botsOnPatch(await settings.get().catch(() => null), confirm);
  if (!patch) return 'declined';
  const next = await settings.set(patch);
  await refreshRoomStatus();
  return next?.enabled ? 'on' : 'failed';
}

/** A create right after the bots were turned on may meet a runtime still
 *  starting: it is asked again a few times, briefly. */
const NOT_STARTED_RETRIES = 3;
const NOT_STARTED_WAIT_MS = 400;

/** Create one bot; `not_started` is retried briefly. */
export async function createBot(
  port: Pick<FactoryBotPort, 'create'>,
  req: FactoryBotCreateRequest,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<FactoryBotCreateResult> {
  if (!port.create) return { ok: false, code: 'not_started', message: 'no bot runtime' };
  let r = await port.create(req);
  for (let i = 0; i < NOT_STARTED_RETRIES && !r.ok && r.code === 'not_started'; i += 1) {
    await wait(NOT_STARTED_WAIT_MS);
    r = await port.create(req);
  }
  return r;
}
