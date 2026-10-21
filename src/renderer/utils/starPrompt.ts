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

/** Takes the sessions main counted since the last drain into the prompt's count. */
export async function drainStarPromptSessions(): Promise<void> {
  const drain = starApi()?.drainSessions;
  if (!drain) return;
  const n = await drain().catch(() => 0);
  const { recordStarPromptAgentSession } = useStore.getState();
  for (let i = 0; i < n; i++) recordStarPromptAgentSession();
}

/**
 * Mounted once in AppLayout. Main's push is only a poke; the count is pulled,
 * once the saved session has been restored (sessions counted before that,
 * e.g. at startup or across a reload, wait in main) and again on every poke.
 * Draining earlier would add to the default state that loadSession then
 * replaces, losing those sessions.
 */
export function useStarPromptSessionBridge(sessionLoaded: boolean): void {
  useEffect(() => {
    if (!sessionLoaded) return;
    const subscribe = starApi()?.onAgentSession;
    if (!subscribe) return;
    const off = subscribe(() => { void drainStarPromptSessions(); });
    void drainStarPromptSessions();
    return off;
  }, [sessionLoaded]);
}

export function resetStarPromptForTests(): void {
  starredCheck = null;
}
