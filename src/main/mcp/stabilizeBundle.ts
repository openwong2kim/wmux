import * as fs from 'fs';
import * as path from 'path';

/**
 * Relocate the packaged MCP bundle to a STABLE, version-free location so the
 * path wmux registers in each agent's config (`~/.claude.json` etc.) never
 * dangles.
 *
 * THE BUG this fixes (RCA 2026-07-24): `McpRegistrar` registered the MCP server
 * command as `process.resourcesPath/mcp-bundle/index.js`. On Windows that lives
 * inside Squirrel's versioned `%LocalAppData%\wmux\app-{version}\resources\…`
 * (and, when dogfooding, inside a throwaway `…\out\…` or a git worktree). The
 * moment that build directory is removed — an app upgrade cleaning the old
 * `app-*`, a worktree being pruned, an `out/` wipe — the registered path points
 * at a file that no longer exists, and every agent that reads the config can no
 * longer launch the wmux MCP server. (Observed live: a registered args path of
 * `D:\wmux-worktrees\…\out\…\mcp-bundle\index.js` with the file already gone.)
 *
 * The fix mirrors what the app already does for the Codex `notify` bridge
 * (`McpRegistrar.installAndRegisterCodexNotify`) and the Claude hook/statusline
 * scripts (`setupHooks.refreshHookBridge`): copy the bundle to `~/.wmux/mcp/`
 * and register THAT path, which survives every `app-*` swap, and refresh the
 * copy on boot so it stays in lock-step with the installed app.
 *
 * Unlike the single-file bridge, the MCP bundle is a DIRECTORY: `index.js`
 * (~1.7MB) pulls in siblings at runtime via `path.join(__dirname, …)`
 * (`playwright-chunk.js` ~4.7MB, `playwright-core-package.json`). So the whole
 * directory must travel together, and — because that is ~6MB — the copy is
 * gated on a version marker so a warm boot pays nothing.
 *
 * Pure (fs + path only) so the security-relevant copy/gate logic has direct
 * unit coverage without an Electron/`process.resourcesPath` harness; the tiny
 * amount of Electron-specific wiring (which source path, `app.getVersion()`,
 * `~/.wmux/mcp`) stays in `McpRegistrar`.
 */

/** Marker file that records which app version last synced the stable bundle. */
export const MCP_VERSION_MARKER = '.wmux-mcp-version';

export interface StabilizeResult {
  /** Absolute path to register: the stable copy on success, the original
   *  `sourceScript` when we fell back (so MCP still works this session). */
  scriptPath: string;
  /** True when `scriptPath` is the stable, version-free copy. */
  stabilized: boolean;
  /** True when a copy actually ran this call (a cold/stale/ repair boot). */
  synced: boolean;
  /** Set when we did NOT stabilize — why we fell back to the source path. */
  reason?: string;
}

/**
 * Ensure `sourceScript`'s bundle directory is mirrored into `stableDir` and
 * return the path to register.
 *
 * @param sourceScript absolute path to the bundle entry inside the versioned
 *   install (e.g. `…/resources/mcp-bundle/index.js` or `…/shim.js`)
 * @param stableDir    version-free destination (e.g. `~/.wmux/mcp`)
 * @param version      current app version — the sync gate. A mismatch (or a
 *   missing target) forces a re-copy; a match with the target present is a no-op.
 *
 * Never throws: any failure (locked file mid-upgrade, ENOSPC, odd layout) is
 * reported as a fall-back to the versioned `sourceScript`, which is still valid
 * for the current session — the same behavior as before this fix, just without
 * the cross-update durability.
 */
export function stabilizeMcpBundle(
  sourceScript: string,
  stableDir: string,
  version: string,
): StabilizeResult {
  try {
    if (!fs.existsSync(sourceScript)) {
      return { scriptPath: sourceScript, stabilized: false, synced: false, reason: 'source-missing' };
    }

    const sourceDir = path.dirname(sourceScript);
    const basename = path.basename(sourceScript);
    const stableScript = path.join(stableDir, basename);
    const markerPath = path.join(stableDir, MCP_VERSION_MARKER);

    // Version-marker gate + repair-on-missing: skip the ~6MB directory copy
    // when the stable dir already carries THIS app version AND the entry we're
    // about to register is present. A missing entry (partial prior copy, manual
    // deletion) forces a re-sync even when the marker matches.
    let marker: string | null = null;
    try {
      marker = fs.readFileSync(markerPath, 'utf8').trim();
    } catch {
      marker = null;
    }
    if (marker === version && fs.existsSync(stableScript)) {
      return { scriptPath: stableScript, stabilized: true, synced: false };
    }

    // Copy EVERY file in the bundle dir — index.js resolves its siblings via
    // path.join(__dirname, …), so they must land next to it. tmp+rename per
    // file so an agent that spawns the MCP mid-copy never reads a half-written
    // script; the tmp name carries the pid so two boots racing can't interleave.
    fs.mkdirSync(stableDir, { recursive: true });
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === MCP_VERSION_MARKER) continue;
      const src = path.join(sourceDir, entry.name);
      const dest = path.join(stableDir, entry.name);
      const tmp = `${dest}.${process.pid}.tmp`;
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dest);
    }

    // Marker written LAST: a crash mid-copy leaves marker !== version, so the
    // next boot re-syncs rather than trusting an incomplete directory.
    fs.writeFileSync(markerPath, version, 'utf8');

    if (!fs.existsSync(stableScript)) {
      // The source dir existed but didn't actually contain the entry we were
      // asked to register (odd layout) — fall back rather than register a path
      // we can't confirm.
      return {
        scriptPath: sourceScript,
        stabilized: false,
        synced: true,
        reason: 'entry-absent-after-copy',
      };
    }
    return { scriptPath: stableScript, stabilized: true, synced: true };
  } catch (err) {
    // Fail-open: register the versioned source path (pre-fix behavior) so MCP
    // still works this session even when the stable copy can't be written
    // (locked file mid-upgrade, disk full, permission denied).
    return {
      scriptPath: sourceScript,
      stabilized: false,
      synced: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
