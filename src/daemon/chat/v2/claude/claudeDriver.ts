// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/integrations/harness/providers/claude/claude.ts), MIT License, Copyright (c) 2026 Nick
//
// The chat-v2 driver for Claude Code: one `claude -p` stream-json process per
// chat record. It maps the agent's stdout records to HarnessEvents and hands
// tool permissions and AskUserQuestion to the host as decisions; replies go
// back as `control_response` frames, exactly one per request id. Changes from
// the source: a class over one process (no thread maps), the wmux driver
// contract (host-stamped user turns, `turn.ended`, the decision sink), string
// request ids, fail-closed handling of request ids the RPC cannot name, and
// no plan/full-access/compaction/model-catalog paths.
import fs from 'node:fs/promises';
import type { HarnessEvent } from '../../../../shared/chatv2/harnessEvents';
import type { TaskListItem, TurnOutcome } from '../../../../shared/chatv2/session';
import { formQuestions, replyFromAnswers } from '../../../../shared/chatv2/questions';
import { isAgentToolName } from '../../../../shared/chatv2/preview';
import { joinStreamText, snapshotRemainder } from '../../../../shared/chatv2/streamText';
import {
  isOtherOption,
  questionPromptTitle,
  questionsFromUnknown,
  type UserQuestion,
} from '../../../../shared/chatv2/userQuestion';
import type { NativeDecisionOutcome, NativeDecisionReply } from '../../../approvals/types';
import { ChildBackend } from '../childBackend';
import type {
  ChatV2Driver,
  ChatV2DriverSink,
  ChatV2DriverStart,
  ChatV2DriverTurn,
} from '../types';
import {
  applyClaudeTaskTool,
  askUserQuestionAllowInput,
  asRecord,
  assistantMessageId,
  assistantTextBlocks,
  assistantThinkingBlocks,
  assistantToolUses,
  buildClaudeSpawnArgs,
  buildClaudeUserMessage,
  buildControlRequest,
  buildControlResponse,
  contextFromResult,
  contextUsedFromAssistant,
  extractAskUserQuestionTitle,
  inputJsonDeltaFromEvent,
  isAgentTaskType,
  isSubagentMessage,
  isTerminalAgentTaskStatus,
  isTodoTool,
  isUsageLimitResult,
  parseBackgroundTasks,
  parseControlCancelId,
  parseControlRequest,
  parseControlResponse,
  parseJsonLine,
  parseTaskNotification,
  parseTaskProgress,
  parseTaskStarted,
  parseTaskUpdated,
  parseToolProgress,
  previewFromTool,
  sessionIdFromMessage,
  statusTextFromSystem,
  streamDeltaFromEvent,
  stringField,
  summarizeToolRequest,
  taskListFromTodos,
  toClaudePermissionResult,
  toolKindFromName,
  toolResultsFromUserMessage,
  toolStartFromEvent,
  toolTitle,
  tryParseJsonRecord,
  turnMetricsFromResult,
  turnStatusFromResult,
  usageLimitFromRateLimitEvent,
  type ClaudeAgentTaskNotification,
  type ClaudeControlRequest,
  type ClaudeImage,
} from './claudeProtocol';

/** The initialize handshake must answer within this long, or `start` rejects. */
export const CLAUDE_INIT_TIMEOUT_MS = 20_000;
/**
 * How long a finished background task may take to wake Claude before the turn
 * is let go anyway. The follow-up turn normally starts within a second or two.
 */
const RESUME_GRACE_MS = 15_000;
/** Task-list block key for TaskCreate/TaskUpdate items. */
const CLAUDE_TASKS_KEY = 'claude-tasks';
/** What `daemon.chatv2.answer` can name; a request id outside it is denied at once. */
const ANSWERABLE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Stderr kept for a failed start's message. */
const STDERR_TAIL_BYTES = 2_048;

type PendingDecision =
  | { kind: 'permission'; input: Record<string, unknown> }
  | { kind: 'questions'; input: Record<string, unknown>; questions: UserQuestion[] };

type InFlightTool = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  partialJson: string;
  title: string;
};

type LiveAgentTask = {
  taskId: string;
  toolUseId?: string;
  description: string;
  backgrounded: boolean;
};

type BackgroundTask = {
  description: string;
  toolUseId?: string;
};

export interface ClaudeDriverOptions {
  /** `--setting-sources`, already validated (CLAUDE_SETTING_SOURCES_PATTERN). */
  settingSources: string;
  /** The executable, resolved through the child env's PATH. */
  command?: string;
  backend?: ChildBackend;
  readImage?: (path: string) => Promise<Buffer>;
}

/**
 * Claude's own question ids are prompt text and its option ids are labels.
 * The contract keys them `q0…` and the option keys `1…` (what a shipped phone
 * can send for a single-select), with "Other" carried as free text only.
 */
