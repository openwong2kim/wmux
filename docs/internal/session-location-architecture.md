# Session location architecture

`SessionLocation` describes where a pane's files and commands live. A cwd alone
is insufficient on Windows: `/home/me/repo` may belong to WSL, `/c/repo` may
belong to Git Bash, and the same WSL path may name different files in different
distributions.

The shared model is defined in `src/shared/sessionLocation.ts`:

```ts
type SessionLocation =
  | { domain: 'host'; cwd: string; shell: string }
  | { domain: 'msys'; cwd: string; shell: string }
  | { domain: 'wsl'; cwd: string; shell: string; distro?: string };
```

## Responsibilities

The shared module provides the canonical operations on this model:

- `parseSessionLocation` validates process-boundary input. It accepts legacy
  bare cwd strings as host locations; this preserves compatibility but does not
  prove that the path is host-accessible.
- `resolveSessionLocation` prefers a stored structured location and classifies
  legacy `{ cmd, cwd }` records only when no valid location is present.
- `classifySessionLocation` derives a domain from the shell and cwd. It cannot
  infer a WSL distribution from a Linux path such as `/home/me/repo`.
- `locationIdentity` and `locationsEqual` normalize locations for cache keys and
  equality without collapsing domains or WSL distributions.
- `preparePtyLocation` computes PTY spawn cwd/arguments. An unconvertible MSYS
  cwd degrades to the supplied safe host home and marks the result
  `degraded: true`.
- `toHostAccessiblePath` and `prepareLocationCommand` are filesystem and
  command conversion boundaries. They return explicit `LocationError` values
  when a conversion would require guessing.

`src/main/git/paneCommand.ts` adds the live-pane command boundary. A WSL command
requires an active context for the same pane and a known distribution; passive
metadata work must never start a distribution merely to answer a poll.

## Live pane state

Main-process metadata deliberately splits a live pane's state in
`src/main/ipc/handlers/metadata.handler.ts`:

- `paneIdentities` holds the cwd-independent shell and optional WSL
  distribution.
- `cwdMap` holds the current cwd reported by the live shell.
- `getPaneCommandTarget` combines them when a consumer needs to run a command.

Create and reconnect paths must call `updatePaneLocation` before `updateCwd`.
`updateCwd` synchronously notifies listeners, so reversing this order exposes a
cwd without its domain identity. The daemon reconnect path also prefers the
daemon's stored `location`; `resolveSessionLocation` supplies the legacy
`{ cmd, cwd }` fallback.

The renderer follows the same preference in
`src/renderer/utils/focusedSurface.ts`: a surface's stored location is
authoritative, while old surfaces without one are classified from `shell` and
`cwd`. Workspace metadata is only a final fallback when the active pane has no
usable surface.

Renderer equality calls must pass `window.electronAPI.platform`. The shared
module is also loaded in a context-isolated renderer where Node's `process` may
not exist, so its defensive default uses case-sensitive POSIX behavior.

## WSL distribution discovery

`src/main/pty/wslDistro.ts` resolves a pane's distribution in this order:

1. an explicit `-d` or `--distribution` spawn argument;
2. the pane's `WSL_DISTRO_NAME`;
3. enumeration with `wsl.exe -l` variants;
4. a single registered or single running distribution when that is
   unambiguous.

Enumeration never executes a command inside a distribution.
`createWslRunner` owns the bytes-to-text and process policy; `defaultRunner` is
only its production binding. The runner is Windows-only, reads raw buffers,
decodes either UTF-16LE or UTF-8, sets `WSL_UTF8=1`, hides the window, and
bounds the process with a three-second timeout and a 256 KiB output cap.

Enumeration results have a 60-second TTL, and concurrent callers share the same
in-flight promise. Results with no registered names, and rejected enumerations,
are removed immediately so the next call retries. A partial result is cached
when the quiet registered-name listing succeeds but another listing fails.
There is currently no production hook that invalidates the cache when a
distribution is installed or removed; `resetWslDistroCache` exists for test
isolation. Therefore an install/remove can remain invisible until the TTL
expires.

## Fail-closed boundaries

The architecture preserves compatibility without treating incomplete context as
authority:

- A legacy bare cwd is parsed as host, but Windows filesystem conversion rejects
  unresolved guest-shaped paths with `UNRESOLVED_GUEST_PATH`.
- A WSL Linux path without a distribution fails with
  `WSL_DISTRO_REQUIRED`.
- A WSL command without matching live-pane context fails with
  `ACTIVE_CONTEXT_REQUIRED` or `WSL_DISTRO_MISMATCH`.
- An unsupported MSYS or WSL path is rejected instead of being passed to a
  Windows API unchanged.

Tests should exercise the boundary that owns each behavior. Parser and
conversion cases belong in `src/shared/__tests__/sessionLocation.test.ts`;
WSL byte decoding and process policy belong below the runner seam in
`src/main/pty/__tests__/wslDistro.test.ts`; live identity/cwd ordering belongs
at the registered PTY handler boundary.
