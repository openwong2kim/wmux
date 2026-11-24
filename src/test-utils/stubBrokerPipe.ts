/**
 * The listening end of a stub broker, for tests that run the native MCP shim
 * against one. The shim takes a Windows pipe only when its owner is this user
 * (core/wmux-native/src/mcp_shim.rs). A net.createServer pipe made by an
 * elevated process (a CI runner) is owned by Administrators instead, so on
 * Windows the stub listens through the terminal core's native pipe listener,
 * as the real broker does; the core must load (WMUX_TERMINAL_CORE_MODULE names
 * it in CI). Elsewhere it is a plain net server.
 */
import * as net from 'net';
import type { Duplex } from 'stream';
import { listenNativePipe, loadNativePipe } from '../mcp/nativePipe';

export interface StubBrokerServer {
  /** Stops listening and destroys every accepted connection. Resolves once
   *  the name is free, so the next stub can listen on it. */
  close(): Promise<void>;
}

export interface StubBrokerOptions {
  /** net only: the accepted sockets' readable high-water mark. */
  highWaterMark?: number;
}

const NAME_FREE_WAIT_MS = 5000;

export async function listenStubBroker(
  name: string,
  onConnection: (sock: Duplex) => void,
  options: StubBrokerOptions = {},
): Promise<StubBrokerServer> {
  const sockets = new Set<Duplex>();
  const accept = (sock: Duplex): void => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    onConnection(sock);
  };
  if (process.platform === 'win32') {
    let module: ReturnType<typeof loadNativePipe>;
    try {
      module = loadNativePipe();
    } catch (e) {
      throw new Error('a Windows stub broker needs the terminal core: run `npm run build:terminal-core` and set ' +
        `WMUX_TERMINAL_CORE_MODULE to dist/wmux-native/index.cjs (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!module) throw new Error('the native pipe listener is unavailable');
    const server = listenNativePipe(name, { maxInstances: 4, module, onConnection: accept });
    return {
      async close() {
        server.close();
        for (const sock of sockets) sock.destroy();
        const deadline = Date.now() + NAME_FREE_WAIT_MS;
        while (module.nativePipeOwnedByUs(name) !== 'none') {
          if (Date.now() > deadline) throw new Error(`${name} is still held after the stub closed`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
    };
  }
  const srv = net.createServer({ highWaterMark: options.highWaterMark }, accept);
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(name, () => resolve());
  });
  return {
    close: () => new Promise<void>((resolve) => {
      for (const sock of sockets) sock.destroy();
      srv.close(() => resolve());
    }),
  };
}
