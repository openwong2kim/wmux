// N4 — the desktop side of "an agent lost its sign-in" (shared/agentAuthLost).
// The daemon reports per pane; this folds the reports into one entry per agent
// and account, raises one notification when an entry appears, and keeps the
// renderer's copy (its toast and the sidebar's "Signed out") in step. An entry
// goes when the account is seen to work again: any pane or run of it finished a
// confirmed turn or its status said signed in (daemon), or the renderer's
// [Sign in again] saw the agent's status say signed in.

import { ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/constants';
import {
  authConfigEnvKey,
  authLostKey,
  isWindowsReadableAccount,
  parseAgentAuthLost,
  parseAuthAccount,
  type AgentAuthLost,
  type AuthLostEntry,
} from '../../shared/agentAuthLost';
import { withFreshWindowsPath } from '../../shared/windowsPathEnv';
import { AgentSetupDetector } from '../firstRun/AgentSetupDetector';
import { dispatchNotification } from '../notification/dispatchNotification';
import type { DaemonClient } from '../DaemonClient';
import { getAccountStore } from '../account/accountStore';
import { getWslAccountState, type WslAccountState } from '../account/wslAccountState';
import { canonicalAccountFolder } from '../../shared/wslAccountHome';
import { parseWslAuthRef } from '../../shared/wslAccountMark';
import { validWslTarget } from '../../shared/wslTarget';

const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' } as const;

/** The entries, keyed by agent and account. Pure, so the rules are testable without Electron. */
export class AuthLostBoard {
  private readonly entries = new Map<string, AuthLostEntry>();
  /** Bumped on every report, so a status check that started before one cannot clear it. */
  private readonly generations = new Map<string, number>();

  /** Record a report; true when it opened a new entry (the one that gets a notification). */
  report(ptyId: string, lost: AgentAuthLost): boolean {
    const key = authLostKey(lost.agent, lost.configDir);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    const entry = this.entries.get(key);
    if (entry) {
      if (ptyId && !entry.ptyIds.includes(ptyId)) entry.ptyIds.push(ptyId);
      return false;
    }
    this.entries.set(key, { key, agent: lost.agent, configDir: lost.configDir, ptyIds: ptyId ? [ptyId] : [] });
    return true;
  }

  /** The agent and account was seen to work: its entry goes, whichever pane or run reported it. */
  accountWorks(agent: AuthLostEntry['agent'], configDir: string | null): boolean {
    return this.clear(authLostKey(agent, configDir));
  }

  generation(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  /** A pane closed: it stops being one of the entry's panes; the entry stays. */
  forgetPane(ptyId: string): boolean {
    let changed = false;
    for (const entry of this.entries.values()) {
      const at = entry.ptyIds.indexOf(ptyId);
      if (at !== -1) {
        entry.ptyIds.splice(at, 1);
        changed = true;
      }
    }
    return changed;
  }

  clear(key: string): boolean {
    return this.entries.delete(key);
  }

  get(key: string): AuthLostEntry | undefined {
    return this.entries.get(key);
  }

  list(): AuthLostEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e, ptyIds: [...e.ptyIds] }));
  }
}

/**
 * A WSL home's sign-in evidence (the daemon sends the pane's target only for a
 * hook whose transcript lies under that home, daemon/wslAuthEvidence.ts):
 * recorded for the account whose folder the sign-in key names, in that
 * distro as that user (wslAccountState.ts).
 */
export function noteWslHomeAuth(
  wsl: unknown,
  account: { agent: string; configDir: string | null } | null,
  signedIn: boolean,
  deps: { accounts?: () => ReadonlyArray<{ id: string; vendor: string; configDir: string }>; state?: Pick<WslAccountState, 'noteAuth'> } = {},
): void {
  if (!account || account.agent !== 'claude' || !validWslTarget(wsl)) return;
  const ref = parseWslAuthRef(account.configDir);
  if (!ref || ref.distro.toLowerCase() !== wsl.distribution.toLowerCase()) return;
  const folder = canonicalAccountFolder(ref.configDir);
  const accounts = deps.accounts ?? (() => getAccountStore().listAccounts());
  const state = deps.state ?? getWslAccountState();
  for (const a of accounts()) {
    if (a.vendor === 'claude' && canonicalAccountFolder(a.configDir) === folder) state.noteAuth(a.id, wsl, signedIn);
  }
}

/**
 * The env an entry's status check runs with: a copy of `base` (main's own
 * environment is never written to) naming the entry's account folder, or
 * none at all for the agent's default account, so an inherited one is out.
 */
export function loginProbeEnv(entry: Pick<AuthLostEntry, 'agent' | 'configDir'>, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const envKey = authConfigEnvKey(entry.agent);
  if (entry.configDir) env[envKey] = entry.configDir;
  else delete env[envKey];
  return env;
}

