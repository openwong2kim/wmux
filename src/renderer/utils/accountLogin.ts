// Account login in an in-app terminal tab.
//
// Opens a terminal tab in the active workspace's active pane with the account's
// config dir exported (CLAUDE_CONFIG_DIR / CODEX_HOME via pty.create's `env`,
// never an inline shell prefix, so it works the same on Windows), runs the
// vendor's login command there, and watches the credential until the login
// lands. The watcher lives at module scope, not in the Settings component:
// opening the tab closes Settings, which would otherwise unmount the poll.
//
// On success a new account is registered (or an existing one's usage is
// refreshed), the login tab closes itself and a toast confirms. On timeout the
// tab stays open and the pending entry flips to 'timed-out' so Settings (and a
// toast) can offer a retry.

import { useStore } from '../stores';
import { t } from '../i18n';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import { resolveStartupCwd, withDefaultShell, withWorkspaceProfile } from './ptyCreateOptions';

export type LoginVendor = 'claude' | 'codex';

export interface AccountLoginRequest {
  vendor: LoginVendor;
  name: string;
  configDir: string;
  loginCommand: string;
  /** Set when re-authenticating a registered account; absent for a new one. */
  accountId?: string;
}

export interface PendingLogin extends AccountLoginRequest {
  /** 'starting' = baseline read / tab spawn in flight; 'error' = the current
   *  credential could not be read, so completion can't be told apart from it. */
  phase: 'starting' | 'waiting' | 'timed-out' | 'error';
  /** False when no login tab could be opened (Settings shows the copy fallback). */
  tabOpen: boolean;
}

interface LoginTab { workspaceId: string; ptyId: string }

interface Watch {
  entry: PendingLogin;
  tab: LoginTab | null;
  /** Credential stamp before login started; undefined = was not logged in. */
  baseline: { stamp: string | null } | undefined;
  poll: ReturnType<typeof setInterval> | null;
  timeout: ReturnType<typeof setTimeout> | null;
}

export const LOGIN_POLL_INTERVAL_MS = 2000;
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Pause between detecting the login and closing the tab, so the CLI finishes
 *  its own post-login output and the user sees it succeed. */
const CLOSE_GRACE_MS = 1500;

const watches = new Map<string, Watch>();
const listeners = new Set<() => void>();
let snapshot: PendingLogin[] = [];

function emit(): void {
  snapshot = [...watches.values()].map((w) => w.entry);
  for (const l of listeners) l();
}

export function subscribeAccountLogins(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getPendingAccountLogins(): PendingLogin[] {
  return snapshot;
}

export function loginEnvKey(vendor: LoginVendor): 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' {
  return vendor === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
}

export function loginInitialCommand(vendor: LoginVendor): string {
  return vendor === 'codex' ? 'codex login' : 'claude auth login';
}

/** Spawn the login tab in the active workspace's active pane, focus it and
 *  close Settings. Returns null when there is nowhere to put it. */
