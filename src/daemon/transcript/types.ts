// Daemon-side types for the transcript projector. The WIRE types
// (TurnEvent, TranscriptPage, TranscriptStatus, TranscriptAppendData) live in
// src/shared/transcript/turnEvents.ts so the daemon, main, the renderer, and
// the wmux web frontend all share one definition.

import type { AgentSignalKind } from '../../shared/hooks/signal-types';
import type { ResumeBinding } from '../../shared/agentResume';
import type { TranscriptAppendData } from '../../shared/transcript/turnEvents';

export interface TranscriptProjectorDeps {
  /**
   * The persisted resume binding for a live session — the ONLY source of the
   * transcript path. There is deliberately no cwd→slug derivation:
   * `agentResume.ts` rejects that mapping as version-drift-prone, and the whole
   * reason `transcriptPath` is persisted is to avoid it.
   */
  getResumeBinding: (sessionId: string) => ResumeBinding | undefined;
  /**
   * The agent currently detected on this pane, if any. Used ONLY to split an
   * ABSENT resume binding into `stale-session` (an agent is running but the
   * binding was not captured — the session started before the hooks were armed,
   * or its first Stop has not landed yet) vs `no-hook` (no agent at all → the
   * wmux hooks never fired here and never will without `wmux setup-hooks`).
   * Absent ⇒ the split degrades to `no-hook`, the pre-split behaviour.
   */
  getDetectedAgent?: (sessionId: string) => string | undefined;
  /**
   * The pane's environment, consulted ONLY by the transcript-path containment
   * check: a workspace profile may set `CLAUDE_CONFIG_DIR`, which relocates the
   * projects root a legitimate transcript lives under. Absent ⇒ the process
   * environment and the default `~/.claude/projects` are used.
   */
  getSessionEnv?: (sessionId: string) => Record<string, string> | undefined;
  /**
   * Deliver an append to the listed clients ONLY (A6 — unicast, not
   * broadcast). A transcript append carries the pane's full conversation
   * content, so it must never reach a client that did not subscribe, and
   * keeping it off those sockets bounds the blast radius of one large payload.
   */
  emitAppend: (
    sessionId: string,
    data: TranscriptAppendData,
    clientIds: readonly string[],
  ) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  now?: () => number;
  /** fs.watch trailing debounce; default 150ms. */
  debounceMs?: number;
  /** Polling-fallback interval used when fs.watch cannot arm; default 3000ms. */
  pollMs?: number;
}

/** Arguments of the on-expand code-body fetch. */
export interface CodeBlockRequest {
  /**
   * Byte offset of the transcript line the block was parsed from. Every ref the
   * parser produces carries one, and it is what makes the fetch O(1).
   */
  srcOffset: number;
  /** Block handle within its parent event (CodeBlockRef.n). */
  n: number;
  /**
   * The event the ref belonged to. Optional but checked when present: it proves
   * the line still at `srcOffset` is the same entry the renderer is looking at,
   * so a rotated file cannot answer with a stranger's code.
   */
  eventId?: string;
}

export type { AgentSignalKind };
