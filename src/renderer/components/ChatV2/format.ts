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

// A finished call reads in the past tense ("Edited a.ts"); "Read" is both.
const PAST: Record<string, string> = { Edit: 'Edited', Write: 'Wrote', Delete: 'Deleted', Move: 'Moved', Find: 'Searched', Fetch: 'Fetched', Run: 'Ran', List: 'Listed' };
// A call in flight that already has a verb reads in the present ("Reading a.ts", not "Running Read a.ts").
const PRESENT: Record<string, string> = { Read: 'Reading', Edit: 'Editing', Write: 'Writing', Delete: 'Deleting', Move: 'Moving', Find: 'Searching', Fetch: 'Fetching', List: 'Listing' };

/**
 * A tool title split for the two-tone line: the verb (semibold) and what it
 * acted on. A raw shell command has no verb of its own, so it gets one; a
 * call still in flight reads "Running <command or tool>".
 */
export function toolLabelParts(title: string, opts: { command: boolean; running: boolean }): { verb: string; object: string } {
  const text = title.trim();
  const space = text.search(/\s/);
  const first = space < 0 ? text : text.slice(0, space);
  const object = space < 0 ? '' : text.slice(space).trim();
  if (opts.running) return !opts.command && PRESENT[first] ? { verb: PRESENT[first], object } : { verb: 'Running', object: text };
  if (opts.command) return { verb: 'Ran', object: text };
  return { verb: PAST[first] ? PAST[first] : first, object };
}

/** An absolute path for a preview path the agent may have given relative to its cwd. */
export function absolutePath(path: string, cwd: string): string {
  if (/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path) || !cwd) return path;
  return `${cwd.replace(/[\\/]+$/, '')}/${path.replace(/^\.\//, '')}`;
}

/**
 * A title or command with the chat's own directory left out of the paths in it
 * ("src/a.ts", not "/repo/src/a.ts"). On Windows either separator matches, and
 * the drive letter in either case; a drive root (C:\) is no prefix to drop,
 * and a UNC share (\\srv\share\repo) keeps its leading \\.
 */
export function relativeToCwd(text: string, cwd: string): string {
  const base = cwd.replace(/[\\/]+$/, '');
  if (!base || base === '~' || /^[A-Za-z]:$/.test(base)) return text;
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const drive = /^([A-Za-z]):/.exec(base);
  // A UNC share (\\srv\share) keeps its two leading separators.
  const unc = /^[\\/]{2}(?![\\/])/.test(base);
  const parts = (unc ? base.slice(2) : base).split(/[\\/]+/).map((part, index) =>
    index === 0 && drive ? `[${drive[1].toLowerCase()}${drive[1].toUpperCase()}]:` : escape(part)).join('[\\\\/]');
  const pattern = unc ? `[\\\\/]{2}${parts}` : parts;
  // Only where a path starts (line start, after a space, quote, = or paren): "/var/tmp/x" stays whole under "/tmp".
  return text.replace(new RegExp(`(^|[\\s'"=(:])${pattern}[\\\\/]`, 'g'), '$1');
}
