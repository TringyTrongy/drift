// The pens on the desk. Canvas needs plain colours, so the palette in
// styles.css is mirrored here in sRGB.

export const PAL = {
  paper: '#ddefd9',
  ink: '#0f1e18',
  graphite: '#49524f',
  print: '#266341',
  red: '#b12725',
  redRGB: [177, 39, 37],
  printRGB: [38, 99, 65],
};

export function letter(px) {
  return `${Math.round(px * 10) / 10}px ISO, "Segoe UI", sans-serif`;
}

export function printFont(px) {
  return `600 ${Math.round(px * 10) / 10}px Pad, "Arial Narrow", sans-serif`;
}

// Lettering over a busy drawing: a paper-coloured halo first, then the ink.
export function haloText(c, text, x, y, color, font) {
  if (font) c.font = font;
  c.lineJoin = 'round';
  c.strokeStyle = PAL.paper;
  c.lineWidth = 4;
  c.strokeText(text, x, y);
  c.fillStyle = color;
  c.fillText(text, x, y);
}
