// Fig. 2: readings plotted on the model, on the sheet's own ruling. Axes start
// and end on grid lines and tick spacing is a whole number of squares.

import { PAL, letter, haloText } from './ink.js';
import { townsend, townsendCurrent, idealSpeed, wireCapacitance, SPARK_FIELD, MU_ION } from './model.js';
import { H, LY } from './geometry.js';

export const V_MAX = 14000;

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 4, 5, 8, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

// Pick a division count that splits `squares` evenly and a round step, so the
// axis tops out as close above `top` as the ruling allows.
function axis(top, squares, strict = true) {
  let best = null;
  for (let n = 3; n <= 14; n++) {
    if (strict && squares % n !== 0) continue;
    if (!strict && n > 8) break;
    const step = niceStep(top / n);
    const max = step * n;
    // Lowest top wins; on a tie, ticks about three squares apart.
    const spread = Math.abs(squares / n - 3);
    if (!best || max < best.max - 1e-9 || (Math.abs(max - best.max) < 1e-9 && spread < best.spread)) best = { n, step, max, spread };
  }
  // A square count with no small divisor: keep round ticks, give up registration.
  return best || axis(top, squares, false);
}

function fmt(v) {
  if (v === 0) return '0';
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(0);
  if (Math.abs(v) >= 1) return Number.isInteger(v) ? String(v) : v.toFixed(1);
  return v.toFixed(2).replace(/0$/, '');
}

// Sets the collected lettering. Numbers at the frame's top and right edges are
// spread so they never touch; notes inside the frame get a paper knockout so the
// curves break around them.
function letterNotes(panel, notes) {
  const c = panel.ctx;
  const width = (n) => {
    c.font = n.font;
    return c.measureText(n.text).width;
  };
  const size = (n) => parseFloat(n.font) || 12;
  const set = [];
  let edge = -Infinity;
  for (const n of notes.filter((m) => m.group === 'top').sort((a, b) => a.x - b.x)) {
    const w = width(n);
    const x0 = Math.max(n.x - w / 2, edge + 4, panel.left + 2);
    if (x0 + w > panel.right + panel.m.sq * 0.9) continue;
    n.x = x0 + w / 2;
    edge = x0 + w;
    set.push(n);
  }
  let floor = -Infinity;
  for (const n of notes.filter((m) => m.group === 'right').sort((a, b) => a.y - b.y)) {
    const h = size(n);
    const y = Math.max(n.y, floor + h * 1.05, panel.top + h);
    if (y > panel.bottom + 4) continue;
    n.y = y;
    floor = y;
    set.push(n);
  }
  const taken = panel.marks.slice();
  const hits = (b) => taken.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
  for (const n of notes.filter((m) => m.group === 'free')) {
    const w = width(n), h = size(n);
    let x0 = n.align === 'right' ? n.x - w : n.align === 'center' ? n.x - w / 2 : n.x;
    x0 = Math.min(Math.max(x0, panel.left + 4), panel.right - w - 4);
    let placed = null;
    for (const dy of [0, -1.3, 1.3, -2.6, 2.6, -3.9, 3.9]) {
      const y = n.y + dy * h;
      const box = [x0 - 3, y - h * 0.85, x0 + w + 3, y + h * 0.27];
      if (y - h < panel.top || y > panel.bottom - 2 || hits(box)) continue;
      placed = { box, y };
      break;
    }
    if (!placed) {
      if (n.optional) continue;
      placed = { box: [x0 - 3, n.y - h * 0.85, x0 + w + 3, n.y + h * 0.27], y: n.y };
    }
    taken.push(placed.box);
    c.fillStyle = PAL.paper;
    c.fillRect(placed.box[0], placed.box[1], placed.box[2] - placed.box[0], placed.box[3] - placed.box[1]);
    n.align = 'left';
    n.x = x0;
    n.y = placed.y;
    set.push(n);
  }
  c.textBaseline = 'alphabetic';
  for (const n of set) {
    c.font = n.font;
    c.textAlign = n.align;
    c.fillStyle = n.color;
    c.fillText(n.text, n.x, n.y);
  }
}

