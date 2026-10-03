/**
 * Chat v2 daemon contract: the driver interface each agent implements, the
 * host the daemon wires into its RPC table, approval registry and phone
 * routes, and the persisted record. See src/shared/chatv2/ipc.ts for the
 * wire contract and its rules.
 *
 * Layering:
 *   index.ts ──(ChatV2HostDeps)──▶ ChatV2Host ──▶ one ChatV2Driver per record
 *   - The host owns records (one per anchor pane), seq/epoch stamping, the
 *     authoritative fold and its uncapped shadow, persistence, batching,
 *     subscriptions, the send ledger and the ApprovalRegistry bridge.
 *   - A driver owns exactly one agent process and translates its protocol to
 *     HarnessEvents and back. It never touches the registry, the store or a
 *     socket.
 */
import type { DaemonEvent } from '../../../shared/rpc';
import type { HarnessEvent } from '../../../shared/chatv2/harnessEvents';
import {
  CHATV2_PUSH_EVENT,
  type ChatV2Agent,
  type ChatV2Binding,
  type ChatV2EventsPush,
  type ChatV2Method,
  type ChatV2ParamsByMethod,
  type ChatV2ResultByMethod,
  type ChatV2RunMode,
  type ChatV2Status,
} from '../../../shared/chatv2/ipc';
import type { FormQuestion } from '../../../shared/chatv2/questions';
import type { HarnessId, Session } from '../../../shared/chatv2/session';
import type { ApprovalRegistry } from '../../approvals/ApprovalRegistry';
import type { NativeDecisionOutcome, NativeDecisionRef, NativeDecisionReply } from '../../approvals/types';
import type { DaemonSessionManager } from '../../DaemonSessionManager';

/** The push's DaemonEvent type, checked against the union in shared/rpc.ts. */
export const CHATV2_DAEMON_EVENT: DaemonEvent['type'] = CHATV2_PUSH_EVENT;

// --- driver -------------------------------------------------------------

export interface ChatV2DriverStart {
  /** The anchor pane's cwd when the record was created. */
  cwd: string;
  /**
   * Final child env, already built by the host (`buildDriverEnv`): the pane's
   * own env without wmux internals and agent-nesting markers, PATH widened
   * to the login shell's, then `WMUX_PTY_ID` = the anchor pane id and
   * `WMUX_GATE=0` (no PreToolUse gate card next to the stream approval). A
   * driver adds nothing to it.
   */
  env: Record<string, string>;
  mode: ChatV2RunMode;
  /** '' = the agent's default. Otherwise `CHATV2_MODEL`, passed as one `--model=<id>` argument. */
  model: string;
  /**
   * The agent conversation id (`CHATV2_PROVIDER_SESSION_ID`). `new`: start a
   * conversation with this id (Claude `--session-id`); `resume`: continue it
   * (Claude `--resume`). Either way it appears in the agent's argv, which is
   * the marker the orphan sweep matches.
   */
  providerSession: { id: string; mode: 'new' | 'resume' };
}

/** A user turn as the driver sends it. Attachments are staged paths the host already checked. */
export interface ChatV2DriverTurn {
  text: string;
  attachments: Array<{ path: string; mimeType: string }>;
}

/**
 * A decision the agent is blocked on. The host records it with
 * `ApprovalRegistry.noteNativeDecision({ sessionId: paneId, agent,
 * native: { adapter: agent, requestId, threadId: chatSessionId, relayId:
 * epoch }, form, question, toolName, summary })` before it stamps the
 * matching transcript event, using the same form shapes as the OpenCode
 * adapter:
 *   permission → `{ v: 1, kind: 'permission', actions: [{ id: 'approve',
 *                label: 'Allow once' }, { id: 'deny', label: 'Reject' }] }`
 *   questions  → `{ v: 1, kind: 'questions', questions,
 *                actions: [{ id: 'submit', label: 'Submit' }, { id: 'deny',
 *                label: 'Dismiss' }] }`
 * Fail-closed: if that returns null, or the record is on the `none` channel,
 * the host immediately calls `driver.answer(requestId, { decision: 'deny', … })`
 * and stamps `approval.resolved` / `question.resolved` with `cancelled`.
 * The driver emits `approval.requested` (with the gated tool's `callId`) or
 * `question.asked` with the same `requestId`.
 */
export type ChatV2DriverDecision =
  | {
      kind: 'permission';
      requestId: string;
      /** The card's question line, e.g. `Allow Bash?`. */
      question: string;
      toolName: string;
      /** One line for the card and the phone (command, path, …). */
      summary: string;
    }
  | {
      kind: 'questions';
      requestId: string;
      /** `formQuestions(question.asked questions)`: ids q0…, keys = option ids. */
      questions: FormQuestion[];
    };

export interface ChatV2DriverSink {
  event(event: HarnessEvent): void;
  decision(decision: ChatV2DriverDecision): void;
  /** The agent dropped a pending request on its own (answered elsewhere, turn ended). */
  decisionGone(requestId: string): void;
  /** The process exited; called once, after `session.ended`. */
  exited(info: { code: number | null; signal: string | null }): void;
}

