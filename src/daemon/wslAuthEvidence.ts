// Which WSL account home a sign-in signal is evidence about.
//
// A turn that failed on its sign-in, or one that worked, says something about
// the home the claude ran on. In a WSL pane that home is per distro and Linux
// user (shared/wslAccountHome.ts), so the evidence carries the pane's own
// target, and only when the hook's own transcript lies under that home's
// projects/: a claude the person started on another folder (the distro's own
// ~/.claude, another account) is not that home's.

import { wslAccountLinuxHome } from '../shared/wslAccountHome';
import { validWslTarget, type WslTarget } from '../shared/wslTarget';
import { isWslOwnTranscriptPath } from './hooks/transcriptPathGuard';

export function wslAuthEvidencePlace(
  meta: { wslTarget?: unknown; env?: Readonly<Record<string, string | undefined>> },
  agentSessionId: string | undefined,
  payload: unknown,
): WslTarget | undefined {
  const target = meta.wslTarget;
  if (!validWslTarget(target) || !agentSessionId) return undefined;
  const transcriptPath = (payload as { transcript_path?: unknown } | null | undefined)?.transcript_path;
  if (typeof transcriptPath !== 'string') return undefined;
  const home = wslAccountLinuxHome(meta.env, 'claude', target.user);
  if (!home || !transcriptPath.startsWith(`${home}/projects/`)) return undefined;
  return isWslOwnTranscriptPath(transcriptPath, agentSessionId, target, meta.env) ? { distribution: target.distribution, user: target.user } : undefined;
}
