# WSL folder browse and reveal — design

Status: approved 2026-11-15, implemented. Size: small-to-medium (~6–8 files).
No upstream issue exists (searched openwong2kim/wmux 2026-11-15).

## Intent

On Windows, a user who works in WSL cannot easily (a) start a workspace in a
WSL folder or (b) reveal a WSL pane's folder in Explorer.

- **Browse Folder:** the native dialog reaches WSL only via its "Linux" node and
  returns `\\wsl.localhost\<distro>\...`. Spawn then drops every `\\` cwd
  (`src/main/pty/resolvePtyCwd.ts:19`), so the workspace silently starts in the
  home directory. The user must already know the full path.
- **Reveal / Open in Explorer:** a WSL pane's cwd is a Linux path
  (`/home/me/repo`). On win32 it reads as `\home\me\repo` and `checkOpenTarget`
  returns NOT_FOUND (`WorkspaceItem.tsx:875`, `FileTreePanel.tsx:620`).

## Goals

1. Picking a folder under a WSL distro yields a **WSL shell workspace in that
   distro at the Linux path** (owner decision A).
2. A discoverable "Browse WSL folder…" `+` menu row: lists installed distros,
   then opens the native dialog at `\\wsl.localhost\<distro>\home`.
3. Reveal / Open-with works for WSL panes (sidebar row, Open-with submenu, file
   tree reveal).
4. Existing workspaces whose `startupCwd` is already a WSL share start working.

## Non-goals / anti-goals

- No `WorkspaceProfile` schema change, no migration.
- No custom in-app folder tree browser; the native dialog stays.
- Never silently fall back to the home directory for a WSL path we recognised.
- No version bump or `CHANGELOG.md` edit (fragment `changelog.d/<pr>.md` only).

## Approaches considered

1. **Derive from the path (chosen by owner).** `startupCwd` remains the share
   path; spawn detects a WSL share and converts it to distro + Linux cwd. No
   schema change; fixes existing workspaces; distro re-derived each time.
2. Store `wslDistro` + Linux `startupCwd` on `WorkspaceProfile`. Explicit, but
   needs schema/validation and leaves existing share-path workspaces broken.

## Design

- **Shared helper** `wslShareToLinux(path) -> {distro, linuxPath} | null` next
  to `src/shared/wslPaths.ts`. Extract from the existing logic in
  `externalSessionPlacement.ts:46-61` and the `WSL_SHARE` regex in
  `cwdShape.ts:51`; accept both `\\wsl$\` and `\\wsl.localhost\`
  (case-insensitive host, as `normalizeHostPath` does). Reuse by those callers.
- **Spawn:** lives in main's pty create handler, not the renderer. When the
  create's `cwd` is a WSL share, `withWslShareCwd` (`pty.handler.ts`, first
  step of both the daemon and local create paths) calls the pure
  `applyWslShareCwd` (`src/shared/wslShareSpawn.ts`), which rewrites the
  options to a WSL shell, the distro as `wslDistro`, and the Linux cwd so
  `validatePtyCwdForShell` accepts it. The installed-distro check uses the
  known-distro cache and enumerates `wsl.exe --list` only on a miss.
- **Unknown distro:** the pane opens in the default WSL shell at its home (never
  the Windows home), with one warning notification per workspace per session.
- **Split inherit:** a pane opened from a share stores the Linux cwd on its
  surface, so a split seeded from it would hand main a bare Linux path.
  `resolveStartupCwd` (`ptyCreateOptions.ts`) rebases a Linux split seed into
  the profile's WSL share (`\\wsl.localhost\<distro>` + seed) so main converts
  it the same way; any other seed/profile is unchanged.
- **Picker:** new `PresetPicker.tsx` row "Browse WSL folder…" (label +
  description, per DESIGN.md `+` menu rows; visible only on win32 with ≥1
  distro). Distros from `shell.wslDistros()` (`SHELL_WSL_DISTROS`). One distro
  → straight to dialog; several → small list first. Dialog `defaultPath`
  via `toolbar.handler.ts`: `\\wsl.localhost\<distro>\home`.
- **Reveal:** in `handleOpenExplorer`, `handleOpenWith`, and the file-tree
  reveal, translate with `paneWslSession` + `wslPathToHost`, mirroring
  `openTerminalFileLink`. A `{error}` result (bad chars, unknown distro) shows
  its text in the existing `notifyOpenFailed` toast.
- **Path spelling:** emit `\\wsl.localhost\` for the picker default (what
  Windows 11 Explorer shows); `wslPathToHost` keeps its current `\\wsl$\`
  output (both resolve). Accept both on input.
- **i18n:** `en.ts` (and `pl.ts`) `sidebar.*` strings.

## Constraints

- DESIGN.md governs the new menu row (no new colour, label + description).
- Windows-only behaviour is gated on win32; macOS/Linux unchanged.
- `checkOpenTarget` sensitive-path protections are not loosened.

## Left to the builder

- Confirm which form `metadata.cwd` holds for WSL panes (comments in
  `MetadataCollector.ts:32-38` conflict with `wslCallerCwd.ts`) before wiring
  reveal.
- File tree root/readDir for WSL panes probably has the same Linux-path issue;
  verify, and fix in this PR only if it is the same one-line translation,
  otherwise file a follow-up.

## Delivery order

1. Reveal fix (+ tests). 2. `wslShareToLinux` + spawn conversion (+ tests).
3. Picker row + i18n. Live check on Windows/WSL before marking the PR ready.
