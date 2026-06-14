#!/usr/bin/env node
/**
 * Cross-platform icon pipeline.
 *
 * Generates platform-specific icons under D:\wmux\assets\:
 *   - icon.ico   (Windows, multi-size PNG-based ICO; preserved as-is when present)
 *   - icon.icns  (macOS, Apple ICNS)
 *   - icon.png   (Linux, 1024x1024 PNG)
 *
 * ICO HANDLING (Windows shell-loader compatibility):
 *   icon.ico is REGENERATED from the 256x256 master every run via
 *   png2icons.createICO(..., forWinExe=true). forWinExe stores every frame
 *   SMALLER than 64px (16/32/48) as an uncompressed Windows BMP and the
 *   larger frames as PNG. This matters: the Win32 shell icon loader that
 *   paints the taskbar button / Alt-Tab / Explorer HICON can NOT render
 *   PNG-compressed frames below 256px, so an all-PNG ICO renders BLANK in
 *   the taskbar even though Chromium (tray nativeImage) decodes it fine.
 *   A previous "byte-identity" contract shipped an all-PNG ICO and caused
 *   exactly that blank-taskbar regression. The artwork is unchanged — we
 *   only re-encode the existing master. The legacy pixel-art "W" path is
 *   kept as a last-resort source so a fresh checkout missing icon.ico can
 *   still bootstrap a master to re-encode from.
 *
 * SOURCES for .icns / .png:
 *   We extract the embedded 256x256 PNG chunk from icon.ico and use it as
 *   the master raster. This guarantees the macOS / Linux assets share a
 *   single visual identity with the Windows icon.
 *
 * Pure JS, no native bindings, no external binaries (no Sharp / iconutil /
 * ImageMagick). Only dependency: png2icons (idesis-gmbh/png2icons).
 */

const fs = require('fs');
const path = require('path');
const png2icons = require('png2icons');
const UPNG = require('png2icons/lib/UPNG');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const ICO_PATH = path.join(ASSETS_DIR, 'icon.ico');
const ICNS_PATH = path.join(ASSETS_DIR, 'icon.icns');
const PNG_PATH = path.join(ASSETS_DIR, 'icon.png');

// ---------------------------------------------------------------------------
// Step 1: Ensure icon.ico exists. If missing, regenerate the legacy pixel-art
// "W" 32x32 ICO (preserves the historical generator behavior bit-for-bit).
// ---------------------------------------------------------------------------

function generateLegacyIco() {
  const SIZE = 32;
  const pixels = Buffer.alloc(SIZE * SIZE * 4); // BGRA

  const BG = [0x2e, 0x1e, 0x1e, 0xff];     // #1e1e2e BGRA
  const BLUE = [0xfa, 0xb4, 0x89, 0xff];   // #89b4fa BGRA
  const GREEN = [0xa1, 0xe3, 0xa6, 0xff];  // #a6e3a1 BGRA

  for (let i = 0; i < SIZE * SIZE; i++) pixels.set(BG, i * 4);

  const W_PATTERN = [
    '..XXXX....XXXX..',
    '..XXXX....XXXX..',
    '..XXXX....XXXX..',
    '..XXXX....XXXX..',
    '..XXXX....XXXX..',
    '..XXXX....XXXX..',
    '..XXXX....XXXX..',
    '..XXXX....XXXX..',
    '..XXXX....XXXX..',
    '..XXXX.XX.XXXX..',
    '..XXXX.XX.XXXX..',
    '..XXXXXX.XXXXX..',
    '..XXXXXX.XXXXX..',
    '..XXXXX..XXXXX..',
    '...XXXX..XXXX...',
    '...XXX....XXX...',
  ];

  const startY = 8;
  const startX = 8;
  for (let row = 0; row < W_PATTERN.length; row++) {
    for (let col = 0; col < W_PATTERN[row].length; col++) {
      if (W_PATTERN[row][col] === 'X') {
        const x = startX + col;
        const y = startY + row;
        if (x < SIZE && y < SIZE) {
          const idx = ((SIZE - 1 - y) * SIZE + x) * 4; // BMP is bottom-up
          pixels.set(BLUE, idx);
        }
      }
    }
  }

  // Green status dot (top-right)
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx * dx + dy * dy <= 4) {
        const x = 26 + dx;
        const y = 5 + dy;
        if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) {
          const idx = ((SIZE - 1 - y) * SIZE + x) * 4;
          pixels.set(GREEN, idx);
        }
      }
    }
  }

  const icoHeader = Buffer.alloc(6);
  icoHeader.writeUInt16LE(0, 0);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(1, 4);

  const dirEntry = Buffer.alloc(16);
  dirEntry.writeUInt8(SIZE, 0);
  dirEntry.writeUInt8(SIZE, 1);
  dirEntry.writeUInt8(0, 2);
  dirEntry.writeUInt8(0, 3);
  dirEntry.writeUInt16LE(1, 4);
  dirEntry.writeUInt16LE(32, 6);

  const bmpHeader = Buffer.alloc(40);
  bmpHeader.writeUInt32LE(40, 0);
  bmpHeader.writeInt32LE(SIZE, 4);
  bmpHeader.writeInt32LE(SIZE * 2, 8);
  bmpHeader.writeUInt16LE(1, 12);
  bmpHeader.writeUInt16LE(32, 14);
  bmpHeader.writeUInt32LE(0, 16);
  bmpHeader.writeUInt32LE(pixels.length, 20);

  const imageSize = bmpHeader.length + pixels.length;
  dirEntry.writeUInt32LE(imageSize, 8);
  dirEntry.writeUInt32LE(6 + 16, 12);

  const ico = Buffer.concat([icoHeader, dirEntry, bmpHeader, pixels]);
  fs.writeFileSync(ICO_PATH, ico);
  console.log(`[generate-icon] Wrote ${path.relative(process.cwd(), ICO_PATH)} (${ico.length} bytes, legacy fallback)`);
}

