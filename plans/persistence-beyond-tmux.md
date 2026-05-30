# Persistence beyond tmux — design + staged plan

Status: design / research (2026-05-30)
Owner: render + daemon
Trigger: user dogfood — `npm start` showed blank terminals after a 20-session
restore; goal set to "make wmux that surpasses tmux's persistence."

---

## 1. What actually happened (root cause, confirmed)

The blank terminals were NOT a daemon-matching failure. The opposite: the daemon
matched perfectly and restored all 20 sessions. Evidence:

- Daemon (pid 21460) had **40 live child processes** = 20 `powershell.exe` + 20
  `conhost.exe`. Every recovered session got a live shell in its saved cwd.
- Daemon log: `04:37:00 rpc.shutdown` (old prod app, v2.15.0, sent it on quit) →
  20 PTYs dumped + killed → `04:37:25` new daemon recovered 20 sessions from
  `.buf` dumps → "Daemon ready", Watchdog `sessions=20`.
- Renderer console: `Too many active WebGL contexts. Oldest context will be
  lost.` ×14, all from `useTerminal` loadWebgl.

The renderer loaded one WebGL context per visible terminal with **no global
ceiling**. Restoring 20 sessions pushed the visible-pane context count past
Chromium's ~16 cap; Chromium force-evicted the oldest contexts and those panes
went blank. The 10s deferred-dispose amplified it across view-switch churn.

**Fixed this session (Fix B):** `webglContextPool` — a process-wide LRU budget
(`MAX_WEBGL_CONTEXTS = 12`) that hard-bounds live contexts below the cap and
grants them most-recently-shown first. Over-budget terminals get a CONTROLLED
dispose → xterm DOM renderer (always works), instead of Chromium's uncontrolled
eviction. Persistence can now restore an arbitrary session count and every
terminal renders. (8 pool unit tests + 188 renderer tests + tsc green.)

**Confirmed already correct (Fix A):** `daemon.shutdown` is sent ONLY from the
explicit full-shutdown branch (`index.ts` before-quit, gated on
`fullShutdownRequested`). A normal Quit detaches. Locked by
`beforeQuitDisconnectRace.test.ts`. The 04:37 shutdown came from the OLD
installed prod app, not the new code.

---

## 2. The persistence ladder — where wmux sits vs tmux

| # | Survives… | live processes? | tmux | wmux today |
|---|-----------|-----------------|------|------------|
| 1 | client detach / relaunch | yes | ✅ | ✅ (new code: Quit = detach, daemon + PTYs stay) |
| 2 | daemon crash / restart | yes | ❌ (killing the tmux server loses everything) | ❌ → **R2** |
| 3 | OS reboot | yes | ❌ | ❌ (impossible on Windows — OS tears down all user processes) |
| 4 | OS reboot | scrollback + fresh shell in same cwd | ❌ (tmux-resurrect restores layout only, no scrollback) | ✅ already |

Reading this honestly: wmux already **matches** tmux on (1) and is already
**beyond** tmux on (4). The one place to genuinely surpass tmux is **(2)** —
keep the actual running processes (Claude Code, vim, a build) alive across a
daemon death. tmux cannot; its single server IS the thing that dies.

(3) with live processes is physically impossible on Windows without a Session-0
service, which can't host an interactive ConPTY a user attaches to. So the
ceiling for "live process survival" is (2). For (3) the floor is (4), which we
already clear.

---

## 3. The Windows constraint that makes (2) hard

The daemon spawns ConPTY sessions via node-pty (`useConpty: true`). Each session
is a `powershell.exe` + a `conhost.exe` that OWNS the pseudoconsole (HPCON). The
daemon holds the master read/write pipes. When the daemon dies, node-pty's
handles close → the HPCON is torn down → conhost signals the shell → the shell
dies. **The shell's lifetime is chained to the daemon's via ConPTY ownership.**

Unlike Unix (double-fork + reparent to init, PTY master holdable by anyone),
Windows ConPTY has no native "detach this pty and re-attach it to another
process" API. So surviving a daemon death requires the PTY owner to be a process
that is NOT the daemon.

---

## 4. Approaches

### R1 — Bulletproof daemon (the tmux-server model, done right)

Make the daemon never die on its own. Then the only daemon deaths are: explicit
full-shutdown (user intent), reboot, or a hard crash — and detach already keeps
every PTY alive across client restarts. This is exactly tmux's model (long-lived
server, clients attach/detach), and wmux already has the detach half.

