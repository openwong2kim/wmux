import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { McpRegistrar, McpRegistrarStatus } from '../../mcp/McpRegistrar';

/**
 * Serializable shape returned to the renderer. Mirrors {@link McpRegistrarStatus}
 * but converts Date → ISO string so it survives Electron's structured clone
 * across the IPC boundary without surprising consumers (Date is technically
 * cloneable, but ISO strings are friendlier for the React side that just
 * formats them for display).
 */
/** Per-target serialized status (Date → ISO string for the IPC boundary). */
export interface McpTargetStatusPayload {
  id: string;
  displayName: string;
  format: 'json' | 'toml';
  configPath: string;
  configExists: boolean;
  /** ISO 8601 string, or null when the config file does not exist. */
  configModified: string | null;
  verified: boolean;
  wmux: { registered: boolean; path: string | null };
  wmuxA2a: { registered: boolean; path: string | null };
}

export interface McpStatusPayload {
  targets: McpTargetStatusPayload[];
}

function serialize(status: McpRegistrarStatus): McpStatusPayload {
  return {
    targets: status.targets.map((t) => ({
      id: t.id,
      displayName: t.displayName,
      format: t.format,
      configPath: t.configPath,
      configExists: t.configExists,
      configModified: t.configModified ? t.configModified.toISOString() : null,
      verified: t.verified,
      wmux: t.wmux,
      wmuxA2a: t.wmuxA2a,
    })),
  };
}

/**
 * Register IPC handlers that surface MCP integration state to the renderer
 * (Settings → General → MCP section). Mirrors the `wmux mcp …` CLI commands so
 * users can verify / reset registration from either GUI or terminal.
 *
 * @param registrar    The shared McpRegistrar instance (owned by main/index.ts).
 * @param getAuthToken Lazy accessor for the active pipe-server auth token. The
 *                     re-register path needs the live token; we read it lazily
 *                     so this handler can be wired up before the pipe server
 *                     finishes starting (it logs and refuses gracefully if the
 *                     token isn't available yet).
 */
export function registerMcpHandlers(
  registrar: McpRegistrar,
  getAuthToken: () => string | null,
): () => void {
  // wrapHandler is variadic and treats its first argument (the IpcMainInvokeEvent)
  // as transport plumbing; we can omit the parameter entirely on the inner
  // handler since none of these read renderer/sender info.
  ipcMain.removeHandler(IPC.MCP_CHECK);
  ipcMain.handle(
    IPC.MCP_CHECK,
    wrapHandler(IPC.MCP_CHECK, async (): Promise<McpStatusPayload> => {
      return serialize(registrar.getStatus());
    }),
  );

  ipcMain.removeHandler(IPC.MCP_REREGISTER);
  ipcMain.handle(
    IPC.MCP_REREGISTER,
    wrapHandler(IPC.MCP_REREGISTER, async (): Promise<McpStatusPayload> => {
      const token = getAuthToken();
      if (!token) {
        // Pipe server not yet ready — surface to renderer rather than crash.
        throw new Error('MCP re-register unavailable: auth token not ready (pipe server still starting)');
      }
      registrar.register(token);
      return serialize(registrar.getStatus());
    }),
  );

  ipcMain.removeHandler(IPC.MCP_UNREGISTER);
  ipcMain.handle(
    IPC.MCP_UNREGISTER,
    wrapHandler(IPC.MCP_UNREGISTER, async (): Promise<McpStatusPayload> => {
      registrar.forceUnregister();
      return serialize(registrar.getStatus());
    }),
  );

  return () => {
    ipcMain.removeHandler(IPC.MCP_CHECK);
    ipcMain.removeHandler(IPC.MCP_REREGISTER);
    ipcMain.removeHandler(IPC.MCP_UNREGISTER);
  };
}