export function rekeyClaudeQuestions(questions: UserQuestion[]): UserQuestion[] {
  return questions.map((question, index) => ({
    ...question,
    id: `q${index}`,
    allowCustom: question.allowCustom || question.options.some(isOtherOption),
    options: question.options
      .filter((option) => !isOtherOption(option))
      .map((option, optionIndex) => ({ ...option, id: String(optionIndex + 1) })),
  }));
}

export class ClaudeDriver implements ChatV2Driver {
  readonly agent = 'claude' as const;
  private readonly backend: ChildBackend;
  private readonly command: string;
  private readonly readImage: (path: string) => Promise<Buffer>;
  private sink: ChatV2DriverSink | null = null;
  private claudeSessionId = '';
  private controlSeq = 0;
  private initRequestId = '';
  private initDone: ((ok: boolean, error?: string) => void) | null = null;
  private initialized = false;
  private stopping = false;
  private exitedOnce = false;
  private stderrTail = '';

  // Requests waiting on an answer, by Claude's request id.
  private readonly pending = new Map<string, PendingDecision>();
  // Request ids that were answered or dropped: a second answer is `not-found`.
  private readonly settled = new Set<string>();

  // Per-turn state (MonoCode's Live).
  private activeTurn = false;
  private interruptRequested = false;
  private turnResultSeen = false;
  private turnOutcome: TurnOutcome = 'completed';
  private usageLimit: { resetsAt?: number } | null = null;
  private emittedAssistant = '';
  private emittedReasoning = '';
  private pendingAssistantBoundary = false;
  private readonly toolsByIndex = new Map<number, InFlightTool>();
  private readonly toolsById = new Map<string, InFlightTool>();
  private readonly agentTasks = new Map<string, LiveAgentTask>();
  private readonly backgroundTasks = new Map<string, BackgroundTask>();
  private readonly backgroundRows = new Map<string, string>();
  private awaitingResume: ReturnType<typeof setTimeout> | null = null;
  private backgroundKey = '';
  private taskNotes: string[] = [];
  private claudeTasks = new Map<string, TaskListItem>();

  constructor(private readonly options: ClaudeDriverOptions) {
    this.backend = options.backend ?? new ChildBackend();
    this.command = options.command ?? 'claude';
    this.readImage = options.readImage ?? ((path) => fs.readFile(path));
  }

  get pid(): number | undefined {
    return this.backend.pid;
  }

