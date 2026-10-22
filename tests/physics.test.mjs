// node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Solver, unitLaplace } from '../src/solver.js';
import { Poisson, DIRICHLET, UNKNOWN } from '../src/poisson.js';
import { peekField, townsend, townsendCurrent, fitTownsend, EPS0 } from '../src/model.js';
import { NX } from '../src/geometry.js';

const close = (a, b, rel) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));

test("Peek's onset field for a 25 µm wire", () => {
  // 3.1 MV/m * (1 + 0.0308 / sqrt(25e-6)) = 22.2 MV/m
  assert.ok(close(peekField(25e-6), 22.196e6, 1e-3));
});

test('Poisson solver reproduces a linear profile between two plates', () => {
  const nx = 64, ny = 16;
  const t = new Uint8Array(nx * ny).fill(UNKNOWN);
  for (let j = 0; j < ny; j++) {
    t[j * nx] = DIRICHLET;
    t[nx - 1 + j * nx] = DIRICHLET;
  }
  const p = new Poisson(nx, ny, 1e-4, t, { left: 'N', right: 'N', bottom: 'N', top: 'N' });
  for (let j = 0; j < ny; j++) p.x[j * nx] = 1;
  for (let k = 0; k < 8; k++) p.solve(10);
  for (let i = 0; i < nx; i++) {
    const want = 1 - i / (nx - 1);
    assert.ok(Math.abs(p.x[i + 5 * nx] - want) < 1e-6, `cell ${i}`);
  }
});

test('below onset there is no corona and no current', () => {
  const s = new Solver({ V: 3000, gap: 0.005, view: 'A' });
  assert.ok(s.onsetVoltage > 3000);
  for (let n = 0; n < 10; n++) s.stepElectro(3);
  assert.equal(s.J, 0);
  assert.equal(s.Icoll, 0);
});

test("above onset Kaptzov's condition holds and charge is conserved", () => {
  const s = new Solver({ V: 9000, gap: 0.005, view: 'A' });
  for (let n = 0; n < 60; n++) s.stepElectro(3);
  assert.ok(close(s.surfaceField, s.Ep, 1e-3), `surface ${s.surfaceField} vs Peek ${s.Ep}`);
  assert.ok(s.J > 0);
  assert.ok(close(s.Icoll, s.J, 1e-3), 'every injected ion reaches the collector');
  // Tens of microamps per centimetre of wire, as wire-to-plate coronas carry.
  const uAcm = s.Icoll * 1e4;
  assert.ok(uAcm > 10 && uAcm < 60, `${uAcm} µA/cm`);
});

test("the wire's induced charge from Green's reciprocity matches the field solve", () => {
  const s = new Solver({ V: 9000, gap: 0.005, view: 'B' });
  for (let n = 0; n < 40; n++) s.stepElectro(3);
  for (let n = 0; n < 6; n++) s.pois.solve(10);
  const viaField = -EPS0 * s.nbSum(s.pois.x);
  assert.ok(close(s.inducedCharge(s.rho), viaField, 1e-4));
});

test('the model onset equals the solver onset for the same geometry', () => {
  const s = new Solver({ V: 9000, gap: 0.006, view: 'C' });
  const m = townsend({ capacitance: s.capacitance, rw: s.rw, path: s.path });
  assert.ok(close(m.V0, s.onsetVoltage, 1e-9));
  const row = unitLaplace('C', 0.006);
  assert.ok(close(row.lambdaL, s.lambdaL, 1e-4));
  assert.ok(row.lambdaL > 0 && row.lambdaL < 2 * Math.PI * EPS0);
});

test('a wider gap starts later', () => {
  const near = new Solver({ gap: 0.003, view: 'A' }).onsetVoltage;
  const far = new Solver({ gap: 0.008, view: 'A' }).onsetVoltage;
  assert.ok(far > near);
});

test('Townsend fit recovers the law it was given', () => {
  const C = 4.2, V0 = 3.8; // µA/kV^2, kV
  const pts = [5, 6, 7, 8, 9, 10].map((V) => ({ V, I: townsendCurrent(V, C, V0) }));
  const fit = fitTownsend(pts);
  assert.ok(close(fit.V0, V0, 1e-3));
  assert.ok(close(fit.C, C, 1e-3));
  assert.ok(fit.r2 > 0.9999);
});

test('the grid is what the solver expects', () => {
  assert.equal(NX, 240);
});

test('air starts moving once the corona is on', () => {
  const s = new Solver({ V: 9000, gap: 0.005, view: 'A' });
  for (let n = 0; n < 40; n++) s.step(7e-4, n < 20 ? 3 : 1);
  const u = s.bulkSpeed();
  assert.ok(u > 0.5 && u < 5, `bulk speed ${u} m/s`);
});
