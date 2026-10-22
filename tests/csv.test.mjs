import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBench } from '../src/csv.js';

test('named columns in kV, µA, m/s and mm', () => {
  const { rows, error } = parseBench('V_kV, I_uA, u_ms, d_mm\n6.0, 18, 1.1, 5\n8.0, 61, 1.9, 5');
  assert.equal(error, null);
  assert.deepEqual(rows[1], { V: 8, I: 61, u: 1.9, d: 5 });
});

test('columns in any order, current in mA', () => {
  const { rows } = parseBench('gap (mm)\tcurrent (mA)\tvoltage (kV)\n4\t0.05\t7.5');
  assert.equal(rows[0].V, 7.5);
  assert.equal(rows[0].I, 50);
  assert.equal(rows[0].d, 4);
  assert.ok(Number.isNaN(rows[0].u));
});

test('volts are converted to kilovolts', () => {
  assert.equal(parseBench('voltage_V;I_uA\n7000;40').rows[0].V, 7);
  assert.equal(parseBench('7000 40\n8000 75').rows[1].V, 8);
});

test('headerless rows are voltage, current, speed, gap', () => {
  const { rows } = parseBench('# bench run 3\n6 20 1.2 5\n7 45 1.6 5');
  assert.deepEqual(rows[0], { V: 6, I: 20, u: 1.2, d: 5 });
});

test('unreadable input explains itself', () => {
  assert.match(parseBench('').error, /No rows/);
  assert.match(parseBench('time, temperature\n1, 20').error, /voltage and current/);
});
