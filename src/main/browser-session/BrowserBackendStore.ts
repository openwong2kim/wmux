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
 * Main-owned persistence for the browser backend setting (#517).
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

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, 'browser-backend.json');
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const record = parsed as { backend?: unknown; liveWriteScope?: unknown } | null;
      const value = record?.backend;
      if (isBrowserBackend(value)) this.backend = value;
      // Same fail-safe direction as the backend: anything unrecognized leaves
      // the DEFAULT in place, and the default here is the narrow grant.
      const scope = record?.liveWriteScope;
      if (isLiveWriteScope(scope)) this.liveScope = scope;
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

  setLiveWriteScope(scope: LiveWriteScope): void {
    this.liveScope = scope;
    this.persist();
  }

  set(backend: BrowserBackend): void {
    this.backend = backend;
    // persist() writes the scope field too, so pick up an operator's file edit
    // first rather than overwriting it with a stale in-memory value.
    this.liveWriteScope();
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      // Atomic write (tmp + rename): a crash mid-write must not leave a
      // truncated file that silently rolls an 'external' user back to builtin
      // on the next boot.
      const tmpPath = `${this.filePath}.tmp`;
      // The scope field is written only once it differs from the default, so a
      // file this app has never been asked to scope keeps exactly the shape it
      // had — nothing downstream has to learn a key that carries no decision.
      writeFileSync(
        tmpPath,
        JSON.stringify({
          backend: this.backend,
          ...(this.liveScope !== DEFAULT_LIVE_WRITE_SCOPE && { liveWriteScope: this.liveScope }),
        }),
        'utf8',
      );
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      // In-memory value still applies for this session; persistence is
      // best-effort but a failure must be visible in logs, not swallowed.
      console.error('[BrowserBackendStore] persist failed:', err);
    }
  }
}
