// Shared model cache. Every league model is built with the brain's current
// "champion" settings and rebuilt every 30 minutes (or right after the brain
// promotes new settings) so freshly finished games are learned.
import { getLeague } from './leagues.js';
import { getHistory } from './espn.js';
import { buildLeagueModel } from './models.js';
import * as brain from './brain.js';

const models = new Map(); // leagueId -> { expires, promise }
const TTL = 30 * 60e3;

export async function historyFor(league) {
  const extra = (league.pool || []).filter((p) => p !== league.id).map((p) => getLeague(p).path);
  return getHistory(league, extra);
}

export function getModel(league, { force = false } = {}) {
  const hit = models.get(league.id);
  if (!force && hit && hit.expires > Date.now()) return hit.promise;
  const promise = (async () => {
    const t0 = Date.now();
    const [history, state] = await Promise.all([historyFor(league), brain.getState(league.id)]);
    const model = buildLeagueModel(league, history, state.champion?.params || null);
    model.version = state.champion?.version || 0;
    console.log(`[model] ${league.id}: ${history.length} games, v${model.version}, built in ${Date.now() - t0}ms`);
    return model;
  })();
  models.set(league.id, { expires: Date.now() + TTL, promise });
  promise.catch(() => models.delete(league.id));
  return promise;
}

export function invalidate(leagueId) {
  models.delete(leagueId);
}

/** Model for a league if it is already built (no network / CPU work). */
export function peekModel(leagueId) {
  return models.get(leagueId)?.promise || null;
}
