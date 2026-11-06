// In-process frames of a guest page, over its own CDP session (the RPC lane).
//
// A frame is read and acted on in an isolated world of its own: the page's
// scripts cannot see or patch what runs there, and the DOM it reads is the
// frame's document only, so a `data-wmux-ref` tag in another document can
// never match. A frame in another process (site isolation) has no world here
// and is reported unreachable, never as an error.
//
// Every call names the frame by id and the document it expects by loaderId;
// a frame that is gone or has navigated since the snapshot is refused with a
// stable prefix (FRAME_GONE / FRAME_NAVIGATED), so a ref from an old document
// cannot act on the new one.

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** Deepest frame level read below the top document. */
export const MAX_FRAME_DEPTH = 5;

/** The isolated world wmux reads frames in; Chrome reuses it per document. */
const FRAME_WORLD_NAME = 'wmux-rpc-frames';

/** Worlds kept per page before the least recently used is dropped. */
const MAX_CACHED_WORLDS = 64;

/**
 * Prefix of the object group each frame target's remote objects belong to.
 * Every target has its own group: clicks on one guest are not serialized, so
 * a shared group released by one would invalidate another's handles.
 */
const OBJECT_GROUP_PREFIX = 'wmux-rpc-frames';
let objectGroupSeq = 0;

export interface FrameEntry {
  frameId: string;
  loaderId: string;
  parentId: string;
  /** 1 for a frame of the top document. */
  depth: number;
  /** Where the frame is, as an origin: no path, query or credentials. */
  origin: string;
  /** The frame's name attribute, as the page set it (page-controlled). */
  name: string;
}

interface TreeFrame {
  id: string;
  loaderId: string;
  parentId?: string;
  url: string;
  name?: string;
}

interface FrameTree {
  frame: TreeFrame;
  childFrames?: FrameTree[];
}

/** A URL as the origin the snapshot shows (the same rule as the DOM listing). */
export function frameOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return '(invalid location)';
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin + (u.pathname && u.pathname !== '/' ? '/…' : '');
  if (u.protocol === 'about:') return `about:${u.pathname.slice(0, 20)}`;
  if (u.protocol === 'file:') return 'file:///…';
  return u.protocol;
}

async function frameTree(send: CdpSend): Promise<FrameTree | null> {
  const reply = (await send('Page.getFrameTree')) as { frameTree?: FrameTree } | null;
  return reply?.frameTree ?? null;
}

/** Child frames in tree order, to MAX_FRAME_DEPTH; the top document is not one. */
export async function listChildFrames(send: CdpSend): Promise<FrameEntry[]> {
  const root = await frameTree(send);
  const out: FrameEntry[] = [];
  const walk = (node: FrameTree, depth: number) => {
    if (depth > MAX_FRAME_DEPTH) return;
    for (const child of node.childFrames ?? []) {
      const f = child.frame;
      out.push({
        frameId: f.id,
        loaderId: f.loaderId,
        parentId: f.parentId ?? node.frame.id,
        depth,
        origin: frameOrigin(f.url),
        name: typeof f.name === 'string' ? f.name : '',
      });
      walk(child, depth + 1);
    }
  };
  if (root) walk(root, 1);
  return out;
}

/** The frame's current document, or a refusal naming why it is not the expected one. */
async function currentLoader(send: CdpSend, frameId: string, expectLoaderId?: string): Promise<string> {
  const root = await frameTree(send);
  const stack = root ? [root] : [];
  while (stack.length > 0) {
    const node = stack.pop() as FrameTree;
    if (node.frame.id === frameId) {
      if (expectLoaderId !== undefined && node.frame.loaderId !== expectLoaderId) {
        throw new Error('FRAME_NAVIGATED: the frame has loaded another document since the snapshot');
      }
      return node.frame.loaderId;
    }
    stack.push(...(node.childFrames ?? []));
  }
  throw new Error('FRAME_GONE: the frame is no longer in the page');
}

export type FrameContext = { contextId: number } | { unreachable: string };

