import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type BrowserBackend,
  DEFAULT_BROWSER_BACKEND,
  isBrowserBackend,
} from '../../shared/browserBackend';

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

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, 'browser-backend.json');
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const value = (parsed as { backend?: unknown } | null)?.backend;
      if (isBrowserBackend(value)) this.backend = value;
      // Unknown/corrupt content falls through to the builtin default — the
      // safe direction: worst case a pane spawns, never a broken toolset.
    } catch {
      /* missing or unreadable file → builtin default */
    }
  }

  get(): BrowserBackend {
    return this.backend;
  }

  set(backend: BrowserBackend): void {
    this.backend = backend;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      // Atomic write (tmp + rename): a crash mid-write must not leave a
      // truncated file that silently rolls an 'external' user back to builtin
      // on the next boot.
      const tmpPath = `${this.filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify({ backend }), 'utf8');
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      // In-memory value still applies for this session; persistence is
      // best-effort but a failure must be visible in logs, not swallowed.
      console.error('[BrowserBackendStore] persist failed:', err);
    }
  }
}
