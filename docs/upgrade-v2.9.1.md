# Upgrade Guide — v2.9.1 (Daemon Shutdown Reliability + .txt Active-Hazard Mitigation)

v2.9.1 ships the Phase A reliability bundle for the wmux daemon. The
focus is the scrollback persistence path under all real shutdown
triggers: tray Quit, Windows OS reboot / log-off, daemon kill, antivirus
interference, and the renderer-side `.txt` rotation chain that was
actively destroying its own backups in earlier versions.

This document is both a release note and a manual verification checklist
for the changes that the automated test suite cannot reach (WM_ENDSESSION
behavior, real ConPTY shutdown latency, antivirus interaction). Run
through the checklist if you maintain wmux on Windows or if you want to
confirm v2.9.1 fixed the "scrollback empty after reboot" symptom.

Target audience:

- v2.9.0 users upgrading to v2.9.1.
- Users who saw empty / chopped scrollback after Windows shutdown or restart.
- Maintainers running the v2.9.1 release verification.

---

## 1. What changed (release notes)

**Daemon shutdown is now actually awaitable.**
- `daemon.shutdown` RPC completes its full body (atomic RingBuffer dumps,
  session.json save, dispose) before returning. The handler then defers
  pipe stop + `process.exit(0)` to `setImmediate` so the ack flushes
  back to the caller.
- `DaemonClient.rpc` gained a per-call `{ timeoutMs }` override so the
  caller can wait beyond the default 10 s.

**Tray Quit + Windows session-end now race the daemon.**
- Tray Quit (main `before-quit`) awaits `daemon.shutdown` against a 4 s
  budget, then falls back to `daemonClient.disconnect()`.
- Windows `session-end` (WM_ENDSESSION) does the same race so OS reboot
  / log-off triggers the same flush path. Detach-only is the final
  fallback exactly as in v2.9.0.

**Atomic RingBuffer dump (tmp + rename).**
- `RingBuffer.dumpToFile` writes to a same-directory `.tmp.<hex>` file
  and renames into place. Readers can never observe a half-written
  `.buf`.
- New `RingBuffer.dumpToFileSyncAtomic` used by the Windows
  `process.on('exit')` last-resort handler.
- Stale `.tmp.*` files swept on daemon startup.

**New session entries persist within 30 s of spawn.**
- `daemon.createSession` and `daemon.attachSession` invoke a snapshot
  runner immediately so the new session's `.buf` is on disk before the
  next 30 s tick. Locked by source-level invariant test against future
  refactors.

**Renderer `.txt` scrollback is gated off in daemon mode.**
- Autosave timer + beforeunload save + scrollback:dump IPC +
  scrollback:load IPC + xterm async restore all short-circuit when the
  renderer's daemon flag is true.
- The flag flips on `daemon:connected` / `daemon:disconnected` events
  emitted by main. Local-mode users (daemon spawn failed or runtime
  disconnect) keep the `.txt` fallback verbatim.

**One-time legacy scrollback migration on first daemon connect.**
- `%APPDATA%/wmux/scrollback/` moves to
  `%APPDATA%/wmux/scrollback-legacy-<unix-ts>/` so daemon-mode users
  get a clean directory. Migration is idempotent (flag file at
  `%APPDATA%/wmux/scrollback-migration.json`) and retries on EBUSY /
  EPERM / ENOTEMPTY.

