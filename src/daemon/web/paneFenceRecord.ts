// A person's fenced panes, as main records them (main/agents/
// paneFenceSessions.ts, `factory/pane-fence-sessions.json`): the phone and
// web launch routes read it, so a launch typed without main is refused in a
// pane main would fence. Read fresh on every call: main writes it.

import fs from 'node:fs';
import path from 'node:path';

/** Whether `sessionId`'s next agent launch is fenced. An unreadable record
 *  counts as fenced (a missing one is no fenced session). */
export function paneFenceOnInRecord(wmuxDir: string, sessionId: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(path.join(wmuxDir, 'factory', 'pane-fence-sessions.json'), 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  try {
    const sessions = (JSON.parse(text) as { sessions?: Record<string, { on?: unknown }> }).sessions;
    const r = sessions && typeof sessions === 'object' ? sessions[sessionId] : undefined;
    return !!r && typeof r === 'object' && r.on === true;
  } catch {
    return true;
  }
}
