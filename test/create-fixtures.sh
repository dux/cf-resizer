#!/usr/bin/env bash
# Generate test fixture images using sharp via bun
set -e

DIR="$(cd "$(dirname "$0")/fixtures" && pwd)"

bun -e "
const sharp = require('sharp');
const path = require('path');
const dir = '${DIR}';

async function gen() {
  const big = sharp({ create: { width: 3200, height: 2400, channels: 3, background: { r: 100, g: 150, b: 200 } } });
  const small = sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 100, b: 50 } } });
  const sq = sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 50, g: 200, b: 100, alpha: 1 } } });

  await big.jpeg({ quality: 90 }).toFile(path.join(dir, 'photo.jpg'));
  await big.png().toFile(path.join(dir, 'photo.png'));
  await big.webp({ quality: 90 }).toFile(path.join(dir, 'photo.webp'));
  await big.avif({ quality: 80 }).toFile(path.join(dir, 'photo.avif'));
  await big.tiff().toFile(path.join(dir, 'photo.tiff'));
  await sq.gif().toFile(path.join(dir, 'photo.gif'));
  await small.jpeg({ quality: 85 }).toFile(path.join(dir, 'small.jpg'));

  // SVG
  const fs = require('fs');
  fs.writeFileSync(path.join(dir, 'icon.svg'), '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\"><rect fill=\"#369\" width=\"100\" height=\"100\"/></svg>');

  console.log('Fixtures created in ' + dir);
}
gen();
"
