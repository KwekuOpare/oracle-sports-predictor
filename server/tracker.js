// Live track record: stores the last pre-game prediction for every game the app
// shows, then grades it once the game is final. Compares our ensemble with the
// betting market and the Gemini analyst on exactly the same games, grades extra
// markets (GG, over 2.5, corners, cards) and measures whether AI lessons help.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickOf } from './models.js';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'predictions.json');
let db = null;
let dirty = false;

export const TRACKED_MARKETS = {
  gg: { name: 'GG (both teams score)', grade: (g) => (g.home.score > 0 && g.away.score > 0 ? 1 : 0) },
  o25: { name: 'Over 2.5 goals', grade: (g) => (g.home.score + g.away.score > 2.5 ? 1 : 0) },
  c95: { name: 'Over 9.5 corners', grade: (g) => (Number.isFinite(g.home.stats?.corners) && Number.isFinite(g.away.stats?.corners) ? (g.home.stats.corners + g.away.stats.corners > 9.5 ? 1 : 0) : null) },
  k35: { name: 'Over 3.5 cards', grade: (g) => (Number.isFinite(g.home.stats?.yellow) && Number.isFinite(g.away.stats?.yellow) ? (g.home.stats.yellow + g.home.stats.red + g.away.stats.yellow + g.away.stats.red > 3.5 ? 1 : 0) : null) },
};

async function load() {
  if (db) return db;
  try {
    db = JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    db = {};
  }
  return db;
}

async function save() {
  if (!dirty) return;
  dirty = false;
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(db));
}
setInterval(() => save().catch(() => {}), 10e3).unref();

function outcome(g) {
  if (g.home.winner) return 'home';
  if (g.away.winner) return 'away';
  if (Number.isFinite(g.home.score) && Number.isFinite(g.away.score)) {
    return g.home.score > g.away.score ? 'home' : g.home.score < g.away.score ? 'away' : 'draw';
  }
  return null;
}

/** Store pre-game predictions and grade any finished games. Returns newly graded records. */
export async function record(leagueId, games) {
  await load();
  const graded = [];
  for (const g of games) {
    const key = `${leagueId}:${g.id}`;
    if (g.state === 'pre' && g.prediction) {
      db[key] = {
        ...(db[key] || {}),
        league: leagueId, id: g.id, date: g.date,
        home: g.home.name, away: g.away.name,
        probs: g.prediction.ensemble.probs,
        market: g.prediction.market,
        version: g.prediction.version ?? db[key]?.version,
        ...(g.tracked ? { mk: g.tracked } : {}),
      };
      dirty = true;
    } else if (g.completed && db[key] && !db[key].result) {
      const o = outcome(g);
      if (o) {
        const r = db[key];
        r.result = o;
        r.score = Number.isFinite(g.home.score) ? `${g.home.score}-${g.away.score}` : null;
        r.gradedAt = new Date().toISOString();
        if (r.mk) {
          r.mkResult = {};
          for (const [k, def] of Object.entries(TRACKED_MARKETS)) {
            if (r.mk[k] === undefined) continue;
            const y = Number.isFinite(g.home.score) ? def.grade(g) : null;
            if (y !== null) r.mkResult[k] = y;
          }
        }
        dirty = true;
        graded.push(r);
      }
    }
  }
  return graded;
}

export async function recordAi(leagueId, game, ai) {
  await load();
  const key = `${leagueId}:${game.id}`;
  if (game.state !== 'pre' || !db[key]) return;
  db[key].ai = ai.probabilities;
  db[key].aiLessons = ai.lessonsUsed || 0;
  db[key].aiWithheld = !!ai.lessonsWithheld;
  dirty = true;
}

const espnDay = (iso, offsetDays = 0) => {
  // ESPN groups games by US Eastern date; approximate with UTC-5.
  const d = new Date(new Date(iso).getTime() - 5 * 3600e3 + offsetDays * 86400e3);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
};

/**
 * Grade predictions whose games should be over, by fetching the scoreboard for
 * their dates (so the record fills in even if nobody opens the app).
 */