if (!fs.existsSync(ICO_PATH)) {
  console.log('[generate-icon] icon.ico missing — regenerating legacy pixel-art fallback.');
  generateLegacyIco();
} else {
  console.log(`[generate-icon] Using existing icon.ico (${fs.statSync(ICO_PATH).size} bytes) as the master source — will re-encode below.`);
}

// ---------------------------------------------------------------------------
// Step 2: Extract the largest PNG chunk from icon.ico to use as the raster
// master for ICNS / PNG generation. ICOs may contain BMP or PNG chunks; we
// look for a PNG chunk (89 50 4E 47 magic) at the highest size.
// ---------------------------------------------------------------------------

function extractMasterPng(icoPath) {
  const buf = fs.readFileSync(icoPath);
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error(`Not an ICO file: ${icoPath}`);
  }
  const numImages = buf.readUInt16LE(4);
  let bestPng = null;
  let bestSize = 0;
  for (let i = 0; i < numImages; i++) {
    const off = 6 + i * 16;
    const w = buf.readUInt8(off) || 256; // 0 means 256
    const h = buf.readUInt8(off + 1) || 256;
    const sz = buf.readUInt32LE(off + 8);
    const offset = buf.readUInt32LE(off + 12);
    const isPng =
      buf[offset] === 0x89 &&
      buf[offset + 1] === 0x50 &&
      buf[offset + 2] === 0x4e &&
      buf[offset + 3] === 0x47;
    if (isPng && w * h > bestSize) {
      bestSize = w * h;
      bestPng = buf.slice(offset, offset + sz);
    }
  }
  return bestPng;
}

let masterPng = extractMasterPng(ICO_PATH);

if (!masterPng) {
  // ICO is BMP-only (legacy fallback path). Synthesize a 256x256 PNG from
  // the 32x32 BMP chunk via nearest-neighbor 8x upscale so we still have
  // something to feed into png2icons.
  console.log('[generate-icon] ICO has no PNG chunks (BMP-only); synthesizing PNG from BMP chunk.');
  const buf = fs.readFileSync(ICO_PATH);
  const dirOff = 6;
  const w = buf.readUInt8(dirOff) || 256;
  const dataOff = buf.readUInt32LE(dirOff + 12);
  // BMP info header (40 bytes) then pixel data, bottom-up BGRA
  const pxOff = dataOff + 40;
  const rgba = new Uint8Array(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const srcIdx = pxOff + ((w - 1 - y) * w + x) * 4;
      const dstIdx = (y * w + x) * 4;
      rgba[dstIdx] = buf[srcIdx + 2];
      rgba[dstIdx + 1] = buf[srcIdx + 1];
      rgba[dstIdx + 2] = buf[srcIdx + 0];
      rgba[dstIdx + 3] = buf[srcIdx + 3];
    }
  }
  // Upscale to 256x256 if smaller (nearest neighbor preserves crisp pixel art)
  const TARGET = 256;
  let pixels = rgba;
  let dim = w;
  if (w < TARGET) {
    const scale = Math.floor(TARGET / w);
    const newDim = w * scale;
    const upscaled = new Uint8Array(newDim * newDim * 4);
    for (let y = 0; y < newDim; y++) {
      for (let x = 0; x < newDim; x++) {
        const sx = Math.floor(x / scale);
        const sy = Math.floor(y / scale);
        const srcIdx = (sy * w + sx) * 4;
        const dstIdx = (y * newDim + x) * 4;
        upscaled[dstIdx] = rgba[srcIdx];
        upscaled[dstIdx + 1] = rgba[srcIdx + 1];
        upscaled[dstIdx + 2] = rgba[srcIdx + 2];
        upscaled[dstIdx + 3] = rgba[srcIdx + 3];
      }
    }
    pixels = upscaled;
    dim = newDim;
  }
  masterPng = Buffer.from(UPNG.encode([pixels.buffer], dim, dim, 0));
}

