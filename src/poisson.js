// Poisson solver on a masked rectangle:  sum_nb (x_nb - x) / h^2 = b.
// Conjugate gradient, preconditioned by one symmetric multigrid V-cycle.
//
// Cell types: 0 unknown, 1 Dirichlet (value held in x), 2 inactive (a wall the
// solution cannot see: Neumann). Each domain edge is either Neumann ('N') or a
// Dirichlet ghost one cell outside ('D'); ghost values default to zero and can be
// set per row on the left and right edges (the flow solver's inlet uses that).

export const UNKNOWN = 0;
export const DIRICHLET = 1;
export const INACTIVE = 2;

function diagonal(nx, ny, type, bc) {
  const d = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = i + j * nx;
      if (type[k] !== UNKNOWN) continue;
      let n = 0;
      if (i > 0) { if (type[k - 1] !== INACTIVE) n++; } else if (bc.left === 'D') n++;
      if (i < nx - 1) { if (type[k + 1] !== INACTIVE) n++; } else if (bc.right === 'D') n++;
      if (j > 0) { if (type[k - nx] !== INACTIVE) n++; } else if (bc.bottom === 'D') n++;
      if (j < ny - 1) { if (type[k + nx] !== INACTIVE) n++; } else if (bc.top === 'D') n++;
      d[k] = n;
    }
  }
  return d;
}

function makeLevel(nx, ny, h, type, bc) {
  const n = nx * ny;
  return {
    nx, ny, h, type, bc, diag: diagonal(nx, ny, type, bc),
    x: new Float64Array(n), b: new Float64Array(n), r: new Float64Array(n),
  };
}

function coarsenTypes(fine) {
  const cx = Math.ceil(fine.nx / 2);
  const cy = Math.ceil(fine.ny / 2);
  const t = new Uint8Array(cx * cy);
  for (let J = 0; J < cy; J++) {
    for (let I = 0; I < cx; I++) {
      let dir = false, active = false;
      for (let dj = 0; dj < 2; dj++) {
        const j = 2 * J + dj;
        if (j >= fine.ny) continue;
        for (let di = 0; di < 2; di++) {
          const i = 2 * I + di;
          if (i >= fine.nx) continue;
          const ft = fine.type[i + j * fine.nx];
          if (ft === DIRICHLET) dir = true;
          else if (ft === UNKNOWN) active = true;
        }
      }
      t[I + J * cx] = dir ? DIRICHLET : active ? UNKNOWN : INACTIVE;
    }
  }
  return { cx, cy, t };
}

// Homogeneous Gauss-Seidel in red-black order; `reverse` runs black then red so
// the V-cycle stays symmetric, as conjugate gradient needs.
function smooth(lv, iters, reverse) {
  const { nx, ny, type, x, b, diag } = lv;
  const h2 = lv.h * lv.h;
  for (let it = 0; it < iters; it++) {
    for (let c = 0; c < 2; c++) {
      const color = reverse ? 1 - c : c;
      for (let j = 0; j < ny; j++) {
        const row = j * nx;
        for (let i = (j + color) & 1; i < nx; i += 2) {
          const k = row + i;
          if (type[k] !== UNKNOWN) continue;
          let sum = 0;
          if (i > 0 && type[k - 1] === UNKNOWN) sum += x[k - 1];
          if (i < nx - 1 && type[k + 1] === UNKNOWN) sum += x[k + 1];
          if (j > 0 && type[k - nx] === UNKNOWN) sum += x[k - nx];
          if (j < ny - 1 && type[k + nx] === UNKNOWN) sum += x[k + nx];
          x[k] = (sum - h2 * b[k]) / diag[k];
        }
      }
    }
  }
}

// Homogeneous residual r = b - Lap(x) on a work level.
function residual0(lv) {
  const { nx, ny, type, x, b, r, diag } = lv;
  const ih2 = 1 / (lv.h * lv.h);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = i + j * nx;
      if (type[k] !== UNKNOWN) { r[k] = 0; continue; }
      let sum = 0;
      if (i > 0 && type[k - 1] === UNKNOWN) sum += x[k - 1];
      if (i < nx - 1 && type[k + 1] === UNKNOWN) sum += x[k + 1];
      if (j > 0 && type[k - nx] === UNKNOWN) sum += x[k - nx];
      if (j < ny - 1 && type[k + nx] === UNKNOWN) sum += x[k + nx];
      r[k] = b[k] - (sum - diag[k] * x[k]) * ih2;
    }
  }
}

export class Poisson {
  // bc: { left, right, bottom, top } each 'N' or 'D'
  constructor(nx, ny, h, type, bc) {
    this.nx = nx;
    this.ny = ny;
    this.h = h;
    this.type = type;
    this.bc = bc;
    const n = nx * ny;
    this.x = new Float64Array(n);
    this.b = new Float64Array(n);
    this.r = new Float64Array(n);
    this.z = new Float64Array(n);
    this.p = new Float64Array(n);
    this.q = new Float64Array(n);
    this.ghostLeft = new Float64Array(ny);
    this.ghostRight = new Float64Array(ny);

    this.levels = [makeLevel(nx, ny, h, type, bc)];
    let lv = this.levels[0];
    while (lv.nx > 8 && lv.ny > 4) {
      const { cx, cy, t } = coarsenTypes(lv);
      // Piecewise-constant prolongation with averaging restriction makes the
      // Galerkin coarse operator half the rediscretised one: spacing grows by sqrt 2.
      lv = makeLevel(cx, cy, lv.h * Math.SQRT2, t, bc);
      this.levels.push(lv);
    }
  }

