/* Dense two-phase simplex for small linear programs.
 *
 * minimize  c . x
 * subject to  rows[i].a . x  (<=, >=, =)  rows[i].b ,  x >= 0
 *
 * rows[i].a is a sparse object {varIndex: coefficient}.
 * Size target: a few hundred variables and rows. Not meant for more.
 * Pivot rule: largest reduced cost, switching to Bland's rule after a stall,
 * because production models are highly degenerate (many rows have b = 0).
 */
(function (root) {
  'use strict';
  const EPS = 1e-9;

  function solveLP(nVars, c, rows, opts) {
    opts = opts || {};
    const maxIter = opts.maxIter || 50000;
    const m = rows.length;

    // Flip rows so that b >= 0.
    const sense = [], rhs = [], A = [];
    for (let i = 0; i < m; i++) {
      let { a, b, op } = rows[i];
      const dense = new Float64Array(nVars);
      for (const k in a) dense[k] = a[k];
      // A '>=' row with b = 0 becomes '<=' so its slack starts in the basis
      // and needs no artificial variable.
      if (b < 0 || (b === 0 && op === '>=')) {
        for (let j = 0; j < nVars; j++) dense[j] = -dense[j];
        b = -b;
        op = op === '<=' ? '>=' : op === '>=' ? '<=' : '=';
      }
      // Scale the row so its largest coefficient is 1. Keeps pivots well conditioned.
      let mx = 0;
      for (let j = 0; j < nVars; j++) mx = Math.max(mx, Math.abs(dense[j]));
      if (mx > 0 && mx !== 1) {
        for (let j = 0; j < nVars; j++) dense[j] /= mx;
        b /= mx;
      }
      A.push(dense); rhs.push(b); sense.push(op);
    }

    // Column layout: structural | slack/surplus | artificial.
    let nSlack = 0, nArt = 0;
    for (let i = 0; i < m; i++) {
      if (sense[i] !== '=') nSlack++;
      if (sense[i] !== '<=') nArt++;
    }
    const nCols = nVars + nSlack + nArt;
    const T = [];            // tableau rows, last column is rhs
    const basis = new Int32Array(m);
    let sCol = nVars, aCol = nVars + nSlack;
    const artCols = [];
    for (let i = 0; i < m; i++) {
      const row = new Float64Array(nCols + 1);
      row.set(A[i], 0);
      row[nCols] = rhs[i];
      if (sense[i] === '<=') {
        row[sCol] = 1; basis[i] = sCol; sCol++;
      } else if (sense[i] === '>=') {
        row[sCol] = -1; sCol++;
        row[aCol] = 1; basis[i] = aCol; artCols.push(aCol); aCol++;
      } else {
        row[aCol] = 1; basis[i] = aCol; artCols.push(aCol); aCol++;
      }
      T.push(row);
    }

    function pivot(r, col, z) {
      const pr = T[r];
      const pv = pr[col];
      for (let j = 0; j <= nCols; j++) pr[j] /= pv;
      for (let i = 0; i < m; i++) {
        if (i === r) continue;
        const f = T[i][col];
        if (Math.abs(f) < 1e-14) continue;
        const ri = T[i];
        for (let j = 0; j <= nCols; j++) ri[j] -= f * pr[j];
      }
      const fz = z[col];
      if (Math.abs(fz) > 1e-14) for (let j = 0; j <= nCols; j++) z[j] -= fz * pr[j];
      basis[r] = col;
    }

    // Run simplex on the current tableau with objective row z (reduced costs).
    // allowed(col) limits entering columns (used to bar artificials in phase 2).
    function run(z, allowed) {
      let stall = 0, lastObj = -z[nCols];
      for (let iter = 0; iter < maxIter; iter++) {
        const bland = stall > 30;
        let col = -1, best = -EPS;
        for (let j = 0; j < nCols; j++) {
          if (!allowed(j)) continue;
          if (z[j] < best) {
            best = z[j]; col = j;
            if (bland) break;
          }
        }
        if (col < 0) return 'optimal';
        let r = -1, minRatio = Infinity;
        for (let i = 0; i < m; i++) {
          const v = T[i][col];
          if (v > EPS) {
            const ratio = T[i][nCols] / v;
            if (ratio < minRatio - 1e-12 ||
                (bland && Math.abs(ratio - minRatio) <= 1e-12 && basis[i] < basis[r])) {
              minRatio = ratio; r = i;
            }
          }
        }
        if (r < 0) return 'unbounded';
        pivot(r, col, z);
        const obj = -z[nCols];
        stall = obj > lastObj + 1e-12 ? 0 : stall + 1;
        lastObj = obj;
      }
      return 'iteration-limit';
    }

    // Phase 1: minimize the sum of artificials.
    if (nArt > 0) {
      const z1 = new Float64Array(nCols + 1);
      for (const ac of artCols) z1[ac] = 1;
      for (let i = 0; i < m; i++) {
        if (artCols.indexOf(basis[i]) >= 0) {
          for (let j = 0; j <= nCols; j++) z1[j] -= T[i][j];
        }
      }
      const st = run(z1, () => true);
      if (st !== 'optimal') return { status: st };
      if (-z1[nCols] > 1e-7) return { status: 'infeasible' };
      // Drive remaining artificials out of the basis when possible.
      for (let i = 0; i < m; i++) {
        if (basis[i] >= nVars + nSlack) {
          for (let j = 0; j < nVars + nSlack; j++) {
            if (Math.abs(T[i][j]) > 1e-9) { pivot(i, j, z1); break; }
          }
        }
      }
    }

    // Phase 2: real objective.
    const z2 = new Float64Array(nCols + 1);
    for (let j = 0; j < nVars; j++) z2[j] = c[j] || 0;
    for (let i = 0; i < m; i++) {
      const cb = basis[i] < nVars ? (c[basis[i]] || 0) : 0;
      if (cb !== 0) for (let j = 0; j <= nCols; j++) z2[j] -= cb * T[i][j];
    }
    const st2 = run(z2, (j) => j < nVars + nSlack);
    if (st2 !== 'optimal') return { status: st2 };

    const x = new Float64Array(nVars);
    for (let i = 0; i < m; i++) if (basis[i] < nVars) x[basis[i]] = Math.max(0, T[i][nCols]);
    return { status: 'optimal', x, objective: -z2[nCols] };
  }

  const api = { solveLP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FPLP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
