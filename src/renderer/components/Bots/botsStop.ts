// ─── Stopping bots from the Bots page ────────────────────────────────────
//
// Two verbs main owns: stop every bot (each running turn interrupted, every
// bot worker stopped, every queued gate cancelled) and stop one bot (its
// turn and its workers). They reach the page through the factory bot port
// when it carries them, else through the preload's `factory` bridge —
//
//   factory: {
//     stopAll(): Promise<StopAllResult>
//     stopBot(botId: string): Promise<StopBotResult>
//   }
//
// Both are optional: a build without them shows no Stop controls.
import { getFactoryBotPort, type FactoryBotPort } from '../Room/factoryPorts';

export interface StopAllResult { ok: boolean; botsInterrupted: number; workersStopped: number; gatesCancelled: number }
export interface StopBotResult { ok: boolean; workersStopped: number }

export interface BotsStopPort {
  stopAll?(): Promise<StopAllResult>;
  stopBot?(botId: string): Promise<StopBotResult>;
}

interface StopBridge {
  stopAll?: () => Promise<StopAllResult>;
  stopBot?: (botId: string) => Promise<StopBotResult>;
}

function bridge(): StopBridge | null {
  const f = (globalThis as { electronAPI?: { factory?: unknown } }).electronAPI?.factory;
  return f && typeof f === 'object' ? (f as StopBridge) : null;
}

/** The stop verbs: the port's own when it has them, else the bridge's. */
export function botsStopPort(port?: FactoryBotPort & BotsStopPort): BotsStopPort {
  const p = (port ?? getFactoryBotPort()) as FactoryBotPort & BotsStopPort;
  const b = bridge();
  const stopAll = p.stopAll ? p.stopAll.bind(p) : b?.stopAll;
  const stopBot = p.stopBot ? p.stopBot.bind(p) : b?.stopBot;
  return { ...(stopAll ? { stopAll } : {}), ...(stopBot ? { stopBot } : {}) };
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** What a stop did, in the owner's words: only the counts that are not
 *  zero, or that nothing was running. Pure. */
export function stopAllSummary(r: StopAllResult, t: T): string {
  if (!r.ok) return t('botsPage.stop.failed');
  const parts = [
    r.botsInterrupted > 0 ? t('botsPage.stop.botsInterrupted', { count: r.botsInterrupted }) : '',
    r.workersStopped > 0 ? t('botsPage.stop.workersStopped', { count: r.workersStopped }) : '',
    r.gatesCancelled > 0 ? t('botsPage.stop.gatesCancelled', { count: r.gatesCancelled }) : '',
  ].filter(Boolean);
  return parts.length > 0 ? t('botsPage.stop.done', { what: parts.join(', ') }) : t('botsPage.stop.nothing');
}

/** One bot's stop, in the owner's words. Pure. */
export function stopBotSummary(name: string, r: StopBotResult, t: T): string {
  if (!r.ok) return t('botsPage.stop.failed');
  return r.workersStopped > 0
    ? t('botsPage.stop.botStoppedWorkers', { name, count: r.workersStopped })
    : t('botsPage.stop.botStopped', { name });
}

/** What turning the bots off stopped, as main's settings write reports it
 *  (absent from a main that does not stop work on Off). */
export interface FactoryStoppedWork { workers: number; tasks: number; ok: boolean }

/** The stop report a settings write answered with, when it carries one. */
export function stoppedWorkOf(result: unknown): FactoryStoppedWork | null {
  const w = result && typeof result === 'object' ? (result as { stoppedWork?: unknown }).stoppedWork : undefined;
  if (!w || typeof w !== 'object') return null;
  const r = w as Record<string, unknown>;
  if (typeof r.ok !== 'boolean' || typeof r.workers !== 'number' || typeof r.tasks !== 'number') return null;
  return { ok: r.ok, workers: r.workers, tasks: r.tasks };
}

interface ToastSink {
  pushToast: (toast: { message: string; level: 'info' | 'error'; action?: { label: string; onClick: () => void }; persist?: boolean }) => void;
}

/** Turning the bots off stopped their running work: say how many workers
 *  stopped (nothing when none was running), or that the stop failed, with
 *  Try again — the page's Stop all. */
export function toastStoppedWork(result: unknown, t: T, sink: ToastSink, stop: BotsStopPort = botsStopPort()): void {
  const w = stoppedWorkOf(result);
  if (!w) return;
  if (w.ok) {
    if (w.workers > 0) sink.pushToast({ message: t(w.workers === 1 ? 'settings.factory.offStoppedOne' : 'settings.factory.offStopped', { count: w.workers }), level: 'info' });
    return;
  }
  const stopAll = stop.stopAll;
  sink.pushToast({
    message: t('settings.factory.offStopFailed'),
    level: 'error',
    persist: true,
    ...(stopAll ? {
      action: {
        label: t('settings.factory.offStopRetry'),
        onClick: () => {
          void stopAll().then(
            (r) => sink.pushToast({ message: stopAllSummary(r, t), level: r.ok ? 'info' : 'error' }),
            (err: unknown) => sink.pushToast({ message: `${t('botsPage.stop.failed')} ${err instanceof Error ? err.message : String(err)}`, level: 'error' }),
          );
        },
      },
    } : {}),
  });
}
