import * as fs from 'node:fs';
import * as path from 'node:path';
import { win32AliasedName } from './wslPaths';

// ---------------------------------------------------------------------------
// browser_file_upload, the parts both processes need: the uploads root, the
// path check, and the search for the file input. The MCP tool runs the check
// for its own error wording; main runs it again on whatever reaches its RPC
// and hands the page only what it returned.
// ---------------------------------------------------------------------------

/** The default file input — the page's first one, as before `selector` existed. */
export const DEFAULT_FILE_INPUT_SELECTOR = 'input[type="file"]';

/** `<wmuxDir>/uploads`, created when missing, with links resolved. */
export function uploadRootIn(wmuxDir: string): string {
  const root = path.join(wmuxDir, 'uploads');
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

/** Why a host path may not be handed to a page. */
export type UploadPathRefusal =
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'aliased'; name: string }
  | { ok: false; reason: 'unresolvable' }
  | { ok: false; reason: 'outside' };

/**
 * The one gate on what a page may be handed. What reaches the browser is the
 * path this RETURNS — the realpath'd, root-checked value — never the input.
 *
 * Takes a HOST path: a WSL caller's `/mnt/<drive>/` spelling is converted by
 * the caller, which is the side that knows its mount. An unconverted one is
 * just a path outside the root here.
 *
 * Five ways out of the root, and what stops each:
 *  - `..` segments — path.resolve() normalises them before any check.
 *  - a symlink/junction inside the root pointing out of it — realpathSync()
 *    resolves it, so the relative check runs against the true target.
 *  - another drive or a UNC share (`E:\x`, `\\host\share\x`) — path.relative()
 *    then returns an absolute path, which path.isAbsolute() rejects.
 *  - a path that does not exist, where realpath cannot run: it stays lexical,
 *    but a path Chrome cannot open is a path Chrome cannot leak. fs.existsSync
 *    resolves links exactly as the browser would, so "exists" and "openable"
 *    are the same question here — with one exception, refused up front:
 *  - on Windows, a name ending in a dot or space, or a device name. Node asks
 *    through the `\\?\` namespace, where `uploads\link.\f` does not exist, so
 *    realpath never runs; Chrome opens it as `uploads\link\f` and follows the
 *    junction out of the root (measured on NTFS with Electron 41).
 *
 * Note what is NOT on that list: a path that EXISTS and whose realpath still
 * cannot be computed. Every guarantee above rests on resolving links first, so
 * on that input the gate would quietly become a lexical string compare — a
 * weaker check of a different kind — and that lexical string is exactly what
 * Chrome would then be asked to open. It is refused instead. existsSync does
 * not throw, so the only inputs that get there are already anomalous.
 *
 * The residue is TOCTOU — swapping the file for a symlink between this check
 * and the upload — which needs write access to the uploads root.
 */
export function checkUploadPath(
  hostPath: unknown,
  root: string,
): { ok: true; path: string } | UploadPathRefusal {
  if (typeof hostPath !== 'string' || hostPath.length === 0) return { ok: false, reason: 'empty' };
  const abs = path.resolve(hostPath);
  if (process.platform === 'win32') {
    const aliased = win32AliasedName(abs);
    if (aliased !== undefined) return { ok: false, reason: 'aliased', name: aliased };
  }
  let resolved = abs;
  try {
    if (fs.existsSync(abs)) resolved = fs.realpathSync(abs);
  } catch {
    return { ok: false, reason: 'unresolvable' };
  }
  const rel = path.relative(root, resolved);
  // `rel === '..'` and `'..' + sep` are the escapes; a bare startsWith('..')
  // also swallows legitimate names — `..dots` in the root relativises to
  // `..dots` and was refused forever.
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { ok: false, reason: 'outside' };
  }
  return { ok: true, path: resolved };
}

/** The shape of the DOM nodes the proximity search walks. */
interface ProximityNode {
  nodeType?: number;
  tagName?: string;
  id?: string;
  getAttribute?: (name: string) => string | null;
  children?: ArrayLike<ProximityNode>;
  parentElement?: ProximityNode | null;
  closest?: (selector: string) => ProximityNode | null;
}

/**
 * Find the file input at or near an anchor element.
 *
 * mirrors browser-use browser/session.py find_file_input_near_element: from the
 * anchor, walk up to MAX_HEIGHT parents; at each level test the node itself,
 * its descendants up to MAX_DESCENDANT_DEPTH, and its siblings, for an
 * `input[type=file]`.
 *
 * Why it is needed: real uploaders style a <button>/<label> and keep the actual
 * input visually hidden, so the ref an agent gets from a snapshot is the button,
 * and setting files on a button fails with an unhelpful error.
 *
 * Deliberately self-contained (no imports, no closure): Playwright serialises
 * it and calls it with the element as its argument, and main injects its
 * source into the page. It used to be passed to Playwright as a source STRING,
 * which Playwright evaluated as an expression instead — the search never ran
 * on the anchor at all and every styled uploader reported "no file input
 * found" (live dogfood).
 */
export function findFileInputNearElement(anchor: unknown): unknown {
  const MAX_HEIGHT = 3;
  const MAX_DESCENDANT_DEPTH = 3;
  const start = anchor as ProximityNode | null;
  const isFileInput = (n: ProximityNode | null | undefined): boolean =>
    !!n &&
    n.nodeType === 1 &&
    n.tagName === 'INPUT' &&
    String((n.getAttribute && n.getAttribute('type')) || '').toLowerCase() === 'file';

  // Walking three levels up reaches sibling subtrees that can belong to a
  // DIFFERENT widget — a second upload form on the same page. When either the
  // anchor or the candidate sits in a <form>, they must sit in the SAME one;
  // otherwise the files would be attached to someone else's form.
  const anchorForm = start && start.closest ? start.closest('form') : null;
  const sameOwner = (n: ProximityNode): boolean => {
    const form = n.closest ? n.closest('form') : null;
    if (anchorForm || form) return form === anchorForm;
    return true;
  };
  const accept = (n: ProximityNode | null | undefined): boolean => !!n && isFileInput(n) && sameOwner(n);

  const inDescendants = (n: ProximityNode | null | undefined, depth: number): ProximityNode | null => {
    if (!n || depth < 0) return null;
    if (accept(n)) return n;
    const kids = n.children ? Array.prototype.slice.call(n.children) : [];
    for (const child of kids as ProximityNode[]) {
      const found = inDescendants(child, depth - 1);
      if (found) return found;
    }
    return null;
  };

  let current: ProximityNode | null | undefined = start;
  for (let level = 0; current && level <= MAX_HEIGHT; level++) {
    if (accept(current)) return current;
    const inside = inDescendants(current, MAX_DESCENDANT_DEPTH);
    if (inside) return inside;
    const parent: ProximityNode | null | undefined = current.parentElement;
    if (parent) {
      const siblings = parent.children ? Array.prototype.slice.call(parent.children) : [];
      for (const sibling of siblings as ProximityNode[]) {
        if (sibling === current) continue;
        if (accept(sibling)) return sibling;
        const found = inDescendants(sibling, MAX_DESCENDANT_DEPTH);
        if (found) return found;
      }
    }
    current = parent;
  }
  return null;
}