/**
 * One isolated world per frame document, created on first use and reused:
 * Chrome answers a repeat createIsolatedWorld for the same name with the same
 * world, and the cache spares the call.
 */
export class FrameWorlds {
  private readonly cache = new Map<string, number>();

  constructor(private readonly send: CdpSend) {}

  async contextFor(frameId: string, expectLoaderId?: string): Promise<FrameContext> {
    // A world cached for the very document the caller names is used without
    // re-reading the tree: Chrome destroys a document's worlds when it goes,
    // so a stale one fails its next call, and inWorld then re-checks here.
    const known = expectLoaderId !== undefined ? this.cache.get(`${frameId}\u0000${expectLoaderId}`) : undefined;
    if (known !== undefined) return { contextId: known };
    const loaderId = await currentLoader(this.send, frameId, expectLoaderId);
    const key = `${frameId}\u0000${loaderId}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { contextId: cached };
    }
    let world: { executionContextId?: unknown } | null;
    try {
      world = (await this.send('Page.createIsolatedWorld', { frameId, worldName: FRAME_WORLD_NAME })) as typeof world;
    } catch (err) {
      return { unreachable: `separate process or not attached (${err instanceof Error ? err.message : String(err)})` };
    }
    if (typeof world?.executionContextId !== 'number') return { unreachable: 'no world for this frame' };
    this.cache.set(key, world.executionContextId);
    while (this.cache.size > MAX_CACHED_WORLDS) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return { contextId: world.executionContextId };
  }

  /** Drop a world whose context Chrome no longer knows (a detach, a reattach). */
  forget(contextId: number): void {
    for (const [key, id] of this.cache) if (id === contextId) this.cache.delete(key);
  }
}

type EvalReply = {
  result?: { value?: unknown; objectId?: string; subtype?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

function evalError(reply: EvalReply): Error {
  return new Error(reply.exceptionDetails?.exception?.description || reply.exceptionDetails?.text || 'Unknown script error');
}

/** Run `fn` in the frame's world, once more on a fresh world if the cached one has gone. */
async function inWorld<T>(
  worlds: FrameWorlds,
  frameId: string,
  expectLoaderId: string | undefined,
  fn: (contextId: number) => Promise<T>,
): Promise<T | { unreachable: string }> {
  for (let attempt = 0; ; attempt++) {
    const ctx = await worlds.contextFor(frameId, expectLoaderId);
    if ('unreachable' in ctx) return ctx;
    try {
      return await fn(ctx.contextId);
    } catch (err) {
      const stale = /Cannot find context|context with specified id|Execution context was destroyed|Cannot find object/i
        .test(err instanceof Error ? err.message : String(err));
      if (!stale || attempt > 0) throw err;
      worlds.forget(ctx.contextId);
    }
  }
}

/** The error a frame read that ran past its `timeoutMs` rejects with. */
export const FRAME_READ_TIMEOUT = 'FRAME_READ_TIMEOUT';

/**
 * An expression's value in the frame's world, or why the frame cannot be read.
 * With `timeoutMs`, Chrome is asked to stop the script then, and the call
 * rejects with FRAME_READ_TIMEOUT when no answer has come by then either (a
 * renderer that does not answer at all).
 */
export async function evaluateInFrame(
  send: CdpSend,
  worlds: FrameWorlds,
  frameId: string,
  expression: string,
  expectLoaderId?: string,
  timeoutMs?: number,
): Promise<{ value: unknown } | { unreachable: string }> {
  const read = inWorld(worlds, frameId, expectLoaderId, async (contextId) => {
    const reply = (await send('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
      ...(timeoutMs !== undefined ? { timeout: Math.max(1, Math.floor(timeoutMs)) } : {}),
    })) as EvalReply;
    if (reply.exceptionDetails) throw evalError(reply);
    return { value: reply.result?.value ?? null };
  });
  if (timeoutMs === undefined) return read;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${FRAME_READ_TIMEOUT}: no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Where to press on `selector` inside a frame, in top-level viewport pixels,
 * and a check that the point still lands on it.
 *
 * The point comes from DOM.getContentQuads, which for an in-process frame is
 * already in the root viewport: Chrome applies the owner iframes' offsets,
 * borders, padding, scroll and transforms. The check asks Chrome what is at
 * the point (DOM.getNodeForLocation) and accepts only the target, or a node
 * inside it, in the same frame. A wrong offset is refused, never pressed.
 */
export class FrameTarget {
  private constructor(
    private readonly send: CdpSend,
    readonly frameId: string,
    private readonly contextId: number,
    private readonly objectId: string,
    private readonly objectGroup: string,
  ) {}

  static async resolve(
    send: CdpSend,
    worlds: FrameWorlds,
    frameId: string,
    expectLoaderId: string | undefined,
    selector: string,
  ): Promise<FrameTarget | { unreachable: string } | null> {
    const objectGroup = `${OBJECT_GROUP_PREFIX}-${++objectGroupSeq}`;
    const found = await inWorld(worlds, frameId, expectLoaderId, async (contextId) => {
      const reply = (await send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          return el;
        })()`,
        contextId,
        objectGroup,
      })) as EvalReply;
      if (reply.exceptionDetails) throw evalError(reply);
      const objectId = reply.result?.subtype === 'null' ? undefined : reply.result?.objectId;
      return objectId ? { contextId, objectId } : null;
    });
    if (found === null || 'unreachable' in found) return found;
    return new FrameTarget(send, frameId, found.contextId, found.objectId, objectGroup);
  }

  /** The middle of the element's first visible quad, or null when it has no area. */
  async point(): Promise<Point | null> {
    const reply = (await this.send('DOM.getContentQuads', { objectId: this.objectId }).catch(() => null)) as
      | { quads?: number[][] }
      | null;
    for (const quad of reply?.quads ?? []) {
      if (quad.length !== 8) continue;
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
      if (area <= 0) continue;
      return { x: xs.reduce((a, b) => a + b) / 4, y: ys.reduce((a, b) => a + b) / 4 };
    }
    return null;
  }

  /** Is the topmost node at `point` this element, or inside it, in this frame? */
  async hits(point: Point): Promise<boolean> {
    // getNodeForLocation takes top-document coordinates: add the top scroll.
    const metrics = (await this.send('Page.getLayoutMetrics').catch(() => null)) as
      | { cssVisualViewport?: { pageX?: number; pageY?: number } }
      | null;
    const scrollX = metrics?.cssVisualViewport?.pageX;
    const scrollY = metrics?.cssVisualViewport?.pageY;
    if (typeof scrollX !== 'number' || typeof scrollY !== 'number') return false;
    const hit = (await this.send('DOM.getNodeForLocation', {
      x: Math.round(point.x + scrollX),
      y: Math.round(point.y + scrollY),
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: true,
    }).catch(() => null)) as { backendNodeId?: number; frameId?: string } | null;
    if (!hit || typeof hit.backendNodeId !== 'number' || hit.frameId !== this.frameId) return false;
    const resolved = (await this.send('DOM.resolveNode', {
      backendNodeId: hit.backendNodeId,
      executionContextId: this.contextId,
      objectGroup: this.objectGroup,
    }).catch(() => null)) as { object?: { objectId?: string } } | null;
    const hitObject = resolved?.object?.objectId;
    if (!hitObject) return false;
    const reply = (await this.send('Runtime.callFunctionOn', {
      objectId: this.objectId,
      functionDeclaration: 'function (h) { for (let n = h; n; n = n.parentNode || n.host) if (n === this) return true; return false; }',
      arguments: [{ objectId: hitObject }],
      returnByValue: true,
    }).catch(() => null)) as EvalReply | null;
    return reply?.result?.value === true;
  }

  /** Release the remote objects this target made. */
  async release(): Promise<void> {
    await this.send('Runtime.releaseObjectGroup', { objectGroup: this.objectGroup }).catch(() => undefined);
  }
}
