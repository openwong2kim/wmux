import { useEffect } from 'react';
import { useStore } from '../stores';
import { t } from '../i18n';
import { authConfigEnvKey, type AuthLostEntry } from '../../shared/agentAuthLost';
import { parseWslAuthRef } from '../../shared/wslAccountMark';
import { loginInitialCommand, openTerminalTab } from '../utils/accountLogin';

// ─── Lost sign-in bridge (N4) ────────────────────────────────────────────────
//
// The single owner of the `agentAuth` IPC subscription, mounted once in
// AppLayout. Mirrors main's entries into the store, keeps one toast with
// [Sign in again] per entry, and after a click waits for the agent's own
// status to say signed in. main drops the entry then, and the toast and the
// sidebar's "Signed out" go with it.

const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' } as const;
export const SIGN_IN_POLL_MS = 3_000;
export const SIGN_IN_WAIT_MS = 10 * 60_000;

/** key → the toast offering [Sign in again] for it. */
const toasts = new Map<string, string>();
/** Keys whose sign-in tab is open and being waited on (no toast meanwhile), with that wait's token. */
const waiting = new Map<string, symbol>();

/** Mirror main's entries: store, then one toast per entry nobody is signing in to yet. */
export function applyAuthLostEntries(entries: readonly AuthLostEntry[]): void {
  const store = useStore.getState();
  store.setAgentAuthLost(entries);
  const live = new Set(entries.map((e) => e.key));
  for (const [key, toastId] of toasts) {
    if (live.has(key)) continue;
    store.dismissToast(toastId);
    toasts.delete(key);
  }
  for (const key of [...waiting.keys()]) if (!live.has(key)) waiting.delete(key);
  for (const entry of entries) if (!toasts.has(entry.key) && !waiting.has(entry.key)) offerSignIn(entry);
}

function offerSignIn(entry: AuthLostEntry): void {
  if (toasts.has(entry.key)) return;
  const ptyId = entry.ptyIds[0];
  const toastId = useStore.getState().pushToast({
    level: 'warn',
    persist: true,
    message: t('agentAuth.signedOut', { agent: AGENT_NAME[entry.agent] }),
    action: {
      label: t('agentAuth.signInAgain'),
      onClick: () => {
        toasts.delete(entry.key);
        void signInAgain(entry);
      },
    },
    ...(ptyId ? { target: { ptyId } } : {}),
  });
  toasts.set(entry.key, toastId);
}

/**
 * Open a tab running the agent's own sign-in for that account (wmux holds no
 * tokens and picks no sign-in method), then ask main every few seconds until
 * the agent says signed in. On timeout the toast comes back.
 */
export async function signInAgain(
  entry: AuthLostEntry,
  deps: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const token = Symbol(entry.key);
  waiting.set(entry.key, token);
  const mine = () => waiting.get(entry.key) === token;
  let settled = false;
  try {
    const envKey = authConfigEnvKey(entry.agent);
    // A WSL pane on a bound account signed out of that account's Linux home:
    // sign in there, in the same distro, not in the Windows folder.
    const wsl = parseWslAuthRef(entry.configDir);
    const tab = await openTerminalTab({
      // The account's own folder, or nothing: never the workspace's bound account,
      // which is not necessarily the one that was signed out.
      plainEnv: true,
      ...(wsl
        ? { env: { [envKey]: wsl.configDir }, wslAccountHomeKey: envKey, shell: 'wsl.exe', wslDistro: wsl.distro }
        : entry.configDir ? { env: { [envKey]: entry.configDir }, wslAccountLoginEnvKey: envKey } : {}),
      initialCommand: loginInitialCommand(entry.agent),
      title: t('agentAuth.signInTabTitle', { agent: AGENT_NAME[entry.agent] }),
      cwd: null,
    });
    if (!tab) return;
    const until = now() + SIGN_IN_WAIT_MS;
    while (mine() && now() < until) {
      await sleep(SIGN_IN_POLL_MS);
      if (!mine()) return;
      const state = await window.electronAPI.agentAuth.loginState(entry.key).catch(() => null);
      if (state && (!state.known || state.signedIn === true)) {
        settled = true;
        return;
      }
    }
  } catch {
    // The tab or the check failed: the toast comes back below.
  } finally {
    // Only this wait's own state: a newer one (the entry went and came back) is left alone.
    if (mine()) {
      waiting.delete(entry.key);
      if (!settled && stillLost(entry.key)) offerSignIn(entry);
    }
  }
}

function stillLost(key: string): boolean {
  return useStore.getState().agentAuthLost.some((e) => e.key === key);
}

/** Test seam: forget the module's toasts and waits. */
export function resetAgentAuthBridgeForTests(): void {
  toasts.clear();
  waiting.clear();
}

export function useAgentAuthBridge(): void {
  useEffect(() => {
    const api = window.electronAPI?.agentAuth;
    if (!api) return;
    let alive = true;
    let changed = false;
    // A list that answers after a change was pushed is older than that change.
    void api.list().then((entries) => { if (alive && !changed) applyAuthLostEntries(entries); }).catch(() => undefined);
    const off = api.onChanged((entries) => {
      changed = true;
      applyAuthLostEntries(entries);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
}
