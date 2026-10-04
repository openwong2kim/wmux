// Whether the Git page can read GitHub for a repo: signed in, not signed in,
// gh not installed, or not a GitHub repo at all. Read from the gated PR list,
// so it costs no extra gh call beyond what the page reads anyway.
import { useEffect, useState } from 'react';

export type GhAuthState = 'checking' | 'ok' | 'unauthenticated' | 'cli-missing' | 'not-github';

type PrListResult = Awaited<ReturnType<Window['electronAPI']['github']['prList']>>;

/** The gate state a PR list answer implies. A list, or a list that failed
 *  for another reason, means gh itself is ready ('ok'). Pure. */
export function ghAuthStateOf(res: PrListResult): Exclude<GhAuthState, 'checking'> {
  if (res.ok) return 'ok';
  if (res.provider === 'gitlab' || res.code === 'no-remote' || res.code === 'unsupported-host') return 'not-github';
  if (res.code === 'cli-missing') return 'cli-missing';
  if (res.code === 'unauthenticated') return 'unauthenticated';
  return 'ok';
}

/** The gate for `repoPath`, read once per repo and per `refreshKey`. A
 *  `refreshKey` above 0 is a Check again: it probes past main's gate cache.
 *  No repo → 'not-github' (there is nothing on GitHub to read). */
export function useGhAuthGate(repoPath: string | null, refreshKey: number): GhAuthState {
  const [state, setState] = useState<GhAuthState>(repoPath ? 'checking' : 'not-github');
  useEffect(() => {
    if (!repoPath) {
      setState('not-github');
      return;
    }
    let live = true;
    setState('checking');
    const read = window.electronAPI?.github?.prList;
    if (!read) {
      setState('ok');
      return;
    }
    read(repoPath, refreshKey > 0)
      .then((res) => { if (live) setState(ghAuthStateOf(res)); })
      // The read itself failed: the page's own error line covers it.
      .catch(() => { if (live) setState('ok'); });
    return () => { live = false; };
  }, [repoPath, refreshKey]);
  return state;
}
