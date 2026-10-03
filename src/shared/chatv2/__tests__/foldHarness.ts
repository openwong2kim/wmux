// Test helpers for the adapted MonoCode fold tests. The source tests call the
// fold with bare events and read the wall clock; chat v2 folds stamped events.
// These wrappers stamp each event with the next seq and `Date.now()` (which
// the tests mock), so the adapted cases keep their original shape.
import * as fold from "../apply";
import type { HarnessEvent, StampedHarnessEvent } from "../harnessEvents";
import { newChatSession, type HarnessId, type Session } from "../session";

let seq = 0;

export function stamp(event: HarnessEvent): StampedHarnessEvent {
  seq += 1;
  return { seq, at: Date.now(), event };
}

/** Agents the source tests name that chat v2 does not run fold as codex. */
export function newSession(harness: string, cwd: string, model?: string): Session {
  const id: HarnessId = harness === "claude" || harness === "opencode" ? harness : "codex";
  return newChatSession({ id: "s", harness: id, cwd, ...(model ? { model } : {}) });
}

export function applyHarnessEvent(session: Session, event: HarnessEvent): Session {
  return fold.applyHarnessEvent(session, stamp(event));
}

export function applyHarnessEvents(session: Session, events: readonly HarnessEvent[]): Session {
  return fold.applyHarnessEvents(session, events.map(stamp));
}

export function appendUser(session: Session, text: string): Session {
  return applyHarnessEvent(session, { type: "user.message", text, clientMessageId: `c${seq + 1}` });
}

export function stopStreaming(session: Session): Session {
  return fold.stopStreaming(session, Date.now());
}
