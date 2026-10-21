// "Star on GitHub": the renderer's side of shared/starPrompt.ts. The prompt's
// state lives in the store (persisted via SessionData); main runs gh and
// counts new agent sessions from the hook path.

import { useEffect } from 'react';
import { useStore } from '../stores';
import type { StarActionResult, StarredCheck } from '../../shared/starPrompt';

/** At most one "already starred?" call per app session (module scope = one renderer load). */
let starredCheck: Promise<StarredCheck> | null = null;

function starApi() {
  return window.electronAPI?.starPrompt;
}

/**
 * Asks gh once per app session whether wmux is already starred, right before
 * the sidebar row would first show. A starred answer completes the prompt.
 * Main makes no network call unless gh is signed in; any failure is `unknown`.
 */
export function checkStarredOnce(): Promise<StarredCheck> {
  if (!starredCheck) {
    const api = starApi();
    starredCheck = (api ? api.checkStarred() : Promise.resolve<StarredCheck>('unknown'))
      .catch((): StarredCheck => 'unknown')
      .then((result) => {
        if (result === 'starred') useStore.getState().completeStarPrompt();
        return result;
      });
  }
  return starredCheck;
}

/**
 * The star action, from the sidebar row or Settings: gh stars it when signed
 * in, else the repository page opens. Either way the prompt is done.
 */
export async function runStarAction(): Promise<StarActionResult> {
  const api = starApi();
  if (!api) return 'failed';
  const result = await api.star().catch((): StarActionResult => 'failed');
  if (result !== 'failed') useStore.getState().completeStarPrompt();
  return result;
}

/** Mounted once in AppLayout: each new agent session main counted moves the prompt's count. */
export function useStarPromptSessionBridge(): void {
  useEffect(() => {
    const subscribe = starApi()?.onAgentSession;
    if (!subscribe) return;
    return subscribe(() => useStore.getState().recordStarPromptAgentSession());
  }, []);
}

export function resetStarPromptForTests(): void {
  starredCheck = null;
}
