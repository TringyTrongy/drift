// Builds the model table in the background: for every collector view and every
// whole-millimetre gap, the wire's unit Laplace charge and the shortest ion path.
// Fig. 2 turns each row into a Townsend curve.

import { unitLaplace } from './solver.js';

const GAPS = [2, 3, 4, 5, 6, 7, 8, 9, 10];
const done = new Set();
let queue = [];

function enqueue(first) {
  const views = [first, ...['A', 'B', 'C'].filter((v) => v !== first)];
  queue = views.filter((v) => !done.has(v));
}

function work() {
  const view = queue.shift();
  if (!view) return;
  let warm = null;
  const rows = [];
  for (const g of GAPS) {
    const r = unitLaplace(view, g / 1000, warm);
    warm = r.x;
    rows.push({ gap: g / 1000, lambdaL: r.lambdaL, path: r.path });
  }
  done.add(view);
  postMessage({ type: 'table', view, rows });
  setTimeout(work, 0);
}

onmessage = (e) => {
  if (e.data.type === 'start') {
    enqueue(e.data.view || 'A');
    work();
  }
};
