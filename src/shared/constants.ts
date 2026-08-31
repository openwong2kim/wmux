// IPC Channel names
export const IPC = {
  PTY_CREATE: 'pty:create',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  // #766 visibility-based size ownership. Renderer → main fire-and-forget:
  // reports whether a pane is actually on screen (workspace + tab active AND
  // the window itself visible). Forwarded to the daemon so the phone resize
  // route can tell "attached and watched" from "attached but nobody looking".
  PTY_SET_VIEWER_VISIBILITY: 'pty:setViewerVisibility',
  PTY_DISPOSE: 'pty:dispose',
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
  PTY_LIST: 'pty:list',
  PTY_PROMOTE: 'pty:promote',
  // TASK-6 — per-pane agent resource attribution for the Fleet View cockpit.
  // Renderer → main invoke: takes a list of ptyIds, resolves each to its shell
  // PID (via daemon.listSessions), takes ONE Win32_Process CIM snapshot, walks
  // each pane's descendant tree, and returns summed RAM + dominant image name.
  // Polled ONLY while Fleet View is visible (renderer-gated) — zero cost idle.
  PANE_RESOURCES: 'pane:resources',
  PTY_RECONNECT: 'pty:reconnect',
  // Renderer-only CRUD for prompts scheduled against one concrete agent PTY.
  // The main-process runner re-verifies the agent family before bracket-paste
  // delivery, waits while a turn/approval is active, and persists across app
  // restarts. Separate from DECK_SCHEDULES_* (workspace orchestrator turns).
  SESSION_PROMPT_SCHEDULES_LIST: 'sessionPromptSchedules:list',
  SESSION_PROMPT_SCHEDULES_CREATE: 'sessionPromptSchedules:create',
  SESSION_PROMPT_SCHEDULES_UPDATE: 'sessionPromptSchedules:update',
  SESSION_PROMPT_SCHEDULES_DELETE: 'sessionPromptSchedules:delete',
  // Phase 3 PR-B — live-pipe re-flush. Re-runs the daemon SessionPipe flush on
  // the EXISTING connected socket (no teardown / re-auth), so a hidden pane can
  // be rehydrated from a headless snapshot without an input dead-zone. Distinct
  // from PTY_RECONNECT, which opens a fresh socket. Renderer degrades to
  // reconnect against legacy daemons (code:'legacy-daemon').
  PTY_RESYNC: 'pty:resync',
  // TASK-9 cold-park — read-only PLAIN-TEXT snapshot of a session's grid from
  // the daemon ring (ANSI stripped, rows + wrap flags). Used by the cross-pane
  // search / readScreen fallback when a workspace is cold-parked and has no
  // renderer xterm buffer, so parked panes are searched, never silently skipped.
  PTY_READ_TEXT: 'pty:readText',
  // X8 pane supervision. PTY_RESTARTED fires when the daemon's PaneSupervisor
  // re-created a session under the SAME id with a fresh PTY (a supervised
  // restart). Distinct from PTY_EXIT — the renderer must re-attach the
  // existing reconnect machinery, NOT run the died-path cleanup. Payload:
  // { ptyId, restartCount, exitCode }.
  PTY_RESTARTED: 'pty:restarted',
  // X8 — sticky supervision status flip (runaway-guard trip → 'stopped',
  // manual rearm/stop). Always forwarded for badge sync; main also raises an
  // OS toast on guard trips only. Payload: { ptyId, status, reason, restartCount }.
  SUPERVISION_CHANGED: 'supervision:changed',
  // X8 — renderer → main invoke channels for the supervision control surface
  // (pane context menu rearm / stop). Renderer-only by design: only the user
  // re-arms a tripped guard, never an external MCP/CLI client. Forwarded to
  // the daemon's renderer-only daemon.superviseRearm / daemon.superviseStop.
  SUPERVISE_REARM: 'supervise:rearm',
  SUPERVISE_STOP: 'supervise:stop',
  // Fires once per attach, after the daemon SessionPipe's ring-buffer
  // flush completes. Payload: (sessionId, recoveredBytes). The renderer
  // uses recoveredBytes>0 as the signal to wipe its .txt-cache replay
  // before letting the live PTY output compose on a clean buffer.
  PTY_FLUSH_COMPLETE: 'pty:flush-complete',
  SHELL_LIST: 'shell:list',
  FONTS_LIST: 'fonts:list',
  SESSION_SAVE: 'session:save',
  // A4 — non-blocking periodic autosave. Same payload/atomicity as SESSION_SAVE
  // (tmp+rename+.bak) but the main-side write is async so the 5s crash-safety
  // tick never blocks the main event loop. Event-driven ptyId-change saves and
  // all exit paths keep using the synchronous SESSION_SAVE / flushSync, so
  // reboot survival is unchanged.
  SESSION_SAVE_ASYNC: 'session:saveAsync',
  SESSION_LOAD: 'session:load',
  NOTIFICATION: 'notification:new',
  // E5 — dock/tray badge unread count. Renderer sends a count update whenever
  // the total unread changes; main applies it to the platform badge surface
  // (macOS dock, Windows tray tooltip).
  NOTIFICATION_BADGE_COUNT: 'notification:badge-count',
  // X2 — OS toast click → jump to the originating pane. Main sends the
  // toast's {ptyId, workspaceId} context; renderer resolves and activates
  // the workspace/pane/surface (see useNotificationListener).
  NOTIFICATION_FOCUS: 'notification:focus',
  // Renderer-decided OS toast. The notification policy (single decision
  // point for every surface) emits an `osToast` action when the window is
  // unfocused; the listener relays it here and main shows it WITHOUT the
  // legacy any-window-focused suppression (ToastManager.showDirect).
  // Payload: { title, body, ptyId?, workspaceId? } — the toast click context.
  NOTIFICATION_OS_TOAST: 'notification:os-toast',
  // Renderer confirms its notification IPC listener is attached (fired once
  // per mount, from useNotificationListener's effect). dispatchNotification
  // consults main's mirror of this to decide whether webContents.send would
  // actually be received, or whether to fall back to a direct OS toast —
  // a live BrowserWindow does not imply a live listener (deferred initial
  // load, mid-reload crash recovery, or a renderer that hasn't mounted yet
  // all leave the window alive with nothing on the other end of send()).
  NOTIFICATION_LISTENER_READY: 'notification:listener-ready',
  CWD_CHANGED: 'notification:cwd-changed',
  /** J3 §3: initialCommand 재시도 소진(프롬프트 미발사) — payload: sessionId. */
  PTY_INITIAL_CMD_EXHAUSTED: 'notification:initial-cmd-exhausted',
  GIT_BRANCH_CHANGED: 'notification:git-branch-changed',
  TERMINAL_TITLE_CHANGED: 'terminal:title-changed',
  METADATA_UPDATE: 'metadata:update',
  METADATA_REQUEST: 'metadata:request',
  // P2 — one-shot renderer→main pull of all current pane labels (paneId → label)
  // to seed the volatile paneLabel mirror on mount (hydrate emits no events).
  METADATA_SNAPSHOT: 'metadata:snapshot',
  // P2 — renderer GUI pane rename → MetadataStore.set (the only non-MCP writer).
  METADATA_SET: 'metadata:set',
  // Renderer Fleet dropdown → set a pane's operator-assigned orchestrator role
  // (custom['orchestrator.role']) via MetadataStore.set (custom deep-merge).
  METADATA_SET_ROLE: 'metadata:set-role',
  // Phase 3: RPC bridge (Main ↔ Renderer)
  RPC_COMMAND: 'rpc:command',
  RPC_RESPONSE: 'rpc:response',
  // Renderer → main: invoke the pipe RpcRouter from a renderer-side caller
  // (used by the in-renderer `__wmuxEventsPoll` and `__wmuxChannelsRpc`
  // bridges installed in `useRpcBridge.ts`). The renderer is a trusted
  // first-party surface — no separate capability check happens here; the
  // router's own PermissionEnforcer applies per-method. Mirrors the
  // shape of the external pipe-client envelope: `{ method, params }`
  // in, the dispatch response out.
  RPC_INVOKE: 'rpc:invoke',
  // Renderer → main: mutate a channel (create/post/join/leave/archive) from the
  // first-party in-app channels UI (D5). Unlike RPC_INVOKE, this is a dedicated
  // renderer-only ipcMain.handle surface — NOT exposed on the pipe RpcRouter —
  // so a same-user pipe/MCP client cannot reach it (the same boundary
  // project-config relies on). The in-app composer/create UI has no senderPtyId,
  // so the pipe-facing a2a.channel.* handler would fail it closed; here the main
  // process trusts the renderer-supplied verifiedWorkspaceId (the human/CEO
  // workspace, sound by the Electron process boundary) and forwards to the
  // daemon, whose authz gates run against it. See channelLocal.handler.ts.
  CHANNEL_MUTATE_LOCAL: 'channels:mutate-local',
  // J1 fan-out — renderer(다이얼로그) → main: 프롬프트 1개 → N 격리 태스크 스폰.
  // main의 FanOutService가 데몬 RPC(mission.start/update/invite)와 렌더러 spawn을
  // 조립한다. 렌더러 신뢰 신원(verifiedWorkspaceId)은 channelLocal과 동일 trust
  // basis(Electron 프로세스 경계). 파이프 미노출 — 같은 사용자 MCP 클라가 못 닿는다.
  FANOUT_START: 'fanout:start',
  // J3 태스크 수명주기 — renderer → main(파이프 미노출, channelLocal과 동일 trust).
  //  TASK_CLOSE: remove 성공→close 커밋 순서 오케스트레이션(TaskCloseService).
  //  TASK_CREATE_PR: gh 4중 게이트 1클릭 PR(TaskPrService).
  //  WORKTASK_SCAN: 전용 루트 디스크 정본 정리 스캔(WorktaskScanService).
  //  WORKTASK_REFIRE: 미발사 재발사 — prompt.md 실존 검사 후 원래 initialCommand
  //    (에이전트 기동+프롬프트 주입)를 정상 경로와 동일 sanitize로 재전송(§3·F2).
  TASK_CLOSE: 'task:close',
  TASK_CREATE_PR: 'task:create-pr',
  WORKTASK_SCAN: 'worktask:scan',
  WORKTASK_REFIRE: 'worktask:refire',
  // Command Deck Phase 2 — the Commander brain (an Agent-SDK orchestrator that
  // runs in MAIN and drives the fleet via wmux MCP). Renderer-only surface, same
  // trust basis as channelLocal/fanout (Electron process boundary, pipe-
  // unreachable):
  //   DECK_SEND       (invoke) renderer → main: run one brain turn. Payload
  //                   { text, fleetContext?, model?, fullPower? }. Resolves
  //                   with the accept/reject result ({ ok, code? }); the
  //                   turn's content streams over DECK_STREAM, it is not the
  //                   invoke's return value.
  //   DECK_STREAM     (push)   main → renderer: one normalized BrainEvent per
  //                   send (text-delta | tool-start | tool-end | turn-end |
  //                   error). Dedicated channel — a brain stream is NOT channel
  //                   semantics, so it never rides the channels plumbing.
  //   DECK_INTERRUPT  (invoke) renderer → main: abort the in-flight turn.
  //   DECK_STATUS     (invoke) renderer → main: { status, sessionId } snapshot.
  //   DECK_FULLPOWER_SET (invoke) renderer → main: sync the full-power toggle
  //                   (BYOB approach A). Main is the authority consulted by
  //                   EVERY turn path (send / scheduled / event-woken), so a
  //                   toggle change applies to autonomous turns immediately —
  //                   not only after the next typed command. The renderer
  //                   pushes on change and once after session hydration
  //                   (restart restore).
  DECK_SEND: 'deck:send',
  DECK_STREAM: 'deck:stream',
  DECK_INTERRUPT: 'deck:interrupt',
  //   DECK_WAKE       (invoke) renderer → main: the dock's Wake button. The
  //                   pty layout has no composer, so this is the human's way to
  //                   ask for one ambient turn NOW. Rides the same ambient turn
  //                   path as the heartbeat/scheduler (busy precheck, fleet
  //                   slot, turn-start announce); resolves { ok, code? }.
  DECK_WAKE: 'deck:wake',
  DECK_STATUS: 'deck:status',
  DECK_FULLPOWER_SET: 'deck:fullpower:set',
  //   DECK_BRAIN_VENDOR_SET (invoke) renderer → main: sync the orchestrator
  //                   brain vendor (BYOB M0 — 'claude' | 'hermes'). Same
  //                   main-authority contract as DECK_FULLPOWER_SET: every
  //                   turn path consults it, idle stale-vendor brains retire
  //                   on change, renderer pushes on change + after hydration.
  DECK_BRAIN_VENDOR_SET: 'deck:brainvendor:set',
  //   DECK_MODEL_SET  (invoke) renderer → main: sync the orchestrator model
  //                   picker. Same main-authority contract as
  //                   DECK_FULLPOWER_SET / DECK_BRAIN_VENDOR_SET, and it
  //                   exists for the same reason those do: the model used to
  //                   ride ONLY on the DECK_SEND payload, so it reached main
  //                   just when a human typed into the deck composer. The
  //                   terminal brain has no composer (its TUI is the input
  //                   path), which left the picker inert for that vendor, and
  //                   automation-driven turns spawned brains on whatever model
  //                   the last typed turn happened to leave behind.
  DECK_MODEL_SET: 'deck:model:set',
  //   DECK_BRAIN_PTY  (send) main → renderer: the `claude-pty` brain just
  //                   spawned its interactive TUI in daemon session <ptyId>.
  //                   One-way and additive to DECK_STREAM (which carries only
  //                   normalized BrainEvents) — the deck embeds that terminal
  //                   in place of the bubble list. `ptyId: null` retires it.
  DECK_BRAIN_PTY: 'deck:brainpty',
  //   DECK_BRAIN_PTY_LIST (invoke) renderer → main: the CURRENT brain pty of
  //                   every workspace. DECK_BRAIN_PTY is a one-way push, so a
  //                   renderer reload (or a late-mounting subscriber) would
  //                   otherwise never learn about a terminal that spawned
  //                   before it was listening. Called once when useDeckStream
  //                   mounts — the same hydrate-then-subscribe shape the other
  //                   main-authoritative deck state uses.
  DECK_BRAIN_PTY_LIST: 'deck:brainpty:list',
  //   DECK_SCHEDULES_* (invoke) renderer → main: CRUD over the persisted
  //                    orchestrator schedules (P3d). Same renderer-only trust
  //                    boundary as DECK_SEND.
  DECK_SCHEDULES_LIST: 'deck:schedules:list',
  DECK_SCHEDULES_CREATE: 'deck:schedules:create',
  DECK_SCHEDULES_UPDATE: 'deck:schedules:update',
  DECK_SCHEDULES_DELETE: 'deck:schedules:delete',
  //   DECK_LOOP_*      (invoke) renderer → main: the one-click loop (loop
  //                    engineering v1). START writes loop-state + autonomy caps
  //                    + optional cadence schedule in ONE action; STOP/PAUSE are
  //                    the fail-closed OFF contract (caps → DEFAULT, cadence
  //                    schedule deleted/disabled). Same renderer-only trust
  //                    boundary as DECK_SEND.
  DECK_LOOP_GET: 'deck:loop:get',
  DECK_LOOP_START: 'deck:loop:start',
  DECK_LOOP_STOP: 'deck:loop:stop',
  DECK_LOOP_PAUSE: 'deck:loop:pause',
  DECK_LOOP_RESUME: 'deck:loop:resume',
  //   DECK_LOOP_TASK — the HUMAN ticks a done-when checklist item. The brain
  //   never writes `passes` (v1 posture: no self-scored done); this is the
  //   human's pen.
  DECK_LOOP_TASK: 'deck:loop:task',
  //   DECK_LOOP_SKILLS — 루프 설정 모달의 스킬 픽커 재료: pane 에이전트가 쓸
  //   수 있는 스킬/커맨드 카탈로그를 디스크(.claude/skills|commands)에서 스캔.
  //   읽기 전용, 렌더러 전용.
  DECK_LOOP_SKILLS: 'deck:loop:skills',
  //   DECK_AUTOWAKE_* — the global event-push kill switch (Settings toggle).
  //   OFF suppresses ambient wake-turns (the unrequested summaries); a
  //   running loop still wakes. Same renderer-only trust boundary.
  DECK_AUTOWAKE_GET: 'deck:autowake:get',
  DECK_AUTOWAKE_SET: 'deck:autowake:set',
  //   DECK_MODE_* — the per-workspace agent mode (off/assist/auto).
  //   Mode is the single user-facing autonomy knob; the raw caps
  //   are derived from it. `set` with mode='off' also tears down running loops
  //   + schedules. Same renderer-only trust boundary.
  DECK_MODE_GET: 'deck:mode:get',
  DECK_MODE_SET: 'deck:mode:set',
  //   HOOKS_BRIDGE_* — the Claude Code hook bridge (wmux setup-hooks, in-app).
  //   STATUS reports whether the wmux hook entries are installed in
  //   ~/.claude/settings.json; INSTALL performs the same idempotent install as
  //   the CLI. Explicitly user-triggered from the install prompt — wmux never
  //   edits Claude settings behind the operator's back (owner decision
  //   2026-07-17). Renderer-only trust boundary.
  HOOKS_BRIDGE_STATUS: 'hooks:bridge:status',
  HOOKS_BRIDGE_INSTALL: 'hooks:bridge:install',
  //   PROMPT_PREF_* — the durable "Don't ask again" for the install prompt.
  //   GET is read by the prompt before it decides to show; SET is written only
  //   by that explicit click, and cleared again from Settings. Refusing the
  //   install is an operator decision and must outlive the process that heard
  //   it — "Later" stays renderer-local and session-scoped.
  HOOKS_BRIDGE_PROMPT_PREF_GET: 'hooks:bridge:prompt-pref:get',
  HOOKS_BRIDGE_PROMPT_PREF_SET: 'hooks:bridge:prompt-pref:set',
  //   STATUSLINE_BRIDGE — mirrors HOOKS_BRIDGE for the per-account usage
  //   statusline (`wmux setup-statusline`). STATUS reports per-target install
  //   state; INSTALL performs the same idempotent install as the CLI. Same
  //   explicit-user-trigger constraint — never auto-run at boot.
  STATUSLINE_BRIDGE_STATUS: 'statusline:bridge:status',
  STATUSLINE_BRIDGE_INSTALL: 'statusline:bridge:install',
  //   DECK_CONVERSATION_CLEAR — the operator's `/clear` for one workspace's
  //   orchestrator: disposes the live brain (interrupting an in-flight turn)
  //   and drops the persisted session id, so the next turn starts a FRESH SDK
  //   conversation. The channel transcript deliberately stays — history is
  //   the audit trail; only the brain's context resets.
  DECK_CONVERSATION_CLEAR: 'deck:conversation:clear',
  //   DECK_DECISION_* — the brain-raised decision gate. The orchestrator brain
  //   calls the deck_ask_decision MCP tool to PAUSE its loop and ask the human
  //   a decision; GET hydrates that pending decision on mount (so it shows
  //   after a reboot) and RESOLVE is the human's answer, which un-blocks the
  //   loop and resumes the brain. Same renderer-only trust boundary as DECK_SEND.
  DECK_DECISION_GET: 'deck:decision:get',
  DECK_DECISION_RESOLVE: 'deck:decision:resolve',
  //   DECK_BRIEFING_* — the deterministic "welcome home" briefing. GET builds a
  //   one-shot summary of EXISTING judgment-engine state (fleet, pending
  //   decision, loop, delta-since-last-view) as a synchronous main-process READ:
  //   no brain turn, no globalTurnGate acquire, renders in every autonomy mode
  //   including 'off'. GET is PURE — SEEN is the separate acknowledge the card
  //   sends once the briefing is actually rendered expanded, and only that
  //   advances the "what you last saw" baseline (fetching must never consume a
  //   delta nobody read). CONFIG get/set are the Settings enabled/autoShow
  //   toggles. Same renderer-only trust boundary as DECK_DECISION_*.
  DECK_BRIEFING_GET: 'deck:briefing:get',
  DECK_BRIEFING_SEEN: 'deck:briefing:seen',
  DECK_BRIEFING_CONFIG_GET: 'deck:briefing:config:get',
  DECK_BRIEFING_CONFIG_SET: 'deck:briefing:config:set',
  //   WORKSPACE_MIRROR_PUSH (send) renderer → main: a fire-and-forget full
  //   snapshot of the workspace tree + per-pane agent status. Feeds the
  //   main-process WorkspaceMirror so routing / hook resolution can be served
  //   locally instead of via the `workspace.list` renderer round-trip (which a
  //   large-buffer flush storm starves). Snapshot-only — never read by the UI,
  //   never authoritative for focus. Full replacement (last write wins).
  WORKSPACE_MIRROR_PUSH: 'workspace:mirror:push',
  //   ACCOUNT_* (invoke) renderer → main: multi-account registry CRUD +
  //   per-workspace bindings. Renderer-only trust boundary (main owns
  //   accounts.json; the renderer never resolves spawn env). Onboarding
  //   provisions an isolated config dir (hybrid share) and reports credential
  //   status by polling; the renderer commits ACCOUNT_ADD once login lands.
  ACCOUNT_LIST: 'account:list',
  ACCOUNT_ONBOARD_PREPARE: 'account:onboard:prepare',
  ACCOUNT_ADD: 'account:add',
  ACCOUNT_RENAME: 'account:rename',
  ACCOUNT_REMOVE: 'account:remove',
  ACCOUNT_SET_BINDING: 'account:set-binding',
  ACCOUNT_CREDENTIAL_STATUS: 'account:credential-status',
  // M2 — per-account usage (hook-gated, opt-in). LIST pulls the current cache on
  // Settings mount; REFRESH (renderer → main) forces a manual probe for one
  // account (explicit user action, bypasses the opt-in/cooldown gates); UPDATE
  // (main → renderer) pushes a single account's entry when its cache changes.
  ACCOUNT_USAGE_LIST: 'account:usage:list',
  ACCOUNT_USAGE_REFRESH: 'account:usage:refresh',
  ACCOUNT_USAGE_UPDATE: 'account:usage:update',
  // Clipboard (main process bridge)
  CLIPBOARD_WRITE: 'clipboard:write',
  CLIPBOARD_READ: 'clipboard:read',
  CLIPBOARD_READ_IMAGE: 'clipboard:read-image',
  CLIPBOARD_HAS_IMAGE: 'clipboard:has-image',
  SYSTEM_BUILTIN_DISPLAY: 'system:builtin-display',
  // Fired by main's powerMonitor 'resume' so the renderer can rebuild GPU
  // state that sleep may have invalidated (shared glyph atlas — see
  // terminal/atlasWakeRecovery.ts).
  SYSTEM_RESUMED: 'system:resumed',
  // Phase 4: Auto updater
  UPDATE_CHECK: 'update:check',
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_NOT_AVAILABLE: 'update:not-available',
  UPDATE_ERROR: 'update:error',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  // #866 — the renderer PULLS a refused install's reason once it is mounted
  // and can actually show it. Main pushing on a timer raced the mount and
  // dropped the notice into a window with no listener; the take is what
  // clears the on-disk marker, so a notice nobody received survives to the
  // next boot instead of being consumed by the attempt.
  UPDATE_TAKE_REFUSED_INSTALL: 'update:take-refused-install',
  // #897 — read (do NOT clear) the update that is downloaded and waiting for
  // the user. Pulled by an always-mounted surface for the same reason the
  // refused-install notice is: the push fires once, into the Settings panel.
  UPDATE_GET_PENDING_INSTALL: 'update:get-pending-install',
  // Settings sync (renderer → main)
  TOAST_ENABLED: 'settings:toast-enabled',
  // #516 — renderer mirrors the muted notification categories so the
  // no-renderer toast fallback in dispatchNotification can honor them.
  MUTED_NOTIFICATION_CATEGORIES: 'settings:muted-notification-categories',
  AUTO_UPDATE_ENABLED: 'settings:auto-update-enabled',
  // Phase 2.2 — MCP plugin permission approval (main → renderer subscribe,
  // renderer → main response). Emitted when the enforcer rejects an
  // unconfirmed plugin in enforce mode and the ApprovalQueue mints a
  // prompt. The renderer's PermissionApprovalDialog renders the prompt
  // and sends the user's decision back over PERMISSION_PROMPT_RESOLVE.
  PERMISSION_PROMPT_OPEN: 'permission:prompt-open',
  PERMISSION_PROMPT_RESOLVE: 'permission:prompt-resolve',
  // Main → renderer push fired from INSIDE ApprovalQueue.resolvePrompt AND
  // cancelPrompt the moment a prompt leaves the queue (resolved by the modal,
  // the pluginHost deadlock-break, or a coalesced sibling). Lets the renderer
  // approval-inbox remove the row. Payload: { promptId }.
  PERMISSION_PROMPT_CLOSED: 'permission:prompt-closed',
  // #898 — main → renderer push, once at startup, when a Claude Code plugin
  // install is found whose bridge still forces a permission prompt. wmux
  // refreshes its OWN copy of the bridge but never the plugin's, so this tells
  // the user to run the plugin update. Payload: StalePluginGate[].
  PLUGIN_GATE_STALE: 'plugin:gate-stale',
  // LanLink PR-2 — main → renderer push of a materialized read-only REMOTE
  // inbox item (origin:'remote', off-machine peer). RemoteInboxBridge sends it
  // after a daemon.inbox.poll; the renderer's useRemoteInboxBridge projects it
  // into the remoteInbox slice. Deliberately a DEDICATED channel (like
  // permissionPrompt) — never the RPC_COMMAND path — so a remote message is
  // structurally incapable of reaching submitToPty / the a2a execute funnel.
  // Payload: RemoteInboxItem.
  LANLINK_REMOTE: 'lanlink:remote',
  // LanLink PR-2 — renderer → main replay request. Fired by useRemoteInboxBridge
  // on mount (AFTER its onRemote listener is installed). Main resets the
  // RemoteInboxBridge delivery cursor to 0 and re-pulls, so a reloaded or
  // just-mounted renderer re-materializes the full live inbox (isNew dedups).
  // Closes the renderer-reload / cold-start delivery gap.
  LANLINK_RESYNC: 'lanlink:resync',
  // Shell
  SHELL_OPEN_EXTERNAL: 'shell:open-external',
  // Open an absolute filesystem path in the OS default app / explorer.
  // Triggered by Ctrl+click (mac: Cmd+click) on a path token rendered in the terminal.
  // Path is validated main-side: must be absolute, no NUL bytes, length-capped.
  SHELL_OPEN_PATH: 'shell:open-path',
  // Renderer → main: detect folder-opening apps available on the system.
  // Returns AppEntry[] — the renderer uses this to populate the "Open with"
  // submenu on workspace items. Called on demand (context menu open), not cached.
  SHELL_DETECT_APPS: 'shell:detect-apps',
  // Renderer → main: open a folder with a specific detected app.
  // Payload: { appId: string, folderPath: string }.
  // Resolves { ok: boolean, error?: string }.
  SHELL_OPEN_WITH: 'shell:open-with',
  GIT_STATUS: 'git:status',
  // J2 — diff 리뷰·hunk 채택
  DIFF_READ: 'diff:read',
  DIFF_APPLY_HUNKS: 'diff:applyHunks',
  // 워크스페이스 diff 진입점 — 임의 cwd를 자기 worktree toplevel로 정규화.
  // (서브디렉토리 cwd를 그대로 diff:read에 넘기면 untracked 합성의
  //  join(worktreePath, rel)이 repo-root 상대경로와 어긋난다.)
  DIFF_RESOLVE_REPO: 'diff:resolveRepo',
  // Deck Git 탭 — 워크트리 GUI (list/add/remove; remove는 --force 미제공)
  WORKTREE_LIST: 'worktree:list',
  WORKTREE_ADD: 'worktree:add',
  WORKTREE_REMOVE: 'worktree:remove',
  // Git 탭 머지 세션 — 격리 integration 워크트리 기반(start/status/land/discard)
  WORKTREE_MERGE_START: 'worktree:mergeStart',
  WORKTREE_MERGE_STATUS: 'worktree:mergeStatus',
  WORKTREE_MERGE_LAND: 'worktree:mergeLand',
  WORKTREE_MERGE_DISCARD: 'worktree:mergeDiscard',
  // Git 탭 PR 섹션 — gh CLI 기반 PR 목록·코멘트(성긴 pull, 30s TTL)
  GITHUB_PR_LIST: 'github:prList',
  GITHUB_PR_DETAIL: 'github:prDetail',
  DIALOG_PICK_FILE: 'dialog:pick-file',
  DIALOG_PICK_FOLDER: 'dialog:pick-folder',
  // File system
  FS_READ_DIR: 'fs:read-dir',
  FS_READ_FILE: 'fs:read-file',
  FS_WRITE_FILE: 'fs:write-file',
  FS_WATCH: 'fs:watch',
  FS_UNWATCH: 'fs:unwatch',
  FS_CHANGED: 'fs:changed',
  // Scrollback persistence
  SCROLLBACK_DUMP: 'scrollback:dump',
  SCROLLBACK_LOAD: 'scrollback:load',
  // Claude Code hook signal health (Phase 1.5). Push channel — main process
  // emits whenever SignalLatencyMeter stats change (throttled to 1Hz in
  // registerHooksRpc). Payload: LatencyStats snapshot. Renderer subscribes
  // via preload `signalHealth.onUpdate` and feeds uiSlice.setHookSignalHealth.
  SIGNAL_HEALTH_UPDATE: 'signal-health:update',
  // Anthropic 5h/7d usage meter (Phase 2). Push channel — UsagePoller in
  // main process emits whenever its state changes (initial fetch, hourly
  // tick, manual refresh, 401, network error). Payload: PollerState.
  // Renderer subscribes via preload `usage.onUpdate` and feeds
  // uiSlice.setAnthropicUsage.
  USAGE_UPDATE: 'usage:update',
  // Renderer → main: opt-in / opt-out toggle for the Anthropic usage
  // meter (Settings → Claude 연동 → Anthropic 사용량 표기 토글). Main
  // starts/stops the UsagePoller on receipt.
  USAGE_TOGGLE: 'usage:toggle',
  // Renderer → main: manual refresh (StatusBar mini widget / Settings
  // "지금 새로고침" button). Triggers an immediate poll regardless of
  // interval timing. Caller enforces a UI-side cooldown (5 min).
  USAGE_REFRESH: 'usage:refresh',
  // EventBus publish — renderer→main one-way for pane lifecycle events
  EVENTS_PUBLISH: 'events:publish',
  // Total app memory (renderer → main, invoke). Returns the summed
  // workingSetSize (RSS) across the whole Electron process tree in bytes.
  // Replaces the renderer-only performance.memory.usedJSHeapSize, which only
  // measured the renderer V8 JS heap (~10MB) and grossly under-reported usage.
  APP_MEMORY: 'app:memory',
  // Windows "start on login" toggle. GET queries the per-user Run registry key
  // (source of truth) and returns { enabled }. SET adds/removes it and returns
  // the post-op state. No-op returning { enabled: false } off-Windows.
  AUTOSTART_GET: 'autostart:get',
  AUTOSTART_SET: 'autostart:set',
  // Window control
  WINDOW_HIDE: 'window:hide',
  // Windows taskbar attention recall. Renderer asks main to flash the
  // taskbar entry when an unfocused window receives a notification (T6 of
  // the Notification System Expansion). `on=true` starts the flash;
  // `on=false` clears it. Main also auto-clears on the BrowserWindow
  // `'focus'` event so a user clicking the window dismisses the flash
  // even if the renderer never sends `false`.
  WINDOW_FLASH_FRAME: 'window:flashFrame',
  // Bridge redesign — theme-following native window controls. The custom
  // titlebar renderer reads the active theme's --bg-mantle/--text-sub and
  // asks main to restyle the Windows titleBarOverlay (snap-layout-capable
  // native min/max/close) so the controls never clash with the theme.
  // Windows-only no-op elsewhere (see registerHandlers).
  WINDOW_SET_TITLEBAR_OVERLAY: 'window:setTitleBarOverlay',
  // Whole-interface zoom (#822): the renderer asks main to scale the
  // BrowserWindow with setZoomFactor and re-place the native chrome to match.
  // One-way send — the persisted factor lives in the renderer store.
  WINDOW_SET_UI_SCALE: 'window:setUiScale',
  // macOS: native fullscreen hides the traffic lights, so the renderer's
  // 72px titlebar reserve must collapse (and come back on exit) — the same
  // enter/leave-full-screen → class toggle pattern VS Code/Hyper use. Push
  // (main → renderer) on the window events + a pull (invoke) for the mount-
  // time initial state.
  WINDOW_FULLSCREEN_CHANGED: 'window:fullscreen-changed',
  WINDOW_IS_FULLSCREEN: 'window:isFullScreen',
  // #882 — "is anyone looking at this window": minimized / hidden to tray /
  // screen locked. Same push + pull shape as fullscreen above. Feeds the #766
  // viewer-visibility report, because `document.visibilityState` never reports
  // any of those on Windows (see main/window/windowDisplayed.ts).
  WINDOW_DISPLAYED_CHANGED: 'window:displayed-changed',
  WINDOW_IS_DISPLAYED: 'window:isDisplayed',
  // MCP integration status / management (Settings panel + CLI parity)
  MCP_CHECK: 'mcp:check',
  MCP_REREGISTER: 'mcp:reregister',
  MCP_UNREGISTER: 'mcp:unregister',
  // LanLink PR-3 control plane (renderer → main → daemon control pipe).
  LANLINK_STATUS: 'lanlink:status',
  LANLINK_CONFIGURE: 'lanlink:configure',
  // LanLink PR-5 pairing/peer control plane (renderer → main → daemon control pipe).
  // These bridge the PR-4 daemon control-pipe RPCs (machine-local, never on the LAN
  // net.Server) to the Settings pairing UI. Outbound-only (pair/send); no PTY paste.
  LANLINK_PAIR_BEGIN: 'lanlink:pair:begin',
  LANLINK_PAIR_STATUS: 'lanlink:pair:status',
  LANLINK_PAIR_CANCEL: 'lanlink:pair:cancel',
  LANLINK_PAIR_JOIN: 'lanlink:pair:join',
  LANLINK_SEND: 'lanlink:send',
  LANLINK_PEERS_LIST: 'lanlink:peers:list',
  LANLINK_PEERS_REMOVE: 'lanlink:peers:remove',
  // wmux web — browser/PWA terminal server control (renderer → main → daemon
  // control pipe). The server lives inside the daemon; these forward the
  // daemon.web.{status,start,stop} string RPCs and degrade gracefully when the
  // daemon is unreachable.
  WEB_STATUS: 'web:status',
  WEB_START: 'web:start',
  WEB_STOP: 'web:stop',
  WEB_PAIR_REFRESH: 'web:pairRefresh',
  /** Name a device, THEN mint its code. The daemon refuses a blank name. */
  WEB_PAIR_START: 'web:pairStart',
  /** The operator's paired-device roster. Carries no secret material. */
  WEB_DEVICE_LIST: 'web:deviceList',
  /** Revoke one device permanently and cut its live streams. */
  WEB_DEVICE_REVOKE: 'web:deviceRevoke',
  /** Grant or withdraw one device's permission to type. */
  WEB_DEVICE_SET_INPUT: 'web:deviceSetInput',
  // First-run wizard (Plan 1.15) — magical-moment onboarding flow
  FIRST_RUN_CHECK: 'first-run:check',
  FIRST_RUN_COMPLETE: 'first-run:complete',
  FIRST_RUN_DISMISS: 'first-run:dismiss',
  FIRST_RUN_REOPEN: 'first-run:reopen',
  FIRST_RUN_REGISTER_MCP: 'first-run:register-mcp',
  FIRST_RUN_START_SAMPLE_TASK: 'first-run:start-sample-task',
  // First-run wizard event channels (renderer-side `on()` listeners)
  FIRST_RUN_SAMPLE_TASK_READY: 'first-run:sample-task-ready',
  FIRST_RUN_SAMPLE_TASK_TIMEOUT: 'first-run:sample-task-timeout',
  // Plugin host (B-1). PLUGINS_LIST returns loaded UI plugin summaries +
  // load failures; PLUGINS_RPC forwards a validated bridge request from a
  // plugin iframe through the shared RpcRouter (clientName pinned main-side).
  PLUGINS_LIST: 'plugins:list',
  PLUGINS_RPC: 'plugins:rpc',
  // Renderer-initiated approval prompt for an unconfirmed plugin. Without
  // this, UI plugins dead-lock: the host only mounts trusted iframes, an
  // unmounted iframe makes no RPCs, and the Phase 2.2 approval prompt only
  // fires on a rejected RPC. Resolves with { approved } after the user
  // answers the standard PermissionApprovalDialog.
  PLUGINS_REQUEST_APPROVAL: 'plugins:request-approval',
  // Main → renderer push for `ui.decoratePane` — payload PluginPaneDecoration.
  PLUGIN_PANE_DECORATION: 'plugins:pane-decoration',
  // Project config (X5 wmux.json). GET resolves a workspace cwd to the nearest
  // wmux.json (repo-boundary walk) + its trust state; SET_TRUST persists a
  // user decision bound to the content hash the approval UI displayed.
  PROJECT_CONFIG_GET: 'project-config:get',
  PROJECT_CONFIG_SET_TRUST: 'project-config:set-trust',
  // Remote workspace attach (see src/shared/remoteHosts.ts)
  REMOTE_HOSTS_LIST: 'remote:hosts:list',
  REMOTE_HOSTS_ADD: 'remote:hosts:add',
  // Pair-with-code registration over the unauthenticated GET /api/pair route
  // (see WebTerminalServer.handlePair) — exchanges an 8-char code read from
  // the remote's titlebar Web popover for a device-scoped token, in place of
  // pasting the full wmux-web URL with the token embedded.
  REMOTE_HOSTS_PAIR: 'remote:hosts:pair',
  REMOTE_HOSTS_REMOVE: 'remote:hosts:remove',
  REMOTE_WORKSPACES_LIST: 'remote:workspaces:list',
  // Bootstrap the FIRST pane of a NEW workspace on a remote host (#1001):
  // the desktop mints the workspace id and hands it to `POST /api/sessions`
  // as an operator-authenticated caller (WebTerminalServer.rejectWorkspaceId's
  // one exception). See RemoteHostClient.createWorkspace.
  REMOTE_WORKSPACE_CREATE: 'remote:workspace:create',
  // Destroy a session the desktop minted on a remote host (#1129) —
  // `DELETE /api/sessions/:id`. The teardown half of REMOTE_WORKSPACE_CREATE:
  // closing a remote-terminal tab detaches the stream, and without this the
  // shell (and the one-shot workspace row the daemon derives from it) would
  // outlive the tab forever. See RemoteHostClient.closeSession.
  REMOTE_SESSION_CLOSE: 'remote:session:close',
  // Persisted attach descriptors (see RemoteAttachmentsStore). The renderer's
  // remote-workspace slice is memory-only, so these are what survive a reload
  // and an app restart; panes are never stored, only re-fetched.
  REMOTE_ATTACHMENTS_LIST: 'remote:attachments:list',
  REMOTE_ATTACHMENTS_ADD: 'remote:attachments:add',
  REMOTE_ATTACHMENTS_REMOVE: 'remote:attachments:remove',
  REMOTE_PANE_ATTACH: 'remote:pane:attach',
  REMOTE_PANE_DETACH: 'remote:pane:detach',
  REMOTE_PANE_WRITE: 'remote:pane:write',
  REMOTE_PANE_DATA: 'remote:pane:data',      // main → renderer push
  REMOTE_PANE_META: 'remote:pane:meta',      // main → renderer push (cols/rows/snapshot)
  // main → renderer push (cols/rows only). A resize on the machine that owns
  // the pane: the mirror re-grids and KEEPS what it has, where META means
  // "reset and repaint".
  REMOTE_PANE_RESIZE: 'remote:pane:resize',
  REMOTE_PANE_EXIT: 'remote:pane:exit',      // main → renderer push
  REMOTE_PANE_ERROR: 'remote:pane:error',    // main → renderer push (reconnect gave up)
} as const;

