// ─── agy multi-account service — registry, swap, sign-in, quota gate ─────────
//
// See src/shared/agyAccounts.ts for why agy accounts are swapped rather than
// bound per pane. This service owns `agy-accounts.json` in the wmux data dir
// (labels, cooldowns, the auto-rotate switch — never a secret) and drives the
// vault. Every agy launch wmux types goes through `prepareLaunch()`: it keeps
// the active account while it has quota, swaps to the account with the most
// quota left when it does not, and refuses the launch when no account has
// quota — so wmux never keeps sending work to an account that is out.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import {
  agyAccountRow,
  chooseAgyAccount,
  normalizeAgyEmail,
  type AgyAccount,
  type AgyAccountQuotaSnapshot,
  type AgyAccountsSnapshot,
  type AgyLaunchDecision,
} from '../../shared/agyAccounts';
import { AgyVault, getAgyVaultBackend } from './agyVault';

interface AgyAccountsFile {
  version: number;
  autoRotate: boolean;
  accounts: AgyAccount[];
  /** Account the user picked by hand ("Use now" or a sign-in). Automatic switching never replaces it
   *  while it is the active one; cleared by another manual pick, its removal, or flipping the switch. */
  manualEmail?: string;
}

const SCHEMA_VERSION = 1;
const MAX_ACCOUNTS = 20;
const MAX_LABEL_CHARS = 80;
const LOGIN_POLL_MS = 2000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** File key for an account's quota snapshot. Must match quota-sink.js. */
export function agyQuotaKey(email: string): string {
  return createHash('sha256').update(normalizeAgyEmail(email)).digest('hex').slice(0, 16);
}

export function agyAccountQuotaPath(email: string, homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.wmux', 'quota', 'agy-accounts', `${agyQuotaKey(email)}.json`);
}

function sanitizeAccount(raw: unknown): AgyAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (typeof o.email !== 'string' || !o.email.includes('@')) return null;
  return {
    id: o.id,
    email: normalizeAgyEmail(o.email),
    label: typeof o.label === 'string' ? o.label.slice(0, MAX_LABEL_CHARS) : '',
    addedAt: typeof o.addedAt === 'number' ? o.addedAt : 0,
    ...(o.needsReauth === true ? { needsReauth: true } : {}),
  };
}

function sanitizeFile(raw: unknown): AgyAccountsFile {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const seen = new Set<string>();
  const accounts = (Array.isArray(o.accounts) ? o.accounts : [])
    .map(sanitizeAccount)
    .filter((a): a is AgyAccount => a !== null && !seen.has(a.email) && Boolean(seen.add(a.email)));
  // Automatic switching is opt-in: a new install, or a file without the field, keeps it off.
  const manual = typeof o.manualEmail === 'string' ? normalizeAgyEmail(o.manualEmail) : '';
  return {
    version: SCHEMA_VERSION,
    autoRotate: o.autoRotate === true,
    accounts,
    ...(manual && accounts.some((a) => a.email === manual) ? { manualEmail: manual } : {}),
  };
}

export class AgyAccountError extends Error {
  constructor(readonly code: 'unsupported' | 'not-found' | 'limit' | 'invalid' | 'busy' | 'swap-failed', message: string) {
    super(message);
    this.name = 'AgyAccountError';
  }
}

export interface AgyAccountServiceDeps {
  vault: AgyVault | null;
  dataDir?: string;
  homeDir?: string;
  now?: () => number;
  readSnapshot?: (email: string) => AgyAccountQuotaSnapshot | null;
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

export interface AgyLoginState {
  pending: boolean;
  previousEmail: string | null;
  startedAt: number | null;
  /** Email of the account the last sign-in landed on. */
  lastResult: string | null;
  /** Set when a cancelled or timed-out sign-in could not put this account back: agy is signed out. */
  restoreFailed?: string;
}

export class AgyAccountService {
  private readonly filePath: string;
  private readonly homeDir: string;
  private readonly now: () => number;
  private cache: AgyAccountsFile | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();
  private login: AgyLoginState = { pending: false, previousEmail: null, startedAt: null, lastResult: null };
  private loginTimer: { cancel: () => void } | null = null;
  /** Refresh-token digest of the sign-in that was active when the login began. Kept out of the
   *  login state the renderer sees. */
  private previousRefreshDigest: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: AgyAccountServiceDeps) {
    this.filePath = path.join(deps.dataDir ?? getWmuxDir(), 'agy-accounts.json');
    this.homeDir = deps.homeDir ?? os.homedir();
    this.now = deps.now ?? Date.now;
  }

