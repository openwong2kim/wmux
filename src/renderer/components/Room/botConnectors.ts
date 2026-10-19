// The owner's side of the connection library (shared/botConnector.ts),
// through the preload bridge `electronAPI.factory.connectors` (main-window
// IPC; main answers only the main window). A key's value goes out once, in
// `save`; nothing here reads one back.

import { useCallback, useEffect, useState } from 'react';
import type {
  ConnectorListResult,
  ConnectorRemoveRequest,
  ConnectorRemoveResult,
  ConnectorSaveRequest,
  ConnectorSaveResult,
  ConnectorSimpleResult,
  ConnectorView,
} from '../../../shared/botConnector';
import { getFactoryBotPort } from './factoryPorts';

export interface BotConnectorPort {
  readonly available: boolean;
  list(): Promise<ConnectorListResult>;
  save(req: ConnectorSaveRequest): Promise<ConnectorSaveResult>;
  remove(req: ConnectorRemoveRequest): Promise<ConnectorRemoveResult>;
  setOffForBot(req: { id: string; botId: string; off: boolean }): Promise<ConnectorSimpleResult>;
  setEnabled(req: { id: string; enabled: boolean }): Promise<ConnectorSimpleResult>;
}

type Bridge = Partial<BotConnectorPort>;

const UNAVAILABLE = { ok: false as const, code: 'unavailable', message: 'Connections are not available in this build.' };

function bridgePort(): BotConnectorPort {
  const api = (globalThis as { electronAPI?: { factory?: { connectors?: Bridge } } }).electronAPI;
  const b = api?.factory?.connectors;
  return {
    available: !!b?.list && !!b.save,
    list: () => b?.list?.() ?? Promise.resolve(UNAVAILABLE),
    save: (req) => b?.save?.(req) ?? Promise.resolve(UNAVAILABLE),
    remove: (req) => b?.remove?.(req) ?? Promise.resolve(UNAVAILABLE),
    setOffForBot: (req) => b?.setOffForBot?.(req) ?? Promise.resolve(UNAVAILABLE),
    setEnabled: (req) => b?.setEnabled?.(req) ?? Promise.resolve(UNAVAILABLE),
  };
}

let port: BotConnectorPort | null = null;

export function getBotConnectorPort(): BotConnectorPort {
  port ??= bridgePort();
  return port;
}

/** Tests, or a host that wires it another way. */
export function setBotConnectorPort(next: BotConnectorPort | null): void {
  port = next;
}

/** The library, re-read on every bot event (main pushes
 *  `connectors-changed` there). */
export function useBotConnectors(p: BotConnectorPort = getBotConnectorPort()): {
  connectors: ConnectorView[];
  cannotStore: string | null;
  reload: () => void;
} {
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [cannotStore, setCannotStore] = useState<string | null>(null);
  const reload = useCallback(() => {
    if (!p.available) return;
    p.list().then((r) => {
      if (!r?.ok) return;
      setConnectors(r.connectors);
      setCannotStore(r.cannotStore?.code ?? null);
    }, () => undefined);
  }, [p]);
  useEffect(() => {
    reload();
    return getFactoryBotPort().subscribe(reload);
  }, [reload]);
  return { connectors, cannotStore, reload };
}
