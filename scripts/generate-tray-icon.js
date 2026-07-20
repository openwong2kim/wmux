#!/usr/bin/env node
/**
 * macOS menu bar tray icon pipeline.
 *
 * Generates assets/trayTemplate.png (22x22) and assets/trayTemplate@2x.png
 * (44x44) — the monochrome "template image" macOS expects in the menu bar.
 *
 * WHY A SEPARATE ASSET:
 *   icon.icns is a full-color 1024px app icon on an opaque black plate.
 *   Downscaling it to 22px (the previous tray path) collapses it into a black
 *   blob in the menu bar (owner-reported 2026-07-20). macOS template images
 *   are alpha-only: the OS paints them black on a light menu bar and white on
 *   a dark one, and highlights them when the menu is open.
 *
 * SOURCE — the app icon itself, not a re-drawn glyph:
 *   Earlier revisions re-drew the ">w" mark from hand-tuned stroke geometry,
 *   which drifted from the app icon's actual proportions (owner rejected it,
 *   2026-07-20: "make it completely identical"). We now derive the template
 *   straight from assets/icon.png — the same 1024px raster the app icon (.icns)
 *   is built from — so the menu bar mark is pixel-faithful to the Dock icon.
 *   icon.png is a transparent-background white ">w"; we take each pixel's
 *   coverage as luminance x alpha, crop to the mark's bounding box (trimming
 *   only empty margin, which preserves the eye/mouth proportions and spacing),
 *   pad slightly, and area-average down to the target size. Black pixels carry
 *   that coverage as alpha, which is exactly what setTemplateImage() wants.
 *
 * Only dependency: png2icons' bundled UPNG encoder (already a devDependency).
 */

const fs = require('fs');
const path = require('path');
const UPNG = require('png2icons/lib/UPNG');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const SRC_PATH = path.join(ASSETS_DIR, 'icon.png');

// Uniform breathing room added around the mark's bounding box, as a fraction of
// the target box. Small so the glyph fills the menu bar like neighbouring icons
// while keeping the app icon's own generous internal spacing intact.
const PAD_FRAC = 0.06;
// Coverage below this (0..1) is treated as empty when finding the bounding box,
// so faint anti-aliased fringe pixels don't inflate it.
const BBOX_THRESHOLD = 0.15;

/** Decode icon.png into a Float32 coverage map (0..1): luminance x alpha. */
function loadCoverage() {
  const img = UPNG.decode(fs.readFileSync(SRC_PATH));
  const rgba = new Uint8Array(UPNG.toRGBA8(img)[0]);
  const { width, height } = img;
  const cov = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const lum = Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) / 255;
    const alpha = rgba[i * 4 + 3] / 255;
    cov[i] = lum * alpha;
  }
  return { cov, width, height };
}

/** Tight bounding box of the inked mark within the coverage map. */
function markBounds(cov, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cov[y * width + x] >= BBOX_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX: maxX + 1, maxY: maxY + 1 };
}

/**
 * Render the mark into a `dim`x`dim` black RGBA buffer whose alpha is the
 * area-averaged source coverage. The mark's bounding box (plus PAD_FRAC padding)
 * is centered on its longer axis so the aspect ratio is preserved.
 */
function render(cov, width, height, bounds, dim) {
  const markW = bounds.maxX - bounds.minX;
  const markH = bounds.maxY - bounds.minY;
  const pad = dim * PAD_FRAC;
  const box = dim - pad * 2;
  const scale = box / Math.max(markW, markH); // dest px per source px
  const offX = pad + (box - markW * scale) / 2;
  const offY = pad + (box - markH * scale) / 2;
  const inv = 1 / scale; // source px per dest px

  const rgba = new Uint8Array(dim * dim * 4);
  for (let py = 0; py < dim; py++) {
    // Source rows covered by this dest row (box filter).
    const sy0 = bounds.minY + (py - offY) * inv;
    const sy1 = sy0 + inv;
    for (let px = 0; px < dim; px++) {
      const sx0 = bounds.minX + (px - offX) * inv;
      const sx1 = sx0 + inv;
      let sum = 0;
      let area = 0;
      const yA = Math.max(bounds.minY, Math.floor(sy0));
      const yB = Math.min(bounds.maxY, Math.ceil(sy1));
      const xA = Math.max(bounds.minX, Math.floor(sx0));
      const xB = Math.min(bounds.maxX, Math.ceil(sx1));
      for (let sy = yA; sy < yB; sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        for (let sx = xA; sx < xB; sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          sum += cov[sy * width + sx] * w;
          area += w;
        }
      }
      const a = area > 0 ? sum / area : 0;
      if (a <= 0) continue;
      const i = (py * dim + px) * 4;
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  return rgba;
}

function write(name, dim, ctx) {
  const rgba = render(ctx.cov, ctx.width, ctx.height, ctx.bounds, dim);
  const png = Buffer.from(UPNG.encode([rgba.buffer], dim, dim, 0));
  const out = path.join(ASSETS_DIR, name);
  fs.writeFileSync(out, png);
  console.log(`[generate-tray-icon] Wrote ${path.relative(process.cwd(), out)} (${png.length} bytes, ${dim}x${dim})`);
}

const { cov, width, height } = loadCoverage();
const bounds = markBounds(cov, width, height);
const ctx = { cov, width, height, bounds };
write('trayTemplate.png', 22, ctx);
write('trayTemplate@2x.png', 44, ctx);
console.log('[generate-tray-icon] Done.');
