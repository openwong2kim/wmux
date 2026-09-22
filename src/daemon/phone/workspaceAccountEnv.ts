import type { DesktopPhoneBridge } from './DesktopPhoneBridge';

/** Resolve the main-owned binding before spawning, never inherit another pane's account. */
export async function workspaceAccountEnv(
  env: Record<string, string>, workspaceId: string,
  desktop: Pick<DesktopPhoneBridge, 'available' | 'request'> | null,
): Promise<Record<string, string>> {
  if (!desktop?.available) throw new Error('Open the desktop app to resolve this workspace account before creating a pane.');
  const resolved = await desktop.request('accounts.env', { workspaceId });
  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) throw new Error('Workspace account resolution failed');
  const next = { ...env };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    delete next[key];
    const value = (resolved as Record<string, unknown>)[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Workspace account resolution failed');
      next[key] = value;
    }
  }
  return next;
}
