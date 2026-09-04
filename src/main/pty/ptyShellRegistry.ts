/**
 * ptyId → shell executable, for the two PTY modes at once.
 *
 * PTYManager already keeps this for local PTYs, but daemon-mode sessions live
 * on the other side of the socket and main holds no instance for them. The
 * clipboard handler needs the answer for BOTH (issue #1196: a WSL pane must get
 * a `/mnt/c/...` path, a PowerShell pane must not), so both creation paths
 * record here and it stays the single place to ask.
 *
 * An unknown ptyId answers undefined, and every caller must treat that as "no
 * rewrite" — guessing a shell is how a native Windows pane would end up with a
 * path it cannot open.
 */
const shells = new Map<string, string>();

export function recordPtyShell(ptyId: string, shell: string | undefined): void {
  if (!ptyId || typeof shell !== 'string' || !shell) return;
  shells.set(ptyId, shell);
}

export function getPtyShell(ptyId: string | undefined): string | undefined {
  return ptyId ? shells.get(ptyId) : undefined;
}

export function forgetPtyShell(ptyId: string): void {
  shells.delete(ptyId);
}

/** Test seam only. */
export function resetPtyShellRegistry(): void {
  shells.clear();
}