  get supported(): boolean {
    return this.deps.vault !== null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) {
      try { l(); } catch { /* listener faults never break the service */ }
    }
  }

  private file(): AgyAccountsFile {
    if (!this.cache) {
      let raw: unknown = null;
      try { raw = atomicReadJSONSync<unknown>(this.filePath); } catch { raw = null; }
      this.cache = sanitizeFile(raw);
    }
    return this.cache;
  }

  private mutate<T>(fn: (file: AgyAccountsFile) => T): Promise<T> {
    const run = this.writeChain.then(async () => {
      const next = structuredClone(this.file());
      const result = fn(next);
      await atomicWriteJSON(this.filePath, next);
      this.cache = next;
      return result;
    });
    this.writeChain = run.catch(() => undefined);
    return run.then((r) => { this.emit(); return r; });
  }

  private readSnapshot(email: string): AgyAccountQuotaSnapshot | null {
    if (this.deps.readSnapshot) return this.deps.readSnapshot(email);
    try {
      const raw = JSON.parse(fs.readFileSync(agyAccountQuotaPath(email, this.homeDir), 'utf8')) as unknown;
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as AgyAccountQuotaSnapshot : null;
    } catch {
      return null;
    }
  }

  private vault(): AgyVault {
    if (!this.deps.vault) throw new AgyAccountError('unsupported', 'agy accounts need the Windows Credential Manager');
    return this.deps.vault;
  }

  snapshot(): AgyAccountsSnapshot {
    const file = this.file();
    const activeEmail = this.deps.vault?.activeEmail() ?? null;
    const now = this.now();
    return {
      supported: this.supported,
      autoRotate: file.autoRotate,
      activeEmail,
      accounts: file.accounts.map((a) => agyAccountRow(a, this.readSnapshot(a.email), activeEmail, now)),
    };
  }

  loginState(): AgyLoginState {
    return { ...this.login };
  }

  /** Register the account agy is signed in with right now (or refresh its vault copy). */
  async addCurrent(label = ''): Promise<AgyAccount> {
    const email = this.vault().captureActive();
    if (!email) throw new AgyAccountError('not-found', 'agy is not signed in');
    return this.register(email, label);
  }

  private register(email: string, label: string): Promise<AgyAccount> {
    return this.mutate((file) => {
      const existing = file.accounts.find((a) => a.email === email);
      if (existing) {
        delete existing.needsReauth;
        if (label.trim()) existing.label = label.trim().slice(0, MAX_LABEL_CHARS);
        return { ...existing };
      }
      if (file.accounts.length >= MAX_ACCOUNTS) throw new AgyAccountError('limit', `at most ${MAX_ACCOUNTS} agy accounts`);
      const account: AgyAccount = { id: randomUUID(), email, label: label.trim().slice(0, MAX_LABEL_CHARS), addedAt: this.now() };
      file.accounts.push(account);
      return { ...account };
    });
  }

  async rename(id: string, label: string): Promise<void> {
    await this.mutate((file) => {
      const a = file.accounts.find((x) => x.id === id);
      if (!a) throw new AgyAccountError('not-found', 'unknown agy account');
      a.label = label.trim().slice(0, MAX_LABEL_CHARS);
    });
  }

  /** Unregister and drop the vault copy. The live sign-in is left alone. */
  async remove(id: string): Promise<void> {
    const email = await this.mutate((file) => {
      const i = file.accounts.findIndex((x) => x.id === id);
      if (i < 0) throw new AgyAccountError('not-found', 'unknown agy account');
      const removed = file.accounts.splice(i, 1)[0].email;
      if (file.manualEmail === removed) delete file.manualEmail;
      return removed;
    });
    this.deps.vault?.removeCopy(email);
  }

  async setAutoRotate(on: boolean): Promise<void> {
    // Flipping the switch hands the choice back to the switch, so an earlier manual pick no longer holds.
    await this.mutate((file) => { file.autoRotate = on; delete file.manualEmail; });
  }

  /** Make an account the active agy sign-in. */
  async activate(id: string): Promise<void> {
    if (this.login.pending) throw new AgyAccountError('busy', 'an agy sign-in is in progress');
    const account = this.file().accounts.find((a) => a.id === id);
    if (!account) throw new AgyAccountError('not-found', 'unknown agy account');
    const result = this.vault().activate(account.email);
    if (result === 'no-copy') {
      await this.mutate((file) => {
        const a = file.accounts.find((x) => x.id === id);
        if (a) a.needsReauth = true;
      });
      throw new AgyAccountError('swap-failed', 'this account has no saved sign-in; sign in to it again');
    }
    if (result === 'live-not-saved') {
      throw new AgyAccountError('swap-failed', 'the current agy sign-in could not be saved, so it was not replaced');
    }
    if (result !== 'ok') throw new AgyAccountError('swap-failed', 'could not switch the agy sign-in');
    await this.mutate((file) => { file.manualEmail = account.email; });
  }

  /**
   * Start adding an account: save the live sign-in, sign agy out, and wait
   * for a new sign-in to land in the slot (the user signs in from the agy
   * pane the renderer opens). The previous account is restored when the
   * sign-in is cancelled or times out.
   */
  async beginLogin(): Promise<AgyLoginState> {
    const vault = this.vault();
    if (this.login.pending) return this.loginState();
    const previousEmail = vault.activeEmail();
    this.previousRefreshDigest = vault.activeRefreshDigest();
    if (previousEmail && this.file().accounts.some((a) => a.email === previousEmail)) vault.captureActive();
    else if (previousEmail) await this.addCurrent();
    if (!vault.signOutActive()) throw new AgyAccountError('swap-failed', 'could not sign agy out');
    this.login = { pending: true, previousEmail, startedAt: this.now(), lastResult: null };
    this.emit();
    this.scheduleLoginPoll();
    return this.loginState();
  }

  private scheduleLoginPoll(): void {
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return { cancel: () => clearTimeout(t) };
    });
    this.loginTimer = set(() => { void this.pollLogin(); }, LOGIN_POLL_MS);
  }

  /** One poll step; exposed for tests. */
  async pollLogin(): Promise<void> {
    if (!this.login.pending) return;
    const email = this.deps.vault?.activeEmail() ?? null;
    // An agy session left running refreshes its access token and rewrites the slot with the account just
    // signed out; that is not the new sign-in. A real sign-in, even to the same account, has a new
    // refresh token, so compare that rather than the email.
    const digest = this.deps.vault?.activeRefreshDigest() ?? null;
    if (email && email === this.login.previousEmail && digest === this.previousRefreshDigest) {
      this.deps.vault?.signOutActive();
    } else if (email) {
      this.login = { ...this.login, pending: false, lastResult: email };
      this.loginTimer = null;
      await this.addCurrent();
      await this.mutate((file) => { file.manualEmail = email; });
      return;
    }
    if (this.now() - (this.login.startedAt ?? 0) > LOGIN_TIMEOUT_MS) {
      await this.cancelLogin();
      return;
    }
    this.scheduleLoginPoll();
  }

  async cancelLogin(): Promise<void> {
    if (!this.login.pending) return;
    this.loginTimer?.cancel();
    this.loginTimer = null;
    const previous = this.login.previousEmail;
    this.login = { pending: false, previousEmail: null, startedAt: null, lastResult: null };
    if (previous && !this.deps.vault?.activeEmail() && this.deps.vault?.activate(previous) !== 'ok') {
      console.warn('[agy-accounts] could not restore the previous agy sign-in after a cancelled sign-in');
      this.login.restoreFailed = previous;
    }
    this.emit();
  }

  /**
   * Gate for every agy launch wmux types. Never throws: an unsupported
   * platform or an empty registry lets the launch through unchanged.
   */
  async prepareLaunch(): Promise<AgyLaunchDecision> {
    if (!this.deps.vault || this.login.pending) return { ok: true, account: null, switched: false };
    const snap = this.snapshot();
    if (snap.accounts.length === 0) return { ok: true, account: null, switched: false };
    // Fold agy's own token refreshes back into the vault copy first.
    if (snap.activeEmail && snap.accounts.some((a) => a.active)) this.deps.vault.captureActive();
    const manual = this.file().manualEmail;
    if (!snap.autoRotate || (manual && snap.activeEmail === manual)) {
      // Rotation off, or the active account is the user's own pick: never swap, but still refuse an
      // active account that is out.
      const active = snap.accounts.find((a) => a.active);
      if (!active || active.state === 'active') return { ok: true, account: active ?? null, switched: false };
      return { ok: false, reason: 'all-exhausted', availableAtMs: active.availableAtMs };
    }
    const decision = chooseAgyAccount(snap.accounts);
    if (!decision.ok || !decision.switched || !decision.account) return decision;
    const result = this.deps.vault.activate(decision.account.email);
    if (result === 'no-copy') {
      await this.mutate((file) => {
        const a = file.accounts.find((x) => x.id === decision.account?.id);
        if (a) a.needsReauth = true;
      });
      return this.prepareLaunch();
    }
    if (result !== 'ok') {
      // The live sign-in could not be saved (or the write failed): never replace it. An active account
      // wmux knows is out is held as usual; any other sign-in starts as it would without wmux.
      console.warn(`[agy-accounts] not switching agy for this launch (${result})`);
      const active = snap.accounts.find((a) => a.active);
      if (active?.state === 'exhausted') return { ok: false, reason: 'all-exhausted', availableAtMs: active.availableAtMs };
      return { ok: true, account: active ?? null, switched: false };
    }
    console.log(`[agy-accounts] switched agy to account ${decision.account.id} for this launch`);
    this.emit();
    return decision;
  }

  dispose(): void {
    this.loginTimer?.cancel();
    this.loginTimer = null;
    this.listeners.clear();
  }
}

let instance: AgyAccountService | null = null;

export function getAgyAccountService(): AgyAccountService {
  if (!instance) {
    const backend = getAgyVaultBackend();
    instance = new AgyAccountService({ vault: backend ? new AgyVault(backend) : null });
  }
  return instance;
}

export function __resetAgyAccountServiceForTests(): void {
  instance?.dispose();
  instance = null;
}
