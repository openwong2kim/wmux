import { stripBom } from '../../../shared/stripBom';

export class JsonEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonEditError';
  }
}

export interface JsonEdit {
  path: (string | number)[];
  op: 'set' | 'delete';
  value?: unknown;
}

function detectJsonIndent(lines: string[]): string | number {
  for (const line of lines) {
    const match = line.match(/^([ \t]+)\S/);
    if (match) {
      const ws = match[1];
      if (ws.startsWith('\t')) return '\t';
      if (ws.startsWith('    ')) return 4;
      if (ws.startsWith('  ')) return 2;
    }
  }
  return 2;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}

export function editJsonKeys(text: string, edits: JsonEdit[]): string {
  let root: unknown;
  try {
    root = JSON.parse(stripBom(text));
  } catch (err) {
    throw new JsonEditError(`Invalid JSON: ${(err as Error).message}`);
  }

  if (edits.length === 0) {
    return text;
  }

  const originalCopy = JSON.parse(JSON.stringify(root));
  let modifiedRoot: unknown = root;
  for (const edit of edits) {
    modifiedRoot = applyJsonEdit(modifiedRoot, edit);
  }

  if (deepEqual(originalCopy, modifiedRoot)) {
    return text;
  }
  return formatLike(text, modifiedRoot);
}

function isUnsafeKey(seg: string | number): boolean {
  return seg === '__proto__' || seg === 'constructor' || seg === 'prototype';
}

/** Applies one edit and returns the root, which is a new value when the edit targets the root itself. */
function applyJsonEdit(root: unknown, edit: JsonEdit): unknown {
  if (edit.path.length === 0) {
    if (edit.op === 'set') return edit.value;
    if (edit.op === 'delete') return {};
    return root;
  }

  const parent = parentOf(root, edit);
  const lastSeg = edit.path[edit.path.length - 1];
  if (parent === null || isUnsafeKey(lastSeg)) {
    return root;
  }

  if (edit.op === 'set') {
    parent[lastSeg] = edit.value;
  } else if (edit.op === 'delete') {
    if (Array.isArray(parent) && typeof lastSeg === 'number') {
      parent.splice(lastSeg, 1);
    } else {
      delete parent[lastSeg];
    }
  }
  return root;
}

/**
 * The object or array that holds the edit's last segment. A set creates the missing levels (an array when the
 * next segment is a number); a delete through a missing level, or any path through an unsafe key, gives null.
 */
function parentOf(root: unknown, edit: JsonEdit): Record<string | number, unknown> | null {
  let current: any = root;
  for (let i = 0; i < edit.path.length - 1; i++) {
    const seg = edit.path[i];
    if (isUnsafeKey(seg)) {
      return null;
    }
    if (edit.op === 'set') {
      if (current[seg] === undefined || current[seg] === null || typeof current[seg] !== 'object') {
        current[seg] = typeof edit.path[i + 1] === 'number' ? [] : {};
      }
    } else if (current === null || typeof current !== 'object' || !(seg in current)) {
      return null;
    }
    current = current[seg];
  }
  return current !== null && typeof current === 'object' ? current : null;
}

/** `value` as JSON in the original text's byte order mark, indent, line endings and final newline. */
function formatLike(text: string, value: unknown): string {
  const bom = stripBom(text) === text ? '' : text[0];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = text.endsWith('\n') || text.endsWith('\r\n');
  const indent = detectJsonIndent(text.split(/\r?\n/));

  let formatted = JSON.stringify(value, null, indent);
  if (eol === '\r\n') {
    formatted = formatted.replace(/\n/g, '\r\n');
  }
  if (hasTrailingNewline) {
    formatted += eol;
  }
  return bom + formatted;
}