class Panel {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  resize(m) {
    this.m = m;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = m.plotW * m.sq;
    this.h = m.plotH * m.sq;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    const sq = m.sq;
    this.left = 3 * sq;
    this.top = 1 * sq;
    this.right = this.w - 1 * sq;
    this.bottom = this.h - 3 * sq;
  }

  // Axis frame; xDiv/yDiv divisions, each a whole number of squares when possible.
  frame(xMax, xDiv, yMax, yDiv, xLabel, yLabel, panel) {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    this.xMax = xMax;
    this.yMax = yMax;
    this.marks = [];
    const { left, top, right, bottom } = this;
    const sq = this.m.sq;
    c.strokeStyle = PAL.ink;
    c.fillStyle = PAL.ink;
    c.lineWidth = 1.3;
    c.beginPath();
    c.moveTo(left + 0.5, top);
    c.lineTo(left + 0.5, bottom + 0.5);
    c.lineTo(right, bottom + 0.5);
    c.stroke();
    c.lineWidth = 1;
    c.font = letter(this.m.fs * 0.85);
    c.beginPath();
    for (let n = 0; n <= xDiv; n++) {
      const x = Math.round(this.px(n * (xMax / xDiv))) + 0.5;
      c.moveTo(x, bottom);
      c.lineTo(x, bottom + sq * 0.3);
    }
    for (let n = 0; n <= yDiv; n++) {
      const y = Math.round(this.py(n * (yMax / yDiv))) + 0.5;
      c.moveTo(left, y);
      c.lineTo(left - sq * 0.3, y);
    }
    c.stroke();
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    const every = this.w / xDiv < sq * 1.6 ? 2 : 1;
    for (let n = 0; n <= xDiv; n += every) c.fillText(fmt(n * (xMax / xDiv)), this.px(n * (xMax / xDiv)), bottom + sq * 1.15);
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    for (let n = 0; n <= yDiv; n++) c.fillText(fmt(n * (yMax / yDiv)), left - sq * 0.45, this.py(n * (yMax / yDiv)));
    c.textBaseline = 'alphabetic';
    c.font = letter(this.m.fs);
    c.textAlign = 'right';
    c.fillText(xLabel, right, bottom + sq * 2.4);
    c.save();
    c.translate(sq * 0.85, top);
    c.rotate(-Math.PI / 2);
    c.textAlign = 'right';
    c.fillText(yLabel, 0, 0);
    c.restore();
    c.textAlign = 'left';
    c.font = letter(this.m.fs * 1.1);
    c.fillText(panel, left + sq * 0.5, top + sq * 0.9);
  }

  px(x) { return this.left + (x / this.xMax) * (this.right - this.left); }
  py(y) { return this.bottom - (y / this.yMax) * (this.bottom - this.top); }

  clip() {
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.rect(this.left + 1, this.top - 2, this.right - this.left, this.bottom - this.top + 2);
    c.clip();
  }

  curve(f, x0, x1, style) {
    const c = this.ctx;
    c.strokeStyle = style.color;
    c.lineWidth = style.width;
    c.setLineDash(style.dash || []);
    c.beginPath();
    const n = 120;
    for (let k = 0; k <= n; k++) {
      const x = x0 + ((x1 - x0) * k) / n;
      const X = this.px(x), Y = this.py(f(x));
      k ? c.lineTo(X, Y) : c.moveTo(X, Y);
    }
    c.stroke();
    c.setLineDash([]);
  }

  dot(x, y, kind) {
    const c = this.ctx;
    const X = this.px(x), Y = this.py(y);
    this.marks.push([X - 6, Y - 6, X + 6, Y + 6]);
    if (kind === 'ink') {
      c.fillStyle = PAL.ink;
      c.beginPath();
      c.arc(X, Y, 3.2, 0, Math.PI * 2);
      c.fill();
    } else if (kind === 'ink-small') {
      c.strokeStyle = PAL.ink;
      c.lineWidth = 1.2;
      c.beginPath();
      c.arc(X, Y, 2.6, 0, Math.PI * 2);
      c.stroke();
    } else if (kind === 'live') {
      c.strokeStyle = PAL.graphite;
      c.lineWidth = 1.3;
      c.beginPath();
      c.arc(X, Y, 5, 0, Math.PI * 2);
      c.stroke();
    } else if (kind === 'bench') {
      c.strokeStyle = PAL.red;
      c.lineWidth = 1.6;
      c.beginPath();
      c.moveTo(X - 4, Y - 4); c.lineTo(X + 4, Y + 4);
      c.moveTo(X - 4, Y + 4); c.lineTo(X + 4, Y - 4);
      c.stroke();
    }
  }
}

