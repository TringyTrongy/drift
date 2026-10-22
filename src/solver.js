// Drift's coupled solver. SI units throughout.
//
//   1. Electrostatics with space charge. The potential is split into a unit
//      Laplace solution L (wire at 1, collector at 0) and a space-charge part P
//      (all conductors at 0):  phi = phi_e * L + P.
//   2. A sub-grid wire. The wire (tens of micrometres) is far thinner than a
//      cell, so it is one cell whose value is the potential at Peaceman's
//      equivalent radius r0 = e^(-pi/2) h. The real surface sits ln(r0/rw)
//      further in, which fixes the wire's line charge and surface field.
//   3. Kaptzov's hypothesis. Once the surface field reaches Peek's onset value,
//      ions are injected at whatever rate holds it there.
//   4. Steady unipolar drift. Ions move down the potential at mu*E, so one sweep
//      in order of falling potential solves the steady upwind charge balance
//      exactly for the current field.
//   5. Air. Incompressible Navier-Stokes on a staggered grid, pushed by rho*E.

import {
  NX, NY, H, FX, FY, HF, IE, JE, LY,
  collectorMask, flowSolid, ionPath,
} from './geometry.js';
import { Poisson, UNKNOWN, DIRICHLET, INACTIVE } from './poisson.js';
import { peekField, EPS0, MU_ION, RHO_AIR, NU_AIR } from './model.js';

const R0 = Math.exp(-Math.PI / 2) * H; // Peaceman equivalent radius
const KE = IE + JE * NX; // emitter cell index
const BC_FIELD = { left: 'N', right: 'N', bottom: 'N', top: 'N' };

// Conjugate gradient in short restarts until the residual norm drops below `tol`
// (for the unit Laplace problem, 300 V/m^2 pins the wire charge to about 1e-5).
function solveTo(p, tol, maxIters = 140) {
  for (let done = 0; done < maxIters; done += 10) {
    if (p.solve(10) < tol) break;
  }
}

function fieldTypes(mask) {
  const t = new Uint8Array(NX * NY);
  for (let k = 0; k < NX * NY; k++) t[k] = mask[k] ? DIRICHLET : UNKNOWN;
  t[KE] = DIRICHLET;
  return t;
}

// The wire's charge per metre at 1 V with no space charge, and the shortest ion
// path, for a geometry: all the model needs to draw a Townsend curve.
export function unitLaplace(view, gap, warm) {
  const mask = collectorMask(view, gap);
  const p = new Poisson(NX, NY, H, fieldTypes(mask), BC_FIELD);
  if (warm) p.x.set(warm);
  for (let k = 0; k < NX * NY; k++) if (p.type[k] === DIRICHLET) p.x[k] = 0;
  p.x[KE] = 1;
  solveTo(p, 300);
  const x = p.x;
  return { lambdaL: EPS0 * (4 - (x[KE - 1] + x[KE + 1] + x[KE - NX] + x[KE + NX])), path: ionPath(mask), x };
}

export class Solver {
  constructor(opts = {}) {
    this.V = opts.V ?? 9000;
    this.gap = opts.gap ?? 0.005;
    this.view = opts.view ?? 'A';
    this.rw = opts.rw ?? 25e-6;
    this.mu = opts.mu ?? MU_ION;

    this.phi = new Float64Array(NX * NY);
    this.rho = new Float64Array(NX * NY);
    this.rhoNew = new Float64Array(NX * NY);
    this.Ex = new Float64Array(NX * NY);
    this.Ey = new Float64Array(NX * NY);
    this.keys = new Float64Array(NX * NY);
    this.order = new Uint32Array(NX * NY);
    this.nOrder = 0;

    // Flow (staggered): u on vertical faces, v on horizontal faces.
    this.u = new Float64Array((FX + 1) * FY);
    this.v = new Float64Array(FX * (FY + 1));
    this.u2 = new Float64Array((FX + 1) * FY);
    this.v2 = new Float64Array(FX * (FY + 1));
    this.fx = new Float64Array(FX * FY);
    this.fy = new Float64Array(FX * FY);

    this.J = 0; // injected current per metre of wire, A/m
    this.Icoll = 0; // collected current per metre, A/m
    this.lambdaP = 0;
    this.time = 0; // simulated seconds of flow
    this.buildGeometry();
  }

  // --- geometry -----------------------------------------------------------

