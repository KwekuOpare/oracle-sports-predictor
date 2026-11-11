// Background loop that keeps the brain learning without anyone clicking anything.
//  every 30 min : grade finished games, rebuild models with new results, learn
//                 trust weights, check for drift, write AI lessons, fetch offsides
//  every 6 h    : evolve active leagues (genetic algorithm + champion test)
import { getLeague } from './leagues.js';
import { getScoreboard, enrichOffsides } from './espn.js';
import { getModel, historyFor, invalidate } from './engine.js';
import * as brain from './brain.js';
import * as tracker from './tracker.js';
import * as lessons from './lessons.js';
import { aiEnabled, generateLesson } from './ai.js';
import * as arena from './arena.js';
import * as tickets from './tickets.js';

let busy = false;
const log = (...a) => console.log('[scheduler]', ...a);

export async function evolveLeague(leagueId, reason = 'manual') {
  const league = getLeague(leagueId);
  const history = await historyFor(league);
  return brain.evolve(league, history, { reason, onPromote: (id) => invalidate(id) });
}

export async function learnLeague(leagueId) {
  const league = getLeague(leagueId);
  const model = await getModel(league);
  const live = await tracker.gradedRows(leagueId);
  // trust: backtest rows (where historical odds exist) + live graded rows
  const rows = [
    ...model.trustRows,
    ...live.map((r) => ({ ours: r.probs, market: r.market, ai: r.ai, outcome: r.result })),
  ];
  await brain.learnTrust(league, rows);
  await brain.checkup(leagueId, model);
  const drift = await brain.checkDrift(league, model, live);
  if (drift.retune) {
    log(`${leagueId}: drift alarm -> retuning`);
    evolveLeague(leagueId, 'drift-retune').catch((e) => log('retune failed', e.message));
  }
  return drift;
}

async function writeLessons() {
  if (!aiEnabled()) return;
  for (const rec of await tracker.lessonCandidates(3)) {
    try {
      if (!(await lessons.has(rec.league, rec.id))) {
        const l = await generateLesson(getLeague(rec.league), rec);
        if (l) { await lessons.add(l); log(`lesson for ${rec.league} ${rec.home} v ${rec.away}: ${l.lesson}`); }
      }
    } catch (e) {
      log('lesson failed', e.message);
    }
    await tracker.markLessonDone(rec);
  }
}

export async function shortCycle() {
  if (busy) return;
  busy = true;
  try {
    const freshTickets = await tickets.getCuratedTickets(false, 'all').catch(() => []);
    if (freshTickets.length) {
      await arena.registerTickets(freshTickets, { source: 'live_cooked', defaultStakeGHS: 100 }).catch(() => {});
    }
    await arena.syncArena({ force: true }).catch((e) => log('arena sync warning:', e.message));
    const graded = await tracker.gradePending(getLeague, getScoreboard);
    if (graded.length) log(`graded ${graded.length} finished games`);
    const touched = new Set(graded.map((r) => r.league));
    for (const id of touched) invalidate(id); // relearn with the new results
    const active = Object.keys(await brain.activeLeagues());
    for (const id of active) {
      try {
        const league = getLeague(id);
        await learnLeague(id);
        if (league.sport === 'soccer') {
          const history = await historyFor(league);
          const n = await enrichOffsides(history, 150);
          if (n) { log(`${id}: +${n} offsides records`); invalidate(id); }
        }
      } catch (e) {
        log(`${id} failed:`, e.message);
      }
    }
    await writeLessons();
  } finally {
    busy = false;
  }
}

export async function longCycle() {
  const active = Object.keys(await brain.activeLeagues());
  for (const id of active) {
    const s = await brain.getState(id);
    if (s.lastEvolved && Date.now() - new Date(s.lastEvolved).getTime() < 5.5 * 3600e3) continue;
    try {
      await evolveLeague(id, 'scheduled');
    } catch (e) {
      log(`evolve ${id} failed:`, e.message);
    }
  }
}

export function start() {
  setTimeout(() => arena.syncArena({ force: true }).catch((e) => log(e.message)), 8e3).unref();
  setTimeout(() => shortCycle().catch((e) => log(e.message)), 25e3).unref();
  setTimeout(() => longCycle().catch((e) => log(e.message)), 60e3).unref();
  setInterval(() => arena.syncArena({ force: true }).catch((e) => log(e.message)), 5 * 60e3).unref();
  setInterval(() => shortCycle().catch((e) => log(e.message)), 30 * 60e3).unref();
  setInterval(() => longCycle().catch((e) => log(e.message)), 6 * 3600e3).unref();
  log('started (arena live-settlement every 5 min, learn every 30 min, evolve every 6 h)');
}