export async function gradePending(getLeague, getScoreboard) {
  await load();
  const now = Date.now();
  const pending = Object.values(db).filter((r) => !r.result && r.date && now - new Date(r.date).getTime() > 3 * 3600e3 && now - new Date(r.date).getTime() < 10 * 86400e3);
  const groups = new Map();
  for (const r of pending) {
    const k = `${r.league}|${espnDay(r.date)}`;
    if (!groups.has(k)) groups.set(k, r);
  }
  const graded = [];
  for (const k of groups.keys()) {
    const [leagueId, day] = k.split('|');
    let league;
    try { league = getLeague(leagueId); } catch { continue; }
    try {
      const games = await getScoreboard(league, day);
      graded.push(...(await record(leagueId, games)));
    } catch (e) {
      console.warn('[tracker] grading failed', k, e.message);
    }
  }
  // Very old pending records (postponed / not found): drop after 10 days
  for (const [key, r] of Object.entries(db)) if (!r.result && r.date && now - new Date(r.date).getTime() > 10 * 86400e3) { delete db[key]; dirty = true; }
  return graded;
}

/** Graded rows for one league, oldest first. */
export async function gradedRows(leagueId) {
  await load();
  return Object.values(db).filter((r) => r.league === leagueId && r.result).sort((a, b) => new Date(a.date) - new Date(b.date));
}

/** Confident misses that deserve a post-mortem lesson. */
export async function lessonCandidates(max = 3) {
  await load();
  return Object.values(db)
    .filter((r) => r.result && !r.lessonDone && Date.now() - new Date(r.date).getTime() < 5 * 86400e3)
    .filter((r) => {
      const ours = r.probs[pickOf(r.probs)];
      const aiConf = r.ai ? r.ai[pickOf(r.ai)] : 0;
      return (pickOf(r.probs) !== r.result && ours >= 0.6) || (r.ai && pickOf(r.ai) !== r.result && aiConf >= 0.6);
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, max);
}

export async function markLessonDone(rec) {
  await load();
  const r = db[`${rec.league}:${rec.id}`];
  if (r) { r.lessonDone = true; dirty = true; }
}

function grade(rows, field) {
  const r = rows.filter((x) => x[field]);
  if (!r.length) return { n: 0 };
  let correct = 0, brier = 0;
  for (const x of r) {
    const p = x[field];
    if (pickOf(p) === x.result) correct++;
    for (const o of ['home', 'draw', 'away']) brier += ((p[o] || 0) - (x.result === o ? 1 : 0)) ** 2;
  }
  return { n: r.length, accuracy: correct / r.length, brier: brier / r.length };
}

function gradeMarkets(rows) {
  const out = [];
  for (const [k, def] of Object.entries(TRACKED_MARKETS)) {
    const r = rows.filter((x) => x.mk?.[k] !== undefined && x.mkResult?.[k] !== undefined);
    if (!r.length) continue;
    let correct = 0, brier = 0, yes = 0;
    for (const x of r) {
      const p = x.mk[k], y = x.mkResult[k];
      if ((p >= 0.5 ? 1 : 0) === y) correct++;
      brier += (p - y) ** 2;
      yes += y;
    }
    out.push({ key: k, name: def.name, n: r.length, accuracy: correct / r.length, brier: brier / r.length, baseAccuracy: Math.max(yes, r.length - yes) / r.length });
  }
  return out;
}

export async function stats() {
  await load();
  const all = Object.values(db);
  const graded = all.filter((x) => x.result);
  const byLeague = {};
  for (const x of graded) (byLeague[x.league] ||= []).push(x);
  const aiRows = graded.filter((x) => x.ai);
  return {
    tracked: all.length,
    graded: graded.length,
    pending: all.length - graded.length,
    overall: { ours: grade(graded, 'probs'), market: grade(graded, 'market'), ai: grade(graded, 'ai') },
    markets: gradeMarkets(graded),
    aiLessons: {
      with: grade(aiRows.filter((x) => x.aiLessons > 0), 'ai'),
      without: grade(aiRows.filter((x) => !x.aiLessons), 'ai'),
      withheld: grade(aiRows.filter((x) => x.aiWithheld), 'ai'),
    },
    leagues: Object.fromEntries(
      Object.entries(byLeague).map(([k, rows]) => [k, { ours: grade(rows, 'probs'), market: grade(rows, 'market'), ai: grade(rows, 'ai') }])
    ),
    recent: graded
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 50)
      .map((x) => ({ ...x, pick: pickOf(x.probs), correct: pickOf(x.probs) === x.result })),
  };
}
