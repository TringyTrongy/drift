// Drift: wires the sheet together. The solver runs in a worker; this thread
// draws Fig. 1 every animation frame, keeps the readings, and plots Fig. 2.

import { applyLayout } from './layout.js';
import { Fig1 } from './render.js';
import { Fig2, V_MAX } from './plots.js';
import { parseBench } from './csv.js';
import { townsend, townsendCurrent, fitTownsend, SPARK_FIELD } from './model.js';
import { EMITTER_X, GAP_MIN, GAP_MAX, LY, VIEWS } from './geometry.js';

const $ = (id) => document.getElementById(id);
const STORE = 'drift.sheet.v1';

// ---------------------------------------------------------------- state ---

const state = {
  V: 9000,
  gap: 0.005,
  view: 'A',
  rw: 25e-6,
  L: 0.04,
  layers: { lines: true, equi: true, charge: true, smoke: true, speed: false },
  readings: [],
  bench: [],
  benchName: '',
  paused: false,
  dragging: false,
};

let frame = null; // latest solver frame
let tables = {}; // model rows per view
let sweep = null;
let lastLoggedKey = '';
let plotDirty = true;

function load() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return;
    const s = JSON.parse(raw);
    for (const k of ['V', 'gap', 'view', 'rw', 'L']) if (Number.isFinite(s[k]) || typeof s[k] === 'string') state[k] = s[k];
    if (s.layers) Object.assign(state.layers, s.layers);
    if (Array.isArray(s.readings)) state.readings = s.readings.slice(-200);
    if (Array.isArray(s.bench)) state.bench = s.bench;
    if (typeof s.benchName === 'string') state.benchName = s.benchName;
  } catch {
    /* a private window or blocked storage: start a fresh sheet */
  }
  if (!VIEWS[state.view]) state.view = 'A';
  state.V = Math.min(V_MAX, Math.max(0, state.V));
  state.gap = Math.min(GAP_MAX, Math.max(GAP_MIN, state.gap));
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const { V, gap, view, rw, L, layers, readings, bench, benchName } = state;
      localStorage.setItem(STORE, JSON.stringify({ V, gap, view, rw, L, layers, readings, bench, benchName }));
    } catch {
      /* storage unavailable: the sheet still works, it just will not persist */
    }
  }, 300);
}

// --------------------------------------------------------------- workers ---

const sim = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
const modelWorker = new Worker(new URL('./model-worker.js', import.meta.url), { type: 'module' });
let inFlight = false;

function requestFrame() {
  if (inFlight) return;
  inFlight = true;
  sim.postMessage({ type: 'frame' });
}

let paramsQueued = false;
function sendParams() {
  if (paramsQueued) return;
  paramsQueued = true;
  setTimeout(() => {
    paramsQueued = false;
    sim.postMessage({ type: 'params', V: state.V, gap: state.gap, view: state.view, rw: state.rw });
  }, 0);
}

sim.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'ready') {
    sendParams();
    requestFrame();
    return;
  }
  if (m.type !== 'frame') return;
  inFlight = false;
  frame = m;
  fig1.setFrame(m);
  onFrame(m.s);
  if (document.hidden) return;
  if (state.paused) setTimeout(requestFrame, 120);
  else requestFrame();
};

modelWorker.onmessage = (e) => {
  if (e.data.type === 'table') {
    tables[e.data.view] = e.data.rows;
    plotDirty = true;
  }
};
modelWorker.postMessage({ type: 'start', view: state.view });

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) requestFrame();
});

// ---------------------------------------------------------------- layout ---

const fig1 = new Fig1($('fig1'));
const fig2 = new Fig2($('plot-iv'), $('plot-ui'));
let metrics = null;

function relayout() {
  metrics = applyLayout();
  fig1.resize(metrics);
  fig1.setGeometry(state.view, state.gap);
  fig2.resize(metrics);
  plotDirty = true;
}

// -------------------------------------------------------------- controls ---

const volts = $('volts');
const gapInput = $('gap');

function setV(kv, from) {
  state.V = Math.round(Math.min(V_MAX / 1000, Math.max(0, kv)) * 10) * 100;
  if (from !== volts) volts.value = String(state.V / 1000);
  $('volts-out').textContent = `${(state.V / 1000).toFixed(1)} kV`;
  sendParams();
  save();
  plotDirty = true;
}

