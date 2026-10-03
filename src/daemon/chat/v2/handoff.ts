import {
  CHATV2_MODEL,
  CHATV2_PROVIDER_SESSION_ID,
  chatV2Error,
  type ChatV2Error,
  type ChatV2RunMode,
} from '../../../shared/chatv2/ipc';
import { permissionFlagFor } from '../../../shared/agentResume';
import type { ChatV2Driver, ChatV2HostDeps, ChatV2StoredRecord } from './types';

/**
 * Chat → terminal handoff, the only direction v1 offers (ipc.ts, Ownership).
 * The host calls it for `toTerminal`. The order is the safety argument:
 *
 *   1. stop the driver, prove by pid that its process is gone, and check the
 *      anchor shell is free and sits at an empty prompt;
 *   2. persist the record as the `handed-off` tombstone;
 *   3. check the shell again and type the resume command.
 *
 * A failed step leaves every later step undone, so the TUI never starts while
 * the driver could still append to the same conversation. A process whose
 * state cannot be read counts as running. If the shell changed after the
 * tombstone was written, the tombstone is rolled back. Every value that
 * reaches the shell is checked against its pattern first.
 */

/** What a pid probe can tell: only `gone` is proof the process exited. */
export type ProcessProbe = 'gone' | 'exists' | 'unknown';

export interface ChatV2HandoffDeps extends Pick<ChatV2HostDeps, 'paneFree' | 'writeToPane' | 'processIdentity'> {
  /** Persist the record atomically. Rejects when the write failed. */
  persist: (record: ChatV2StoredRecord) => Promise<void>;
  /**
   * The anchor shell's input revision while it sits at an empty prompt of a
   * POSIX shell, or null (not provably empty, no shell integration, Windows).
   * The command is typed only while the revision is unchanged.
   */
  promptRevision: (paneId: string) => number | null;
  /** Defaults to signal 0: ESRCH is `gone`, success or EPERM is `exists`. */
  probe?: (pid: number) => ProcessProbe;
}

export interface ChatV2HandoffInput {
  record: ChatV2StoredRecord;
  /** The live driver, or null when the record has no process (restored, or exited). */
  driver: Pick<ChatV2Driver, 'pid' | 'stop'> | null;
}

/**
 * On failure `record`, when present, is what is persisted now and the host
 * adopts it: the rolled-back record, or the tombstone when the rollback
 * failed too.
 */
export type ChatV2HandoffResult =
  | { ok: true; record: ChatV2StoredRecord }
  | { ok: false; error: ChatV2Error; record?: ChatV2StoredRecord };