  buildGeometry() {
    this.mask = collectorMask(this.view, this.gap);
    this.solid = flowSolid(this.mask);
    this.path = ionPath(this.mask);

    const t = fieldTypes(this.mask);
    const bcE = BC_FIELD;
    const prevL = this.lap ? this.lap.fine.x : null;
    const prevP = this.pois ? this.pois.fine.x : null;
    this.lap = new Poisson(NX, NY, H, t, bcE);
    this.pois = new Poisson(NX, NY, H, t.slice(), bcE);
    if (prevL) this.lap.fine.x.set(prevL);
    if (prevP) this.pois.fine.x.set(prevP);
    for (let k = 0; k < NX * NY; k++) {
      if (t[k] === DIRICHLET) { this.lap.fine.x[k] = 0; this.pois.fine.x[k] = 0; }
    }
    this.lap.fine.x[KE] = 1;
    this.lap.fine.b.fill(0);
    solveTo(this.lap, 300);

    // Conductor cells hold no space charge.
    for (let k = 0; k < NX * NY; k++) if (t[k] === DIRICHLET) this.rho[k] = 0;

    // Flow grid: solids carry no velocity.
    const tp = new Uint8Array(FX * FY);
    for (let k = 0; k < FX * FY; k++) tp[k] = this.solid[k] ? INACTIVE : UNKNOWN;
    const prevPr = this.press ? this.press.fine.x : null;
    this.press = new Poisson(FX, FY, HF, tp, { left: 'D', right: 'D', bottom: 'N', top: 'N' });
    if (prevPr) this.press.fine.x.set(prevPr);
    this.zeroSolidFaces();

    this.lambdaL = EPS0 * (4 - this.nbSum(this.lap.fine.x));
    this.order.fill(0);
    this.nOrder = 0;
    this.sortCountdown = 0;
  }

  nbSum(x) {
    return x[KE - 1] + x[KE + 1] + x[KE - NX] + x[KE + NX];
  }

  setParams({ V, gap, view, rw }) {
    let geo = false;
    if (V !== undefined) this.V = V;
    if (rw !== undefined) this.rw = rw;
    if (gap !== undefined && Math.round(gap / H) !== Math.round(this.gap / H)) { this.gap = gap; geo = true; }
    if (view !== undefined && view !== this.view) { this.view = view; geo = true; }
    if (geo) this.buildGeometry();
  }

  resetFlow() {
    this.u.fill(0);
    this.v.fill(0);
    this.press.fine.x.fill(0);
    this.time = 0;
  }

  // --- the wire -------------------------------------------------------------

  get Ep() {
    return peekField(this.rw);
  }
  // Line charge that puts Peek's field on the wire surface.
  get lambdaC() {
    return 2 * Math.PI * EPS0 * this.rw * this.Ep;
  }
  // Peaceman coefficient: cell potential = surface potential - k * lambda.
  get kWire() {
    return Math.log(R0 / this.rw) / (2 * Math.PI * EPS0);
  }
  // Capacitance per metre of the real wire in this geometry.
  get capacitance() {
    return this.lambdaL / (1 + this.kWire * this.lambdaL);
  }
  get onsetVoltage() {
    return this.lambdaC / this.capacitance;
  }
  // Wire line charge with the present space charge.
  get lambda() {
    return (this.lambdaL * this.V + this.lambdaP) / (1 + this.kWire * this.lambdaL);
  }
  get surfaceField() {
    return this.lambda / (2 * Math.PI * EPS0 * this.rw);
  }
  get corona() {
    return this.V > this.onsetVoltage;
  }

  // --- electrostatics and ions ----------------------------------------------

  composePhi() {
    const phiE = this.V - this.kWire * this.lambda;
    const L = this.lap.fine.x, P = this.pois.fine.x, phi = this.phi;
    for (let k = 0; k < NX * NY; k++) phi[k] = phiE * L[k] + P[k];
    this.phiE = phiE;
  }

  // Order air cells by falling potential. Keys pack a quantised potential above
  // the cell index in one float so the native numeric sort does the work.
  sortByPotential() {
    const phi = this.phi, keys = this.keys, mask = this.mask;
    const top = this.phiE;
    const span = Math.max(1, top);
    const Q = 2 ** 36;
    let n = 0;
    for (let k = 0; k < NX * NY; k++) {
      if (mask[k] || k === KE) continue;
      const q = Math.floor(Math.min(1, Math.max(0, (top - phi[k]) / span)) * (Q - 1));
      keys[n++] = q * 32768 + k;
    }
    const sorted = keys.subarray(0, n).sort();
    for (let m = 0; m < n; m++) this.order[m] = sorted[m] % 32768;
    this.nOrder = n;
  }