function familyModels(table, rw) {
  if (!table) return [];
  return table.map((row) => {
    const cap = wireCapacitance(row.lambdaL, rw, H);
    const t = townsend({ capacitance: cap, rw, path: row.path });
    return { gap: row.gap, path: row.path, ...t };
  });
}

// st: { live, readings, bench, table, L, rw, view, gap, steady }
export class Fig2 {
  constructor(ivCanvas, uiCanvas) {
    this.iv = new Panel(ivCanvas);
    this.ui = new Panel(uiCanvas);
  }

  resize(m) {
    this.iv.resize(m);
    this.ui.resize(m);
  }

  draw(st) {
    const { live, readings, bench, L } = st;
    const sameKind = readings.filter((r) => r.view === st.view && Math.abs(r.rw - st.rw) < 1e-9);
    const family = familyModels(st.table, st.rw);
    const cur = live ? townsend({ capacitance: live.capacitance, rw: st.rw, path: live.path }) : null;
    const curSpark = live ? Math.min(V_MAX, SPARK_FIELD * live.path) : V_MAX;

    // ----- (a) current against voltage -----
    let iTop = 0;
    if (cur) iTop = townsendCurrent(curSpark, cur.C, cur.V0) * L * 1e6;
    for (const r of sameKind) iTop = Math.max(iTop, r.Iper * L * 1e6);
    for (const b of bench) iTop = Math.max(iTop, b.I);
    if (live) iTop = Math.max(iTop, live.Icoll * L * 1e6);
    iTop = Math.max(iTop * 1.08, 10);
    const ya = axis(iTop, Math.round((this.iv.bottom - this.iv.top) / this.iv.m.sq));
    const yDivA = ya.n;
    const iMax = ya.max;
    const xDivA = 7;
    const p = this.iv;
    p.frame(V_MAX / 1000, xDivA, iMax, yDivA, 'V, kV', 'I, µA', '(a)');
    const c = p.ctx;
    p.clip();

    // Sparkover zone at the current gap.
    if (curSpark < V_MAX) {
      const x0 = p.px(curSpark / 1000);
      c.save();
      c.beginPath();
      c.rect(x0, p.top, p.right - x0, p.bottom - p.top);
      c.clip();
      c.strokeStyle = PAL.red;
      c.globalAlpha = 0.2;
      c.lineWidth = 1;
      c.beginPath();
      for (let s = x0 - (p.bottom - p.top); s < p.right; s += 7) {
        c.moveTo(s, p.bottom);
        c.lineTo(s + (p.bottom - p.top), p.top);
      }
      c.stroke();
      c.restore();
    }

    // Lettering is collected while the curves are drawn and set last, on a paper
    // knockout, the way a draughtsman breaks lines around a note.
    const fsSmall = p.m.fs * 0.75;
    const ivOf = (C, V0) => (Vk) => townsendCurrent(Vk * 1000, C, V0) * L * 1e6;
    const notesA = [];

    if (cur) {
      const g = ivOf(cur.C, cur.V0);
      p.curve(g, cur.V0 / 1000, curSpark / 1000, { color: PAL.ink, width: 1.8 });
      // Below the curve: the readings sit above it.
      let vLab = cur.V0 + 0.62 * (curSpark - cur.V0);
      while (vLab > cur.V0 && g(vLab / 1000) > iMax * 0.7) vLab -= 100;
      notesA.push({
        text: `model, d = ${(st.gap * 1000).toFixed(1)} mm`, font: letter(p.m.fs * 0.9), color: PAL.ink,
        x: p.px(vLab / 1000) + 10, y: p.py(g(vLab / 1000)) + p.m.sq * 0.85, align: 'left', group: 'free',
      });
    }

    // Dashed family at whole-millimetre gaps, each numbered where it leaves the frame.
    for (const f of family) {
      if (Math.abs(f.gap - st.gap) < 0.6 * H) continue; // the solid curve covers it
      const vEnd = Math.min(V_MAX, SPARK_FIELD * f.path);
      if (vEnd <= f.V0) continue;
      const g = ivOf(f.C, f.V0);
      p.curve(g, f.V0 / 1000, vEnd / 1000, { color: PAL.graphite, width: 0.9, dash: [4, 3] });
      const note = { text: `${Math.round(f.gap * 1000)}`, font: letter(fsSmall), color: PAL.graphite };
      if (g(vEnd / 1000) >= iMax) {
        let lo = f.V0, hi = vEnd;
        for (let it = 0; it < 30; it++) {
          const mid = (lo + hi) / 2;
          if (g(mid / 1000) > iMax) hi = mid; else lo = mid;
        }
        notesA.push({ ...note, x: p.px(lo / 1000), y: p.top - 4, align: 'center', group: 'top' });
      } else if (vEnd < V_MAX) {
        notesA.push({ ...note, x: p.px(vEnd / 1000) + 4, y: p.py(g(vEnd / 1000)) + 3, align: 'left', group: 'free', optional: true });
      } else {
        notesA.push({ ...note, x: p.right + 3, y: p.py(g(V_MAX / 1000)) + 4, align: 'left', group: 'right' });
      }
    }
    // Bench fit.
    if (st.benchFit) {
      const bf = st.benchFit;
      p.curve((Vk) => townsendCurrent(Vk * 1000, bf.C, bf.V0), bf.V0 / 1000, V_MAX / 1000, { color: PAL.red, width: 1.2 });
    }

    // The result, lettered onto the plot: a bracket from a reading down to the model.
    if (cur && Number.isFinite(st.ratio)) {
      const onGap = sameKind
        .filter((r) => Math.abs(r.gap - st.gap) < 0.6 * H && r.V > cur.V0 && r.V <= curSpark && r.Iper * L * 1e6 < iMax)
        .sort((a, b) => b.V - a.V);
      const r = onGap[Math.min(1, onGap.length - 1)];
      if (r) {
        const x = p.px(r.V / 1000);
        const y1 = p.py(r.Iper * L * 1e6) + 5, y2 = p.py(ivOf(cur.C, cur.V0)(r.V / 1000)) - 3;
        if (y2 - y1 > 8) {
          c.strokeStyle = PAL.ink;
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(x - 3, y1); c.lineTo(x + 3, y1);
          c.moveTo(x, y1); c.lineTo(x, y2);
          c.moveTo(x - 3, y2); c.lineTo(x + 3, y2);
          c.stroke();
          notesA.push({
            text: `simulation ≈ ${st.ratio.toFixed(2)} × model`, font: letter(p.m.fs * 0.9), color: PAL.ink,
            x: x - 7, y: (y1 + y2) / 2 + 4, align: 'right', group: 'free',
          });
        }
      }
    }
    // Readings.
    for (const r of sameKind) {
      const onGap = Math.abs(r.gap - st.gap) < 0.6 * H;
      p.dot(r.V / 1000, r.Iper * L * 1e6, onGap ? 'ink' : 'ink-small');
    }
    for (const b of bench) p.dot(b.V, b.I, 'bench');
    if (live && !st.steady) p.dot(live.V / 1000, live.Icoll * L * 1e6, 'live');
    c.restore();
    letterNotes(p, notesA);
    // Onset tick under the axis.
    if (cur && cur.V0 < V_MAX) {
      const x = p.px(cur.V0 / 1000);
      c.strokeStyle = PAL.red;
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(x, p.bottom - p.m.sq * 0.5);
      c.lineTo(x, p.bottom + p.m.sq * 0.3);
      c.stroke();
      c.font = letter(p.m.fs * 0.85);
      c.textAlign = 'center';
      haloText(c, 'V₀', x, p.bottom - p.m.sq * 0.7, PAL.red);
    }

    // ----- (b) wind against current -----
    const q = this.ui;
    let uTop = 0.5;
    for (const r of sameKind) uTop = Math.max(uTop, r.u);
    for (const b of bench) if (Number.isFinite(b.u)) uTop = Math.max(uTop, b.u);
    if (live) uTop = Math.max(uTop, live.uBulk);
    if (cur) uTop = Math.max(uTop, idealSpeed((iMax * 0.6) / 1e6 / L, live.path, LY) * 0.9);
    const yb = axis(uTop * 1.05, Math.round((q.bottom - q.top) / q.m.sq));
    const yDivB = yb.n;
    const uMax = yb.max;
    const xb = axis(iMax, Math.round((q.right - q.left) / q.m.sq));
    const xDivB = xb.n;
    const ixMax = xb.max;
    q.frame(ixMax, xDivB, uMax, yDivB, 'I, µA', 'u, m/s', '(b)');
    const d = q.ctx;
    q.clip();
    const notesB = [];
    const uOf = (path) => (IuA) => idealSpeed(IuA / 1e6 / L, path, LY);
    // Number a rising curve where it leaves the frame: the top or the right edge.
    const exitNote = (g, note) => {
      if (g(ixMax) >= uMax) {
        let lo = 0, hi = ixMax;
        for (let it = 0; it < 30; it++) {
          const mid = (lo + hi) / 2;
          if (g(mid) > uMax) hi = mid; else lo = mid;
        }
        notesB.push({ ...note, x: q.px(lo), y: q.top - 4, align: 'center', group: 'top' });
      } else {
        notesB.push({ ...note, x: q.right + 3, y: q.py(g(ixMax)) + 4, align: 'left', group: 'right' });
      }
    };
    for (const f of family) {
      if (Math.abs(f.gap - st.gap) < 0.6 * H) continue;
      q.curve(uOf(f.path), 0, ixMax, { color: PAL.graphite, width: 0.9, dash: [4, 3] });
      exitNote(uOf(f.path), { text: `${Math.round(f.gap * 1000)}`, font: letter(fsSmall), color: PAL.graphite });
    }
    if (live) {
      const g = uOf(live.path);
      q.curve(g, 0, ixMax, { color: PAL.ink, width: 1.8 });
      // Lettered to the right of the curve, part way up.
      let Ilab = ixMax * 0.5;
      while (Ilab > ixMax * 0.05 && g(Ilab) > uMax * 0.78) Ilab *= 0.9;
      notesB.push({
        text: `lossless limit, d = ${(st.gap * 1000).toFixed(1)} mm`, font: letter(q.m.fs * 0.9), color: PAL.ink,
        x: q.px(Ilab) + 8, y: q.py(g(Ilab)) + 4, align: 'left', group: 'free',
      });
    }
    // The one fitted line on this figure: u = k sqrt(I) through the readings.
    const pts = sameKind.filter((r) => r.Iper > 0 && r.u > 0);
    let eta = null;
    if (pts.length >= 2) {
      let num = 0, den = 0, rat = 0;
      for (const r of pts) {
        const I = r.Iper * L * 1e6;
        num += Math.sqrt(I) * r.u;
        den += I;
        rat += r.u / idealSpeed(r.Iper, r.path, LY);
      }
      const k = num / den;
      eta = rat / pts.length;
      q.curve((I) => k * Math.sqrt(I), 0, ixMax, { color: PAL.ink, width: 1, dash: [1, 3] });
      const font = letter(q.m.fs * 0.9);
      const x = q.right - 4, y = q.py(k * Math.sqrt(ixMax)) + q.m.sq * 1.1;
      notesB.push({ text: `fit through the readings: u = ${k.toFixed(3)} √I`, font, color: PAL.ink, x, y, align: 'right', group: 'free' });
      notesB.push({ text: `${Math.round(eta * 100)} % of the lossless limit`, font, color: PAL.ink, x, y: y + q.m.fs * 1.2, align: 'right', group: 'free' });
    }
    for (const r of sameKind) {
      const onGap = Math.abs(r.gap - st.gap) < 0.6 * H;
      q.dot(r.Iper * L * 1e6, r.u, onGap ? 'ink' : 'ink-small');
    }
    for (const b of bench) if (Number.isFinite(b.u)) q.dot(b.I, b.u, 'bench');
    if (live && !st.steady) q.dot(live.Icoll * L * 1e6, live.uBulk, 'live');
    d.restore();
    letterNotes(q, notesB);
    return { eta, iMax };
  }
}

export { MU_ION };
