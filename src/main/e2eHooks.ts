// E2E test hooks — a dev-build-only seam for the Electron e2e harness (e2e/).
//
// The harness plays Moa's brain without a model: it sends the same pipe RPCs
// the brain's MCP tools send (deck.proposeGoal, fanout.start, deck.goal), and
// for that it needs what a real brain adapter gets at spawn — a commander
// token bound to the HQ workspace. Nothing else is exposed.
//
// Installed only when BOTH hold: the build is unpackaged (a packaged app never
// has it) and WMUX_E2E_HOOKS=1 is in main's environment at launch.

import { app } from 'electron';
import { mintCommanderToken } from './deck/commanderTrust';
import { getHqWorkspaceId } from './deck/deckHqStore';

export interface WmuxE2EHooks {
  /** A live commander token for the current HQ, or null when there is none. */
  mintHqCommanderToken(): string | null;
  hqWorkspaceId(): string | null;
}

export function e2eHooksEnabled(env: NodeJS.ProcessEnv = process.env, packaged: boolean = app.isPackaged): boolean {
  return !packaged && env.WMUX_E2E_HOOKS === '1';
}

export function installE2EHooks(): void {
  if (!e2eHooksEnabled()) return;
  const hooks: WmuxE2EHooks = {
    mintHqCommanderToken: () => {
      const hq = getHqWorkspaceId();
      return hq ? mintCommanderToken(hq) : null;
    },
    hqWorkspaceId: () => getHqWorkspaceId(),
  };
  (globalThis as { __wmuxE2E?: WmuxE2EHooks }).__wmuxE2E = hooks;
  console.warn('[e2e] test hooks installed (WMUX_E2E_HOOKS=1, unpackaged build)');
}
