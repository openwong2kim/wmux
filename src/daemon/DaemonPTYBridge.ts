import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { OscParser } from '../main/pty/OscParser';
import { TerminalNotificationParser } from '../main/pty/oscNotification';
import { AgentDetector, type AgentEventStatus } from '../main/pty/AgentDetector';
import { ActivityMonitor } from '../main/pty/ActivityMonitor';
import { parseOsc7Cwd, detectPromptCwd } from '../main/pty/cwdDetect';
import { sanitizeTitle } from '../main/pty/titleDetect';
import { RingBuffer } from './RingBuffer';
import { PromptEventLog, parseOsc133Payload } from './PromptEventLog';
import { OutputModeTracker } from './util/outputModeTracker';
import { RESIZE_REDRAW_GUARD_MS } from '../main/notification/idleSuppression';

/**
 * Daemon version of PTYBridge.
 * Replaces BrowserWindow IPC with EventEmitter events.
 *
 * Events:
 *  - 'data'     → Buffer (raw PTY output)
 *  - 'cwd'      → { sessionId: string, cwd: string }
 *  - 'agent'    → { sessionId: string, event: AgentEvent }
 *  - 'notification' → { sessionId, event: TerminalNotification & { ts } }
 *  - 'critical' → { sessionId: string, event: CriticalEvent }
 *  - 'active'   → { sessionId, agentName?, likelyRepaint? } — onActive cycle
 *                 start; likelyRepaint marks a passive burst inside the
 *                 resize-redraw guard window (alarm feeds must ignore it)
 *  - 'idle'     → { sessionId: string }                — onActiveToIdle
 *  - 'exit'     → { sessionId: string, exitCode, signal }
 *  - 'resize'   → (no payload) — an applied geometry change; consumers read the
 *                 new size from the session's own meta.
 */
export class DaemonPTYBridge extends EventEmitter {
  private oscParser: OscParser | null = null;
  private modeTracker: OutputModeTracker | null = null;
  private agentDetector: AgentDetector | null = null;
  private activityMonitor: ActivityMonitor | null = null;
  private dataDisposable: (() => void) | null = null;
  private exitDisposable: (() => void) | null = null;
  private idleUnsubscribe: (() => void) | null = null;
  private activeUnsubscribe: (() => void) | null = null;
  private agentUnsubscribe: (() => void) | null = null;
  private criticalUnsubscribe: (() => void) | null = null;
  private resizeGuardTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId: string | null = null;
  /**
   * v2.8.1 hotfix: when true, drop PTY output instead of writing it to
   * the ring buffer. Used by recovery sessions until the renderer has
   * resized the PTY to its actual cols/rows; otherwise output produced
   * at the saved/default geometry interleaves with output the renderer
   * paints at the new geometry.
   *
   * Exit notification is unaffected — `ptyProcess.onExit` fires even
   * while muted so the daemon notices when a recovered shell dies.
   */
  private muted = false;

  /**
   * Last resize timestamp for this session (daemon-process state — the
   * main-side idleSuppression Maps are unreachable from here). Mirrors the
   * local-mode PTYBridge resize-redraw guard: an onActive burst that starts
   * within RESIZE_REDRAW_GUARD_MS of a resize is a TUI repaint, and
   * resetting the AgentDetector emission dedup on it would let the
   * unchanged idle footer re-match and re-fire a stale notification.
   */
  private lastResizeAtMs = 0;

  /**
   * app-weight P1-4: last cwd emitted from the OSC 7 path. Starts null so
   * the first OSC 7 after spawn always emits; a bridge instance is strictly
   * per-PTY-lifetime (setupDataForwarding once, cleanup on teardown), so a
   * plain field is sufficient. Cleared in cleanup() for hygiene.
   */
  private lastEmittedOscCwd: string | null = null;

  /**
   * OSC 7-sticky: set on the first OSC 7 from this session's shell and never
   * cleared. While true, prompt-scrape cwd detection is skipped entirely — the
   * hook is the authoritative source, and the scraper's only remaining effect
   * would be false positives from screen text shaped like a prompt.
   */
  private oscCwdSeen = false;

  /**
   * A detector/hook terminal state (waiting, complete, awaiting input, error)
   * outranks passive byte throughput until a real submitted-input boundary
   * starts the next turn. This prevents a full-screen idle redraw from
   * resurrecting stale `running` metadata.
   */
  private explicitTerminalStatus = false;
  private submittedTurnPending = false;

