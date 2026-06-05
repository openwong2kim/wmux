import * as pty from 'node-pty';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { getPipeName, ENV_KEYS, getPidMapDir } from '../../shared/constants';
import { resolveSpawnEnv } from './resolveSpawnEnv';
import { isWindows } from '../../shared/platform';

export type ShellType = 'powershell' | 'bash' | 'cmd' | 'unknown';

export interface PTYInstance {
  id: string;
  process: pty.IPty;
  shell: string;
  /**
   * Workspace this PTY belongs to. Captured at create time so the EventBus
   * can scope process.* events without consulting the renderer state.
   * Optional — undefined when the PTY was created without a workspace context
   * (CLI tools, tests). Used only for EventBus scoping; absence skips emission.
   */
  workspaceId?: string;
}

const MAX_PTY_INSTANCES = 20;

export class PTYManager {
  private instances = new Map<string, PTYInstance>();
  private nextId = 0;
  private onDisposeCallback: ((ptyId: string) => void) | null = null;

  onDispose(callback: (ptyId: string) => void): void {
    this.onDisposeCallback = callback;
  }

  /**
   * Detect shell type from the shell executable path.
   */
  detectShellType(shellPath: string): ShellType {
    const lower = shellPath.toLowerCase();
    const base = path.basename(lower);
    if (base.includes('pwsh') || base.includes('powershell')) return 'powershell';
    if (base.includes('bash') || base.includes('wsl')) return 'bash';
    if (base.includes('cmd')) return 'cmd';
    return 'unknown';
  }