/**
 * [Sign in again]'s check: the agent's own status for an entry the board holds.
 * Signed in drops the entry (returned as `cleared`). An unknown key is not
 * probed, so the renderer can only ask about accounts the daemon reported. A
 * WSL account home is not probed either: the Windows status command would read
 * the Windows folder, another sign-in. Its entry goes when that pane's agent is
 * seen to work (the daemon's report), and the wait ends then or times out.
 */
export async function answerLoginState(
  board: AuthLostBoard,
  key: unknown,
  loginState: (entry: AuthLostEntry) => Promise<boolean | null>,
): Promise<{ known: false } | { known: true; signedIn: boolean | null; cleared: boolean }> {
  const entry = typeof key === 'string' ? board.get(key) : undefined;
  if (!entry) return { known: false };
  if (!isWindowsReadableAccount(entry.configDir)) return { known: true, signedIn: null, cleared: false };
  const started = board.generation(entry.key);
  const signedIn = await loginState(entry).catch(() => null);
  // A newer report arrived while the status ran: that loss stands.
  const cleared = signedIn === true && board.generation(entry.key) === started && board.clear(entry.key);
  return { known: true, signedIn, cleared };
}

/**
 * One board for the life of the app. The handlers are registered again on
 * every daemon reconnect (registerAllHandlers); a loss seen before the
 * reconnect is still a loss, so it must not start empty then.
 */
const appBoard = new AuthLostBoard();

export function registerAgentAuthHandlers(
  daemonClient: DaemonClient | undefined,
  getWindow: () => BrowserWindow | null,
  deps: { loginState?: (entry: AuthLostEntry) => Promise<boolean | null>; board?: AuthLostBoard } = {},
): () => void {
  const board = deps.board ?? appBoard;
  const loginState = deps.loginState
    ?? ((entry: AuthLostEntry) => new AgentSetupDetector().loginState(entry.agent, loginProbeEnv(entry, withFreshWindowsPath(process.env))));
  const publish = (): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.AGENT_AUTH_LOST_CHANGED, board.list());
  };

  const onAuthLost = (payload: { sessionId: string; lost?: unknown; works?: unknown; wsl?: unknown }): void => {
    const works = parseAuthAccount(payload.works);
    noteWslHomeAuth(payload.wsl, works ?? parseAgentAuthLost(payload.lost), works !== null);
    if (works) {
      if (board.accountWorks(works.agent, works.configDir)) publish();
      return;
    }
    const lost = parseAgentAuthLost(payload.lost);
    if (!lost) return;
    if (board.report(payload.sessionId, lost)) {
      const name = AGENT_NAME[lost.agent];
      dispatchNotification(getWindow(), payload.sessionId || null, {
        type: 'warning',
        title: `${name} is signed out`,
        body: lost.origin === 'schedule'
          ? `A scheduled run was not started. Sign in to ${name} again to run it.`
          : `${name} cannot run until you sign in again.`,
        category: 'system',
      }, { ptyId: payload.sessionId || null });
    }
    publish();
  };
  const onGone = (payload: { sessionId: string }): void => {
    if (board.forgetPane(payload.sessionId)) publish();
  };

  ipcMain.removeHandler(IPC.AGENT_AUTH_LOST_LIST);
  ipcMain.handle(IPC.AGENT_AUTH_LOST_LIST, () => board.list());
  // Only an entry the daemon reported can be asked about or cleared: the
  // renderer names a key, never a folder, so it cannot point a probe anywhere.
  ipcMain.removeHandler(IPC.AGENT_AUTH_LOGIN_STATE);
  ipcMain.handle(IPC.AGENT_AUTH_LOGIN_STATE, async (_event, key: unknown) => {
    const answer = await answerLoginState(board, key, loginState);
    if (!answer.known) return answer;
    if (answer.cleared) publish();
    return { known: true as const, signedIn: answer.signedIn };
  });

  // The renderer's copy is brought back in step with the board on every registration.
  publish();
  if (daemonClient) {
    daemonClient.on('agent:authLost', onAuthLost);
    daemonClient.on('session:died', onGone);
    daemonClient.on('session:destroyed', onGone);
  }

  return () => {
    ipcMain.removeHandler(IPC.AGENT_AUTH_LOST_LIST);
    ipcMain.removeHandler(IPC.AGENT_AUTH_LOGIN_STATE);
    if (daemonClient) {
      daemonClient.removeListener('agent:authLost', onAuthLost);
      daemonClient.removeListener('session:died', onGone);
      daemonClient.removeListener('session:destroyed', onGone);
    }
  };
}