export interface ChatV2Driver {
  readonly agent: HarnessId;
  /** The agent process pid once spawned. */
  readonly pid: number | undefined;
  /** Spawn and initialize. Rejects when the CLI is missing or fails its startup probe. */
  start(spec: ChatV2DriverStart, sink: ChatV2DriverSink): Promise<void>;
  /** Hand a user turn to the agent. Resolves once written, not when the turn ends. */
  send(turn: ChatV2DriverTurn): Promise<void>;
  /** Ask the agent to stop the open turn. False when there was nothing to stop. */
  interrupt(): Promise<boolean>;
  /**
   * Reply to one pending request. Idempotent per `requestId`: the first call
   * writes the reply, later calls return `not-found` without writing.
   * Questions: `reply.answers` → `replyFromAnswers` (questions.ts).
   */
  answer(requestId: string, reply: NativeDecisionReply): Promise<NativeDecisionOutcome>;
  /** Stop the process tree (`agentProcess.ts` tree kill, never a bare `child.kill`) and wait until it is reaped. */
  stop(): Promise<void>;
}

export type ChatV2DriverFactory = (agent: HarnessId) => ChatV2Driver | null;

// --- persisted record ---------------------------------------------------

/** What the orphan sweep compares before it kills anything. */
export interface ChatV2ProcessIdentity {
  pid: number;
  /** As `getProcessStartTime` reports it. */
  startTime: string;
  /** Must appear in the process command line: the provider session id. */
  marker: string;
}

/** `chat-sessions/v2/<chatSessionId>.json`, written atomically (temp + rename), mode 0600. */
export interface ChatV2StoredRecord {
  version: 1;
  paneId: string;
  chatSessionId: string;
  agent: ChatV2Agent;
  mode: ChatV2RunMode;
  model: string;
  /** `active` or the `handed-off` tombstone. */
  state: 'active' | 'handed-off';
  providerSessionId: string;
  /** The last seq folded into `session`. */
  seq: number;
  /** The capped, authoritative folded session. */
  session: Session;
  /** Full values the caps cut, by `<blockId>:<field>`; oldest dropped beyond CHATV2_BODY_STORE_MAX_BYTES. */
  bodies: Record<string, string>;
  /** Last CHATV2_SEND_LEDGER_MAX sends, oldest first. `digest` = sha256 of text + attachment paths. */
  sends: Array<{ clientMessageId: string; digest: string; seq: number }>;
  /** The driver process while one runs; cleared once it is reaped. */
  process?: ChatV2ProcessIdentity;
  savedAt: number;
}

// --- host ---------------------------------------------------------------

/** What index.ts supplies. Everything a host needs from the rest of the daemon. */
export interface ChatV2HostDeps {
  /** The wmux data dir: records under `chat-sessions/v2/`, staged images under `CHATV2_ATTACHMENT_DIR`. */
  wmuxDir: string;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  now: () => number;
  sessionManager: Pick<DaemonSessionManager, 'getSession'>;
  /** Null until the registry exists; a host without it offers no approvals. */
  approvals: () => ApprovalRegistry | null;
  /**
   * The single-writer check: true only when no agent process is tracked alive
   * in the pane AND its anchor shell is idle with no child processes.
   */
  paneFree: (paneId: string) => Promise<boolean>;
  /** Type into the anchor shell (toTerminal's resume command). */
  writeToPane: (paneId: string, data: string) => boolean;
  /**
   * Unicast a DaemonEvent to one pipe client. False = the socket is gone or
   * too far behind: the host drops its subscriptions and calls `dropClient`.
   */
  sendTo: (clientId: string, event: DaemonEvent) => boolean;
  /**
   * Close a client socket that could not take a push, so main reconnects and
   * re-subscribes instead of waiting on pushes that will never come.
   */
  dropClient?: (clientId: string) => void;
  /** Start time and command line of a live pid, or null when it is gone. */
  processIdentity: (pid: number) => Promise<{ startTime: string; commandLine: string } | null>;
  /** Tree kill. Call only after `processIdentity` matched a `ChatV2ProcessIdentity`. */
  killTree: (pid: number) => Promise<void>;
  /** Defaults to the built-in drivers. Tests pass fakes. */
  drivers?: ChatV2DriverFactory;
  /** Where a new driver runs (default: `driverCwd` in cwd.ts). Tests pass fakes. */
  driverCwd?: (meta: { spawnCwd?: string; pid?: number }) => Promise<string | undefined>;
  /**
   * Whether a pid exists, for the handoff's exit proof: `gone` only on proof
   * (ESRCH). Defaults to signal 0. Tests pass fakes.
   */
  processProbe?: (pid: number) => 'gone' | 'exists' | 'unknown';
}

export interface ChatV2Host {
  /** Run one first-party RPC. Params are already validated by `parseChatV2Params`. */
  call<M extends ChatV2Method>(method: M, params: ChatV2ParamsByMethod[M], clientId: string): Promise<ChatV2ResultByMethod[M]>;
  /** The ApprovalRegistry's `answerNative` entry for `adapter: 'claude'` (phone and desktop answers both land here). */
  answerNative(native: NativeDecisionRef, reply: NativeDecisionReply, paneId: string): Promise<NativeDecisionOutcome>;
  /** A pipe client went away: drop its subscriptions. */
  clientGone(clientId: string): void;
  /** Synchronous read for the phone `/turns` route and agent-status overlays. */
  bindingForPane(paneId: string): ChatV2Binding | null;
  /** The folded session (full, read-only) for the phone projection. */
  sessionForPane(paneId: string): Readonly<Session> | null;
  /** Status for agent-status overlays; null = no record. */
  statusForPane(paneId: string): ChatV2Status | null;
  /** In-process listener for every push (phone nudges). Returns an unsubscribe. */
  onPush(listener: (push: ChatV2EventsPush) => void): () => void;
  /** Load records, sweep orphan drivers (identity-matched only), expire their approvals. */
  start(): Promise<void>;
  /** Stop every driver (tree kill) and flush the store. Resolves within CHATV2_DISPOSE_TIMEOUT_MS. */
  dispose(): Promise<void>;
}
