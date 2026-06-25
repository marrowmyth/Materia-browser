'use strict';
// Generates the installer art from the high-res logos in the Downloads folder.
// Run once (needs sharp): node scripts/make-build-assets.js
// Outputs: build/icon.png (app icon), build/installerSidebar.bmp, build/installerHeader.bmp
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DL = path.join(ROOT, '..');            // the Downloads folder
const BUILD = path.join(ROOT, 'build');
const BG = { r: 255, g: 255, b: 255 };       // white = blends into the wizard's page bg (BMP has no alpha)

const SRC = {
  icon: path.join(DL, 'small.png'),          // clean square Materia emblem
  sidebar: path.join(DL, 'Materia1.png'),    // tall Materia logo
  header: path.join(DL, 'MMFull Logo.png')   // MarrowMyth wordmark
};

// Minimal 24-bit BMP encoder (NSIS wizard images must be .bmp, no alpha).
function writeBMP(file, width, height, rgb) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixSize = rowSize * height;
  const buf = Buffer.alloc(54 + pixSize);
  buf.write('BM', 0);
  buf.writeUInt32LE(54 + pixSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);     // positive height = bottom-up
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixSize, 34);
  buf.writeInt32LE(2835, 38); buf.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const dst = 54 + (height - 1 - y) * rowSize;   // BMP rows are bottom-up
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      buf[dst + x * 3] = rgb[s + 2];      // B
      buf[dst + x * 3 + 1] = rgb[s + 1];  // G
      buf[dst + x * 3 + 2] = rgb[s];      // R
    }
  }
  fs.writeFileSync(file, buf);
}

async function bmpFrom(src, w, h, out) {
  const raw = await sharp(src)
    .resize(w, h, { fit: 'contain', background: BG })
    .flatten({ background: BG })
    .removeAlpha()
    .raw()
    .toBuffer();
  writeBMP(out, w, h, raw);
}

async function run() {
  fs.mkdirSync(BUILD, { recursive: true });
  // App icon — 512 square, transparent; electron-builder converts to .ico
  await sharp(SRC.icon)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(BUILD, 'icon.png'));
  // Wizard welcome/finish side panel (164x314) + inner-page header (150x57)
  await bmpFrom(SRC.sidebar, 164, 314, path.join(BUILD, 'installerSidebar.bmp'));
  await bmpFrom(SRC.header, 150, 57, path.join(BUILD, 'installerHeader.bmp'));
  console.log('Build assets written to build/:', fs.readdirSync(BUILD).join(', '));
}
run().catch(e => { console.error(e); process.exit(1); });