// ---------------------------------------------------------------------------
// Step 2.5: Re-encode icon.ico (Windows) from the master with shell-safe frame
// encoding. forWinExe=true stores frames < 64px (16/32/48) as uncompressed
// Windows BMP and larger frames as PNG. The Win32 shell icon loader (taskbar
// button, Alt-Tab, Explorer, window title-bar) can't render PNG-compressed
// sub-256 frames, so an all-PNG ICO shows a BLANK taskbar icon. This is the
// fix for that regression — artwork is unchanged, only the encoding. (PNG arg
// is ignored when forWinExe is true.)
// ---------------------------------------------------------------------------

const icoBuf = png2icons.createICO(masterPng, png2icons.BICUBIC2, 0, false, true);
if (!icoBuf) {
  throw new Error('png2icons.createICO returned null');
}
fs.writeFileSync(ICO_PATH, icoBuf);
console.log(`[generate-icon] Wrote ${path.relative(process.cwd(), ICO_PATH)} (${icoBuf.length} bytes, BMP<64 + PNG, Windows shell-safe)`);

// ---------------------------------------------------------------------------
// Step 3: Generate icon.icns (macOS) via png2icons.createICNS.
// ---------------------------------------------------------------------------

const icnsBuf = png2icons.createICNS(masterPng, png2icons.BICUBIC2, 0);
if (!icnsBuf) {
  throw new Error('png2icons.createICNS returned null');
}
fs.writeFileSync(ICNS_PATH, icnsBuf);
console.log(`[generate-icon] Wrote ${path.relative(process.cwd(), ICNS_PATH)} (${icnsBuf.length} bytes)`);

// ---------------------------------------------------------------------------
// Step 4: Generate icon.png (Linux, 1024x1024). Decode master PNG, upscale
// 4x via nearest neighbor (master is 256x256 so 256 -> 1024), re-encode.
// Nearest neighbor is intentional: the master is already anti-aliased; bicubic
// would add a second blur pass. For a logo this preserves edge crispness.
// ---------------------------------------------------------------------------

const decoded = UPNG.decode(masterPng);
const masterRgba = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
const SRC_W = decoded.width;
const SRC_H = decoded.height;
const TARGET_DIM = 1024;
const scale = Math.max(1, Math.floor(TARGET_DIM / SRC_W));
const OUT_W = SRC_W * scale;
const OUT_H = SRC_H * scale;
const linuxRgba = new Uint8Array(OUT_W * OUT_H * 4);
for (let y = 0; y < OUT_H; y++) {
  for (let x = 0; x < OUT_W; x++) {
    const sx = Math.floor(x / scale);
    const sy = Math.floor(y / scale);
    const srcIdx = (sy * SRC_W + sx) * 4;
    const dstIdx = (y * OUT_W + x) * 4;
    linuxRgba[dstIdx] = masterRgba[srcIdx];
    linuxRgba[dstIdx + 1] = masterRgba[srcIdx + 1];
    linuxRgba[dstIdx + 2] = masterRgba[srcIdx + 2];
    linuxRgba[dstIdx + 3] = masterRgba[srcIdx + 3];
  }
}
const linuxPng = Buffer.from(UPNG.encode([linuxRgba.buffer], OUT_W, OUT_H, 0));
fs.writeFileSync(PNG_PATH, linuxPng);
console.log(`[generate-icon] Wrote ${path.relative(process.cwd(), PNG_PATH)} (${linuxPng.length} bytes, ${OUT_W}x${OUT_H})`);

console.log('[generate-icon] Done.');
