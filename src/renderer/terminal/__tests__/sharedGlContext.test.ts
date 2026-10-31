import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlResources } from '../sharedWebgl/addon/GlResources';
import {
  acquireSharedGlContext,
  grownCanvasSize,
  paneCopyY,
  paneViewportY,
  SHARED_CANVAS_GROW_STEP,
  SHARED_CONTEXT_RESTORE_TIMEOUT_MS,
  type ISharedGlClient,
} from '../sharedWebgl/addon/SharedGlContext';
import { TextureAtlas } from '../sharedWebgl/addon/TextureAtlas';
import type { ITextureAtlas, IWebGL2RenderingContext } from '../sharedWebgl/addon/Types';

/**
 * The shared WebGL context draws every pane into one default framebuffer and
 * copies each frame into the pane's own 2D canvas. These tests pin the parts
 * that do not need a GPU: where a pane lands in the framebuffer (GL's origin
 * is bottom-left, a canvas's is top-left), how the canvas grows, how GL
 * objects are shared and released, and what each pane is told when the
 * context is lost. Pixels are checked against the stock addon in a real
 * Chromium, outside this suite.
 */

describe('shared framebuffer geometry', () => {
  it('puts a pane shorter than the framebuffer in its top rows', () => {
    // 1024-tall buffer, 300-tall pane: GL y 724..1023 is canvas rows 0..299,
    // which is the source rect the copy reads.
    expect(paneViewportY(1024, 300)).toBe(724);
    expect(paneViewportY(512, 512)).toBe(0);
  });

  it('copies to the bottom of a pane canvas taller than the frame, like a per-pane context', () => {
    expect(paneCopyY(361, 360)).toBe(1);
    expect(paneCopyY(360, 360)).toBe(0);
  });

  it('grows in whole steps to hold the largest pane and never shrinks', () => {
    expect(grownCanvasSize(256, 700)).toBe(768);
    expect(grownCanvasSize(768, 700)).toBe(768);
    expect(grownCanvasSize(768, 100)).toBe(768);
    expect(grownCanvasSize(768, 769)).toBe(768 + SHARED_CANVAS_GROW_STEP);
  });
});

/** A WebGL2 stand-in that records calls and hands out numbered objects. */
function fakeGl(canvas: { width: number; height: number }) {
  let next = 1;
  const calls: [string, ...unknown[]][] = [];
  const record = (name: string, ret?: () => unknown) =>
    vi.fn((...args: unknown[]) => {
      calls.push([name, ...args]);
      return ret?.();
    });
  const gl = {
    TEXTURE0: 0x84c0, TEXTURE_2D: 1, TEXTURE_WRAP_S: 2, TEXTURE_WRAP_T: 3, CLAMP_TO_EDGE: 4, RGBA: 5,
    UNSIGNED_BYTE: 6, SCISSOR_TEST: 7, COLOR_BUFFER_BIT: 8, MAX_TEXTURE_SIZE: 9,
    get drawingBufferHeight() { return canvas.height; },
    getParameter: vi.fn(() => 16384),
    createTexture: record('createTexture', () => ({ id: next++ })),
    deleteTexture: record('deleteTexture'),
    activeTexture: record('activeTexture'),
    bindTexture: record('bindTexture'),
    texParameteri: record('texParameteri'),
    texImage2D: record('texImage2D'),
    viewport: record('viewport'),
    enable: record('enable'),
    disable: record('disable'),
    scissor: record('scissor'),
    clearColor: record('clearColor'),
    clear: record('clear'),
  };
  return { gl: gl as unknown as IWebGL2RenderingContext, calls };
}

