import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type BrowserBackend,
  DEFAULT_BROWSER_BACKEND,
  isBrowserBackend,
} from '../../shared/browserBackend';
import {
  DEFAULT_LIVE_WRITE_SCOPE,
  isLiveWriteScope,
  type LiveWriteScope,
} from '../../shared/liveWriteScope';

/**
 * Main-owned persistence for the browser backend setting (#517), and the
 * other browser settings main decides on (the live write scope, the
 * private-network opt-in).
 *
 * Main is the authority on purpose: the consumer is the RPC layer in the main
 * process, and an RPC call can arrive before the renderer has booted. Reading
 * the value synchronously at construction means there is no settled gate, no
 * timeout fallback, and no startup race — browser.open sees the right value
 * from the first call. The renderer Settings UI reads/writes over IPC and
 * keeps only a non-persisted mirror for rendering.
 */
export class BrowserBackendStore {
  private readonly filePath: string;
  private backend: BrowserBackend = DEFAULT_BROWSER_BACKEND;
  /**
   * How far an agent may WRITE on the live backend (the agent-window policy).
   *
   * Operator-only, and deliberately not in the Settings UI: 'all' is the larger
   * grant, and a switch that hands an agent every logged-in tab in the user's
   * browser should cost an edit to this file rather than one click.
   */
  private liveScope: LiveWriteScope = DEFAULT_LIVE_WRITE_SCOPE;
  /**
   * Settings → Browser → Allow private network addresses: whether agent
   * navigation may reach RFC1918 and fc00::/7 (the navigation policy in
   * shared/types). Main is the only writer (the Settings IPC), so the
   * in-memory value is the one in force: a toggle reaches the very next
   * navigation, here and — over browser.navigationPolicy.get — in the MCP
   * server's preflight.
   */
  private privateNetwork = false;
  /**
   * Whether a protected profile starts on the DevTools port instead of the
   * debugging pipe, where a client of the port reaches it without the pipe's
   * rules. Operator-only like the live write scope: set by editing this file,
   * never from the Settings UI or an RPC.
   */
  private protectedPort = false;

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, 'browser-backend.json');
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const record = parsed as
        | { backend?: unknown; liveWriteScope?: unknown; allowPrivateNetwork?: unknown; protectedPortTransport?: unknown }
        | null;
      const value = record?.backend;
      if (isBrowserBackend(value)) this.backend = value;
      // Same fail-safe direction as the backend: anything unrecognized leaves
      // the DEFAULT in place, and the default here is the narrow grant.
      const scope = record?.liveWriteScope;
      if (isLiveWriteScope(scope)) this.liveScope = scope;
      // Only a literal true opts in: it widens what an agent may reach.
      this.privateNetwork = record?.allowPrivateNetwork === true;
      // Only a literal true opts in: it lets a protected profile run on the port.
      this.protectedPort = record?.protectedPortTransport === true;
      // Unknown/corrupt content falls through to the builtin default — the
      // safe direction: worst case a pane spawns, never a broken toolset.
    } catch {
      /* missing or unreadable file → builtin default */
    }
  }

  get(): BrowserBackend {
    return this.backend;
  }

  /**
   * The live write scope as persisted. Re-read from the file on every call:
   * this setting is operator-only and lives in the file precisely so that
   * widening it costs an edit, and that edit has to take effect without a
   * restart — and must not be silently reverted by the next backend write,
   * which persists whatever this field holds. An unreadable or unrecognised
   * value keeps the last good one (the narrow grant on a fresh store).
   */
  liveWriteScope(): LiveWriteScope {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const scope = (parsed as { liveWriteScope?: unknown } | null)?.liveWriteScope;
      this.liveScope = isLiveWriteScope(scope) ? scope : DEFAULT_LIVE_WRITE_SCOPE;
    } catch {
      /* missing or unreadable file → keep the in-memory value */
    }
    return this.liveScope;
  }

  /**
   * The protected-port setting as persisted, re-read from the file on every
   * call for the same reasons as liveWriteScope(). An unreadable file keeps
   * the last good value (off on a fresh store).
   */
  protectedPortTransport(): boolean {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      this.protectedPort = (parsed as { protectedPortTransport?: unknown } | null)?.protectedPortTransport === true;
    } catch {
      /* missing or unreadable file → keep the in-memory value */
    }
    return this.protectedPort;
  }

  setLiveWriteScope(scope: LiveWriteScope): void {
    this.liveScope = scope;
    this.persist();
  }

  allowPrivateNetwork(): boolean {
    return this.privateNetwork;
  }

  /**
   * Returns whether the change was saved. Unsaved, the in-memory value lands on
   * the narrow side either way: an opt-out still applies for this session (and
   * the caller must say it will not survive a restart), and an opt-in does not
   * apply at all — access is never widened on a change the file does not hold.
   */
  setAllowPrivateNetwork(allow: boolean): boolean {
    this.privateNetwork = allow;
    // Same reason as set(): persist() writes the operator fields too.
    this.liveWriteScope();
    this.protectedPortTransport();
    const saved = this.persist();
    if (!saved && allow) this.privateNetwork = false;
    return saved;
  }

  set(backend: BrowserBackend): void {
    this.backend = backend;
    // persist() writes the operator fields too, so pick up an operator's file
    // edit first rather than overwriting it with a stale in-memory value.
    this.liveWriteScope();
    this.protectedPortTransport();
    this.persist();
  }

  /** Whether the write reached the file. */
  private persist(): boolean {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      // Atomic write (tmp + rename): a crash mid-write must not leave a
      // truncated file that silently rolls an 'external' user back to builtin
      // on the next boot.
      const tmpPath = `${this.filePath}.tmp`;
      // The scope and private-network fields are written only once they differ
      // from their defaults, so a file this app has never been asked to scope
      // keeps exactly the shape it had — nothing downstream has to learn a key
      // that carries no decision.
      writeFileSync(
        tmpPath,
        JSON.stringify({
          backend: this.backend,
          ...(this.liveScope !== DEFAULT_LIVE_WRITE_SCOPE && { liveWriteScope: this.liveScope }),
          ...(this.privateNetwork && { allowPrivateNetwork: true }),
          ...(this.protectedPort && { protectedPortTransport: true }),
        }),
        'utf8',
      );
      renameSync(tmpPath, this.filePath);
      return true;
    } catch (err) {
      // The backend and scope keep their in-memory value for this session;
      // setAllowPrivateNetwork decides for itself (see there). A failure must
      // be visible in logs, not swallowed.
      console.error('[BrowserBackendStore] persist failed:', err);
      return false;
    }
  }
}
