/**
 * wmux: not part of xterm.js.
 *
 * One WebGL2 context, on a canvas that is never attached, that every
 * shared-mode renderer of a document draws through. Each WebGL context costs
 * the GPU process a fixed few MB plus its own upload of every atlas page it
 * samples; with one context, that cost is paid once however many panes there
 * are (GlResources keeps one program per shader and one texture set per atlas).
 *
 * A pane frame is drawn into the top-left w x h of the default framebuffer and
 * copied, in the same task, into the pane's own visible 2D canvas
 * (beginPane / present). The 2D canvas keeps the last frame, which is what a
 * pane shows while the context is lost.
 *
 * Only this module owns the context: renderers never lose it. When it is lost,
 * every registered renderer stops drawing and keeps its last frame; on
 * `webglcontextrestored`, or after SHARED_CONTEXT_RESTORE_TIMEOUT_MS on a new
 * canvas, they rebuild their GL state and redraw. If no new context can be
 * created, they are told the context failed, which the addon reports through
 * onContextLoss as upstream does.
 */

import { IDisposable } from '../xterm/common/Types';
import { GlResources } from './GlResources';
import { IWebGL2RenderingContext } from './Types';

export interface ISharedGlClient {
  /** The context was lost. Draw nothing until restored; keep the last frame. */
  handleSharedContextLost(): void;
  /** A context is usable again: rebuild GL state from `gl`/`resources` and redraw. */
  handleSharedContextRestored(): void;
  /** No context could be created. The renderer cannot draw any more. */
  handleSharedContextFailed(): void;
}

/** Same wait as upstream's per-renderer restore window. */
export const SHARED_CONTEXT_RESTORE_TIMEOUT_MS = 3000;
/** The shared canvas grows in steps of this many pixels, so a window drag that
 *  enlarges the largest pane does not reallocate the framebuffer every frame. */
export const SHARED_CANVAS_GROW_STEP = 256;

/**
 * The size the shared canvas must have to hold a `needed` pane: never smaller
 * than it is (it does not shrink), and grown in whole steps when it must grow.
 */
export function grownCanvasSize(current: number, needed: number, step: number = SHARED_CANVAS_GROW_STEP): number {
  if (needed <= current) {
    return current;
  }
  return Math.ceil(needed / step) * step;
}

/**
 * The GL viewport y that puts a pane of height `paneHeight` in the TOP rows of
 * a default framebuffer `bufferHeight` tall. GL window coordinates start at the
 * bottom-left, while drawImage reads canvas rows from the top, so the pane's
 * frame is read back from source y 0 only when it is drawn at
 * `bufferHeight - paneHeight`.
 */
export function paneViewportY(bufferHeight: number, paneHeight: number): number {
  return bufferHeight - paneHeight;
}

/**
 * Destination y of the copy into a pane canvas `targetHeight` tall. Upstream's
 * per-pane context draws with viewport y 0, so when its canvas is taller than
 * the frame (the device-pixel observer sized it a pixel larger) the frame sits
 * at the bottom. Copying to the same place keeps the two paths pixel-identical.
 */
export function paneCopyY(targetHeight: number, paneHeight: number): number {
  return targetHeight - paneHeight;
}

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  antialias: false,
  depth: false,
  preserveDrawingBuffer: false
};

export class SharedGlContext {
  private _canvas: HTMLCanvasElement;
  private _gl: IWebGL2RenderingContext;
  private _resources: GlResources;
  private _isLost = false;
  private _isFailed = false;
  private _restoreTimeout: number | undefined;
  private _detachCanvas: () => void;
  private readonly _clients = new Set<ISharedGlClient>();
  public readonly maxTextureSize: number;

  constructor(private readonly _document: Document) {
    const created = this._createContext();
    if (!created) {
      throw new Error('WebGL2 not supported');
    }
    [this._canvas, this._gl] = created;
    this._resources = new GlResources(this._gl);
    this._detachCanvas = this._attachCanvas(this._canvas);
    this.maxTextureSize = this._gl.getParameter(this._gl.MAX_TEXTURE_SIZE);
  }

