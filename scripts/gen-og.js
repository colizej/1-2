#!/usr/bin/env node
// Converts og-image.svg → og-image.png and favicon.svg → icon-512.png
// Requires: @resvg/resvg-js (installed via `make og` or manually)

const { Resvg } = require('@resvg/resvg-js');
const fs   = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function convert(svgFile, pngFile, width, bgColor) {
  let svg = fs.readFileSync(svgFile, 'utf-8');
  if (bgColor) {
    // Inject background rect right after opening <svg ...> tag
    svg = svg.replace(/(<svg[^>]*>)/, `$1<rect width="100%" height="100%" fill="${bgColor}"/>`);
  }
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font:  { loadSystemFonts: true },
  });
  const pngData = resvg.render().asPng();
  fs.writeFileSync(pngFile, pngData);
  console.log('✓', path.relative(root, pngFile));
}

convert(
  path.join(root, 'icons/og-image.svg'),
  path.join(root, 'icons/og-image.png'),
  1200,
);

const iconSizes = [
  { file: 'icons/icon-512.png', size: 512 },
  { file: 'icons/icon-192.png', size: 192 },
  { file: 'icons/icon-180.png', size: 180 },
  { file: 'icons/favicon-32.png', size: 32 },
];
for (const { file, size } of iconSizes) {
  convert(path.join(root, 'icons/favicon.svg'), path.join(root, file), size, '#0a0a0f');
}
