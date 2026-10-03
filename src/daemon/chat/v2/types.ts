/**
 * Chat v2 daemon contract: the driver interface each agent implements, and
 * the host the daemon wires into its RPC table, approval registry and phone
 * routes. See src/shared/chatv2/ipc.ts for the wire contract.
 *
 * Layering:
 *   index.ts ──(ChatV2HostDeps)──▶ ChatV2Host ──▶ one ChatV2Driver per record
 *   - The host owns records (one per anchor pane), seq/epoch stamping, the
 *     authoritative fold, persistence, batching, subscriptions and the
 *     ApprovalRegistry bridge.
 *   - A driver owns exactly one agent process and translates its protocol to
 *     HarnessEvents and back. It never touches the registry, the store or a
 *     socket.
 */
import type { DaemonEvent } from '../../../shared/rpc';
import type { HarnessEvent } from '../../../shared/chatv2/harnessEvents';
import {
  CHATV2_PUSH_EVENT,
  type ChatV2Binding,
  type ChatV2EventsPush,
  type ChatV2Method,
  type ChatV2ParamsByMethod,
  type ChatV2ResultByMethod,
  type ChatV2RunMode,
  type ChatV2Status,
} from '../../../shared/chatv2/ipc';
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
   * Final child env, already built by the host: `scrubAgentEnv` +
   * `resolveAccountEnv` + `buildAutomationEnv`, then `WMUX_PTY_ID` = the
   * anchor pane id and `WMUX_GATE=0`. A driver adds nothing to it.
   */
  env: Record<string, string>;
  mode: ChatV2RunMode;
  /** '' = the agent's default. */
  model: string;
  /** Resume this agent conversation instead of starting a new one. */
  resume?: string;
}

/** A user turn as the driver sends it. Attachments are read by the driver from staged paths. */
export interface ChatV2DriverTurn {
  text: string;
  attachments: Array<{ path: string; mimeType: string }>;
}

/**
 * A decision the agent is blocked on, in the shape the host turns into an
 * ApprovalRegistry native decision (`adapter: agent`, `requestId`). The
 * driver also emits the matching `approval.requested` / `question.asked`
 * HarnessEvent for the transcript.
 */
export type ChatV2DriverDecision =
  | {
      kind: 'permission';
      requestId: string;
      toolName: string;
      /** One line for the card and the phone (command, path, …). */
      summary: string;
    }
  | {
      kind: 'questions';
      requestId: string;
      questions: Array<{
        header?: string;
        text: string;
        multiSelect: boolean;
        options: Array<{ key: string; label: string }>;
      }>;
    };

export interface ChatV2DriverSink {
  event(event: HarnessEvent): void;
  decision(decision: ChatV2DriverDecision): void;
  /** The agent dropped a pending request on its own (answered elsewhere, turn ended). */
  decisionGone(requestId: string): void;
  /** The process exited; called once. */
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
   */
  answer(requestId: string, reply: NativeDecisionReply): Promise<NativeDecisionOutcome>;
  /** Stop the process tree (Windows-safe tree kill) and wait until it is reaped. */
  stop(): Promise<void>;
}

export type ChatV2DriverFactory = (agent: HarnessId) => ChatV2Driver | null;

// --- host ---------------------------------------------------------------

/** What index.ts supplies. Everything a host needs from the rest of the daemon. */
export interface ChatV2HostDeps {
  wmuxDir: string;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  now: () => number;
  sessionManager: Pick<DaemonSessionManager, 'getSession'>;
  /** Null until the registry exists; a host without it offers no approvals. */
  approvals: () => ApprovalRegistry | null;
  /** True while an agent process (TUI) is alive in the pane's anchor shell. */
  agentAliveInPane: (paneId: string) => Promise<boolean>;
  /** True when the anchor shell sits at an empty prompt (OSC 133). */
  shellIdle: (paneId: string) => Promise<boolean>;
  /** Type into the anchor shell (toTerminal's resume command). */
  writeToPane: (paneId: string, data: string) => boolean;
  /** Unicast a DaemonEvent to one pipe client. */
  sendTo: (clientId: string, event: DaemonEvent) => void;
  killTree: (pid: number) => Promise<void>;
  /** Defaults to the built-in drivers. Tests pass fakes. */
  drivers?: ChatV2DriverFactory;
}

export interface ChatV2Host {
  /** Run one first-party RPC. Params are already validated by `parseChatV2Params`. */
  call<M extends ChatV2Method>(method: M, params: ChatV2ParamsByMethod[M], clientId: string): Promise<ChatV2ResultByMethod[M]>;
  /** The ApprovalRegistry's `answerNative` entry for `adapter: 'claude'`. */
  answerNative(native: NativeDecisionRef, reply: NativeDecisionReply, paneId: string): Promise<NativeDecisionOutcome>;
  /** A pipe client went away: drop its subscriptions. */
  clientGone(clientId: string): void;
  /** Synchronous read for the phone `/turns` route and agent-status overlays. */
  bindingForPane(paneId: string): ChatV2Binding | null;
  /** The folded session (full, read-only) for the phone projection. */
  sessionForPane(paneId: string): Readonly<Session> | null;
  /** Status for `readChatAgentState`; null = no record. */
  statusForPane(paneId: string): ChatV2Status | null;
  /** In-process listener for every push (phone nudges). Returns an unsubscribe. */
  onPush(listener: (push: ChatV2EventsPush) => void): () => void;
  /** Kill leftover driver processes from a previous run and expire their approvals. */
  start(): Promise<void>;
  /** Stop every driver (tree kill) and flush the store. */
  dispose(): Promise<void>;
}