// Daemon process exit codes. A spawned daemon that finds the canonical control
// pipe already owned by a LIVE daemon exits with this distinct code (rather than
// a generic failure) so the launcher reconnects to the existing daemon instead
// of looping into another spawn — the duplicate-daemon / split-brain fix
// (Defect 3 / Step ③). 75 mirrors sysexits.h EX_TEMPFAIL: "try again", and is
// well clear of Node's own 1/2/9-ish fatal codes.
export const DAEMON_EXIT_ALREADY_RUNNING = 75;

// 인스턴스 격리용 경로 suffix. main 프로세스가 dev 빌드(!app.isPackaged)에서
// WMUX_DATA_SUFFIX='-dev'를 설정하고, daemon은 spawn 시 env로 이를 상속한다.
// 이 헬퍼를 모든 소켓/토큰/디렉토리 경로에 적용해, dev 빌드와 packaged 빌드(또는
// 다른 체크아웃의 빌드)가 같은 SingletonLock·소켓·~/.wmux를 두고 충돌하지 않게
// 한다. 미설정(packaged 기본) 시 빈 문자열이라 기존 경로와 100% 동일.
export function dataSuffix(): string {
  return process.env.WMUX_DATA_SUFFIX || '';
}

// Named Pipe / Unix socket path for wmux API
// Fixed name so MCP clients (e.g. Claude Code) can reconnect across wmux restarts
export function getPipeName(): string {
  if (process.platform === 'win32') {
    // Use os.userInfo() instead of process.env.USERNAME — env vars may not
    // be inherited by MCP subprocesses spawned by Claude Code
    const username = require('os').userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux${dataSuffix()}-${username}`;
  }
  const home = require('os').homedir() || '/tmp';
  return `${home}/.wmux${dataSuffix()}.sock`;
}

// Shared MCP broker pipe (plans/mcp-broker-design-2026-07-16.md Option A).
// A SECOND named pipe, separate from the main RPC pipe above: the broker
// speaks line-framed MCP JSON-RPC to shims, not the wmux RPC envelope, and
// keeping the protocols on separate pipes means neither server needs to
// sniff frames. Same per-user + instance-suffix keying as getPipeName so a
// dev-suffixed app's shims can never join the production broker.
export function getMcpBrokerPipeName(): string {
  if (process.platform === 'win32') {
    const username = require('os').userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux-mcpb${dataSuffix()}-${username}`;
  }
  const home = require('os').homedir() || '/tmp';
  return `${home}/.wmux-mcpb${dataSuffix()}.sock`;
}

