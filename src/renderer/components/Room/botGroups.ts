// The owner's group chats (shared/botGroup.ts), through the preload bridge
// `electronAPI.factory.groups` (main-window IPC; main answers only the main
// window). Main pushes `groups-changed` on the bot event channel.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BotGroup,
  BotGroupCreateRequest,
  BotGroupListResult,
  BotGroupRemoveResult,
  BotGroupResult,
  BotGroupUpdateRequest,
} from '../../../shared/botGroup';
import { getFactoryBotPort } from './factoryPorts';

export interface BotGroupPort {
  readonly available: boolean;
  list(): Promise<BotGroupListResult>;
  create(req: BotGroupCreateRequest): Promise<BotGroupResult>;
  update(req: BotGroupUpdateRequest): Promise<BotGroupResult>;
  remove(id: string): Promise<BotGroupRemoveResult>;
}

interface Bridge {
  list?: (req?: { workspaceId?: string }) => Promise<BotGroupListResult>;
  create?: (req: BotGroupCreateRequest) => Promise<BotGroupResult>;
  update?: (req: BotGroupUpdateRequest) => Promise<BotGroupResult>;
  remove?: (id: string) => Promise<BotGroupRemoveResult>;
}

const UNAVAILABLE = { ok: false as const, code: 'not_started' as const, message: 'Group chats are not available in this build.' };

function bridgePort(): BotGroupPort {
  const api = (globalThis as { electronAPI?: { factory?: { groups?: Bridge } } }).electronAPI;
  const b = api?.factory?.groups;
  return {
    available: !!b?.list && !!b.create,
    list: () => b?.list?.() ?? Promise.resolve(UNAVAILABLE),
    create: (req) => b?.create?.(req) ?? Promise.resolve(UNAVAILABLE),
    update: (req) => b?.update?.(req) ?? Promise.resolve(UNAVAILABLE),
    remove: (id) => b?.remove?.(id) ?? Promise.resolve(UNAVAILABLE),
  };
}

let port: BotGroupPort | null = null;

export function getBotGroupPort(): BotGroupPort {
  port ??= bridgePort();
  return port;
}

/** Tests, or a host that wires it another way. */
export function setBotGroupPort(next: BotGroupPort | null): void {
  port = next;
}

const NO_GROUPS: readonly BotGroup[] = [];

/** The live group chats, re-read on every bot event (main pushes
 *  `groups-changed` there, and a bot removed changes a group's members). */
export function useBotGroups(p: BotGroupPort = getBotGroupPort()): { groups: readonly BotGroup[]; reload: () => void } {
  const [groups, setGroups] = useState<readonly BotGroup[]>(NO_GROUPS);
  const asked = useRef(0);
  const reload = useCallback(() => {
    if (!p.available) return;
    const n = ++asked.current;
    p.list().then((r) => {
      // Only the newest answer counts.
      if (r?.ok && n === asked.current) setGroups(r.groups);
    }, () => undefined);
  }, [p]);
  useEffect(() => {
    reload();
    return getFactoryBotPort().subscribe(reload);
  }, [reload]);
  return { groups, reload };
}
