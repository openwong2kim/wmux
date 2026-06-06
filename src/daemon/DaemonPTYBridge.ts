import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { OscParser } from '../main/pty/OscParser';
import { AgentDetector } from '../main/pty/AgentDetector';
import { ActivityMonitor } from '../main/pty/ActivityMonitor';
import { parseOsc7Cwd, detectPromptCwd } from '../main/pty/cwdDetect';
import { RingBuffer } from './RingBuffer';
import { PromptEventLog, parseOsc133Payload } from './PromptEventLog';

/**
 * Daemon version of PTYBridge.
 * Replaces BrowserWindow IPC with EventEmitter events.
 *
 * Events:
 *  - 'data'     → Buffer (raw PTY output)
 *  - 'cwd'      → { sessionId: string, cwd: string }
 *  - 'agent'    → { sessionId: string, event: AgentEvent }
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
      this.agentDetector?.resetEmissionState();
      this.emit('active', { sessionId: ptyId });
    });

    // OSC events → cwd (OSC 7) and prompt/command markers (OSC 133)
    oscParser.onOsc((event) => {
      if (event.code === 7) {
        const cwd = parseOsc7Cwd(event.data);
        this.emit('cwd', { sessionId, cwd });
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
      // Muted: drop the chunk before any side effect. Recovery sessions
      // run muted until their first resize so the geometry mismatch
      // window (Bug 2 in v2.8.0) doesn't pollute the ring buffer.
      if (this.muted) return;
      try {
        const buf = Buffer.from(data);
        ringBuffer.write(buf);
        activityMonitor.feed(sessionId, buf.length);
        oscParser.process(data);
        agentDetector.feed(data);

        // Prompt-based CWD detection
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

    this.oscParser = null;
    this.agentDetector = null;
    this.activityMonitor = null;
    this.sessionId = null;

    this.removeAllListeners();
  }
}