  /**
   * Resolve the shell-hooks directory.
   * In development: relative to source tree.
   * In production (packaged): extraResources in process.resourcesPath.
   */
  getShellHooksDir(): string {
    // Check if running in packaged Electron app (asar)
    const appPath = typeof globalThis.__dirname !== 'undefined' ? globalThis.__dirname : __dirname;
    const isPackaged = appPath.includes('app.asar');

    if (isPackaged) {
      // Production: shell-hooks copied to resources via extraResource
      return path.join(process.resourcesPath, 'shell-hooks');
    }
    // Development: resolve from source tree
    // __dirname in Vite build is .vite/build, so navigate to project root
    const candidates = [
      path.join(appPath, '..', '..', 'src', 'main', 'pty', 'shell-hooks'),
      path.join(appPath, 'src', 'main', 'pty', 'shell-hooks'),
      path.resolve('src', 'main', 'pty', 'shell-hooks'),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(dir)) return dir;
    }
    return path.resolve('src', 'main', 'pty', 'shell-hooks');
  }

  /**
   * Build shell args and env additions for hook injection.
   */
  buildHookInjection(
    shellType: ShellType,
    env: Record<string, string>,
  ): { args: string[]; env: Record<string, string> } {
    const hooksDir = this.getShellHooksDir();
    const args: string[] = [];

    switch (shellType) {
      case 'powershell': {
        const hookPath = path.join(hooksDir, 'pwsh.ps1');
        if (fs.existsSync(hookPath)) {
          env[ENV_KEYS.SHELL_HOOK] = hookPath;
          // Use -NoExit -Command to dot-source the hook script
          // Quoting with single quotes inside double quotes handles spaces in path
          args.push('-NoExit', '-Command', `. '${hookPath}'`);
        }
        break;
      }
      case 'bash': {
        const hookPath = path.join(hooksDir, 'bash.sh');
        if (fs.existsSync(hookPath)) {
          env[ENV_KEYS.SHELL_HOOK] = hookPath;
          // --rcfile replaces the default .bashrc loading; our hook sources .bashrc itself
          args.push('--rcfile', hookPath);
        }
        break;
      }
      case 'cmd': {
        // CMD: set PROMPT with OSC 7 escape for CWD reporting.
        // Windows-only — cmd.exe does not exist on macOS/Linux, and the
        // PROMPT env var has different semantics on Unix shells.
        if (!isWindows) break;
        // $E = ESC, $P = current drive and path, $G = >
        env['PROMPT'] = '$E]7;file://$COMPUTERNAME/$P$E\\$P$G';
        env[ENV_KEYS.SHELL_HOOK_ACTIVE] = '1';
        break;
      }
      default:
        // Unknown shell — no hook injection
        break;
    }

    return { args, env };
  }

  create(options?: {
    shell?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    workspaceId?: string;
    surfaceId?: string;
    /** Workspace profile env overlay (see PtyCreateOptions.env). */
    env?: Record<string, string>;
  }): PTYInstance {
    if (this.instances.size >= MAX_PTY_INSTANCES) {
      throw new Error('Maximum PTY instances reached');
    }
    const id = `pty-${++this.nextId}`;
    const shell = options?.shell || this.getDefaultShell();
    const cwd = options?.cwd || os.homedir();

    // Filter out sensitive and build-only variables to prevent leaking
    // internal state to child processes. Shared with DaemonSessionManager
    // via src/shared/envFilter so both spawn paths evolve in lockstep —
    // previously this filter was laxer than the daemon's and would leak
    // WMUX_AUTH_TOKEN, GITHUB_TOKEN, ANTHROPIC_API_KEY, etc. to shells.
    // Resolve the child env in the canonical order (safe baseline → profile
    // overlay → forced identity); see resolveSpawnEnv. Identity is forced last
    // so a profile can never spoof socket path / workspace / surface.
    // Security: auth token is NEVER passed via env — buildSafeChildEnv strips
    // WMUX_AUTH*, so any inherited token from the main process is dropped. CLI/
    // MCP clients read the token from ~/.wmux-auth-token instead.
    const identity: Record<string, string> = { [ENV_KEYS.SOCKET_PATH]: getPipeName() };
    if (options?.workspaceId) identity[ENV_KEYS.WORKSPACE_ID] = options.workspaceId;
    if (options?.surfaceId) identity[ENV_KEYS.SURFACE_ID] = options.surfaceId;
    const env = resolveSpawnEnv(globalThis.process.env, options?.env, identity);

    // Detect shell type and inject hook
    const shellType = this.detectShellType(shell);
    const hookInjection = this.buildHookInjection(shellType, env);

    // node-pty throws synchronously on a missing/invalid shell binary or an
    // unreadable cwd (common on macOS/Linux where the shell path differs from
    // Windows). Surface an actionable error instead of the raw node-pty throw.
    // (useConpty is a Windows-only hint; node-pty ignores it elsewhere.)
    let ptyProcess: ReturnType<typeof pty.spawn>;
    try {
      ptyProcess = pty.spawn(shell, hookInjection.args, {
        name: 'xterm-256color',
        cols: options?.cols || 80,
        rows: options?.rows || 24,
        cwd,
        env: hookInjection.env,
        useConpty: true,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to start shell "${shell}" in "${cwd}": ${detail}`);
    }

    const instance: PTYInstance = {
      id,
      process: ptyProcess,
      shell,
      ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
    };
    this.instances.set(id, instance);

    // Write PID->ptyId mapping so MCP servers can resolve identity (Claude
    // Code doesn't propagate env vars to MCP child processes). We store the
    // ptyId (stable) rather than the workspaceId — the owning workspace is
    // resolved live by a2a.resolve.identity, so it can't go stale if the
    // workspace id is re-minted.
    if (ptyProcess.pid) {
      this.writePidMap(ptyProcess.pid, id);
    }

    return instance;
  }

  private writePidMap(pid: number, ptyId: string): void {
    try {
      const dir = getPidMapDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/${pid}`, ptyId, 'utf8');
    } catch { /* best-effort */ }
  }

  private removePidMap(pid: number): void {
    try {
      fs.unlinkSync(`${getPidMapDir()}/${pid}`);
    } catch { /* best-effort */ }
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
      this.removePidMap(instance.process.pid);
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
      // Try PowerShell paths in order — basename alone may fail
      // if Electron's PATH is limited (e.g. installed via install.ps1)
      const candidates = [
        `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        `${process.env.ProgramFiles}\\PowerShell\\7\\pwsh.exe`,
        'powershell.exe',
        'cmd.exe',
      ];
      for (const s of candidates) {
        try { if (fs.existsSync(s)) return s; } catch { /* skip */ }
      }
      return 'cmd.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }
}
