import * as net from 'net';

const DEFAULT_PORT_MIN = 18800;
const DEFAULT_PORT_MAX = 18899;

/**
 * Manages CDP port allocation for WinMux instances.
 * Prevents multi-instance port collisions by probing ports before assignment.
 */
export class PortAllocator {
  private readonly min: number;
  private readonly max: number;
  private readonly envVar: string | null;
  private allocatedPort: number | null = null;

  constructor(portRange?: { min: number; max: number; envVar?: string | null }) {
    this.min = portRange?.min ?? DEFAULT_PORT_MIN;
    this.max = portRange?.max ?? DEFAULT_PORT_MAX;
    // undefined keeps the legacy WMUX_CDP_PORT behavior; null disables the
    // env override entirely (the chrome launcher's allocator must not throw
    // because the user pinned the Electron CDP port outside its range).
    this.envVar = portRange?.envVar === undefined ? 'WMUX_CDP_PORT' : portRange.envVar;
  }

  /**
   * Allocate an available CDP port.
   * If WMUX_CDP_PORT env var is set and within range, tries that first.
   */
  async allocate(): Promise<number> {
    if (this.allocatedPort !== null) {
      return this.allocatedPort;
    }

    // Prefer env-specified port
    const envPort = this.envVar && process.env[this.envVar]
      ? Number(process.env[this.envVar])
      : null;

    if (envPort !== null) {
      if (envPort < this.min || envPort > this.max) {
        throw new Error(
          `${this.envVar} ${envPort} is out of range (${this.min}-${this.max})`
        );
      }
      if (await this.isPortAvailable(envPort)) {
        this.allocatedPort = envPort;
        return envPort;
      }
      throw new Error(`${this.envVar} ${envPort} is already in use`);
    }

    // Scan range for an available port
    for (let port = this.min; port <= this.max; port++) {
      if (await this.isPortAvailable(port)) {
        this.allocatedPort = port;
        return port;
      }
    }

    throw new Error(
      `No available CDP port in range ${this.min}-${this.max}`
    );
  }

  /** Release the currently allocated port. */
  release(port: number): void {
    if (this.allocatedPort === port) {
      this.allocatedPort = null;
    }
  }

  /** Get the currently allocated port, or null if none. */
  getPort(): number | null {
    return this.allocatedPort;
  }

  /** Check if a port is available by attempting to bind a temporary server. */
  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
  }
}