  public get gl(): IWebGL2RenderingContext { return this._gl; }
  public get resources(): GlResources { return this._resources; }
  public get canvas(): HTMLCanvasElement { return this._canvas; }
  public get isLost(): boolean { return this._isLost; }
  public get isFailed(): boolean { return this._isFailed; }
  public get clientCount(): number { return this._clients.size; }

  public register(client: ISharedGlClient): IDisposable {
    this._clients.add(client);
    return { dispose: () => this._clients.delete(client) };
  }

  /**
   * Start one pane's frame: make the canvas hold `width` x `height`, aim the
   * viewport at the top-left of the framebuffer, and clear that region to
   * transparent, the state a per-pane context starts every frame in.
   */
  public beginPane(width: number, height: number): void {
    const canvas = this._canvas;
    const w = grownCanvasSize(canvas.width, width);
    const h = grownCanvasSize(canvas.height, height);
    if (w !== canvas.width || h !== canvas.height) {
      canvas.width = w;
      canvas.height = h;
    }
    const gl = this._gl;
    const y = paneViewportY(gl.drawingBufferHeight, height);
    gl.viewport(0, y, width, height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, y, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Copy the frame beginPane started into the pane's visible canvas. */
  public present(target: CanvasRenderingContext2D, width: number, height: number): void {
    const targetCanvas = target.canvas;
    target.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    target.drawImage(this._canvas, 0, 0, width, height, 0, paneCopyY(targetCanvas.height, height), width, height);
  }

  private _createContext(): [HTMLCanvasElement, IWebGL2RenderingContext] | undefined {
    const canvas = this._document.createElement('canvas');
    canvas.width = SHARED_CANVAS_GROW_STEP;
    canvas.height = SHARED_CANVAS_GROW_STEP;
    const gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES) as IWebGL2RenderingContext | null;
    return gl ? [canvas, gl] : undefined;
  }

  private _attachCanvas(canvas: HTMLCanvasElement): () => void {
    const onLost = (e: Event): void => this._handleLost(e);
    const onRestored = (): void => this._handleRestored();
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    };
  }

  private _handleLost(e: Event): void {
    // Allow the browser to restore this context.
    e.preventDefault();
    if (this._isLost) {
      return;
    }
    console.warn(`[wmux:shared-webgl] context lost — ${this._clients.size} pane(s) keep their last frame`);
    this._isLost = true;
    this._resources.markLost();
    for (const client of [...this._clients]) {
      client.handleSharedContextLost();
    }
    this._restoreTimeout = window.setTimeout(() => {
      this._restoreTimeout = undefined;
      this._recreate();
    }, SHARED_CONTEXT_RESTORE_TIMEOUT_MS);
  }

  private _handleRestored(): void {
    window.clearTimeout(this._restoreTimeout);
    this._restoreTimeout = undefined;
    console.warn('[wmux:shared-webgl] context restored');
    this._resume();
  }

  /** The browser did not restore the context: replace it with a new one. */
  private _recreate(): void {
    this._detachCanvas();
    const created = this._createContext();
    if (!created) {
      console.warn('[wmux:shared-webgl] could not create a new context');
      this._isFailed = true;
      for (const client of [...this._clients]) {
        client.handleSharedContextFailed();
      }
      return;
    }
    [this._canvas, this._gl] = created;
    this._detachCanvas = this._attachCanvas(this._canvas);
    console.warn('[wmux:shared-webgl] context recreated');
    this._resume();
  }

  private _resume(): void {
    this._resources = new GlResources(this._gl);
    this._isLost = false;
    for (const client of [...this._clients]) {
      client.handleSharedContextRestored();
    }
  }
}

const sharedContexts = new WeakMap<Document, SharedGlContext>();

/** The document's shared context, created on first use (and again after one
 *  failed). Throws when WebGL2 is unavailable, like upstream's renderer. */
export function acquireSharedGlContext(document: Document): SharedGlContext {
  let context = sharedContexts.get(document);
  if (!context || context.isFailed) {
    context = new SharedGlContext(document);
    sharedContexts.set(document, context);
  }
  return context;
}