describe('GlResources', () => {
  beforeEach(() => {
    TextureAtlas.maxAtlasPages = 4;
  });

  it('gives every renderer of one atlas the same texture set, deleted with its last user', () => {
    const { gl, calls } = fakeGl({ width: 1, height: 1 });
    const res = new GlResources(gl);
    const atlas = {} as ITextureAtlas;
    const a = res.acquireAtlasTextures(atlas);
    const b = res.acquireAtlasTextures(atlas);
    expect(b).toBe(a);
    expect(calls.filter((c) => c[0] === 'createTexture')).toHaveLength(4);

    res.releaseAtlasTextures(a);
    expect(calls.filter((c) => c[0] === 'deleteTexture')).toHaveLength(0);
    res.releaseAtlasTextures(b);
    expect(calls.filter((c) => c[0] === 'deleteTexture')).toHaveLength(4);
    expect(res.atlasTextureCount).toBe(0);
  });

  it('keeps separate sets per atlas, and invalidation is per set', () => {
    const { gl } = fakeGl({ width: 1, height: 1 });
    const res = new GlResources(gl);
    const a = res.acquireAtlasTextures({} as ITextureAtlas);
    const b = res.acquireAtlasTextures({} as ITextureAtlas);
    expect(b).not.toBe(a);
    for (const t of [...a.textures, ...b.textures]) t.version = 7;
    a.invalidate();
    expect(a.textures.every((t) => t.version === -1)).toBe(true);
    expect(b.textures.every((t) => t.version === 7)).toBe(true);
  });

  it('creates each program once per context and deletes nothing once lost', () => {
    const { gl, calls } = fakeGl({ width: 1, height: 1 });
    const res = new GlResources(gl);
    const dispose = vi.fn();
    const create = vi.fn(() => ({ dispose }));
    expect(res.program('glyph', create)).toBe(res.program('glyph', create));
    expect(create).toHaveBeenCalledTimes(1);

    const set = res.acquireAtlasTextures({} as ITextureAtlas);
    res.markLost();
    res.releaseAtlasTextures(set);
    res.dispose();
    expect(dispose).not.toHaveBeenCalled();
    expect(calls.filter((c) => c[0] === 'deleteTexture')).toHaveLength(0);
  });
});

/** A canvas whose fake WebGL2 context exists while `state.available`. */
class FakeCanvas {
  width = 0;
  height = 0;
  readonly gl = fakeGl(this);
  readonly listeners = new Map<string, ((e: Event) => void)[]>();

  constructor(private readonly _state: { available: boolean }) {}

  addEventListener(type: string, fn: (e: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }

  getContext(): unknown {
    return this._state.available ? this.gl.gl : null;
  }
}

/** A document that makes FakeCanvases, with their loss listeners exposed. */
function fakeDocument() {
  const state = { available: true };
  const canvases: FakeCanvas[] = [];
  const doc = {
    createElement: () => {
      const canvas = new FakeCanvas(state);
      canvases.push(canvas);
      return canvas;
    },
  };
  const fire = (i: number, type: string) => {
    const e = { preventDefault: vi.fn() } as unknown as Event;
    for (const fn of canvases[i].listeners.get(type) ?? []) fn(e);
    return e;
  };
  return { doc: doc as unknown as Document, canvases, state, fire };
}

function client(): ISharedGlClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    handleSharedContextLost: vi.fn(),
    handleSharedContextRestored: vi.fn(),
    handleSharedContextFailed: vi.fn(),
  };
}