// Environment variable names injected into PTY sessions
export const ENV_KEYS = {
  WORKSPACE_ID: 'WMUX_WORKSPACE_ID',
  SURFACE_ID: 'WMUX_SURFACE_ID',
  // Human-readable name of the pane's workspace, stamped next to WORKSPACE_ID.
  // DISPLAY ONLY — never a routing/authorization key (workspace names are
  // user-editable and not unique; WORKSPACE_ID stays the identity). It exists
  // because consumers OUTSIDE the renderer (wmux web, which is served by the
  // daemon and has no access to the workspace tree) can otherwise only label a
  // pane by its cwd. Deliberately OPTIONAL and snapshot-shaped: it is the name
  // as of spawn time, so it is absent for panes created before this key existed
  // and stale for a workspace renamed afterwards. Consumers must fall back to
  // the id / cwd rather than trusting it as current.
  WORKSPACE_NAME: 'WMUX_WORKSPACE_NAME',
  // X6 ③: the daemon session id of the pane, injected by the daemon at spawn
  // (DaemonSessionManager.createSession). Unlike SURFACE_ID — which the renderer
  // never supplies at pty.create time because a surface is minted AFTER the pty
  // exists — the daemon always knows its own session id, so this is the one
  // per-pane identifier that reliably reaches the child shell (and the Claude
  // hook bridge). Lets a hook attribute its capture to the EXACT pane instead of
  // collapsing to the workspace's active surface (split-pane / shared-cwd fix).
  PTY_ID: 'WMUX_PTY_ID',
  // Instance-isolation suffix (dev / dogfood vs prod). Re-keys the control pipe
  // + data dir — see dataSuffix() / getPipeName(). Unlike the identity vars it is
  // NOT an ownership claim; it only selects WHICH instance a child joins, so it
  // is deliberately PROPAGATED to child PTYs (forced from the spawning process's
  // OWN env, never a child/profile value) so an agent/MCP/CLI inside a pane
  // re-keys onto THIS instance's pipe instead of silently leaking onto production.
  DATA_SUFFIX: 'WMUX_DATA_SUFFIX',
  SOCKET_PATH: 'WMUX_SOCKET_PATH',
  AUTH_TOKEN: 'WMUX_AUTH_TOKEN',
  SHELL_HOOK: 'WMUX_SHELL_HOOK',
  SHELL_HOOK_ACTIVE: 'WMUX_SHELL_HOOK_ACTIVE',
  // 1d (roster identity): default channel member id for CLI/agent tooling
  // inside the pane. Stamped at spawn with the pane's ptyId — the only
  // spawn-time-stable unique pane coordinate (the pretty auto-name
  // 'w26-1(claude)' cannot exist yet: agent detection runs after spawn).
  // `wmux channel join` defaults to this instead of the colliding literal
  // 'agent', so two CLI agents in different panes never share a member id;
  // display prettiness comes from the daemon-derived roster memberName (1b),
  // and ghost-vs-roster drift is absorbed by the 1c single-row mapping.
  MEMBER_ID: 'WMUX_MEMBER_ID',
  // Marks a daemon session as an ORCHESTRATOR BRAIN pty (the `claude-pty`
  // brain vendor runs the interactive Claude Code TUI in one). A brain is not
  // a worker pane: it is embedded in the deck, never in a surface, and must be
  // filtered out of pane/session listings so it can neither be adopted by the
  // renderer's reconcile nor show up as an agent the orchestrator can drive.
  BRAIN_PTY: 'WMUX_BRAIN_PTY',
  // B′ daemon auto-replace: the app version that spawned this daemon, injected
  // UNCONDITIONALLY (overwriting any inherited value) by launcher.spawnDaemon()
  // and echoed back in daemon.ping as `spawnedByVersion`. Unconditional
  // assignment matters: in wmux-in-wmux dogfood the dev app itself runs inside
  // a daemon-spawned PTY, so a conditional (??=) injection would inherit the
  // OLD daemon's version and poison the staleness gate.
  SPAWNED_BY_VERSION: 'WMUX_SPAWNED_BY_VERSION',
} as const;