  /**
   * Which terminal status settled the pane, while one has. Read only to keep
   * `awaiting_input` out of the byte-promotion path below: that status means a
   * HUMAN has to act, and only a human acting — `noteInput`, including the
   * forceSubmitted approval controls — should retire it. Every other terminal
   * status is a statement about the agent, which a turn the agent starts by
   * itself can legitimately contradict.
   */
  private settledStatus: AgentEventStatus | null = null;

  /**
   * Last write to this PTY's stdin, from any client. Only the settled branch
   * reads it: while a terminal status owns the pane, a burst that starts this
   * soon after a keystroke is the TUI echoing the user's own typing, and
   * letting it promote the pane to `running` would paint every draft message
   * as work. Measured on Claude Code (2026-08-21, 140x41): typing peaks at
   * ~1.5 KB per 3 s window against a 2 KB threshold, so the threshold alone
   * already separates echo from work on that TUI — this guard is what keeps
   * the separation from depending on one agent's repaint economy.
   */
  private lastInputAt = 0;
  /**
   * At least one full activity window. A shorter one would let bytes banked
   * before a keystroke combine, inside the same 3 s measurement window, with
   * the echo that followed it — the guard has to outlast what it is guarding.
   */
  private static readonly INPUT_ECHO_QUIET_MS = 3000;

  /**
   * When the current settle was recorded, and how long a burst must wait
   * before it may contradict it.
   *
   * A turn does not stop painting the moment it ends: the summary line, the
   * footer and the cursor restore all land after the Stop hook. Promoting on
   * that tail would be wrong twice over — it reports a finished pane as
   * running, and it feeds `notePaneWorking`, whose whole job is to rebut an
   * open completion window, so a real "turn finished" alarm would die
   * silently (the failure #907 exists to prevent).
   *
   * The length is set by a SECOND constraint, which is the tighter one. The
   * status a promotion writes is cleared by the byte-silence idle that follows
   * it, and main drops that idle when it lands within 10 s of the pane's last
   * lifecycle event (`AGENT_EVENT_SUPPRESSION_MS` in DaemonNotificationRouter,
   * mirrored from PTYBridge). The idle cannot arrive sooner than
   * IDLE_DELAY_MS (5 s) after the promoting burst, so a cool-down under 5 s
   * leaves a window where a SHORT autonomous burst is promoted and then has
   * its clearing idle swallowed — a pane stuck reporting `running` after it
   * finished, which is the other half of the very bug this fixes. Six seconds
   * clears 10 s with both delays counted, and is still short next to any turn
   * worth reporting.
   */
  private settledAtMs = 0;
  private static readonly SETTLE_COOLDOWN_MS = 6000;

  /**
   * A pane that has been blocked on a human since its last submitted input or
   * running edge. `settledStatus` alone is not enough: the Claude footer under
   * an approval box still matches the detector's idle-prompt patterns, and that
   * `waiting` would otherwise overwrite the `awaiting_input` that must stay.
   */
  private awaitingHuman = false;

  /** Track bracketed-paste input so newlines inside a pasted draft are not
   * mistaken for Enter. The closing marker and the later CR are separate writes
   * in the normal renderer path; only that CR starts a turn. */
  private inputInBracketedPaste = false;
  private static readonly BRACKETED_PASTE_START = '\x1b[200~';
  private static readonly BRACKETED_PASTE_END = '\x1b[201~';

  /** Called by DaemonSessionManager.resizeSession on every applied resize. */
  noteResize(): void {
    this.lastResizeAtMs = Date.now();
    // One event for BOTH resize paths (the phone's /api/sessions/:id/resize and
    // the desk's RPC) — they both land in resizeSession, and an SSE viewer whose
    // grid is now the wrong size renders every later absolute-positioned frame
    // in the wrong place.
    this.emit('resize');
  }

  /**
   * Live terminal-mode state reconstructed from this session's output, or null
   * before data forwarding is set up. Read by the SSE snapshot path so a capped
   * window that no longer contains the mode switches can still be replayed
   * faithfully — see util/outputModeTracker.ts.
   */
  get outputModes(): OutputModeTracker | null {
    return this.modeTracker;
  }

