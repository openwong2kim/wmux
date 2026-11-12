// Whether the desktop app runs on this install, as the daemon's pipe server
// needs it for the daemon-only pairing calls (DaemonPipeServer
// HEADLESS_REMOTE_METHODS): those answer a caller that is not the app only on
// a host the app has never used.
//
// Three signals, any one of which marks this daemon as the app's:
//   - the app's launcher started it (ENV_KEYS.APP_SPAWNED_DAEMON, read once
//     here and taken out of the environment so nothing the daemon starts
//     carries it on);
//   - the app identified on this install before (APP_ATTACHED_FILE in the
//     daemon's data dir, written on the first `daemon.client.identify` as main
//     and read at boot), which covers a daemon started without the app
//     (`wmux daemon start`, a login service) on a machine that has it;
//   - the app identifies on this daemon (DaemonPipeServer.markFirstParty).

import fs from 'node:fs';
import path from 'node:path';
import { ENV_KEYS } from '../shared/constants';
import type { DaemonPipeServer } from './DaemonPipeServer';

export const APP_ATTACHED_FILE = 'app-attached';

/** Read and remove the app launcher's marker from `env` (once, at load). */
export function takeAppSpawnedMarker(env: NodeJS.ProcessEnv): boolean {
  const spawnedByApp = env[ENV_KEYS.APP_SPAWNED_DAEMON] === '1';
  delete env[ENV_KEYS.APP_SPAWNED_DAEMON];
  return spawnedByApp;
}

/**
 * At boot: mark the pipe server as the app's when the app's launcher started
 * this daemon or the app attached on this install before. Returns whether it did.
 */
export function applyAppHostAtBoot(pipeServer: Pick<DaemonPipeServer, 'markAppHost'>, dataDir: string, spawnedByApp: boolean): boolean {
  const attachedBefore = fs.existsSync(path.join(dataDir, APP_ATTACHED_FILE));
  if (spawnedByApp || attachedBefore) pipeServer.markAppHost();
  return spawnedByApp || attachedBefore;
}

/**
 * `daemon.client.identify`: a caller that claims the app's role is marked
 * first party and, the first time on this install, recorded in the data dir.
 * A failed write is logged; the in-memory mark still holds for this daemon.
 */
export function registerClientIdentify(
  pipeServer: Pick<DaemonPipeServer, 'onRpc' | 'markFirstParty'>,
  dataDir: string,
  log: (message: string) => void = console.warn,
): void {
  let recorded = false;
  pipeServer.onRpc('daemon.client.identify', async (params, ctx) => {
    const role = typeof params['role'] === 'string' ? params['role'] : '';
    if (role !== 'main') return { ok: false };
    // Keep classification as the first side effect. New clients no longer rely
    // on synchronous handler completion for correctness — they retry subscribe
    // after this reply settles — but doing the cheap mark first still minimizes
    // the refusal window for every caller.
    pipeServer.markFirstParty(ctx.clientId);
    if (!recorded) {
      recorded = true;
      const file = path.join(dataDir, APP_ATTACHED_FILE);
      try {
        if (!fs.existsSync(file)) fs.writeFileSync(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
      } catch (err) {
        recorded = false;
        log(`[app-host] could not record the app's attach in ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ok: true };
  });
}
