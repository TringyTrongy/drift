// Channel geometry, shared by the solver (masks) and the drawing (outlines).
// Lengths in metres. The field grid is NX x NY cells of H; the flow grid is
// FX x FY cells of HF = 2H. The emitter sits at the centre of field cell (IE, JE).

export const NX = 240;
export const NY = 120;
export const H = 1e-4;
export const LX = NX * H; // 24 mm
export const LY = NY * H; // 12 mm
export const FX = NX / 2;
export const FY = NY / 2;
export const HF = 2 * H;
export const IE = 60;
export const JE = 60;
export const EMITTER_X = (IE + 0.5) * H;
export const EMITTER_Y = (JE + 0.5) * H;

export const GAP_MIN = 0.002;
export const GAP_MAX = 0.01;

export const VIEWS = {
  A: {
    letter: 'A',
    name: 'twin plates',
    blurb: 'two grounded plates parallel to the flow, wire upstream on the centreline',
  },
  B: {
    letter: 'B',
    name: 'bar grid',
    blurb: 'a row of grounded bars across the channel',
  },
  C: {
    letter: 'C',
    name: 'airfoil',
    blurb: 'a grounded symmetric airfoil, wire ahead of its nose',
  },
};

// Plate geometry for view A (field cells).
const PLATE_GAP = 25; // centreline to inner face, 2.5 mm
const PLATE_T = 4; // 0.4 mm
const PLATE_L = 60; // 6 mm
// Bars for view B.
const BAR = 5; // 0.5 mm square
const BAR_PITCH = 14; // 1.4 mm
const BAR_COUNT = 4; // each side of the centreline
// Airfoil for view C (NACA 00xx).
const FOIL_CHORD = 70; // 7 mm
const FOIL_T = 0.18;

function foilHalf(xc) {
  // NACA 4-digit symmetric thickness, xc in [0, 1], closed trailing edge.
  if (xc < 0 || xc > 1) return -1;
  return 5 * FOIL_T * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
}

// Collector outlines in metres, for drawing. Each shape is a closed polygon.
export function collectorShapes(view, gap) {
  const gc = Math.round(gap / H);
  const x0 = (IE + gc) * H + 0.5 * H; // leading face (cell edge nearest the wire, centre-aligned)
  const shapes = [];
  if (view === 'A') {
    for (const s of [1, -1]) {
      const yIn = EMITTER_Y + s * (PLATE_GAP - 0.5) * H;
      const yOut = yIn + s * PLATE_T * H;
      shapes.push([
        [x0 - 0.5 * H, yIn], [x0 - 0.5 * H + PLATE_L * H, yIn],
        [x0 - 0.5 * H + PLATE_L * H, yOut], [x0 - 0.5 * H, yOut],
      ]);
    }
  } else if (view === 'B') {
    for (let k = -BAR_COUNT; k <= BAR_COUNT; k++) {
      const yc = EMITTER_Y + k * BAR_PITCH * H;
      const xa = x0 - 0.5 * H;
      shapes.push([
        [xa, yc - (BAR / 2) * H], [xa + BAR * H, yc - (BAR / 2) * H],
        [xa + BAR * H, yc + (BAR / 2) * H], [xa, yc + (BAR / 2) * H],
      ]);
    }
  } else {
    const xa = x0 - 0.5 * H;
    const c = FOIL_CHORD * H;
    const top = [], bot = [];
    for (let n = 0; n <= 48; n++) {
      const t = 0.5 - 0.5 * Math.cos((Math.PI * n) / 48); // cosine spacing
      const y = foilHalf(t) * c;
      top.push([xa + t * c, EMITTER_Y + y]);
      bot.push([xa + t * c, EMITTER_Y - y]);
    }
    shapes.push(top.concat(bot.reverse()));
  }
  return shapes;
}

// Field-grid collector mask (1 = grounded conductor).
export function collectorMask(view, gap) {
  const mask = new Uint8Array(NX * NY);
  const gc = Math.round(gap / H);
  const i0 = IE + gc;
  if (view === 'A') {
    for (let i = i0; i < Math.min(NX, i0 + PLATE_L); i++) {
      for (let t = 0; t < PLATE_T; t++) {
        mask[i + (JE + PLATE_GAP + t) * NX] = 1;
        mask[i + (JE - PLATE_GAP - t) * NX] = 1;
      }
    }
  } else if (view === 'B') {
    const half = (BAR - 1) / 2;
    for (let k = -BAR_COUNT; k <= BAR_COUNT; k++) {
      const jc = JE + k * BAR_PITCH;
      for (let j = jc - half; j <= jc + half; j++) {
        if (j < 0 || j >= NY) continue;
        for (let i = i0; i < i0 + BAR; i++) mask[i + j * NX] = 1;
      }
    }
  } else {
    for (let i = i0; i < Math.min(NX, i0 + FOIL_CHORD + 1); i++) {
      const t = (i - i0) / FOIL_CHORD;
      const half = foilHalf(t) * FOIL_CHORD;
      if (half < 0) continue;
      for (let j = 0; j < NY; j++) {
        if (Math.abs(j - JE) <= half + 0.25) mask[i + j * NX] = 1;
      }
    }
  }
  return mask;
}

// Flow-grid solid mask: a flow cell is solid when at least two of its four field
// cells are conductor, so thin plates survive the coarser grid.
export function flowSolid(mask) {
  const solid = new Uint8Array(FX * FY);
  for (let J = 0; J < FY; J++) {
    for (let I = 0; I < FX; I++) {
      const k = 2 * I + 2 * J * NX;
      const n = mask[k] + mask[k + 1] + mask[k + NX] + mask[k + NX + 1];
      solid[I + J * FX] = n >= 2 ? 1 : 0;
    }
  }
  return solid;
}

// Shortest distance from the wire to any conductor cell centre: the ion path
// length the momentum model uses.
export function ionPath(mask) {
  let best = Infinity;
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      if (!mask[i + j * NX]) continue;
      const d = Math.hypot(i - IE, j - JE);
      if (d < best) best = d;
    }
  }
  return (best - 0.5) * H;
}
