// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/features/sessions/ui/AgentTranscript.tsx), MIT License, Copyright (c) 2026 Nick
//
// Turn footer wording: `<model> worked for 2m 5s · 3:41 PM`.
import { claudeModelLabel } from '../../../shared/claudeModels';
import { HARNESS_TITLE, type HarnessId } from '../../../shared/chatv2/session';

export function formatElapsed(elapsedMs: number | null | undefined): string | null {
  if (elapsedMs == null) return null;
  const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Wall-clock stamp for a finished turn, in the reader's own locale. */
export function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** The model a turn ran on, as people call it ('' = the agent's default). */
export function turnModelLabel(harness: HarnessId, modelId: string | undefined): string {
  if (!modelId) return HARNESS_TITLE[harness];
  return harness === 'claude' ? claudeModelLabel(modelId) : modelId;
}

export function formatWorkingDuration(elapsedMs: number | null, modelName: string, done: boolean): string {
  const elapsed = formatElapsed(elapsedMs);
  const verb = done ? 'worked' : 'working';
  if (elapsed == null) return done ? `${modelName} ${verb}` : `${modelName} ${verb}…`;
  return `${modelName} ${verb} for ${elapsed}`;
}
