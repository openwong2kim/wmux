/**
 * wmux: not part of xterm.js.
 *
 * GL objects that do not belong to one terminal: shader programs, and the GPU
 * copies of each texture atlas. Upstream creates both per renderer, which is
 * per context there. One instance lives per WebGL context incarnation, so a
 * renderer with its own context gets exactly upstream's objects, while every
 * pane drawing through the shared context uses one program per shader and one
 * texture set per atlas.
 *
 * A lost context invalidates every object at once. `markLost` makes the
 * instance stop issuing deletes (they would target a dead or replaced
 * context); the owner then builds a new instance for the next incarnation.
 */

import { IDisposable } from '../xterm/common/Types';
import { throwIfFalsy } from '../xterm/browser/renderer/shared/RendererUtils';
import { TextureAtlas } from './TextureAtlas';
import { ITextureAtlas, IWebGL2RenderingContext } from './Types';
import { GLTexture } from './WebglUtils';

/** The GPU copy of one atlas: one texture per sampler unit, each tagged with the
 *  page version it holds. */
export class AtlasTextures {
  public refs = 0;

  constructor(public readonly atlas: ITextureAtlas, public readonly textures: GLTexture[]) {}

  /** Force every page to upload again on its next render. */
  public invalidate(): void {
    for (const t of this.textures) {
      t.version = -1;
    }
  }
}

export class GlResources {
  private readonly _programs = new Map<string, { value: unknown, dispose(): void }>();
  private readonly _atlasTextures = new Map<ITextureAtlas, AtlasTextures>();
  private _isLost = false;

  constructor(public readonly gl: IWebGL2RenderingContext) {}

  public get isLost(): boolean { return this._isLost; }

  /** The context is gone: its objects need no deletes, and must get none. */
  public markLost(): void {
    this._isLost = true;
  }

  /** One program per key for this context, created on first use. */
  public program<T extends IDisposable>(key: string, create: () => T): T {
    let entry = this._programs.get(key);
    if (!entry) {
      const value = create();
      entry = { value, dispose: () => value.dispose() };
      this._programs.set(key, entry);
    }
    return entry.value as T;
  }

  /**
   * The texture set for `atlas` in this context, shared by every renderer
   * that draws with that atlas. Each acquire must be paired with a release.
   * New textures start as 1x1 red, as upstream's per-renderer ones do, so an
   * unbound page is visible rather than silent.
   */
  public acquireAtlasTextures(atlas: ITextureAtlas): AtlasTextures {
    let set = this._atlasTextures.get(atlas);
    if (!set) {
      const gl = this.gl;
      const textures: GLTexture[] = [];
      for (let i = 0; i < TextureAtlas.maxAtlasPages!; i++) {
        const glTexture = new GLTexture(throwIfFalsy(gl.createTexture()));
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, glTexture.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 0, 0, 255]));
        textures.push(glTexture);
      }
      set = new AtlasTextures(atlas, textures);
      this._atlasTextures.set(atlas, set);
    }
    set.refs++;
    return set;
  }

  public releaseAtlasTextures(set: AtlasTextures): void {
    if (--set.refs > 0 || this._atlasTextures.get(set.atlas) !== set) {
      return;
    }
    this._atlasTextures.delete(set.atlas);
    if (!this._isLost) {
      for (const t of set.textures) {
        this.gl.deleteTexture(t.texture);
      }
    }
  }

  /** Number of atlases with a live texture set (diagnostics and tests). */
  public get atlasTextureCount(): number { return this._atlasTextures.size; }

  public dispose(): void {
    if (!this._isLost) {
      for (const entry of this._programs.values()) {
        entry.dispose();
      }
      for (const set of this._atlasTextures.values()) {
        for (const t of set.textures) {
          this.gl.deleteTexture(t.texture);
        }
      }
    }
    this._programs.clear();
    this._atlasTextures.clear();
  }
}
