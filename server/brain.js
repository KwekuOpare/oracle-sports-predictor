// The "brain": makes the predictor learn and grow over time.
//
//  1. Evolution      - a genetic algorithm searches each league's model settings
//                      (Elo K-factor, home advantage, memory half-life, ...).
//  2. Champion test  - a challenger is only promoted if it beats the current
//                      champion on games it never saw during evolution.
//  3. Growth timeline- every check-up / promotion is versioned and stored.
//  4. Trust weights  - learns how much to trust our models vs. the betting market
//                      vs. the Gemini analyst from graded results ("Smart pick").
//  5. Drift alarm    - if live accuracy falls below what the backtest promised,
//                      the brain retunes itself automatically.
// (AI lessons-from-mistakes live in lessons.js / ai.js.)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLeagueModel, defaultParams, PARAM_SPACE, normalize, OUTCOMES } from './models.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'brain');
const states = new Map(); // leagueId -> state
const running = new Map(); // leagueId -> { promise, progress }
const TIMELINE_MAX = 300;

const tick = () => new Promise((r) => setImmediate(r));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function blank(leagueId) {
  return { league: leagueId, champion: null, timeline: [], trust: null, drift: null, lastEvolved: null, lastCheck: null };
}

export async function getState(leagueId) {
  if (states.has(leagueId)) return states.get(leagueId);
  let s;
  try {
    s = { ...blank(leagueId), ...JSON.parse(await fs.readFile(path.join(DIR, `${leagueId}.json`), 'utf8')) };
  } catch {
    s = blank(leagueId);
  }
  states.set(leagueId, s);
  return s;
}

async function save(leagueId) {
  const s = states.get(leagueId);
  if (!s) return;
  if (s.timeline.length > TIMELINE_MAX) s.timeline = s.timeline.slice(-TIMELINE_MAX);
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(path.join(DIR, `${leagueId}.json`), JSON.stringify(s, null, 1));
}

// ---------- active leagues (the ones the brain keeps training) ----------

const ACTIVE_FILE = path.join(DIR, 'active.json');
let active = null;

export async function activeLeagues() {
  if (active) return active;
  try {
    active = JSON.parse(await fs.readFile(ACTIVE_FILE, 'utf8'));
  } catch {
    active = { nfl: Date.now(), 'eng.1': Date.now() };
  }
  return active;
}

export async function touch(leagueId) {
  const a = await activeLeagues();
  const isNew = !a[leagueId];
  a[leagueId] = Date.now();
  // forget leagues nobody looked at for 21 days (keeps background CPU low)
  for (const [k, t] of Object.entries(a)) if (Date.now() - t > 21 * 86400e3 && Object.keys(a).length > 2) delete a[k];
  if (isNew || Math.random() < 0.05) {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(ACTIVE_FILE, JSON.stringify(a));
  }
  return isNew;
}

// ---------- evolution (genetic algorithm) ----------

const KEYS = Object.keys(PARAM_SPACE);

function randomParams(league) {
  const p = {};
  for (const k of KEYS) {
    const [lo, hi] = PARAM_SPACE[k](league);
    p[k] = lo + Math.random() * (hi - lo);
  }
  return p;
}

function mutate(league, params, rate = 0.35, scale = 0.15) {
  const p = { ...params };
  for (const k of KEYS) {
    if (Math.random() > rate) continue;
    const [lo, hi] = PARAM_SPACE[k](league);
    // Box-Muller gaussian step
    const g = Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
    p[k] = clamp(p[k] + g * scale * (hi - lo), lo, hi);
  }
  return p;
}

function crossover(a, b) {
  const c = {};
  for (const k of KEYS) c[k] = Math.random() < 0.5 ? a[k] : b[k];
  return c;
}

function round(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) out[k] = +Number(v).toPrecision(4);
  return out;
}

function evaluate(league, history, params, evalFrom, evalTo) {
  const m = buildLeagueModel(league, history, params, { light: true, evalFrom, evalTo });
  const e = m.metrics.ensemble;
  return e?.n ? { logLoss: e.logLoss, accuracy: e.accuracy, brier: e.brier, n: e.n } : { logLoss: Infinity, accuracy: 0, brier: 1, n: 0 };
}

/**
 * Run one evolution cycle for a league.
 * Fitness = log loss on the 55%-85% slice of history; the final champion test
 * uses the most recent 15% of games, which evolution never looked at.
 */
