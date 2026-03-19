#!/usr/bin/env node
/**
 * Generates a simple wmux icon as .ico file using raw pixel data.
 * No external dependencies — pure Node.js.
 *
 * Creates a 256x256 icon with:
 * - Dark background (#1e1e2e)
 * - Blue "W" letter (#89b4fa)
 * - Green status dot (#a6e3a1)
 */
const fs = require('fs');
const path = require('path');

// Simple BMP-based ICO generator for 32x32 icon
const SIZE = 32;
const pixels = Buffer.alloc(SIZE * SIZE * 4); // BGRA

const BG = [0x2e, 0x1e, 0x1e, 0xff];       // #1e1e2e BGRA
const BLUE = [0xfa, 0xb4, 0x89, 0xff];      // #89b4fa BGRA
const GREEN = [0xa1, 0xe3, 0xa6, 0xff];     // #a6e3a1 BGRA

// Fill background
for (let i = 0; i < SIZE * SIZE; i++) {
  pixels.set(BG, i * 4);
}

// Draw "W" shape (simplified pixel art)
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

// Draw green dot (top-right)
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

// Build ICO file
// ICO Header: 6 bytes
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);      // Reserved
icoHeader.writeUInt16LE(1, 2);      // Type: ICO
icoHeader.writeUInt16LE(1, 4);      // Number of images

// ICO Directory Entry: 16 bytes
const dirEntry = Buffer.alloc(16);
dirEntry.writeUInt8(SIZE, 0);       // Width
dirEntry.writeUInt8(SIZE, 1);       // Height
dirEntry.writeUInt8(0, 2);          // Color palette
dirEntry.writeUInt8(0, 3);          // Reserved
dirEntry.writeUInt16LE(1, 4);       // Color planes
dirEntry.writeUInt16LE(32, 6);      // Bits per pixel

// BMP Info Header: 40 bytes
const bmpHeader = Buffer.alloc(40);
bmpHeader.writeUInt32LE(40, 0);     // Header size
bmpHeader.writeInt32LE(SIZE, 4);    // Width
bmpHeader.writeInt32LE(SIZE * 2, 8); // Height (double for ICO)
bmpHeader.writeUInt16LE(1, 12);     // Planes
bmpHeader.writeUInt16LE(32, 14);    // Bits per pixel
bmpHeader.writeUInt32LE(0, 16);     // Compression (none)
bmpHeader.writeUInt32LE(pixels.length, 20); // Image size

const imageSize = bmpHeader.length + pixels.length;
dirEntry.writeUInt32LE(imageSize, 8);  // Size of image data
dirEntry.writeUInt32LE(6 + 16, 12);   // Offset to image data

const ico = Buffer.concat([icoHeader, dirEntry, bmpHeader, pixels]);

const outPath = path.join(__dirname, '..', 'assets', 'icon.ico');
fs.writeFileSync(outPath, ico);
console.log(`Icon written to ${outPath} (${ico.length} bytes)`);