  // Steady upwind balance for every air cell, in order of falling potential:
  //   rho_i * sum_out mu (phi_i - phi_j) = sum_in rho_j mu (phi_j - phi_i) + S_i
  sweepIons() {
    const phi = this.phi, rn = this.rhoNew, mask = this.mask, mu = this.mu;
    rn.fill(0);
    // Injection into the wire's four neighbours, shared by outward flux (A/m).
    const nbs = [KE - 1, KE + 1, KE - NX, KE + NX];
    const src = [0, 0, 0, 0];
    let fsum = 0;
    for (const k of nbs) fsum += Math.max(0, this.phiE - phi[k]);
    if (this.J > 0 && fsum > 0) {
      for (let n = 0; n < 4; n++) src[n] = (this.J * Math.max(0, this.phiE - phi[nbs[n]])) / fsum;
    }
    let collected = 0;
    const order = this.order;
    for (let m = 0; m < this.nOrder; m++) {
      const k = order[m];
      const i = k % NX, j = (k - i) / NX;
      const p = phi[k];
      // Balance in units of charge density times volts (the mobility divides out).
      const s = nbs.indexOf(k);
      let inflow = s >= 0 ? src[s] / mu : 0;
      let out = 0, toCollector = 0;
      // Domain edges are insulating: no flux through them.
      for (let n = 0; n < 4; n++) {
        let q;
        if (n === 0) { if (i === 0) continue; q = k - 1; }
        else if (n === 1) { if (i === NX - 1) continue; q = k + 1; }
        else if (n === 2) { if (j === 0) continue; q = k - NX; }
        else { if (j === NY - 1) continue; q = k + NX; }
        if (q === KE) continue;
        const d = p - phi[q];
        if (d > 0) { out += d; if (mask[q]) toCollector += d; }
        else if (!mask[q]) inflow -= rn[q] * d;
      }
      const rho = out > 1e-9 ? inflow / out : 0;
      rn[k] = rho;
      collected += mu * rho * toCollector;
    }
    this.Icoll = collected;
  }

  // Charge induced on the grounded wire by a charge distribution, by Green's
  // reciprocity: lambda_P = -sum(rho * L) h^2, with L the unit Laplace solution.
  inducedCharge(rho) {
    const L = this.lap.fine.x;
    let s = 0;
    for (let m = 0; m < this.nOrder; m++) {
      const k = this.order[m];
      s += rho[k] * L[k];
    }
    return -s * H * H;
  }

  // Kaptzov's condition, solved directly. For the present field the swept
  // charge is proportional to the injected current, so the induced charge per
  // unit current fixes the current that pins the surface field at Peek's value.
  stepElectro(iters = 3) {
    const k = this.kWire, lL = this.lambdaL;
    const rho = this.rho, rn = this.rhoNew;
    for (let it = 0; it < iters; it++) {
      this.composePhi();
      if (this.sortCountdown-- <= 0) { this.sortByPotential(); this.sortCountdown = 2; }
      const lambdaLap = (lL * this.V) / (1 + k * lL);
      let Jt = 0;
      let collectedPerAmp = 0;
      if (lambdaLap > this.lambdaC) {
        const J = this.J;
        this.J = 1; // unit injection, A/m
        this.sweepIons();
        this.J = J;
        collectedPerAmp = this.Icoll;
        const perAmp = this.inducedCharge(rn); // < 0
        const target = this.lambdaC * (1 + k * lL) - lL * this.V; // required lambda_P (< 0)
        Jt = perAmp < 0 ? target / perAmp : 0;
      } else {
        rn.fill(0);
      }
      this.J += 0.6 * (Jt - this.J);
      if (Jt === 0 && this.J < 1e-9) this.J = 0;
      this.Icoll = this.J * collectedPerAmp;
      for (let m = 0; m < this.nOrder; m++) {
        const q = this.order[m];
        rho[q] += 0.6 * (this.J * rn[q] - rho[q]);
      }
      const b = this.pois.fine.b;
      for (let q = 0; q < NX * NY; q++) b[q] = -rho[q] / EPS0;
      this.pois.solve(1);
      this.lambdaP = this.inducedCharge(rho);
    }
    this.composePhi();
    this.computeField();
  }

