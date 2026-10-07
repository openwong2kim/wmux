// Moa's delegate — the owner's side (renderer IPC only). The panel lists the
// moa_ask tickets, answers the escalated ones, and flips the per-rule auto
// toggles. None of this is on the pipe: no RPC, MCP tool or CLI verb reaches
// these channels (shared/moaDecision.ts, the owner IPC note).
//
// The backend registers its service in moaDelegatePorts only while the
// delegate is on. A null service is "mode off": LIST answers empty (plus a
// read-only count of tickets still escalated from before) and
// RESOLVE / AUTO_SET refuse, so with every switch off nothing here touches
// disk or the judge.
//
// Events: the ports have no "registered" signal, so the handler subscribes
// lazily on each invoke and re-subscribes when the service instance changes.
// The panel lists on mount, so the first LIST attaches the forwarder.
import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import {
  parseMoaAutoRuleSetRequest,
  parseMoaResolveRequest,
  type MoaAutoRuleSetResult,
  type MoaDelegateListResult,
  type MoaResolveResult,
} from '../../../shared/moaDecision';
import { getMoaDelegateService, type MoaDelegateServicePort } from '../../deck/moaDelegatePorts';
import { countOpenTicketsReadOnly } from '../../deck/moaDecisionStore';
import { getWmuxDir } from '../../../daemon/config';
import { wrapHandler } from '../wrapHandler';

export interface MoaDelegateHandlerPorts {
  getService?: () => MoaDelegateServicePort | null;
  /** Open tickets left from when the delegate was on (read only). */
  countOpenWhileOff?: () => number;
}

const OFF_MESSAGE = 'delegate is off';

export function moaDelegateOffList(): MoaDelegateListResult {
  return { mode: 'off', decisions: [], effects: [], rules: [] };
}

/** The handler bodies, without Electron, so tests can drive them directly. */
export function createMoaDelegateHandlers(
  getWindow: () => BrowserWindow | null,
  ports: MoaDelegateHandlerPorts = {},
) {
  const getService = ports.getService ?? getMoaDelegateService;
  const countOpenWhileOff = ports.countOpenWhileOff ?? (() => countOpenTicketsReadOnly(getWmuxDir()));
  let subscribed: MoaDelegateServicePort | null = null;
  let unsubscribe: (() => void) | null = null;

  const send = (channel: string, payload: unknown): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const detach = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    subscribed = null;
  };

  /** The live service, with the event forwarder attached to it. */
  const service = (): MoaDelegateServicePort | null => {
    const s = getService();
    if (s !== subscribed) {
      detach();
      if (s) {
        subscribed = s;
        unsubscribe = s.subscribe({
          decision: (event) => send(IPC.DECK_MOA_DELEGATE_DECISION_EVENT, event),
          effect: (event) => send(IPC.DECK_MOA_DELEGATE_EFFECT_EVENT, event),
          // The lane audit rides the decision channel (MoaAuditEvent).
          audit: (event) => send(IPC.DECK_MOA_DELEGATE_DECISION_EVENT, event),
        });
      }
    }
    return s;
  };

  return {
    list: async (): Promise<MoaDelegateListResult> => {
      const s = service();
      if (s) return s.list();
      // Off: nothing is started or written, but tickets escalated while it
      // was on still have askers waiting on them.
      const waiting = countOpenWhileOff();
      return waiting > 0 ? { ...moaDelegateOffList(), waitingWhileOff: waiting } : moaDelegateOffList();
    },
    resolve: async (raw: unknown): Promise<MoaResolveResult> => {
      const parsed = parseMoaResolveRequest(raw);
      if (!parsed.ok) return parsed;
      const s = service();
      if (!s) return { ok: false, code: 'invalid', message: OFF_MESSAGE };
      return s.resolveByOwner(parsed.value);
    },
    autoSet: async (raw: unknown): Promise<MoaAutoRuleSetResult> => {
      const parsed = parseMoaAutoRuleSetRequest(raw);
      if (!parsed.ok) return parsed;
      const s = service();
      if (!s) return { ok: false, code: 'invalid', message: OFF_MESSAGE };
      return s.setAutoRule(parsed.value);
    },
    /** Attach now if the service is already up (startup order varies). */
    attach: (): void => { service(); },
    detach,
  };
}

export function registerMoaDelegateHandlers(
  getWindow: () => BrowserWindow | null,
  ports: MoaDelegateHandlerPorts = {},
): () => void {
  const h = createMoaDelegateHandlers(getWindow, ports);
  const channels = [IPC.DECK_MOA_DELEGATE_LIST, IPC.DECK_MOA_DELEGATE_RESOLVE, IPC.DECK_MOA_DELEGATE_AUTO_SET];
  for (const c of channels) ipcMain.removeHandler(c);

  ipcMain.handle(IPC.DECK_MOA_DELEGATE_LIST, wrapHandler(IPC.DECK_MOA_DELEGATE_LIST, () => h.list()));
  ipcMain.handle(
    IPC.DECK_MOA_DELEGATE_RESOLVE,
    wrapHandler(IPC.DECK_MOA_DELEGATE_RESOLVE, (_e: Electron.IpcMainInvokeEvent, req: unknown) => h.resolve(req)),
  );
  ipcMain.handle(
    IPC.DECK_MOA_DELEGATE_AUTO_SET,
    wrapHandler(IPC.DECK_MOA_DELEGATE_AUTO_SET, (_e: Electron.IpcMainInvokeEvent, req: unknown) => h.autoSet(req)),
  );
  h.attach();

  return () => {
    h.detach();
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