export function evolve(league, history, { reason = 'scheduled', popSize = 10, generations = 6, onPromote } = {}) {
  if (running.has(league.id)) return running.get(league.id).promise;
  const status = { stage: 'starting', generation: 0, generations, evaluated: 0, startedAt: new Date().toISOString() };
  const promise = (async () => {
    const state = await getState(league.id);
    const base = defaultParams(league);
    const champ = { ...base, ...(state.champion?.params || {}) };
    if (history.length < 120) throw new Error('Not enough history to evolve');

    // Champion's current score on the test slice (re-measured: new games arrive all the time)
    status.stage = 'measuring champion';
    const champTest = evaluate(league, history, champ, 0.85, 1);
    await tick();

    let pop = [champ, base];
    while (pop.length < popSize) pop.push(pop.length < popSize * 0.7 ? mutate(league, champ, 0.6, 0.2) : randomParams(league));
    let scored = [];
    let bestEver = null;
    for (let gen = 0; gen < generations; gen++) {
      status.stage = 'evolving';
      status.generation = gen + 1;
      scored = [];
      for (const p of pop) {
        scored.push({ p, fit: evaluate(league, history, p, 0.55, 0.85) });
        status.evaluated++;
        await tick();
      }
      scored.sort((a, b) => a.fit.logLoss - b.fit.logLoss);
      if (!bestEver || scored[0].fit.logLoss < bestEver.fit.logLoss) bestEver = scored[0];
      status.best = { logLoss: +bestEver.fit.logLoss.toFixed(4), accuracy: +bestEver.fit.accuracy.toFixed(4) };
      // next generation: elitism 2 + tournament selection / crossover / mutation
      const pickParent = () => {
        let best = null;
        for (let i = 0; i < 3; i++) {
          const c = scored[Math.floor(Math.random() * scored.length)];
          if (!best || c.fit.logLoss < best.fit.logLoss) best = c;
        }
        return best.p;
      };
      const next = [scored[0].p, scored[1].p];
      while (next.length < popSize) next.push(mutate(league, crossover(pickParent(), pickParent())));
      pop = next;
    }

    status.stage = 'champion vs challenger';
    const challenger = bestEver.p;
    const challTest = evaluate(league, history, challenger, 0.85, 1);
    const promoted = challTest.logLoss < champTest.logLoss - 0.0005;
    const version = (state.champion?.version || 0) + (promoted ? 1 : 0);
    const winner = promoted ? challTest : champTest;
    if (promoted || !state.champion) {
      state.champion = { params: round(promoted ? challenger : champ), version: Math.max(version, 1), metrics: winner, promotedAt: new Date().toISOString() };
    } else {
      state.champion.metrics = champTest;
    }
    const entry = {
      date: new Date().toISOString(),
      version: state.champion.version,
      games: history.length,
      accuracy: +winner.accuracy.toFixed(4),
      logLoss: +winner.logLoss.toFixed(4),
      brier: +winner.brier.toFixed(4),
      n: winner.n,
      event: promoted ? 'promoted' : 'kept',
      reason,
      challenger: { accuracy: +challTest.accuracy.toFixed(4), logLoss: +challTest.logLoss.toFixed(4) },
      previous: { accuracy: +champTest.accuracy.toFixed(4), logLoss: +champTest.logLoss.toFixed(4) },
    };
    state.timeline.push(entry);
    state.lastEvolved = entry.date;
    await save(league.id);
    console.log(`[brain] ${league.id}: ${entry.event} v${entry.version} (test ll ${entry.previous.logLoss} -> challenger ${entry.challenger.logLoss}) [${reason}]`);
    if (promoted && onPromote) onPromote(league.id);
    return entry;
  })();
  running.set(league.id, { promise, status });
  promise.finally(() => running.delete(league.id)).catch(() => {});
  return promise;
}

export function evolveStatus(leagueId) {
  return running.get(leagueId)?.status || null;
}

/** Record a lightweight check-up point on the growth timeline (at most every 12h). */
export async function checkup(leagueId, model) {
  const state = await getState(leagueId);
  const last = state.timeline.at(-1);
  if (last && Date.now() - new Date(last.date).getTime() < 12 * 3600e3) return;
  const e = model.metrics.ensemble;
  if (!e?.n) return;
  state.timeline.push({
    date: new Date().toISOString(), version: state.champion?.version || 0, games: model.games,
    accuracy: +e.accuracy.toFixed(4), logLoss: +e.logLoss.toFixed(4), brier: +e.brier.toFixed(4), n: e.n, event: 'checkup',
  });
  await save(leagueId);
}

// ---------- trust weights: ours vs market vs AI ----------

const PRIOR = { ours: 0.5, market: 0.5, ai: 0.25 };
const SOURCES = ['ours', 'market', 'ai'];

function mix(row, w, draws) {
  const out = { home: 0, draw: 0, away: 0 };
  let tw = 0;
  for (const s of SOURCES) {
    if (!row[s] || !w[s]) continue;
    for (const o of OUTCOMES) out[o] += w[s] * (row[s][o] || 0);
    tw += w[s];
  }
  return tw ? normalize({ home: out.home / tw, draw: out.draw / tw, away: out.away / tw }, draws) : null;
}

function ll(rows, w, draws) {
  let s = 0, n = 0;
  for (const r of rows) {
    const p = mix(r, w, draws);
    if (!p) continue;
    s += -Math.log(clamp(p[r.outcome] || 0, 1e-6, 1));
    n++;
  }
  return n ? s / n : Infinity;
}

/**
 * Learn trust weights from graded rows [{ours, market?, ai?, outcome}] by grid
 * search over the weight simplex, shrunk towards a prior when data is scarce.
 */