function signalProbe(pid: number): ProcessProbe {
  try {
    process.kill(pid, 0);
    return 'exists';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ESRCH' ? 'gone' : code === 'EPERM' ? 'exists' : 'unknown';
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Anything a command line must never carry: C0 controls and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The resume command for the anchor shell: back to the conversation's cwd,
 * then the agent with the same model and permission mode, submitted. Null when
 * a value fails its check.
 */
export function resumeCommand(record: Pick<ChatV2StoredRecord, 'providerSessionId' | 'model' | 'mode' | 'session'>): string | null {
  const { providerSessionId, model, mode } = record;
  const cwd = record.session.cwd;
  if (!CHATV2_PROVIDER_SESSION_ID.test(providerSessionId)) return null;
  if (model && !CHATV2_MODEL.test(model)) return null;
  if (!cwd || CONTROL.test(cwd)) return null;
  const permission = permissionFlagFor(modePermission(mode));
  const parts = [
    'cd', '--', shellQuote(cwd), '&&',
    'claude', '--resume', providerSessionId,
    ...(model ? [shellQuote(`--model=${model}`)] : []),
    ...(permission ? [permission] : []),
  ];
  return `${parts.join(' ')}\r`;
}

function modePermission(mode: ChatV2RunMode): 'bypassPermissions' | 'default' {
  return mode === 'bypass' ? 'bypassPermissions' : 'default';
}

/**
 * Whether `pid` still runs as the driver. `gone` needs proof: the pid does not
 * exist, or it now belongs to another process (another start time, without the
 * conversation id in its command line). Anything unreadable is `unknown`.
 */
async function driverState(
  deps: Pick<ChatV2HandoffDeps, 'processIdentity' | 'probe'>,
  pid: number,
  record: ChatV2StoredRecord,
): Promise<'gone' | 'alive' | 'unknown'> {
  const probe = (deps.probe ?? signalProbe)(pid);
  if (probe !== 'exists') return probe;
  const identity = await deps.processIdentity(pid).catch(() => null);
  if (!identity) return 'unknown';
  if (identity.commandLine.includes(record.providerSessionId)) return 'alive';
  if (record.process?.pid === pid && record.process.startTime && identity.startTime === record.process.startTime) return 'alive';
  return 'gone';
}

/** Panes with a handoff in flight: a second one is refused, never interleaved. */
const inFlight = new Set<string>();

export async function handOffToTerminal(deps: ChatV2HandoffDeps, input: ChatV2HandoffInput): Promise<ChatV2HandoffResult> {
  const { paneId } = input.record;
  if (inFlight.has(paneId)) return chatV2Error('handoff-refused', 'This chat is already moving to the terminal.');
  inFlight.add(paneId);
  try {
    return await handOff(deps, input);
  } finally {
    inFlight.delete(paneId);
  }
}

async function handOff(deps: ChatV2HandoffDeps, input: ChatV2HandoffInput): Promise<ChatV2HandoffResult> {
  const { record, driver } = input;
  const { paneId } = record;
  const refuse = (message: string) => chatV2Error('handoff-refused', message);
  if (record.state === 'handed-off') return chatV2Error('handed-off', 'This chat already moved to the terminal.');
  const command = resumeCommand(record);
  if (!command) return refuse('This conversation cannot be resumed in a terminal.');

  // 1. Stop the driver and prove its process is gone.
  const pid = driver?.pid ?? record.process?.pid;
  if (driver) {
    try {
      await driver.stop();
    } catch {
      return refuse('The chat agent could not be stopped.');
    }
  }
  if (pid !== undefined) {
    const state = await driverState(deps, pid, record);
    if (state === 'alive') return refuse('The chat agent is still running.');
    if (state === 'unknown') return refuse('Could not confirm that the chat agent stopped.');
  }
  // Checked once the driver is gone: its own process must not read as the pane
  // being busy. A refusal here leaves the record active with no process
  // (`stopped`), which the next send restarts.
  if (!(await deps.paneFree(paneId))) return refuse('The terminal is busy.');
  const revision = deps.promptRevision(paneId);
  if (revision === null) return refuse('The terminal prompt is not empty.');

  // 2. The tombstone, before anything reaches the shell.
  const tombstone: ChatV2StoredRecord = { ...record, state: 'handed-off' };
  delete tombstone.process;
  try {
    await deps.persist(tombstone);
  } catch {
    return refuse('The chat could not be saved as handed off.');
  }

  // 3. The shell again, then the command, with no await between the last check and the write.
  const free = await deps.paneFree(paneId).catch(() => false);
  const typed = free && deps.promptRevision(paneId) === revision
    && deps.writeToPane(paneId, command);
  if (typed) return { ok: true, record: tombstone };
  return rollBack(deps, record, tombstone, free ? 'The terminal is gone or no longer at an empty prompt.' : 'The terminal is busy.');
}

/** Undo the tombstone after nothing was typed: the record is active again, without a process. */
async function rollBack(
  deps: Pick<ChatV2HandoffDeps, 'persist'>,
  record: ChatV2StoredRecord,
  tombstone: ChatV2StoredRecord,
  message: string,
): Promise<ChatV2HandoffResult> {
  const restored: ChatV2StoredRecord = { ...record, state: 'active' };
  delete restored.process;
  try {
    await deps.persist(restored);
    return { ...chatV2Error('handoff-refused', message), record: restored };
  } catch {
    return { ...chatV2Error('handoff-refused', message), record: tombstone };
  }
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
