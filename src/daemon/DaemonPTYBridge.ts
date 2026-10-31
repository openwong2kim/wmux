import type { NativeOutputChunk } from '../shared/nativeTerminalCore';
import type { TerminalPty } from '../shared/terminalPty';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { IPty } from 'node-pty';
import type { AgentStatus } from '../shared/types';
import { OutputInterpreter, type OutputModes } from './OutputInterpreter';
import { TerminalNotificationParser } from '../main/pty/oscNotification';
import { AgentDetector, drawsCodexBanner, type AgentEventStatus } from '../main/pty/AgentDetector';
import { ActivityMonitor } from '../main/pty/ActivityMonitor';
import { parseOsc7Cwd, detectPromptCwd } from '../main/pty/cwdDetect';
import { ClaudeTitleTurnEdge, sanitizeTitle } from '../main/pty/titleDetect';
import { RingBuffer } from './RingBuffer';
import { PromptEventLog, parseOsc133Payload } from './PromptEventLog';
import { ESC_INTERRUPT_CONFIRM_MS, RESIZE_REDRAW_GUARD_MS } from '../main/notification/idleSuppression';
import { stripReplayQuerySequences } from '../shared/replayQuerySanitizer';
import { isFreshSessionSource } from '../shared/hooks/signal-types';
import { ESCAPE_WIN32 } from '../shared/win32InputKeys';
import { isEscapeChunk } from '../shared/hooks/interruptKeystroke';
import { stripPassiveInput } from '../shared/terminal/passiveInput';
import { ShellMarkIngress } from '../shared/terminal/shellMarkIngress';
import { kittyChunkAsLegacy } from '../shared/kittyKeyEvents';
import { titleShowsFinishedTurn, titleShowsRunningTurn } from './transcript/chatScreenGate';
import { AWAITING_TITLE, CLAUDE_IDLE_TITLE, CLAUDE_RUNNING_TITLE, CLAUDE_RUNNING_TITLE_OSC, RUNNING_TITLE } from '../shared/agentTitleRules';
import { agentDisplayToSlug, agentRow, isAgentSlug } from '../shared/agentIdentity';
import type { AgentSignal } from '../shared/hooks/signal-types';
import { canSeedHookIdentity, DETECTOR_IDENTITY_HOOK_MAX_AGE_MS } from '../shared/hooks/detectorIdentity';
import type { CanonicalAgentIdentity } from './canonicalAgent';
import type { TurnFailure } from '../shared/phoneTurnFailure';
import type { ApprovalScreenReader } from '../shared/approvalScreen';
import { PROGRAM_STATUS_OSC, ProgramStatusStore, parseProgramStatus, type ProgramStatusRecord } from './programStatus';

/**
 * #1965 — the answer the daemon gives the bundled OpenConsole's startup DA1.
 * The same string the desk renderer's xterm sends with inline images on
 * (sixel, `4`). OpenConsole does not read it — sixel passes through with or
 * without the `4`, and with no answer at all — it only waits for one.
 */
export const STARTUP_DA1_REPLY = '\x1b[?62;4;9;22c';

/**
 * How many bytes of escape-only output the startup DA1 scan buffers while
 * waiting for a sequence split across chunks. OpenConsole's own preamble in
 * front of its query is 4 bytes (`CSI 1 t`).
 */
const STARTUP_DA1_SCAN_BYTES = 64;