/** Id prefix every orchestrator brain pty is minted with (ClaudePtyBrainAdapter).
 *  The ENV_KEYS.BRAIN_PTY marker is the authoritative one, but it only travels
 *  with the daemon SESSION record — per-pty renderer events (metadata updates,
 *  agent status, activity) carry a bare ptyId and nothing else, so the id itself
 *  has to carry the mark too. Both are set at the same place and read through
 *  `isBrainPty` / `isBrainPtyId`. */
export const BRAIN_PTY_ID_PREFIX = 'brain-';

/** True for a ptyId minted as an orchestrator brain pty. The renderer-side half
 *  of the brain exclusion: a brain is not a fleet agent and must never enter a
 *  roster, an agent-status map or the principal registry. */
export function isBrainPtyId(ptyId: string | null | undefined): boolean {
  return typeof ptyId === 'string' && ptyId.startsWith(BRAIN_PTY_ID_PREFIX);
}

/** True for a daemon session that is an orchestrator brain pty. Checks BOTH
 *  marks so a daemon build that omits `env` from its session listing (which
 *  would make the env test silently fail OPEN and let a brain be adopted as a
 *  pane) is still caught by the id. */
export function isBrainPty(session: { id?: string; env?: Record<string, string> | undefined }): boolean {
  return session.env?.[ENV_KEYS.BRAIN_PTY] === '1' || isBrainPtyId(session.id);
}

