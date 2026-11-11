// Prediction engine.
//
// Independent models are run "walk-forward" over every historical game: each game is
// predicted using ONLY information available before kick-off, then the models learn
// from the result. This gives honest out-of-sample predictions that are used to
// (1) score each model, (2) train the ML model, (3) weight the ensemble, and
// (4) let the self-learning "brain" evolve better settings over time.
//
//   Elo        - rating system with home advantage, margin-of-victory and season regression
//   Score      - attack/defence strengths; Poisson score grid (low scoring) or Normal margin (high scoring)
//   ML         - logistic regression on engineered features
//   Ensemble   - log-loss weighted blend of the above
//   Stats      - (soccer) corners, cards, shots, shots on target, fouls, offsides via negative binomial
//   Markets    - GG/NG, over/under, correct score, double chance, HT/FT, handicaps, corners, cards, ...

const OUTCOMES = ['home', 'draw', 'away'];
const DAY = 86400e3;

// ---------- math helpers ----------

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function invNorm(p) {
  // Acklam's inverse normal CDF approximation
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  p = clamp(p, 1e-6, 1 - 1e-6);
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function poissonPmfs(lambda, max) {
  const out = new Array(max + 1);
  out[0] = Math.exp(-lambda);
  for (let k = 1; k <= max; k++) out[k] = (out[k - 1] * lambda) / k;
  return out;
}

/** Negative binomial pmf (mean mu, dispersion r). r = Infinity -> Poisson. */
function nbPmfs(mu, r, max) {
  if (!Number.isFinite(r) || r > 500) return poissonPmfs(mu, max);
  const out = new Array(max + 1);
  const q = mu / (r + mu);
  out[0] = (r / (r + mu)) ** r;
  for (let k = 1; k <= max; k++) out[k] = (out[k - 1] * (k - 1 + r) * q) / k;
  return out;
}

function convolve(a, b, max) {
  const out = new Array(max + 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length && i + j <= max; j++) out[i + j] += a[i] * b[j];
  return out;
}

const pOver = (pmf, line) => pmf.reduce((s, p, k) => (k > line ? s + p : s), 0);

function normalize(p, draws) {
  const q = { home: Math.max(p.home, 1e-4), draw: draws ? Math.max(p.draw || 0, 1e-4) : 0, away: Math.max(p.away, 1e-4) };
  const s = q.home + q.draw + q.away;
  return { home: q.home / s, draw: q.draw / s, away: q.away / s };
}

function outcomeOf(g) {
  if (Number.isFinite(g.home.score) && Number.isFinite(g.away.score) && !(g.home.winner || g.away.winner)) {
    if (g.home.score > g.away.score) return 'home';
    if (g.home.score < g.away.score) return 'away';
    return 'draw';
  }
  if (g.home.winner) return 'home';
  if (g.away.winner) return 'away';
  return 'draw';
}

function pickOf(p) {
  return OUTCOMES.reduce((best, o) => ((p[o] || 0) > (p[best] || 0) ? o : best), 'home');
}

// ---------- tunable parameters (evolved by the brain) ----------

export function defaultParams(league) {
  return {
    k: league.elo.k,
    home: league.elo.home,
    regress: 1 / 3,
    drawMult: 1.12,
    halfLife: league.scoring === 'points' ? 120 : league.sport === 'baseball' ? 90 : 150,
    prior: 4,
    l2: 0.002,
    temp: 25,
  };
}

export const PARAM_SPACE = {
  k: (L) => [L.elo.k * 0.4, L.elo.k * 2.5],
  home: (L) => [0, L.elo.home * 2 + 20],
  regress: () => [0, 0.6],
  drawMult: () => [0.8, 1.5],
  halfLife: () => [30, 400],
  prior: () => [1, 12],
  l2: () => [0.0002, 0.05],
  temp: () => [5, 60],
};

// ---------- Elo ----------

class Elo {
  constructor(league, P) {
    this.cfg = league.elo;
    this.P = P;
    this.league = league;
    this.r = new Map();
    this.n = new Map();
    this.last = new Map();
    this.draws = 0;
    this.games = 0;
  }
  rating(id, t) {
    let r = this.r.get(id) ?? 1500;
    const last = this.last.get(id);
    if (this.league.kind === 'team' && last && t - last > 100 * DAY) r = r * (1 - this.P.regress) + 1500 * this.P.regress;
    return r;
  }
  predict(g) {
    const t = new Date(g.date).getTime();
    const rh = this.rating(g.home.id, t);
    const ra = this.rating(g.away.id, t);
    const diff = rh - ra + (g.neutral ? 0 : this.P.home);
    const E = 1 / (1 + 10 ** (-diff / 400));
    let probs;
    if (this.league.draws) {
      const drawRate = this.games > 50 ? this.draws / this.games : this.league.sport === 'mma' ? 0.01 : 0.26;
      const pD = clamp(drawRate * this.P.drawMult * Math.exp(-1.8 * (2 * E - 1) ** 2), 0.005, 0.45);
      probs = normalize({ home: E - pD / 2, draw: pD, away: 1 - E - pD / 2 }, true);
    } else {
      probs = { home: E, draw: 0, away: 1 - E };
    }
    return { probs, home: Math.round(rh), away: Math.round(ra), diff };
  }
  update(g) {
    const t = new Date(g.date).getTime();
    const { diff } = this.predict(g);
    const E = 1 / (1 + 10 ** (-diff / 400));
    const o = outcomeOf(g);
    const S = o === 'home' ? 1 : o === 'away' ? 0 : 0.5;
    let mult = 1;
    const m = Math.abs((g.home.score ?? 0) - (g.away.score ?? 0));
    if (this.cfg.mov === 'points' || this.cfg.mov === 'runs') {
      const winnerDiff = S === 1 ? diff : S === 0 ? -diff : 0;
      mult = Math.log(m + 1) * (2.2 / (winnerDiff * 0.001 + 2.2));
      if (this.cfg.mov === 'runs') mult = 0.6 + mult * 0.6;
      mult = Math.max(mult, 0.5);
    } else if (this.cfg.mov === 'goals') {
      mult = m <= 1 ? 1 : m === 2 ? 1.5 : (11 + m) / 8;
    }
    const rh = this.rating(g.home.id, t);
    const ra = this.rating(g.away.id, t);
    const kFor = (id) => {
      if (!this.cfg.dynamicK) return this.P.k;
      const n = this.n.get(id) ?? 0;
      return (this.P.k / 32) * (250 / (n + 5) ** 0.4);
    };
    this.r.set(g.home.id, rh + kFor(g.home.id) * mult * (S - E));
    this.r.set(g.away.id, ra - kFor(g.away.id) * mult * (S - E));
    for (const id of [g.home.id, g.away.id]) {
      this.n.set(id, (this.n.get(id) ?? 0) + 1);
      this.last.set(id, t);
    }
    this.games++;
    if (o === 'draw') this.draws++;
  }
  table(names) {
    return [...this.r.entries()]
      .map(([id, r]) => ({ id, rating: Math.round(r), games: this.n.get(id), ...names.get(id) }))
      .sort((a, b) => b.rating - a.rating);
  }
}

// ---------- decay helper ----------

function decay(obj, t, halfLife) {
  if (obj.t !== null && obj.t !== undefined) {
    const f = 0.5 ** ((t - obj.t) / DAY / halfLife);
    for (const k of Object.keys(obj)) if (k !== 't') obj[k] *= f;
  }
  obj.t = t;
}

// ---------- Scoring model (attack / defence strengths) ----------

class ScoreModel {
  constructor(league, P) {
    this.league = league;
    this.P = P;
    this.teams = new Map();
    this.lg = { home: 0, away: 0, w: 0, h1: 0, ft: 0, t: null }; // h1/ft: first-half share of goals
  }
  team(id) {
    if (!this.teams.has(id)) this.teams.set(id, { gf: 0, ga: 0, w: 0, t: null });
    return this.teams.get(id);
  }
  expected(g) {
    const lg = this.lg;
    if (lg.w < 15) return null;
    const avgH = lg.home / lg.w;
    const avgA = lg.away / lg.w;
    const avg = (avgH + avgA) / 2;
    const W0 = this.P.prior;
    const str = (id) => {
      const s = this.teams.get(id) || { gf: 0, ga: 0, w: 0 };
      return { att: (s.gf + W0 * avg) / (s.w + W0) / avg, def: (s.ga + W0 * avg) / (s.w + W0) / avg };
    };
    const h = str(g.home.id);
    const a = str(g.away.id);
    return { home: (g.neutral ? avg : avgH) * h.att * a.def, away: (g.neutral ? avg : avgA) * a.att * h.def };
  }
  firstHalfShare() {
    return this.lg.ft > 20 ? clamp(this.lg.h1 / this.lg.ft, 0.3, 0.55) : 0.45;
  }
  predict(g, withGrid = false) {
    const ex = this.expected(g);
    if (!ex) return null;
    const L = this.league;
    if (L.scoring === 'points') {
      const mu = ex.home - ex.away;
      const pH = normCdf(mu / L.sigma);
      return {
        probs: { home: pH, draw: 0, away: 1 - pH },
        expected: { home: +ex.home.toFixed(1), away: +ex.away.toFixed(1) },
        likely: `${Math.round(ex.home)}-${Math.round(ex.away)}`,
        spread: +(-mu).toFixed(1),
        total: +(ex.home + ex.away).toFixed(1),
        lambda: ex,
      };
    }
    const max = L.maxGoals || 10;
    const ph = poissonPmfs(ex.home, max), pa = poissonPmfs(ex.away, max);
    let pH = 0, pD = 0, pA = 0, best = { p: -1 }, bestNoDraw = { p: -1 };
    const grid = withGrid ? [] : null;
    for (let i = 0; i <= max; i++) {
      if (grid) grid.push(new Array(max + 1));
      for (let j = 0; j <= max; j++) {
        const p = ph[i] * pa[j];
        if (grid) grid[i][j] = p;
        if (i > j) pH += p; else if (i < j) pA += p; else pD += p;
        if (p > best.p) best = { p, s: `${i}-${j}` };
        if (i !== j && p > bestNoDraw.p) bestNoDraw = { p, s: `${i}-${j}` };
      }
    }
    let probs;
    if (L.draws) probs = normalize({ home: pH, draw: pD, away: pA }, true);
    else {
      const share = pH / (pH + pA);
      probs = { home: pH + pD * share, draw: 0, away: pA + pD * (1 - share) };
      const s = probs.home + probs.away;
      probs.home /= s; probs.away /= s;
    }
    return {
      probs,
      expected: { home: +ex.home.toFixed(2), away: +ex.away.toFixed(2) },
      likely: L.draws ? best.s : bestNoDraw.s,
      total: +(ex.home + ex.away).toFixed(2),
      lambda: ex,
      grid,
    };
  }
  update(g) {
    const t = new Date(g.date).getTime();
    const hs = g.home.score, as = g.away.score;
    if (!Number.isFinite(hs) || !Number.isFinite(as)) return;
    decay(this.lg, t, this.P.halfLife);
    this.lg.home += hs; this.lg.away += as; this.lg.w += 1;
    if (g.ht) { this.lg.h1 += g.ht.home + g.ht.away; this.lg.ft += hs + as; }
    const h = this.team(g.home.id), a = this.team(g.away.id);
    decay(h, t, this.P.halfLife); decay(a, t, this.P.halfLife);
    h.gf += hs; h.ga += as; h.w += 1;
    a.gf += as; a.ga += hs; a.w += 1;
  }
}

// ---------- Match-stats model (soccer): negative binomial per team per stat ----------

export const STATS = {
  corners: { name: 'Corners', lines: [6.5, 13.5], team: [2.5, 7.5], max: 30 },
  cards: { name: 'Cards', lines: [1.5, 7.5], team: [0.5, 3.5], max: 16 },
  shots: { name: 'Shots', lines: [17.5, 32.5], team: [7.5, 18.5], max: 70 },
  sot: { name: 'Shots on target', lines: [4.5, 13.5], team: [1.5, 7.5], max: 35 },
  fouls: { name: 'Fouls', lines: [16.5, 32.5], team: [8.5, 16.5], max: 60 },
  offsides: { name: 'Offsides', lines: [1.5, 7.5], team: [0.5, 3.5], max: 20 },
};

function statValue(side, key) {
  const s = side.stats;
  if (!s) return null;
  if (key === 'cards') return s.yellow !== null && s.red !== null ? s.yellow + s.red : null;
  const v = s[key];
  return Number.isFinite(v) ? v : null;
}

class StatsModel {
  constructor(league, halfLife = 150) {
    this.halfLife = halfLife;
    this.teams = new Map(); // `${stat}:${id}` -> {f, a, w, t}
    this.lg = {}; // stat -> {h, a, w, e, r2, t}
    this.red = { yes: 0, n: 0, t: null };
  }
  key(stat, id) {
    const k = `${stat}:${id}`;
    if (!this.teams.has(k)) this.teams.set(k, { f: 0, a: 0, w: 0, t: null });
    return this.teams.get(k);
  }
  lgs(stat) {
    if (!this.lg[stat]) this.lg[stat] = { h: 0, a: 0, w: 0, e: 0, r2: 0, n: 0, t: null };
    return this.lg[stat];
  }
  expected(stat, g) {
    const L = this.lg[stat];
    if (!L || L.w < 25) return null;
    const avgH = L.h / L.w, avgA = L.a / L.w, avg = (avgH + avgA) / 2;
    if (avg <= 0) return null;
    const W0 = 5;
    const str = (id) => {
      const s = this.teams.get(`${stat}:${id}`) || { f: 0, a: 0, w: 0 };
      return { f: (s.f + W0 * avg) / (s.w + W0) / avg, a: (s.a + W0 * avg) / (s.w + W0) / avg };
    };
    const h = str(g.home.id), a = str(g.away.id);
    const eH = (g.neutral ? avg : avgH) * h.f * a.a;
    const eA = (g.neutral ? avg : avgA) * a.f * h.a;
    // Over-dispersion from walk-forward residuals: var = mu + mu^2 / r
    const meanE = L.n > 0 ? L.e / L.n : avg;
    const varR = L.n > 30 ? L.r2 / L.n : meanE * 1.3;
    const r = varR > meanE * 1.02 ? clamp((meanE * meanE) / (varR - meanE), 1, 500) : Infinity;
    return { home: eH, away: eA, r };
  }
  dist(stat, g) {
    const e = this.expected(stat, g);
    if (!e) return null;
    const max = STATS[stat].max;
    const ph = nbPmfs(e.home, e.r, max), pa = nbPmfs(e.away, e.r, max);
    return { eH: e.home, eA: e.away, home: ph, away: pa, total: convolve(ph, pa, max) };
  }
  pRed() {
    return this.red.n > 30 ? this.red.yes / this.red.n : null;
  }
  update(g) {
    const t = new Date(g.date).getTime();
    for (const stat of Object.keys(STATS)) {
      const vh = statValue(g.home, stat), va = statValue(g.away, stat);
      if (vh === null || va === null) continue;
      const e = this.expected(stat, g);
      const L = this.lgs(stat);
      decay(L, t, this.halfLife);
      if (e) { L.e += e.home + e.away; L.r2 += (vh - e.home) ** 2 + (va - e.away) ** 2; L.n += 2; }
      L.h += vh; L.a += va; L.w += 1;
      const h = this.key(stat, g.home.id), a = this.key(stat, g.away.id);
      decay(h, t, this.halfLife); decay(a, t, this.halfLife);
      h.f += vh; h.a += va; h.w += 1;
      a.f += va; a.a += vh; a.w += 1;
    }
    const rh = g.home.stats?.red, ra = g.away.stats?.red;
    if (Number.isFinite(rh) && Number.isFinite(ra)) {
      decay(this.red, t, 365);
      this.red.n += 1;
      if (rh + ra > 0) this.red.yes += 1;
    }
  }
}

// ---------- Form / feature tracker ----------

class FormTracker {
  constructor(league) {
    this.league = league;
    this.s = new Map();
    this.scale = league.scoring === 'points' ? league.sigma : league.scoring === 'goals' ? 2 : 1;
  }
  get(id) {
    if (!this.s.has(id)) this.s.set(id, { res: [], last: null, n: 0 });
    return this.s.get(id);
  }
  summary(id, t) {
    const s = this.get(id);
    const last5 = s.res.slice(-5);
    const last10 = s.res.slice(-10);
    return {
      form: last5.length ? last5.reduce((a, r) => a + r.s, 0) / last5.length : 0.5,
      margin: last10.length ? last10.reduce((a, r) => a + r.m, 0) / last10.length / this.scale : 0,
      rest: s.last ? clamp((t - s.last) / DAY, 0, 14) : 7,
      n: s.n,
      streak: last5.map((r) => (r.s === 1 ? 'W' : r.s === 0 ? 'L' : 'D')).join(''),
    };
  }
  update(g) {
    const t = new Date(g.date).getTime();
    const o = outcomeOf(g);
    const m = Number.isFinite(g.home.score) && Number.isFinite(g.away.score) ? g.home.score - g.away.score : o === 'home' ? 1 : o === 'away' ? -1 : 0;
    const push = (id, s, mm) => {
      const st = this.get(id);
      st.res.push({ s, m: mm });
      if (st.res.length > 10) st.res.shift();
      st.last = t;
      st.n++;
    };
    push(g.home.id, o === 'home' ? 1 : o === 'away' ? 0 : 0.5, m);
    push(g.away.id, o === 'away' ? 1 : o === 'home' ? 0 : 0.5, -m);
  }
}

function features(g, eloPred, scorePred, form) {
  const t = new Date(g.date).getTime();
  const h = form.summary(g.home.id, t);
  const a = form.summary(g.away.id, t);
  const lo = (p) => Math.log(clamp(p, 0.02, 0.98) / (1 - clamp(p, 0.02, 0.98)));
  return [
    eloPred.diff / 400,
    scorePred ? lo(scorePred.probs.home + scorePred.probs.draw / 2) / 2 : 0,
    h.form - a.form,
    clamp(h.margin - a.margin, -3, 3),
    (h.rest - a.rest) / 7,
    g.neutral ? 0 : 1,
    (Math.log1p(h.n) - Math.log1p(a.n)) / 3,
  ];
}
const FEATURE_NAMES = ['Elo difference', 'Scoring-model edge', 'Recent form (last 5)', 'Avg margin (last 10)', 'Rest days', 'Home field', 'Experience'];

// ---------- Logistic regression ----------

function trainLogistic(X, y, { iters = 400, lr = 0.3, l2 = 0.002 } = {}) {
  const d = X[0]?.length || 0;
  const w = new Array(d + 1).fill(0);
  const n = X.length;
  if (!n) return w;
  const grad = new Array(d + 1);
  for (let it = 0; it < iters; it++) {
    grad.fill(0);
    for (let i = 0; i < n; i++) {
      const x = X[i];
      let z = w[d];
      for (let j = 0; j < d; j++) z += w[j] * x[j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) grad[j] += err * x[j];
      grad[d] += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (grad[j] / n + l2 * w[j]);
    w[d] -= lr * (grad[d] / n);
  }
  return w;
}
const dot = (w, x) => x.reduce((s, v, j) => s + v * w[j], w[x.length]);

class MLModel {
  constructor(league, P) {
    this.league = league;
    this.P = P;
    this.wH = null;
    this.wA = null;
  }
  fit(rows) {
    const X = rows.map((r) => r.x);
    this.wH = trainLogistic(X, rows.map((r) => (r.outcome === 'home' ? 1 : 0)), { l2: this.P.l2 });
    if (this.league.draws) this.wA = trainLogistic(X, rows.map((r) => (r.outcome === 'away' ? 1 : 0)), { l2: this.P.l2 });
    return this;
  }
  predict(x) {
    if (!this.wH) return null;
    const pH = sigmoid(dot(this.wH, x));
    if (!this.league.draws) return { probs: { home: pH, draw: 0, away: 1 - pH } };
    const pA = sigmoid(dot(this.wA, x));
    const pD = Math.max(0.02, 1 - pH - pA);
    return { probs: normalize({ home: pH, draw: pD, away: pA }, true) };
  }
  importance() {
    if (!this.wH) return [];
    return FEATURE_NAMES.map((name, j) => ({ name, weight: +this.wH[j].toFixed(3) }));
  }
}

// ---------- evaluation ----------

function score(rows, getP) {
  let n = 0, correct = 0, brier = 0, ll = 0;
  for (const r of rows) {
    const p = getP(r);
    if (!p) continue;
    n++;
    if (pickOf(p) === r.outcome) correct++;
    for (const o of OUTCOMES) brier += ((p[o] || 0) - (r.outcome === o ? 1 : 0)) ** 2;
    ll += -Math.log(clamp(p[r.outcome] || 0, 1e-6, 1));
  }
  return n ? { n, accuracy: correct / n, brier: brier / n, logLoss: ll / n } : { n: 0 };
}

/** Binary market evaluation vs. a naive "base rate" predictor. */
function scoreBinary(items) {
  const n = items.length;
  if (n < 20) return null;
  const rate = items.reduce((s, x) => s + x.y, 0) / n;
  let correct = 0, brier = 0, baseBrier = 0;
  for (const { p, y } of items) {
    if ((p >= 0.5 ? 1 : 0) === y) correct++;
    brier += (p - y) ** 2;
    baseBrier += (rate - y) ** 2;
  }
  return { n, accuracy: correct / n, baseAccuracy: Math.max(rate, 1 - rate), brier: brier / n, baseBrier: baseBrier / n, rate };
}

function blend(parts, weights, draws) {
  const out = { home: 0, draw: 0, away: 0 };
  let tw = 0;
  for (const [k, p] of Object.entries(parts)) {
    if (!p || !weights[k]) continue;
    for (const o of OUTCOMES) out[o] += weights[k] * (p[o] || 0);
    tw += weights[k];
  }
  if (!tw) return null;
  return normalize({ home: out.home / tw, draw: out.draw / tw, away: out.away / tw }, draws);
}

// ---------- markets ----------

const mk = (group, key, name, sporty, sels) => ({
  group, key, name, sporty,
  selections: sels.filter(Boolean).map(([k, label, p, sportyPick]) => ({ key: k, label, p: clamp(p, 0, 1), sportyPick: sportyPick || label })),
});

function linesNear(mean, [lo, hi], n = 4) {
  const base = Math.floor(mean) + 0.5;
  const cands = [];
  for (let d = -2; d <= 2; d++) cands.push(base + d);
  return cands.filter((l) => l >= lo && l <= hi).sort((a, b) => Math.abs(a - mean) - Math.abs(b - mean)).slice(0, n).sort((a, b) => a - b);
}

/** Rescale a goals grid so its home/draw/away mass matches the ensemble 1X2. */
function alignGrid(grid, ens) {
  let h = 0, d = 0, a = 0;
  grid.forEach((row, i) => row.forEach((p, j) => { if (i > j) h += p; else if (i < j) a += p; else d += p; }));
  const fh = ens.home / h, fd = ens.draw / d, fa = ens.away / a;
  return grid.map((row, i) => row.map((p, j) => p * (i > j ? fh : i < j ? fa : fd)));
}

function gridSum(grid, fn) {
  let s = 0;
  grid.forEach((row, i) => row.forEach((p, j) => { if (fn(i, j)) s += p; }));
  return s;
}

function htft(lh, la, share) {
  const m1 = 6, m2 = 8;
  const a1 = poissonPmfs(lh * share, m1), b1 = poissonPmfs(la * share, m1);
  const a2 = poissonPmfs(lh * (1 - share), m2), b2 = poissonPmfs(la * (1 - share), m2);
  const res = (x, y) => (x > y ? 'H' : x < y ? 'A' : 'D');
  const out = {};
  let ht = { H: 0, D: 0, A: 0 }, o05 = 0, o15 = 0;
  for (let i = 0; i <= m1; i++) for (let j = 0; j <= m1; j++) {
    const p1 = a1[i] * b1[j];
    ht[res(i, j)] += p1;
    if (i + j > 0.5) o05 += p1;
    if (i + j > 1.5) o15 += p1;
    for (let k = 0; k <= m2; k++) for (let l = 0; l <= m2; l++) {
      const key = res(i, j) + res(i + k, j + l);
      out[key] = (out[key] || 0) + p1 * a2[k] * b2[l];
    }
  }
  return { htft: out, ht, o05, o15 };
}

function soccerMarkets(g, ens, sp, stm, share) {
  const H = g.home.short || g.home.name, A = g.away.short || g.away.name;
  const M = [];
  M.push(mk('Main', '1x2', '1X2 (match result)', '1X2', [['home', `${H} win`, ens.home, 'Home'], ['draw', 'Draw', ens.draw, 'Draw'], ['away', `${A} win`, ens.away, 'Away']]));
  // SportyBet 1UP & 2UP early payout markets
  const p1upH = clamp(ens.home + ens.draw * 0.34 + (1 - ens.home - ens.draw) * 0.14, 0.08, 0.97);
  const p1upA = clamp(ens.away + ens.draw * 0.32 + (1 - ens.away - ens.draw) * 0.12, 0.08, 0.97);
  M.push(mk('Main', '1up', '1X2 - 1UP (lead by 1 = win)', '1X2 - 1UP', [['home', `${H} (1UP)`, p1upH, 'Home (1UP)'], ['away', `${A} (1UP)`, p1upA, 'Away (1UP)']]));
  const p2upH = clamp(ens.home + ens.draw * 0.08, 0.05, 0.95);
  const p2upA = clamp(ens.away + ens.draw * 0.07, 0.05, 0.95);
  M.push(mk('Main', '2up', '1X2 - 2UP (lead by 2 = win)', '1X2 - 2UP', [['home', `${H} (2UP)`, p2upH, 'Home (2UP)'], ['away', `${A} (2UP)`, p2upA, 'Away (2UP)']]));
  M.push(mk('Main', 'dc', 'Double chance', 'Double Chance', [
    ['1x', `${H} or draw`, ens.home + ens.draw, 'Home or Draw'],
    ['12', `${H} or ${A}`, ens.home + ens.away, 'Home or Away'],
    ['x2', `Draw or ${A}`, ens.draw + ens.away, 'Draw or Away'],
  ]));
  M.push(mk('Main', 'dnb', 'Draw no bet', 'Draw No Bet', [['home', H, ens.home / (ens.home + ens.away), 'Home'], ['away', A, ens.away / (ens.home + ens.away), 'Away']]));
  if (!sp?.grid) return M;
  const G = alignGrid(sp.grid, ens);
  M.push(mk('Main', 'hcp', 'Handicap (home -1)', 'Handicap', [
    ['h', `${H} win by 2+`, gridSum(G, (i, j) => i - j >= 2), 'Home (-1)'],
    ['d', `${H} win by exactly 1`, gridSum(G, (i, j) => i - j === 1), 'Draw (-1)'],
    ['a', `${A} win or draw`, gridSum(G, (i, j) => i - j <= 0), 'Away (+1)'],
  ]));
  const gg = gridSum(G, (i, j) => i > 0 && j > 0);
  M.push(mk('Goals', 'ggng', 'Both teams to score (GG/NG)', 'GG/NG', [['gg', 'GG (both score)', gg, 'GG'], ['ng', 'NG (not both)', 1 - gg, 'NG']]));
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    const o = gridSum(G, (i, j) => i + j > line);
    M.push(mk('Goals', `ou${line}`, `Total goals ${line}`, 'Over/Under', [['over', `Over ${line}`, o], ['under', `Under ${line}`, 1 - o]]));
  }
  for (const [side, name, idx] of [['home', H, 0], ['away', A, 1]]) {
    for (const line of [0.5, 1.5, 2.5]) {
      const o = gridSum(G, (i, j) => (idx === 0 ? i : j) > line);
      M.push(mk('Goals', `${side}ou${line}`, `${name} goals ${line}`, `${side === 'home' ? 'Home' : 'Away'} Team Over/Under`, [['over', `${name} over ${line}`, o, `Over ${line}`], ['under', `${name} under ${line}`, 1 - o, `Under ${line}`]]));
    }
  }
  const odd = gridSum(G, (i, j) => (i + j) % 2 === 1);
  M.push(mk('Goals', 'oddeven', 'Total goals odd/even', 'Odd/Even', [['odd', 'Odd', odd], ['even', 'Even', 1 - odd]]));
  M.push(mk('Goals', 'cs_h', 'Clean sheet', 'Clean Sheet', [
    ['h', `${H} clean sheet`, gridSum(G, (i, j) => j === 0), 'Home Yes'],
    ['a', `${A} clean sheet`, gridSum(G, (i, j) => i === 0), 'Away Yes'],
  ]));
  M.push(mk('Goals', 'wtn', 'Win to nil', 'Win to Nil', [
    ['h', `${H} win to nil`, gridSum(G, (i, j) => i > 0 && j === 0), 'Home'],
    ['a', `${A} win to nil`, gridSum(G, (i, j) => j > 0 && i === 0), 'Away'],
  ]));
  const cells = [];
  G.forEach((row, i) => row.forEach((p, j) => { if (i <= 6 && j <= 6) cells.push([`${i}-${j}`, p]); }));
  cells.sort((a, b) => b[1] - a[1]);
  M.push(mk('Goals', 'cs', 'Correct score (top 8)', 'Correct Score', cells.slice(0, 8).map(([s, p]) => [s, s, p, s])));
  // SportyBet Multiscores (Cluster Correct Scores)
  M.push(mk('Goals', 'multiscore', 'Multiscores (cluster correct score)', 'Multiscores', [
    ['1750', '1:0, 2:0 or 3:0', (G[1]?.[0] || 0) + (G[2]?.[0] || 0) + (G[3]?.[0] || 0), '1:0, 2:0 or 3:0'],
    ['1751', '0:1, 0:2 or 0:3', (G[0]?.[1] || 0) + (G[0]?.[2] || 0) + (G[0]?.[3] || 0), '0:1, 0:2 or 0:3'],
    ['1754', '2:1, 3:1 or 4:1', (G[2]?.[1] || 0) + (G[3]?.[1] || 0) + (G[4]?.[1] || 0), '2:1, 3:1 or 4:1'],
    ['1755', '1:2, 1:3 or 1:4', (G[1]?.[2] || 0) + (G[1]?.[3] || 0) + (G[1]?.[4] || 0), '1:2, 1:3 or 1:4'],
    ['draw_cs', '1:1, 2:2 or 3:3', (G[1]?.[1] || 0) + (G[2]?.[2] || 0) + (G[3]?.[3] || 0), '1:1, 2:2 or 3:3'],
  ]));

  const hf = htft(sp.lambda.home, sp.lambda.away, share);
  M.push(mk('Halves', 'ht1x2', '1st half result', '1st Half - 1X2', [['home', `${H} lead at HT`, hf.ht.H, 'Home'], ['draw', 'Level at HT', hf.ht.D, 'Draw'], ['away', `${A} lead at HT`, hf.ht.A, 'Away']]));
  M.push(mk('Halves', 'ht05', '1st half goals 0.5', '1st Half - Over/Under', [['over', '1H over 0.5', hf.o05, 'Over 0.5'], ['under', '1H under 0.5', 1 - hf.o05, 'Under 0.5']]));
  M.push(mk('Halves', 'ht15', '1st half goals 1.5', '1st Half - Over/Under', [['over', '1H over 1.5', hf.o15, 'Over 1.5'], ['under', '1H under 1.5', 1 - hf.o15, 'Under 1.5']]));
  const nm = { H, D: 'Draw', A };
  const htftSel = Object.entries(hf.htft).sort((a, b) => b[1] - a[1]).map(([k, p]) => [k, `${nm[k[0]]} / ${nm[k[1]]}`, p, `${{ H: 'Home', D: 'Draw', A: 'Away' }[k[0]]}/${{ H: 'Home', D: 'Draw', A: 'Away' }[k[1]]}`]);
  M.push(mk('Halves', 'htft', 'Half-time / full-time', 'HT/FT', htftSel));

  if (stm) {
    const groupOf = { corners: 'Corners', cards: 'Cards', shots: 'Shots', sot: 'Shots', fouls: 'Offsides & fouls', offsides: 'Offsides & fouls' };
    for (const [stat, cfg] of Object.entries(STATS)) {
      const d = stm.dist(stat, g);
      if (!d) continue;
      const grp = groupOf[stat];
      const eT = d.eH + d.eA;
      for (const line of linesNear(eT, cfg.lines, 3)) {
        const o = pOver(d.total, line);
        M.push(mk(grp, `${stat}ou${line}`, `Total ${cfg.name.toLowerCase()} ${line}`, `${cfg.name} - Over/Under`, [['over', `Over ${line} ${cfg.name.toLowerCase()}`, o, `Over ${line}`], ['under', `Under ${line} ${cfg.name.toLowerCase()}`, 1 - o, `Under ${line}`]]));
      }
      for (const [side, name, pmf, e] of [['home', H, d.home, d.eH], ['away', A, d.away, d.eA]]) {
        const line = linesNear(e, cfg.team, 1)[0];
        if (line === undefined) continue;
        const o = pOver(pmf, line);
        M.push(mk(grp, `${stat}${side}${line}`, `${name} ${cfg.name.toLowerCase()} ${line}`, `${side === 'home' ? 'Home' : 'Away'} ${cfg.name} - Over/Under`, [['over', `${name} over ${line}`, o, `Over ${line}`], ['under', `${name} under ${line}`, 1 - o, `Under ${line}`]]));
      }
      if (['corners', 'cards', 'shots', 'sot', 'fouls'].includes(stat)) {
        let ph = 0, pd = 0, pa = 0;
        d.home.forEach((x, i) => d.away.forEach((y, j) => { const p = x * y; if (i > j) ph += p; else if (i < j) pa += p; else pd += p; }));
        M.push(mk(grp, `${stat}_1x2`, `Most ${cfg.name.toLowerCase()} (1X2)`, `${cfg.name} 1X2`, [['home', `${H} most ${cfg.name.toLowerCase()}`, ph, 'Home'], ['draw', 'Equal', pd, 'Draw'], ['away', `${A} most ${cfg.name.toLowerCase()}`, pa, 'Away']]));
      }
      M.at(-1).expected = { home: +d.eH.toFixed(1), away: +d.eA.toFixed(1) };
    }

    // Tactical Throw-Ins & Goal Kicks Models (Goal Kicks driven by opponent off-target shot & cross pressure; Throw-Ins by touchline congestion, wing play & pressing)
    const cDist = stm.dist('corners', g);
    const fDist = stm.dist('fouls', g);
    const sDist = stm.dist('shots', g);
    const sotDist = stm.dist('sot', g);
    const tightness = 1 - Math.abs((ens.home || 0.45) - (ens.away || 0.30));

    const expThrowH = clamp(17.4 + ((cDist?.eH || 5.2) - 5.2) * 0.85 + ((fDist?.eH || 11.0) - 11.0) * 0.32 + tightness * 1.4, 11.5, 26.5);
    const expThrowA = clamp(16.9 + ((cDist?.eA || 4.6) - 4.6) * 0.85 + ((fDist?.eA || 11.2) - 11.2) * 0.32 + tightness * 1.4, 11.0, 26.0);
    const expThrowTot = expThrowH + expThrowA;
    for (const line of [33.5, 35.5, 37.5, 39.5]) {
      const pOv = 1 - normCdf((line - expThrowTot) / 5.2);
      M.push(mk('Throws & Goal Kicks', `throwins_ou${line}`, `Total throw-ins ${line}`, 'Throw-Ins Over/Under', [
        ['over', `Over ${line} throw-ins`, pOv, `Over ${line}`],
        ['under', `Under ${line} throw-ins`, 1 - pOv, `Under ${line}`],
      ]));
      M.at(-1).expected = { home: +expThrowH.toFixed(1), away: +expThrowA.toFixed(1) };
    }
    const p1HThrowOv = 1 - normCdf((17.5 - expThrowTot * 0.485) / 3.4);
    M.push(mk('Throws & Goal Kicks', 'throwins_1h_ou17.5', '1st half throw-ins 17.5', '1st Half Throw-Ins O/U', [
      ['over', '1H Over 17.5 throw-ins', p1HThrowOv, 'Over 17.5'],
      ['under', '1H Under 17.5 throw-ins', 1 - p1HThrowOv, 'Under 17.5'],
    ]));
    const pThrowDiff = 1 - normCdf((0.5 - (expThrowH - expThrowA)) / 4.6);
    const pThrowAway = 1 - normCdf((0.5 - (expThrowA - expThrowH)) / 4.6);
    const pThrowDraw = Math.max(0.04, 1 - pThrowDiff - pThrowAway);
    M.push(mk('Throws & Goal Kicks', 'throwins_1x2', 'Most throw-ins (1X2)', 'Throw-Ins 1X2', [
      ['home', `${H} most throw-ins`, pThrowDiff, 'Home'],
      ['draw', 'Equal throw-ins', pThrowDraw, 'Draw'],
      ['away', `${A} most throw-ins`, pThrowAway, 'Away'],
    ]));
    M.at(-1).expected = { home: +expThrowH.toFixed(1), away: +expThrowA.toFixed(1) };

    // Goal Kicks: Team A takes a goal kick whenever Team B misses the target or overhits crosses
    const homeMissed = Math.max(2.5, (sDist?.eH || 13.2) - (sotDist?.eH || 4.5));
    const awayMissed = Math.max(2.2, (sDist?.eA || 11.0) - (sotDist?.eA || 3.8));
    const expGkH = clamp(2.8 + 0.56 * awayMissed + 0.22 * (cDist?.eA || 4.6), 4.0, 14.5);
    const expGkA = clamp(3.0 + 0.56 * homeMissed + 0.22 * (cDist?.eH || 5.3), 4.2, 15.5);
    const expGkTot = expGkH + expGkA;
    for (const line of [14.5, 15.5, 16.5, 17.5]) {
      const pGkOv = 1 - normCdf((line - expGkTot) / 3.35);
      M.push(mk('Throws & Goal Kicks', `goalkicks_ou${line}`, `Total goal kicks ${line}`, 'Goal Kicks Over/Under', [
        ['over', `Over ${line} goal kicks`, pGkOv, `Over ${line}`],
        ['under', `Under ${line} goal kicks`, 1 - pGkOv, `Under ${line}`],
      ]));
      M.at(-1).expected = { home: +expGkH.toFixed(1), away: +expGkA.toFixed(1) };
    }
    const hGkLine = Math.floor(expGkH) + 0.5;
    const aGkLine = Math.floor(expGkA) + 0.5;
    const pHGkOv = 1 - normCdf((hGkLine - expGkH) / 2.35);
    const pAGkOv = 1 - normCdf((aGkLine - expGkA) / 2.35);
    M.push(mk('Throws & Goal Kicks', `goalkicks_home_ou${hGkLine}`, `${H} goal kicks ${hGkLine}`, 'Home Goal Kicks O/U', [
      ['over', `${H} over ${hGkLine} goal kicks`, pHGkOv, `Over ${hGkLine}`],
      ['under', `${H} under ${hGkLine} goal kicks`, 1 - pHGkOv, `Under ${hGkLine}`],
    ]));
    M.push(mk('Throws & Goal Kicks', `goalkicks_away_ou${aGkLine}`, `${A} goal kicks ${aGkLine}`, 'Away Goal Kicks O/U', [
      ['over', `${A} over ${aGkLine} goal kicks`, pAGkOv, `Over ${aGkLine}`],
      ['under', `${A} under ${aGkLine} goal kicks`, 1 - pAGkOv, `Under ${aGkLine}`],
    ]));
    const pGkHomeMost = 1 - normCdf((0.5 - (expGkH - expGkA)) / 3.1);
    const pGkAwayMost = 1 - normCdf((0.5 - (expGkA - expGkH)) / 3.1);
    const pGkDraw = Math.max(0.06, 1 - pGkHomeMost - pGkAwayMost);
    M.push(mk('Throws & Goal Kicks', 'goalkicks_1x2', 'Most goal kicks (1X2)', 'Goal Kicks 1X2', [
      ['home', `${H} most goal kicks`, pGkHomeMost, 'Home'],
      ['draw', 'Equal goal kicks', pGkDraw, 'Draw'],
      ['away', `${A} most goal kicks`, pGkAwayMost, 'Away'],
    ]));
    M.at(-1).expected = { home: +expGkH.toFixed(1), away: +expGkA.toFixed(1) };

    const pr = stm.pRed();
    if (pr !== null) M.push(mk('Cards', 'red', 'Red card shown', 'Red Card', [['yes', 'Yes, a red card', pr, 'Yes'], ['no', 'No red card', 1 - pr, 'No']]));
  }
  return M;
}

function goalsLeagueMarkets(g, ens, sp, league) {
  const H = g.home.short || g.home.name, A = g.away.short || g.away.name;
  const M = [mk('Main', 'ml', 'Moneyline (incl. OT)', 'Winner', [['home', `${H} win`, ens.home, 'Home'], ['away', `${A} win`, ens.away, 'Away']])];
  if (!sp?.grid) return M;
  const G = sp.grid;
  const reg = gridSum(G, (i, j) => i > j);
  const rl = gridSum(G, (i, j) => i - j >= 2);
  const lineName = league.sport === 'hockey' ? 'Puck line' : 'Run line';
  M.push(mk('Main', 'rl', `${lineName} ±1.5`, 'Handicap', [['home', `${H} -1.5`, rl, 'Home (-1.5)'], ['away', `${A} +1.5`, 1 - rl, 'Away (+1.5)']]));
  M.push(mk('Main', 'reg1x2', 'Regulation-time result', '1X2', [['home', `${H} win`, reg, 'Home'], ['draw', 'Draw (reg.)', gridSum(G, (i, j) => i === j), 'Draw'], ['away', `${A} win`, gridSum(G, (i, j) => i < j), 'Away']]));
  const total = sp.lambda.home + sp.lambda.away;
  for (const line of linesNear(total, [0.5, 20.5], 3)) {
    const o = gridSum(G, (i, j) => i + j > line);
    M.push(mk('Totals', `ou${line}`, `Total ${league.sport === 'hockey' ? 'goals' : 'runs'} ${line}`, 'Over/Under', [['over', `Over ${line}`, o], ['under', `Under ${line}`, 1 - o]]));
  }
  if (league.sport === 'hockey') {
    const gg = gridSum(G, (i, j) => i > 0 && j > 0);
    M.push(mk('Totals', 'ggng', 'Both teams to score', 'GG/NG', [['gg', 'GG', gg], ['ng', 'NG', 1 - gg]]));
  }
  return M;
}

function pointsMarkets(g, ens, sp, league) {
  const H = g.home.short || g.home.name, A = g.away.short || g.away.name;
  const M = [mk('Main', 'ml', 'Moneyline', 'Winner', [['home', `${H} win`, ens.home, 'Home'], ['away', `${A} win`, ens.away, 'Away']])];
  if (!sp) return M;
  const sigma = league.sigma;
  const mu = sigma * invNorm(ens.home); // margin implied by the ensemble
  const lines = new Set();
  if (Number.isFinite(g.odds?.spread)) lines.add(g.odds.spread);
  lines.add(Math.round(-mu * 2) / 2 + (Math.round(-mu * 2) % 2 === 0 ? 0.5 : 0));
  for (const line of [...lines].sort((a, b) => a - b)) {
    // home line e.g. -3.5 => home must win by more than 3.5
    const p = 1 - normCdf((-line - mu) / sigma);
    const fmt = (x) => (x > 0 ? `+${x}` : `${x}`);
    M.push(mk('Spread', `sp${line}`, `Spread ${H} ${fmt(line)}`, 'Handicap', [['home', `${H} ${fmt(line)}`, p, `Home (${fmt(line)})`], ['away', `${A} ${fmt(-line)}`, 1 - p, `Away (${fmt(-line)})`]]));
  }
  const tot = sp.lambda.home + sp.lambda.away;
  const tSig = league.totalSigma || sigma * 1.2;
  const tl = new Set();
  if (Number.isFinite(g.odds?.overUnder)) tl.add(g.odds.overUnder);
  tl.add(Math.floor(tot) + 0.5);
  for (const line of [...tl].sort((a, b) => a - b)) {
    const o = 1 - normCdf((line - tot) / tSig);
    M.push(mk('Totals', `ou${line}`, `Total points ${line}`, 'Over/Under', [['over', `Over ${line}`, o], ['under', `Under ${line}`, 1 - o]]));
  }
  return M;
}

function individualMarkets(g, ens, league) {
  const sel = [['home', g.home.name, ens.home, '1'], ['away', g.away.name, ens.away, '2']];
  if (league.draws && ens.draw > 0.01) sel.splice(1, 0, ['draw', 'Draw', ens.draw, 'Draw']);
  return [mk('Main', 'winner', 'Winner', 'Winner', sel)];
}

// ---------- league model ----------

/**
 * @param league   league config
 * @param history  chronological completed games
 * @param params   tunable params (see defaultParams)
 * @param opts     { light: skip stats/markets/final fit (fast, used by the evolver),
 *                   evalFrom/evalTo: fractions of the timeline used for evaluation }
 */
export function buildLeagueModel(league, history, params = null, opts = {}) {
  const P = { ...defaultParams(league), ...(params || {}) };
  const light = !!opts.light;
  const evalFrom = opts.evalFrom ?? 0.7;
  const evalTo = opts.evalTo ?? 1;
  const elo = new Elo(league, P);
  const sm = league.scoring === 'none' ? null : new ScoreModel(league, P);
  const stm = !light && league.sport === 'soccer' ? new StatsModel(league) : null;
  const form = new FormTracker(league);
  const names = new Map();
  const rows = [];
  const n = history.length;
  const split = Math.floor(n * evalFrom);
  const end = Math.floor(n * evalTo);

  for (let idx = 0; idx < n; idx++) {
    const g = history[idx];
    const inEval = idx >= split && idx < end;
    const ep = elo.predict(g);
    const sp = sm?.predict(g, !light && inEval) || null;
    const x = features(g, ep, sp, form);
    const row = { g, outcome: outcomeOf(g), elo: ep.probs, score: sp?.probs || null, x, market: g.odds?.implied || null };
    if (!light && inEval) {
      // market-level predictions for the backtest
      row.mk = {};
      if (sp?.grid) {
        if (league.sport === 'soccer') {
          row.mk.gg = { p: gridSum(sp.grid, (i, j) => i > 0 && j > 0), y: g.home.score > 0 && g.away.score > 0 ? 1 : 0 };
          row.mk.o25 = { p: gridSum(sp.grid, (i, j) => i + j > 2.5), y: g.home.score + g.away.score > 2.5 ? 1 : 0 };
          if (g.ht) {
            const hf = htft(sp.lambda.home, sp.lambda.away, sm.firstHalfShare());
            row.mk.ht05 = { p: hf.o05, y: g.ht.home + g.ht.away > 0.5 ? 1 : 0 };
          }
        } else {
          const line = league.sport === 'hockey' ? 5.5 : 8.5;
          row.mk.total = { p: gridSum(sp.grid, (i, j) => i + j > line), y: g.home.score + g.away.score > line ? 1 : 0, line };
        }
      }
      if (stm) {
        row.st = {};
        for (const stat of Object.keys(STATS)) {
          const vh = statValue(g.home, stat), va = statValue(g.away, stat);
          if (vh === null || va === null) continue;
          const d = stm.dist(stat, g);
          if (d) row.st[stat] = { e: d.eH + d.eA, total: d.total, y: vh + va };
        }
      }
    }
    rows.push(row);
    elo.update(g);
    sm?.update(g);
    stm?.update(g);
    form.update(g);
    names.set(g.home.id, { name: g.home.name, abbr: g.home.abbr, logo: g.home.logo });
    names.set(g.away.id, { name: g.away.name, abbr: g.away.abbr, logo: g.away.logo });
  }

  const warm = Math.floor(n * 0.12);
  const trainRows = rows.slice(warm, split);
  const holdout = rows.slice(split, end);
  const mlEnabled = trainRows.length >= 60;

  if (mlEnabled) {
    const evalModel = new MLModel(league, P).fit(trainRows);
    for (const r of holdout) r.ml = evalModel.predict(r.x).probs;
  }

  const metrics = {
    elo: score(holdout, (r) => r.elo),
    score: sm ? score(holdout, (r) => r.score) : { n: 0 },
    ml: mlEnabled ? score(holdout, (r) => r.ml) : { n: 0 },
  };

  const avail = Object.entries(metrics).filter(([, m]) => m.n >= 20);
  const minLL = Math.min(...avail.map(([, m]) => m.logLoss));
  const weights = {};
  for (const [k, m] of avail) weights[k] = Math.exp(-(m.logLoss - minLL) * P.temp);
  if (!avail.length) weights.elo = 1;
  const wSum = Object.values(weights).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(weights)) weights[k] = weights[k] / wSum;

  const ensOf = (r) => blend({ elo: r.elo, score: r.score, ml: r.ml }, weights, league.draws);
  metrics.ensemble = score(holdout, ensOf);

  if (light) return { metrics, weights, games: n, params: P };

  // ---- full model extras ----
  const withMarket = holdout.filter((r) => r.market);
  const vsMarket = withMarket.length >= 15
    ? { n: withMarket.length, market: score(withMarket, (r) => normalize(r.market, league.draws)), ensemble: score(withMarket, ensOf) }
    : null;

  // Market & stats backtests
  const marketBacktest = [];
  const addBin = (key, name, items) => { const s = scoreBinary(items); if (s) marketBacktest.push({ key, name, ...s }); };
  if (league.sport === 'soccer') {
    addBin('gg', 'GG/NG (both teams score)', holdout.filter((r) => r.mk?.gg).map((r) => r.mk.gg));
    addBin('o25', 'Over/Under 2.5 goals', holdout.filter((r) => r.mk?.o25).map((r) => r.mk.o25));
    addBin('ht05', '1st half over 0.5', holdout.filter((r) => r.mk?.ht05).map((r) => r.mk.ht05));
  } else if (sm && league.scoring === 'goals') {
    const line = league.sport === 'hockey' ? 5.5 : 8.5;
    addBin('total', `Over/Under ${line}`, holdout.filter((r) => r.mk?.total).map((r) => r.mk.total));
  }
  const statsBacktest = [];
  if (stm) {
    for (const [stat, cfg] of Object.entries(STATS)) {
      const items = holdout.filter((r) => r.st?.[stat]).map((r) => r.st[stat]);
      if (items.length < 30) continue;
      const meanY = items.reduce((s, x) => s + x.y, 0) / items.length;
      const line = Math.floor(meanY) + 0.5;
      const bin = scoreBinary(items.map((x) => ({ p: pOver(x.total, line), y: x.y > line ? 1 : 0 })));
      const mae = items.reduce((s, x) => s + Math.abs(x.e - x.y), 0) / items.length;
      const baseMae = items.reduce((s, x) => s + Math.abs(meanY - x.y), 0) / items.length;
      statsBacktest.push({ key: stat, name: cfg.name, n: items.length, avg: +meanY.toFixed(2), line, mae: +mae.toFixed(2), baseMae: +baseMae.toFixed(2), ...bin });
    }
  }

  // Drift check on history: is the most recent third of the holdout worse than before?
  const third = Math.floor(holdout.length / 3);
  const older = score(holdout.slice(0, holdout.length - third), ensOf);
  const latest = score(holdout.slice(-third), ensOf);
  const historyDrift = older.n && latest.n ? { older: older.brier, latest: latest.brier, delta: latest.brier - older.brier } : null;

  const ml = mlEnabled ? new MLModel(league, P).fit(rows.slice(warm)) : null;

  const recent = holdout.slice(-40).reverse().map((r) => {
    const p = ensOf(r);
    return {
      id: r.g.id, date: r.g.date,
      home: r.g.home.name, away: r.g.away.name,
      score: Number.isFinite(r.g.home.score) ? `${r.g.home.score}-${r.g.away.score}` : null,
      outcome: r.outcome, pick: pickOf(p), probs: p, correct: pickOf(p) === r.outcome,
    };
  });

  const trustRows = withMarket.map((r) => ({ ours: ensOf(r), market: normalize(r.market, league.draws), outcome: r.outcome }));
  const share = sm?.firstHalfShare() ?? 0.45;

  function predict(g, { markets = false } = {}) {
    const ep = elo.predict(g);
    const sp = sm?.predict(g, markets && league.scoring === 'goals') || null;
    const x = features(g, ep, sp, form);
    const mp = ml?.predict(x) || null;
    const ens = blend({ elo: ep.probs, score: sp?.probs, ml: mp?.probs }, weights, league.draws);
    const pick = pickOf(ens);
    const t = new Date(g.date).getTime();
    const fh = form.summary(g.home.id, t);
    const fa = form.summary(g.away.id, t);
    const out = {
      ensemble: { probs: ens, pick, confidence: ens[pick] },
      models: {
        elo: { probs: ep.probs, ratings: { home: ep.home, away: ep.away } },
        score: sp ? { ...sp, grid: undefined, lambda: undefined } : null,
        ml: mp,
      },
      form: { home: fh, away: fa },
      market: g.odds?.implied ? normalize(g.odds.implied, league.draws) : null,
      dataQuality: Math.min(fh.n, fa.n) >= 8 ? 'good' : Math.min(fh.n, fa.n) >= 3 ? 'limited' : 'low',
    };
    if (markets) {
      if (league.kind === 'individual') out.markets = individualMarkets(g, ens, league);
      else if (league.sport === 'soccer') out.markets = soccerMarkets(g, ens, sp, stm, share);
      else if (league.scoring === 'goals') out.markets = goalsLeagueMarkets(g, ens, sp, league);
      else out.markets = pointsMarkets(g, ens, sp, league);
    }
    return out;
  }

  /** Probabilities for the handful of markets the live tracker grades. */
  function trackedMarkets(g) {
    if (league.sport !== 'soccer' || !sm) return null;
    const ens = predict(g).ensemble.probs;
    const sp = sm.predict(g, true);
    if (!sp?.grid) return null;
    const G = alignGrid(sp.grid, ens);
    const out = { gg: gridSum(G, (i, j) => i > 0 && j > 0), o25: gridSum(G, (i, j) => i + j > 2.5) };
    const dc = stm?.dist('corners', g);
    if (dc) out.c95 = pOver(dc.total, 9.5);
    const dk = stm?.dist('cards', g);
    if (dk) out.k35 = pOver(dk.total, 3.5);
    return out;
  }

  return {
    predict,
    trackedMarkets,
    weights,
    metrics,
    vsMarket,
    marketBacktest,
    statsBacktest,
    historyDrift,
    trustRows,
    recent,
    params: P,
    games: n,
    holdoutSize: holdout.length,
    from: history[0]?.date || null,
    to: history.at(-1)?.date || null,
    featureImportance: ml?.importance() || [],
    rankings: () => elo.table(names).slice(0, 150),
  };
}

export { pickOf, OUTCOMES, normalize };