async function openLoginTab(req: AccountLoginRequest): Promise<LoginTab | null> {
  const state = useStore.getState();
  if (state.paneGate !== 'ready') return null;
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return null;
  const paneId = ws.activePaneId;
  const cwd = resolveStartupCwd({
    splitInheritsCwd: false,
    profile: ws.profile,
    startupDirectory: state.startupDirectory,
  });
  // withWorkspaceProfile merges profile env UNDER this explicit env and keeps
  // this initialCommand, and main applies options.env after any account
  // binding — so the tab always logs into THIS account's dir. No role binding:
  // it would rewrite the login command as an agent launch.
  const options = withWorkspaceProfile(
    withDefaultShell(
      {
        workspaceId: ws.id,
        cwd,
        spawnKind: 'user-shell' as const,
        env: { [loginEnvKey(req.vendor)]: req.configDir },
        initialCommand: loginInitialCommand(req.vendor),
      },
      state.defaultShell,
    ),
    ws.profile,
  );
  try {
    const created = await window.electronAPI.pty.create(options) as { id: string; shell?: string; cwd?: string };
    const dispose = () => { void window.electronAPI.pty.dispose(created.id).catch(() => undefined); };
    // The workspace or its pane may have been closed/split away during the await.
    const freshWs = useStore.getState().workspaces.find((w) => w.id === ws.id);
    if (!freshWs || !getWorkspaceLeafPanes(freshWs).some((p) => p.id === paneId)) {
      dispose();
      return null;
    }
    // addSurface's third argument is the SHELL (also the initial title); the
    // restore path re-spawns it, so it must be a real shell, never the label.
    useStore.getState().addSurface(paneId, created.id, created.shell || options.shell || '', created.cwd || cwd || '', ws.id);
    const surface = findSurfaceByPty(ws.id, created.id);
    if (!surface) {
      dispose();
      return null;
    }
    const after = useStore.getState();
    // Set + lock the title so the shell's own title escape can't overwrite it.
    after.updateSurfaceTitle(surface.surfaceId, t('accounts.loginTabTitle', { name: req.name }));
    after.setActivePane(paneId);
    after.setSettingsPanelVisible(false);
    return { workspaceId: ws.id, ptyId: created.id };
  } catch (err) {
    useStore.getState().pushToast({
      level: 'error',
      message: `${t('accounts.loginTabFailed')} (${err instanceof Error ? err.message : String(err)})`,
    });
    return null;
  }
}

function findSurfaceByPty(workspaceId: string, ptyId: string): { paneId: string; surfaceId: string; count: number } | null {
  const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId);
  if (!ws) return null;
  for (const pane of getWorkspaceLeafPanes(ws)) {
    const s = pane.surfaces.find((x) => x.ptyId === ptyId);
    if (s) return { paneId: pane.id, surfaceId: s.id, count: pane.surfaces.length };
  }
  return null;
}

/** Close the login tab the same way the tab's own close button does. A tab the
 *  user already closed is simply gone. */
function closeLoginTab(tab: LoginTab | null): void {
  if (!tab) return;
  const found = findSurfaceByPty(tab.workspaceId, tab.ptyId);
  if (!found) return;
  void window.electronAPI.pty.dispose(tab.ptyId).catch(() => undefined);
  const state = useStore.getState();
  state.closeSurface(found.paneId, found.surfaceId, tab.workspaceId);
  if (found.count <= 1) state.closePane(found.paneId, tab.workspaceId);
}

function stopTimers(w: Watch): void {
  if (w.poll) { clearInterval(w.poll); w.poll = null; }
  if (w.timeout) { clearTimeout(w.timeout); w.timeout = null; }
}

async function onLoggedIn(w: Watch): Promise<void> {
  const api = window.electronAPI?.accounts;
  const { entry } = w;
  try {
    if (entry.accountId) {
      api?.usageRefresh?.(entry.accountId);
    } else {
      await api?.add({ name: entry.name, vendor: entry.vendor, configDir: entry.configDir });
    }
  } catch (err) {
    watches.delete(entry.configDir);
    emit();
    useStore.getState().pushToast({
      level: 'error',
      message: t('accounts.loginAddFailed', {
        name: entry.name,
        error: String((err as { message?: string })?.message ?? err),
      }),
    });
    return;
  }
  watches.delete(entry.configDir);
  emit();
  useStore.getState().pushToast({ level: 'info', message: t('accounts.loginReady', { name: entry.name }) });
  setTimeout(() => closeLoginTab(w.tab), CLOSE_GRACE_MS);
}

function startPolling(w: Watch): void {
  const api = window.electronAPI?.accounts;
  if (!api) return;
  stopTimers(w);
  w.entry = { ...w.entry, phase: 'waiting' };
  emit();
  let inflight = false;
  w.poll = setInterval(() => {
    if (inflight) return;
    inflight = true;
    void api.credentialStatus({ vendor: w.entry.vendor, configDir: w.entry.configDir }).then((st) => {
      if (watches.get(w.entry.configDir) !== w || !w.poll) return;
      // A re-login must see a NEW credential, not the stale one it replaces.
      const fresh = st.loggedIn && (!w.baseline || (st.stamp ?? null) !== w.baseline.stamp);
      if (fresh) { stopTimers(w); void onLoggedIn(w); }
    }).catch(() => { /* transient — keep polling */ }).finally(() => { inflight = false; });
  }, LOGIN_POLL_INTERVAL_MS);
  w.timeout = setTimeout(() => {
    stopTimers(w);
    if (watches.get(w.entry.configDir) !== w) return;
    w.entry = { ...w.entry, phase: 'timed-out' };
    emit();
    useStore.getState().pushToast({
      level: 'warn',
      persist: true,
      message: t('accounts.loginTimedOut', { name: w.entry.name }),
      action: { label: t('accounts.checkAgain'), onClick: () => checkAccountLoginAgain(w.entry.configDir) },
    });
  }, LOGIN_TIMEOUT_MS);
}

