import * as pty from 'node-pty';
import os from 'node:os';
import { getPipeName, ENV_KEYS } from '../../shared/constants';

export interface PTYInstance {
  id: string;
  process: pty.IPty;
  shell: string;
}

const MAX_PTY_INSTANCES = 20;

export class PTYManager {
  private instances = new Map<string, PTYInstance>();
  private nextId = 0;
  private onDisposeCallback: ((ptyId: string) => void) | null = null;

  onDispose(callback: (ptyId: string) => void): void {
    this.onDisposeCallback = callback;
  }

  create(options?: {
    shell?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    workspaceId?: string;
    surfaceId?: string;
  }): PTYInstance {
    if (this.instances.size >= MAX_PTY_INSTANCES) {
      throw new Error('Maximum PTY instances reached');
    }
    const id = `pty-${++this.nextId}`;
    const shell = options?.shell || this.getDefaultShell();
    const cwd = options?.cwd || os.homedir();

    // Filter out sensitive and build-only variables to prevent leaking internal state to child processes
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(globalThis.process.env)) {
      if (value === undefined) continue;
      if (key.startsWith('ELECTRON_')) continue;
      if (key.startsWith('VITE_')) continue;
      if (key === 'NODE_OPTIONS') continue;
      if (key === 'ELECTRON_RUN_AS_NODE') continue;
      env[key] = value;
    }
    env[ENV_KEYS.SOCKET_PATH] = getPipeName();
    if (options?.workspaceId) env[ENV_KEYS.WORKSPACE_ID] = options.workspaceId;
    if (options?.surfaceId) env[ENV_KEYS.SURFACE_ID] = options.surfaceId;
    // Security: auth token is NOT passed via environment variable to prevent
    // malicious child processes (e.g. npm packages) from accessing it.
    // CLI/MCP clients read the token directly from ~/.wmux-auth-token file.

    const process = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: options?.cols || 80,
      rows: options?.rows || 24,
      cwd,
      env,
      useConpty: true,
    });

    const instance: PTYInstance = { id, process, shell };
    this.instances.set(id, instance);
    return instance;
  }

  write(id: string, data: string): void {
    const instance = this.instances.get(id);
    if (instance) {
      instance.process.write(data);
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id);
    if (instance) {
      instance.process.resize(cols, rows);
    }
  }

  dispose(id: string): void {
    const instance = this.instances.get(id);
    if (instance) {
      try { instance.process.kill(); } catch { /* already dead */ }
      this.onDisposeCallback?.(id);
      this.instances.delete(id);
    }
  }

  /** Remove an entry from the map without killing — use when the process has already exited. */
  remove(id: string): void {
    this.instances.delete(id);
  }

  get(id: string): PTYInstance | undefined {
    return this.instances.get(id);
  }

  /** Return summary of all active PTY instances for crash recovery reconnection. */
  getActiveInstances(): { id: string; shell: string }[] {
    const result: { id: string; shell: string }[] = [];
    for (const instance of this.instances.values()) {
      result.push({ id: instance.id, shell: instance.shell });
    }
    return result;
  }

  disposeAll(): void {
    for (const id of Array.from(this.instances.keys())) {
      this.dispose(id);
    }
  }

  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      // PowerShell 우선 (cd로 드라이브 전환 자동 지원)
      return 'powershell.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }
}
