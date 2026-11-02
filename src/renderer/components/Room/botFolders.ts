// The owner's bot folders (shared/botFolder.ts), through the preload bridge
// `electronAPI.factory.folders` (main-window IPC; main answers only the main
// window). Main pushes `folders-changed` on the bot event channel.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotFolder, BotFolderListResult, BotFolderOkResult, BotFolderResult } from '../../../shared/botFolder';
import { getFactoryBotPort } from './factoryPorts';

export interface BotFolderPort {
  readonly available: boolean;
  list(): Promise<BotFolderListResult>;
  create(name: string): Promise<BotFolderResult>;
  rename(id: string, name: string): Promise<BotFolderResult>;
  setCollapsed(id: string, collapsed: boolean): Promise<BotFolderResult>;
  assign(botId: string, folderId: string | null): Promise<BotFolderOkResult>;
  assignMany(botIds: string[], folderId: string | null): Promise<BotFolderOkResult>;
  remove(id: string): Promise<BotFolderOkResult>;
}

interface Bridge {
  list?: () => Promise<BotFolderListResult>;
  create?: (name: string) => Promise<BotFolderResult>;
  rename?: (id: string, name: string) => Promise<BotFolderResult>;
  setCollapsed?: (id: string, collapsed: boolean) => Promise<BotFolderResult>;
  assign?: (botId: string, folderId: string | null) => Promise<BotFolderOkResult>;
  assignMany?: (botIds: string[], folderId: string | null) => Promise<BotFolderOkResult>;
  remove?: (id: string) => Promise<BotFolderOkResult>;
}

const UNAVAILABLE = { ok: false as const, code: 'not_started' as const, message: 'Bot folders are not available in this build.' };

function bridgePort(): BotFolderPort {
  const api = (globalThis as { electronAPI?: { factory?: { folders?: Bridge } } }).electronAPI;
  const b = api?.factory?.folders;
  return {
    available: !!b?.list && !!b.create,
    list: () => b?.list?.() ?? Promise.resolve(UNAVAILABLE),
    create: (name) => b?.create?.(name) ?? Promise.resolve(UNAVAILABLE),
    rename: (id, name) => b?.rename?.(id, name) ?? Promise.resolve(UNAVAILABLE),
    setCollapsed: (id, collapsed) => b?.setCollapsed?.(id, collapsed) ?? Promise.resolve(UNAVAILABLE),
    assign: (botId, folderId) => b?.assign?.(botId, folderId) ?? Promise.resolve(UNAVAILABLE),
    assignMany: (botIds, folderId) => b?.assignMany?.(botIds, folderId) ?? Promise.resolve(UNAVAILABLE),
    remove: (id) => b?.remove?.(id) ?? Promise.resolve(UNAVAILABLE),
  };
}

let port: BotFolderPort | null = null;

export function getBotFolderPort(): BotFolderPort {
  port ??= bridgePort();
  return port;
}

/** Tests, or a host that wires it another way. */
export function setBotFolderPort(next: BotFolderPort | null): void {
  port = next;
}

const NO_FOLDERS: readonly BotFolder[] = [];

/** The owner's folders, re-read on every bot event (main pushes
 *  `folders-changed` there, and a bot removed leaves its folder). */
export function useBotFolders(p: BotFolderPort = getBotFolderPort()): { folders: readonly BotFolder[]; reload: () => void } {
  const [folders, setFolders] = useState<readonly BotFolder[]>(NO_FOLDERS);
  const asked = useRef(0);
  const reload = useCallback(() => {
    if (!p.available) return;
    const n = ++asked.current;
    p.list().then((r) => {
      // Only the newest answer counts.
      if (r?.ok && n === asked.current) setFolders(r.folders);
    }, () => undefined);
  }, [p]);
  useEffect(() => {
    reload();
    return getFactoryBotPort().subscribe(reload);
  }, [reload]);
  return { folders, reload };
}