export async function learnTrust(league, rows) {
  const state = await getState(league.id);
  const usable = rows.filter((r) => r.ours && r.outcome);
  const avail = SOURCES.filter((s) => usable.filter((r) => r[s]).length >= 10);
  const prior = Object.fromEntries(SOURCES.map((s) => [s, avail.includes(s) || s === 'ours' ? PRIOR[s] : 0]));
  let best = { ...prior }, bestLL = ll(usable, prior, league.draws);
  if (avail.length >= 2) {
    const steps = 20; // 0.05 grid on the weight simplex
    for (let a = 0; a <= steps; a++) {
      for (let b = 0; a + b <= steps; b++) {
        const c = steps - a - b;
        if (avail.length === 2 && c !== 0) continue;
        const vals = [a, b, c].map((x) => x / steps);
        const w = { ours: 0, market: 0, ai: 0 };
        avail.forEach((s, i) => { w[s] = vals[i]; });
        const v = ll(usable, w, league.draws);
        if (v < bestLL) { bestLL = v; best = w; }
      }
    }
  }
  // Shrink toward the prior: with few games we stay close to it.
  const n = usable.length, k = 40;
  const sumP = Object.values(prior).reduce((x, y) => x + y, 0) || 1;
  const sumB = Object.values(best).reduce((x, y) => x + y, 0) || 1;
  const weights = {};
  for (const s of SOURCES) weights[s] = +((n * (best[s] / sumB) + k * (prior[s] / sumP)) / (n + k)).toFixed(3);
  const perSource = {};
  for (const s of SOURCES) {
    const r = usable.filter((x) => x[s]);
    if (r.length) perSource[s] = { n: r.length, logLoss: +ll(r, { [s]: 1 }, league.draws).toFixed(4) };
  }
  state.trust = { weights, n, perSource, updatedAt: new Date().toISOString() };
  await save(league.id);
  return state.trust;
}

/** The "Smart pick": blend ours / market / AI with the learned trust weights. */
export function smartBlend(state, league, { ours, market, ai }) {
  const w = state?.trust?.weights || PRIOR;
  const p = mix({ ours, market, ai }, w, league.draws);
  if (!p) return null;
  const used = SOURCES.filter((s) => ({ ours, market, ai })[s] && w[s] > 0);
  return { probs: p, weights: w, used, learned: !!state?.trust && state.trust.n >= 10 };
}

// ---------- drift alarm ----------

/**
 * Compare live tracked accuracy with what the backtest promised.
 * Returns { status: 'ok'|'warning'|'alarm'|'waiting', ... }. 'alarm' => retune.
 */
export async function checkDrift(league, model, liveRows) {
  const state = await getState(league.id);
  const rows = liveRows.filter((r) => r.probs && r.result).slice(-40);
  const expected = model.metrics.ensemble?.brier;
  let live = null;
  if (rows.length) {
    let b = 0, c = 0;
    for (const r of rows) {
      for (const o of OUTCOMES) b += ((r.probs[o] || 0) - (r.result === o ? 1 : 0)) ** 2;
      const pick = OUTCOMES.reduce((x, o) => ((r.probs[o] || 0) > (r.probs[x] || 0) ? o : x), 'home');
      if (pick === r.result) c++;
    }
    live = { n: rows.length, brier: b / rows.length, accuracy: c / rows.length };
  }
  let status = 'waiting';
  let message = `Need ${Math.max(0, 25 - rows.length)} more graded live games to check drift.`;
  if (live && live.n >= 25 && Number.isFinite(expected)) {
    const d = live.brier - expected;
    if (d > 0.05) { status = 'alarm'; message = `Live Brier ${live.brier.toFixed(3)} is worse than backtest ${expected.toFixed(3)} — retuning.`; }
    else if (d > 0.025) { status = 'warning'; message = `Live results slightly worse than backtest (${live.brier.toFixed(3)} vs ${expected.toFixed(3)}).`; }
    else { status = 'ok'; message = `Live results match the backtest (${live.brier.toFixed(3)} vs ${expected.toFixed(3)}).`; }
  }
  if (status !== 'alarm' && model.historyDrift?.delta > 0.04) {
    status = 'warning';
    message = `Recent games are harder to predict than earlier ones (Brier +${model.historyDrift.delta.toFixed(3)}).`;
  }
  const prev = state.drift?.status;
  state.drift = { status, message, live, expected: expected ?? null, historyDrift: model.historyDrift, checkedAt: new Date().toISOString() };
  // Avoid retuning over and over: alarm triggers at most once per 24h
  const lastRetune = state.timeline.filter((t) => t.reason === 'drift-retune').at(-1);
  state.drift.retune = status === 'alarm' && (!lastRetune || Date.now() - new Date(lastRetune.date).getTime() > 24 * 3600e3);
  if (prev !== status || state.drift.retune) await save(league.id);
  return state.drift;
}

export async function summary(leagueId) {
  const s = await getState(leagueId);
  return {
    champion: s.champion,
    defaults: null,
    timeline: s.timeline,
    trust: s.trust,
    drift: s.drift,
    lastEvolved: s.lastEvolved,
    evolving: evolveStatus(leagueId),
    active: !!(await activeLeagues())[leagueId],
  };
}
