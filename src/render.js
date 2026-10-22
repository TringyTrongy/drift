// Fig. 1: the channel drawn in section on the ruling, with the solver's fields
// laid over it the way you would on paper: ink field lines, dashed graphite
// equipotentials, red pencil space charge and smoke tracers.

import {
  NX, NY, FX, FY, H, HF, LX, LY, EMITTER_X, EMITTER_Y, IE, JE,
  collectorShapes, collectorMask,
} from './geometry.js';
import { PAL, letter, haloText } from './ink.js';

const SLOWMO = 150; // smoke plays back at 1/150 of real speed

export class Fig1 {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.layers = { lines: true, equi: true, charge: true, smoke: true, speed: false };
    this.view = 'A';
    this.gap = 0.005;
    this.frame = null;
    this.fieldCache = null;
    this.fieldDirty = true;
    this.chargeImg = document.createElement('canvas');
    this.chargeImg.width = NX;
    this.chargeImg.height = NY;
    this.speedImg = document.createElement('canvas');
    this.speedImg.width = FX;
    this.speedImg.height = FY;
    this.wash = document.createElement('canvas');
    this.grain = document.createElement('canvas');
    this.statics = document.createElement('canvas');
    this.lineCanvas = document.createElement('canvas');
    this.hover = false;
  }

  // m: layout metrics from layout.js
  resize(m) {
    this.m = m;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = m.stageW * m.sq;
    this.h = m.stageH * m.sq;
    for (const c of [this.canvas, this.wash, this.grain, this.statics, this.lineCanvas]) {
      c.width = Math.round(this.w * dpr);
      c.height = Math.round(this.h * dpr);
    }
    this.ppm = m.mm * m.sq * 1000; // CSS px per metre
    this.top = (m.ruler + m.wall) * m.sq; // channel top edge
    this.chH = LY * this.ppm;
    this.dimY = this.top + this.chH + m.wall * m.sq + 1.3 * m.sq;
    this.makeGrain();
    this.drawStatics();
    this.fieldDirty = true;
    const target = Math.round((m.mode === 'narrow' ? 260 : 460) * Math.min(1, (this.w * this.chH) / (960 * 480)) + 80);
    this.seedParticles(target);
  }

  X(x) { return x * this.ppm; }
  Y(y) { return this.top + (LY - y) * this.ppm; }
  toWorld(px, py) { return [px / this.ppm, LY - (py - this.top) / this.ppm]; }

  setGeometry(view, gap) {
    if (view === this.view && Math.round(gap / H) === Math.round(this.gap / H) && this.mask) return;
    this.view = view;
    this.gap = gap;
    this.mask = collectorMask(view, gap);
    this.shapes = collectorShapes(view, gap);
    // Flow-cell solids at drawing resolution, for tracer respawns.
    this.drawStatics();
    this.fieldDirty = true;
    for (const p of this.particles) if (this.inSolid(p.x, p.y)) this.respawn(p, true);
  }

  inSolid(x, y) {
    if (!this.mask) return false;
    const i = Math.floor(x / H), j = Math.floor(y / H);
    if (i < 0 || j < 0 || i >= NX || j >= NY) return false;
    return this.mask[i + j * NX] === 1;
  }

  makeGrain() {
    const g = this.grain, c = g.getContext('2d');
    const img = c.createImageData(g.width, g.height);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < img.data.length; k += 4) {
      const v = rnd();
      img.data[k + 3] = v < 0.42 ? 255 * (0.35 + 0.65 * rnd()) : 0;
    }
    c.putImageData(img, 0, 0);
  }

  // Ruler, walls, collector: redrawn only when the layout or geometry changes.
  drawStatics() {
    if (!this.m) return;
    const c = this.statics.getContext('2d');
    const { dpr, m } = this;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    const sq = m.sq;

    // Millimetre scale along the top.
    c.strokeStyle = PAL.ink;
    c.fillStyle = PAL.ink;
    c.lineWidth = 1;
    const base = m.ruler * sq - 1;
    c.beginPath();
    c.moveTo(0, base + 0.5);
    c.lineTo(this.X(LX), base + 0.5);
    for (let mmv = 0; mmv <= 24; mmv++) {
      const x = Math.round(this.X(mmv / 1000)) + 0.5;
      const len = mmv % 5 === 0 ? sq * 0.42 : sq * 0.2;
      c.moveTo(x, base);
      c.lineTo(x, base - len);
    }
    c.stroke();
    c.font = letter(Math.min(m.fs * 0.78, sq * 0.7));
    c.textBaseline = 'alphabetic';
    const labelY = base - Math.max(sq * 0.5, 3);
    for (let mmv = 5; mmv < 24; mmv += 5) {
      c.textAlign = 'center';
      c.fillText(String(mmv), this.X(mmv / 1000), labelY);
    }
    c.textAlign = 'left';
    c.fillText('mm', this.X(0) + 3, labelY);

    // Channel walls in section.
    const wallH = m.wall * sq;
    this.hatchRect(c, 0, this.top - wallH, this.X(LX), wallH);
    this.hatchRect(c, 0, this.top + this.chH, this.X(LX), wallH);
    c.lineWidth = 1.6;
    c.strokeStyle = PAL.ink;
    c.beginPath();
    c.moveTo(0, this.top);
    c.lineTo(this.X(LX), this.top);
    c.moveTo(0, this.top + this.chH);
    c.lineTo(this.X(LX), this.top + this.chH);
    c.stroke();

    // Collector.
    if (this.shapes) {
      for (const poly of this.shapes) {
        c.save();
        c.beginPath();
        poly.forEach(([x, y], n) => (n ? c.lineTo(this.X(x), this.Y(y)) : c.moveTo(this.X(x), this.Y(y))));
        c.closePath();
        c.fillStyle = PAL.paper;
        c.fill();
        c.clip();
        this.hatchLines(c, this.boundsOf(poly));
        c.restore();
        c.beginPath();
        poly.forEach(([x, y], n) => (n ? c.lineTo(this.X(x), this.Y(y)) : c.moveTo(this.X(x), this.Y(y))));
        c.closePath();
        c.lineWidth = 1.5;
        c.strokeStyle = PAL.ink;
        c.stroke();
      }
    }
  }

  boundsOf(poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) {
      x0 = Math.min(x0, this.X(x)); x1 = Math.max(x1, this.X(x));
      y0 = Math.min(y0, this.Y(y)); y1 = Math.max(y1, this.Y(y));
    }
    return [x0, y0, x1 - x0, y1 - y0];
  }

  hatchRect(c, x, y, w, h) {
    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
    this.hatchLines(c, [x, y, w, h]);
    c.restore();
  }

  hatchLines(c, [x, y, w, h]) {
    const step = Math.max(4, this.m.sq * 0.28);
    c.strokeStyle = PAL.ink;
    c.lineWidth = 0.8;
    c.beginPath();
    for (let s = x - h; s < x + w + h; s += step) {
      c.moveTo(s, y + h);
      c.lineTo(s + h, y);
    }
    c.stroke();
  }

  // --- tracers -----------------------------------------------------------------

  seedParticles(n) {
    this.particles = [];
    for (let k = 0; k < n; k++) {
      const p = { x: 0, y: 0, tx: new Float32Array(5), ty: new Float32Array(5), n: 0, age: 0 };
      this.respawn(p, true);
      this.particles.push(p);
    }
  }

  respawn(p, anywhere) {
    for (let tries = 0; tries < 20; tries++) {
      if (anywhere) {
        p.x = Math.random() * LX;
        p.y = Math.random() * LY;
      } else {
        // Enter at the inlet in proportion to the inflow there.
        p.x = Math.random() * HF * 0.5;
        p.y = Math.random() * LY;
        const u = this.frame ? this.sampleVel(p.x + HF, p.y)[0] : 0;
        if (u <= 0 || Math.random() * this.inletPeak > u) continue;
      }
      if (!this.inSolid(p.x, p.y)) break;
    }
    p.n = 0;
    p.age = 0;
  }

  sampleVel(x, y) {
    const f = this.frame;
    if (!f) return [0, 0];
    let gx = x / HF - 0.5, gy = y / HF - 0.5;
    gx = Math.min(FX - 1.001, Math.max(0, gx));
    gy = Math.min(FY - 1.001, Math.max(0, gy));
    const i = Math.floor(gx), j = Math.floor(gy), tx = gx - i, ty = gy - j;
    const k = i + j * FX;
    const U = f.uc, V = f.vc;
    const u = (U[k] * (1 - tx) + U[k + 1] * tx) * (1 - ty) + (U[k + FX] * (1 - tx) + U[k + FX + 1] * tx) * ty;
    const v = (V[k] * (1 - tx) + V[k + 1] * tx) * (1 - ty) + (V[k + FX] * (1 - tx) + V[k + FX + 1] * tx) * ty;
    return [u, v];
  }

  stepParticles(dtWall) {
    if (!this.frame) return;
    const dt = Math.min(dtWall, 1 / 30) / SLOWMO;
    // Inlet profile peak for weighted respawns.
    let peak = 1e-6;
    for (let J = 0; J < FY; J++) peak = Math.max(peak, this.frame.uc[1 + J * FX]);
    this.inletPeak = peak;
    const moving = peak > 0.02;
    for (const p of this.particles) {
      // Shift the trail.
      for (let k = Math.min(p.n, 4); k > 0; k--) { p.tx[k] = p.tx[k - 1]; p.ty[k] = p.ty[k - 1]; }
      p.tx[0] = p.x;
      p.ty[0] = p.y;
      if (p.n < 5) p.n++;
      const [u1, v1] = this.sampleVel(p.x, p.y);
      const [u2, v2] = this.sampleVel(p.x + 0.5 * dt * u1, p.y + 0.5 * dt * v1);
      p.x += dt * u2;
      p.y += dt * v2;
      p.age++;
      if (p.y < 0) p.y = 0;
      if (p.y > LY) p.y = LY;
      if (p.x > LX || p.x < 0 || this.inSolid(p.x, p.y)) this.respawn(p, !moving);
    }
  }

  // --- fields ------------------------------------------------------------------

  setFrame(f) {
    this.frame = f;
    this.fieldDirty = true;
  }

  drawCharge(c) {
    const f = this.frame;
    const rho = f.rho;
    let rmax = 0;
    for (let k = 0; k < rho.length; k++) if (rho[k] > rmax) rmax = rho[k];
    if (rmax <= 0) return;
    const ctx = this.chargeImg.getContext('2d');
    const img = ctx.createImageData(NX, NY);
    const span = 2.5;
    const lo = Math.log10(rmax) - span;
    const [r, g, b] = PAL.redRGB;
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const v = rho[i + j * NX];
        if (v <= 0) continue;
        const a = Math.min(1, Math.max(0, (Math.log10(v) - lo) / span));
        if (a <= 0) continue;
        const o = (i + (NY - 1 - j) * NX) * 4;
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b;
        img.data[o + 3] = 255 * 0.6 * a * a;
      }
    }
    ctx.putImageData(img, 0, 0);
    const w = this.wash.getContext('2d');
    w.setTransform(1, 0, 0, 1, 0, 0);
    w.clearRect(0, 0, this.wash.width, this.wash.height);
    w.imageSmoothingEnabled = true;
    w.drawImage(this.chargeImg, 0, this.top * this.dpr, this.X(LX) * this.dpr, this.chH * this.dpr);
    w.globalCompositeOperation = 'destination-out';
    w.globalAlpha = 0.55;
    w.drawImage(this.grain, 0, 0);
    w.globalAlpha = 1;
    w.globalCompositeOperation = 'source-over';
    c.drawImage(this.wash, 0, 0, this.w, this.h);
  }

  drawSpeed(c) {
    const f = this.frame;
    let umax = 0.5;
    for (let k = 0; k < f.uc.length; k++) umax = Math.max(umax, Math.hypot(f.uc[k], f.vc[k]));
    const ctx = this.speedImg.getContext('2d');
    const img = ctx.createImageData(FX, FY);
    const [r, g, b] = PAL.printRGB;
    for (let J = 0; J < FY; J++) {
      for (let I = 0; I < FX; I++) {
        const k = I + J * FX;
        const s = Math.hypot(f.uc[k], f.vc[k]) / umax;
        const o = (I + (FY - 1 - J) * FX) * 4;
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b;
        img.data[o + 3] = 255 * 0.5 * s * s;
      }
    }
    ctx.putImageData(img, 0, 0);
    c.imageSmoothingEnabled = true;
    c.drawImage(this.speedImg, 0, this.top, this.X(LX), this.chH);
  }

  phiAt(gx, gy) {
    const phi = this.frame.phi;
    gx = Math.min(NX - 1.001, Math.max(0, gx));
    gy = Math.min(NY - 1.001, Math.max(0, gy));
    const i = Math.floor(gx), j = Math.floor(gy), tx = gx - i, ty = gy - j;
    const k = i + j * NX;
    return (phi[k] * (1 - tx) + phi[k + 1] * tx) * (1 - ty) + (phi[k + NX] * (1 - tx) + phi[k + NX + 1] * tx) * ty;
  }

  // Field lines from the wire, traced along E in cell units, and equipotentials
  // by marching squares; both cached until the next solver frame.
  rebuildFieldLines() {
    const c = this.lineCanvas.getContext('2d');
    const { dpr } = this;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    const f = this.frame;
    const px = (gx) => this.X((gx + 0.5) * H);
    const py = (gy) => this.Y((gy + 0.5) * H);

    if (this.layers.equi) {
      const phi = f.phi;
      const top = f.s.phiE;
      c.strokeStyle = PAL.graphite;
      c.lineWidth = 0.9;
      c.setLineDash([3.5, 3]);
      c.beginPath();
      const levels = 11;
      for (let n = 1; n <= levels; n++) {
        const L = (top * n) / (levels + 1);
        for (let j = 0; j < NY - 1; j++) {
          for (let i = 0; i < NX - 1; i++) {
            const k = i + j * NX;
            const a = phi[k] - L, b = phi[k + 1] - L, cc = phi[k + NX + 1] - L, d = phi[k + NX] - L;
            const idx = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (cc > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
            if (idx === 0 || idx === 15) continue;
            if (this.mask[k] || this.mask[k + 1] || this.mask[k + NX] || this.mask[k + NX + 1]) continue;
            const e = [];
            if ((idx & 1) !== (idx & 2) >> 1) e.push([i + a / (a - b), j]);
            if (((idx & 2) >> 1) !== ((idx & 4) >> 2)) e.push([i + 1, j + b / (b - cc)]);
            if (((idx & 4) >> 2) !== ((idx & 8) >> 3)) e.push([i + 1 - cc / (cc - d), j + 1]);
            if (((idx & 8) >> 3) !== (idx & 1)) e.push([i, j + 1 - d / (d - a)]);
            for (let q = 0; q + 1 < e.length; q += 2) {
              c.moveTo(px(e[q][0]), py(e[q][1]));
              c.lineTo(px(e[q + 1][0]), py(e[q + 1][1]));
            }
          }
        }
      }
      c.stroke();
      c.setLineDash([]);
    }

    if (this.layers.lines) {
      const N = 30;
      c.strokeStyle = PAL.ink;
      c.lineWidth = 0.9;
      c.globalAlpha = 0.85;
      const arrows = [];
      for (let n = 0; n < N; n++) {
        const ang = ((n + 0.5) / N) * Math.PI * 2;
        let gx = IE + 1.6 * Math.cos(ang), gy = JE + 1.6 * Math.sin(ang);
        c.beginPath();
        c.moveTo(px(gx), py(gy));
        let len = 0;
        let arrowAt = null;
        for (let s = 0; s < 1600; s++) {
          const ex = -(this.phiAt(gx + 0.5, gy) - this.phiAt(gx - 0.5, gy));
          const ey = -(this.phiAt(gx, gy + 0.5) - this.phiAt(gx, gy - 0.5));
          const mag = Math.hypot(ex, ey);
          if (mag < 1e-6) break;
          const st = 0.45;
          gx += (st * ex) / mag;
          gy += (st * ey) / mag;
          len += st;
          if (gx < 0 || gy < 0 || gx > NX - 1 || gy > NY - 1) break;
          c.lineTo(px(gx), py(gy));
          if (!arrowAt && len > 22) arrowAt = [gx, gy, ex, ey];
          const ci = Math.round(gx), cj = Math.round(gy);
          if (this.mask[ci + cj * NX]) break;
        }
        c.stroke();
        if (arrowAt) arrows.push(arrowAt);
      }
      c.globalAlpha = 1;
      c.fillStyle = PAL.ink;
      for (const [gx, gy, ex, ey] of arrows) {
        const a = Math.atan2(-ey, ex);
        const x = px(gx), y = py(gy), s = 4.2;
        c.beginPath();
        c.moveTo(x + s * Math.cos(a), y + s * Math.sin(a));
        c.lineTo(x + s * Math.cos(a + 2.6), y + s * Math.sin(a + 2.6));
        c.lineTo(x + s * Math.cos(a - 2.6), y + s * Math.sin(a - 2.6));
        c.closePath();
        c.fill();
      }
    }
    this.fieldDirty = false;
  }

  // --- the frame ----------------------------------------------------------------

  draw(state) {
    const c = this.ctx;
    const { dpr, m } = this;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    const f = this.frame;
    if (f) {
      c.save();
      c.beginPath();
      c.rect(0, this.top, this.X(LX), this.chH);
      c.clip();
      if (this.layers.speed) this.drawSpeed(c);
      if (this.layers.charge) this.drawCharge(c);
      if (this.fieldDirty) this.rebuildFieldLines();
      c.drawImage(this.lineCanvas, 0, 0, this.w, this.h);
      if (this.layers.smoke) this.drawSmoke(c);
      c.restore();
    }
    c.drawImage(this.statics, 0, 0, this.w, this.h);
    this.drawWire(c, state);
    this.drawDimension(c, state);
    this.drawLabels(c, state);
  }

  drawSmoke(c) {
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = PAL.graphite;
    c.lineWidth = 0.85;
    c.globalAlpha = 0.38;
    c.beginPath();
    for (const p of this.particles) {
      const x = this.X(p.x), y = this.Y(p.y);
      c.moveTo(x, y);
      if (p.n <= 1) {
        c.lineTo(x + 0.6, y);
        continue;
      }
      for (let k = 0; k < p.n; k++) c.lineTo(this.X(p.tx[k]), this.Y(p.ty[k]));
    }
    c.stroke();
    c.globalAlpha = 1;
  }

  drawWire(c, state) {
    const x = this.X(EMITTER_X), y = this.Y(EMITTER_Y);
    const sq = this.m.sq;
    if (state.corona) {
      c.strokeStyle = PAL.red;
      c.lineWidth = 1.4;
      c.beginPath();
      c.arc(x, y, sq * 0.42, 0, Math.PI * 2);
      c.stroke();
      // Short red pencil rays: the ionisation sheath.
      c.lineWidth = 1.1;
      c.beginPath();
      for (let n = 0; n < 12; n++) {
        const a = (n / 12) * Math.PI * 2 + 0.13;
        c.moveTo(x + Math.cos(a) * sq * 0.5, y + Math.sin(a) * sq * 0.5);
        c.lineTo(x + Math.cos(a) * sq * 0.72, y + Math.sin(a) * sq * 0.72);
      }
      c.stroke();
    }
    c.fillStyle = PAL.ink;
    c.beginPath();
    c.arc(x, y, Math.max(2.2, sq * 0.13), 0, Math.PI * 2);
    c.fill();
  }

  collectorLead() {
    // x of the collector's leading face, m
    return EMITTER_X + Math.round(this.gap / H) * H - 0.5 * H;
  }

  drawDimension(c, state) {
    const sq = this.m.sq;
    const xe = this.X(EMITTER_X), xc = this.X(this.collectorLead());
    const y = this.dimY;
    const y0 = this.top + this.chH + this.m.wall * sq + 2;
    c.strokeStyle = PAL.ink;
    c.fillStyle = PAL.ink;
    c.lineWidth = 0.9;
    c.beginPath();
    c.moveTo(xe + 0.5, y0);
    c.lineTo(xe + 0.5, y + sq * 0.35);
    c.moveTo(xc + 0.5, y0);
    c.lineTo(xc + 0.5, y + sq * 0.35);
    c.moveTo(xe, y);
    c.lineTo(xc, y);
    c.stroke();
    const head = (x, dir) => {
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + dir * 7, y - 2.4);
      c.lineTo(x + dir * 7, y + 2.4);
      c.closePath();
      c.fill();
    };
    head(xe + 0.5, 1);
    head(xc + 0.5, -1);
    c.font = letter(this.m.fs);
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    const label = `d = ${(state.gap * 1000).toFixed(1)}`;
    haloText(c, label, (xe + xc) / 2, y - sq * 0.28, PAL.ink);
    // Drag grip on the collector side.
    c.fillStyle = this.hover || state.dragging ? PAL.red : PAL.graphite;
    // Grip beside the collector-side arrowhead.
    const gx = xc + 12;
    c.beginPath();
    c.moveTo(gx, y); c.lineTo(gx + 6, y - 4); c.lineTo(gx + 6, y + 4); c.closePath();
    c.moveTo(gx + 16, y); c.lineTo(gx + 10, y - 4); c.lineTo(gx + 10, y + 4); c.closePath();
    c.fill();
  }

  drawLabels(c, state) {
    const sq = this.m.sq;
    const fs = this.m.fs;
    c.font = letter(fs);
    c.textBaseline = 'alphabetic';
    const xe = this.X(EMITTER_X), ye = this.Y(EMITTER_Y);
    const narrow = this.m.mode === 'narrow';

    // Wire label with a leader.
    const lx = narrow ? sq * 0.4 : this.X(0.0008), ly = this.top + sq * (narrow ? 1.1 : 1.6);
    c.strokeStyle = PAL.ink;
    c.lineWidth = 0.9;
    c.beginPath();
    c.moveTo(xe - 3, ye - 3);
    c.lineTo(lx + sq * 2.4, ly + sq * 0.35);
    c.lineTo(lx, ly + sq * 0.35);
    c.stroke();
    c.textAlign = 'left';
    const kv = (state.V / 1000).toFixed(1);
    haloText(c, `wire +${kv} kV`, lx, ly, PAL.ink);
    if (state.corona) {
      haloText(c, 'corona on', lx, ly + sq * (narrow ? 1.6 : 1.3) , PAL.red, letter(fs * 0.9));
    } else {
      haloText(c, 'below onset', lx, ly + sq * (narrow ? 1.6 : 1.3), PAL.graphite, letter(fs * 0.9));
    }

    // Collector label.
    if (this.shapes && !narrow) {
      const [bx, by, bw] = this.boundsOf(this.shapes[0]);
      const tx = Math.min(bx + bw + sq * 0.6, this.X(LX) - sq * 7.5);
      const ty = this.top + sq * 1.6;
      c.strokeStyle = PAL.ink;
      c.lineWidth = 0.9;
      c.beginPath();
      c.moveTo(bx + bw * 0.7, by + 2);
      c.lineTo(tx - 4, ty + sq * 0.35);
      c.lineTo(tx + sq * 6.4, ty + sq * 0.35);
      c.stroke();
      c.textAlign = 'left';
      haloText(c, 'collector, 0 V', tx, ty, PAL.ink);
    }

    // Outlet speed.
    const u = state.uBulk;
    const ox = this.X(LX) - sq * 0.4, oy = this.top + this.chH - sq * 0.7;
    c.textAlign = 'right';
    const col = state.steady ? PAL.ink : PAL.graphite;
    // A drawn flow arrow, then the reading lettered before it.
    const ax = ox - sq * 1.1, ay = oy - fs * 0.32;
    c.strokeStyle = col;
    c.fillStyle = col;
    c.lineWidth = 1.2;
    c.beginPath();
    c.moveTo(ax, ay);
    c.lineTo(ox - 6, ay);
    c.stroke();
    c.beginPath();
    c.moveTo(ox, ay);
    c.lineTo(ox - 7, ay - 2.6);
    c.lineTo(ox - 7, ay + 2.6);
    c.closePath();
    c.fill();
    haloText(c, `u = ${u.toFixed(2)} m/s`, ax - 5, oy, col);
  }

  // Pointer hit test for dragging the collector: returns true when (px, py) is on
  // the collector or its dimension grip.
  hit(px, py) {
    const sq = this.m.sq;
    const xc = this.X(this.collectorLead());
    if (Math.abs(py - this.dimY) < sq * 0.8 && px > xc - sq * 0.6 && px < xc + sq * 1.6) return true;
    if (!this.shapes) return false;
    for (const poly of this.shapes) {
      const [x, y, w, h] = this.boundsOf(poly);
      if (px > x - 6 && px < x + w + 6 && py > y - 6 && py < y + h + 6) return true;
    }
    return false;
  }
}