  computeField() {
    const phi = this.phi, Ex = this.Ex, Ey = this.Ey;
    const inv2h = 1 / (2 * H), invh = 1 / H;
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const k = i + j * NX;
        Ex[k] = i === 0 ? -(phi[k + 1] - phi[k]) * invh : i === NX - 1 ? -(phi[k] - phi[k - 1]) * invh : -(phi[k + 1] - phi[k - 1]) * inv2h;
        Ey[k] = j === 0 ? -(phi[k + NX] - phi[k]) * invh : j === NY - 1 ? -(phi[k] - phi[k - NX]) * invh : -(phi[k + NX] - phi[k - NX]) * inv2h;
      }
    }
  }

  // --- air ------------------------------------------------------------------

  // Body force rho*E, averaged onto flow cells (N/m^3).
  gatherForce() {
    const { rho, Ex, Ey, fx, fy } = this;
    for (let J = 0; J < FY; J++) {
      for (let I = 0; I < FX; I++) {
        const k = 2 * I + 2 * J * NX;
        let sx = 0, sy = 0;
        for (const q of [k, k + 1, k + NX, k + NX + 1]) {
          sx += rho[q] * Ex[q];
          sy += rho[q] * Ey[q];
        }
        fx[I + J * FX] = sx / 4;
        fy[I + J * FX] = sy / 4;
      }
    }
  }

  zeroSolidFaces() {
    const { u, v, solid } = this;
    for (let J = 0; J < FY; J++) {
      for (let I = 0; I <= FX; I++) {
        const a = I > 0 && solid[I - 1 + J * FX];
        const b = I < FX && solid[I + J * FX];
        if (a || b) u[I + J * (FX + 1)] = 0;
      }
    }
    for (let J = 0; J <= FY; J++) {
      for (let I = 0; I < FX; I++) {
        const a = J > 0 && solid[I + (J - 1) * FX];
        const b = J < FY && solid[I + J * FX];
        if (a || b || J === 0 || J === FY) v[I + J * FX] = 0;
      }
    }
  }

  sampleU(x, y) {
    // u lives at (I*HF, (J+0.5)*HF)
    let fxp = x / HF, fyp = y / HF - 0.5;
    fxp = Math.min(FX, Math.max(0, fxp));
    fyp = Math.min(FY - 1, Math.max(0, fyp));
    const i = Math.min(FX - 1, Math.floor(fxp)), j = Math.min(FY - 2, Math.floor(fyp));
    const tx = fxp - i, ty = fyp - j;
    const W = FX + 1, u = this.u;
    const a = u[i + j * W], b = u[i + 1 + j * W], c = u[i + (j + 1) * W], d = u[i + 1 + (j + 1) * W];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  sampleV(x, y) {
    // v lives at ((I+0.5)*HF, J*HF)
    let fxp = x / HF - 0.5, fyp = y / HF;
    fxp = Math.min(FX - 1, Math.max(0, fxp));
    fyp = Math.min(FY, Math.max(0, fyp));
    const i = Math.min(FX - 2, Math.floor(fxp)), j = Math.min(FY - 1, Math.floor(fyp));
    const tx = fxp - i, ty = fyp - j;
    const v = this.v;
    const a = v[i + j * FX], b = v[i + 1 + j * FX], c = v[i + (j + 1) * FX], d = v[i + 1 + (j + 1) * FX];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  stepFlow(dt) {
    const { u, v, u2, v2, fx, fy, solid } = this;
    const W = FX + 1;
    const LXf = FX * HF, LYf = FY * HF;

    // Body force.
    for (let J = 0; J < FY; J++) {
      for (let I = 1; I < FX; I++) {
        u[I + J * W] += (dt * 0.5 * (fx[I - 1 + J * FX] + fx[I + J * FX])) / RHO_AIR;
      }
    }
    for (let J = 1; J < FY; J++) {
      for (let I = 0; I < FX; I++) {
        v[I + J * FX] += (dt * 0.5 * (fy[I + (J - 1) * FX] + fy[I + J * FX])) / RHO_AIR;
      }
    }
    this.zeroSolidFaces();

    // Semi-Lagrangian advection (midpoint back-trace) plus explicit viscosity.
    const nu = NU_AIR, ih2 = 1 / (HF * HF);
    for (let J = 0; J < FY; J++) {
      for (let I = 0; I <= FX; I++) {
        const k = I + J * W;
        const x = I * HF, y = (J + 0.5) * HF;
        const uu = u[k], vv = this.sampleV(x, y);
        const xm = x - 0.5 * dt * uu, ym = y - 0.5 * dt * vv;
        const xb = Math.min(LXf, Math.max(0, x - dt * this.sampleU(xm, ym)));
        const yb = Math.min(LYf, Math.max(0, y - dt * this.sampleV(xm, ym)));
        const adv = this.sampleU(xb, yb);
        // Laplacian: no-slip at the channel walls (ghost = -u), zero gradient at the open ends.
        const uw = I > 0 ? u[k - 1] : uu, ue = I < FX ? u[k + 1] : uu;
        const us = J > 0 ? u[k - W] : -uu, un = J < FY - 1 ? u[k + W] : -uu;
        u2[k] = adv + dt * nu * (uw + ue + us + un - 4 * uu) * ih2;
      }
    }
    for (let J = 0; J <= FY; J++) {
      for (let I = 0; I < FX; I++) {
        const k = I + J * FX;
        if (J === 0 || J === FY) { v2[k] = 0; continue; }
        const x = (I + 0.5) * HF, y = J * HF;
        const vv = v[k], uu = this.sampleU(x, y);
        const xm = x - 0.5 * dt * uu, ym = y - 0.5 * dt * vv;
        const xb = Math.min(LXf, Math.max(0, x - dt * this.sampleU(xm, ym)));
        const yb = Math.min(LYf, Math.max(0, y - dt * this.sampleV(xm, ym)));
        const adv = this.sampleV(xb, yb);
        const vw = I > 0 ? v[k - 1] : vv, ve = I < FX - 1 ? v[k + 1] : vv;
        const vs = v[k - FX], vn = v[k + FX];
        v2[k] = adv + dt * nu * (vw + ve + vs + vn - 4 * vv) * ih2;
      }
    }
    u.set(u2);
    v.set(v2);
    this.zeroSolidFaces();

    // Pressure projection with open ends.
    const pr = this.press;
    const b = pr.fine.b;
    const scale = RHO_AIR / dt;
    for (let J = 0; J < FY; J++) {
      for (let I = 0; I < FX; I++) {
        const k = I + J * FX;
        if (solid[k]) { b[k] = 0; continue; }
        const div = (u[I + 1 + J * W] - u[I + J * W] + v[k + FX] - v[k]) / HF;
        b[k] = scale * div;
      }
      // Air drawn in from the room arrives at zero total pressure, so its static
      // pressure is -rho u^2 / 2; air leaving meets the room at zero static.
      const uin = u[J * W], uout = u[FX + J * W];
      pr.ghostLeft[J] = uin > 0 ? -0.5 * RHO_AIR * uin * uin : 0;
      pr.ghostRight[J] = uout < 0 ? -0.5 * RHO_AIR * uout * uout : 0;
    }
    pr.solve(2);
    const p = pr.fine.x;
    const g = dt / (RHO_AIR * HF);
    for (let J = 0; J < FY; J++) {
      for (let I = 0; I <= FX; I++) {
        const k = I + J * W;
        const pl = I > 0 ? p[I - 1 + J * FX] : pr.ghostLeft[J];
        const pe = I < FX ? p[I + J * FX] : pr.ghostRight[J];
        u[k] -= g * (pe - pl);
      }
    }
    for (let J = 1; J < FY; J++) {
      for (let I = 0; I < FX; I++) {
        v[I + J * FX] -= g * (p[I + J * FX] - p[I + (J - 1) * FX]);
      }
    }
    this.zeroSolidFaces();
    this.time += dt;
  }

  maxSpeed() {
    let m = 0;
    for (let k = 0; k < this.u.length; k++) m = Math.max(m, Math.abs(this.u[k]));
    for (let k = 0; k < this.v.length; k++) m = Math.max(m, Math.abs(this.v[k]));
    return m;
  }

  // Advance the air by `span` seconds in stable sub-steps.
  advanceFlow(span) {
    this.gatherForce();
    let left = span;
    let steps = 0;
    while (left > 1e-12 && steps < 16) {
      const umax = this.maxSpeed();
      const dt = Math.min(left, 1.2e-4, umax > 0 ? (2.5 * HF) / umax : 1.2e-4);
      this.stepFlow(dt);
      left -= dt;
      steps++;
    }
  }

  // Mean outlet velocity across the channel (m/s): the fan's bulk speed.
  bulkSpeed() {
    const W = FX + 1;
    let s = 0;
    for (let J = 0; J < FY; J++) s += this.u[FX - 2 + J * W];
    return s / FY;
  }

  // Cell-centred velocities for drawing and tracers.
  cellVelocity(outU, outV) {
    const W = FX + 1;
    for (let J = 0; J < FY; J++) {
      for (let I = 0; I < FX; I++) {
        const k = I + J * FX;
        outU[k] = 0.5 * (this.u[I + J * W] + this.u[I + 1 + J * W]);
        outV[k] = 0.5 * (this.v[k] + this.v[k + FX]);
      }
    }
  }

  step(flowSpan = 8e-4, electroIters = 3) {
    this.stepElectro(electroIters);
    this.advanceFlow(flowSpan);
  }

  // Channel height the current spreads across, for the momentum model.
  get channelHeight() {
    return LY;
  }
}