function setGap(mm, from) {
  const g = Math.round(Math.min(GAP_MAX * 1000, Math.max(GAP_MIN * 1000, mm)) * 10) / 10;
  state.gap = g / 1000;
  if (from !== gapInput) gapInput.value = String(g);
  $('gap-out').textContent = `${g.toFixed(1)} mm`;
  fig1.setGeometry(state.view, state.gap);
  sendParams();
  save();
  plotDirty = true;
}

function setView(v) {
  state.view = v;
  $('view-name').textContent = VIEWS[v].name;
  for (const r of document.querySelectorAll('input[name="view"]')) r.checked = r.value === v;
  fig1.setGeometry(state.view, state.gap);
  modelWorker.postMessage({ type: 'start', view: v });
  sendParams();
  save();
  plotDirty = true;
}

volts.addEventListener('input', () => setV(Number(volts.value), volts));
gapInput.addEventListener('input', () => setGap(Number(gapInput.value), gapInput));
for (const r of document.querySelectorAll('input[name="view"]')) {
  r.addEventListener('change', () => r.checked && setView(r.value));
}
for (const cb of document.querySelectorAll('[data-layer]')) {
  cb.checked = !!state.layers[cb.dataset.layer];
  cb.addEventListener('change', () => {
    state.layers[cb.dataset.layer] = cb.checked;
    fig1.layers = state.layers;
    fig1.fieldDirty = true;
    save();
  });
}

// Scrubbable numbers in the wire line: drag sideways or use the arrow keys.
function scrubbable(el, { min, max, step, get, set }) {
  let start = null;
  const apply = (v) => {
    v = Math.min(max, Math.max(min, Math.round(v / step) * step));
    set(v);
    el.textContent = String(v);
    el.setAttribute('aria-valuenow', String(v));
  };
  el.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, v: get() };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    apply(start.v + ((e.clientX - start.x) / 4) * step);
  });
  const end = () => (start = null);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => {
    const k = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (k) {
      e.preventDefault();
      apply(get() + k * step * (e.shiftKey ? 5 : 1));
    }
  });
  apply(get());
}

scrubbable($('rw'), {
  min: 10, max: 100, step: 1,
  get: () => Math.round(state.rw * 1e6),
  set: (v) => { state.rw = v * 1e-6; sendParams(); save(); plotDirty = true; },
});
scrubbable($('len'), {
  min: 10, max: 200, step: 5,
  get: () => Math.round(state.L * 1000),
  set: (v) => { state.L = v / 1000; save(); plotDirty = true; renderLog(); },
});

// Drag the collector in Fig. 1 to change the gap.
const canvas = $('fig1');
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  if (!fig1.hit(px, py)) return;
  const [x] = fig1.toWorld(px, py);
  drag = { offset: state.gap - (x - EMITTER_X) };
  state.dragging = true;
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
});
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  if (drag) {
    const [x] = fig1.toWorld(px, py);
    setGap((x - EMITTER_X + drag.offset) * 1000);
  } else {
    fig1.hover = fig1.hit(px, py);
    canvas.style.cursor = fig1.hover ? 'ew-resize' : 'default';
  }
});
const endDrag = () => {
  drag = null;
  state.dragging = false;
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => { if (!drag) fig1.hover = false; });

$('pause').addEventListener('click', () => {
  state.paused = !state.paused;
  $('pause').setAttribute('aria-pressed', String(state.paused));
  $('pause').textContent = state.paused ? 'Resume' : 'Pause';
  sim.postMessage({ type: 'pause', paused: state.paused });
});
$('reset').addEventListener('click', () => {
  sim.postMessage({ type: 'reset' });
  lastLoggedKey = '';
});
$('log-now').addEventListener('click', () => frame && logReading(frame.s, true));
$('sweep').addEventListener('click', () => (sweep ? stopSweep() : startSweep()));
$('clear-log').addEventListener('click', () => {
  state.readings = [];
  lastLoggedKey = '';
  renderLog();
  save();
  plotDirty = true;
});
$('export-log').addEventListener('click', async () => {
  const head = 'n,V_kV,gap_mm,view,wire_radius_um,length_mm,I_uA,u_ms,I_over_model';
  const lines = state.readings.map((r) =>
    [r.n, (r.V / 1000).toFixed(2), (r.gap * 1000).toFixed(1), r.view, Math.round(r.rw * 1e6), Math.round(state.L * 1000),
      (r.Iper * state.L * 1e6).toFixed(2), r.u.toFixed(3), ratioOf(r)?.toFixed(3) ?? ''].join(','));
  const text = [head, ...lines].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    flash($('export-log'), 'Copied');
  } catch {
    flash($('export-log'), 'Copy blocked');
  }
});

