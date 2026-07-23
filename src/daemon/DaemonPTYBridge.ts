import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { OscParser } from '../main/pty/OscParser';
import { TerminalNotificationParser } from '../main/pty/oscNotification';
import { AgentDetector } from '../main/pty/AgentDetector';
import { ActivityMonitor } from '../main/pty/ActivityMonitor';
import { parseOsc7Cwd, detectPromptCwd } from '../main/pty/cwdDetect';
import { sanitizeTitle } from '../main/pty/titleDetect';
import { RingBuffer } from './RingBuffer';
import { PromptEventLog, parseOsc133Payload } from './PromptEventLog';
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
 *  - 'active'   → { sessionId: string }                — onActive cycle start
 *  - 'idle'     → { sessionId: string }                — onActiveToIdle
 *  - 'exit'     → { sessionId: string, exitCode, signal }
 */
export class DaemonPTYBridge extends EventEmitter {
  private oscParser: OscParser | null = null;
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

  /** Called by DaemonSessionManager.resizeSession on every applied resize. */
  noteResize(): void {
    this.lastResizeAtMs = Date.now();
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

    const agentDetector = new AgentDetector();
    this.agentDetector = agentDetector;

    this.sessionId = sessionId;

    const activityMonitor = new ActivityMonitor();
    this.activityMonitor = activityMonitor;
    activityMonitor.start(sessionId);

    // Activity → idle notification
    this.idleUnsubscribe = activityMonitor.onActiveToIdle((ptyId) => {
      this.emit('idle', { sessionId: ptyId });
    });
    // Activity → active notification (start of a sustained output burst).
    // Also resets AgentDetector emission dedup inside the daemon process so
    // turn N+1's idle prompt fires again even if its text is identical to
    // turn N. The reset MUST happen in-process: AgentDetector instances
    // live in the daemon, so the main-side DaemonNotificationRouter can't
    // reach into them the way local-mode PTYBridge does (Codex P1).
    this.activeUnsubscribe = activityMonitor.onActive((ptyId) => {
      // Resize-redraw guard (twin of PTYBridge local mode): a burst that
      // starts right after a resize is the TUI repainting at the new
      // geometry, not new agent activity — resetting the emission dedup
      // there re-fires the unchanged idle footer.
      //
      // onActive fires EXACTLY ONCE per active-to-idle cycle, so skipping
      // the reset outright (rather than deferring it) would permanently
      // skip it for the rest of THIS cycle too — if a genuinely new turn's
      // output continues into the same cycle (no 5s idle gap after the
      // repaint), its completion would never see a fresh dedup state and
      // would be silently deduped as a repeat (codex review catch, mirrors
      // the local-mode PTYBridge fix). Defer the reset to fire once the
      // guard window elapses instead of skipping it.
      const elapsed = Date.now() - this.lastResizeAtMs;
      if (elapsed < RESIZE_REDRAW_GUARD_MS) {
        if (this.resizeGuardTimer) clearTimeout(this.resizeGuardTimer);
        this.resizeGuardTimer = setTimeout(() => {
          this.resizeGuardTimer = null;
          this.agentDetector?.resetEmissionState();
        }, RESIZE_REDRAW_GUARD_MS - elapsed);
      } else {
        this.agentDetector?.resetEmissionState();
      }
      // Attach gate-confirmed agent name to active events. main's
      // DaemonNotificationRouter cannot reach the daemon AgentDetector directly,
      // but within the same daemon process getLastAgent() can. This ensures
      // agents whose idle prompt pattern is not detected (Claude Code v2.1.x etc.)
      // still get agentName filled while running.
      this.emit('active', { sessionId: ptyId, agentName: this.agentDetector?.getLastAgent() ?? undefined });
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

    // Agent detection
    this.agentUnsubscribe = agentDetector.onEvent((agentEvent) => {
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
      // AgentDetector is pure text analysis (no side effects) so it must run even
      // during muted intervals. Recovery sessions stay muted until first resize; if
      // an agent startup banner ("Claude Code vX" etc.) prints in that window, the
      // gate regex stays permanently disabled and all later status detection dies
      // (daemon mode agent detection gap). Only feed skips the muted check upfront;
      // ring buffer write·emit etc. remain muted-blocked to prevent geometry mismatch
      // contamination.
      try {
        agentDetector.feed(data);
      } catch {
        // detection failure must not block data forwarding.
      }

      // Muted: drop the chunk before any side effect. Recovery sessions
      // run muted until their first resize so the geometry mismatch
      // window (Bug 2 in v2.8.0) doesn't pollute the ring buffer.
      if (this.muted) return;
      try {
        const buf = Buffer.from(data);
        ringBuffer.write(buf);
        activityMonitor.feed(sessionId, buf.length);
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
        this.emit('data', Buffer.from(data));
      }
    });
    this.dataDisposable = () => onDataDisposable.dispose();

    // PTY exit handler. Capture `signal` alongside exitCode: a clean shell
    // exit carries a numeric exitCode and no signal, whereas a terminated
    // process (ConPTY torn down, killed) shows up as a signal or a null
    // exitCode. That distinction is what the silent-death investigation needs
    // to tell "the shell exited on its own" from "something killed it".
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
    this.muted = muted;
  }

  /**
   * Gate-confirmed agent display name (null if none). AgentDetector inside the
   * daemon process receives banner feed directly, so this is authoritative regardless
   * of one-shot session:agent emit propagation to main (timing race). Renderer
   * detection pull queries this value directly.
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
    this.oscParser = null;
    this.agentDetector = null;
    this.activityMonitor = null;
    this.sessionId = null;

    this.removeAllListeners();
  }
}