**Bundled M6 in-orbit fixes.**
- bf67a79: Pane split max-depth/count guard (TODOS #2).
- Daemon reconnection retry on tray restore (TODOS #1).
- destroyCompanyWithCleanup race resolution (TODOS #4).
- Member workspace PTY leak on company destroy (TODOS #5).

---

## 2. What you may notice

- The `%APPDATA%/wmux/scrollback/` directory will be absent after first
  launch on v2.9.1. Its prior contents are at `scrollback-legacy-<ts>/`
  in the same parent directory. wmux does not delete this — you can
  hand-delete it if storage matters, or copy specific files out for
  manual recovery.
- If you have not been running with a daemon (you would know — typically
  Windows-only deploys with daemon binaries missing), v2.9.1 changes
  nothing for your scrollback path. The `.txt` directory is still your
  source of truth.
- Tray Quit may take up to ~5 s longer than v2.9.0 if you have many
  panes open and antivirus is scanning during shutdown. This is the
  expected race timeout; it caps the daemon's flush window so atomic
  dumps complete before Windows pulls the plug.

---

## 3. Manual verification checklist (Windows)

The automated test suite covers everything except the OS-level shutdown
signals. Run through this list to confirm v2.9.1 lands cleanly on your
machine. **Before starting**: close all running wmux instances. Open
Task Manager so you can watch the `node.exe` daemon process.

### 3.1 Tray Quit cleanly flushes scrollback

1. Launch wmux. Open at least 5 terminal panes across 2 workspaces.
2. Run a varied command in each pane (e.g., `dir`, `tree`, `ipconfig`)
   for at least 2 minutes so each RingBuffer has real content.
3. Right-click the tray icon → **Quit**.
4. Inspect `%APPDATA%/wmux/buffers/`. Each pane's `.buf` file should
   match the output volume you generated (not 0 bytes, not 159 bytes).
5. Relaunch wmux. Each pane should restore scrollback identical to
   pre-quit (within ±30 s).

### 3.2 Windows reboot test (P0 critical gap)

This is the path that was broken in v2.9.0 and earlier. The automated
test suite cannot reproduce WM_ENDSESSION; this step is the only
end-to-end coverage.

1. With wmux open + multiple active panes + running commands, click
   Start → Power → **Restart**.
2. Let Windows fully restart and log back in.
3. Open wmux. Each pane should show its pre-restart scrollback. No
   panes should show "empty" content.

If this step fails, please file an issue with the daemon log
(`%APPDATA%/wmux/logs/` if logging is enabled) and a description of how
many panes / what kind of workloads were active.

### 3.3 Log-off + log-on

1. Open wmux + at least 1 pane with content.
2. Start → user icon → **Sign out**.
3. Log back in. Open wmux. Scrollback should be intact.

### 3.4 Forced daemon kill (Task Manager)

1. Open wmux. Confirm `node.exe` is running in Task Manager (the
   daemon).
2. End that `node.exe` process via Task Manager.
3. wmux should automatically fall back to local PTY mode for new
   panes. Existing panes will show "Daemon disconnected" log entries
   and continue running in local mode.
4. Close wmux normally. Relaunch. Daemon should respawn; previous
   panes should restore from the last `.buf` snapshot.

### 3.5 Antivirus block

1. Add `%APPDATA%/wmux/buffers/` as a scan target in your antivirus.
2. Reboot Windows.
3. Reopen wmux. If the daemon could not write its `.buf` files cleanly
   under antivirus interference, you should still see the previous
   snapshot's content (EBUSY paths log a warning but do not corrupt the
   prior good file thanks to the atomic tmp + rename pattern).

### 3.6 Local mode test (no daemon)

This confirms the v2.9.1 gates do not regress users whose daemon binary
fails to spawn (Issue #1A).

1. Rename `daemon-pipe` file (or block the daemon binary via antivirus).
2. Launch wmux. The log should show "Daemon auto-start failed, using
   local PTY".
3. Open a pane, generate output for ~2 minutes, close wmux.
4. Reopen wmux. The pane should restore from the `.txt` rotation chain
   in `%APPDATA%/wmux/scrollback/` (the gates we added skip in local
   mode).

### 3.7 Legacy migration sanity

1. Confirm `%APPDATA%/wmux/scrollback-legacy-<ts>/` exists if you had
   pre-v2.9.1 scrollback data.
2. Confirm `%APPDATA%/wmux/scrollback-migration.json` exists and
   contains `{ schema: 1, migratedAt: ..., fromVersion: 2.9.1 }`.
3. Confirm `%APPDATA%/wmux/scrollback/` is absent (daemon mode) OR
   newly-created and empty (you ran 3.6 first).

---

## 4. T5 latency calibration (optional, advanced)

The before-quit + session-end races use a 4 s timeout placeholder. If
you have many panes (50+) or slow storage and want to dial this in,
rerun the T5 measurement on the target hardware:

```bash
npm run build:daemon
node scripts/daemon-shutdown-dynamic.mjs
```

The harness prints per-N latency and a recommended timeout. If T5 p99
exceeds 3 s, raise `BEFORE_QUIT_TIMEOUT_MS` in
`src/main/index.ts` (currently 4_000) and `A5_TIMEOUT_MS` in the
`session-end` handler. Cap at 4 s — anything higher risks Windows
SIGKILL inside the 5 s OS budget.

The current harness has a known ConPTY rapid-spawn race that throws
`ERROR_INVALID_PARAMETER (87)` from inside a `Socket.on('data')`
handler in a way that bypasses the harness's try/catch chain. If you
hit this and want a measurement, add a sleep between createSession
calls or reduce the N values to {1, 5, 10}.

---

## 5. Known trade-offs

- **Post-migration local-mode fresh scrollback.** If your daemon
  connects successfully, A7 moves your legacy `.txt` directory aside.
  If the daemon later dies mid-session and you fall back to local mode,
  scrollback starts fresh from that session forward. The legacy data
  remains at `scrollback-legacy-<ts>/` for manual recovery.
- **WM_ENDSESSION 4 s budget.** Windows gives ~5 s before SIGKILL.
  v2.9.1 uses 4 s for the daemon race, leaving 1 s for disconnect +
  Electron teardown. Heavy workloads (50 × 8 MB sessions on HDD with
  antivirus) may exceed 4 s and trigger the detach fallback. The
  fallback is the v2.9.0 behavior, so nothing regresses, but the
  daemon's atomic exit handler still kicks in to dump as much as
  possible before the process dies.
- **`.txt` rotation chain still hazardous in local mode.** A6 + A7
  only affect daemon-mode users. The fundamental `.txt` rotation
  bug (size-unaware backups overwriting good data with 64-byte stubs)
  remains for users who run without a daemon. Phase B-E will address
  the local-mode side via either fixing the rotation logic or
  retiring the `.txt` system entirely.

---

## 6. Rollback

If v2.9.1 regresses your scrollback in an unexpected way, downgrade
to v2.9.0 via your installer. The on-disk format is fully
compatible — daemon-mode users will see `scrollback-legacy-<ts>/` left
intact in `%APPDATA%/wmux/`. v2.9.0 reads from `%APPDATA%/wmux/scrollback/`,
so create or restore that directory before the downgrade. Move the
legacy data back:

```powershell
Rename-Item "$env:APPDATA\wmux\scrollback-legacy-<ts>" "$env:APPDATA\wmux\scrollback"
Remove-Item "$env:APPDATA\wmux\scrollback-migration.json"
```

Then file an issue with the symptom + the daemon log so we can fix
forward in v2.9.2.