function flash(btn, text) {
  const was = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = was), 1400);
}

// -------------------------------------------------------------- readings ---

function keyOf(s) {
  return `${(s.V / 1000).toFixed(1)}|${(s.gap * 1000).toFixed(1)}|${s.view}|${Math.round(s.rw * 1e6)}`;
}

function modelFor(r) {
  return townsend({ capacitance: r.capacitance, rw: r.rw, path: r.path });
}

function ratioOf(r) {
  const m = modelFor(r);
  const Im = townsendCurrent(r.V, m.C, m.V0);
  return Im > 0 && r.Iper > 0 ? r.Iper / Im : null;
}

function logReading(s, manual) {
  const key = keyOf(s);
  if (!manual && key === lastLoggedKey) return;
  const existing = state.readings.findIndex((r) => keyOf(r) === key);
  const n = state.readings.length ? state.readings[state.readings.length - 1].n + 1 : 1;
  const r = {
    n, V: s.V, gap: s.gap, view: s.view, rw: s.rw,
    Iper: s.Icoll, u: s.uBulk, path: s.path, capacitance: s.capacitance,
  };
  if (existing >= 0) state.readings.splice(existing, 1);
  state.readings.push(r);
  if (state.readings.length > 200) state.readings.shift();
  lastLoggedKey = key;
  freshRow = r.n;
  renderLog();
  save();
  plotDirty = true;
}

