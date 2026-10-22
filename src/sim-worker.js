// Runs the solver off the main thread. The page asks for a frame, the worker
// advances the physics and answers with the fields and readings, so the two
// sides pace each other.

import { Solver } from './solver.js';
import { NX, NY, FX, FY } from './geometry.js';

const solver = new Solver();
let paused = false;
let busyFrames = 0; // electro iterations stay high for a while after a change
let changedAt = 0; // sim time of the last change
let uAvg = 0; // bulk speed, smoothed over a few milliseconds of sim time
let lastI = 0;
let currentStill = 0; // consecutive frames with a converged current
const trail = []; // [time, uAvg] for the steadiness test

const FLOW_SPAN = 7e-4; // seconds of air per frame
const TAU = 8e-3; // smoothing time for the bulk speed

function markChanged() {
  busyFrames = 30;
  changedAt = solver.time;
  currentStill = 0;
  trail.length = 0;
}

function frame() {
  if (!paused) {
    solver.step(FLOW_SPAN, busyFrames > 0 ? 3 : 1);
    if (busyFrames > 0) busyFrames--;
    const u = solver.bulkSpeed();
    uAvg += (u - uAvg) * (1 - Math.exp(-FLOW_SPAN / TAU));
    trail.push([solver.time, uAvg]);
    while (trail.length && trail[0][0] < solver.time - 0.03) trail.shift();
    const I = solver.Icoll;
    currentStill = Math.abs(I - lastI) <= 2e-3 * Math.max(Math.abs(I), 1e-7) ? currentStill + 1 : 0;
    lastI = I;
  }

  // Steady: the current has stopped moving, and the smoothed wind speed has held
  // within 3 % over the last 15 ms of air time.
  const since = solver.time - changedAt;
  let flowSteady = false;
  if (since > 0.03 && trail.length > 4) {
    const t0 = solver.time - 0.015;
    let ref = null;
    for (const [t, v] of trail) if (t >= t0) { ref = v; break; }
    if (ref !== null) flowSteady = Math.abs(uAvg - ref) <= 0.03 * Math.max(Math.abs(uAvg), 0.05);
  }
  // With no corona the only steady state is still air.
  if (solver.J === 0 && Math.abs(uAvg) > 0.03) flowSteady = false;
  const steady = currentStill >= 6 && flowSteady;
  const settle = Math.min(1, since / 0.045);

  const phi = new Float32Array(solver.phi);
  const rho = new Float32Array(solver.rho);
  const uc = new Float64Array(FX * FY);
  const vc = new Float64Array(FX * FY);
  solver.cellVelocity(uc, vc);
  const u32 = new Float32Array(uc);
  const v32 = new Float32Array(vc);

  postMessage(
    {
      type: 'frame',
      phi, rho, uc: u32, vc: v32,
      s: {
        V: solver.V,
        gap: solver.gap,
        view: solver.view,
        rw: solver.rw,
        V0: solver.onsetVoltage,
        Ep: solver.Ep,
        Es: solver.surfaceField,
        capacitance: solver.capacitance,
        lambdaL: solver.lambdaL,
        path: solver.path,
        J: solver.J,
        Icoll: solver.Icoll,
        phiE: solver.phiE,
        uBulk: uAvg,
        uMax: solver.maxSpeed(),
        time: solver.time,
        corona: solver.corona,
        steady,
        settle,
        paused,
      },
    },
    [phi.buffer, rho.buffer, u32.buffer, v32.buffer],
  );
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'params') {
    const before = [solver.V, solver.gap, solver.view, solver.rw].join();
    solver.setParams(m);
    if ([solver.V, solver.gap, solver.view, solver.rw].join() !== before) markChanged();
  } else if (m.type === 'reset') {
    solver.resetFlow();
    uAvg = 0;
    markChanged();
  } else if (m.type === 'pause') {
    paused = m.paused;
  } else if (m.type === 'frame') {
    frame();
  }
};

postMessage({ type: 'ready', NX, NY, FX, FY });
