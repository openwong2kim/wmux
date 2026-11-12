// Automated prompts (a scheduled prompt, the fan-out caller nudge, the
// usage-limit continue) wait while a dialog or selection menu is on the
// pane's screen. The screen is the session's own ring, read the way the
// daemon reads it.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { deliverScheduledPrompt, type ScheduledPromptDeliveryDeps } from '../sessionPromptDelivery';
import { deliverCallerNudge } from '../callerNudgeDelivery';
import { folderTrustRefusal, type FolderTrustSession } from '../folderTrustState';
import { RingBuffer } from '../RingBuffer';
import { USAGE_LIMIT_CONTINUE_PROMPT } from '../../shared/usageLimit';
import type { AgentStatus } from '../../shared/types';

const fixture = (dir: string, name: string): { screen: string[]; cols: number; rows: number } =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../approvals/__tests__/fixtures', dir, `${name}.json`), 'utf8'));

/** A full-screen TUI's frame: each row placed by cursor position, as Claude Code draws. */
const frame = (rows: string[]): Buffer => Buffer.from(`\x1b[2J${rows.map((row, i) => `\x1b[${i + 1};1H${row}`).join('')}`);

function session(rows: string[], cols: number, height: number): FolderTrustSession {
  const ring = new RingBuffer(1024 * 1024);
  ring.noteGeometry(cols, height);
  ring.write(frame(rows));
  return {
    meta: { state: 'attached', cols, rows: height },
    ptyProcess: { cols, rows: height },
    ringBuffer: ring,
    bridge: { isMuted: false, outputModes: null, heldOutput: () => null },
  } as unknown as FolderTrustSession;
}

const PERMISSION = fixture('terminal-prompts', 'claude-bash-boxed-01');
const TRUST = fixture('folder-trust', 'claude-folder-trust-60x30');
/** Claude Code at rest: the composer under the last reply, at the permission fixture's size. */
const IDLE = { cols: 50, rows: 24, screen: ['⏺ Done. The report is in out/report.md.', '', '────────────────────', '> ', '────────────────────', '  ? for shortcuts'] };

type Screen = { screen: string[]; cols: number; rows: number };

/** Delivery wired as the daemon wires it for its automated writers
 *  (index.ts deliverPromptToSessionNow). `onPaste`: the screen the pane
 *  shows once the paste is written, for a dialog that opens before Enter. */
function wired(screen: Screen, status: AgentStatus, opts: { onPaste?: Screen; onRefused?: (verdict: string) => void } = {}) {
  const s = session(screen.screen, Number(screen.cols), Number(screen.rows));
  const writes: string[] = [];
  let revision = 0;
  const deps: ScheduledPromptDeliveryDeps = {
    folderTrustBlocks: async () => {
      const refused = await folderTrustRefusal({ getSession: () => s }, 'pane', 'test writer', { refuseUnknown: true, refuseDialog: true, log: () => undefined });
      if (refused) opts.onRefused?.(refused);
      return refused;
    },
    getAgentState: () => ({ slug: 'claude', incarnationId: 'inc-1', status, inputQuiet: true, inputRevision: revision }),
    isAgentProcessAlive: async () => true,
    write: (data) => {
      writes.push(data);
      revision++;
      if (opts.onPaste && data !== '\r') (s.ringBuffer as RingBuffer).write(frame(opts.onPaste.screen));
      return true;
    },
    delay: async () => undefined,
  };
  return { deps, writes };
}

/** A selection menu under a cursor, as an agent shows when a turn stops on its usage limit. */
const MENU = { cols: 50, rows: 24, screen: ['⏺ You have reached your usage limit.', '', '  What do you want to do?', '', '❯ 1. Stop and wait for the reset', '  2. Switch to another plan'] };

const NUDGE = '[wmux] fan-out task 6k7g7szw updated — channel_mission_list';

const callers: Array<[string, AgentStatus, (deps: ScheduledPromptDeliveryDeps) => Promise<unknown>]> = [
  ['a scheduled prompt', 'waiting', (deps) => deliverScheduledPrompt('claude', 'inc-1', 'Run the nightly report.', deps)],
  ['the fan-out caller nudge', 'waiting', (deps) => deliverCallerNudge(NUDGE, {
    usageHeld: () => false,
    input: () => ({ hasDraft: () => false, isKeyInputQuietFor: () => true }),
    deliver: (opts) => deliverScheduledPrompt('claude', 'inc-1', NUDGE, { ...deps, ...opts }),
  })],
  ['the usage-limit continue', 'waiting', (deps) => deliverScheduledPrompt('claude', 'inc-1', USAGE_LIMIT_CONTINUE_PROMPT, {
    ...deps, acceptError: true, authorized: async () => true,
  })],
  ['the usage-limit continue at error', 'error', (deps) => deliverScheduledPrompt('claude', 'inc-1', USAGE_LIMIT_CONTINUE_PROMPT, {
    ...deps, acceptError: true, authorized: async () => true,
  })],
];

describe('automated prompt delivery and a dialog on screen', () => {
  it.each(callers)('%s presses no Enter into a permission dialog', async (_name, status, deliver) => {
    const { deps, writes } = wired(PERMISSION, status);
    await deliver(deps);
    expect(writes.filter((w) => w.includes('\r'))).toEqual([]);
  });

  it.each(callers)('%s presses no Enter into a selection menu', async (_name, status, deliver) => {
    const { deps, writes } = wired(MENU, status);
    await deliver(deps);
    expect(writes.filter((w) => w.includes('\r'))).toEqual([]);
  });

  it('refuses before writing anything: busy, held, and a continue that waits', async () => {
    const scheduled = wired(PERMISSION, 'waiting');
    expect(await deliverScheduledPrompt('claude', 'inc-1', 'Run the nightly report.', scheduled.deps)).toBe('busy');
    expect(scheduled.writes).toEqual([]);

    const nudge = wired(PERMISSION, 'waiting');
    expect(await callers[1][2](nudge.deps)).toEqual({ result: 'held', pasted: false });
    expect(nudge.writes).toEqual([]);

    // The continue's refusal hook (index.ts deliverContinue) turns any
    // refusal into 'folder_trust': the registry waits on its normal tick,
    // spending no busy retry and never disarming.
    const verdicts: string[] = [];
    const resume = wired(PERMISSION, 'error', { onRefused: (v) => verdicts.push(v) });
    expect(await callers[3][2](resume.deps)).toBe('busy');
    expect(verdicts).toEqual(['dialog']);
    expect(resume.writes).toEqual([]);
  });

  it('presses no Enter when a dialog opens between the paste and the Enter', async () => {
    const { deps, writes } = wired(IDLE, 'idle', { onPaste: PERMISSION });
    expect(await deliverScheduledPrompt('claude', 'inc-1', 'Run the nightly report.', deps)).toBe('error');
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toContain('\r');
  });

  it('a scheduled prompt still reaches an idle composer', async () => {
    const { deps, writes } = wired(IDLE, 'idle');
    expect(await deliverScheduledPrompt('claude', 'inc-1', 'Run the nightly report.', deps)).toBe('sent');
    expect(writes.at(-1)).toBe('\r');
  });

  it('a scheduled prompt still refuses a folder-trust prompt', async () => {
    const { deps, writes } = wired(TRUST, 'waiting');
    expect(await deliverScheduledPrompt('claude', 'inc-1', 'Run the nightly report.', deps)).toBe('folder_trust');
    expect(writes).toEqual([]);
  });
});
