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

/**
 * The longest main waits for a page to take an upload's files. The MCP tool
 * clamps its own timeout to it too, so both sides wait for the same bound.
 */
export const UPLOAD_MAX_TIMEOUT_MS = 120_000;

/**
 * The uploads root, two ways: as spelled (`<wmuxDir>/uploads`) and with its
 * links resolved. A path is first compared with both, without touching the
 * filesystem, and only one that names somewhere under the root is resolved.
 */
export interface UploadRoot {
  spelled: string;
  real: string;
}

/** `<wmuxDir>/uploads`, created when missing. */
export function uploadRootIn(wmuxDir: string): UploadRoot {
  const spelled = path.join(wmuxDir, 'uploads');
  if (!fs.existsSync(spelled)) {
    fs.mkdirSync(spelled, { recursive: true });
  }
  try {
    return { spelled, real: fs.realpathSync(spelled) };
  } catch {
    return { spelled, real: spelled };
  }
}

/** Why a host path may not be handed to a page. */
export type UploadPathRefusal =
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'aliased'; name: string }
  | { ok: false; reason: 'outside' }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'not-a-file' }
  | { ok: false; reason: 'unresolvable' };

/**
 * The first name in a Windows path that holds a colon past the drive
 * designator, or undefined. NTFS reads such a name as a stream or attribute of
 * the file or directory before the colon (`f::$DATA`, `f:name`,
 * `dir::$INDEX_ALLOCATION`), so Node and the browser can resolve the spelling
 * to different things; it is refused like the other aliased names. The drive
 * of a `\\?\` or `\\.\` path is a designator too, not a name.
 */
function win32StreamName(p: string): string | undefined {
  return p
    .replace(/^(?:[\\/]{2}[?.][\\/])?[A-Za-z]:/, '')
    .split(/[\\/]/)
    .find((s) => s.includes(':'));
}

/** Is `p` strictly inside `root`? Lexical: no filesystem access. */
function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  // `rel === '..'` and `'..' + sep` are the escapes; a bare startsWith('..')
  // also swallows legitimate names — `..dots` in the root relativises to
  // `..dots` and was refused forever.
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The one gate on what a page may be handed. What reaches the browser is the
 * path this RETURNS — the realpath'd, root-checked value — never the input.
 *
 * Takes a HOST path: a WSL caller's `/mnt/<drive>/` spelling is converted by
 * the caller, which is the side that knows its mount. An unconverted one is
 * just a path outside the root here.
 *
 * In order, and why:
 *  - Lexical first, with no filesystem call: `..` segments are normalised by
 *    path.resolve(), and another drive or a UNC share (`E:\x`,
 *    `\\host\share\x`) relativises to an absolute path. Such a path is refused
 *    before anything could open a network share from the main process.
 *  - On Windows, a name ending in a dot or space, or a device name, is refused
 *    too: Node resolves it through the `\\?\` namespace, where
 *    `uploads\link.\f` does not exist, while Chrome opens it as
 *    `uploads\link\f` and follows the junction out of the root (measured on
 *    NTFS with Electron 41). So is a name holding a colon past the drive,
 *    which NTFS reads as a stream or attribute name (win32StreamName).
 *  - Then the real path: a symlink or junction inside the root pointing out of
 *    it resolves to its target, which must be under the real root. A path that
 *    does not exist is refused — the browser opens a path only when the page
 *    reads it, so a lexical pass would let a file appear there later — and so
 *    is one whose real path cannot be computed.
 *  - Last, a regular file only. A directory would be handed over whole, with
 *    every link inside it unchecked (a `webkitdirectory` input lists them).
 *
 * The residue is TOCTOU: the browser opens the file when the page reads it,
 * not when it is handed over, so swapping the file for a link in between needs
 * write access to the uploads root.
 */
export function checkUploadPath(
  hostPath: unknown,
  root: UploadRoot,
): { ok: true; path: string } | UploadPathRefusal {
  if (typeof hostPath !== 'string' || hostPath.length === 0) return { ok: false, reason: 'empty' };
  const abs = path.resolve(hostPath);
  if (process.platform === 'win32') {
    const aliased = win32AliasedName(abs) ?? win32StreamName(abs);
    if (aliased !== undefined) return { ok: false, reason: 'aliased', name: aliased };
  }
  if (!isInside(root.spelled, abs) && !isInside(root.real, abs)) return { ok: false, reason: 'outside' };
  let resolved: string;
  try {
    resolved = fs.realpathSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unresolvable' };
  }
  if (!isInside(root.real, resolved)) return { ok: false, reason: 'outside' };
  try {
    if (!fs.statSync(resolved).isFile()) return { ok: false, reason: 'not-a-file' };
  } catch {
    return { ok: false, reason: 'unresolvable' };
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

/**
 * Every element matching `selector` in `root` and in the open shadow roots
 * under it: the root's own matches first, then each shadow root's, depth-first
 * in document order. One document only; frames are not entered. A styled
 * uploader is often a web component, and Playwright's own selectors pierced
 * open shadow roots, so a plain querySelectorAll would miss what used to work.
 *
 * Self-contained (no imports, no closure): main injects its source.
 */
export function queryOpenShadowRoots(root: unknown, selector: string): unknown[] {
  interface QueryRoot {
    querySelectorAll: (s: string) => ArrayLike<{ shadowRoot?: QueryRoot | null }>;
  }
  const found: unknown[] = [];
  const visit = (r: QueryRoot): void => {
    const matches = r.querySelectorAll(selector);
    for (let i = 0; i < matches.length; i++) found.push(matches[i]);
    const all = r.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const inner = all[i].shadowRoot;
      if (inner) visit(inner);
    }
  };
  visit(root as QueryRoot);
  return found;
}

/**
 * The expression main evaluates in the page's isolated world to find what an
 * upload sets: the element itself (a node), or why not — `'none'` (nothing
 * matched), `'many'` (a ref's anchor matched more than once, counted across
 * every open shadow root), `'anchor'` (no file input near the anchor).
 * Without `near` the first match is the input.
 */
export function uploadLookupExpression(selector: string, near: boolean): string {
  return (
    `(() => { const all = (${String(queryOpenShadowRoots)})(document, ${JSON.stringify(selector)}); ` +
    `if (all.length === 0) return 'none'; ` +
    `if (!${near}) return all[0]; ` +
    `if (all.length > 1) return 'many'; ` +
    `return (${String(findFileInputNearElement)})(all[0]) || 'anchor'; })()`
  );
}