// Auth token file path — written by wmux main process, read by MCP server
export function getAuthTokenPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return `${home}/.wmux${dataSuffix()}-auth-token`;
}

// PID-to-workspace mapping directory — written by PTYManager, read by MCP server
// to resolve workspace identity when env vars don't propagate through Claude Code
export function getPidMapDir(): string {
  return `${getWmuxHomeDir()}/pid-map`;
}

// TCP port file path — written by PipeServer, read by MCP clients as fallback
// when Windows named pipe EPERM blocks direct pipe connections
export function getTcpPortPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return `${home}/.wmux${dataSuffix()}-tcp-port`;
}

// wmux user home directory — root for plugin-trust.json, pid-map/, and other
// substrate state that needs to survive across wmux restarts. Single source
// of truth so callers don't reimplement the USERPROFILE/HOME dance.
export function getWmuxHomeDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return `${home}/.wmux${dataSuffix()}`;
}

// ─── P7: 데몬 제어/세션 소켓 경로 (macOS/Linux는 ~/.wmux{suffix}/ 하위) ──────
//
// 과거에는 홈 디렉터리에 직접 `~/.wmux-daemon{suffix}.sock` /
// `~/.wmux-session-<id>.sock`을 만들어 홈을 오염시켰다. 디렉터리가 이미
// suffix를 담으므로 파일명에서 suffix를 빼 sun_path 104바이트 한계에 여유를
// 둔다(`~/.wmux/daemon.sock`, `~/.wmux/session-<uuid>.sock`). Windows named
// pipe 이름은 기존 그대로 유지(경로 아님).
//
// FOUR-SIDED LOCKSTEP — 데몬 바인더(daemon/config.ts getDefaultPipeName,
// daemon/SessionPipe.getPipeName)와 클라이언트(main/DaemonClient, cli/client)가
// 전부 이 헬퍼를 쓴다. 서로 다른 경로를 계산하면 구데몬처럼 연결이 끊긴다.
// 업그레이드 중 살아 있는 구버전 데몬과의 호환은 ① 제어 파이프: 데몬이 부팅 시
// 실제 바인드 경로를 `~/.wmux/daemon-pipe` 힌트 파일에 쓰고 클라이언트가 이를
// 우선하므로 유지 ② 세션 파이프: 힌트가 없으므로 클라이언트 쪽 legacy 경로
// 재시도 폴백(main/DaemonClient.connectSessionPipe)으로 유지.