let freshRow = -1;
function renderLog() {
  const body = $('log-body');
  body.textContent = '';
  const rows = state.readings.slice(-14);
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (r.n === freshRow) tr.className = 'fresh';
    const ratio = ratioOf(r);
    const cells = [
      String(r.n), (r.V / 1000).toFixed(1), (r.gap * 1000).toFixed(1), r.view,
      (r.Iper * state.L * 1e6).toFixed(r.Iper * state.L * 1e6 >= 100 ? 0 : 1), r.u.toFixed(2),
      ratio === null ? '–' : ratio.toFixed(2),
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  if (frame && !frame.s.steady) {
    const s = frame.s;
    const tr = document.createElement('tr');
    tr.className = 'pending';
    for (const c of ['…', (s.V / 1000).toFixed(1), (s.gap * 1000).toFixed(1), s.view, (s.Icoll * state.L * 1e6).toFixed(1), s.uBulk.toFixed(2), '']) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  $('log-empty').hidden = state.readings.length > 0;
}

// ----------------------------------------------------------------- sweep ---

function startSweep() {
  if (!frame) return;
  const s = frame.s;
  const v0 = s.V0;
  const vTop = Math.min(V_MAX, 0.97 * SPARK_FIELD * s.path);
  if (vTop <= v0 + 300) return;
  // Start from still air just above onset and climb: driven flow settles in a
  // few milliseconds of air time, while coasting down would take far longer.
  const lo = Math.ceil((v0 + 250) / 100) * 100;
  const steps = [];
  const n = 8;
  for (let k = 0; k < n; k++) steps.push(Math.round((lo + ((vTop - lo) * k) / (n - 1)) / 100) * 100);
  sim.postMessage({ type: 'reset' });
  sweep = { steps, idx: 0, since: performance.now() };
  $('sweep').textContent = 'Stop';
  setV(steps[0] / 1000);
}

function stopSweep() {
  sweep = null;
  $('sweep').textContent = 'Sweep';
}

function advanceSweep(s) {
  if (!sweep) return;
  const target = sweep.steps[sweep.idx];
  const at = Math.abs(s.V - target) < 1;
  const waited = performance.now() - sweep.since;
  if (at && (s.steady || waited > 20000)) {
    logReading(s, waited > 20000);
    sweep.idx++;
    if (sweep.idx >= sweep.steps.length) {
      stopSweep();
      return;
    }
    sweep.since = performance.now();
    setV(sweep.steps[sweep.idx] / 1000);
  }
}

// ----------------------------------------------------------- on a frame ---

let lastReadout = 0;
let wasSteady = false;

function onFrame(s) {
  if (s.steady && !state.paused && !state.dragging && !sweep) logReading(s, false);
  advanceSweep(s);
  if (s.steady !== wasSteady) plotDirty = true;
  wasSteady = s.steady;
}

const fmtI = (A) => (A >= 1e-3 ? `${(A * 1e3).toFixed(2)} mA` : `${(A * 1e6).toFixed(A * 1e6 >= 100 ? 0 : 1)} µA`);

function updateReadouts() {
  if (!frame) return;
  const s = frame.s;
  const ink = s.steady ? 'inked' : 'pencil';
  const set = (id, text, cls = ink) => {
    const el = $(id);
    if (el.textContent !== text) el.textContent = text;
    el.className = cls;
  };
  set('r-onset', `${(s.V0 / 1000).toFixed(2)} kV`, 'inked');
  set('r-field', s.corona ? `${(s.Es / 1e6).toFixed(1)} MV/m, Peek` : `${(s.Es / 1e6).toFixed(1)} of ${(s.Ep / 1e6).toFixed(1)} MV/m`, s.corona ? 'corona-on' : ink);
  const I = s.Icoll * state.L;
  set('r-current', s.corona ? `${fmtI(I)} · ${(s.Icoll * 1e4).toFixed(1)} µA/cm` : '0, no corona');
  const P = s.V * I;
  set('r-power', P >= 0.995 ? `${P.toFixed(2)} W` : `${(P * 1000).toFixed(0)} mW`);
  set('r-wind', `${s.uBulk.toFixed(2)} m/s`);
  set('r-peak', `${s.uMax.toFixed(2)} m/s`);
  const Q = Math.max(0, s.uBulk) * LY * state.L; // m^3/s
  set('r-flow', `${(Q * 1000).toFixed(2)} L/s · ${(Q * 2118.88).toFixed(2)} cfm`);
  set('r-time', `${(s.time * 1000).toFixed(0)} ms`, 'inked');

  let status;
  if (state.paused) status = 'paused';
  else if (sweep) status = `sweep, step ${sweep.idx + 1} of ${sweep.steps.length}${s.steady ? '' : ', settling'}`;
  else if (!s.corona) status = s.uBulk > 0.02 ? 'below onset: no ions, the air is coasting to rest' : 'below onset: still air';
  else if (s.V > SPARK_FIELD * s.path) status = `past the sparkover guide: a real gap would arc${s.steady ? '' : ', settling'}`;
  else if (s.steady) {
    const last = state.readings[state.readings.length - 1];
    status = last && keyOf(last) === keyOf(s) ? `steady, logged as No. ${last.n}` : 'steady';
  } else status = 'settling';
  const st = $('status');
  if (st.textContent !== status) st.textContent = status;
  st.className = `status ${s.steady ? 'inked' : ''}`;

  // Onset and sparkover marks on the voltage scale.
  const frac = (v) => `calc(7px + (100% - 14px) * ${Math.min(1, Math.max(0, v / V_MAX))})`;
  $('onset-mark').style.left = frac(s.V0);
  for (const i of document.querySelectorAll('#volts-scale .ticks i')) {
    i.classList.toggle('yield', Math.abs(Number(i.textContent) - s.V0 / 1000) < 0.8);
  }
  const spark = SPARK_FIELD * s.path;
  const z = $('spark-zone');
  if (spark < V_MAX) {
    z.style.left = frac(spark);
    z.hidden = false;
  } else z.hidden = true;

  renderLog();
}

// Median simulated-to-model current at the present gap, view and wire.
function gapRatio() {
  const r = state.readings
    .filter((x) => x.view === state.view && Math.abs(x.rw - state.rw) < 1e-9 && Math.abs(x.gap - state.gap) < 5e-5)
    .map(ratioOf)
    .filter((x) => x !== null)
    .sort((a, b) => a - b);
  return r.length ? r[Math.floor(r.length / 2)] : NaN;
}

function updateVerdict(eta) {
  const pts = state.readings.filter((r) => r.view === state.view && Math.abs(r.rw - state.rw) < 1e-9);
  const ratios = pts.map(ratioOf).filter((x) => x !== null).sort((a, b) => a - b);
  const el = $('verdict');
  if (!ratios.length) {
    el.textContent = 'No readings for this collector yet. Each steady state inks one in; a sweep logs eight.';
    return;
  }
  const med = ratios[Math.floor(ratios.length / 2)];
  let text = `View ${state.view}, ${ratios.length} reading${ratios.length > 1 ? 's' : ''} above onset: the simulation carries ${med.toFixed(2)} times the model's current (median).`;
  if (eta !== null) text += ` The wind reaches ${Math.round(eta * 100)} % of the lossless limit.`;
  if (state.bench.length) {
    const fit = fitTownsend(state.bench);
    if (fit) text += ` Bench fit: V₀ = ${fit.V0.toFixed(2)} kV.`;
  }
  el.textContent = text;
}

// ----------------------------------------------------------------- bench ---

function plotBench(text, name) {
  const { rows, error } = parseBench(text);
  const out = $('bench-fit');
  if (error) {
    out.textContent = error;
    return;
  }
  state.bench = rows;
  state.benchName = name || 'pasted rows';
  save();
  describeBench();
  plotDirty = true;
}

function describeBench() {
  const out = $('bench-fit');
  if (!state.bench.length) {
    out.textContent = '';
    return;
  }
  const fit = fitTownsend(state.bench);
  const rows = state.bench.length;
  let t = `${state.benchName}: ${rows} row${rows > 1 ? 's' : ''} plotted as red crosses.`;
  if (fit) t += ` Townsend fit: V₀ = ${fit.V0.toFixed(2)} kV, C = ${fit.C.toPrecision(3)} µA/kV², R² = ${fit.r2.toFixed(3)}.`;
  out.textContent = t;
}

const benchFitOf = () => {
  const fit = fitTownsend(state.bench);
  // Bench units are kV and µA; the plot asks for volts in, µA out.
  return fit ? { C: fit.C / 1e6, V0: fit.V0 * 1000 } : null;
};

$('bench-plot').addEventListener('click', () => plotBench($('bench-paste').value, 'pasted rows'));
$('bench-clear').addEventListener('click', () => {
  state.bench = [];
  state.benchName = '';
  $('bench-paste').value = '';
  describeBench();
  save();
  plotDirty = true;
});
$('bench-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) plotBench(await f.text(), f.name);
});
const drop = $('drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) plotBench(await f.text(), f.name);
});

