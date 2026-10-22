// Works out the sheet: square size, column count and where everything sits, all
// in whole squares so the page lands on its own ruling. Writes CSS variables on
// <html> and returns the numbers the canvases need.

export function computeLayout(vw) {
  let mode, sq, row, fs, fsPrint, cols, from, to, ruleAt;
  if (vw >= 1320) {
    mode = 'wide';
    sq = vw >= 1640 ? 22 : 20;
    cols = 72;
    ruleAt = 4;
    from = 6;
    to = 72;
  } else if (vw >= 900) {
    mode = 'stack';
    sq = vw >= 1000 ? 20 : 18;
    cols = Math.floor(vw / sq);
    ruleAt = 2;
    from = 4;
    to = cols;
  } else {
    mode = 'narrow';
    sq = vw < 380 ? 14 : 15;
    cols = Math.floor(vw / sq);
    ruleAt = 1;
    from = 3;
    to = cols;
  }
  const W = to - from; // content width in squares
  if (mode === 'narrow') {
    row = 2 * sq;
    fs = vw < 380 ? 15 : 16;
    fsPrint = 12;
  } else {
    row = sq;
    fs = Math.round(sq * 0.76);
    fsPrint = Math.round(sq * 0.6);
  }
  const used = cols * sq;
  const bgx = mode === 'wide' ? Math.max(0, Math.floor((vw - used) / 2 / sq)) * sq : 0;

  // Fig. 1: squares per millimetre, then the stage around a 24 x 12 mm channel:
  // a millimetre scale, two walls and room for the gap's dimension line.
  let mm;
  if (mode === 'wide') mm = 2;
  else if (mode === 'stack') mm = Math.min(2, Math.floor((W / 24) * 4) / 4);
  else mm = Math.min(1, W / 24);
  const stageW = Math.floor(24 * mm);
  const ruler = 1, wall = 1, dim = 2;
  const stageH = Math.round(12 * mm) + ruler + 2 * wall + dim;

  let f1From = from, f1To = mode === 'wide' ? from + 48 : to;
  let mFrom = mode === 'wide' ? from + 50 : from, mTo = to;
  let mGrid = '1fr';
  if (mode === 'stack') mGrid = 'repeat(2, minmax(0, 1fr))';

  // Fig. 2 panels.
  let plotW, plotH, f2Grid;
  if (mode === 'wide') {
    plotW = 32;
    plotH = 22;
    f2Grid = `repeat(2, calc(var(--sq) * ${plotW}))`;
  } else if (W >= 57) {
    plotW = Math.floor((W - 1) / 2);
    plotH = Math.round(plotW * 0.7);
    f2Grid = `repeat(2, calc(var(--sq) * ${plotW}))`;
  } else {
    plotW = Math.min(W, mode === 'narrow' ? W : 44);
    plotH = Math.round(plotW * (mode === 'narrow' ? 0.8 : 0.66));
    f2Grid = `calc(var(--sq) * ${plotW})`;
  }

  [plotW, plotH] = registerPlot(plotW, plotH);
  if (mode !== 'narrow' && f2Grid.startsWith('repeat')) f2Grid = `repeat(2, calc(var(--sq) * ${plotW}))`;
  else f2Grid = `calc(var(--sq) * ${plotW})`;

  const logGrid = mode === 'wide' ? 'calc(var(--sq) * 38) 1fr' : W >= 60 ? 'calc(var(--sq) * 34) 1fr' : '1fr';
  const notesW = Math.min(W, mode === 'narrow' ? W : 34);
  const footGrid = mode === 'narrow' ? '1fr' : 'repeat(2, calc(var(--sq) * 22))';

  // Header boxes.
  const hd = mode === 'wide' ? 11 : mode === 'stack' ? 9 : Math.floor(W / 2);
  const hs = mode === 'narrow' ? W - hd : hd;
  const hp = mode === 'narrow' ? W : W - hd - hs;

  const vars = {
    '--sq': `${sq}px`,
    '--row': `${row}px`,
    '--fs': `${fs}px`,
    '--fs-print': `${fsPrint}px`,
    '--cols': cols,
    '--bgx': `${bgx}px`,
    '--margin-rule': ruleAt,
    '--c-from': from,
    '--c-to': to,
    '--head-cols': W,
    '--hp': hp,
    '--hd': hd,
    '--hs': hs,
    '--f1-from': f1From,
    '--f1-to': f1To,
    '--stage-w': stageW,
    '--stage-h': stageH,
    '--m-from': mFrom,
    '--m-to': mTo,
    '--m-grid': mGrid,
    '--f2-grid': f2Grid,
    '--plot-w': plotW,
    '--plot-h': plotH,
    '--log-grid': logGrid,
    '--notes-w': notesW,
    '--foot-grid': footGrid,
  };
  return { mode, sq, row, fs, cols, mm, stageW, stageH, ruler, wall, dim, plotW, plotH, vars };
}

// Plot areas sit 4 squares inside their panels. Split the height into 6 whole-
// square steps, and the voltage span into 7 when that costs at most 3 squares,
// so ticks land on ruling lines.
function registerPlot(w, h) {
  const raw = w - 4;
  const fit = Math.floor(raw / 7) * 7;
  const aw = fit >= 7 && raw - fit <= 3 ? fit : raw;
  const ah = Math.max(6, Math.ceil((h - 4) / 6) * 6);
  return [aw + 4, ah + 4];
}

export function applyLayout() {
  const vw = document.documentElement.clientWidth;
  const L = computeLayout(vw);
  const root = document.documentElement;
  root.dataset.layout = L.mode;
  for (const [k, v] of Object.entries(L.vars)) root.style.setProperty(k, String(v));
  return L;
}