// eslint-disable-next-line no-control-regex
const CSI_SEQUENCE = /^\x1b\[[0-?]*[ -/]*[@-~]/;
// eslint-disable-next-line no-control-regex
const CSI_PARTIAL = /^\x1b(?:\[[0-?]*[ -/]*)?$/;

/**
 * Classify the first bytes a PTY wrote. `'answer'`: a bare DA1 (`CSI c`) came
 * before any byte that was not part of a CSI sequence. `'closed'`: something
 * else came first, so whatever follows is the program's, not the pseudo
 * console's. `'more'`: only CSI sequences so far, possibly one cut short.
 */
export function scanStartupDa1(text: string): 'answer' | 'more' | 'closed' {
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const m = CSI_SEQUENCE.exec(rest);
    if (!m) return CSI_PARTIAL.test(rest) ? 'more' : 'closed';
    if (m[0] === '\x1b[c') return 'answer';
    i += m[0].length;
  }
  return 'more';
}

/** The `agent` event message for an OSC 7501 `blocked` report, by its `kind`. */
const PROGRAM_BLOCKED_MESSAGE: Record<'permission' | 'question' | 'auth' | 'none', string> = {
  permission: 'Approval requested',
  question: 'Question asked',
  auth: 'Sign-in required',
  none: 'Waiting on you',
};

/** The `agent` event message for an OSC 7501 settle. Never the program's own `msg`. */
const PROGRAM_SETTLED_MESSAGE: Record<'idle' | 'done' | 'error', string> = {
  idle: 'Ready for input',
  done: 'Task complete',
  error: 'Turn ended',
};

/**
 * Daemon version of PTYBridge.
 * Replaces BrowserWindow IPC with EventEmitter events.
 *
 * Events:
 *  - 'data'     → Buffer (raw PTY output)
 *  - 'outputActivity' → no payload (unmuted output, no byte copy required)
 *  - 'cwd'      → { sessionId: string, cwd: string }
 *  - 'agent'    → { sessionId: string, event: AgentEvent }
 *  - 'notification' → { sessionId, event: TerminalNotification & { ts } }
 *  - 'critical' → { sessionId: string, event: CriticalEvent }
 *  - 'usageLimit' → { sessionId: string, event: UsageLimitLineEvent }
 *  - 'turnInterrupted' → { sessionId: string, agent: string } — the agent
 *                 printed its own "turn interrupted" row (not inside a
 *                 resize redraw or a muted replay)
 *  - 'inputSubmitted' → { sessionId: string } (input with a submit boundary)
 *  - 'active'   → { sessionId, agentName?, likelyRepaint? } — onActive cycle
 *                 start. A passive burst inside the resize-redraw guard
 *                 window is not emitted, except a cycle a hook's running
 *                 edge armed in a still-open turn: that one carries
 *                 likelyRepaint (alarm feeds must ignore it)
 *  - 'idle'     → { sessionId, preTurn? }              — onActiveToIdle;
 *                 preTurn marks silence after a SessionStart with no turn
 *                 started since (see isPreTurn)
 *  - 'exit'     → { sessionId: string, exitCode, signal }
 *  - 'answered' → { sessionId, reason: 'input' | 'screen-cleared' } — the
 *                 dialog the pane was blocked on closed
 *  - 'awaitingActivity' → { sessionId, cause: 'input' | 'output', ... } —
 *                 stdin or output while the pane is blocked on a human
 *  - 'fenceInput' → { sessionId } — a key, click, release or wheel reached stdin
 *  - 'typedInput' → { sessionId } — a key (not a mouse report) reached stdin;
 *                 at most once per TYPED_INPUT_THROTTLE_MS. Workspace settle
 *                 reads it as "someone is using this pane".
 *  - 'resize'   → (no payload) — an applied geometry change; consumers read the
 *                 new size from the session's own meta.
 *  - 'agentTurn' → { sessionId, runningSince: number | null } — the pane's
 *                 agent started (epoch ms of the episode's start) or stopped
 *                 being mid-turn; see isAgentMidTurn. Edges only.
 */
/** How long an open episode must stay without a transcript turn before noteNoTranscriptTurn closes it. */
const NO_TRANSCRIPT_TURN_GRACE_MS = 2_000;

/**
 * A held tail's bytes, oldest first. Once it has dropped some, its oldest kept
 * byte may be inside a sequence, so it then starts at its first line or
 * escape sequence, whichever comes first; `lost` counts every byte before.
 */
function tailBytes(tail: RingBuffer | null): { bytes: Buffer; lost: number } {
  const data = tail?.readAll() ?? Buffer.alloc(0);
  const lost = (tail?.totalBytesWritten ?? 0) - data.length;
  if (lost === 0) return { bytes: data, lost: 0 };
  const lf = data.indexOf(0x0a);
  const esc = data.indexOf(0x1b);
  const cut = Math.min(lf === -1 ? data.length : lf + 1, esc === -1 ? data.length : esc);
  return { bytes: data.subarray(cut), lost: lost + cut };
}

export class DaemonPTYBridge extends EventEmitter {
  private outputInterpreter: OutputInterpreter | null = null;
  private modeTracker: OutputModes | null = null;
  private agentDetector: AgentDetector | null = null;
  private approvalScreenReader: ApprovalScreenReader | null = null;
  private activityMonitor: ActivityMonitor | null = null;
  private dataDisposable: (() => void) | null = null;
  private exitDisposable: (() => void) | null = null;
  private idleUnsubscribe: (() => void) | null = null;
  private activeUnsubscribe: (() => void) | null = null;
  private agentUnsubscribe: (() => void) | null = null;
  private criticalUnsubscribe: (() => void) | null = null;
  private usageLimitUnsubscribe: (() => void) | null = null;
  private interruptedUnsubscribe: (() => void) | null = null;
  /** See noteInput: typed or pasted composer text not yet submitted. */
  private draftPending = false;
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
   * #1464: output that arrived while muted, kept so `setMuted(false,
   * { replayHeld: true })` can release it. A recovered shell prints its first
   * prompt while still muted; when the renderer's first resize keeps the saved
   * geometry no SIGWINCH follows, so the shell never repaints and a dropped
   * prompt leaves the pane blank until a key is pressed. `null` = not holding.
   *
   * Bounded by keeping the HEAD: once the cap is reached later chunks are not
   * held for the unmute (`heldFull`), but what was held stays — the shell's prompt, or a
   * TUI's first frame, is printed first, so it is the part worth keeping.
   */
  private heldWhileMuted: string[] | null = null;
  private heldBytes = 0;
  private heldFull = false;
  private static readonly MAX_HELD_BYTES = 256 * 1024;
  /**
   * #2855: the output that arrived after the head filled, its newest
   * MAX_HELD_TAIL_BYTES kept, so a screen read (heldOutput) still sees the
   * live screen, and the unmute releases it after the head: an unmute at the
   * same size brings no repaint, and the head alone would leave the pane
   * showing the start of the output, not the screen the program last drew.
   * Created at the first chunk past the head; a quarter of the 8 MB session
   * ring the same output would fill unmuted, and that ring takes nothing
   * while muted.
   */
  private heldTail: RingBuffer | null = null;
  private static readonly MAX_HELD_TAIL_BYTES = 2 * 1024 * 1024;
  /** The unmuted capture path, set by setupDataForwarding; replays held chunks. */
  private captureChunk: ((data: string, buf: Buffer) => void) | null = null;

  /** See armStartupDa1Reply. Null once the startup window has closed. */
  private startupDa1: {
    scanned: string;
    canAnswer: () => boolean;
    onAnswered?: () => void;
  } | null = null;

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
   * A WSL distro's shell names the distro's own hostname in OSC 7, which can
   * differ from this machine's (wsl.conf), so its reports skip the host check.
   * The path rules still apply.
   */
  private wslDistro = false;

  /** Last cwd emitted by the prompt-scrape fallback (shells without OSC 7). */
  private lastDetectedPromptCwd = '';

  /**
   * A detector/hook terminal state (waiting, complete, awaiting input, error)
   * outranks passive byte throughput until a real submitted-input boundary
   * starts the next turn. This prevents a full-screen idle redraw from
   * resurrecting stale `running` metadata.
   */
  private explicitTerminalStatus = false;
  private submittedTurnPending = false;
  /** The current activity cycle was armed by a hook's running edge and has not fired yet. */
  private hookArmedCycle = false;
  private lastTurnStartedAt = 0;

  /**
   * Running-episode id (phone chat `turn.id`). A new episode opens only on a
   * settled/idle -> running transition: a submit while the pane is not running,
   * or the first running edge (hook or byte promotion) after the last one
   * closed. Answering a dialog and a submit typed into a running turn (the
   * agent's own composer queue) stay in the episode. `turnNonce` keeps ids from
   * a previous daemon or PTY lifetime from ever comparing equal to a new one.
   */
  private readonly turnNonce = randomBytes(6).toString('hex');
  private turnSeq = 0;
  private turnOpen = false;
  private turnOpenedAt = 0;
  /** When the episode before the current one opened (0 = none). */
  private prevTurnOpenedAt = 0;
  /**
   * The typed failure of the last turn (phone contract v-next item 1), and the
   * agent conversation it happened in. Lives until the next episode opens (a
   * new `turnSeq`): a queued phone send that has not reached the PTY keeps it.
   */
  private lastFailure: { failure: TurnFailure; agentSessionId?: string } | null = null;
  /** An authoritative hook has reported on this pane: only hooks and the transcript end its episodes. */
  private hookSeen = false;
  /**
   * The pane's agent reports its own state (OSC 7501, see noteProgramStatus):
   * its root record drives the turn, and the title and byte heuristics only
   * fill in where it agrees. Reset when the agent ends, like `hookSeen`.
   */
  private programStatusSeen = false;
  /** The tracked agent the program's reports were accepted for. */
  private programAgentSlug: string | null = null;
  /** Hands a silent `working` pane back to the heuristics (see armProgramQuietCheck). */
  private programQuietTimer: ReturnType<typeof setTimeout> | null = null;
  /** No output and no report for this long while `working`: the program is hung, not working. */
  private static readonly PROGRAM_WORKING_QUIET_MS = 5 * 60_000;
  /** How long after a submit a repeated settle report is read as crossing it (applyProgramState). */
  private static readonly PROGRAM_REPEAT_GRACE_MS = 2_000;
  /** When the PTY last wrote anything, muted or not (0 = never). */
  private lastOutputAt = 0;
  /**
   * When the program's current root state was last applied (0 = never). A
   * repeat skipped inside the submit grace leaves it, so the turn the submit
   * opened is still read as one the program has not reported on.
   */
  private programStateAt = 0;
  /** When a submit that carried a prompt last reached the pane (0 = never). */
  private promptSubmittedAt = 0;
  /** When the program's last episode ended (endProgramStatusEpisode); older records are history. */
  private programEpisodeEndAt = 0;
  /** OSC 7501 records of this terminal (root and child ids). */
  private readonly programStatus = new ProgramStatusStore();
  /** The last output chunk ended in ESC: a RIS (`ESC c`) may straddle chunks. */
  private outputEndsWithEsc = false;
  /**
   * The episode was closed by a detector settle only. That read can be wrong
   * mid-turn (a pause between tools on an agent whose hooks have not spoken
   * yet), so the next running edge that is not a submit resumes the same
   * episode instead of starting another. A submit, a hook settle, a recorded
   * transcript end or the agent ending makes the close final.
   */
  private turnSoftClosed = false;
  /** #2673 — when a submit that carried a prompt last reached Claude Code (0 = never). */
  private claudePromptAt = 0;
  /** #2673 — when Claude Code last set its running title `◐`/`◑` (0 = never). */
  private claudeRunningTitleAt = 0;
  /**
   * F24 — the open episode was opened by output alone (a byte promotion) on a
   * pane whose hooks report, and no hook or submit has confirmed it since.
   * Such a pane says when its turns end, and Claude Code's own post-turn
   * paints (the idle recap, a repaint when a viewer attaches) fire no hook:
   * an episode they opened would never close. So until a hook confirms it,
   * the episode ends like a hook-less pane's does (a detector settle), and
   * also when its output goes quiet: a real turn keeps painting its spinner.
   */
  private byteOpenedTurn = false;
  /**
   * #1670 — the episode was opened while the boot window was open (a program
   * launched, no submit or hook since), by a byte promotion or by the first
   * Enter: the TUI painting itself or a dialog answered, or a real first turn.
   * A running hook, or a submit joining it while it runs, proves a turn; until
   * then a submit that finds no running turn on the title replaces it (see
   * `startAnsweredTurn`).
   */
  private bootEpisode = false;
  /** The last `isAgentMidTurn` value reported through 'agentTurn'. */
  private reportedMidTurn = false;

  /**
   * Reads the pane's transcript for the latest recorded turn end (epoch ms),
   * or undefined. Installed once by the daemon; consulted on a submit while an
   * episode is open, because an interrupt fires no Stop hook and nothing else
   * would have closed it.
   */
  static transcriptTurnEndProbe: ((sessionId: string) => number | undefined) | null = null;

  /** Last write to stdin that was a lone Esc, from any source (0 = never). */
  private lastEscAt = 0;
  /** The `lastEscAt` an idle title already reported as an interrupt (#2264). */
  private titleEdgeEscAt = 0;
  /** Latest OSC 0/2 window title (sanitized) and when it arrived (0 = never). */
  private lastTitle = '';
  private lastTitleAt = 0;
  /** When `active` was last emitted (0 = never); see noteCodexTitleSpinner. */
  private lastActiveAt = 0;
  /** #1463 — a session started and no turn has since (see isPreTurn). */
  private preTurn = false;
  /** #1463 — arrival time of the last turn evidence: submitted input, an
   *  answer, or any hook other than SessionStart. A SessionStart that FIRED
   *  before it (a late or retried delivery) says nothing about now. */
  private turnEvidenceAt = 0;
  /** #1610 — a program launched and no turn evidence since (see noteCodexOutput). */
  private codexBootWindow = false;
  private codexBannerTail = '';
  private static readonly CODEX_BANNER_TAIL = 512;
  /**
   * The pane's agent process as the daemon's process tracker last reported
   * it (see noteAgentProcess), or null before any report. The detector's last
   * agent outlives the agent; this is the process truth the title path reads.
   */
  private trackedAgent: { slug?: string; alive: boolean } | null = null;
  /** This bridge's PTY lifetime; old async evidence cannot seed a replacement. */
  private identityLifetimeAt = 0;

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
  /** Monotonic stdin write counter used to detect input racing a scheduled paste. */
  private inputRevision = 0;
  /**
   * Like `inputRevision`, but advanced only by writes that could act on the
   * screen: a key, a mouse click, a release, a wheel turn. A chunk made purely
   * of pointer MOTION reports and focus in/out reports does not count. The
   * remote terminal-prompt answer fences on it — the pointer drifting over the
   * pane is not someone answering the dialog, but a click may be.
   */
  private keyInputRevision = 0;
  /** When `keyInputRevision` last moved (#1680): `isKeyInputQuiet` reads it so
   *  a pointer drifting over the pane does not read as someone typing. */
  private lastKeyInputAt = 0;
  private emptyShellPrompt = false;
  private completedShellCommand = false;
  private shellCommandRunning = false;
  /** #2673 — the shell has drawn an OSC 133 prompt: `shellCommandRunning` then says whether a program, not the shell, owns the keys. */
  private shellPromptSeen = false;
  private shellSubmittedKeyRevision: number | undefined;
  private shellCommandKeyRevision = 0;
  /** The shell command that ended last, until the next one starts: the key
   *  revision it started from, the one it ended at, and whether a prompt was
   *  drawn since (rebaseShellKeyInput). */
  private endedShellCommand: { keyRevision: number; endedAt: number; prompted: boolean } | null = null;
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
  /** #1463 — the hook fire time (`AgentSignal.ts`) of the AskUserQuestion that
   *  put this pane in `awaitingHuman`; null when anything else did (a
   *  permission dialog, a detector match). Only such a question may be
   *  released by the agent's own "answered" signal — see
   *  `clearAnsweredQuestion`. */
  private awaitingQuestionAt: number | null = null;

  /** Track bracketed-paste input so newlines inside a pasted draft are not
   * mistaken for Enter. The closing marker and the later CR are separate writes
   * in the normal renderer path; only that CR starts a turn. */
  private inputInBracketedPaste = false;
  private static readonly BRACKETED_PASTE_START = '\x1b[200~';
  private static readonly BRACKETED_PASTE_END = '\x1b[201~';

  /** Called by DaemonSessionManager.resizeSession on every applied resize. */
  noteResize(): void {
    this.agentDetector?.invalidateApprovalScreen();
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
  get outputModes(): OutputModes | null {
    return this.modeTracker;
  }

  /**
   * Observe bytes successfully written to PTY stdin. A CR/LF outside bracketed
   * paste is a submitted turn; callers that send an immediate TUI choice
   * (approval digit/ESC) pass `forceSubmitted=true` because those controls do
   * not include Enter but still resume the blocked turn.
   */
  noteInput(data: string, forceSubmitted?: boolean): void;
  /**
   * `selfWrite`: a key the stepwise approval driver typed. It moves the key
   * revision like any key and returns the new revision, so the driver can
   * record it synchronously and tell its own keys from a human's. It is not a
   * human acting: no `fenceInput` (the pending record is not refreshed), no
   * "answered", no submit — the driver calls `noteSubmitted` after its last key.
   */
  noteInput(data: string, opts: { selfWrite: true }): number;
  noteInput(data: string, opts: boolean | { selfWrite: true } = false): void | number {
    if (typeof opts === 'object') {
      if (data.length > 0) {
        this.agentDetector?.invalidateApprovalScreen();
        this.lastInputAt = Date.now();
        this.inputRevision += 1;
        this.keyInputRevision += 1;
        this.lastKeyInputAt = this.lastInputAt;
        this.emptyShellPrompt = false;
        this.completedShellCommand = false;
      }
      return this.keyInputRevision;
    }
    const forceSubmitted = opts;
    // Kitty-encoded keys (a pane that pushed the protocol) are read as the
    // legacy bytes the checks below match; a key release is not input at all.
    // Only this accounting changes, the PTY already has the real bytes.
    if (data.length > 0) {
      data = kittyChunkAsLegacy(data);
      if (data.length === 0) return;
    }
    // Stamped for EVERY write, including the ordinary keystrokes that fall out
    // below. Output that arrives while the user is still typing is the TUI
    // echoing them, and echo must never be mistaken for the agent working —
    // see the settled branch in setupDataForwarding's data handler.
    if (data.length > 0) {
      this.lastInputAt = Date.now();
      this.inputRevision += 1;
      const active = stripPassiveInput(data);
      if (active.length > 0) this.agentDetector?.invalidateApprovalScreen();
      // Every path that types into a pane ends here (pipe, web raw input, chat
      // Stop, approval keys), so this is the one place a lone Esc is seen.
      // Inside a bracketed paste an ESC is text, not a key. On Windows the
      // approval answers write Esc as a win32-input-mode record (#1915).
      if ((active === '\x1b' || active === ESCAPE_WIN32) && !this.inputInBracketedPaste) this.lastEscAt = this.lastInputAt;
      if (active.length > 0) {
        this.keyInputRevision += 1;
        this.lastKeyInputAt = this.lastInputAt;
        // Sizes nothing, carries nothing: a remote terminal-prompt answer that
        // a key or click has overtaken is refreshed off this.
        if (this.sessionId) this.emit('fenceInput', { sessionId: this.sessionId });
        this.noteTyped(active);
        // Only a key can put text on the prompt line. A terminal's replies
        // (ConPTY's startup queries) and focus reports cannot, and a focus
        // change (Alt-Tab) used to leave an untouched prompt reading as used.
        this.emptyShellPrompt = false;
        this.completedShellCommand = false;
      }
    }

    // A pane blocked on a human is answered by a lone option digit or a lone
    // ESC as well as by Enter: Claude Code's permission dialog takes `1`/`2`/`3`
    // and ESC without a CR. Arrow keys (`ESC [ A`) move the selection and are
    // not an answer; a paste is never one.
    //
    // The input stream is unframed, so with mouse reporting on (`?1003h` /
    // `?1006h`) the digit can arrive glued to SGR mouse reports, and a focus
    // change adds `ESC [ I` / `ESC [ O`. Neither is a keystroke, so both are
    // stripped before the lone-key test.
    //
    // ESC counts in every encoding wmux writes (#1901): on Windows the bare
    // byte can leave the AskUserQuestion picker up (#1915), so whatever really
    // cancels it arrives as a win32-input-mode record pair. No hook reports a
    // cancelled question, and on a narrow grid the screen verifier holds the
    // pane while the question's record is pending, so an unrecognised cancel
    // left the pane at Needs you until the next prompt.
    const wasAwaiting = this.awaitingHuman;
    const keyProbe = wasAwaiting ? data.replace(DaemonPTYBridge.NON_KEY_INPUT, '') : data;
    const answerKey = wasAwaiting && !this.inputInBracketedPaste
      && (/^[1-9]$/.test(keyProbe) || isEscapeChunk(keyProbe));
    // A single letter into a box the agent's title holds open (Codex's y / p /
    // n): it went to the box, not the composer.
    const titleDialogKey = wasAwaiting && this.titleRaisedAwaiting && !this.inputInBracketedPaste
      && /^[a-z]$/i.test(keyProbe);
    const hasSubmitBoundary = this.scanSubmittedInput(data);
    const answered = forceSubmitted || hasSubmitBoundary || answerKey;
    // #2673: a submit that carried a prompt, not a bare Enter (a dialog's answer).
    const promptSubmitted = (forceSubmitted || hasSubmitBoundary) && !wasAwaiting
      && (forceSubmitted || this.draftPending || DaemonPTYBridge.typesDraftText(data));
    // An unsubmitted draft in the composer: typed or pasted text with no Enter
    // after it. Ctrl+C / Ctrl+U empty the composer. Read by the usage-limit
    // continue, which must never append to (and submit) a human's half-typed line.
    // eslint-disable-next-line no-control-regex
    const clearsComposer = /[\x03\x15]/.test(data);
    if (forceSubmitted || hasSubmitBoundary) {
      if (!this.shellCommandRunning) {
        // A single write can contain Enter followed by queued history/draft
        // input. One chunk revision cannot distinguish those trailing bytes.
        this.shellSubmittedKeyRevision = /^[^\r\n]*[\r\n]$/.test(data) ? this.keyInputRevision : -1;
      }
      this.draftPending = false;
      if (this.sessionId) this.emit('inputSubmitted', { sessionId: this.sessionId });
    } else if (clearsComposer) {
      this.draftPending = false;
    } else if (!answerKey && !titleDialogKey && DaemonPTYBridge.typesDraftText(data)) {
      // Not for a lone digit that answered a dialog: it went to the dialog,
      // not the composer. Counting it left a phantom draft that no Enter ever
      // followed, so every later hand-off into the idle pane was refused as
      // user_typing.
      this.draftPending = true;
    }
    // Input that reached a pane still blocked on a human. Carries sizes only,
    // never the text: the daemon logs it (to see what an unrecognised answer
    // looked like) and uses it to schedule a screen check.
    if (wasAwaiting && data.length > 0 && this.sessionId) {
      this.emit('awaitingActivity', {
        sessionId: this.sessionId,
        cause: 'input',
        bytes: data.length,
        nonKeyBytes: data.length - keyProbe.length,
        answered,
      });
    }
    if (!answered) return;
    this.startAnsweredTurn(wasAwaiting, 'input', promptSubmitted);
  }

  /**
   * The dialog this pane was blocked on is gone, although no answer key was
   * seen (the screen verifier read the pane and found no dialog on it twice,
   * or the agent's title stopped showing it: noteTitleAwaitingHuman).
   * Runs exactly the path a recognised answer key runs. Returns false, and
   * does nothing, when the pane was not awaiting.
   */
  clearAwaiting(reason: 'screen-cleared'): boolean {
    if (!this.awaitingHuman) return false;
    this.startAnsweredTurn(true, reason);
    return true;
  }

  /**
   * #1463 — the agent's own hook reported an AskUserQuestion answered (fired
   * at `answeredAt`, the hook's `AgentSignal.ts`). Releases the pane through
   * the answer-key path, but only when what it is blocked on is a question
   * asked no later than that: a late or duplicate answer must not release a
   * NEWER question, nor a permission dialog that went up in between.
   */
  clearAnsweredQuestion(answeredAt: number): boolean {
    if (!this.awaitingHuman || this.awaitingQuestionAt === null) return false;
    if (answeredAt < this.awaitingQuestionAt) return false;
    this.startAnsweredTurn(true, 'input');
    return true;
  }

  /**
   * The stepwise approval driver typed its last key (see `noteInput`
   * `selfWrite`): the dialog is answered and the turn resumes, exactly as a
   * recognised answer key would have done it.
   */
  noteSubmitted(): void {
    this.startAnsweredTurn(this.awaitingHuman, 'input');
  }

  /** Whether the pane is blocked on a human right now. */
  isAwaitingHuman(): boolean {
    return this.awaitingHuman;
  }

  /**
   * A submitted input, or an answer to the dialog the pane was blocked on,
   * starts the next turn. The one path both `noteInput` and `clearAwaiting`
   * take, so an answer recognised from a key and one recognised from the
   * screen leave the bridge in the same state.
   */
  private startAnsweredTurn(wasAwaiting: boolean, reason: 'input' | 'screen-cleared', promptSubmitted = false): void {
    // An answer resumes the episode it interrupted; a submit into a running
    // turn is queued by the agent's own composer. Anything else starts one.
    if (!wasAwaiting) {
      // #1670 — an episode opened at boot (by the boot burst, or by the first
      // Enter after a launch, which may only have answered a dialog the
      // detector does not see, such as Codex's folder-trust prompt) is not a
      // turn unless the agent shows one running (a first turn started from
      // the command line, or the first prompt still working). Otherwise the
      // next submit starts the turn, so a key sent before it (a lone Esc
      // dismissing a notice) is never read as an interrupt of that turn.
      if (this.turnOpen && this.bootEpisode && !this.titleShowsRunningTurn()) this.closeTurn();
      if (this.turnOpen && this.sessionId) {
        const endedAt = DaemonPTYBridge.transcriptTurnEndProbe?.(this.sessionId);
        if (endedAt !== undefined) this.noteTranscriptTurnEnd(endedAt);
      }
      // Still open = no settle and no recorded end since it began: a prompt
      // typed into the running turn, however long the turn has been quiet.
      const joined = this.turnOpen;
      this.turnSoftClosed = false;
      this.openTurn();
      if (joined) this.bootEpisode = false;
      // A prompt typed into Claude Code itself, not a dialog's bare Enter, nor
      // the launch line the shell ran: the shell at its own OSC 133 prompt
      // owns the keys there, whatever the tracker still reads alive.
      const atShellPrompt = this.shellPromptSeen && !this.shellCommandRunning;
      if (promptSubmitted && !atShellPrompt && this.paneAgentTitlesTurns()) this.claudePromptAt = Date.now();
      if (promptSubmitted && !atShellPrompt) this.promptSubmittedAt = Date.now();
    } else if (this.turnSoftClosed) {
      // Answering a dialog resumes the episode it interrupted, even one a
      // detector settle closed softly before the dialog went up.
      this.openTurn(true);
    }
    // A submit, or a human answering the agent's dialog: a turn either way.
    this.byteOpenedTurn = false;
    // An answer resumes the episode it interrupted, so who opened it stands:
    // a turn the spinner opened is still ended by its frame dropping.
    if (!wasAwaiting) this.spinnerOpenedTurn = false;
    this.lastTurnStartedAt = Date.now();
    this.preTurn = false;
    this.codexBootWindow = false;
    this.turnEvidenceAt = this.lastTurnStartedAt;

    this.explicitTerminalStatus = false;
    this.settledStatus = null;
    this.awaitingHuman = false;
    this.submittedTurnPending = true;
    if (this.resizeGuardTimer) {
      clearTimeout(this.resizeGuardTimer);
      this.resizeGuardTimer = null;
    }
    this.spinnerArmedCycle = false;
    this.agentDetector?.resetEmissionState();
    if (this.activityMonitor && this.sessionId) {
      this.activityMonitor.beginTurn(this.sessionId);
    }
    // The dialog is closed. On a hook-governed pane bytes cannot relight the
    // status (main mutes the byte heuristic while the turn latch is held), so
    // the daemon broadcasts `running` and cancels a still-held awaiting window.
    if (wasAwaiting && this.sessionId) this.emit('answered', { sessionId: this.sessionId, reason });
    this.reportMidTurn();
  }

  /** SGR mouse reports and focus in/out reports: terminal input that is not a key. */
  // eslint-disable-next-line no-control-regex
  private static readonly NON_KEY_INPUT = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[IO]/g;
  /** Whether input carries composer text: printable characters once control
   *  bytes, escape sequences and the paste brackets are removed. */
  private static typesDraftText(data: string): boolean {
    // eslint-disable-next-line no-control-regex
    const text = data.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1bO.|\x1b[\]P_^][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b./g, '').replace(/[\x00-\x1f\x7f]/g, '');
    return text.length > 0;
  }

  /** Whether the composer holds a typed but unsubmitted draft. */
  hasDraft(): boolean {
    return this.draftPending;
  }

  /** Every mouse report: SGR (press, release, wheel, motion) and X10. */
  // eslint-disable-next-line no-control-regex -- terminal mouse reports contain ESC bytes
  private static readonly ANY_MOUSE = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}/g;
  static readonly TYPED_INPUT_THROTTLE_MS = 30_000;
  private typedInputAt = -Infinity;

  /** `active` is already free of passive input; a key is anything but a mouse report. */
  private noteTyped(active: string): void {
    if (!this.sessionId || active.replace(DaemonPTYBridge.ANY_MOUSE, '').length === 0) return;
    const now = Date.now();
    if (now - this.typedInputAt < DaemonPTYBridge.TYPED_INPUT_THROTTLE_MS) return;
    this.typedInputAt = now;
    this.emit('typedInput', { sessionId: this.sessionId });
  }

  /**
   * Apply an authoritative detector/hook lifecycle edge inside the daemon.
   * Terminal states settle the turn and block later byte-only redraws;
   * explicit running activity opens the gate again for autonomous work.
   * `source: 'program'` is the agent's own OSC 7501 report (applyProgramState):
   * it opens and closes the episode itself. While such reports drive the pane,
   * a screen read (detector, title) may still raise a dialog but no longer
   * settles or runs the turn.
   */
  noteAgentStatus(status: AgentEventStatus, authoritative = false, questionAt?: number, provisional = false, signalTs?: number, source?: 'program'): void {
    const program = source === 'program';
    if (!authoritative && !program && this.programMutesScreen(status)) return;
    this.spinnerArmedCycle = false;
    if (authoritative) this.spinnerOpenedTurn = false;
    // #1463 — any hook is turn evidence. SessionStart re-sets `preTurn` after
    // its own edge (noteSessionStart); detector statuses are not evidence.
    if (authoritative) {
      this.preTurn = false;
      this.codexBootWindow = false;
      this.turnEvidenceAt = Date.now();
    }
    if (status === 'running') {
      if (authoritative) {
        this.hookSeen = true;
        this.lastTurnStartedAt = Date.now();
        // The first hook after a settle is an autonomous turn; later hooks, and
        // any hook behind an unanswered dialog, belong to the open episode.
        // A hook-opened episode starts when the hook fired, not when it
        // arrived: `turnAt` compares a later hook's own timestamp against it.
        if (!this.awaitingHuman) this.openTurn(true, signalTs);
        // The agent's own hook: whatever opened the episode, it is a turn.
        this.bootEpisode = false;
        this.byteOpenedTurn = false;
      } else if (program) {
        // The program says it is working: the episode is its own, so neither
        // byte silence nor a running title dropping may end it.
        if (!this.awaitingHuman) this.openTurn(true);
        // #1670 keeps the first submit after a launch a boot episode (it may
        // only have answered a dialog). One that carried a prompt, followed
        // by the program's own `working`, is a turn. Codex also reports
        // `working` at startup, so the prompt is what tells them apart.
        if (this.turnOpen && this.bootEpisode && this.promptSubmittedAt > 0 && this.promptSubmittedAt >= this.turnOpenedAt) this.bootEpisode = false;
        this.byteOpenedTurn = false;
        this.spinnerOpenedTurn = false;
      }
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
        if (authoritative) this.hookArmedCycle = true;
        this.activityMonitor.beginTurnIfInactive(this.sessionId);
      }
      this.reportMidTurn();
      return;
    }
    this.explicitTerminalStatus = true;
    this.settledStatus = status;
    // An authoritative turn end (the Stop / StopFailure hook) closes any dialog
    // the turn was blocked on. The detector's own `waiting` / `complete` cannot:
    // the idle footer under an approval box matches those patterns too.
    if (status === 'awaiting_input') {
      // Who answers for the dialog is settled when it opens; a later match of
      // the same box (the detector's line, the hook) only adds the hook's claim.
      if (!this.awaitingHuman) {
        this.titleRaisedAwaiting = false;
        this.awaitingFromHook = false;
        this.awaitingFromProgram = false;
      }
      if (authoritative) this.awaitingFromHook = true;
      if (program && !this.awaitingHuman) this.awaitingFromProgram = true;
      this.awaitingHuman = true;
      this.awaitingQuestionAt = questionAt ?? null;
      // The agent's own dialog hook means its turn is running: an episode a
      // detector settle closed softly mid-turn resumes under the same id.
      if (authoritative && this.turnSoftClosed) this.openTurn(true);
    } else if (authoritative) this.awaitingHuman = false;
    // A settle ends the episode unless it is the dialog the turn waits on. On
    // a pane with hooks only the hook's own settle (Stop / StopFailure) counts:
    // the detector's `complete` / `waiting` also match footers mid-turn.
    if (authoritative) this.hookSeen = true;
    // `provisional`: a hook settle the transcript has not confirmed (see the
    // daemon's Codex stop handling) closes like a detector settle does.
    // The program's own settle is final, like a hook's that the transcript confirmed.
    if (!this.awaitingHuman && (authoritative || program || !this.hookSeen || this.byteOpenedTurn)) this.closeTurn((!authoritative && !program) || provisional);
    this.settledAtMs = Date.now();
    this.submittedTurnPending = false;
    this.hookArmedCycle = false;
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
    this.reportMidTurn();
  }

  /**
   * True when nothing has been written to this PTY's stdin recently enough for
   * the current output to be an echo of it. `lastInputAt` starts at 0, so a
   * pane nobody has typed into is quiet from the moment it spawns.
   */
  isInputQuiet(): boolean {
    return Date.now() - this.lastInputAt >= DaemonPTYBridge.INPUT_ECHO_QUIET_MS;
  }

  /** #1621 — an episode is open (a submit or running edge not yet settled). */
  isTurnOpen(): boolean {
    return this.turnOpen;
  }

  /** Milliseconds since the pane's last settled status (a turn's result),
   *  or null when none settled since its current agent started. */
  settledAgoMs(): number | null {
    return this.settledAtMs > 0 ? Math.max(0, Date.now() - this.settledAtMs) : null;
  }

  /** #1621 — an authoritative hook has reported on this pane's current agent. */
  hasHookReports(): boolean {
    return this.hookSeen;
  }

  /** Current stdin generation; every non-empty write advances it once. */
  isEmptyShellPrompt(): boolean { return this.emptyShellPrompt; }

  getInputRevision(): number {
    return this.inputRevision;
  }

  /** Stdin generation counting only writes that can act on the screen (see the field). */
  getKeyInputRevision(): number {
    return this.keyInputRevision;
  }

  /**
   * The daemon itself ended the shell's foreground program (a proven stop of
   * a TUI moving into chat). The keys typed up to `keyRevision`, read before
   * that stop, went to the program, not to the shell's line editor, so they
   * are not input queued at the next prompt. Keys after it still are. Works
   * whether the shell has already drawn that prompt or not.
   */
  rebaseShellKeyInput(keyRevision: number): void {
    if (this.shellCommandRunning) {
      this.shellCommandKeyRevision = Math.max(this.shellCommandKeyRevision, keyRevision);
      return;
    }
    const ended = this.endedShellCommand;
    // Another command, or a key after the mark before the program ended: the end's verdict stands.
    if (!ended || keyRevision < ended.keyRevision || ended.endedAt !== keyRevision) return;
    // A key reached the pane after the program ended: the shell's line editor holds it.
    if (this.keyInputRevision !== ended.endedAt) return;
    if (!ended.prompted) this.completedShellCommand = true;
    else this.emptyShellPrompt = true;
  }

  /** `isInputQuiet` for writes that can act on the screen only: focus and
   *  pointer-motion reports do not break the quiet (#1680). */
  isKeyInputQuiet(): boolean {
    return Date.now() - this.lastKeyInputAt >= DaemonPTYBridge.INPUT_ECHO_QUIET_MS;
  }

  /** Milliseconds since the last key input (focus and pointer reports excluded). */
  keyInputIdleMs(): number {
    return Date.now() - this.lastKeyInputAt;
  }

  /** `isKeyInputQuiet` over a caller-chosen window: no key input for `ms`. */
  isKeyInputQuietFor(ms: number): boolean {
    return Date.now() - this.lastKeyInputAt >= ms;
  }

  /** Actual submitted input/hook work, excluding terminal redraw activity. */
  getLastTurnStartedAt(): number {
    return this.lastTurnStartedAt;
  }

  /** `resume`: a running edge that is not a submit may reopen a detector-closed episode. */
  private openTurn(resume = false, signalTs?: number): void {
    if (this.turnOpen) return;
    this.turnOpen = true;
    if (resume && this.turnSoftClosed) {
      this.turnSoftClosed = false;
      this.reportMidTurn();
      return;
    }
    this.turnSoftClosed = false;
    this.turnSeq += 1;
    this.lastFailure = null;
    this.prevTurnOpenedAt = this.turnOpenedAt;
    const now = Date.now();
    // Only a plausible hook time (not in the future, not older than the 2 s
    // hook budget allows plus margin) replaces the receive time.
    this.turnOpenedAt = signalTs !== undefined && Number.isFinite(signalTs) && signalTs <= now && now - signalTs < 10_000 ? signalTs : now;
    this.bootEpisode = this.codexBootWindow;
    this.reportMidTurn();
  }

  /**
   * The pane's agent is in the middle of a turn: what a pane recovered after
   * this daemon died must continue rather than sit idle (see 'agentTurn').
   *
   * `turnOpen` is the one episode both signals feed: a hook's running edge
   * (UserPromptSubmit, tool hooks) and the byte/title heuristics a hookless
   * pane runs on. It is not enough alone. A submit opens it in a plain shell
   * too, and a shell without OSC 133 never settles it, so an agent must be
   * present: one whose hooks report (`hookSeen`, reset when the agent ends),
   * one that reports its own status (`programStatusSeen`, likewise), or a live
   * agent process. A boot episode (the launch Enter or the TUI's first
   * paint, with no hook or joining submit since) is not a turn yet: continuing
   * an agent idle at its composer would invent work. A hookless agent's first
   * turn after its launch counts once Claude Code's running title shows it
   * (noteClaudeTitle); a submit that only answered a dialog draws none.
   */
  isAgentMidTurn(): boolean {
    return this.turnOpen && !this.bootEpisode && (this.hookSeen || this.programStatusSeen || this.trackedAgent?.alive === true);
  }

  /** Emits 'agentTurn' when `isAgentMidTurn` changed since the last report. */
  private reportMidTurn(): void {
    const midTurn = this.isAgentMidTurn();
    if (midTurn === this.reportedMidTurn || !this.sessionId) return;
    this.reportedMidTurn = midTurn;
    this.emit('agentTurn', { sessionId: this.sessionId, runningSince: midTurn ? this.turnOpenedAt : null });
  }

  private closeTurn(soft = false): void {
    // A cycle the title armed for this turn, which no output has reached yet,
    // ends with it: a trailing frame would otherwise reopen the turn.
    this.releaseTitleCycle();
    this.byteOpenedTurn = false;
    this.spinnerOpenedTurn = false;
    if (this.turnOpen) this.turnSoftClosed = soft;
    else if (!soft) this.turnSoftClosed = false;
    this.turnOpen = false;
    if (!this.turnSoftClosed) this.bootEpisode = false;
    this.reportMidTurn();
  }

  /**
   * Codex keeps a braille spinner at the front of its window title while a
   * turn runs. Without Codex hooks that spinner is the only running signal a
   * long reasoning stretch gives: the screen barely changes, so the byte-rate
   * heuristic stays quiet, and no tool runs for the transcript watcher to
   * report. The pane then read Idle mid-turn once the renderer's two-minute
   * activity stamp ran out.
   *
   * The spinner goes through the same turn bookkeeping as output does, so
   * the event, getAgentStatus() and isTurnOpen() agree. A frame arms the
   * activity cycle, and the next frame reports `active` through onActive.
   * When no turn is open (a detector settled it, as Codex's footer can
   * mid-turn), the frame also opens one, as noteSpinnerTitle does for Claude
   * Code, and the frame dropping from the title ends that turn again
   * (endSpinnerTurn): the detector's dedup may keep the same footer from
   * settling it a second time. The trailing frames of a turn the transcript
   * recorded as ended open nothing.
   * While the turn runs and the cycle stays active, a frame every
   * CODEX_SPINNER_REFRESH_MS reports `active` again, which keeps the
   * renderer's stamp fresh.
   *
   * A pane whose hooks report is left to them, and the title waits out the
   * settle cooldown and a resize repaint: the last frames of a turn that just
   * ended would otherwise reach the daemon's completion alarm as fresh work
   * and cancel it. A pane waiting on a human is never promoted by its title.
   * The agent is the one the process tracker watches alive in the pane, with
   * the registry's `titleRunning` capability (Claude's spinner has its own
   * path above) and its running title from RUNNING_TITLE: the detector's last agent
   * outlives the agent, and another program's title can start with a braille
   * frame too.
   */
  private noteCodexTitleSpinner(sessionId: string): void {
    // The program's own word outranks its title: the spinner may only agree.
    if (this.programStatusSeen && !this.programWorking()) return;
    const slug = this.trackedAgent?.alive ? this.trackedAgent.slug : undefined;
    // Before any turn evidence the title still counts: `codex "<prompt>"`
    // (Fan-out's launch) submits its first turn itself, with no keystroke
    // reaching the bridge. endSpinnerTurn settles such a turn as a boot.
    if (!slug || !agentRow(slug)?.titleRunning || this.hookSeen) return;
    if (!titleShowsRunningTurn({ title: this.lastTitle, at: this.lastTitleAt }, slug, Date.now())) {
      if (this.spinnerOpenedTurn && this.turnOpen && !this.awaitingHuman) this.endSpinnerTurn();
      return;
    }
    const monitor = this.activityMonitor;
    if (!monitor || this.awaitingHuman || this.muted) return;
    const now = Date.now();
    if (
      now - this.settledAtMs < DaemonPTYBridge.SETTLE_COOLDOWN_MS
      || now - this.lastResizeAtMs < RESIZE_REDRAW_GUARD_MS
    ) return;
    const promoted = this.explicitTerminalStatus;
    if (promoted && !this.isInputQuiet()) return;
    // The last frames of a turn the transcript just recorded as ended belong to it.
    if (!this.turnOpen && now - this.transcriptTurnEndAt < DaemonPTYBridge.SETTLE_COOLDOWN_MS) return;
    const settled = this.settledStatus;
    if (promoted) {
      this.explicitTerminalStatus = false;
      this.settledStatus = null;
      this.submittedTurnPending = false;
    }
    // No turn is open (a detector settled it, or a late launch edge of another
    // agent ended it) while the title spins: the title opens one, and its
    // frame dropping ends it again (endSpinnerTurn), whichever path the next
    // `active` takes.
    if (!this.turnOpen) {
      this.spinnerSettledStatus = promoted ? settled : null;
      this.openTurn(true);
      this.spinnerOpenedTurn = true;
    }
    if (!monitor.isActive(sessionId)) {
      // A promotion keeps the detector's dedup, as the settled branch of
      // onActive does: the footer still on screen must not settle it again.
      if (promoted) this.spinnerArmedCycle = true;
      monitor.beginTurnIfInactive(sessionId);
      this.titleArmedCycle = monitor.cycleOf(sessionId);
      // The monitor starts a cycle's idle countdown on output only. A cycle
      // no output reaches (the TUI went quiet right after this frame) would
      // read running forever, so it gets a countdown of its own.
      if (this.titleCycleTimer) clearTimeout(this.titleCycleTimer);
      this.titleCycleTimer = setTimeout(() => {
        this.titleCycleTimer = null;
        // Only the cycle the title armed, unclaimed: output, a submit, an idle
        // or a hook took any other over, and it is theirs to end.
        if (!this.titleCycleStillPending()) {
          this.titleArmedCycle = null;
          return;
        }
        // No output at all since the frame: a turn the title opened ends as
        // if its frame had dropped (endSpinnerTurn releases the cycle too).
        if (this.spinnerOpenedTurn && this.turnOpen && !this.awaitingHuman && !this.hookSeen) this.endSpinnerTurn();
        else this.releaseTitleCycle();
      }, DaemonPTYBridge.TITLE_CYCLE_IDLE_MS);
      return;
    }
    if (now - this.lastActiveAt < DaemonPTYBridge.CODEX_SPINNER_REFRESH_MS) return;
    this.lastActiveAt = now;
    this.emit('active', {
      sessionId,
      agentName: this.agentDetector?.getLastAgent() ?? undefined,
      likelyRepaint: false,
    });
  }

  /** The activity cycle noteCodexTitleSpinner armed (ActivityMonitor.cycleOf),
   *  until output or idle takes it over; the tracked Codex dying or being
   *  replaced while it is still that cycle hands it back (noteAgentProcess). */
  private titleArmedCycle: number | null = null;
  /** Releases a title-armed cycle no output reached (see noteCodexTitleSpinner). */
  private titleCycleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The activity monitor's own idle delay. */
  private static readonly TITLE_CYCLE_IDLE_MS = 5_000;

  /**
   * Codex keeps `[ ! ] Action Required | …` in its window title while an
   * approval box waits. The question on screen can wrap on a narrow pane or
   * arrive in cursor-addressed pieces the detector's line patterns never see,
   * so a pane without the PermissionRequest hook read running through the
   * whole approval. The title raises the same `awaiting_input` the detector
   * would, once per dialog (the title blinks). The agent is the one the
   * process tracker watches alive in the pane, as for the running title.
   *
   * The title also says when the box is gone, which a keystroke cannot: Codex
   * takes `y` / `p` as answers (not read as one by noteInput), and the box
   * can be answered from elsewhere or withdrawn. A dialog the title raised
   * ends when the title stops showing it, through the release a screen read
   * runs (clearAwaiting).
   */
  private noteTitleAwaitingHuman(sessionId: string): void {
    // A program that reports its status reports its dialogs too (`blocked`).
    if (this.programStatusSeen) return;
    const slug = this.trackedAgent?.alive ? this.trackedAgent.slug : undefined;
    const rule = slug ? AWAITING_TITLE.get(slug) : undefined;
    if (!slug || !rule || this.muted) return;
    if (rule.test(this.lastTitle)) {
      if (this.awaitingHuman) {
        // The detector's own line match for the same box: the title now
        // answers for it too. A hook's dialog stays the hook's.
        if (!this.awaitingFromHook) this.titleRaisedAwaiting = true;
        return;
      }
      this.noteAgentStatus('awaiting_input');
      this.titleRaisedAwaiting = true;
      this.emit('agent', {
        sessionId,
        event: { agent: agentRow(slug)?.display ?? slug, status: 'awaiting_input', message: 'Approval requested' },
      });
      return;
    }
    if (!this.titleRaisedAwaiting || this.awaitingFromHook || !this.awaitingHuman || !this.lastTitle) return;
    this.titleRaisedAwaiting = false;
    // The box is gone from the pane's own display: the release a screen read
    // that finds no dialog runs (answered event, approval card, turn resumed).
    this.clearAwaiting('screen-cleared');
    // Answered and still working: the running-title path carries the turn on.
    if (RUNNING_TITLE.get(slug)?.test(this.lastTitle)) return;
    // No spinner: the turn ended with the box (withdrawn, or denied). The
    // resumed cycle would wait for output that may never come, so the pane
    // settles at its prompt now, as the detector's idle prompt settles it.
    this.noteAgentStatus('waiting');
    this.emit('agent', {
      sessionId,
      event: { agent: agentRow(slug)?.display ?? slug, status: 'waiting', message: 'Waiting for input' },
    });
  }
  /** The open dialog is one the title shows (noteTitleAwaitingHuman), not a hook's. */
  private titleRaisedAwaiting = false;
  /** The open dialog was raised by the agent's own hook. */
  private awaitingFromHook = false;
  /** The open dialog was raised by the program's own `blocked` report. */
  private awaitingFromProgram = false;

  /** How often a still-spinning Codex title re-reports running (well inside
   *  the renderer's 120 s activity window). */
  private static readonly CODEX_SPINNER_REFRESH_MS = 30_000;

  /** The agent's own running spinner is the latest window title, set within the freshness window. */
  private titleShowsRunningTurn(): boolean {
    const agent = this.agentDetector?.getLastAgent() ?? '';
    const slug = /codex/i.test(agent) ? 'codex' : /claude/i.test(agent) ? 'claude' : '';
    return !!slug && titleShowsRunningTurn({ title: this.lastTitle, at: this.lastTitleAt }, slug, Date.now());
  }

  /**
   * F24 — output alone must not open a turn here: the pane's hooks report,
   * and the latest window title is Claude Code's idle `✳ <name>`. Claude Code
   * swaps it for its `◐`/`◑` spinner within about a second of any turn it
   * starts, autonomous ones included, and keeps the spinner up for the whole
   * turn; its idle recap, `Checking for updates` and a repaint for a viewer
   * that attached are all drawn under `✳`. The agent is not checked: the
   * glyph is Claude Code's own, and its detector may not have named it.
   * The chunk being measured is read before its titles are parsed, so a
   * spinner title inside that same chunk counts too.
   */
  private idleTitleOnHookPane(): boolean {
    return this.hookSeen && !this.chunkSetsSpinnerTitle
      && titleShowsFinishedTurn({ title: this.lastTitle, at: this.lastTitleAt }, 'claude', 0);
  }

  /** The output chunk the activity monitor is measuring sets Claude Code's spinner title. */
  private chunkSetsSpinnerTitle = false;
  /** When the idle-title gate last held a burst back (0 = never). */
  private heldBurstAt = 0;
  private static readonly HELD_BURST_MS = 3000;

  /**
   * F24 — Claude Code set its running spinner title on a settled hook pane
   * within a few seconds of a burst the idle-title gate held back: it
   * started a turn by itself (a background task woke it), and that burst was
   * the turn's first paint. The spinner alone writes too few bytes to cross
   * the activity threshold again, so the title opens the turn, dated from the
   * held burst. Without a held burst a spinner title opens nothing (a slow
   * Stop hook keeps the spinner up after its Stop arrived). The settled
   * branch's other guards apply: echo of the user's keys, a resize repaint.
   */
  private noteSpinnerTitle(): void {
    if (!this.explicitTerminalStatus || !this.hookSeen || this.awaitingHuman || this.muted || !this.sessionId) return;
    const now = Date.now();
    if (
      now - this.settledAtMs < DaemonPTYBridge.SETTLE_COOLDOWN_MS
      || !this.isInputQuiet()
      || now - this.lastResizeAtMs < RESIZE_REDRAW_GUARD_MS
    ) return;
    if (now - this.heldBurstAt >= DaemonPTYBridge.HELD_BURST_MS) return;
    const heldAt = this.heldBurstAt;
    this.heldBurstAt = 0;
    this.spinnerSettledStatus = this.settledStatus;
    this.explicitTerminalStatus = false;
    this.settledStatus = null;
    this.submittedTurnPending = false;
    // Not `byteOpenedTurn`: the spinner is the agent's own word that a turn
    // runs, and that turn ends with a Stop like any other. Until a hook
    // speaks, Claude Code's idle title ends it too (see endSpinnerTurn).
    const wasOpen = this.turnOpen;
    this.openTurn(true, heldAt);
    if (!wasOpen) this.spinnerOpenedTurn = true;
    // The turn's next output reports `running` through onActive, as a hook's
    // running edge does, but keeps the detector's dedup like the settled
    // branch's promotion: the idle chrome still on screen must not answer
    // with a stale `waiting`.
    this.spinnerArmedCycle = true;
    this.activityMonitor?.beginTurnIfInactive(this.sessionId);
  }

  /** The current activity cycle was armed by noteSpinnerTitle and has not fired yet. */
  private spinnerArmedCycle = false;
  /** The open episode was opened by a running title (noteSpinnerTitle, noteCodexTitleSpinner), and no hook or submit has spoken since (answering its dialog keeps it). */
  private spinnerOpenedTurn = false;
  /** The settled status noteSpinnerTitle cleared, for endSpinnerTurn to put back. */
  private spinnerSettledStatus: AgentEventStatus | null = null;

  /**
   * Claude Code set its idle title over a turn only its spinner opened (no
   * hook since: an interrupt, or a turn that never reached the model). The
   * episode ends softly and the pane is settled again as it was, so a later
   * repaint under that title meets the idle-title gate.
   */
  private endSpinnerTurn(): void {
    // A spinner that ran before any turn evidence (a boot, or a first turn
    // the agent submitted itself) settles the way a boot does: an idle main
    // treats as pre-turn, not a `complete` nobody asked for.
    const preTurn = this.preTurn;
    this.closeTurn(true);
    this.settledStatus = this.spinnerSettledStatus ?? (preTurn ? null : 'complete');
    this.explicitTerminalStatus = this.settledStatus !== null;
    this.spinnerSettledStatus = null;
    this.spinnerArmedCycle = false;
    if (this.activityMonitor && this.sessionId) {
      this.activityMonitor.endTurn(this.sessionId);
      // Main heard `running` from this turn; nothing else would retract it.
      this.emit('idle', { sessionId: this.sessionId, ...(preTurn ? { preTurn: true } : {}) });
    }
  }

  /**
   * #2673 — Claude Code's running title (`◐`/`◑`, up for the whole of every
   * turn it runs) over a boot episode that a prompt opened: the agent's word
   * that the episode is a turn. #1670 keeps the first submit after a launch a
   * boot episode because it may only have answered a dialog; the next submit
   * would find this title and keep the turn (startAnsweredTurn). Left a boot
   * episode, the turn never reached main as one, so its end could not settle
   * the pane either. Only when the episode began with a prompt typed into
   * Claude Code (claudePromptAt): the launch line, a startup paint and a
   * dialog's bare Enter stay boot episodes.
   */
  private noteClaudeTitle(title: string): void {
    if (!CLAUDE_RUNNING_TITLE.test(title)) return;
    this.claudeRunningTitleAt = this.lastTitleAt;
    if (!this.turnOpen || !this.bootEpisode || this.awaitingHuman || this.muted) return;
    if (this.claudePromptAt === 0 || this.claudePromptAt < this.turnOpenedAt || !this.paneAgentTitlesTurns()) return;
    this.bootEpisode = false;
    this.reportMidTurn();
  }

  /** The pane's agent reads its turns off its title (registry `titleTurns`):
   *  the tracked process's agent when it names one, else the agent on the screen. */
  private paneAgentTitlesTurns(): boolean {
    // A live pick with no slug (a wrapper, an unknown child) names no agent:
    // the screen's then stands.
    const tracked = this.trackedAgent?.alive ? this.trackedAgent.slug : undefined;
    const slug = tracked ?? agentDisplayToSlug(this.agentDetector?.getLastAgent() ?? '');
    return agentRow(slug)?.titleTurns === true;
  }

  /**
   * Something other than the shell moved the pane's cwd (an agent's hook
   * reported its own directory). Forget the last shell-reported value so the
   * shell's next report re-emits even when it names the same directory again,
   * which is how the cwd moves back once the agent exits to the prompt.
   */
  forgetEmittedCwd(): void {
    this.lastEmittedOscCwd = null;
    this.lastDetectedPromptCwd = '';
  }

  /**
   * The agent's transcript recorded a turn end (completed or interrupted) at
   * `at`. An interrupt fires no Stop hook, so without this the episode would
   * stay open and the next prompt would join it. Ignored behind a dialog, or
   * when the end predates the latest turn evidence.
   */
  noteTranscriptTurnEnd(at: number): void {
    if ((this.turnOpen || this.turnSoftClosed) && !this.awaitingHuman && at >= this.turnOpenedAt) {
      this.closeTurn();
      this.transcriptTurnEndAt = Date.now();
    }
  }
  /**
   * The pane's own transcript ends with a finished turn, yet an episode is
   * open: whatever opened it (a Codex /status submit) ran no turn there, so
   * none of its stops will end it.
   */
  noteNoTranscriptTurn(): void {
    // A real prompt reaches the rollout within milliseconds of its Enter; only
    // an episode that has stayed empty past the grace is taken as no turn.
    if (Date.now() - this.turnOpenedAt < NO_TRANSCRIPT_TURN_GRACE_MS) return;
    if (this.turnOpen && !this.awaitingHuman) this.closeTurn();
  }
  /** When noteTranscriptTurnEnd last closed an episode (0 = never). */
  private transcriptTurnEndAt = 0;

  /**
   * The agent that owned this pane is gone (its process exited, another agent
   * replaced it, or the shell took the foreground back). It sends no Stop for
   * that, so its episode ends here, and the next agent's hooks are judged
   * afresh: until one reports, its detector settles count.
   */
  /** OSC 133 command starts this pane's shell reported (monotonic; read through getCommandStarts). */
  private commandStarts = 0;
  private parsesOsc133 = false;

  /**
   * #2673 — how many commands the pane's shell has started (OSC 133 C), or
   * undefined when this bridge does not parse them. The process tracker reads
   * it to tell whether a watched agent's death may have a successor.
   */
  getCommandStarts(): number | undefined {
    return this.parsesOsc133 ? this.commandStarts : undefined;
  }

  noteAgentEnded(clearDetectorIdentity = true): void {
    this.closeTurn();
    this.hookSeen = false;
    this.endProgramStatusEpisode();
    if (clearDetectorIdentity) this.agentDetector?.clearTrustedIdentity();
  }

  /**
   * An OSC 7501 report (see programStatus.ts). Every valid report is stored;
   * only the root record drives the pane, and only while the process tracker
   * watches an agent alive in it (paneAgent): a plain shell command reporting
   * `working` is not an agent turn. The feature query
   * (`?`) is not answered yet, so only programs that report without asking
   * (Codex) reach this.
   */
  private noteProgramStatus(data: string): void {
    const report = parseProgramStatus(data);
    if (!report) return;
    const prior = this.programStatusSeen ? this.programStatus.root() : undefined;
    this.programStatus.apply(report, Date.now());
    const root = this.programStatus.root();
    if (!root) {
      // `clear` (or eviction) took the root: the heuristics take the pane back.
      this.handBackProgramStatus();
      return;
    }
    if (report.id !== undefined || !this.sessionId) return;
    const pane = this.paneAgent();
    if (!pane) return;
    this.programStatusSeen = true;
    this.programAgentSlug = pane.slug;
    this.applyProgramState(root, prior, pane.name, this.sessionId);
  }

  /**
   * The root record's state, applied with the same events the screen
   * heuristics raise (`agent`, `active`, `answered`), so main and the phone
   * need nothing new: `working` runs the turn, `blocked` waits on a human,
   * `idle` / `done` / `error` settle it. `title` and `msg` are stored only.
   */
  private applyProgramState(record: ProgramStatusRecord, prior: ProgramStatusRecord | undefined, agent: string, sessionId: string): void {
    const changed = record.state !== prior?.state;
    if (record.state === 'blocked' || record.state === 'working') this.programStateAt = record.updatedAt;
    if (record.state === 'blocked') {
      // The dialog the screen or a hook already raised: the program now answers for it too.
      if (this.awaitingHuman) {
        this.awaitingFromProgram = true;
        return;
      }
      this.noteAgentStatus('awaiting_input', false, undefined, false, undefined, 'program');
      this.emit('agent', { sessionId, event: { agent, status: 'awaiting_input', message: PROGRAM_BLOCKED_MESSAGE[record.kind ?? 'none'] } });
      return;
    }
    // Not blocked: a dialog the program reported, or one only the screen
    // raised, is over, released the way a screen read that finds it gone
    // releases it. A hook's own dialog the program never reported stays the hook's.
    if (this.awaitingHuman && (this.awaitingFromProgram || !this.awaitingFromHook)) this.clearAwaiting('screen-cleared');
    if (record.state === 'working') {
      this.noteAgentStatus('running', false, undefined, false, undefined, 'program');
      this.armProgramQuietCheck(sessionId);
      // A repeat keeps the renderer's activity stamp fresh, as the Codex
      // spinner title does (CODEX_SPINNER_REFRESH_MS).
      if ((changed || Date.now() - this.lastActiveAt >= DaemonPTYBridge.CODEX_SPINNER_REFRESH_MS) && !this.muted) {
        this.lastActiveAt = Date.now();
        this.emit('active', { sessionId, agentName: agent, likelyRepaint: false });
      }
      return;
    }
    // `error` settles as a neutral turn end: main words an `error` status as
    // an API failure, which a program's own `error` need not be.
    const status = record.state === 'idle' ? 'waiting' : 'complete';
    if (!changed && this.explicitTerminalStatus && this.settledStatus === status) return;
    // The same settle again right after a submit (or a hook) started a turn:
    // a repeat of the old state crossing the submit, not this turn's end. A
    // later one ends a turn the program never started (an empty Enter).
    if (!changed && prior && this.lastTurnStartedAt >= this.programStateAt
      && Date.now() - this.lastTurnStartedAt < DaemonPTYBridge.PROGRAM_REPEAT_GRACE_MS) return;
    this.programStateAt = record.updatedAt;
    const wasSettled = this.explicitTerminalStatus;
    this.noteAgentStatus(status, false, undefined, false, undefined, 'program');
    this.emit('agent', { sessionId, event: { agent, status, message: PROGRAM_SETTLED_MESSAGE[record.state] } });
    // At the prompt before any turn (the agent booting), as the detector's idle prompt reports it.
    if (status === 'waiting' && !wasSettled && this.isPreTurn()) this.emit('idle', { sessionId, preTurn: true });
  }

  /** Applies the root record stored before the tracker saw the agent alive. */
  private applyStoredProgramStatus(root: ProgramStatusRecord): void {
    const pane = this.paneAgent();
    if (!pane || !this.sessionId) return;
    this.programStatusSeen = true;
    this.programAgentSlug = pane.slug;
    this.applyProgramState(root, undefined, pane.name, this.sessionId);
  }

  /**
   * The agent the process tracker watches alive in the pane, or null. Not the
   * detector's last agent alone: that outlives the agent, and bytes any later
   * program prints (a `cat` of a crafted file) must not speak for it.
   */
  private paneAgent(): { slug: string; name: string } | null {
    const slug = this.trackedAgent?.alive ? this.trackedAgent.slug : undefined;
    if (!slug) return null;
    const screen = this.agentDetector?.getLastAgent();
    const name = screen && agentDisplayToSlug(screen) === slug ? screen : agentRow(slug)?.display;
    return name ? { slug, name } : null;
  }

  /**
   * A program that says `working` repaints (Codex's spinner title is output),
   * so output stopping for PROGRAM_WORKING_QUIET_MS with no report since means
   * it is stopped or hung. Codex has no stall rule of its own (StallWatch is
   * Claude's), so the pane goes back to the heuristics and gets the idle the
   * silence held back. Its next report drives the pane again.
   */
  private armProgramQuietCheck(sessionId: string, delay = DaemonPTYBridge.PROGRAM_WORKING_QUIET_MS): void {
    if (this.programQuietTimer) clearTimeout(this.programQuietTimer);
    this.programQuietTimer = setTimeout(() => {
      this.programQuietTimer = null;
      const root = this.programStatus.root();
      if (!this.programWorking() || !root || this.sessionId !== sessionId) return;
      // Output or a report since: wait out the bound from the later of them.
      const left = Math.max(this.lastOutputAt, root.updatedAt) + DaemonPTYBridge.PROGRAM_WORKING_QUIET_MS - Date.now();
      if (left > 0) {
        this.armProgramQuietCheck(sessionId, left);
        return;
      }
      this.handBackProgramStatus();
      // The turn the silence held open ends too (softly: a later running
      // edge resumes it), or main would keep reading it as mid-turn.
      this.closeTurn(true);
      this.activityMonitor?.endTurn(sessionId);
      if (!this.explicitTerminalStatus) this.emit('idle', { sessionId, ...(this.isPreTurn() ? { preTurn: true } : {}) });
    }, delay);
  }

  /**
   * Whether a screen read of `status` is muted because the program reports.
   * A dialog never is. Nor is a settle while the program sits settled and has
   * said nothing since a submit opened a turn: an Enter it never turned into
   * work (an empty composer, a slash command) is ended by the screen.
   */
  private programMutesScreen(status: AgentEventStatus): boolean {
    if (!this.programStatusSeen || status === 'awaiting_input') return false;
    const root = this.programStatus.root();
    const silentSinceSubmit = status !== 'running' && this.turnOpen && !!root
      && (root.state === 'idle' || root.state === 'done' || root.state === 'error')
      && this.lastTurnStartedAt >= this.programStateAt;
    return !silentSinceSubmit;
  }

  /** The program driving this pane says it is working. */
  private programWorking(): boolean {
    return this.programStatusSeen && this.programStatus.root()?.state === 'working';
  }

  /**
   * The program's episode is over (it exited, the agent ended, or a shell
   * prompt began): working and blocked records are dropped, done and error
   * stay, and the heuristics take the pane back.
   */
  private endProgramStatusEpisode(): void {
    this.programEpisodeEndAt = Date.now();
    this.programStatus.dropTransient();
    this.handBackProgramStatus();
  }

  /** RIS: every record goes. */
  private resetProgramStatus(): void {
    this.programStatus.clear();
    this.handBackProgramStatus();
  }

  /**
   * Stop driving the pane from OSC 7501. A dialog the program raised is
   * released quietly (as a lost server releases one): nobody answered it,
   * so no `answered` (which main reads as the turn resuming) is sent.
   */
  private handBackProgramStatus(): void {
    this.programStatusSeen = false;
    this.programAgentSlug = null;
    if (this.programQuietTimer) clearTimeout(this.programQuietTimer);
    this.programQuietTimer = null;
    const raised = this.awaitingFromProgram;
    this.awaitingFromProgram = false;
    if (!raised || !this.awaitingHuman || this.awaitingFromHook) return;
    this.awaitingHuman = false;
    this.awaitingQuestionAt = null;
    if (this.settledStatus === 'awaiting_input') this.settledStatus = 'waiting';
  }

  /** The root OSC 7501 record (a copy), or undefined. */
  getProgramStatus(): ProgramStatusRecord | undefined {
    const root = this.programStatus.root();
    return root ? { ...root } : undefined;
  }

  /** Whether the program's own reports drive this pane's turn state now. */
  isProgramStatusDriving(): boolean {
    return this.programStatusSeen;
  }

  /** The host supplies a parsed live viewport with output/geometry fences. */
  setApprovalScreenReader(reader: ApprovalScreenReader): void {
    this.approvalScreenReader = reader;
  }

  private recheckQuietApproval(detector: AgentDetector): void {
    const reader = this.approvalScreenReader;
    const sessionId = this.sessionId;
    if (!reader || !sessionId || this.muted) return;
    void detector.revalidateApprovalScreen(async () => {
      if (this.agentDetector !== detector || this.sessionId !== sessionId || this.muted) return null;
      const snapshot = await reader(sessionId);
      return this.agentDetector === detector && this.sessionId === sessionId && !this.muted ? snapshot : null;
    }).catch(() => undefined); // an unavailable screen cannot change pane state
  }

  /**
   * The daemon's process tracker picked the pane's agent process, or saw it
   * die. Only the watched pid's death is reported, so a relaunch the tracker
   * already picked is never ended by its predecessor's late death edge.
   */
  noteAgentProcess(state: { slug?: string; alive: boolean; observedAt?: number; replacedLive?: true; identityEpoch?: number | null }): void {
    const detector = this.agentDetector;
    const now = Date.now();
    const boundaryAt = Math.max(this.identityLifetimeAt, detector?.getIdentityBoundaryAt() ?? 0);
    const epochProven = state.identityEpoch !== undefined && state.identityEpoch !== null
      && state.identityEpoch === detector?.getIdentityEpoch();
    // Missing time cannot seed identity. An explicit WSL replacement can
    // still retire the old episode without granting the new process a seed.
    // A probe begun before a shell return belongs to that older launch even
    // when the process table arrives after the next one started.
    if (state.alive && state.identityEpoch !== undefined && !epochProven) return;
    if (state.alive && state.observedAt !== undefined && (!Number.isFinite(state.observedAt)
      || (epochProven ? state.observedAt < boundaryAt : state.observedAt <= boundaryAt) || state.observedAt > now
      || now - state.observedAt > DETECTOR_IDENTITY_HOOK_MAX_AGE_MS)) return;
    const screenName = this.getLastAgent();
    const previous = detector?.getTrustedAgent() ?? this.trackedAgent?.slug
      ?? (screenName ? agentDisplayToSlug(screenName) : undefined);
    // A report the agent wrote before the tracker saw it alive (Codex's boot
    // `idle`), not one left from an earlier episode.
    const stored = this.programStatus.root();
    const pendingReport = state.alive && !this.programStatusSeen && stored && stored.updatedAt > this.programEpisodeEndAt ? stored : undefined;
    if (!state.alive || ((state.observedAt !== undefined || state.replacedLive) && state.slug && previous && previous !== state.slug)) this.noteAgentEnded();
    this.trackedAgent = { ...(state.slug ? { slug: state.slug } : {}), alive: state.alive };
    this.reportMidTurn();
    if (pendingReport && this.programStatus.root() === pendingReport) this.applyStoredProgramStatus(pendingReport);
    if (detector && state.alive && state.observedAt !== undefined && isAgentSlug(state.slug)) {
      if (detector.seedTrustedIdentity(state.slug, detector.getIdentityEpoch())) this.recheckQuietApproval(detector);
    }
    // A cycle the title armed waits for output to start its idle countdown;
    // an agent that died (or was replaced by another) right after the frame
    // writes none, and the cycle would read running forever. It goes with
    // the agent that armed it.
    if (state.alive && agentRow(state.slug)?.titleRunning) return;
    this.releaseTitleCycle();
  }

  /** Capture before an async probe, not when its result is delivered. */
  captureIdentityProbe(): { epoch: number; isCurrent: () => boolean } | undefined {
    const detector = this.agentDetector;
    if (!detector) return undefined;
    const epoch = detector.getIdentityEpoch();
    return { epoch, isCurrent: () => this.agentDetector === detector && detector.getIdentityEpoch() === epoch };
  }

  /** Fresh hook identity may enable screen fallback patterns, never a turn. */
  noteHookAgentIdentity(signal: AgentSignal, canonical: CanonicalAgentIdentity | undefined): boolean {
    const detector = this.agentDetector;
    if (!detector || !this.sessionId || canonical?.source !== 'hook' || canonical.slug !== signal.agent) return false;
    if (!canSeedHookIdentity(signal, {
      ptyId: this.sessionId, now: Date.now(),
      boundaryAt: Math.max(this.identityLifetimeAt, detector.getIdentityBoundaryAt()),
    })) return false;
    // The caller computed the canonical identity with process contradiction
    // checks; retain that check here for callers that race a process edge.
    if (this.trackedAgent?.alive && this.trackedAgent.slug && this.trackedAgent.slug !== signal.agent) return false;
    const seeded = detector.seedTrustedIdentity(signal.agent, detector.getIdentityEpoch());
    if (seeded) this.recheckQuietApproval(detector);
    return seeded;
  }

  /** Ends the cycle noteCodexTitleSpinner armed if it is still that cycle and
   *  no hook claimed it (a submit, an idle or a new burst starts another). */
  private releaseTitleCycle(): void {
    if (this.titleCycleTimer) {
      clearTimeout(this.titleCycleTimer);
      this.titleCycleTimer = null;
    }
    if (this.titleCycleStillPending() && this.sessionId) this.activityMonitor?.endTurn(this.sessionId);
    this.titleArmedCycle = null;
  }

  /** The cycle noteCodexTitleSpinner armed is still the monitor's current
   *  one, and no hook has claimed it. */
  private titleCycleStillPending(): boolean {
    const monitor = this.activityMonitor;
    return this.titleArmedCycle !== null && !!this.sessionId && !!monitor
      && monitor.cycleOf(this.sessionId) === this.titleArmedCycle && !this.hookArmedCycle;
  }

  /**
   * #1671 — the agent's server is gone under a live TUI (a restart): a turn it
   * was running is over, and a dialog it was waiting on went with it. Nothing
   * reports either (no Stop hook, no transcript end), so the episode ends here
   * and the next prompt starts a new one. A pane with no open turn and no
   * dialog is left as it is.
   */
  noteServerLost(): void {
    if (!this.turnOpen && !this.awaitingHuman) return;
    if (this.awaitingHuman) {
      this.awaitingHuman = false;
      this.awaitingQuestionAt = null;
      if (this.settledStatus === 'awaiting_input') this.settledStatus = 'waiting';
    }
    this.closeTurn();
  }

  /**
   * Start of the evidence a transcript end must postdate to count for the
   * current state: the last submit/hook, or a later byte-promoted episode.
   */
  getTurnEvidenceStartedAt(): number {
    return Math.max(this.lastTurnStartedAt, this.turnOpen ? this.turnOpenedAt : 0);
  }

  /**
   * The running episode as the phone sees it. `chatStatus` is the chat-refined
   * status (transcript end_turn / abort applied); `running` needs both an open
   * episode and a running or dialog-blocked status. `startedAt` is absent
   * before the first episode.
   */
  getTurn(chatStatus: AgentStatus): { id: string; state: 'running' | 'idle'; startedAt?: number } {
    const running = this.turnOpen && (chatStatus === 'running' || chatStatus === 'awaiting_input');
    return {
      id: `t1:${this.turnNonce}.${this.turnSeq}`,
      state: running ? 'running' : 'idle',
      ...(this.turnSeq > 0 ? { startedAt: this.turnOpenedAt } : {}),
    };
  }

  /**
   * Which episode an event that happened at `ts` belongs to. Hook delivery is
   * retried and interleaved, so a turn end can arrive after the next turn
   * opened. `current`: the open (or last) episode; otherwise the one before
   * it. Null when it predates both. Before the first episode: current, no id.
   */
  turnAt(ts: number): { turnId?: string; current: boolean } | null {
    if (this.turnSeq === 0) return { current: true };
    if (ts >= this.turnOpenedAt) return { turnId: `t1:${this.turnNonce}.${this.turnSeq}`, current: true };
    if (this.turnSeq > 1 && ts >= this.prevTurnOpenedAt) return { turnId: `t1:${this.turnNonce}.${this.turnSeq - 1}`, current: false };
    return null;
  }

  /**
   * The id of the latest episode when it is over for good: closed by a settle
   * that is not soft (a soft close resumes under the same id). Null while it
   * is open or soft-closed, or before the first episode.
   */
  endedTurnId(): string | null {
    if (this.turnSeq === 0 || this.turnOpen || this.turnSoftClosed) return null;
    return `t1:${this.turnNonce}.${this.turnSeq}`;
  }

  /**
   * Record a failed turn. A failure already held for the same turn (or, with
   * no turn id, any failure held since the last episode opened) is kept as
   * is, so every surface serves one `turnId`/`at`; `fresh` is false then.
   */
  noteTurnFailure(failure: TurnFailure, agentSessionId?: string): { failure: TurnFailure; fresh: boolean } {
    const held = this.lastFailure?.failure;
    if (held && held.turnId === failure.turnId) return { failure: held, fresh: false };
    this.lastFailure = { failure, ...(agentSessionId ? { agentSessionId } : {}) };
    return { failure, fresh: true };
  }

  /** The failure of the last turn, while no later turn has started. */
  getLastFailure(): { failure: TurnFailure; agentSessionId?: string } | undefined {
    return this.lastFailure ?? undefined;
  }

  /** When a lone Esc was last written to this PTY, from any source; 0 = never. */
  getLastEscAt(): number {
    return this.lastEscAt;
  }

  /**
   * Claude Code set its idle title with no Stop-hook row before it (#2264). An
   * Esc while it is still thinking ends the turn without the `⎿  Interrupted`
   * row, so this title is the only thing that confirms such an Esc. It is reported
   * as the same `turnInterrupted` the row raises, and only right after a lone
   * Esc reached this pane: every turn ends with this edge, and an ordinary
   * turn end is not an interrupt. Main still checks its own Escape record
   * before it settles. Dropped like the row inside a resize redraw or a muted
   * replay.
   */
  private noteTitleTurnEnd(sessionId: string): void {
    const now = Date.now();
    if (this.muted || now - this.lastResizeAtMs < RESIZE_REDRAW_GUARD_MS) return;
    if (now - this.lastEscAt >= ESC_INTERRUPT_CONFIRM_MS) return;
    // One Esc confirms one turn: a later idle title inside the same window
    // belongs to a turn that Esc never touched.
    if (this.lastEscAt === this.titleEdgeEscAt) return;
    if (this.agentDetector?.getLastAgent() !== 'Claude Code') return;
    this.titleEdgeEscAt = this.lastEscAt;
    this.closeInterruptedTurn();
    this.emit('turnInterrupted', { sessionId, agent: 'Claude Code' });
  }

  /**
   * The agent reported its turn interrupted (its own row, or Claude Code's
   * idle title right after a lone Esc). No Stop hook follows an interrupt, so
   * the episode ends here: otherwise it stays open, and the pane keeps reading
   * as mid-turn (`agent.turn`) until the next prompt. Also behind a dialog:
   * the interrupt ended the turn the dialog belonged to, and the dialog's own
   * state (awaitingHuman) still drives the display until it is gone. Only on
   * this turn's own interrupt: a lone Esc (or the agent's own interrupt,
   * noteInterrupt) since the episode opened and within the confirm window. A
   * redraw can reprint an older turn's row, which says nothing of this one.
   */
  private closeInterruptedTurn(): void {
    if (!this.turnOpen && !this.turnSoftClosed) return;
    if (Date.now() - this.lastEscAt >= ESC_INTERRUPT_CONFIRM_MS || this.lastEscAt < this.turnOpenedAt) return;
    this.closeTurn();
  }

  /**
   * The agent's own interrupt reached this pane's turn without a key (Codex
   * `turn/interrupt`): recorded like a lone Esc, so the once-per-turn latch
   * and the cooldown hold for every later Stop, phone or desktop. Nothing
   * else a key would change (input revision, answered prompts) moves.
   */
  noteInterrupt(): void {
    this.lastEscAt = Date.now();
  }

  /** The latest window title the program set, and when (`at` 0 = never). */
  getTitle(): { title: string; at: number } {
    return { title: this.lastTitle, at: this.lastTitleAt };
  }

  /**
   * #1463 — the agent's SessionStart hook (fired at `signalTs`). Applies the
   * hook's own `running` edge like every other hook, then marks the pane
   * pre-turn — but only for a source that begins a session with no turn, and
   * only when the hook fired after the last turn evidence arrived.
   *
   * If the boot already ended on the detector's idle prompt, no silence idle
   * will follow, so the pre-turn idle is reported here.
   */
  noteSessionStart(signalTs: number, source: unknown): void {
    const atIdlePrompt = this.explicitTerminalStatus && this.settledStatus === 'waiting' && !this.awaitingHuman;
    const { preTurn, turnEvidenceAt, turnOpen, turnSeq, turnOpenedAt, prevTurnOpenedAt, turnSoftClosed, codexBootWindow, bootEpisode, byteOpenedTurn, spinnerOpenedTurn, lastFailure } = this;
    this.noteAgentStatus('running', true);
    this.codexBootWindow = codexBootWindow;
    // The session start is not turn evidence itself: a duplicate delivery of
    // it must neither clear nor re-set the state the first one left. Nor does
    // it touch the running episode: Codex fires its SessionStart inside the
    // first turn, and a resume or a compaction continues the one there was.
    this.preTurn = preTurn;
    this.turnEvidenceAt = turnEvidenceAt;
    this.turnOpen = turnOpen;
    this.turnSeq = turnSeq;
    this.lastFailure = lastFailure;
    this.turnOpenedAt = turnOpenedAt;
    this.prevTurnOpenedAt = prevTurnOpenedAt;
    this.turnSoftClosed = turnSoftClosed;
    this.bootEpisode = bootEpisode;
    this.byteOpenedTurn = byteOpenedTurn;
    this.spinnerOpenedTurn = spinnerOpenedTurn;
    this.reportMidTurn();
    if (!isFreshSessionSource(source)) {
      this.preTurn = false;
      return;
    }
    if (signalTs < turnEvidenceAt) return;
    this.preTurn = true;
    // `/clear` is a command, not a turn: no Stop ends the episode its Enter opened.
    if (source === 'clear' && this.turnOpen && !this.awaitingHuman) {
      this.closeTurn();
      // The Enter armed an activity cycle too; with no output after it, it would keep reading running.
      if (this.activityMonitor && this.sessionId) this.activityMonitor.endTurn(this.sessionId);
    }
    if (atIdlePrompt && this.sessionId) this.emit('idle', { sessionId: this.sessionId, preTurn: true });
  }

  /**
   * #1610 — Codex fires no SessionStart before its first turn, so the banner
   * row it draws at boot stands in for one: the pane is pre-turn until the
   * next turn evidence. The row is also redrawn mid-turn (a resize, an
   * overlay) and can appear in a reply or in a later shell command's output,
   * so it counts only while all of these hold:
   *   - the boot window is open: a program was launched (OSC 133 C, or the
   *     pane spawned) and no submit, answer or hook has arrived since;
   *   - no dialog is up;
   *   - the pane's agent is Codex and a program owns the input: zsh and bash
   *     turn bracketed paste off before running a command, and Codex turns it
   *     back on before it paints, so plain command output does not qualify.
   * Only `preTurn` moves; the episode and `hookSeen` are left as they were.
   * `turnOpen` is not a guard: before any turn evidence it can only be the
   * boot burst's own byte promotion.
   */
  private noteCodexOutput(data: string): void {
    const text = this.codexBannerTail + data;
    // A row can straddle two PTY chunks; keep enough of the tail to rejoin it.
    this.codexBannerTail = text.slice(-DaemonPTYBridge.CODEX_BANNER_TAIL);
    if (!this.codexBootWindow || this.awaitingHuman) return;
    if (this.agentDetector?.getLastAgent() !== 'Codex CLI' || !this.modeTracker?.isSet(2004)) return;
    if (drawsCodexBanner(text)) this.preTurn = true;
  }

  /**
   * #1463 — a session started and no turn has started since: no submitted
   * input, no answer, no other hook. Output in this state is the TUI booting
   * (or redrawing after `/clear`), so the silence after it ends nothing and
   * main may settle it. The Enter that launched the agent came before its
   * SessionStart, so it does not count as a turn.
   */
  isPreTurn(): boolean {
    return this.preTurn;
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
    /**
     * #2771 — how the pane's process writes OSC 133 marks: `exec` runs a
     * program with no shell (it never prompts), `integrated` is a shell with
     * wmux's integration (it marks every prompt with `D;<n>` and `A`),
     * `plain` anything else, whose marks are passed through unread. Absent:
     * `plain`.
     */
    shellMarks: 'exec' | 'integrated' | 'plain' = 'plain',
  ): void {
    const interpreter = new OutputInterpreter((ptyProcess as TerminalPty).backend === 'rust' ? 'rust' : 'node');
    this.outputInterpreter = interpreter;

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
    const modeTracker = interpreter.modes;
    this.modeTracker = modeTracker;
    const prefilled = ringBuffer.readAll();
    if (prefilled.length > 0) {
      interpreter.seedModes(prefilled.toString('utf8'), ringBuffer.totalBytesWritten);
    }
    // A bridge is built only for a freshly spawned process (a recovered
    // ring holds the dead one's scrollback), so an integrated shell starts at
    // its prompt and an exec unit's program starts running.
    const marks = shellMarks === 'plain' ? null : new ShellMarkIngress(shellMarks === 'exec' ? 'running' : 'idle',
      () => console.log(`[pty] ${sessionId}: program-written OSC 133 marks lowercased (shell command running)`));

    // With OSC 133 parsed here, the detector ends the agent on its markers in
    // stream order itself (see the command start/end branch below).
    const agentDetector = new AgentDetector({ launchBoundaries: !!promptLog });
    this.parsesOsc133 = !!promptLog;
    this.agentDetector = agentDetector;
    this.identityLifetimeAt = Date.now();

    this.sessionId = sessionId;
    this.explicitTerminalStatus = false;
    this.submittedTurnPending = false;
    this.hookArmedCycle = false;
    this.inputInBracketedPaste = false;
    this.lastInputAt = 0;
    this.settledStatus = null;
    this.settledAtMs = 0;
    this.awaitingHuman = false;
    // A pane spawned straight into a program (a chat launch) boots it with no OSC 133 C.
    this.codexBootWindow = true;
    this.codexBannerTail = '';

    const activityMonitor = new ActivityMonitor();
    this.activityMonitor = activityMonitor;
    activityMonitor.start(sessionId);

    // Activity → idle notification. Once a detector or hook has already
    // settled this turn, byte silence is weaker evidence and must not clear the
    // explicit waiting/complete state five seconds later.
    this.idleUnsubscribe = activityMonitor.onActiveToIdle((ptyId) => {
      this.hookArmedCycle = false;
      this.titleArmedCycle = null;
      // F24: an episode only output opened, on a hook pane, ends when that
      // output stops (see `byteOpenedTurn`). Five seconds of byte silence
      // means no spinner either; the spinner title is output too. Softly, so
      // the next hook of a real turn resumes the same episode.
      if (this.byteOpenedTurn && !this.awaitingHuman) this.closeTurn(true);
      // #2673: on a pane whose hooks have not reported, nothing else ends a
      // turn: no Stop hook, and Claude Code's idle prompt draws nothing the
      // detector reads. Claude Code refreshes its running title about once a
      // second for the whole turn, so silence under its idle title `✳` is the
      // turn over. Not the title edge alone: Claude Code also sets `✳` the
      // moment a permission dialog opens, a few ms before the dialog's rows,
      // and by now the detector has seen those (awaitingHuman). Softly, as a
      // detector settle: a later running edge resumes the episode.
      // Only a turn Claude Code's spinner ran in (a sample newer than the
      // episode's start), under an idle title set after that sample.
      if (
        this.turnOpen && !this.bootEpisode && !this.hookSeen && !this.awaitingHuman
        && this.paneAgentTitlesTurns()
        && this.claudeRunningTitleAt > 0 && this.claudeRunningTitleAt >= this.turnOpenedAt
        && titleShowsFinishedTurn({ title: this.lastTitle, at: this.lastTitleAt }, 'claude', this.claudeRunningTitleAt)
      ) this.closeTurn(true);
      // A quiet stretch of a turn the program says is running is not idle,
      // up to a bound (armProgramQuietCheck).
      if (this.programWorking()) {
        this.armProgramQuietCheck(ptyId);
        return;
      }
      // A submit the program never turned into work (an empty Enter, a slash
      // command): it is still at the state it last reported, so the turn the
      // submit opened ends with the silence, settled as that state.
      const root = this.programStatusSeen && this.turnOpen && !this.awaitingHuman ? this.programStatus.root() : undefined;
      if (root && root.state !== 'working' && root.state !== 'blocked' && this.lastTurnStartedAt >= this.programStateAt) {
        this.closeTurn(true);
        this.settledStatus = root.state === 'idle' ? 'waiting' : 'complete';
        this.explicitTerminalStatus = true;
        this.emit('idle', { sessionId: ptyId, ...(this.isPreTurn() ? { preTurn: true } : {}) });
        return;
      }
      if (this.explicitTerminalStatus) return;
      this.emit('idle', { sessionId: ptyId, ...(this.isPreTurn() ? { preTurn: true } : {}) });
    });
    // Activity → active notification. A submitted turn is re-armed by
    // beginTurn(), so its very first output emits running even for a short
    // reply. A settled pane can be promoted too, but only by a burst that
    // cleared the threshold from a cycle the turn end re-armed, with the user's
    // keystrokes quiet and outside the resize-redraw window — the three things
    // that separate an autonomous turn from echo and repaints.
    this.activeUnsubscribe = activityMonitor.onActive((ptyId) => {
      // Output reached the cycle and started its idle countdown: whatever
      // armed it, it can no longer read running forever.
      this.titleArmedCycle = null;
      let likelyRepaint = false;

      if (this.explicitTerminalStatus) {
        // A pane blocked on a human is never retired by bytes — it stays in
        // the "needs you" count until a person answers, however much a
        // subagent paints behind the prompt. Read from the sticky flag rather
        // than `settledStatus`, which a later detector `waiting` off the footer
        // under the approval box would otherwise overwrite.
        if (this.awaitingHuman) return;
        // The program settled the pane itself (OSC 7501): bytes cannot
        // contradict it. Its next `working` report starts the next turn. A
        // pane something else settled while the program says working (a
        // provisional hook Stop between tool calls) is promoted as before.
        if (this.programStatusSeen && !this.programWorking()) {
          activityMonitor.endTurn(ptyId);
          return;
        }

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
        // F24: on a hook pane, a burst under Claude Code's idle title is its
        // own post-turn paint (the recap, a repaint on attach), not a turn.
        // Such a burst is held: the spinner title of a real turn may follow it
        // (see noteSpinnerTitle).
        const now = Date.now();
        if (
          now - this.settledAtMs < DaemonPTYBridge.SETTLE_COOLDOWN_MS
          || !this.isInputQuiet()
          || now - this.lastResizeAtMs < RESIZE_REDRAW_GUARD_MS
        ) {
          activityMonitor.endTurn(ptyId);
          return;
        }
        if (this.idleTitleOnHookPane()) {
          this.heldBurstAt = now;
          activityMonitor.endTurn(ptyId);
          return;
        }
        this.explicitTerminalStatus = false;
        this.settledStatus = null;
        this.submittedTurnPending = false;
        const wasOpen = this.turnOpen;
        this.openTurn(true);
        if (!wasOpen && this.hookSeen) this.byteOpenedTurn = true;
        // Deliberately NOT resetEmissionState(). The unsettled path below
        // clears the detector's dedup so a new turn's footer can speak again;
        // doing it here would let the idle chrome that is still on screen
        // answer the `complete` this pane just recorded with a stale
        // `waiting` — trading a silent wrong status for a loud one.
      } else {
        const inputStartedTurn = this.submittedTurnPending;
        this.submittedTurnPending = false;
        const hookArmed = this.hookArmedCycle;
        this.hookArmedCycle = false;
        const spinnerArmed = this.spinnerArmedCycle;
        this.spinnerArmedCycle = false;

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
            // A resize repaint is not work, so it does not reach the status
            // dot either. Revealing a workspace refits its panes, and an idle
            // TUI (Codex) repaints the whole screen, well over the threshold:
            // emitting `active` here lit an idle pane "running", and the
            // unmarked idle that followed left it lit for the renderer's
            // two-minute activity window. Like the settled rejections above,
            // hand the cycle back instead of consuming it, so a real turn that
            // keeps writing past the guard window still reports running.
            // A cycle a hook's running edge armed is exempt while that turn is
            // still open: handing it back would drop the hook's signal to the
            // byte threshold for the rest of a sparse-output turn. Only the
            // arming edge counts, not `turnOpen` alone: a boot paint or a
            // submitted prompt that never got a settle also leaves the turn
            // open, and its reveal repaint is still not work.
            if (!(hookArmed && this.turnOpen)) {
              activityMonitor.endTurn(ptyId);
              return;
            }
          } else {
            if (!spinnerArmed) this.agentDetector?.resetEmissionState();
            const wasOpen = this.turnOpen;
            this.openTurn(true);
            if (!wasOpen && this.hookSeen) this.byteOpenedTurn = true;
          }
        }
      }

      // gate로 확정된 에이전트 이름을 active 이벤트에 함께 싣는다. main의
      // DaemonNotificationRouter는 daemon AgentDetector에 직접 닿지 못하지만,
      // 같은 daemon 프로세스인 여기서는 getLastAgent()가 닿는다. 이게 있어야
      // idle prompt 패턴이 안 잡히는 에이전트(Claude Code v2.1.x 등)도 running
      // 상태에서 agentName이 채워진다.
      // `likelyRepaint` is true only for a cycle a hook's running edge armed
      // in a still-open turn whose first output landed inside the
      // resize-redraw guard window; every other burst in that window returned
      // above. The status dot shows that hook turn running, but the alarm's
      // working feed in daemon/index.ts must NOT treat the burst as turn
      // evidence — a repaint rebutting a pending completion window would
      // silently kill a real "finished" alarm.
      this.lastActiveAt = Date.now();
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
    // #2264: Claude Code's title turning idle right after a lone Esc (see noteTitleTurnEnd).
    const titleTurnEdge = new ClaudeTitleTurnEdge();
    interpreter.onOsc((event) => {
      if (event.code === 0 || event.code === 2) {
        // OSC 0/2 window title (e.g. Claude Code `/rename`). OSC 1 (icon-only)
        // is ignored. Sanitized here so the daemon→main payload is already safe.
        const title = sanitizeTitle(event.data);
        // Every title write, repeats included: chat Stop reads the agent's
        // running spinner here and needs to know how fresh it is.
        this.lastTitle = title;
        this.lastTitleAt = Date.now();
        if (title) this.emit('title', { sessionId, title });
        if (titleTurnEdge.observe(title)) this.noteTitleTurnEnd(sessionId);
        if (CLAUDE_RUNNING_TITLE.test(title)) this.noteSpinnerTitle();
        else if (this.spinnerOpenedTurn && this.turnOpen && !this.awaitingHuman && CLAUDE_IDLE_TITLE.test(title)) this.endSpinnerTurn();
        this.noteTitleAwaitingHuman(sessionId);
        this.noteClaudeTitle(title);
        this.noteCodexTitleSpinner(sessionId);
        return;
      }
      if (event.code === 7) {
        // app-weight P1-4: dedup identical OSC 7 emissions. Shells re-emit
        // OSC 7 on every prompt redraw, so an idle pane would otherwise spam
        // the same cwd across daemon→main→renderer on each redraw. Mirrors
        // the prompt-detect guard (lastDetectedPromptCwd) below; the first OSC 7
        // after spawn always emits because the cache starts null. A report
        // that is not a local folder is ignored and the previous cwd stays.
        const cwd = this.wslDistro ? parseOsc7Cwd(event.data, null) : parseOsc7Cwd(event.data);
        if (cwd === null) return;
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
      if (event.code === PROGRAM_STATUS_OSC) {
        this.noteProgramStatus(event.data);
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
          if (parsed.type === 'command_end') {
            // Input queued while a command runs can become history or a draft
            // at the next prompt. Completion must not erase that invalidation.
            this.completedShellCommand = this.shellCommandRunning && this.keyInputRevision === this.shellCommandKeyRevision;
            this.endedShellCommand = this.shellCommandRunning
              ? { keyRevision: this.shellCommandKeyRevision, endedAt: this.keyInputRevision, prompted: false }
              : null;
            this.shellCommandRunning = false;
          }
          if (parsed.type === 'command_start') {
            this.commandStarts += 1;
            this.shellCommandKeyRevision = this.shellSubmittedKeyRevision ?? this.keyInputRevision;
            this.shellSubmittedKeyRevision = undefined;
            this.shellCommandRunning = true; this.completedShellCommand = false; this.emptyShellPrompt = false;
            this.endedShellCommand = null;
          }
          // The shell's foreground program changed hands: whatever episode was
          // open (an agent's, or the Enter that launched the next one) is over.
          // The detector already cleared its identity at this marker, where it
          // sits in the stream (launchBoundaries). Clearing it again here,
          // after the whole read, wiped the gate the next agent's splash in
          // the same read had just opened (#2673).
          if (parsed.type === 'command_start' || parsed.type === 'command_end') this.noteAgentEnded(false);
          this.codexBootWindow = parsed.type === 'command_start' || (parsed.type !== 'command_end' && this.codexBootWindow);
          if (parsed.type === 'prompt_start' || parsed.type === 'prompt_end') this.shellPromptSeen = true;
          // A new shell prompt ends the program's working and blocked records (OSC 7501).
          if (parsed.type === 'prompt_start') this.endProgramStatusEpisode();
          if (parsed.type === 'prompt_end') {
            // The first prompt is empty when no key has reached the pane;
            // passive input (counted by inputRevision) does not type.
            this.emptyShellPrompt = this.keyInputRevision === 0 || this.completedShellCommand;
            this.completedShellCommand = false;
            if (this.endedShellCommand) this.endedShellCommand.prompted = true;
          }
          promptLog.append(parsed);
          this.emit('prompt', { sessionId, event: parsed });
        }
      }
    });

    // Agent detection. Apply status priority before forwarding the event so a
    // same-chunk/full-screen redraw cannot race a terminal state back to running.
    this.agentUnsubscribe = agentDetector.onEvent((agentEvent) => {
      // A program reporting its own status owns the turn. A dialog read off
      // the screen still counts: one the program does not report must not go
      // unseen.
      // The screen names another agent: the reporting one is gone.
      if (this.programStatusSeen && agentDisplayToSlug(agentEvent.agent) !== this.programAgentSlug) this.endProgramStatusEpisode();
      if (this.programMutesScreen(agentEvent.status)) return;
      const wasSettled = this.explicitTerminalStatus;
      // The question line of a box the agent's title (noteTitleAwaitingHuman)
      // or its own `blocked` report already raised: the same dialog, told once.
      const sameDialog = agentEvent.status === 'awaiting_input' && this.awaitingHuman && (this.titleRaisedAwaiting || this.awaitingFromProgram);
      this.noteAgentStatus(agentEvent.status);
      if (!sameDialog) this.emit('agent', { sessionId, event: agentEvent });
      // #1463 — the agent's idle prompt, before any turn. The status above
      // ends the byte cycle, so no silence idle follows it, and main withholds
      // a detector `waiting` on a hook-reporting pane: without this the boot
      // burst's running stamp was the pane's last word for 120 s. Same gate as
      // the silence idle: a pane an earlier status already settled is left be.
      if (agentEvent.status === 'waiting' && !wasSettled && this.isPreTurn()) {
        this.emit('idle', { sessionId, preTurn: true });
      }
    });

    // Critical action detection
    this.criticalUnsubscribe = agentDetector.onCritical((criticalEvent) => {
      this.emit('critical', { sessionId, event: criticalEvent });
    });
    this.usageLimitUnsubscribe = agentDetector.onUsageLimit((event) => {
      this.emit('usageLimit', { sessionId, event });
    });
    // The interrupt row stays in the transcript: a resize redraw or a muted
    // recovery replay prints it again for a turn that is long over.
    this.interruptedUnsubscribe = agentDetector.onInterrupted(({ agent }) => {
      if (this.muted || Date.now() - this.lastResizeAtMs < RESIZE_REDRAW_GUARD_MS) return;
      this.closeInterruptedTurn();
      this.emit('turnInterrupted', { sessionId, agent });
    });

    // Prompt-based CWD detection state
    let promptBuffer = '';

    const capture = (data: string, buf?: Buffer, nativeChunk?: NativeOutputChunk): void => {
      // Detached sessions need retention/analysis, but no JS byte copy. Snapshot
      // tees and live clients subscribe to data and materialize exactly once.
      let delivery = buf;
      const forward = () => {
        this.emit('outputActivity');
        if (this.listenerCount('data') > 0) {
          delivery ??= nativeChunk?.readBytes() ?? Buffer.from(data);
          this.emit('data', delivery);
        }
      };
      try {
        if (nativeChunk) ringBuffer.writeNativeChunk(nativeChunk);
        else ringBuffer.write(buf ?? Buffer.from(data));
        // AFTER the ring write: the tracker's offsets are in the ring's own
        // coordinate system, so it needs the counter this chunk already moved.
        // Before the titles in this chunk are read (see ClaudeTitleTurnEdge.noteOutput).
        titleTurnEdge.noteOutput(data);
        // RIS removes every OSC 7501 record, in stream order against this
        // chunk's last report: before it, the report stands; after it, it goes.
        const risCarry = this.outputEndsWithEsc;
        this.outputEndsWithEsc = data.endsWith('\x1b');
        let risAfterReports = false;
        if (this.programStatus.size > 0 || this.programStatusSeen || data.includes('\x1b]7501;')) {
          const risAt = Math.max(data.lastIndexOf('\x1bc'), risCarry && data.startsWith('c') ? 0 : -1);
          if (risAt >= 0) {
            if (risAt > data.lastIndexOf('\x1b]7501;')) risAfterReports = true;
            else this.resetProgramStatus();
          }
        }
        interpreter.feed(data, ringBuffer.totalBytesWritten, nativeChunk);
        if (risAfterReports) this.resetProgramStatus();
        // After the mode tracker and OSC 133 have seen this chunk (see noteCodexOutput).
        this.noteCodexOutput(data);

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
            if (detectedCwd !== this.lastDetectedPromptCwd) {
              this.lastDetectedPromptCwd = detectedCwd;
              this.emit('cwd', { sessionId, cwd: detectedCwd });
            }
            promptBuffer = '';
          }
        }

        forward();
        // Output on a pane blocked on a human may be the dialog closing (see
        // `clearAwaiting`); the daemon re-reads the screen off this.
        if (this.awaitingHuman) this.emit('awaitingActivity', { sessionId, cause: 'output' });
      } catch (err) {
        // Still forward raw data even if parsing failed
        forward();
      }
    };
    this.captureChunk = capture;

    // PTY data handler
    const onOutput = (data: string, nativeChunk?: NativeOutputChunk) => {
      // Ahead of the mute check: a recovered session is muted at spawn, and
      // its startup query is exactly the one nobody else will answer.
      if (this.startupDa1) this.checkStartupDa1(data, ptyProcess);
      this.lastOutputAt = Date.now();

      // #2771 — before anything reads the chunk: a mark the running program
      // wrote (not the shell) gets a lowercase kind, so the detector, the
      // held chunks, the ring, the interpreter and live data all read the
      // same decision. Only a chunk that can hold a mark is scanned.
      if (marks) {
        const decided = marks.apply(data);
        if (decided !== data) {
          data = decided;
          // The native chunk's bytes no longer match: it leaves the zero-copy
          // path. A chunk with only the shell's marks keeps it.
          nativeChunk = undefined;
        }
      }
      const buf = nativeChunk ? undefined : Buffer.from(data);
      const byteLength = nativeChunk ? nativeChunk.byteLength : (buf?.length ?? 0);

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
      if (!this.muted && (!this.explicitTerminalStatus || this.isInputQuiet())) {
        // Only the settled hook-pane gate reads it (see idleTitleOnHookPane).
        this.chunkSetsSpinnerTitle = this.explicitTerminalStatus && this.hookSeen
          && CLAUDE_RUNNING_TITLE_OSC.test(data);
        try {
          activityMonitor.feed(sessionId, byteLength);
        } catch {
          // activity heuristics must never block detection or data forwarding.
        }
        this.chunkSetsSpinnerTitle = false;
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
      // A grid-only question this chunk finished (approvalReady): read the
      // screen once the chunk is in the ring, below. Muted, it is dropped.
      const approvalRecheck = agentDetector.takeApprovalRecheckRequest();

      // Muted: keep the chunk out of the ring before any side effect. Recovery
      // sessions run muted until their first resize so the geometry mismatch
      // window (Bug 2 in v2.8.0) doesn't pollute the ring buffer. The chunk is
      // held (bounded, head kept) so the unmute can release what was produced
      // at the geometry the renderer shows (#1464).
      if (this.muted) {
        if (this.heldWhileMuted && !this.heldFull) {
          if (this.heldBytes + byteLength > DaemonPTYBridge.MAX_HELD_BYTES) {
            this.heldFull = true;
          } else {
            this.heldBytes += byteLength;
            this.heldWhileMuted.push(data);
          }
        }
        if (this.heldWhileMuted && this.heldFull) {
          this.heldTail ??= new RingBuffer(DaemonPTYBridge.MAX_HELD_TAIL_BYTES, 'node');
          this.heldTail.write(buf ?? nativeChunk?.readBytes() ?? Buffer.from(data));
        }
        return;
      }
      capture(data, buf, nativeChunk);
      if (approvalRecheck) this.recheckQuietApproval(agentDetector);
    };
    const nativePty = ptyProcess as TerminalPty;
    const onDataDisposable = nativePty.onNativeData
      ? nativePty.onNativeData(chunk => onOutput(chunk.text, chunk))
      : ptyProcess.onData(onOutput);
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
      // The process is gone: its working and blocked records go with it.
      this.endProgramStatusEpisode();
      this.emit('exit', { sessionId, exitCode, signal });
    });
    this.exitDisposable = () => onExitDisposable.dispose();
  }

  /**
   * #1965: answer the bundled OpenConsole's startup DA1 from the daemon.
   *
   * OpenConsole writes `CSI c` before anything else and then holds all of the
   * shell's output until a terminal answers, or for about 3 s. A fresh pane's
   * query lands in the ring before any renderer is receiving live bytes, and
   * every replay path strips queries (replayQuerySanitizer), so no xterm ever
   * answers it and each new pane started 3 s late.
   *
   * Answered exactly once, and only when all of these hold:
   *  - the bare `CSI c` is among the PTY's first bytes, with nothing but CSI
   *    sequences in front of it (any other byte closes the window for good);
   *  - `canAnswer()` says so at that moment. The session manager makes that
   *    "bundled backend, and no viewer is receiving this chunk live".
   *
   * No race with the renderer under that gate: the decision is made inside
   * the same synchronous data callback that decides where the chunk goes.
   * If a viewer receives it live, that viewer's xterm answers and the daemon
   * does not; if none does, the chunk only ever reaches a viewer through a
   * replay, which strips the query, so the daemon is the only responder. (An
   * attach flush's live delta counts as replay: it is written before the
   * flush-done marker, and the desk sanitizes everything before the marker.)
   *
   * The reply goes straight to `ptyProcess.write`, not through `noteInput`:
   * it is not user input, and nothing that tracks input (drafts, submits,
   * detector dedup, typed-input or fence events) may see it.
   */
  /** The shell runs in a WSL distro on this machine (see wslDistro). */
  markWslDistro(): void {
    this.wslDistro = true;
  }

  armStartupDa1Reply(canAnswer: () => boolean, onAnswered?: () => void): void {
    this.startupDa1 = { scanned: '', canAnswer, onAnswered };
  }

  private checkStartupDa1(data: string, ptyProcess: IPty): void {
    const pending = this.startupDa1;
    if (!pending) return;
    const text = pending.scanned + data;
    const verdict = scanStartupDa1(text);
    if (verdict === 'more' && text.length <= STARTUP_DA1_SCAN_BYTES) {
      pending.scanned = text;
      return;
    }
    // One decision per session, answered or not.
    this.startupDa1 = null;
    if (verdict !== 'answer' || !pending.canAnswer()) return;
    try {
      ptyProcess.write(STARTUP_DA1_REPLY);
      pending.onAnswered?.();
    } catch {
      // The PTY is already gone: nothing is waiting for the answer.
    }
  }

  /**
   * Mute or unmute PTY output capture. While muted, the data handler
   * drops chunks; ringBuffer pre-fill from saved scrollback (set up by
   * the caller before forwarding starts) is preserved.
   *
   * Muting starts holding the dropped chunks. Unmuting with `replayHeld`
   * pushes them through the normal capture path (ring + clients) in order,
   * the head and then the tail (see heldTail); without it they are
   * discarded, as before (#1464).
   *
   * The replay goes out as LIVE bytes (after the attach flush), so terminal
   * queries in it — DA1/DSR/OSC color probes the program sent at startup and
   * has long since stopped waiting for — would make xterm answer late, and the
   * answer would land in the program's input. They are stripped first, with
   * the same sanitizer the attach-time ring replay goes through.
   */
  setMuted(muted: boolean, opts?: { replayHeld?: boolean }): void {
    // Unmuting a recovered pane releases a full repaint at the new geometry,
    // and `noteResize` only stamps when the dimensions actually CHANGED — a
    // pane recovered at the size it was saved at gets the storm with no guard
    // behind it. Stamp the same guard here so that repaint cannot be read as
    // the agent starting a turn. Muted panes feed nothing, so the window is
    // empty and the storm would otherwise clear the threshold on its own.
    if (this.muted && !muted) this.lastResizeAtMs = Date.now();
    const held = this.heldWhileMuted;
    // Read before the hold is reset below, which releases the tail.
    const replay = !muted && opts?.replayHeld && held ? Buffer.concat([Buffer.from(held.join('')), tailBytes(this.heldTail).bytes]) : null;
    if (muted !== this.muted) {
      this.heldWhileMuted = muted ? [] : null;
      this.heldBytes = 0;
      this.heldFull = false;
      this.dropHeldTail();
    }
    this.muted = muted;
    if (replay && replay.length > 0 && this.captureChunk) {
      const buf = stripReplayQuerySequences(replay);
      if (buf.length > 0) this.captureChunk(buf.toString(), buf);
    }
  }

  /**
   * #1464: forget what was held so far but keep holding. Called right before a
   * muted PTY is resized to a new geometry (not on the bundled ConPTY, which
   * sends nothing on resize to replace them, #1965) — the chunks already held were
   * produced at the old size, while the shell's SIGWINCH repaint (the prompt
   * at the new size) arrives after it and is what the unmute should release.
   */
  discardHeld(): void {
    if (!this.muted) return;
    this.heldWhileMuted = [];
    this.heldBytes = 0;
    this.heldFull = false;
    this.dropHeldTail();
  }

  private dropHeldTail(): void {
    this.heldTail?.dispose();
    this.heldTail = null;
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

  /** Authoritative status snapshot used when the desktop reconnects. */
  getAgentStatus(): AgentStatus {
    if (this.awaitingHuman) return 'awaiting_input';
    if (this.settledStatus) return this.settledStatus;
    if (this.programWorking()) return 'running';
    if (this.sessionId && this.activityMonitor?.isActive(this.sessionId)) return 'running';
    return 'idle';
  }

  /** Whether the bridge is currently dropping PTY output. */
  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * The output that arrived while muted, for a screen read; null when not
   * muted. `total`: its bytes so far. `read()`: the bytes, oldest first, all of
   * them while the head and tail (see heldWhileMuted, heldTail) still join up,
   * else the tail alone (tailBytes), `dropped` being the bytes before it.
   * Read-only: the unmute still releases the hold.
   */
  heldOutput(): { total: number; read(): { data: Buffer; dropped: number } } | null {
    const head = this.heldWhileMuted;
    if (!head) return null;
    const tail = this.heldTail;
    const headBytes = this.heldBytes;
    return {
      total: headBytes + (tail?.totalBytesWritten ?? 0),
      read: () => {
        const { bytes, lost } = tailBytes(tail);
        if (lost === 0) return { data: Buffer.concat([Buffer.from(head.join('')), bytes]), dropped: 0 };
        return { data: bytes, dropped: headBytes + lost };
      },
    };
  }

  cleanup(): void {
    if (this.titleCycleTimer) clearTimeout(this.titleCycleTimer);
    this.titleCycleTimer = null;
    this.dataDisposable?.();
    this.dataDisposable = null;
    this.startupDa1 = null;

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
    this.usageLimitUnsubscribe?.();
    this.usageLimitUnsubscribe = null;
    this.interruptedUnsubscribe?.();
    this.interruptedUnsubscribe = null;

    // Stop activity monitor to clear timers and state
    if (this.activityMonitor && this.sessionId) {
      this.activityMonitor.stop(this.sessionId);
    }

    this.lastEmittedOscCwd = null;
    this.explicitTerminalStatus = false;
    this.submittedTurnPending = false;
    this.hookArmedCycle = false;
    this.inputInBracketedPaste = false;
    this.lastInputAt = 0;
    this.inputRevision = 0;
    this.keyInputRevision = 0;
    this.lastKeyInputAt = 0;
    this.shellCommandRunning = false;
    this.shellPromptSeen = false;
    this.shellSubmittedKeyRevision = undefined;
    this.shellCommandKeyRevision = 0;
    this.endedShellCommand = null;
    this.emptyShellPrompt = false;
    this.completedShellCommand = false;
    this.settledStatus = null;
    this.settledAtMs = 0;
    this.preTurn = false;
    this.turnEvidenceAt = 0;
    this.codexBootWindow = false;
    this.codexBannerTail = '';
    this.trackedAgent = null;
    this.lastActiveAt = 0;
    this.transcriptTurnEndAt = 0;
    this.turnOpen = false;
    this.turnSoftClosed = false;
    this.bootEpisode = false;
    this.reportedMidTurn = false;
    this.byteOpenedTurn = false;
    this.heldBurstAt = 0;
    this.spinnerArmedCycle = false;
    this.spinnerOpenedTurn = false;
    this.hookSeen = false;
    this.programStatusSeen = false;
    this.programAgentSlug = null;
    if (this.programQuietTimer) clearTimeout(this.programQuietTimer);
    this.programQuietTimer = null;
    this.lastOutputAt = 0;
    this.programStateAt = 0;
    this.promptSubmittedAt = 0;
    this.programEpisodeEndAt = 0;
    this.programStatus.clear();
    this.outputEndsWithEsc = false;
    this.awaitingFromProgram = false;
    this.lastTitle = '';
    this.lastTitleAt = 0;
    this.awaitingHuman = false;
    this.outputInterpreter?.dispose();
    this.outputInterpreter = null;
    this.modeTracker = null;
    this.agentDetector?.clearTrustedIdentity();
    this.agentDetector = null;
    this.activityMonitor = null;
    this.sessionId = null;

    this.removeAllListeners();
  }
}
