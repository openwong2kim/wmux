// ─── Binding a bot to My Hermes (FACTORY_BOT_SET_ENGINE, FACTORY_BOT_CREATE) ─
//
// What main checks before a bot is bound to one of the owner's own Hermes
// profiles, and the native confirm main itself shows (never a renderer
// dialog): v1 runs on macOS and Linux only, the profile must exist, one bot
// per profile (the store refuses a second too, botStore.ts), and a bot on My
// Hermes talks with the owner one to one, so a bot in a group chat is not
// moved there (groupStore.ts refuses the other direction).

import os from 'node:os';
import { dialog, type BrowserWindow } from 'electron';
import { isHermesProfileName } from '../../shared/bot';
import { myHermesProfileLabel, type MyHermesStatus } from '../../shared/hermesEngine';
import type { BotGroup } from '../../shared/botGroup';
import { getAutomationUiLocale } from '../automation/AutomationBridge';
import type { AutomationUiLocale } from '../automation/toastText';
import type { BotStore } from './botStore';
import { myHermesInUseMessage } from './botStore';
import { myHermesNoGroupMessage } from './groupStore';
import { listMyHermesProfiles, myHermesReadinessCached, type MyHermesReadinessDeps } from './myHermes';

export interface MyHermesBindDeps {
  platform?: NodeJS.Platform;
  home?: string;
  /** The owner's profiles (default: listMyHermesProfiles over `home`). */
  profiles?: () => string[];
  /** The live group chats (null: not loaded). */
  groups?: () => readonly Pick<BotGroup, 'memberIds'>[] | null;
}

/** Why `botId` (null: a bot not made yet) cannot be bound to `profile`, or
 *  null. */
export function myHermesBindRefusal(
  store: Pick<BotStore, 'ownHermesHolder' | 'get'>,
  botId: string | null,
  profile: unknown,
  deps: MyHermesBindDeps = {},
): string | null {
  if ((deps.platform ?? process.platform) === 'win32') return 'My Hermes runs on macOS and Linux in this version.';
  if (!isHermesProfileName(profile)) return 'That is not a Hermes profile name.';
  const profiles = (deps.profiles ?? (() => listMyHermesProfiles(deps.home ?? os.homedir())))();
  if (!profiles.includes(profile)) return `No Hermes profile ${profile} was found (${myHermesProfileLabel(profile)}).`;
  const holder = store.ownHermesHolder(profile, botId ?? undefined);
  if (holder) return myHermesInUseMessage(holder.name, profile);
  if (botId !== null) {
    const inGroup = (deps.groups?.() ?? []).some((g) => g.memberIds.includes(botId));
    if (inGroup) return myHermesNoGroupMessage(store.get(botId)?.name ?? botId);
  }
  return null;
}

export interface MyHermesConfirmCopy { message: string; detail: string; confirm: string; cancel: string }

/** The confirm's words. `switching`: an existing bot moves (its Hermes
 *  session does not come along). Pure. */
export function myHermesConfirmCopy(locale: AutomationUiLocale, botName: string, profile: string, switching: boolean): MyHermesConfirmCopy {
  const name = botName.replace(/[\r\n]+/g, ' ').slice(0, 80);
  const where = myHermesProfileLabel(profile);
  if (locale === 'ko') {
    return {
      message: `"${name}"에 내 Hermes를 쓸까요?`,
      detail: `${name}은(는) 내 Hermes(${where})를 씁니다. 그 Hermes의 기억, 스킬, 모델, 셸을 포함한 도구가 내 권한으로 실행돼요.`
        + (switching ? '\n\n대화방 기록은 그대로 남지만, Hermes 세션은 다른 Hermes 홈으로 이어지지 않아요.' : ''),
      confirm: '내 Hermes 쓰기',
      cancel: '취소',
    };
  }
  return {
    message: `Use your own Hermes for "${name}"?`,
    detail: `${name} will use your own Hermes (${where}): its memory, skills, model and tools, including the shell, run as you.`
      + (switching ? '\n\nThe room\'s conversation stays, but the Hermes session does not carry over between Hermes homes.' : ''),
    confirm: 'Use My Hermes',
    cancel: 'Cancel',
  };
}

export type MyHermesConfirm = (win: BrowserWindow | null, botName: string, profile: string, switching: boolean) => Promise<boolean>;

/** The native confirm, owned by main. Cancel is the default. */
export const confirmMyHermesNatively: MyHermesConfirm = async (win, botName, profile, switching) => {
  const copy = myHermesConfirmCopy(getAutomationUiLocale(), botName, profile, switching);
  const opts = {
    type: 'warning' as const,
    buttons: [copy.cancel, copy.confirm],
    defaultId: 0,
    cancelId: 0,
    message: copy.message,
    detail: copy.detail,
    noLink: true,
  };
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
};

/** FACTORY_MY_HERMES's answer: the profiles (each with the bot on it), and
 *  the asked profile's readiness. */
export async function myHermesStatus(
  store: Pick<BotStore, 'ownHermesHolder'> | null,
  req: unknown,
  deps: MyHermesBindDeps & { readiness?: (profile: string, fresh: boolean) => Promise<NonNullable<MyHermesStatus['readiness']>>; readinessDeps?: MyHermesReadinessDeps } = {},
): Promise<MyHermesStatus> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return { supported: false, profiles: [] };
  const r = req && typeof req === 'object' && !Array.isArray(req) ? (req as Record<string, unknown>) : {};
  const names = (deps.profiles ?? (() => listMyHermesProfiles(deps.home ?? os.homedir())))();
  const profiles = names.map((name) => {
    const holder = store?.ownHermesHolder(name) ?? null;
    return { name, dir: myHermesProfileLabel(name), ...(holder ? { usedBy: { botId: holder.id, name: holder.name } } : {}) };
  });
  const asked = r.profile === undefined ? null : r.profile;
  if (asked === null) return { supported: true, profiles };
  if (!isHermesProfileName(asked)) return { supported: true, profiles, readiness: { ready: false, reason: 'profile-missing', message: 'That is not a Hermes profile name.', notices: [] } };
  const ask = deps.readiness ?? ((p: string, fresh: boolean) => myHermesReadinessCached(p, fresh, deps.readinessDeps));
  return { supported: true, profiles, readiness: await ask(asked, r.fresh === true) };
}