describe('SharedGlContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is created once per document, on first use', () => {
    const { doc, canvases } = fakeDocument();
    expect(canvases).toHaveLength(0);
    const a = acquireSharedGlContext(doc);
    expect(acquireSharedGlContext(doc)).toBe(a);
    expect(canvases).toHaveLength(1);
  });

  it('aims each pane at the top-left of the framebuffer and clears only that region', () => {
    const { doc, canvases } = fakeDocument();
    const ctx = acquireSharedGlContext(doc);
    ctx.beginPane(700, 450);
    expect([canvases[0].width, canvases[0].height]).toEqual([768, 512]);
    ctx.beginPane(140, 75);
    // Did not shrink for the small pane.
    expect([canvases[0].width, canvases[0].height]).toEqual([768, 512]);
    const calls = canvases[0].gl.calls;
    const last = (name: string) => calls.filter((c) => c[0] === name).at(-1)!.slice(1);
    expect(last('viewport')).toEqual([0, 512 - 75, 140, 75]);
    expect(last('scissor')).toEqual([0, 512 - 75, 140, 75]);
  });

  it('copies the pane region from the top of the shared canvas', () => {
    const { doc, canvases } = fakeDocument();
    const ctx = acquireSharedGlContext(doc);
    ctx.beginPane(140, 75);
    const target = { canvas: { width: 140, height: 76 }, clearRect: vi.fn(), drawImage: vi.fn() };
    ctx.present(target as unknown as CanvasRenderingContext2D, 140, 75);
    expect(target.clearRect).toHaveBeenCalledWith(0, 0, 140, 76);
    expect(target.drawImage).toHaveBeenCalledWith(canvases[0], 0, 0, 140, 75, 0, 1, 140, 75);
  });

  it('tells every pane once on loss and again when the browser restores it', () => {
    const { doc, fire } = fakeDocument();
    const ctx = acquireSharedGlContext(doc);
    const a = client(), b = client();
    ctx.register(a);
    ctx.register(b);
    const oldResources = ctx.resources;
    const e = fire(0, 'webglcontextlost');
    fire(0, 'webglcontextlost');
    expect(e.preventDefault).toHaveBeenCalled();
    expect(ctx.isLost).toBe(true);
    expect(oldResources.isLost).toBe(true);
    expect(a.handleSharedContextLost).toHaveBeenCalledTimes(1);
    expect(b.handleSharedContextLost).toHaveBeenCalledTimes(1);

    fire(0, 'webglcontextrestored');
    expect(ctx.isLost).toBe(false);
    expect(ctx.resources).not.toBe(oldResources);
    expect(a.handleSharedContextRestored).toHaveBeenCalledTimes(1);
    expect(b.handleSharedContextRestored).toHaveBeenCalledTimes(1);
    // The restore timer was cancelled: no second canvas later.
    vi.advanceTimersByTime(SHARED_CONTEXT_RESTORE_TIMEOUT_MS * 2);
    expect(a.handleSharedContextRestored).toHaveBeenCalledTimes(1);
  });

  it('recreates the context on a new canvas when the browser does not restore it', () => {
    const { doc, canvases, fire } = fakeDocument();
    const ctx = acquireSharedGlContext(doc);
    const a = client();
    ctx.register(a);
    const firstGl = ctx.gl;
    fire(0, 'webglcontextlost');
    vi.advanceTimersByTime(SHARED_CONTEXT_RESTORE_TIMEOUT_MS - 1);
    expect(a.handleSharedContextRestored).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(canvases).toHaveLength(2);
    expect(ctx.gl).not.toBe(firstGl);
    expect(ctx.isLost).toBe(false);
    expect(a.handleSharedContextRestored).toHaveBeenCalledTimes(1);
    // The old canvas no longer drives this context.
    expect(canvases[0].listeners.get('webglcontextrestored')).toHaveLength(0);
  });

  it('reports failure when no new context can be made, and the next pane starts a fresh one', () => {
    const { doc, canvases, state, fire } = fakeDocument();
    const ctx = acquireSharedGlContext(doc);
    const a = client();
    ctx.register(a);
    fire(0, 'webglcontextlost');
    state.available = false;
    vi.advanceTimersByTime(SHARED_CONTEXT_RESTORE_TIMEOUT_MS);
    expect(a.handleSharedContextFailed).toHaveBeenCalledTimes(1);
    expect(ctx.isFailed).toBe(true);

    state.available = true;
    const fresh = acquireSharedGlContext(doc);
    expect(fresh).not.toBe(ctx);
    expect(canvases).toHaveLength(3);
  });

  it('a pane that unregisters is not told about later losses', () => {
    const { doc, fire } = fakeDocument();
    const ctx = acquireSharedGlContext(doc);
    const a = client(), b = client();
    const reg = ctx.register(a);
    ctx.register(b);
    reg.dispose();
    expect(ctx.clientCount).toBe(1);
    fire(0, 'webglcontextlost');
    expect(a.handleSharedContextLost).not.toHaveBeenCalled();
    expect(b.handleSharedContextLost).toHaveBeenCalledTimes(1);
  });
});