/** 데몬 제어 소켓/파이프 기본 경로. */
export function getDaemonSocketPath(): string {
  if (process.platform === 'win32') {
    const username = require('os').userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux-daemon${dataSuffix()}-${username}`;
  }
  return `${getWmuxHomeDir()}/daemon.sock`;
}

/** P7 이전(구버전)의 데몬 제어 소켓 경로 — 폴백/마이그레이션 판정용.
 * 구버전 코드와 동일하게 os.homedir() 기반으로 계산해야 문자열이 일치한다. */
export function getLegacyDaemonSocketPath(): string {
  const home = require('os').homedir() || '';
  return `${home}/.wmux-daemon${dataSuffix()}.sock`;
}

/** 세션 데이터 소켓/파이프 경로. */
export function getSessionSocketPath(sessionId: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wmux-session-${sessionId}`;
  }
  return `${getWmuxHomeDir()}/session-${sessionId}.sock`;
}

/** P7 이전(구버전)의 세션 소켓 경로 — 구데몬 연결 폴백용(os.homedir() 기반). */
export function getLegacySessionSocketPath(sessionId: string): string {
  const home = require('os').homedir() || '';
  return `${home}/.wmux-session-${sessionId}.sock`;
}

// Daemon control-pipe auth token. Unlike the main-pipe token (getAuthTokenPath,
// a `~/.wmux${suffix}-auth-token` FILE), the daemon token has ALWAYS lived
// INSIDE the ~/.wmux directory next to config.json — so we make the *directory*
// suffix-aware (getWmuxHomeDir) rather than the filename. This mirrors the
// already-suffix-aware daemon control pipe (`wmux-daemon${suffix}-user`): a dev
// / dogfood instance ('-dev') gets its own `~/.wmux-dev/daemon-auth-token`
// instead of colliding with production's token on the shared `~/.wmux/` file
// (concurrent dev+packaged daemons run on different pipes but historically wrote
// the SAME token file — a cold-start race or rotateToken could then brick one
// instance's auth). Crucially, with the default empty suffix the path resolves
// to exactly `~/.wmux/daemon-auth-token` — byte-identical to older versions, so
// existing installs are never stranded.
//
// THREE-SIDED LOCKSTEP — this is the single source of truth. The daemon WRITES
// here (DaemonPipeServer.getTokenPath → loadOrCreateToken/rotateToken); the
// launcher (main/DaemonClient.readDaemonAuthToken) and the CLI
// (cli/client.resolveDaemonAuthToken) READ it. All three MUST call this helper
// — if they compute different paths, nothing authenticates and wmux is bricked.
//
// Home source (GLM review): getWmuxHomeDir() uses USERPROFILE||HOME, like every
// other wmux path helper (getAuthTokenPath / getTcpPortPath). Before this change
// the daemon token used os.homedir() — the ONE outlier. Aligning it with
// USERPROFILE||HOME is precisely what keeps the WRITER in lockstep with the
// launcher+CLI READERS (which resolve through this helper). The daemon's OTHER
// ~/.wmux files (config.json, daemon-pipe) still resolve via src/daemon/config.ts
// getWmuxDir → os.homedir(); on every real platform os.homedir() === USERPROFILE
// (Windows) / HOME (*nix) so token and config co-locate, but unifying getWmuxDir
// onto getWmuxHomeDir so the whole daemon shares ONE home source is a separate
// follow-up (it also touches config/pipe paths, out of scope for the auth fix).
export function getDaemonAuthTokenPath(): string {
  return `${getWmuxHomeDir()}/daemon-auth-token`;
}

// Legacy (pre-suffix) daemon token location: the ALWAYS-unsuffixed
// `~/.wmux/daemon-auth-token`, exactly as older wmux versions wrote it. READERS
// (launcher, CLI) fall back to this when the suffix-aware path is absent, so a
// suffixed instance upgrading OVER a still-running older daemon (which wrote
// here) can still authenticate during the transition. It is a read-only
// migration shim: the daemon WRITER never consults it (that would re-establish
// the cross-instance collision for the suffixed case). With the default empty
// suffix getDaemonAuthTokenPath() resolves to this exact string, so the fallback
// is a no-op for production. (Same USERPROFILE/HOME base as getWmuxHomeDir,
// which equals os.homedir() — where older versions wrote — on Windows.)
export function getLegacyDaemonAuthTokenPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return `${home}/.wmux/daemon-auth-token`;
}

// Plugin trust database — see `docs/api/mcp-plugin-spec.md`. Written by main
// process via `PluginTrustStore` (atomicWriteJSON). NOT a secret — it stores
// declared identities and user-issued trust grants, not credentials.
export function getPluginTrustPath(): string {
  return `${getWmuxHomeDir()}/plugin-trust.json`;
}