**Concrete gap found this session (actionable):** the daemon can still be
self-killed on a *hang*. `DaemonRespawnController` escalates after 5 consecutive
failed health pings (~50s at 10s interval / 5s timeout) and forces a respawn;
`ensureDaemon` then verify-kills the "wedged" daemon and spawns a fresh one —
**losing all live PTYs**. A daemon that is merely CPU-starved for ~60s (huge
`sessions.json` recovery, Defender scan, GC pause) trips this. RCA A4 already
raised the thresholds, but the failure mode remains: *slow ≠ dead, yet we kill
it.*

R1 work items:
- Health escalation must not kill a daemon that has **live sessions** without a
  much longer grace + a "are you actually dead (process gone), or just slow"
  check. Prefer waiting over killing when `sessions > 0`.
- Make `ensureDaemon`'s kill-before-respawn the genuine last resort: only when
  the PID is gone or the pipe is unrecoverable, never on "ping was slow."
- Crash-proof the daemon hot paths (PTY data, RPC dispatch, recovery): an
  unhandled throw must never take down the process holding 20 PTYs.

Cost: low–moderate. Value: high. Delivers tmux-equivalent live persistence and
makes daemon deaths genuinely rare. **Recommended next milestone.**

### R2 — Session-host (PTY leader) process (the genuine "beyond tmux")

Split a thin, ultra-stable **session host** out of the daemon. The session host
creates and OWNS the HPCONs + shell processes and exposes a PTY-relay pipe. The
daemon connects to the session host and relays bytes (pty output → daemon →
renderer; renderer input → daemon → pty). The daemon never owns the HPCON.

If the daemon crashes or restarts, the session host keeps every shell alive; the
new daemon re-attaches to the relay and replays buffered output. Now (2) is real:
your running Claude Code survives a daemon restart. Strictly dominates tmux,
which loses everything when its one server dies.

Why it's an ocean:
- node-pty has no "hand a pty to another process." The session host must BE the
  node-pty owner and relay I/O over IPC — a new process, a new pipe protocol, and
  reconnect/replay logic on daemon re-attach.
- New long-lived process holding live shells = real security surface (ACLs,
  auth on the relay pipe, no token leakage). Needs its own review.
- Still does NOT survive reboot (the session host dies too) — (4) remains the
  floor there.

Cost: weeks + a dedicated design/security review. Substrate-aligned (thin
neutral PTY substrate under a restartable control daemon). **Plan as a separate
milestone, not now.**

### Floor — scrollback recovery (already shipped)

For every unavoidable death (reboot, session-host crash, explicit shutdown), the
daemon recovers each session as a fresh shell in the saved cwd with the old
scrollback pre-filled (`createSession` + `scrollbackData` + `deferOutput`). This
is the graceful degradation and is already beyond tmux (rung 4). Fix B is what
makes it actually render at scale.

---

## 5. Recommended staged path

1. **Now (this session):** Fix B (render scaling) + Fix A (detach lock).
   Prerequisite for everything — persistence is useless if restored terminals
   are blank. ✅ done.
2. **Milestone R1:** harden the daemon to never self-kill on a hang with live
   sessions; make respawn-kill the true last resort; crash-proof hot paths.
   Tms-equivalent live persistence, daemon deaths become rare.
3. **Milestone R2:** session-host PTY-leader process so live processes survive
   daemon crash/restart. The genuine beyond-tmux. Own design + security review.
4. **Polish (Fix C):** surface a "session restored (fresh shell)" marker so a
   recovered session reads as intentional, not a glitch. Needs a daemon-side
   `recovered` flag plumbed to the renderer. Small, do alongside R1.

---

## 6. Open questions for review

- R1: what grace is acceptable for a wedged-but-live daemon before we give up?
  (User-visible: "wmux is frozen" vs "wmux killed my sessions." The latter is
  worse — bias hard toward waiting when `sessions > 0`.)
- R2: is a single session-host for all sessions the right unit, or one host per
  workspace (blast-radius isolation vs process count)? Substrate neutrality says
  one neutral host; revisit under the substrate plan.
- Fix C: marker as an inline divider in the buffer, or a pane-level chrome badge?
  Inline survives scrollback dump/restore; chrome is cleaner but ephemeral.
