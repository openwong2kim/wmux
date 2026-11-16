import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { A2A_REMOTE_RECORD_V, isA2aAnswersSetting, type A2aAnswersSetting } from '../../shared/a2aRemote';
import { isIsoString, loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * Whether this PC types the asking PC's answer into the question a headless
 * worker shows (`a2a-remote-answers.json`, headlessAnswer.ts): `on` or `off`.
 * `default` (saved as such, or no file at all): it follows the follow-ups
 * policy, on where follow-ups go straight to the agent (`direct`) and off
 * where they wait for a person (`ask`).
 *
 * Its own file, not a field of the spawn policy or of the status labels file:
 * a file rewritten by an older build drops fields it does not know, which
 * would turn an explicit `off` back into the default. A file that is there
 * but cannot be read or parsed reads as off, and says so (`damaged`): it is
 * set aside and `off` written in its place with the time it was found, so the
 * next start reads the same, until a person sets it again. If that write
 * fails, the file set aside (`<file>.corrupt-<time>`) with no file in its
 * place still reads as off on the next start. A file that cannot be told
 * apart from a missing one (a folder that cannot be searched) reads as there.
 */
export const ANSWERS_FILE = 'a2a-remote-answers.json';

interface AnswersSettingsV1 {
  v: 1;
  answers: A2aAnswersSetting;
  /** Set when the file was found damaged and `off` written in its place. */
  damagedAt?: string;
}

/** Only ENOENT is a missing file: any other failure to look (EACCES on the folder, say) counts as a file there. */
function fileThere(filePath: string): boolean {
  try {
    fs.statSync(filePath);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** A damaged file set aside by an earlier start whose repair write failed. */
function corruptLeftover(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => name.startsWith(`${ANSWERS_FILE}.corrupt-`));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function coerce(raw: unknown): AnswersSettingsV1 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== A2A_REMOTE_RECORD_V || !isA2aAnswersSetting(r['answers'])) return null;
  const damagedAt = r['damagedAt'];
  if (damagedAt !== undefined && (r['answers'] !== 'off' || !isIsoString(damagedAt))) return null;
  return { v: 1, answers: r['answers'], ...(typeof damagedAt === 'string' ? { damagedAt } : {}) };
}

export interface AnswersStoreOptions {
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seams. */
  write?: (filePath: string, data: unknown) => void;
  scheduleHarden?: (filePath: string) => void;
}

export class AnswersStore {
  readonly filePath: string;
  private readonly log: StoreLog;
  private readonly now: () => number;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  /** `default`: no file. */
  private setting: A2aAnswersSetting;
  private damaged: boolean;
  private readonly writable: boolean;

  constructor(opts: AnswersStoreOptions) {
    this.filePath = path.join(opts.dir, ANSWERS_FILE);
    this.log = opts.log ?? ((): void => undefined);
    this.now = opts.now ?? Date.now;
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    const present = fileThere(this.filePath);
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: ANSWERS_FILE,
      coerce,
      now: this.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'answers from other PCs are off until `wmux remote answers` sets them',
    });
    this.writable = loaded.writable;
    if (loaded.value) {
      this.setting = loaded.value.answers;
      this.damaged = loaded.value.damagedAt !== undefined;
    } else if (!present && !corruptLeftover(opts.dir)) {
      this.setting = 'default';
      this.damaged = false;
    } else {
      this.setting = 'off';
      this.damaged = true;
      // Set aside as damaged (now, or by a start whose repair write failed): `off` takes its place on disk too.
      if (this.writable) this.persist({ v: 1, answers: 'off', damagedAt: new Date(this.now()).toISOString() });
    }
  }

  private persist(data: AnswersSettingsV1): string | null {
    try {
      this.write(this.filePath, data);
      this.scheduleHarden(this.filePath);
      return null;
    } catch (err) {
      const error = `${ANSWERS_FILE}: not saved: ${err instanceof Error ? err.message : String(err)}`;
      this.log('error', `[a2a-remote] ${error}`);
      return error;
    }
  }

  /** The setting as saved (`default`: no file), and whether it is off because the file was damaged. */
  get(): { answers: A2aAnswersSetting; damaged: boolean } {
    return { answers: this.setting, damaged: this.damaged };
  }

  /** What applies now: `default` follows the follow-ups policy. */
  effective(followUpsDirect: boolean): 'on' | 'off' | 'damaged' {
    if (this.damaged) return 'damaged';
    if (this.setting === 'default') return followUpsDirect ? 'on' : 'off';
    return this.setting;
  }

  /** Save `on`, `off` or `default` (saved as such, so a damaged file set aside earlier never reads as one). */
  set(answers: A2aAnswersSetting): { ok: true; answers: A2aAnswersSetting } | { ok: false; error: string } {
    if (!this.writable) return { ok: false, error: storeUnavailable(ANSWERS_FILE).message };
    const error = this.persist({ v: 1, answers });
    if (error) return { ok: false, error };
    this.setting = answers;
    this.damaged = false;
    return { ok: true, answers };
  }
}
