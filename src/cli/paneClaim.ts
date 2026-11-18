import { sendRequest, setWorkspaceToken } from './client';
import { resolveSelfContext, getParentPidDefault } from './identity';

/**
 * Bind this CLI's pane claim, for an app action. From a wmux pane the claim
 * goes with every request after this; outside wmux there is none.
 *
 * A pane whose claim did not come back must not pass for the command line.
 * On macOS and Linux main checks that itself, from the pid the OS reports for
 * the connection. On Windows it cannot, so the pane's environment decides
 * here: with it set and no claim, this stops rather than send without one.
 * Returns why it stopped, or null to go on.
 */
export async function bindPaneClaim(): Promise<string | null> {
  const self = await resolveSelfContext({
    sendRequest,
    env: process.env,
    ppid: process.ppid,
    getParentPid: getParentPidDefault,
    callerPid: process.pid,
  });
  if (self.workspaceToken) {
    setWorkspaceToken(self.workspaceToken);
    return null;
  }
  const inPaneEnv = Boolean(process.env.WMUX_WORKSPACE_ID || process.env.WMUX_PTY_ID);
  if (!inPaneEnv || process.platform !== 'win32') return null;
  return `this runs in a wmux pane, but wmux could not confirm which one${self.claimRefused ? ` (${self.claimRefused})` : ''}; run it again`;
}