  /**
   * Observe bytes successfully written to PTY stdin. A CR/LF outside bracketed
   * paste is a submitted turn; callers that send an immediate TUI choice
   * (approval digit/ESC) pass `forceSubmitted=true` because those controls do
   * not include Enter but still resume the blocked turn.
   */
  noteInput(data: string, forceSubmitted = false): void {
    // Stamped for EVERY write, including the ordinary keystrokes that fall out
    // below. Output that arrives while the user is still typing is the TUI
    // echoing them, and echo must never be mistaken for the agent working —
    // see the settled branch in setupDataForwarding's data handler.
    if (data.length > 0) this.lastInputAt = Date.now();

    const hasSubmitBoundary = this.scanSubmittedInput(data);
    if (!forceSubmitted && !hasSubmitBoundary) return;

    this.explicitTerminalStatus = false;
    this.settledStatus = null;
    this.awaitingHuman = false;
    this.submittedTurnPending = true;
    if (this.resizeGuardTimer) {
      clearTimeout(this.resizeGuardTimer);
      this.resizeGuardTimer = null;
    }
    this.agentDetector?.resetEmissionState();
    if (this.activityMonitor && this.sessionId) {
      this.activityMonitor.beginTurn(this.sessionId);
    }
  }

  /**
   * Apply an authoritative detector/hook lifecycle edge inside the daemon.
   * Terminal states settle the turn and block later byte-only redraws;
   * explicit running activity opens the gate again for autonomous work.
   */
  noteAgentStatus(status: AgentEventStatus): void {
    if (status === 'running') {
      this.explicitTerminalStatus = false;
      this.settledStatus = null;
      // `awaitingHuman` deliberately survives. HookIngest projects
      // `agent.subagent_stop` and every metadata kind (activity, tool_started,
      // session_start) as `running`, so a subagent finishing behind an
      // unanswered approval would otherwise retire the question nobody
      // answered. Only `noteInput` — a human, including the forceSubmitted
      // approval controls — clears it.
      //
      // #1045: an authoritative running edge also re-arms the byte cycle,
      // gated on the cycle being INACTIVE — repeated running-class hook
      // events inside one turn must not re-open the once-per-cycle onActive
      // dedup (#1013). Without this, a tool call whose own output stays
      // under the throughput threshold (a polling loop, a slow build) could
      // never earn `running` back after an idle, and the roster showed idle
      // for a pane genuinely mid-turn.
      if (this.activityMonitor && this.sessionId) {
        this.activityMonitor.beginTurnIfInactive(this.sessionId);
      }
      return;
    }
    this.explicitTerminalStatus = true;
    this.settledStatus = status;
    if (status === 'awaiting_input') this.awaitingHuman = true;
    this.settledAtMs = Date.now();
    this.submittedTurnPending = false;
    if (this.resizeGuardTimer) {
      clearTimeout(this.resizeGuardTimer);
      this.resizeGuardTimer = null;
    }
    // Re-arm the activity cycle on the turn end so the NEXT burst has to earn
    // `running` from scratch. Without this the cycle re-arms only after five
    // seconds of byte silence, which a TUI painting a live counter never gives.
    if (this.activityMonitor && this.sessionId) {
      this.activityMonitor.endTurn(this.sessionId);
    }
  }

  /**
   * True when nothing has been written to this PTY's stdin recently enough for
   * the current output to be an echo of it. `lastInputAt` starts at 0, so a
   * pane nobody has typed into is quiet from the moment it spawns.
   */
  private inputIsQuiet(): boolean {
    return Date.now() - this.lastInputAt >= DaemonPTYBridge.INPUT_ECHO_QUIET_MS;
  }

  private scanSubmittedInput(data: string): boolean {
    let remaining = data;
    let submitted = false;

    while (remaining.length > 0) {
      if (this.inputInBracketedPaste) {
        const closeAt = remaining.indexOf(DaemonPTYBridge.BRACKETED_PASTE_END);
        if (closeAt < 0) return submitted;
        this.inputInBracketedPaste = false;
        remaining = remaining.slice(
          closeAt + DaemonPTYBridge.BRACKETED_PASTE_END.length,
        );
        continue;
      }

      const openAt = remaining.indexOf(DaemonPTYBridge.BRACKETED_PASTE_START);
      const outsidePaste = openAt < 0 ? remaining : remaining.slice(0, openAt);
      if (/[\r\n]/.test(outsidePaste)) submitted = true;
      if (openAt < 0) break;

      this.inputInBracketedPaste = true;
      remaining = remaining.slice(
        openAt + DaemonPTYBridge.BRACKETED_PASTE_START.length,
      );
    }

    return submitted;
  }

