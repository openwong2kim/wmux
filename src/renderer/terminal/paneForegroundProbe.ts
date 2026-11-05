/**
 * Process truth for the #1792 prompt-mode guard (desktop only, #1794 review
 * item 1): is the process that armed a pane's mouse / focus reporting gone, or
 * does it still run behind the prompt the shell just printed?
 *
 * A prompt mark does not say. A TUI launched in the background
 * (`Start-Process -NoNewWindow`, `cmd &`) or stopped with Ctrl+Z is alive
 * behind the prompt and must keep its mouse. Sources, strongest first:
 *
 *  1. Windows, native panes: the pane shell's descendant tree
 *     (`pty.resources`, one Win32_Process snapshot, the Fleet chip's walk).
 *     No descendant = gone; any descendant = alive. The snapshot is taken
 *     after the prompt mark parsed, and the shell prints its prompt only after
 *     a foreground child exited, so a killed TUI is already missing from it.
 *     An unrelated long-lived child of the shell (a profile-started helper)
 *     reads as alive too: the guard then leaves the modes alone, which never
 *     takes a live TUI's mouse. Not for WSL panes: the Linux processes behind
 *     `wsl.exe` are not in the Windows table, so an empty walk proves nothing.
 *  2. Elsewhere (POSIX, WSL panes, or when the snapshot failed): `pty.list`.
 *     Its `commandRunning` is OSC 133 state, NOT process truth — it reads
 *     `false` for a background or stopped job too — so it only rules out a
 *     reading that predates the prompt. The process truth there is the agent
 *     tracker (`agentProcessAlive` / `liveAgent`), which knows agents (claude,
 *     codex, ...) only, and whose death edge lags by one ProcessMonitor tick
 *     (15 s). So a live-agent reading counts as "alive" only once that lag has
 *     passed since the prompt; earlier it is unknown, and the guard keeps
 *     dropping reports and asks again. A background or stopped non-agent TUI
 *     is not protected there (no descendant walk).
 *
 * Fresh on every call: both are asked on demand, after the prompt mark, never
 * read from the 15 s `pty.list` poll's store maps, which can predate it.
 */
import type { ForegroundGoneProbe } from '../../shared/terminal/shellPromptModeReset';
import { validWslTarget } from '../../shared/wslTarget';
import { isWslDistroSpawnArgs, isWslShellPath } from '../../shared/wslDistro';

/** ProcessMonitor's 15 s death-check cadence plus one poll of margin. */
export const AGENT_DEATH_LAG_MS = 20_000;

type ListedSession = {
  id: string;
  shell?: string;
  args?: string[];
  commandRunning?: boolean;
  agentProcessAlive?: boolean;
  liveAgent?: string;
  wslTarget?: unknown;
};

export interface PaneForegroundApi {
  resources(ptyIds: string[]): Promise<Record<string, { rss: number; image?: string }>>;
  list(): Promise<ReadonlyArray<ListedSession>>;
}

export function paneForegroundProbe(
  ptyId: string,
  api: PaneForegroundApi,
  now: () => number = Date.now,
): ForegroundGoneProbe {
  return async ({ promptAt }) => {
    let session: ListedSession | undefined;
    let listed = false;
    try {
      session = (await api.list()).find((x) => x.id === ptyId);
      listed = true;
    } catch {
      // the tree may still answer
    }
    if (!session?.wslTarget) {
      try {
        const tree = (await api.resources([ptyId]))[ptyId];
        if (tree) return tree.image === undefined;
      } catch {
        // fall through to the OSC 133 + agent-tracker answer
      }
    }
    if (!listed) return undefined;
    // Unknown (no shell integration proof) or a reading from before the prompt.
    if (!session || session.commandRunning !== false) return undefined;
    const agentAlive = session.agentProcessAlive === true || session.liveAgent !== undefined;
    if (!agentAlive) return true;
    return now() - promptAt >= AGENT_DEATH_LAG_MS ? false : undefined;
  };
}

/**
 * Whether a pane's shell runs inside WSL, read from its session: a WSL target
 * or a `wsl.exe` shell path. The tab's `shell` field is a display label
 * ("Terminal" for Ctrl+T and palette tabs), so it cannot answer this. `distro`
 * is set only when the session names one (a `wslTarget`, or `wsl.exe -d <name>`).
 * A failed or empty session list reads as not WSL.
 */
export async function paneWslSession(
  ptyId: string,
  api: Pick<PaneForegroundApi, 'list'>,
): Promise<{ wsl: boolean; distro?: string }> {
  try {
    const session = (await api.list()).find((x) => x.id === ptyId);
    const target = session?.wslTarget;
    if (validWslTarget(target)) return { wsl: true, distro: target.distribution };
    if (isWslDistroSpawnArgs(session?.shell, session?.args)) return { wsl: true, distro: session.args[1] };
    return { wsl: isWslShellPath(session?.shell) };
  } catch {
    return { wsl: false };
  }
}
