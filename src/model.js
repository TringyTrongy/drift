// The analytic model Fig. 2 draws its curves from, and the fits for bench data.

export const EPS0 = 8.8541878128e-12; // F/m
export const MU_ION = 2.0e-4; // positive ions in air, m^2/(V s)
export const RHO_AIR = 1.2; // kg/m^3
export const NU_AIR = 1.5e-5; // m^2/s

// Peek's onset field for a smooth wire of radius rw (m) in air at relative
// density delta:  Ep = 3.1 MV/m * delta * (1 + 0.0308 / sqrt(delta * rw)).
export function peekField(rw, delta = 1) {
  return 3.1e6 * delta * (1 + 0.0308 / Math.sqrt(delta * rw));
}

// Townsend's law I' = C V (V - V0) per metre of wire, with no fitted constants.
// Onset: the wire's line charge reaches the value that puts Peek's field on its
// surface, so V0 = 2 pi eps0 rw Ep / C', with C' the wire's capacitance per metre.
// Coefficient, a transit-time estimate: above onset the space charge has to carry
// the excess charge C'(V - V0); it crosses the shortest ion path l in about
// l^2 / (mu V), so  I' ~ C'(V - V0) mu V / l^2  and  C = mu C' / l^2.
export function townsend({ capacitance, rw, path, mu = MU_ION }) {
  const C = (mu * capacitance) / (path * path);
  const V0 = (2 * Math.PI * EPS0 * rw * peekField(rw)) / capacitance;
  return { C, V0 };
}

// Wire capacitance per metre from the grid's unit Laplace charge (see solver.js).
export function wireCapacitance(lambdaL, rw, h) {
  const r0 = Math.exp(-Math.PI / 2) * h;
  const k = Math.log(r0 / rw) / (2 * Math.PI * EPS0);
  return lambdaL / (1 + k * lambdaL);
}

// Rough sparkover guide: mean field along the shortest path, V/m. Real gaps
// vary with wire, humidity and surface; this only marks where to stop trusting
// a corona model.
export const SPARK_FIELD = 2.5e6;

export function townsendCurrent(V, C, V0) {
  return V > V0 ? C * V * (V - V0) : 0;
}

// Ideal momentum model: ions crossing the path l push the air with force I' l / mu
// per metre of wire; spread over the channel height w that is a pressure rise, and
// with no losses it all becomes dynamic pressure:  u = sqrt(2 I' l / (rho mu w)).
export function idealSpeed(Iper, path, w, mu = MU_ION) {
  return Iper > 0 ? Math.sqrt((2 * Iper * path) / (RHO_AIR * mu * w)) : 0;
}

// Least-squares Townsend fit to measured (V, I) pairs. For each trial V0 the best
// C is closed-form; V0 is found by golden-section search on the residual.
export function fitTownsend(points) {
  const pts = points.filter((p) => Number.isFinite(p.V) && Number.isFinite(p.I));
  if (pts.length < 2) return null;
  const vmax = Math.max(...pts.map((p) => p.V));
  const cost = (V0) => {
    let num = 0, den = 0;
    for (const p of pts) {
      const g = p.V > V0 ? p.V * (p.V - V0) : 0;
      num += g * p.I;
      den += g * g;
    }
    const C = den > 0 ? num / den : 0;
    let r = 0;
    for (const p of pts) r += (p.I - townsendCurrent(p.V, C, V0)) ** 2;
    return { r, C };
  };
  let a = 0, b = vmax * 0.98;
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = b - phi * (b - a), d = a + phi * (b - a);
  let fc = cost(c).r, fd = cost(d).r;
  for (let it = 0; it < 80; it++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = cost(c).r; }
    else { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = cost(d).r; }
  }
  const V0 = (a + b) / 2;
  const { C, r } = cost(V0);
  const mean = pts.reduce((s, p) => s + p.I, 0) / pts.length;
  const tot = pts.reduce((s, p) => s + (p.I - mean) ** 2, 0);
  return { C, V0, r2: tot > 0 ? 1 - r / tot : 1, n: pts.length };
}

// Least-squares slope through the origin for u = k sqrt(I).
export function fitSqrt(points) {
  const pts = points.filter((p) => Number.isFinite(p.I) && Number.isFinite(p.u) && p.I > 0);
  if (pts.length < 2) return null;
  let num = 0, den = 0;
  for (const p of pts) {
    const s = Math.sqrt(p.I);
    num += s * p.u;
    den += s * s;
  }
  return { k: num / den, n: pts.length };
}