/** Read the credential stamp a re-login must move away from. Retried once; a
 *  failure is reported rather than guessed, since an empty baseline would count
 *  the OLD credential as a fresh login. */
async function readBaseline(req: AccountLoginRequest): Promise<Watch['baseline'] | 'failed'> {
  const api = window.electronAPI?.accounts;
  if (!req.accountId || !api) return undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const st = await api.credentialStatus({ vendor: req.vendor, configDir: req.configDir });
      return st.loggedIn ? { stamp: st.stamp ?? null } : undefined;
    } catch { /* retry once */ }
  }
  return 'failed';
}

/** Open a login tab for an account (new or existing) and watch for the login. */
export async function startAccountLogin(req: AccountLoginRequest): Promise<void> {
  const cur = watches.get(req.configDir);
  if (cur) {
    if (cur.entry.phase !== 'starting') await reopenAccountLoginTab(req.configDir);
    return;
  }
  // Register synchronously, before any await, so a double click can't start a
  // second watch (and a second tab) for the same dir.
  const w: Watch = { entry: { ...req, phase: 'starting', tabOpen: false }, tab: null, baseline: undefined, poll: null, timeout: null };
  watches.set(req.configDir, w);
  emit();
  const baseline = await readBaseline(req);
  if (watches.get(req.configDir) !== w) return; // cancelled meanwhile
  if (baseline === 'failed') {
    w.entry = { ...w.entry, phase: 'error' };
    emit();
    useStore.getState().pushToast({ level: 'error', message: t('accounts.loginStatusFailed', { name: req.name }) });
    return;
  }
  w.baseline = baseline;
  const tab = await openLoginTab(req);
  if (watches.get(req.configDir) !== w) { closeLoginTab(tab); return; }
  w.tab = tab;
  w.entry = { ...w.entry, tabOpen: tab !== null };
  startPolling(w);
}

/** Restart detection after a timeout (the login tab is left as it is), or retry
 *  from the start after a failed baseline read. */
export function checkAccountLoginAgain(configDir: string): void {
  const w = watches.get(configDir);
  if (!w || w.entry.phase === 'starting') return;
  if (w.entry.phase === 'error') {
    // The baseline was never read: start over from it.
    watches.delete(configDir);
    const { vendor, name, configDir: dir, loginCommand, accountId } = w.entry;
    void startAccountLogin({ vendor, name, configDir: dir, loginCommand, accountId });
    return;
  }
  startPolling(w);
}

/** Open a fresh login tab for a pending login (e.g. the first one was closed). */
export async function reopenAccountLoginTab(configDir: string): Promise<void> {
  const w = watches.get(configDir);
  if (!w || w.entry.phase === 'starting' || w.entry.phase === 'error') return;
  stopTimers(w);
  closeLoginTab(w.tab);
  w.tab = null;
  const tab = await openLoginTab(w.entry);
  if (watches.get(configDir) !== w) { closeLoginTab(tab); return; }
  w.tab = tab;
  w.entry = { ...w.entry, tabOpen: tab !== null };
  startPolling(w);
}

/** Stop waiting. A NEW account's login tab is closed too: once the watch is
 *  gone nothing would register the account if that login later completed. A
 *  re-login's tab stays, since the account is already registered. */
export function cancelAccountLogin(configDir: string): void {
  const w = watches.get(configDir);
  if (!w) return;
  stopTimers(w);
  watches.delete(configDir);
  emit();
  if (!w.entry.accountId) closeLoginTab(w.tab);
}