// ------------------------------------------------------------------ loop ---

let lastT = performance.now();
let lastPlot = 0;
let lastRaf = 0;

function loop(t) {
  lastRaf = t;
  tick(t);
  requestAnimationFrame(loop);
}

// Some embedded views stop animation frames while the page still counts as
// visible; keep drawing on a timer then.
setInterval(() => {
  const now = performance.now();
  if (!document.hidden && now - lastRaf > 400) tick(now);
}, 50);

function tick(t) {
  const dt = (t - lastT) / 1000;
  lastT = t;
  if (frame && !state.paused) fig1.stepParticles(dt);
  if (frame) {
    fig1.draw({
      V: state.V,
      gap: state.gap,
      corona: frame.s.corona,
      uBulk: frame.s.uBulk,
      steady: frame.s.steady,
      dragging: state.dragging,
    });
  }
  if (t - lastReadout > 120) {
    updateReadouts();
    lastReadout = t;
  }
  if (frame && (plotDirty || t - lastPlot > 400)) {
    const s = frame.s;
    const { eta } = fig2.draw({
      live: s,
      readings: state.readings,
      bench: state.bench,
      benchFit: state.bench.length ? benchFitOf() : null,
      table: tables[state.view],
      L: state.L,
      rw: state.rw,
      view: state.view,
      gap: state.gap,
      steady: s.steady,
      ratio: gapRatio(),
    });
    if (plotDirty) updateVerdict(eta);
    plotDirty = false;
    lastPlot = t;
  }
}

// ------------------------------------------------------------------ boot ---

load();
$('date').textContent = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
fig1.layers = state.layers;
relayout();
setV(state.V / 1000);
setGap(state.gap * 1000);
setView(state.view);
describeBench();
renderLog();
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(relayout, 120);
});
document.fonts.ready.then(() => {
  fig1.drawStatics();
  plotDirty = true;
});
requestAnimationFrame(loop);

