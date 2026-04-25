#!/usr/bin/env node
/**
 * Generate macOS icons (icon.icns + iconTemplate{,@2x}.png) from SVG source.
 *
 * Cross-platform: uses png2icons + sharp (no macOS `iconutil` dependency).
 * Run on Windows / Linux / macOS — produces identical output.
 *
 * Inputs:
 *   - assets/icon.svg  (preferred)
 *   - assets/icon.ico  (fallback — sharp can extract largest PNG frame)
 *
 * Outputs:
 *   - assets/icon.icns           macOS .app bundle icon (multi-size)
 *   - assets/iconTemplate.png    16x16 black-silhouette tray icon (Apple HIG)
 *   - assets/iconTemplate@2x.png 32x32 Retina tray icon
 */
const fs = require('fs');
const path = require('path');
const png2icons = require('png2icons');
const sharp = require('sharp');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const SVG_PATH = path.join(ASSETS_DIR, 'icon.svg');
const ICO_PATH = path.join(ASSETS_DIR, 'icon.ico');

async function loadSourceBuffer() {
  if (fs.existsSync(SVG_PATH)) {
    console.log(`Source: ${SVG_PATH}`);
    return { buffer: fs.readFileSync(SVG_PATH), kind: 'svg' };
  }
  if (fs.existsSync(ICO_PATH)) {
    console.log(`Source: ${ICO_PATH} (SVG not found — falling back to ICO)`);
    return { buffer: fs.readFileSync(ICO_PATH), kind: 'ico' };
  }
  throw new Error(`No source icon found. Expected ${SVG_PATH} or ${ICO_PATH}.`);
}

/**
 * Render the source at the requested size.
 * sharp handles SVG via librsvg internally; for ICO it picks the largest frame.
 */
async function renderPngAt(sourceBuffer, size) {
  return sharp(sourceBuffer, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

/**
 * Build a monochrome silhouette suitable for a macOS template image.
 *
 * Apple's template-image convention: opaque pixels are black, transparent
 * elsewhere. macOS tints them automatically per light/dark mode and per
 * menu-bar state. Color content fights that tint, so we discard it.
 *
 * Strategy: render in colour, then map every visible (alpha > 0) pixel to
 * pure black while preserving the original alpha as the silhouette mask.
 */
async function renderTemplatePng(sourceBuffer, size) {
  // Render larger then down-sample for crisper edges at small sizes.
  const renderSize = Math.max(size * 4, 64);
  const rendered = await sharp(sourceBuffer, { density: 384 })
    .resize(renderSize, renderSize, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data, info } = rendered;
  const channels = info.channels; // expected 4
  const out = Buffer.alloc(data.length);

  // The wmux SVG is white-on-black: drawing the foreground glyph as opaque
  // and the rect background as opaque too. For a template image we want only
  // the glyph silhouette. So we treat near-black background pixels as
  // transparent and near-white foreground pixels as opaque black.
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = channels === 4 ? data[i + 3] : 255;

    // Luminance — perceptual weighting.
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    // Foreground (glyph) is light; background is dark. Use luminance as the
    // silhouette mask, scaled by source alpha so transparent pixels stay clear.
    const mask = Math.round((lum / 255) * a);

    out[i] = 0;       // R
    out[i + 1] = 0;   // G
    out[i + 2] = 0;   // B
    out[i + 3] = mask; // A
  }

  return sharp(out, { raw: { width: info.width, height: info.height, channels } })
    .resize(size, size, { fit: 'contain', kernel: 'lanczos3' })
    .png()
    .toBuffer();
}

async function main() {
  const { buffer: source } = await loadSourceBuffer();

  // 1) Base PNG for ICNS (1024 is the largest macOS expects).
  const basePng = await renderPngAt(source, 1024);

  // 2) Build ICNS (multi-size, BICUBIC resample, lossless).
  const icnsBuffer = png2icons.createICNS(basePng, png2icons.BICUBIC, 0);
  if (!icnsBuffer) throw new Error('png2icons.createICNS returned null');
  const icnsOut = path.join(ASSETS_DIR, 'icon.icns');
  fs.writeFileSync(icnsOut, icnsBuffer);
  console.log(`Wrote ${icnsOut} (${icnsBuffer.length.toLocaleString()} bytes)`);

  // 3) Template tray icons — silhouette, transparent background.
  const tpl16 = await renderTemplatePng(source, 16);
  const tpl16Out = path.join(ASSETS_DIR, 'iconTemplate.png');
  fs.writeFileSync(tpl16Out, tpl16);
  console.log(`Wrote ${tpl16Out} (${tpl16.length.toLocaleString()} bytes)`);

  const tpl32 = await renderTemplatePng(source, 32);
  const tpl32Out = path.join(ASSETS_DIR, 'iconTemplate@2x.png');
  fs.writeFileSync(tpl32Out, tpl32);
  console.log(`Wrote ${tpl32Out} (${tpl32.length.toLocaleString()} bytes)`);

  console.log('\nDone. Generated 3 macOS icon assets.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
