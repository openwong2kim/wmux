import * as fs from 'fs';
import { parse as parseTomlText } from 'smol-toml';
import { assertUnchanged, FileSnapshot, snapshotFile } from './snapshot';
import { backupFile } from './backup';
import { writeFileAtomic } from './atomicWrite';
import { editJsonKeys, JsonEdit } from './jsonEdit';
import { editTomlKeys, TomlEdit } from './tomlEdit';
import { stripBom } from '../../../shared/stripBom';

export interface ApplyConfigEditOptions {
  path: string;
  kind: 'json' | 'toml';
  edits: JsonEdit[] | TomlEdit[];
  backup?: boolean;
  now?: Date | number;
  snapshot?: FileSnapshot;
}

export interface ApplyConfigEditResult {
  changed: boolean;
  backupPath?: string;
}

export function applyConfigEdit(options: ApplyConfigEditOptions): ApplyConfigEditResult {
  const snap = options.snapshot ?? snapshotFile(options.path);

  if (!snap.exists) {
    const hasSetEdits = (options.edits as (JsonEdit | TomlEdit)[]).some((e) => e.op === 'set');
    if (!hasSetEdits) {
      return { changed: false };
    }

    let newText: string;
    if (options.kind === 'json') {
      newText = editJsonKeys('{}', options.edits as JsonEdit[]);
    } else {
      newText = editTomlKeys('', options.edits as TomlEdit[]);
    }

    // The check-then-rename race window is not closed without OS file locking.
    assertUnchanged(options.path, snap);
    writeFileAtomic(options.path, newText);

    try {
      const written = fs.readFileSync(options.path, 'utf8');
      if (options.kind === 'json') {
        JSON.parse(stripBom(written));
      } else {
        parseTomlText(written);
      }
    } catch (err) {
      try {
        fs.unlinkSync(options.path);
      } catch {}
      throw err;
    }

    return { changed: true };
  }

  const currentText = snap.text!;
  let newText: string;
  if (options.kind === 'json') {
    newText = editJsonKeys(currentText, options.edits as JsonEdit[]);
  } else {
    newText = editTomlKeys(currentText, options.edits as TomlEdit[]);
  }

  if (newText === currentText) {
    return { changed: false };
  }

  let backupPath: string | undefined;
  if (options.backup !== false) {
    backupPath = backupFile(options.path, options.now);
  }

  // The check-then-rename race window is not closed without OS file locking.
  assertUnchanged(options.path, snap);
  writeFileAtomic(options.path, newText);

  try {
    const written = fs.readFileSync(options.path, 'utf8');
    if (options.kind === 'json') {
      JSON.parse(stripBom(written));
    } else {
      parseTomlText(written);
    }
  } catch (err) {
    try {
      writeFileAtomic(options.path, currentText);
    } catch {}
    throw err;
  }

  return { changed: true, backupPath };
}