  // Prompt-based CWD detection. Parsing is shared with the local PTYBridge via
  // ../main/pty/cwdDetect (parseOsc7Cwd / detectPromptCwd) so both spawn paths
  // stay in lockstep; this only owns the ANSI strip + buffering.
  // eslint-disable-next-line no-control-regex
  private static readonly ANSI_STRIP = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[[?]?[0-9;]*[hlm]/g;

  setupDataForwarding(
    ptyProcess: IPty,
    ringBuffer: RingBuffer,
    sessionId: string,
    promptLog?: PromptEventLog,
  ): void {
    const oscParser = new OscParser();
    this.oscParser = oscParser;

    // Fed from the same place the ring is written, so the tracked modes always
    // describe exactly the bytes the ring holds.
    //
    // Including the bytes that were already there: a RECOVERED session's ring is
    // pre-filled with saved scrollback BEFORE this bridge exists (see
    // DaemonSessionManager.createSession), and those are precisely the
    // long-running fullscreen sessions the preamble exists for — a tracker that
    // started at power-on defaults here would report "no alt screen" for a pane
    // that has been inside vim since before the daemon restarted. One pass over
    // the ring, once per PTY lifetime.
    const modeTracker = new OutputModeTracker();
    this.modeTracker = modeTracker;
    const prefilled = ringBuffer.readAll();
    if (prefilled.length > 0) {
      modeTracker.feed(prefilled.toString('utf8'), ringBuffer.totalBytesWritten);
    }

    const agentDetector = new AgentDetector();
    this.agentDetector = agentDetector;

    this.sessionId = sessionId;
    this.explicitTerminalStatus = false;
    this.submittedTurnPending = false;
    this.inputInBracketedPaste = false;
    this.lastInputAt = 0;
    this.settledStatus = null;
    this.settledAtMs = 0;
    this.awaitingHuman = false;

    const activityMonitor = new ActivityMonitor();
    this.activityMonitor = activityMonitor;
    activityMonitor.start(sessionId);

    // Activity → idle notification. Once a detector or hook has already
    // settled this turn, byte silence is weaker evidence and must not clear the
    // explicit waiting/complete state five seconds later.
    this.idleUnsubscribe = activityMonitor.onActiveToIdle((ptyId) => {
      if (this.explicitTerminalStatus) return;
      this.emit('idle', { sessionId: ptyId });
    });
    // Activity → active notification. A submitted turn is re-armed by
    // beginTurn(), so its very first output emits running even for a short
    // reply. A settled pane can be promoted too, but only by a burst that
    // cleared the threshold from a cycle the turn end re-armed, with the user's
    // keystrokes quiet and outside the resize-redraw window — the three things
    // that separate an autonomous turn from echo and repaints.
    this.activeUnsubscribe = activityMonitor.onActive((ptyId) => {
      let likelyRepaint = false;

      if (this.explicitTerminalStatus) {
        // A pane blocked on a human is never retired by bytes — it stays in
        // the "needs you" count until a person answers, however much a
        // subagent paints behind the prompt. Read from the sticky flag rather
        // than `settledStatus`, which a later detector `waiting` off the footer
        // under the approval box would otherwise overwrite.
        if (this.awaitingHuman) return;

        // Promoting a SETTLED pane. Three things disqualify the burst: the
        // turn that just ended is still painting its tail, the user's
        // keystrokes are still echoing, or a resize is still repainting.
        //
        // Every rejection re-arms the cycle rather than consuming it. A burst
        // that proved nothing must not spend the one `onActive` a cycle gets,
        // or the real autonomous turn arriving right behind it would stay
        // silent for as long as it kept the idle timer alive — which, for a
        // TUI painting a live counter, is the whole turn. That applies to the
        // cool-down too: the tail of the finishing turn is exactly the burst
        // most likely to arrive just before a genuine one.
        const now = Date.now();
        if (
          now - this.settledAtMs < DaemonPTYBridge.SETTLE_COOLDOWN_MS
          || !this.inputIsQuiet()
          || now - this.lastResizeAtMs < RESIZE_REDRAW_GUARD_MS
        ) {
          activityMonitor.endTurn(ptyId);
          return;
        }
        this.explicitTerminalStatus = false;
        this.settledStatus = null;
        this.submittedTurnPending = false;
        // Deliberately NOT resetEmissionState(). The unsettled path below
        // clears the detector's dedup so a new turn's footer can speak again;
        // doing it here would let the idle chrome that is still on screen
        // answer the `complete` this pane just recorded with a stale
        // `waiting` — trading a silent wrong status for a loud one.
      } else {
        const inputStartedTurn = this.submittedTurnPending;
        this.submittedTurnPending = false;

        // Real submitted input already reset detector dedup in noteInput(). For
        // a passive startup/autonomous burst, retain the resize-redraw guard: a
        // TUI repaint is not a new turn and must not make an unchanged footer
        // emit another waiting notification.
        if (!inputStartedTurn) {
          const elapsed = Date.now() - this.lastResizeAtMs;
          likelyRepaint = elapsed < RESIZE_REDRAW_GUARD_MS;
          if (likelyRepaint) {
            if (this.resizeGuardTimer) clearTimeout(this.resizeGuardTimer);
            this.resizeGuardTimer = setTimeout(() => {
              this.resizeGuardTimer = null;
              this.agentDetector?.resetEmissionState();
            }, RESIZE_REDRAW_GUARD_MS - elapsed);
          } else {
            this.agentDetector?.resetEmissionState();
          }
        }
      }

      // gate로 확정된 에이전트 이름을 active 이벤트에 함께 싣는다. main의
      // DaemonNotificationRouter는 daemon AgentDetector에 직접 닿지 못하지만,
      // 같은 daemon 프로세스인 여기서는 getLastAgent()가 닿는다. 이게 있어야
      // idle prompt 패턴이 안 잡히는 에이전트(Claude Code v2.1.x 등)도 running
      // 상태에서 agentName이 채워진다.
      // `likelyRepaint`: this passive burst sits inside the resize-redraw
      // guard window, so it is a TUI repaint, not work. The loose status dot
      // still updates (the flag travels with the event), but the alarm's
      // working feed in daemon/index.ts must NOT treat it as turn evidence —
      // a repaint rebutting a pending completion window would silently kill
      // a real "finished" alarm.
      this.emit('active', {
        sessionId: ptyId,
        agentName: this.agentDetector?.getLastAgent() ?? undefined,
        likelyRepaint,
      });
    });

    // Terminal desktop-notification sequences (OSC 9/777/99). Stateful for
    // OSC 99 chunk assembly, so it lives per-bridge like OscParser itself.
    const notificationParser = new TerminalNotificationParser();

    // OSC events → cwd (OSC 7), prompt/command markers (OSC 133), and
    // desktop notifications (OSC 9/777/99)
    oscParser.onOsc((event) => {
      if (event.code === 0 || event.code === 2) {
        // OSC 0/2 window title (e.g. Claude Code `/rename`). OSC 1 (icon-only)
        // is ignored. Sanitized here so the daemon→main payload is already safe.
        const title = sanitizeTitle(event.data);
        if (title) this.emit('title', { sessionId, title });
        return;
      }
      if (event.code === 7) {
        // app-weight P1-4: dedup identical OSC 7 emissions. Shells re-emit
        // OSC 7 on every prompt redraw, so an idle pane would otherwise spam
        // the same cwd across daemon→main→renderer on each redraw. Mirrors
        // the prompt-detect guard (lastDetectedCwd) below; the first OSC 7
        // after spawn always emits because the cache starts null.
        const cwd = parseOsc7Cwd(event.data);
        // OSC 7-sticky (2026-07-21): this shell has the integration hook — the
        // authoritative cwd source. Disable prompt scraping for the session's
        // lifetime so screen text that happens to match a prompt regex (agent
        // TUI output printing "user@host:path$"-shaped strings — observed live
        // as a pane cwd stored as the literal "path") can never override it.
        this.oscCwdSeen = true;
        if (cwd !== this.lastEmittedOscCwd) {
          this.lastEmittedOscCwd = cwd;
          this.emit('cwd', { sessionId, cwd });
        }
        return;
      }
      if (event.code === 9 || event.code === 99 || event.code === 777) {
        const notification = notificationParser.handle(event.code, event.data);
        if (notification) {
          this.emit('notification', { sessionId, event: { ...notification, ts: Date.now() } });
        }
        return;
      }
      if (event.code === 133 && promptLog) {
        const parsed = parseOsc133Payload(event.data, Date.now(), ringBuffer.totalBytesWritten);
        if (parsed) {
          promptLog.append(parsed);
          this.emit('prompt', { sessionId, event: parsed });
        }
      }
    });

    // Agent detection. Apply status priority before forwarding the event so a
    // same-chunk/full-screen redraw cannot race a terminal state back to running.
    this.agentUnsubscribe = agentDetector.onEvent((agentEvent) => {
      this.noteAgentStatus(agentEvent.status);
      this.emit('agent', { sessionId, event: agentEvent });
    });

    // Critical action detection
    this.criticalUnsubscribe = agentDetector.onCritical((criticalEvent) => {
      this.emit('critical', { sessionId, event: criticalEvent });
    });

    // Prompt-based CWD detection state
    let lastDetectedCwd = '';
    let promptBuffer = '';

    // PTY data handler
    const onDataDisposable = ptyProcess.onData((data: string) => {
      const buf = Buffer.from(data);

      // Byte activity is weaker than a detector/hook terminal edge. Process it
      // FIRST, so a waiting/complete pattern found in this same chunk is
      // forwarded last and remains authoritative.
      //
      // While the pane is settled the bytes still count, but only once the
      // user's own keystrokes have gone quiet (#935). A turn the agent starts
      // by ITSELF — a background task finishing and the agent picking up —
      // submits no input and, on a hook install without PostToolUse, produces
      // no explicit running edge either, so those two openers left the pane
      // wearing the previous turn's `complete` for the whole autonomous turn.
      // Echo is what the settled branch has to exclude, and the input stamp
      // names it directly instead of blocking every byte to be safe.
      if (!this.muted && (!this.explicitTerminalStatus || this.inputIsQuiet())) {
        try {
          activityMonitor.feed(sessionId, buf.length);
        } catch {
          // activity heuristics must never block detection or data forwarding.
        }
      }

      // AgentDetector는 순수 텍스트 분석(side effect 없음)이라 muted 구간에서도
      // 돌려야 한다. recovery 세션은 첫 resize 전까지 muted인데, 그 사이에
      // 에이전트 시작 배너("Claude Code vX" 등)가 출력되면 gate 정규식이 영구
      // 미활성화되어 이후 모든 status 감지가 죽는다(daemon mode agent detection
      // 갭). activity보다 뒤에서 처리해 같은 chunk의 명시 상태가 최종 승자가 된다.
      try {
        agentDetector.feed(data);
      } catch {
        // detection 실패가 데이터 포워딩을 막아선 안 된다.
      }

      // Muted: drop the chunk before any side effect. Recovery sessions
      // run muted until their first resize so the geometry mismatch
      // window (Bug 2 in v2.8.0) doesn't pollute the ring buffer.
      if (this.muted) return;
      try {
        ringBuffer.write(buf);
        // AFTER the ring write: the tracker's offsets are in the ring's own
        // coordinate system, so it needs the counter this chunk already moved.
        modeTracker.feed(data, ringBuffer.totalBytesWritten);
        oscParser.process(data);

        // Prompt-based CWD detection — fallback for shells WITHOUT the
        // integration hook only. Once OSC 7 has been seen (oscCwdSeen), the
        // scraper is permanently off for this session: the hook re-emits on
        // every prompt, so scraping can only ever add false positives.
        if (!this.oscCwdSeen) {
          promptBuffer += data;
          if (promptBuffer.length > 1024) promptBuffer = promptBuffer.slice(-512);

          const clean = promptBuffer.replace(DaemonPTYBridge.ANSI_STRIP, '');
          const detectedCwd = detectPromptCwd(clean);
          if (detectedCwd !== null) {
            if (detectedCwd !== lastDetectedCwd) {
              lastDetectedCwd = detectedCwd;
              this.emit('cwd', { sessionId, cwd: detectedCwd });
            }
            promptBuffer = '';
          }
        }

        this.emit('data', buf);
      } catch (err) {
        // Still forward raw data even if parsing failed
        this.emit('data', buf);
      }
    });
    this.dataDisposable = () => onDataDisposable.dispose();

    // PTY exit handler. Capture `signal` alongside exitCode: a clean shell
    // exit carries a numeric exitCode and no signal, whereas a killed process
    // reports the signal that killed it. That distinction is what the
    // silent-death investigation needs to tell "the shell exited on its own"
    // from "something killed it".
    //
    // A NULL exitCode with no signal is neither (#646). It is node-pty's
    // conout-socket-close path: the Windows agent's exit handler runs with
    // `_agent.exitCode === undefined` when the socket drops, and the shell may
    // well still be running. This comment used to call that shape the
    // involuntary-teardown signature, which contradicted the classifier in
    // shutdownKill.ts (only 0x40010004 / our own shutdown flag qualify) — and
    // the classifier is what runs, so null was treated as a voluntary exit and
    // buried a live shell. Consumers must not infer a death from a null code
    // alone; see phantomExit.ts for the liveness check that settles it.
    const onExitDisposable = ptyProcess.onExit(({ exitCode, signal }) => {
      this.emit('exit', { sessionId, exitCode, signal });
    });
    this.exitDisposable = () => onExitDisposable.dispose();
  }

  /**
   * Mute or unmute PTY output capture. While muted, the data handler
   * drops chunks; ringBuffer pre-fill from saved scrollback (set up by
   * the caller before forwarding starts) is preserved.
   */
  setMuted(muted: boolean): void {
    // Unmuting a recovered pane releases a full repaint at the new geometry,
    // and `noteResize` only stamps when the dimensions actually CHANGED — a
    // pane recovered at the size it was saved at gets the storm with no guard
    // behind it. Stamp the same guard here so that repaint cannot be read as
    // the agent starting a turn. Muted panes feed nothing, so the window is
    // empty and the storm would otherwise clear the threshold on its own.
    if (this.muted && !muted) this.lastResizeAtMs = Date.now();
    this.muted = muted;
  }

  /**
   * gate로 확정된 에이전트 표시명(없으면 null). daemon 프로세스 안의
   * AgentDetector가 배너를 직접 feed받아 설정하므로, main으로의 1회성
   * session:agent emit 전파(타이밍 race)와 무관하게 권위 있는 값을 준다.
   * renderer의 detection pull이 이 값을 직접 조회한다.
   */
  getLastAgent(): string | null {
    return this.agentDetector?.getLastAgent() ?? null;
  }

  /** Whether the bridge is currently dropping PTY output. */
  get isMuted(): boolean {
    return this.muted;
  }

  cleanup(): void {
    this.dataDisposable?.();
    this.dataDisposable = null;

    this.exitDisposable?.();
    this.exitDisposable = null;

    this.idleUnsubscribe?.();
    this.idleUnsubscribe = null;

    this.activeUnsubscribe?.();
    this.activeUnsubscribe = null;

    if (this.resizeGuardTimer) clearTimeout(this.resizeGuardTimer);
    this.resizeGuardTimer = null;

    // AgentDetector subscriptions: without explicit unsubscribe, recovered
    // sessions or repeated setupDataForwarding calls would accumulate
    // closure-captured callbacks against a stale `agentDetector` reference.
    // (Same leak class as the v2.7.2 PlaywrightEngine CDP session fix.)
    this.agentUnsubscribe?.();
    this.agentUnsubscribe = null;
    this.criticalUnsubscribe?.();
    this.criticalUnsubscribe = null;

    // Stop activity monitor to clear timers and state
    if (this.activityMonitor && this.sessionId) {
      this.activityMonitor.stop(this.sessionId);
    }

    this.lastEmittedOscCwd = null;
    this.explicitTerminalStatus = false;
    this.submittedTurnPending = false;
    this.inputInBracketedPaste = false;
    this.lastInputAt = 0;
    this.settledStatus = null;
    this.settledAtMs = 0;
    this.awaitingHuman = false;
    this.oscParser = null;
    this.modeTracker = null;
    this.agentDetector = null;
    this.activityMonitor = null;
    this.sessionId = null;

    this.removeAllListeners();
  }
}
