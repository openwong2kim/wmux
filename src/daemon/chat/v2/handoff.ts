import {
  CHATV2_PROVIDER_SESSION_ID,
  chatV2Error,
  type ChatV2Error,
  type ChatV2ResultByMethod,
} from '../../../shared/chatv2/ipc';
import type { ChatV2Driver, ChatV2HostDeps, ChatV2StoredRecord } from './types';

/**
 * Chat → terminal handoff, the only direction v1 offers (ipc.ts, Ownership).
 * The host calls it for `toTerminal`. The order is the safety argument:
 *
 *   1. stop the driver, then prove by pid that its process is gone;
 *   2. persist the record as the `handed-off` tombstone;
 *   3. type `claude --resume <providerSessionId>` into the anchor shell.
 *
 * A failed step leaves every later step undone, so the TUI never starts while
 * the driver could still append to the same conversation, and a tombstone is
 * never written for a driver that still runs. The provider session id is
 * checked against the UUID pattern before anything happens: it is the one
 * value that reaches the shell.
 */

export interface ChatV2HandoffDeps extends Pick<ChatV2HostDeps, 'paneFree' | 'writeToPane' | 'processIdentity'> {
  /** Persist the record atomically. Rejects when the write failed. */
  persist: (record: ChatV2StoredRecord) => Promise<void>;
}

export interface ChatV2HandoffInput {
  record: ChatV2StoredRecord;
  /** The live driver, or null when the record has no process (restored, or exited). */
  driver: Pick<ChatV2Driver, 'pid' | 'stop'> | null;
}

export type ChatV2HandoffResult =
  | { ok: true; record: ChatV2StoredRecord }
  | Extract<ChatV2ResultByMethod['toTerminal'], { ok: false }>;

/** The agent's resume command, typed into the anchor shell and submitted. */
export function resumeCommand(providerSessionId: string): string {
  return `claude --resume ${providerSessionId}\r`;
}

/**
 * Whether `pid` still runs as the driver's process. A pid that is gone, or now
 * belongs to a process with another start time and without the conversation
 * id in its command line, has exited.
 */
async function driverAlive(
  deps: Pick<ChatV2HandoffDeps, 'processIdentity'>,
  pid: number,
  record: ChatV2StoredRecord,
): Promise<boolean> {
  const identity = await deps.processIdentity(pid);
  if (!identity) return false;
  if (record.process?.pid === pid && identity.startTime === record.process.startTime) return true;
  return identity.commandLine.includes(record.providerSessionId);
}

export async function handOffToTerminal(deps: ChatV2HandoffDeps, input: ChatV2HandoffInput): Promise<ChatV2HandoffResult> {
  const { record, driver } = input;
  const refuse = (message: string) => chatV2Error('handoff-refused', message);
  if (record.state === 'handed-off') return chatV2Error('handed-off', 'This chat already moved to the terminal.');
  if (!CHATV2_PROVIDER_SESSION_ID.test(record.providerSessionId)) {
    return refuse('The conversation id cannot be resumed in a terminal.');
  }
  if (!(await deps.paneFree(record.paneId))) return refuse('The terminal is busy.');

  // 1. Stop the driver and prove its process is gone.
  const pid = driver?.pid ?? record.process?.pid;
  if (driver) {
    try {
      await driver.stop();
    } catch {
      return refuse('The chat agent could not be stopped.');
    }
  }
  if (pid !== undefined && await driverAlive(deps, pid, record)) {
    return refuse('The chat agent is still running.');
  }

  // 2. The tombstone, before anything reaches the shell.
  const tombstone: ChatV2StoredRecord = { ...record, state: 'handed-off' };
  delete tombstone.process;
  try {
    await deps.persist(tombstone);
  } catch {
    return refuse('The chat could not be saved as handed off.');
  }

  // 3. Resume the same conversation in the anchor shell's TUI.
  if (!deps.writeToPane(record.paneId, resumeCommand(record.providerSessionId))) {
    return refuse('The terminal is gone.');
  }
  return { ok: true, record: tombstone };
}

/**
 * The refusal a `handed-off` record answers to `send` and to any driver
 * (re)start, or null. The host checks it before it touches the driver.
 */
export function handedOffRefusal(record: Pick<ChatV2StoredRecord, 'state'>): { ok: false; error: ChatV2Error } | null {
  return record.state === 'handed-off'
    ? chatV2Error('handed-off', 'This chat moved to the terminal. Continue it there.')
    : null;
}