  async start(spec: ChatV2DriverStart, sink: ChatV2DriverSink): Promise<void> {
    if (this.sink) throw new Error('Driver already started');
    this.sink = sink;
    this.claudeSessionId = spec.providerSession.id;
    const args = buildClaudeSpawnArgs({
      mode: spec.mode,
      model: spec.model,
      providerSession: spec.providerSession,
      settingSources: this.options.settingSources,
    });
    const initialized = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      this.initDone = (ok, error) => resolve({ ok, ...(error ? { error } : {}) });
    });
    await this.backend.start(this.command, args, spec.cwd, spec.env, {
      line: (line) => this.handleLine(line),
      exit: (info) => this.handleExit(info),
      stderr: (chunk) => { this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES); },
    });
    this.initRequestId = this.nextControlId();
    const timer = setTimeout(() => this.initDone?.(false, 'Claude Code did not answer its startup handshake.'), CLAUDE_INIT_TIMEOUT_MS);
    timer.unref();
    try {
      await this.write(buildControlRequest(this.initRequestId, { subtype: 'initialize' }));
    } catch {
      this.initDone?.(false, 'Claude Code exited during startup.');
    }
    const result = await initialized;
    clearTimeout(timer);
    if (!result.ok) {
      await this.stop();
      const detail = this.stderrTail.trim().split('\n').pop()?.slice(0, 300);
      throw new Error(detail ? `${result.error} ${detail}` : result.error);
    }
    this.emit({ type: 'session.providerBound', providerSessionId: this.claudeSessionId });
    this.emit({ type: 'session.started' });
  }

  async send(turn: ChatV2DriverTurn): Promise<void> {
    if (!this.backend.alive) throw new Error('Claude Code is not running.');
    const images: ClaudeImage[] = [];
    for (const attachment of turn.attachments) {
      const data = await this.readImage(attachment.path);
      images.push({ mimeType: attachment.mimeType, data: data.toString('base64') });
    }
    const message = buildClaudeUserMessage({ text: turn.text, images });
    this.resetTurn();
    this.activeTurn = true;
    await this.write(message);
  }

  async interrupt(): Promise<boolean> {
    if (!this.activeTurn || !this.backend.alive) return false;
    this.interruptRequested = true;
    await this.write(buildControlRequest(this.nextControlId(), { subtype: 'interrupt' }));
    return true;
  }

  async answer(requestId: string, reply: NativeDecisionReply): Promise<NativeDecisionOutcome> {
    const pending = this.pending.get(requestId);
    if (!pending || this.settled.has(requestId)) return 'not-found';
    // Claimed before the write: a second answer for this id never writes.
    this.pending.delete(requestId);
    this.settled.add(requestId);
    let response: Record<string, unknown>;
    if (pending.kind === 'questions') {
      const answered = reply.decision === 'approve' ? replyFromAnswers(pending.questions, reply.answers) : { kind: 'skipped' as const };
      response = answered.kind === 'answered'
        ? { behavior: 'allow', updatedInput: askUserQuestionAllowInput(pending.input, answered, pending.questions) }
        : { behavior: 'deny', message: 'User cancelled tool execution.' };
    } else {
      response = toClaudePermissionResult(reply.decision === 'approve' ? 'allow' : 'deny', pending.input);
    }
    try {
      await this.write(buildControlResponse(requestId, response));
      return 'ok';
    } catch {
      // Nothing left the process boundary when the child is gone. A live
      // child that did not take the write may or may not have it: the card
      // stays up until the turn ends or Claude drops the request.
      return this.backend.alive ? 'uncertain' : 'not-found';
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearAwaitingResume();
    await this.backend.stop();
  }

  // --- process ------------------------------------------------------------

  private emit(event: HarnessEvent): void {
    this.sink?.event(event);
  }

  private nextControlId(): string {
    this.controlSeq += 1;
    return `wmux_${this.controlSeq}`;
  }

  private write(payload: Record<string, unknown>): Promise<void> {
    return this.backend.write(JSON.stringify(payload));
  }

  private handleExit(info: { code: number | null; signal: string | null }): void {
    if (this.exitedOnce) return;
    this.exitedOnce = true;
    this.clearAwaitingResume();
    this.initDone?.(false, 'Claude Code exited during startup.');
    this.initDone = null;
    for (const requestId of this.pending.keys()) this.settled.add(requestId);
    this.pending.clear();
    this.activeTurn = false;
    const sink = this.sink;
    if (!sink) return;
    if (this.initialized) sink.event({ type: 'session.ended', code: info.code });
    sink.exited(info);
  }

  private markInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.initDone?.(true);
    this.initDone = null;
  }

  private handleLine(line: string): void {
    const rec = parseJsonLine(line);
    if (!rec) return;
    const type = stringField(rec, 'type');
    if (type === 'keep_alive') return;

    const cancelId = parseControlCancelId(rec);
    if (cancelId) {
      if (this.pending.delete(cancelId)) {
        this.settled.add(cancelId);
        this.sink?.decisionGone(cancelId);
      }
      return;
    }

    const control = parseControlRequest(rec);
    if (control) {
      void this.handleControlRequest(control).catch(() => undefined);
      return;
    }

    if (type === 'control_response') {
      const response = parseControlResponse(rec);
      if (response && response.requestId === this.initRequestId) {
        if (response.ok) this.markInitialized();
        else this.initDone?.(false, response.error ?? 'Claude Code refused its startup handshake.');
      }
      return;
    }
    if (!this.initialized || this.stopping) return;

    const sessionIdFromLine = sessionIdFromMessage(rec);
    if (sessionIdFromLine && sessionIdFromLine !== this.claudeSessionId) {
      this.claudeSessionId = sessionIdFromLine;
      // A different conversation starts with its own task ids.
      this.claudeTasks = new Map();
      this.emit({ type: 'session.providerBound', providerSessionId: sessionIdFromLine });
    }

    if (type === 'system' && stringField(rec, 'subtype') === 'init') this.noteClaudeTurnStarted();

    if (this.handleAgentLifecycle(rec)) return;
    if (type === 'tool_progress') {
      this.handleToolProgress(rec);
      return;
    }
    if (type === 'stream_event') {
      if (!isSubagentMessage(rec)) this.noteClaudeTurnStarted();
      this.handleStreamEvent(rec);
      return;
    }
    if (type === 'assistant') {
      if (!isSubagentMessage(rec)) this.noteClaudeTurnStarted();
      this.handleAssistant(rec);
      return;
    }
    if (type === 'user') {
      this.handleUser(rec);
      return;
    }
    if (type === 'result') {
      this.handleResult(rec);
      return;
    }
    if (type === 'rate_limit_event') {
      this.usageLimit = usageLimitFromRateLimitEvent(rec);
      return;
    }
    if (type === 'system') {
      const text = statusTextFromSystem(rec);
      if (text) this.emit({ type: 'status', text });
    }
  }

  // --- turn ---------------------------------------------------------------

  private resetTurn(): void {
    // A request id lives for its turn only.
    this.settled.clear();
    this.emittedAssistant = '';
    this.emittedReasoning = '';
    this.pendingAssistantBoundary = false;
    this.toolsByIndex.clear();
    this.toolsById.clear();
    this.agentTasks.clear();
    this.backgroundTasks.clear();
    this.backgroundRows.clear();
    this.clearAwaitingResume();
    this.backgroundKey = '';
    this.taskNotes = [];
    this.turnResultSeen = false;
    this.turnOutcome = 'completed';
    this.usageLimit = null;
    this.interruptRequested = false;
  }

  private handleStreamEvent(rec: Record<string, unknown>): void {
    const subagent = isSubagentMessage(rec);
    const delta = streamDeltaFromEvent(rec);
    if (delta) {
      if (subagent) return;
      if (delta.kind === 'assistant') {
        this.closePendingAssistantMessage();
        this.emittedAssistant = joinStreamText(this.emittedAssistant, delta.text);
        this.emit({ type: 'message.delta', text: delta.text });
      } else {
        this.emittedReasoning = joinStreamText(this.emittedReasoning, delta.text);
        this.emit({ type: 'reasoning.delta', text: delta.text });
      }
      return;
    }

    const started = toolStartFromEvent(rec);
    if (started) {
      if (subagent) {
        this.noteSubagentTool(rec, started.id, started.name, started.input);
        return;
      }
      const tool: InFlightTool = {
        id: started.id,
        name: started.name,
        input: started.input,
        partialJson: '',
        title: toolTitle(started.name, started.input),
      };
      if (started.index >= 0) this.toolsByIndex.set(started.index, tool);
      this.toolsById.set(started.id, tool);
      this.emitToolStarted(tool);
      return;
    }

    const jsonDelta = inputJsonDeltaFromEvent(rec);
    if (jsonDelta) {
      if (subagent) return;
      const tool = this.toolsByIndex.get(jsonDelta.index);
      if (!tool) return;
      tool.partialJson += jsonDelta.partial;
      const parsed = tryParseJsonRecord(tool.partialJson);
      if (!parsed) return;
      tool.input = parsed;
      tool.title = toolTitle(tool.name, parsed);
      this.emit({
        type: 'tool.updated',
        callId: tool.id,
        title: tool.title,
        kind: toolKindFromName(tool.name),
        ...this.agentModelOf(tool.name, tool.input),
        status: 'pending',
        detail: summarizeToolRequest(tool.name, parsed),
        preview: previewFromTool(tool.name, parsed),
      });
      this.emitTaskListIfNeeded(tool.name, parsed);
    }
  }

  private agentModelOf(name: string, input: Record<string, unknown>): { agentModel?: string } {
    const model = isAgentToolName(name) ? stringField(input, 'model') : undefined;
    return model ? { agentModel: model } : {};
  }

  private emitToolStarted(tool: InFlightTool): void {
    this.emit({
      type: 'tool.started',
      callId: tool.id,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      ...this.agentModelOf(tool.name, tool.input),
      status: isAgentToolName(tool.name) ? 'in_progress' : 'pending',
      preview: previewFromTool(tool.name, tool.input),
    });
    this.emitTaskListIfNeeded(tool.name, tool.input);
  }

  private handleAssistant(rec: Record<string, unknown>): void {
    if (isSubagentMessage(rec)) {
      this.noteSubagentNarration(rec);
      for (const use of assistantToolUses(rec)) {
        this.noteSubagentTool(rec, use.id, use.name, use.input);
      }
      return;
    }

    const used = contextUsedFromAssistant(rec);
    if (used !== undefined) this.emit({ type: 'context', used });

    const snapshot = assistantTextBlocks(rec).join('');
    if (snapshot) this.closePendingAssistantMessage();
    const extra = snapshotRemainder(this.emittedAssistant, snapshot);
    if (extra) {
      this.emittedAssistant = joinStreamText(this.emittedAssistant, extra);
      this.emit({ type: 'message.delta', text: extra });
    }

    for (const use of assistantToolUses(rec)) {
      const streamed = this.toolsById.get(use.id);
      if (streamed) {
        // content_block_start often has an empty input, and the input JSON
        // delta may never form a parseable object before the complete
        // assistant snapshot: reconcile from the snapshot.
        if (JSON.stringify(streamed.input) !== JSON.stringify(use.input)) {
          streamed.input = use.input;
          streamed.title = toolTitle(use.name, use.input);
          this.emit({
            type: 'tool.updated',
            callId: streamed.id,
            title: streamed.title,
            kind: toolKindFromName(streamed.name),
            ...this.agentModelOf(streamed.name, use.input),
            status: isAgentToolName(streamed.name) ? 'in_progress' : 'pending',
            preview: previewFromTool(streamed.name, use.input),
          });
          this.emitTaskListIfNeeded(streamed.name, use.input);
        }
        continue;
      }
      const tool: InFlightTool = {
        id: use.id,
        name: use.name,
        input: use.input,
        partialJson: '',
        title: toolTitle(use.name, use.input),
      };
      this.toolsById.set(use.id, tool);
      this.emitToolStarted(tool);
    }

    // Each assistant record is one Claude message. Wait until the next message
    // begins to close its block, so a backgrounded turn stays visibly live.
    this.pendingAssistantBoundary = !!(snapshot || this.emittedAssistant);
    this.emittedAssistant = '';
    this.emittedReasoning = '';
  }

  private closePendingAssistantMessage(): void {
    if (!this.pendingAssistantBoundary) return;
    this.pendingAssistantBoundary = false;
    this.emit({ type: 'message.completed' });
  }

  private handleUser(rec: Record<string, unknown>): void {
    if (isSubagentMessage(rec)) {
      this.noteSubagentResults(rec);
      return;
    }
    for (const result of toolResultsFromUserMessage(rec)) {
      const tool = this.toolsById.get(result.toolUseId);
      if (!tool) continue;
      if (isAgentToolName(tool.name) && this.isBackgroundedAgentTool(tool.id)) continue;
      this.emit({
        type: 'tool.updated',
        callId: tool.id,
        title: tool.title,
        kind: toolKindFromName(tool.name),
        status: result.isError ? 'failed' : 'completed',
        detail: result.text || undefined,
        preview: previewFromTool(tool.name, tool.input, result.text),
      });
      if (!result.isError && applyClaudeTaskTool(this.claudeTasks, tool.name, tool.input, result.text)) {
        this.emit({
          type: 'tasks.updated',
          key: CLAUDE_TASKS_KEY,
          // The map is the source of truth, so a TaskUpdate subject is a rename.
          authoritative: true,
          providerSessionId: this.claudeSessionId,
          items: [...this.claudeTasks.values()],
        });
      }
      // What a subagent hands back is the last thing it said: it closes that
      // agent's own trail rather than sitting on the parent row as detail.
      if (isAgentToolName(tool.name) && result.text.trim() && !result.isError) {
        this.emit({
          type: 'agent.step',
          callId: tool.id,
          stepId: `${tool.id}:report`,
          kind: 'message',
          text: result.text,
        });
      }
      if (isAgentToolName(tool.name)) this.settleInlineAgentTask(tool.id);
    }
  }

  /**
   * A subagent that was never backgrounded reports back on the parent's own
   * tool result, and Claude sends no task record for one that ended inline.
   * Without this its task would keep the turn open for good.
   */
  private settleInlineAgentTask(toolUseId: string): void {
    let settled = false;
    for (const [taskId, task] of [...this.agentTasks]) {
      if (task.toolUseId !== toolUseId || task.backgrounded) continue;
      this.agentTasks.delete(taskId);
      this.backgroundTasks.delete(taskId);
      settled = true;
    }
    if (!settled) return;
    this.maybeFinishTurn();
    this.syncBackgroundWait();
  }

  private handleResult(rec: Record<string, unknown>): void {
    if (isSubagentMessage(rec)) return;
    const context = contextFromResult(rec);
    if (context) this.emit({ type: 'context', ...context });
    const metrics = turnMetricsFromResult(rec);
    if (metrics) this.emit({ type: 'turn.metrics', ...metrics });

    const result = turnStatusFromResult(rec);
    const interrupted = this.interruptRequested || result.status === 'interrupted' || result.status === 'cancelled';
    if (result.status === 'failed' && result.error && !interrupted) {
      this.emit({ type: 'session.error', message: result.error });
    }
    // A refused window can still fall back to another model, so only a turn
    // that ended in error was stopped by it.
    const turnErrored = rec.is_error === true || result.status === 'failed';
    const usageLimit = this.usageLimit ?? (isUsageLimitResult(rec) ? {} : null);
    this.usageLimit = null;
    if (usageLimit && turnErrored && !interrupted) {
      this.emit({ type: 'usage.limited', ...usageLimit });
    }
    this.turnOutcome = interrupted
      ? 'interrupted'
      : usageLimit && turnErrored
        ? 'usage-limited'
        : result.status === 'failed'
          ? 'failed'
          : 'completed';
    this.turnResultSeen = true;
    this.maybeFinishTurn();
    this.showBackgroundRows();
    this.syncBackgroundWait();
  }

  // --- decisions ----------------------------------------------------------

  private async handleControlRequest(control: ClaudeControlRequest): Promise<void> {
    if (control.subtype !== 'can_use_tool' && control.subtype !== 'permission') {
      await this.write(buildControlResponse(control.requestId, {}));
      return;
    }
    const toolName = control.toolName ?? 'tool';
    const input = control.input ?? {};
    // Fail closed on anything nobody can answer: a stopping driver, or a
    // request id the answer RPC could not name.
    if (this.stopping || !this.sink || !ANSWERABLE_REQUEST_ID.test(control.requestId) || this.settled.has(control.requestId)) {
      await this.write(buildControlResponse(control.requestId, toClaudePermissionResult('deny', input))).catch(() => undefined);
      return;
    }
    if (this.pending.has(control.requestId)) return;

    if (toolName === 'AskUserQuestion') {
      const questions = rekeyClaudeQuestions(questionsFromUnknown(input));
      if (!questions.length) {
        await this.write(buildControlResponse(control.requestId, toClaudePermissionResult('deny', input))).catch(() => undefined);
        return;
      }
      this.pending.set(control.requestId, { kind: 'questions', input, questions });
      this.sink.decision({ kind: 'questions', requestId: control.requestId, questions: formQuestions(questions) });
      this.emit({
        type: 'question.asked',
        requestId: control.requestId,
        title: questionPromptTitle(questions) || extractAskUserQuestionTitle(input),
        questions,
        ...(control.toolUseId ? { callId: control.toolUseId } : {}),
      });
      return;
    }

    this.applyKnownToolInput(toolName, input, control.toolUseId);
    this.pending.set(control.requestId, { kind: 'permission', input });
    this.sink.decision({
      kind: 'permission',
      requestId: control.requestId,
      question: `Allow ${toolName}?`,
      toolName,
      summary: summarizeToolRequest(toolName, input),
    });
    const preview = previewFromTool(toolName, input);
    this.emit({
      type: 'approval.requested',
      requestId: control.requestId,
      title: toolTitle(toolName, input),
      kind: toolKindFromName(toolName),
      ...(control.toolUseId ? { callId: control.toolUseId } : {}),
      ...(preview ? { preview } : {}),
    });
  }

  private applyKnownToolInput(toolName: string, input: Record<string, unknown>, callId?: string): void {
    if (!callId || Object.keys(input).length === 0) return;
    const existing = this.toolsById.get(callId);
    if (existing) {
      existing.input = input;
      existing.title = toolTitle(toolName, input);
    }
    this.emit({
      type: 'tool.updated',
      callId,
      title: toolTitle(toolName, input),
      kind: toolKindFromName(toolName),
      status: 'pending',
      preview: previewFromTool(toolName, input),
    });
  }

  private emitTaskListIfNeeded(toolName: string, input: Record<string, unknown>): void {
    if (!isTodoTool(toolName)) return;
    const items = taskListFromTodos(input);
    if (items) this.emit({ type: 'tasks.updated', items });
  }

  // --- subagents and background work -------------------------------------

  private handleAgentLifecycle(rec: Record<string, unknown>): boolean {
    const started = parseTaskStarted(rec);
    if (started) {
      if (started.ambient) return true;
      this.backgroundTasks.set(started.taskId, { description: started.description, toolUseId: started.toolUseId });
      this.syncBackgroundWait();
      if (!isAgentTaskType(started.taskType)) return true;
      this.agentTasks.set(started.taskId, {
        taskId: started.taskId,
        toolUseId: started.toolUseId,
        description: started.description,
        backgrounded: started.backgrounded,
      });
      this.upsertAgentTool(started.toolUseId, started.description, 'in_progress');
      return true;
    }

    const progress = parseTaskProgress(rec);
    if (progress) {
      const task = this.agentTasks.get(progress.taskId);
      const title = progress.description || task?.description || 'Subagent';
      const detail = progress.summary
        || progress.lastToolName
        || (progress.subagentType ? `${progress.subagentType.replace(/[_-]+/g, ' ')} subagent` : undefined);
      this.upsertAgentTool(progress.toolUseId ?? task?.toolUseId, title, 'in_progress', detail);
      return true;
    }

    const updated = parseTaskUpdated(rec);
    if (updated) {
      const task = this.agentTasks.get(updated.taskId);
      if (task && updated.backgrounded !== undefined) task.backgrounded = updated.backgrounded;
      if (task && updated.description) task.description = updated.description;
      const background = this.backgroundTasks.get(updated.taskId);
      if (background && updated.description) background.description = updated.description;
      if (isTerminalAgentTaskStatus(updated.status)) {
        this.settleBackgroundRow(updated.taskId, updated.status ?? 'completed', updated.error);
        this.finishBackgroundTask(updated.taskId);
        this.completeAgentTask(updated.taskId, updated.status === 'completed' ? 'completed' : 'failed', updated.error);
      }
      return true;
    }

    const notice = parseTaskNotification(rec);
    if (notice) {
      if (!notice.ambient) {
        this.noteTaskNotification(notice);
        this.finishBackgroundTask(notice.taskId);
        this.completeAgentTask(notice.taskId, notice.status === 'completed' ? 'completed' : 'failed', notice.summary || undefined);
      }
      return true;
    }

    const allTasks = parseBackgroundTasks(rec);
    if (!allTasks) return false;
    const next = new Set(allTasks.map((task) => task.taskId));
    for (const id of [...this.backgroundTasks.keys()]) {
      if (next.has(id)) continue;
      this.settleBackgroundRow(id, 'completed');
      this.finishBackgroundTask(id);
    }
    for (const row of allTasks) {
      if (!this.backgroundTasks.has(row.taskId)) this.backgroundTasks.set(row.taskId, { description: row.description });
    }
    const liveTasks = allTasks.filter((task) => isAgentTaskType(task.taskType));
    for (const id of [...this.agentTasks.keys()]) {
      if (!next.has(id)) this.completeAgentTask(id, 'completed');
    }
    for (const row of liveTasks) {
      if (this.agentTasks.has(row.taskId)) continue;
      // The list carries no tool_use_id and often lands before task_started,
      // so find the Agent call that spawned it rather than opening a second row.
      const toolUseId = this.unclaimedAgentCall(row.description);
      this.agentTasks.set(row.taskId, { taskId: row.taskId, toolUseId, description: row.description, backgrounded: true });
      this.upsertAgentTool(toolUseId, row.description, 'in_progress');
    }
    this.maybeFinishTurn();
    this.syncBackgroundWait();
    return true;
  }

  private handleToolProgress(rec: Record<string, unknown>): void {
    const progress = parseToolProgress(rec);
    if (!progress) return;
    const tool = this.toolsById.get(progress.toolUseId)
      ?? (progress.parentToolUseId ? this.toolsById.get(progress.parentToolUseId) : undefined);
    if (!tool || !isAgentToolName(tool.name)) return;
    this.emit({ type: 'tool.updated', callId: tool.id, title: tool.title, kind: 'agent', status: 'in_progress' });
    // Progress names the call in flight: a step in the run, not its result.
    if (progress.toolName) {
      this.emit({
        type: 'agent.step',
        callId: tool.id,
        stepId: progress.toolUseId,
        kind: 'tool',
        text: progress.toolName,
        status: 'in_progress',
        ...(progress.subagentType ? { agentType: progress.subagentType } : {}),
      });
    }
  }

  /** The Agent call a subagent message belongs to, or nothing. */
  private subagentParent(rec: Record<string, unknown>): InFlightTool | undefined {
    const parentId = stringField(rec, 'parent_tool_use_id');
    if (!parentId) return undefined;
    const parent = this.toolsById.get(parentId);
    if (!parent || !isAgentToolName(parent.name)) return undefined;
    return parent;
  }

  /** A call a subagent made, mirrored onto the Agent row that spawned it. */
  private noteSubagentTool(rec: Record<string, unknown>, id: string, name: string, input: Record<string, unknown>): void {
    const parent = this.subagentParent(rec);
    if (!parent) return;
    this.emit({ type: 'tool.updated', callId: parent.id, title: parent.title, kind: 'agent', status: 'in_progress' });
    if (!id) return;
    const preview = previewFromTool(name, input);
    this.emit({
      type: 'agent.step',
      callId: parent.id,
      stepId: id,
      kind: 'tool',
      text: toolTitle(name, input),
      toolKind: toolKindFromName(name),
      status: 'in_progress',
      ...(preview ? { preview } : {}),
    });
  }

  /** What a subagent said and thought, kept on its own row, never in the main transcript. */
  private noteSubagentNarration(rec: Record<string, unknown>): void {
    const parent = this.subagentParent(rec);
    if (!parent) return;
    const model = stringField(asRecord(rec.message), 'model');
    if (model) this.emit({ type: 'tool.updated', callId: parent.id, kind: 'agent', agentModel: model });
    const messageId = assistantMessageId(rec) ?? `${parent.id}:${this.controlSeq}`;
    const thinking = assistantThinkingBlocks(rec).join('').trim();
    if (thinking) {
      this.emit({ type: 'agent.step', callId: parent.id, stepId: `${messageId}:thinking`, kind: 'reasoning', text: thinking });
    }
    const text = assistantTextBlocks(rec).join('').trim();
    if (text) {
      this.emit({ type: 'agent.step', callId: parent.id, stepId: `${messageId}:text`, kind: 'message', text });
    }
  }

  /** Settles the subagent's own tool rows once their results come back. */
  private noteSubagentResults(rec: Record<string, unknown>): void {
    const parent = this.subagentParent(rec);
    if (!parent) return;
    for (const result of toolResultsFromUserMessage(rec)) {
      this.emit({
        type: 'agent.step',
        callId: parent.id,
        stepId: result.toolUseId,
        kind: 'tool',
        text: '',
        status: result.isError ? 'failed' : 'completed',
        ...(result.isError && result.text ? { detail: result.text } : {}),
      });
    }
  }

  private isBackgroundedAgentTool(toolUseId: string): boolean {
    for (const task of this.agentTasks.values()) {
      if (task.toolUseId === toolUseId && task.backgrounded) return true;
    }
    return false;
  }

  /** The latest Agent call with this description that no task has claimed yet. */
  private unclaimedAgentCall(description: string): string | undefined {
    const claimed = new Set([...this.agentTasks.values()].map((task) => task.toolUseId));
    let match: string | undefined;
    for (const tool of this.toolsById.values()) {
      if (!isAgentToolName(tool.name) || claimed.has(tool.id)) continue;
      if (stringField(tool.input, 'description') === description) match = tool.id;
    }
    return match;
  }

  private upsertAgentTool(callId: string | undefined, title: string, status: string, detail?: string): void {
    const id = callId ?? `agent:${title}`;
    const existing = this.toolsById.get(id);
    if (!existing) {
      this.toolsById.set(id, { id, name: 'Agent', input: {}, partialJson: '', title });
      this.emit({ type: 'tool.started', callId: id, title, kind: 'agent', status });
      if (status !== 'in_progress' && status !== 'pending' && status !== 'running') {
        this.emit({ type: 'tool.updated', callId: id, title, kind: 'agent', status, ...(detail ? { detail } : {}) });
      }
      return;
    }
    if (title) existing.title = title;
    this.emit({ type: 'tool.updated', callId: id, title: existing.title, kind: 'agent', status, ...(detail ? { detail } : {}) });
  }

  private completeAgentTask(taskId: string, status: string, detail?: string): void {
    const task = this.agentTasks.get(taskId);
    this.agentTasks.delete(taskId);
    if (task) {
      this.upsertAgentTool(task.toolUseId, task.description, status, detail ?? (status === 'failed' ? 'Subagent failed.' : undefined));
    }
    this.maybeFinishTurn();
  }

  /**
   * A task is done. If Claude had already yielded, the notification about it
   * starts a follow-up turn, so the turn is held open for that too.
   */
  private finishBackgroundTask(taskId: string): void {
    if (!this.backgroundTasks.delete(taskId)) return;
    if (this.turnResultSeen && this.activeTurn && !this.awaitingResume) {
      this.awaitingResume = setTimeout(() => {
        this.awaitingResume = null;
        this.maybeFinishTurn();
        this.syncBackgroundWait();
      }, RESUME_GRACE_MS);
      this.awaitingResume.unref?.();
    }
    this.maybeFinishTurn();
    this.syncBackgroundWait();
  }

  /**
   * Claude began another turn inside this one: woken by a finished task, or
   * by a follow-up written while it waited. Its own result decides the end.
   */
  private noteClaudeTurnStarted(): void {
    if (!this.activeTurn || !this.turnResultSeen) return;
    this.turnResultSeen = false;
    this.emittedAssistant = '';
    this.emittedReasoning = '';
    this.pendingAssistantBoundary = false;
    this.emit({ type: 'message.completed' });
    this.emit({ type: 'reasoning.completed' });
    for (const text of this.taskNotes) this.emit({ type: 'status', text });
    this.taskNotes = [];
    this.clearAwaitingResume();
    this.syncBackgroundWait();
  }

  /** Commands still running when Claude yielded each get a live row until they finish. */
  private showBackgroundRows(): void {
    if (!this.activeTurn) return;
    for (const [taskId, task] of this.backgroundTasks) {
      if (this.backgroundRows.has(taskId) || this.agentTasks.has(taskId)) continue;
      const source = task.toolUseId ? this.toolsById.get(task.toolUseId) : undefined;
      if (source && isAgentToolName(source.name)) continue;
      const callId = `background:${taskId}`;
      this.backgroundRows.set(taskId, callId);
      const preview = source ? previewFromTool(source.name, source.input) : undefined;
      this.emit({
        type: 'tool.started',
        callId,
        title: source ? toolTitle(source.name, source.input) : task.description,
        kind: source ? toolKindFromName(source.name) : 'execute',
        status: 'in_progress',
        background: true,
        ...(preview ? { preview } : {}),
      });
    }
  }

  private settleBackgroundRow(taskId: string, status: string, detail?: string): void {
    const callId = this.backgroundRows.get(taskId);
    if (!callId) return;
    this.emit({ type: 'tool.updated', callId, status: status === 'completed' ? 'completed' : 'failed', ...(detail ? { detail } : {}) });
  }

  /** A command's row takes the summary; a subagent's is kept for the trail. */
  private noteTaskNotification(notice: ClaudeAgentTaskNotification): void {
    if (!this.activeTurn) return;
    if (this.backgroundRows.has(notice.taskId)) {
      this.settleBackgroundRow(notice.taskId, notice.status, notice.summary || undefined);
      return;
    }
    const tool = notice.toolUseId ? this.toolsById.get(notice.toolUseId) : null;
    const agent = (tool && isAgentToolName(tool.name)) || this.agentTasks.has(notice.taskId);
    if (!agent || !this.turnResultSeen) return;
    this.taskNotes.push(notice.summary || 'Subagent finished.');
  }

  private clearAwaitingResume(): void {
    if (!this.awaitingResume) return;
    clearTimeout(this.awaitingResume);
    this.awaitingResume = null;
  }

  /** What the turn waits on once Claude yielded with work still running. */
  private syncBackgroundWait(): void {
    const waiting = this.activeTurn && this.turnResultSeen
      ? [...this.backgroundTasks.values()].map((task) => task.description)
      : [];
    const key = waiting.join('\n');
    if (key === this.backgroundKey) return;
    this.backgroundKey = key;
    this.emit({ type: 'background.updated', tasks: waiting });
  }

  private maybeFinishTurn(): void {
    if (!this.turnResultSeen || !this.activeTurn) return;
    if (this.agentTasks.size > 0 || this.backgroundTasks.size > 0) return;
    if (this.awaitingResume) return;
    this.clearAwaitingResume();
    this.activeTurn = false;
    this.emit({ type: 'message.completed' });
    this.emit({ type: 'reasoning.completed' });
    // Requests a finished turn left behind can no longer be answered.
    for (const requestId of this.pending.keys()) {
      this.settled.add(requestId);
      this.sink?.decisionGone(requestId);
    }
    this.pending.clear();
    this.emit({ type: 'turn.ended', outcome: this.turnOutcome });
  }
}
