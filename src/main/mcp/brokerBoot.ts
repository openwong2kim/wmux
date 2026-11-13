/**
 * The boot step that starts the MCP broker (when it is on) and registers the
 * MCP server in the agent configs, before the pipe server starts.
 *
 * Only a dev build waits for the broker: there `useShim` picks the node shim
 * when the broker answers in time. A packaged build never registers the node
 * shim; it registers the native launcher or the full bundle, and the launcher
 * falls back to its own server before the broker's ack, so a broker that is
 * slow to start must not hold up boot.
 */

/** How long a dev build waits for the broker before it registers the full bundle. */
export const DEV_BROKER_READY_TIMEOUT_MS = 4000;

export interface BrokerBootDeps {
  brokerEnabled: boolean;
  packaged: boolean;
  supervisor: { start(): void; whenReady(timeoutMs: number): Promise<boolean> };
  register(opts?: { useShim?: boolean }): Promise<unknown>;
}

export async function startBrokerAndRegister(deps: BrokerBootDeps): Promise<void> {
  if (!deps.brokerEnabled) {
    await deps.register();
    return;
  }
  deps.supervisor.start();
  if (deps.packaged) {
    await deps.register();
    return;
  }
  // whenReady never rejects and caps the wait at the timeout.
  const brokerReady = await deps.supervisor.whenReady(DEV_BROKER_READY_TIMEOUT_MS);
  await deps.register({ useShim: brokerReady });
}
