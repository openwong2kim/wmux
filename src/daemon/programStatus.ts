/**
 * Program Status Protocol (OSC 7501, spec revision 0.4): a program reports its
 * own state — idle, working, blocked on the user, done, failed — instead of
 * the terminal guessing it from the screen.
 *
 *   OSC 7501 ; state=blocked:kind=permission:app=codex ST
 *
 * Everything in a report is untrusted program output. A report is applied
 * whole or not at all: any limit broken, a body that does not decode, or a
 * control character in decoded text discards it. `title` / `msg` are stored
 * as plain text with bidi and zero-width characters removed; nothing here is
 * ever written back to the PTY.
 */

export const PROGRAM_STATUS_OSC = 7501;

export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error';
export type ProgramBlockedKind = 'permission' | 'question' | 'auth';

export interface ProgramStatusReport {
  state: ProgramState | 'clear';
  /** Absent: the root record. */
  id?: string;
  kind?: ProgramBlockedKind;
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
}

export interface ProgramStatusRecord extends Omit<ProgramStatusReport, 'state'> {
  state: ProgramState;
  updatedAt: number;
  /** When the record entered its state: a repeat of the same state keeps it. */
  stateSince: number;
}

const STATES = new Set(['idle', 'working', 'done', 'blocked', 'error', 'clear']);
const KINDS = new Set(['permission', 'question', 'auth']);
/** `ESC ] 7501 ;` plus a two-byte `ESC \` terminator around the payload. */
const MAX_PAYLOAD_BYTES = 4096 - 9;
const MAX_KEY_BYTES = 16;
const MAX_APP_BYTES = 32;
const MAX_ID_BYTES = 128;
const MAX_ID_DEPTH = 8;
const TEXT_LIMITS = { title: { encoded: 256, decoded: 192 }, msg: { encoded: 2732, decoded: 2048 } } as const;
export const MAX_PROGRAM_STATUS_RECORDS = 256;

const KEY = /^[a-z]+$/;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const APP = /^[A-Za-z0-9_.+-]{1,32}$/;
const BASE64 = /^([A-Za-z0-9+/]*)(={0,2})$/;
// eslint-disable-next-line no-control-regex -- C0, DEL and C1 are what the spec refuses
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Bidi controls, zero-width characters and line/paragraph separators. */
const INVISIBLE = /[\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g;

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Strict base64 (padding optional) of UTF-8 text; null on any defect or limit. */
function decodeText(value: string, limits: { encoded: number; decoded: number }): string | null {
  if (value.length > limits.encoded) return null;
  const m = BASE64.exec(value);
  if (!m) return null;
  const body = m[1];
  if (body.length % 4 === 1 || (m[2] && (body.length + m[2].length) % 4 !== 0)) return null;
  const bytes = Buffer.from(body, 'base64');
  // Canonical only: rejects non-zero trailing bits that a lenient decoder drops.
  if (bytes.toString('base64').replace(/=+$/, '') !== body || bytes.length > limits.decoded) return null;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return null;
  }
  if (CONTROL.test(text)) return null;
  return text.replace(INVISIBLE, '');
}

function validId(id: string): boolean {
  if (Buffer.byteLength(id) > MAX_ID_BYTES) return false;
  const segments = id.split('/');
  return segments.length <= MAX_ID_DEPTH && segments.every((s) => SEGMENT.test(s));
}

/**
 * Parse the payload after `7501;`. Null for a feature-detection query (`?`)
 * and for every report the spec says to discard or ignore.
 */
export function parseProgramStatus(payload: string): ProgramStatusReport | null {
  if (payload.startsWith('?')) return null;
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) return null;
  const pairs = new Map<string, string>();
  for (const pair of payload.split(':')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!KEY.test(key)) continue;
    if (key.length > MAX_KEY_BYTES) return null;
    if (!VALUE.test(value)) continue;
    pairs.set(key, value);
  }
  const state = pairs.get('state');
  if (state === undefined || !STATES.has(state)) return null;
  const report: ProgramStatusReport = { state: state as ProgramStatusReport['state'] };
  const id = pairs.get('id');
  if (id !== undefined) {
    if (!validId(id)) return null;
    report.id = id;
  }
  const kind = pairs.get('kind');
  if (state === 'blocked' && kind !== undefined && KINDS.has(kind)) report.kind = kind as ProgramBlockedKind;
  const progress = pairs.get('progress');
  if ((state === 'working' || state === 'blocked') && progress !== undefined && /^\d{1,3}$/.test(progress) && Number(progress) <= 100) {
    report.progress = Number(progress);
  }
  const app = pairs.get('app');
  if (app !== undefined) {
    if (app.length > MAX_APP_BYTES) return null;
    if (APP.test(app)) report.app = app;
  }
  for (const key of ['title', 'msg'] as const) {
    const value = pairs.get(key);
    if (value === undefined) continue;
    const text = decodeText(value, TEXT_LIMITS[key]);
    if (text === null) return null;
    report[key] = text;
  }
  return report;
}

/**
 * One terminal's records, keyed by id ('' = root). Each report replaces its
 * record whole. Map order is update order, so the first entry is the least
 * recently updated one, evicted when a new record would pass the cap.
 */
export class ProgramStatusStore {
  private readonly records = new Map<string, ProgramStatusRecord>();

  get size(): number {
    return this.records.size;
  }

  root(): ProgramStatusRecord | undefined {
    return this.records.get('');
  }

  apply(report: ProgramStatusReport, now: number): void {
    if (report.state === 'clear') {
      if (report.id === undefined) {
        this.records.clear();
        return;
      }
      const prefix = `${report.id}/`;
      for (const key of [...this.records.keys()]) {
        if (key === report.id || key.startsWith(prefix)) this.records.delete(key);
      }
      return;
    }
    const key = report.id ?? '';
    const prior = this.records.get(key);
    this.records.delete(key);
    if (this.records.size >= MAX_PROGRAM_STATUS_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }
    const stateSince = prior?.state === report.state ? prior.stateSince : now;
    this.records.set(key, { ...report, state: report.state, updatedAt: now, stateSince });
  }

  /** The process exited or a shell prompt began: working and blocked records end. */
  dropTransient(): void {
    for (const [key, record] of [...this.records]) {
      if (record.state === 'working' || record.state === 'blocked') this.records.delete(key);
    }
  }

  clear(): void {
    this.records.clear();
  }
}