  // Kept so callers can write solver.fine.x as with a plain grid.
  get fine() {
    return this;
  }

  // r = b - Lap(x) with the real boundary values; returns its norm.
  residual() {
    const { nx, ny, type, x, b, r, bc } = this;
    const ih2 = 1 / (this.h * this.h);
    const gl = this.ghostLeft, gr = this.ghostRight;
    let norm = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = i + j * nx;
        if (type[k] !== UNKNOWN) { r[k] = 0; continue; }
        const xk = x[k];
        let lap = 0;
        if (i > 0) { if (type[k - 1] !== INACTIVE) lap += x[k - 1] - xk; }
        else if (bc.left === 'D') lap += gl[j] - xk;
        if (i < nx - 1) { if (type[k + 1] !== INACTIVE) lap += x[k + 1] - xk; }
        else if (bc.right === 'D') lap += gr[j] - xk;
        if (j > 0) { if (type[k - nx] !== INACTIVE) lap += x[k - nx] - xk; }
        else if (bc.bottom === 'D') lap -= xk;
        if (j < ny - 1) { if (type[k + nx] !== INACTIVE) lap += x[k + nx] - xk; }
        else if (bc.top === 'D') lap -= xk;
        const rk = b[k] - lap * ih2;
        r[k] = rk;
        norm += rk * rk;
      }
    }
    return Math.sqrt(norm);
  }

  vcycle(l) {
    const lv = this.levels[l];
    if (l === this.levels.length - 1) {
      smooth(lv, 30, false);
      smooth(lv, 30, true);
      return;
    }
    smooth(lv, 2, false);
    residual0(lv);
    const c = this.levels[l + 1];
    c.x.fill(0);
    for (let J = 0; J < c.ny; J++) {
      for (let I = 0; I < c.nx; I++) {
        const K = I + J * c.nx;
        if (c.type[K] !== UNKNOWN) { c.b[K] = 0; continue; }
        let s = 0, n = 0;
        for (let dj = 0; dj < 2; dj++) {
          const j = 2 * J + dj;
          if (j >= lv.ny) continue;
          for (let di = 0; di < 2; di++) {
            const i = 2 * I + di;
            if (i >= lv.nx) continue;
            const k = i + j * lv.nx;
            if (lv.type[k] === UNKNOWN) { s += lv.r[k]; n++; }
          }
        }
        c.b[K] = n ? s / n : 0;
      }
    }
    this.vcycle(l + 1);
    for (let j = 0; j < lv.ny; j++) {
      const J = j >> 1;
      for (let i = 0; i < lv.nx; i++) {
        const k = i + j * lv.nx;
        if (lv.type[k] === UNKNOWN) lv.x[k] += c.x[(i >> 1) + J * c.nx];
      }
    }
    smooth(lv, 2, true);
  }

  // z ~ Lap^-1 r with homogeneous boundaries (one V-cycle).
  precondition(r, z) {
    const lv = this.levels[0];
    lv.b.set(r);
    lv.x.fill(0);
    this.vcycle(0);
    z.set(lv.x);
  }

  // q = -Lap(p) with homogeneous boundaries (symmetric positive definite).
  applyA(p, q) {
    const { nx, ny, type } = this;
    const diag = this.levels[0].diag;
    const ih2 = 1 / (this.h * this.h);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = i + j * nx;
        if (type[k] !== UNKNOWN) { q[k] = 0; continue; }
        let sum = 0;
        if (i > 0 && type[k - 1] === UNKNOWN) sum += p[k - 1];
        if (i < nx - 1 && type[k + 1] === UNKNOWN) sum += p[k + 1];
        if (j > 0 && type[k - nx] === UNKNOWN) sum += p[k - nx];
        if (j < ny - 1 && type[k + nx] === UNKNOWN) sum += p[k + nx];
        q[k] = (diag[k] * p[k] - sum) * ih2;
      }
    }
  }

  // `iters` preconditioned CG steps from the current x; returns the residual norm.
  // With A = -Lap the system is A x = -b, so the CG residual is -(b - Lap x).
  solve(iters = 2) {
    const { x, r, z, p, q, type } = this;
    const n = x.length;
    this.residual();
    for (let k = 0; k < n; k++) r[k] = -r[k];
    // z = A^-1 r  <=>  Lap z = -r
    for (let k = 0; k < n; k++) q[k] = -r[k];
    this.precondition(q, z);
    p.set(z);
    let rz = 0;
    for (let k = 0; k < n; k++) rz += r[k] * z[k];
    for (let it = 0; it < iters && rz > 0; it++) {
      this.applyA(p, q);
      let pq = 0;
      for (let k = 0; k < n; k++) pq += p[k] * q[k];
      if (pq <= 0) break;
      const alpha = rz / pq;
      for (let k = 0; k < n; k++) {
        if (type[k] !== UNKNOWN) continue;
        x[k] += alpha * p[k];
        r[k] -= alpha * q[k];
      }
      if (it === iters - 1) break;
      for (let k = 0; k < n; k++) q[k] = -r[k];
      this.precondition(q, z);
      let rzNew = 0;
      for (let k = 0; k < n; k++) rzNew += r[k] * z[k];
      const beta = rzNew / rz;
      rz = rzNew;
      for (let k = 0; k < n; k++) p[k] = z[k] + beta * p[k];
    }
    let norm = 0;
    for (let k = 0; k < n; k++) norm += r[k] * r[k];
    return Math.sqrt(norm);
  }
}
