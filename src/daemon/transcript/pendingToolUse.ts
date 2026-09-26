// The tool call a Claude pane is waiting on, read from its own transcript.
//
// A `terminal_prompt` record may be answered from a phone only when the dialog
// on screen is bound to the call the agent actually made: the transcript's
// latest `tool_use` that has no `tool_result` yet, with the same tool and the
// same full command. Screen text alone is not enough — a dialog can be printed
// by anything running in the pane, and a row inside a command can be read as
// the dialog's frame. The transcript is written by the agent itself.

import fs from 'node:fs';

export interface PendingToolUse {
  /** The `tool_use` block's id — one dialog instance. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** How much of the transcript's end is read. A permission wait is at the tail. */
export const PENDING_TOOL_USE_TAIL_BYTES = 256 * 1024;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function contentBlocks(entry: Json): Json[] {
  const message = entry['message'];
  if (!isObject(message)) return [];
  const content = message['content'];
  return Array.isArray(content) ? content.filter(isObject) : [];
}

/**
 * The latest `tool_use` in these transcript entries (oldest first) if no
 * `tool_result` answers it; null otherwise. Sidechain (subagent) entries are
 * not the pane's own dialog and are skipped.
 */
export function latestPendingToolUse(entries: readonly unknown[]): PendingToolUse | null {
  let latest: PendingToolUse | null = null;
  const answered = new Set<string>();
  for (const entry of entries) {
    if (!isObject(entry) || entry['isSidechain'] === true) continue;
    const type = entry['type'];
    for (const block of contentBlocks(entry)) {
      if (type === 'assistant' && block['type'] === 'tool_use') {
        const id = block['id'];
        const name = block['name'];
        if (typeof id === 'string' && id && typeof name === 'string' && name) {
          latest = { id, name, input: isObject(block['input']) ? block['input'] : {} };
        }
      } else if (type === 'user' && block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        answered.add(block['tool_use_id']);
      }
    }
  }
  return latest && !answered.has(latest.id) ? latest : null;
}

/**
 * Read the transcript's tail and find its pending tool call. Null when the file
 * cannot be read or nothing is pending. Synchronous and bounded.
 */
export function readPendingToolUse(
  transcriptPath: string,
  maxBytes = PENDING_TOOL_USE_TAIL_BYTES,
): PendingToolUse | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    // A read that starts mid-file starts mid-line.
    if (start > 0) lines.shift();
    const entries: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A half-written last line, or a line cut by the window: skipped.
      }
    }
    return latestPendingToolUse(entries);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already gone */ }
    }
  }
}

/**
 * The text a tool's permission dialog shows as "the command": Bash's
 * `command`, otherwise the path / url / pattern the call acts on.
 */
export function commandOfToolInput(name: string, input: Record<string, unknown>): string | undefined {
  const fields = name === 'Bash' ? ['command'] : ['file_path', 'notebook_path', 'path', 'url', 'pattern'];
  for (const field of fields) {
    const value = input[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}
