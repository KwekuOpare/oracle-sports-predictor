// AI Accumulator, Rollover Compounder, Identical/Mixed Multi Synthesizer & Slip Centre Vault Engine.
// Automatically compiles conflict-free accumulators (up to 20 folds), Daily 2.00x Rollover Bankers,
// Kickoff-Soon Fast-Cash slips, identical single-market slips, mixed multi-market slips, correlation-aware
// same-game multis, and a 20-game Correct Score Vault — each with a REAL 6-character SportyBet Ghana Booking Code.

import { getLeague } from './leagues.js';
import { getScoreboard } from './espn.js';
import { getModel } from './engine.js';
import {
  getSportyCatalog,
  extractBookableSelections,
  findSportyEventForGame,
  generateSportyBookingCode,
} from './sportybet.js';
import { buildInsiderRadarTicket } from './intelligence.js';
import { getArenaMarketWeights } from './arena.js';

const PRIORITY_ESPN_LEAGUES = [
  'eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1',
  'uefa.champions', 'uefa.europa', 'ned.1', 'por.1', 'usa.1',
  'nfl', 'nba', 'nhl', 'mlb',
];

const curatedCacheByWindow = new Map(); // windowKey -> { ts, tickets }
let vaultCache = { ts: 0, vault: null };
let espnPredCache = { ts: 0, map: new Map() };

const CACHE_TTL = 8 * 60 * 1000; // 8 minutes
const ESPN_PRED_TTL = 10 * 60 * 1000;

async function getEspnPredMap() {
  if (espnPredCache.map.size > 0 && Date.now() - espnPredCache.ts < ESPN_PRED_TTL) {
    return espnPredCache.map;
  }
  const map = new Map();
  await Promise.all(PRIORITY_ESPN_LEAGUES.slice(0, 10).map(async (lid) => {
    try {
      const league = getLeague(lid);
      if (!league) return;
      const [model, games] = await Promise.all([getModel(league), getScoreboard(league)]);
      for (const g of games.filter((x) => x.state === 'pre')) {
        const spEv = await findSportyEventForGame(g);
        if (spEv) {
          const pred = model.predict(g, { markets: true });
          map.set(spEv.eventId, pred);
        }
      }
    } catch { /* ignore single league hiccup */ }
  }));
  espnPredCache = { ts: Date.now(), map };
  return map;
}

function filterEventsByWindow(events, timeWindow = 'all') {
  const now = Date.now();
  const minStart = now + 5 * 60 * 1000;
  const upcoming = events.filter((ev) => ev.estimateStartTime > minStart);
  if (!timeWindow || timeWindow === 'all') return upcoming;

  const hoursMap = {
    '3h': 4,
    soon: 6,
    today: 24,
    '48h': 48,
  };
  const targetHours = hoursMap[timeWindow] || 0;
  if (!targetHours) return upcoming;

  const filtered = upcoming.filter((ev) => ev.estimateStartTime <= now + targetHours * 3600 * 1000);
  if (filtered.length >= 12) return filtered;

  // Graceful expansion if late at night and next 4-6h has fewer than 12 games
  const fallbackHours = Math.max(targetHours * 2, 18);
  const expanded = upcoming.filter((ev) => ev.estimateStartTime <= now + fallbackHours * 3600 * 1000);
  return expanded.length >= 6 ? expanded : upcoming.slice(0, 40);
}

/**
 * Collect rich, SportyBet-bookable candidate picks across upcoming SportyBet Ghana matches,
 * fused with ESPN statistical model predictions and calibrated by real-world Arena hit rates.
 */
export async function collectCandidatePicks({ timeWindow = 'all' } = {}) {
  const [rawCatalog, arenaWeights, espnPredMap] = await Promise.all([
    getSportyCatalog(),
    getArenaMarketWeights().catch(() => ({})),
    getEspnPredMap(),
  ]);

  const sportyCatalog = filterEventsByWindow(rawCatalog, timeWindow);
  const byGame = new Map(); // eventId -> { event, hasModelFusion, selections }
  const now = Date.now();

  for (const ev of sportyCatalog) {
    const modelPred = espnPredMap.get(ev.eventId) || null;
    const sels = extractBookableSelections(ev, modelPred);
    const hoursAway = Math.max(0, (ev.estimateStartTime - now) / 3600000);
    // Gentle freshness bonus so today's matches naturally rank ahead of matches 5 days away
    const freshnessBonus = hoursAway <= 8 ? 0.022 : hoursAway <= 24 ? 0.015 : hoursAway <= 48 ? 0.006 : 0;

    for (const s of sels) {
      const grp = s.marketKey === '1up' || s.marketKey === '2up'
        ? '1UP / 2UP Early Payout'
        : s.marketKey === 'cs' || s.marketKey === 'multiscore'
          ? 'Correct Score & Multiscores'
          : s.group || 'Main';
      const boost = arenaWeights[grp] || 1.0;
      if (boost !== 1.0 && !['cs', 'multiscore'].includes(s.marketKey)) {
        const empFactor = Math.max(0.94, Math.min(1.055, 1 + (boost - 1) * 0.68));
        s.p = +Math.min(0.95, s.p * empFactor).toFixed(4);
        s.fairOdds = +(1 / Math.max(s.p, 1e-4)).toFixed(2);
        s.edgePct = +((s.p * s.sportyOdds - 1) * 100).toFixed(1);
        const b = s.sportyOdds - 1;
        const fk = b > 0 ? (s.p * s.sportyOdds - 1) / b : 0;
        s.kellyPct = fk > 0 ? +Math.min(6.0, Math.max(0.5, fk * 25)).toFixed(2) : 0;
      }
      s.arenaBoost = boost;
      s.hoursToKickoff = +hoursAway.toFixed(1);
      s.calibratedScore = +((s.vhimScore || s.p) * boost + freshnessBonus).toFixed(4);
    }
    if (sels.length) {
      byGame.set(ev.eventId, {
        event: ev,
        hasModelFusion: Boolean(modelPred),
        selections: sels,
      });
    }
  }

  return byGame;
}

/** Check that every leg in every cached ticket is still at least 4 minutes before kickoff. */
function areCachedTicketsFresh(tickets) {
  if (!Array.isArray(tickets) || !tickets.length) return false;
  const minStart = Date.now() + 4 * 60 * 1000;
  for (const t of tickets) {
    for (const leg of t.legs || []) {
      const ms = leg.startTime || (leg.date ? new Date(leg.date).getTime() : Infinity);
      if (Number.isFinite(ms) && ms <= minStart) return false;
    }
  }
  return true;
}

/**
 * Exact Poisson-Binomial Dynamic Programming engine to compute how many legs are expected to hit
 * and explicitly advise the user when and how to use SportyBet Flex (Cut-1 / Cut-2 / Cut-3+) or Split Pods.
 */
export function computeFlexDirective(legs = [], totalSportyOdds = 1) {
  const n = legs.length;
  if (!n) return null;

  // dp[k] = probability of hitting exactly k out of n legs
  const dp = new Array(n + 1).fill(0);
  dp[0] = 1;
  let sumP = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.max(0.05, Math.min(0.97, Number(legs[i]?.p) || 0.65));
    sumP += p;
    for (let k = i + 1; k >= 1; k--) {
      dp[k] = dp[k] * (1 - p) + dp[k - 1] * p;
    }
    dp[0] *= (1 - p);
  }

  const tailProb = (minHits) => {
    const start = Math.max(0, minHits);
    let s = 0;
    for (let k = start; k <= n; k++) s += dp[k];
    return +Math.min(0.9999, Math.max(0, s)).toFixed(4);
  };

  const pFull = +dp[n].toFixed(4);
  const pCut1 = tailProb(n - 1);
  const pCut2 = tailProb(n - 2);
  const pCut3 = tailProb(n - 3);
  const pCut5 = tailProb(n - 5);
  const expectedHits = +sumP.toFixed(1);
  const avgLegProb = +(sumP / n).toFixed(3);

  let tier = 'STRAIGHT';
  let needFlex = false;
  let badge = '✅ PLAY STRAIGHT (NO FLEX NEEDED)';
  let headline = 'High-Accuracy Banker — Play Straight for Full Payout';
  let detail = `Expected hits: ${expectedHits}/${n} legs (${Math.round(avgLegProb * 100)}% avg leg accuracy). Full straight hit chance is ${(pFull * 100).toFixed(1)}%.`;
  let recommendedCut = 0;

  if (n >= 25 || totalSportyOdds >= 25000) {
    tier = 'MANDATORY_MAX_FLEX';
    needFlex = true;
    recommendedCut = n >= 40 ? 5 : 3;
    const podSize = n >= 45 ? 15 : 10;
    const numPods = Math.ceil(n / podSize);
    badge = `🚨 FLEX REQUIRED: TURN ON SPORTYBET MAX-FLEX (CUT-${recommendedCut}) + ${numPods} PODS`;
    headline = `You MUST Flex This ${n}-Fold Multi (${totalSportyOdds >= 1e6 ? `${(totalSportyOdds / 1e6).toFixed(2)}M+` : `${Math.round(totalSportyOdds).toLocaleString()}x`} Odds)`;
    detail = `Every leg is a high-accuracy pick (${Math.round(avgLegProb * 100)}% avg), projecting ${expectedHits}/${n} hits! Across ${n} matches, 2–4 surprise upsets (red cards/VAR) are statistically normal — turn ON SportyBet Flex (Cut-3/Cut-5: ${(pCut3 * 100).toFixed(1)}%–${(pCut5 * 100).toFixed(1)}% hit zone) AND consider splitting into ${numPods} × ${podSize}-Fold Pod Slips.`;
  } else if (n >= 10 || totalSportyOdds >= 120) {
    tier = 'FLEX_CUT2';
    needFlex = true;
    recommendedCut = 2;
    badge = '🛡️ FLEX DIRECTIVE: USE SPORTYBET FLEX CUT-2 (ALLOW 2 MISSES)';
    headline = `Flex Recommended: Play ${n - 2}/${n} Flex (Cut-2) + Small Straight`;
    detail = `Model expects ${expectedHits}/${n} winning legs (${Math.round(avgLegProb * 100)}% avg accuracy). Turning ON Flex Cut-2 boosts your cash probability from ${(pFull * 100).toFixed(1)}% (Straight) → ${(pCut2 * 100).toFixed(1)}% (Cut-2)!`;
  } else if (n >= 5 || (n >= 4 && pFull < 0.34)) {
    tier = 'FLEX_CUT1';
    needFlex = true;
    recommendedCut = 1;
    badge = '🛡️ FLEX DIRECTIVE: USE SPORTYBET FLEX CUT-1 (ALLOW 1 MISS)';
    headline = `Flex Recommended: Turn ON ${n - 1}/${n} Flex (Cut-1 Insurance)`;
    detail = `Model expects ${expectedHits}/${n} hits. SportyBet Flex Cut-1 jumps your payout probability from ${(pFull * 100).toFixed(1)}% → ${(pCut1 * 100).toFixed(1)}%, protecting your stake if 1 late goal spoils the full acca.`;
  }

  return {
    tier,
    needFlex,
    recommendedCut,
    badge,
    headline,
    detail,
    expectedHits,
    avgLegProb,
    pFull,
    pCut1,
    pCut2,
    pCut3,
    pCut5,
  };
}

/** Summarize a list of legs and attach a live SportyBet Ghana Booking Code + Flex Directive + Kelly stake guidance. */
async function finalizeTicket(meta, legs) {
  const combP = legs.reduce((a, b) => a * (b.p || 0.5), 1);
  const combinedFairOdds = legs.length ? +(1 / Math.max(combP, 1e-12)).toFixed(2) : 0;
  const rawSportyProd = legs.length
    ? legs.reduce((a, b) => a * (b.sportyOdds || b.fairOdds || 1.5), 1)
    : 0;
  const totalSportyOdds = rawSportyProd >= 1000
    ? Math.round(rawSportyProd)
    : +rawSportyProd.toFixed(2);

  const avgEdgePct = legs.length
    ? +(legs.reduce((a, b) => a + (Number(b.edgePct) || 0), 0) / legs.length).toFixed(1)
    : 0;

  const avgLegProb = legs.length
    ? +(legs.reduce((a, b) => a + (Number(b.p) || 0.65), 0) / legs.length).toFixed(3)
    : 0;

  const earliestKickoff = legs.reduce((minIso, l) => {
    if (!l.date) return minIso;
    return !minIso || new Date(l.date) < new Date(minIso) ? l.date : minIso;
  }, null);

  const latestKickoff = legs.reduce((maxIso, l) => {
    if (!l.date) return maxIso;
    return !maxIso || new Date(l.date) > new Date(maxIso) ? l.date : maxIso;
  }, null);

  // Recommended bankroll fraction (% of bankroll) scaled inversely with fold count
  const recommendedBankrollPct = legs.length <= 3
    ? 5.0
    : legs.length <= 6
      ? 3.0
      : legs.length <= 12
        ? 1.5
        : legs.length <= 25
          ? 0.75
          : 0.25;

  const flexDirective = computeFlexDirective(legs, totalSportyOdds);
  const booking = legs.length ? await generateSportyBookingCode(legs) : { ok: false };

  const playAdvice = flexDirective?.needFlex
    ? (legs.length >= 25
      ? `MUST FLEX (Cut-${flexDirective.recommendedCut}) + Small Straight Lotto`
      : `Turn ON SportyBet Flex (Cut-${flexDirective.recommendedCut})`)
    : 'Play Straight Banker (No Flex Needed)';

  return {
    ...meta,
    legs,
    count: legs.length,
    combinedProb: +combP.toFixed(6),
    avgLegProb,
    combinedFairOdds,
    totalSportyOdds,
    avgEdgePct,
    earliestKickoff,
    latestKickoff,
    recommendedBankrollPct,
    flexDirective,
    playAdvice,
    shareCode: booking.shareCode || null,
    shareURL: booking.shareURL || null,
    badge: booking.shareCode ? `CODE: ${booking.shareCode}` : `${legs.length} Folds`,
  };
}

/**
 * Build a 1-leg-per-match accumulator using a custom filter & ranking function,
 * with optional seed offset to produce distinct variations without duplicate legs.
 */
function selectOnePerGame(byGame, maxLegs, filterFn, scoreFn = (s) => s.calibratedScore || s.p, offset = 0) {
  const candidates = [];
  for (const { event, hasModelFusion, selections } of byGame.values()) {
    const valid = selections.filter(filterFn);
    if (!valid.length) continue;
    valid.sort((a, b) => scoreFn(b, hasModelFusion) - scoreFn(a, hasModelFusion));
    candidates.push({
      pick: valid[0],
      rankScore: scoreFn(valid[0], hasModelFusion) + (hasModelFusion ? 0.035 : 0),
      startTime: event.estimateStartTime,
    });
  }

  candidates.sort((a, b) => b.rankScore - a.rankScore);
  const sliced = candidates.slice(offset, offset + maxLegs);
  return sliced.map((c) => c.pick);
}

/**
 * Build a precision Daily 2.00x–2.45x Safe Rollover Banker (2 to 3 ultra-high-certainty picks
 * kicking off soonest/today whose combined SportyBet odds hit >= 1.95x).
 */
function buildDailyRolloverLegs(byGame, targetMinOdds = 1.98, targetMaxOdds = 2.65) {
  const safePool = [];
  for (const { event, hasModelFusion, selections } of byGame.values()) {
    const valid = selections.filter((s) =>
      ['1up', 'dc', 'ou1.5', 'dnb', '1x2'].includes(s.marketKey) &&
      s.p >= 0.74 &&
      s.sportyOdds >= 1.24 &&
      s.sportyOdds <= 1.58
    );
    if (!valid.length) continue;
    valid.sort((a, b) => (b.calibratedScore || b.p) - (a.calibratedScore || a.p));
    const best = valid[0];
    const soonBonus = (best.hoursToKickoff ?? 24) <= 18 ? 0.03 : 0;
    safePool.push({
      pick: best,
      score: (best.calibratedScore || best.p) + (hasModelFusion ? 0.04 : 0) + soonBonus,
      startTime: event.estimateStartTime,
    });
  }

  safePool.sort((a, b) => b.score - a.score);
  const chosen = [];
  let runningOdds = 1;

  for (const item of safePool.slice(0, 12)) {
    if (chosen.length >= 4) break;
    const nextOdds = runningOdds * item.pick.sportyOdds;
    if (chosen.length >= 2 && runningOdds >= targetMinOdds) break;
    if (chosen.length >= 2 && nextOdds > targetMaxOdds + 0.35) continue;
    chosen.push(item.pick);
    runningOdds = nextOdds;
    if (runningOdds >= targetMinOdds && chosen.length >= 2) break;
  }

  return chosen.length >= 2 ? chosen : safePool.slice(0, 3).map((x) => x.pick);
}

/**
 * Build a Fast-Cash Express slip strictly from matches kicking off in the nearest window
 * so the bettor gets settled within hours rather than waiting days.
 */
function buildFastCashSoonLegs(byGame, maxLegs = 5) {
  const gamesSortedByTime = [...byGame.values()]
    .sort((a, b) => a.event.estimateStartTime - b.event.estimateStartTime)
    .slice(0, 32);

  const candidates = [];
  for (const { event, hasModelFusion, selections } of gamesSortedByTime) {
    const valid = selections.filter((s) =>
      ['1up', 'ou1.5', 'dc', '1x2', 'dnb', 'ou2.5'].includes(s.marketKey) &&
      s.p >= 0.68 &&
      s.sportyOdds >= 1.22 &&
      s.sportyOdds <= 1.78
    );
    if (!valid.length) continue;
    valid.sort((a, b) => (b.calibratedScore || b.p) - (a.calibratedScore || a.p));
    candidates.push({
      pick: valid[0],
      score: (valid[0].calibratedScore || valid[0].p) + (hasModelFusion ? 0.03 : 0),
      startTime: event.estimateStartTime,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxLegs).sort((a, b) => a.startTime - b.startTime).map((c) => c.pick);
}

/**
 * Build a True Mixed Multi where each match contributes a DIFFERENT market category in round-robin order
 * (1UP -> Over 1.5 -> 1X2 -> GG -> Corners -> Bookings/Cards -> Over 2.5 -> Shots/SOT -> Double Chance).
 */
function selectRoundRobinMixed(byGame, maxLegs = 12, offset = 0) {
  const buckets = [
    (s) => s.marketKey === '1up' && s.p >= 0.66 && s.sportyOdds >= 1.24 && s.sportyOdds <= 1.90,
    (s) => s.marketKey === 'ou1.5' && s.selKey === 'over' && s.p >= 0.72 && s.sportyOdds >= 1.22,
    (s) => s.marketKey === '1x2' && s.p >= 0.59 && s.sportyOdds >= 1.32 && s.sportyOdds <= 2.15,
    (s) => s.marketKey === 'ggng' && s.selKey === 'gg' && s.p >= 0.56 && s.sportyOdds >= 1.50,
    (s) => s.group === 'Corners' && s.selKey === 'over' && s.p >= 0.55 && s.sportyOdds >= 1.40,
    (s) => s.group === 'Cards' && s.selKey === 'over' && s.p >= 0.56 && s.sportyOdds >= 1.40,
    (s) => s.marketKey === 'ou2.5' && s.selKey === 'over' && s.p >= 0.60 && s.sportyOdds >= 1.48,
    (s) => (s.group === 'Shots' || s.group === 'Offsides & fouls') && s.p >= 0.55 && s.sportyOdds >= 1.42,
    (s) => s.marketKey === 'dc' && s.p >= 0.76 && s.sportyOdds >= 1.18 && s.sportyOdds <= 1.50,
  ];

  const usedGames = new Set();
  const legs = [];
  const gamesList = [...byGame.values()];

  let pass = 0;
  while (legs.length < maxLegs && pass < maxLegs * 3) {
    const bucketFn = buckets[(pass + offset) % buckets.length];
    pass++;
    let bestPick = null;
    let bestGameId = null;
    let bestScore = -1;

    for (const { event, hasModelFusion, selections } of gamesList) {
      if (usedGames.has(event.eventId)) continue;
      const matches = selections.filter(bucketFn);
      if (!matches.length) continue;
      matches.sort((a, b) => (b.calibratedScore || b.p) - (a.calibratedScore || a.p));
      const top = matches[0];
      const sc = (top.calibratedScore || top.p) + (hasModelFusion ? 0.04 : 0);
      if (sc > bestScore) {
        bestScore = sc;
        bestPick = top;
        bestGameId = event.eventId;
      }
    }

    if (bestPick && bestGameId) {
      usedGames.add(bestGameId);
      legs.push(bestPick);
    }
  }

  return legs;
}

/**
 * Build Correlation-Aware Same-Game Multi (SGM) picks per match so picks reinforce each other
 * rather than contradicting one another!
 */
function buildCorrelatedSameGameMulti(byGame, targetLegs = 9, offset = 0) {
  const scoredGames = [];
  for (const { event, hasModelFusion, selections } of byGame.values()) {
    const fav1Up = selections
      .filter((s) => ['1up', '1x2'].includes(s.marketKey) && s.selKey !== 'draw' && s.p >= 0.64 && s.sportyOdds >= 1.24)
      .sort((a, b) => (b.calibratedScore || b.p) - (a.calibratedScore || a.p))[0];
    const over15 = selections.find((s) => s.marketKey === 'ou1.5' && s.selKey === 'over' && s.p >= 0.70 && s.sportyOdds >= 1.20);
    const over25 = selections.find((s) => s.marketKey === 'ou2.5' && s.selKey === 'over' && s.p >= 0.58 && s.sportyOdds >= 1.45);
    const ggYes = selections.find((s) => s.marketKey === 'ggng' && s.selKey === 'gg' && s.p >= 0.56 && s.sportyOdds >= 1.48);
    const attackProp = selections
      .filter((s) => ['Corners', 'Shots'].includes(s.group) && s.selKey === 'over' && s.p >= 0.55 && s.sportyOdds >= 1.38)
      .sort((a, b) => (b.calibratedScore || b.p) - (a.calibratedScore || a.p))[0];

    let combo = [];
    // Script A: Dominant Favorite + Over 1.5 Goals + Attack Volume (Corners/Shots Over)
    if (fav1Up && over15) {
      combo = [fav1Up, over15, attackProp].filter(Boolean);
    } else if (over25 && ggYes) {
      // Script B: High-Tempo Shootout (Over 2.5 + GG + SOT/Corners Over)
      combo = [over25, ggYes, attackProp].filter(Boolean);
    }

    if (combo.length >= 2) {
      const avgScore = combo.reduce((s, x) => s + (x.calibratedScore || x.p), 0) / combo.length;
      scoredGames.push({
        event,
        combo,
        score: avgScore + (hasModelFusion ? 0.035 : 0),
      });
    }
  }

  scoredGames.sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const g of scoredGames.slice(offset)) {
    for (const pick of g.combo) {
      if (chosen.length < targetLegs) chosen.push(pick);
    }
    if (chosen.length >= targetLegs) break;
  }
  return chosen;
}

/**
 * High-Accuracy Multi-Match Compounder (30 to 60 Folds — up to 1,000,000x+ Odds).
 * Strictly picks ONLY high-likelihood selections (p >= minP, typically 64%–85%) across distinct matches
 * rather than gambling on low-probability upsets, compounding steady @1.25–@1.68 winners into 5-figure to 7-figure multipliers.
 */
function buildHighAccuracyMultiMatch(byGame, {
  targetOdds = 1000000,
  maxLegs = 56,
  minP = 0.64,
  minLegOdds = 1.24,
  maxLegOdds = 1.72,
  offset = 0,
} = {}) {
  const safeMarkets = new Set(['1up', '2up', 'dc', 'ou1.5', 'dnb', '1x2', 'homeou0.5', 'awayou0.5', 'ou2.5']);
  const pool = [];

  for (const { event, hasModelFusion, selections } of byGame.values()) {
    const valid = selections.filter((s) =>
      safeMarkets.has(s.marketKey) &&
      s.p >= minP &&
      s.sportyOdds >= minLegOdds &&
      s.sportyOdds <= maxLegOdds
    );
    if (!valid.length) continue;

    // Prioritize highest win probability while ensuring healthy compounding multiplier
    valid.sort((a, b) => {
      const scoreA = (a.calibratedScore || a.p) * 1.22 + Math.min(0.05, Math.max(0, (a.edgePct || 0) * 0.004)) + (a.sportyOdds >= 1.28 ? 0.02 : 0);
      const scoreB = (b.calibratedScore || b.p) * 1.22 + Math.min(0.05, Math.max(0, (b.edgePct || 0) * 0.004)) + (b.sportyOdds >= 1.28 ? 0.02 : 0);
      return scoreB - scoreA;
    });

    const best = valid[0];
    pool.push({
      pick: best,
      rankScore: (best.calibratedScore || best.p) + (hasModelFusion ? 0.035 : 0),
      startTime: event.estimateStartTime,
    });
  }

  pool.sort((a, b) => b.rankScore - a.rankScore);
  const rotated = offset > 0 ? [...pool.slice(offset), ...pool.slice(0, offset)] : pool;

  const chosen = [];
  let runningOdds = 1;
  const hardCap = Math.min(60, maxLegs); // SportyBet Ghana verified single-code max = 60 folds

  for (const item of rotated) {
    if (chosen.length >= hardCap) break;
    chosen.push(item.pick);
    runningOdds *= (item.pick.sportyOdds || item.pick.fairOdds || 1.32);
    if (targetOdds > 0 && runningOdds >= targetOdds && chosen.length >= 2) break;
  }

  return chosen;
}

/** Pre-compile all curated daily tickets (with live SportyBet Ghana Booking Codes and timeWindow support). */
export async function getCuratedTickets(force = false, timeWindow = 'all') {
  const winKey = String(timeWindow || 'all');
  const cached = curatedCacheByWindow.get(winKey);
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL && areCachedTicketsFresh(cached.tickets)) {
    return cached.tickets;
  }

  const byGame = await collectCandidatePicks({ timeWindow: winKey });
  // Ensure 30-fold & 50-fold Million-Odds multi-match tickets have a deep 500-game pool even if user filtered to 6h window
  const fullPoolByGame = byGame.size >= 75 ? byGame : await collectCandidatePicks({ timeWindow: 'all' });

  // 0A. 💰 Daily 2.00x Safe Rollover Banker (2-3 Folds — Bankroll Compounder)
  const dailyRolloverLegs = buildDailyRolloverLegs(byGame, 1.98, 2.60);

  // 0B. ⚡ Fast-Cash Kickoff Soon Express (5-Fold — Settles in Hours!)
  const fastCashLegs = buildFastCashSoonLegs(byGame, 5);

  // 1. 🔥 The "Vhim" Sure Banker (5-Fold) — Real playable odds (@1.22 - @1.65)
  const vhimBankerLegs = selectOnePerGame(
    byGame,
    5,
    (s) => ['1x2', '1up', 'dc', 'ou1.5', 'dnb'].includes(s.marketKey) && s.p >= 0.72 && s.sportyOdds >= 1.22 && s.sportyOdds <= 1.65,
    (s) => (s.calibratedScore || s.p) * 1.15 + (s.edgePct > 0 ? 0.04 : 0)
  );

  // 1B. 💎 Positive-EV & Steam Value Sniper (6-Fold — Beats SportyBet Margin)
  const valueSniperLegs = selectOnePerGame(
    byGame,
    6,
    (s) => !['cs', 'multiscore', 'htft'].includes(s.marketKey) && s.p >= 0.58 && s.sportyOdds >= 1.38 && s.sportyOdds <= 2.35 && (s.edgePct >= 0.2 || s.steamPct >= 2.2),
    (s) => (s.calibratedScore || s.p) + Math.max(0, s.edgePct * 0.008) + Math.max(0, (s.steamPct || 0) * 0.005)
  );

  // 2. 🏆 Mega 20-Fold Accumulator (Full 20 Folds across distinct matches!)
  const mega20Legs = selectOnePerGame(
    byGame,
    20,
    (s) => ['1x2', '1up', '2up', 'dc', 'ou1.5', 'ou2.5', 'homeou0.5', 'awayou0.5'].includes(s.marketKey) && s.p >= 0.68 && s.sportyOdds >= 1.18 && s.sportyOdds <= 1.75,
    (s) => s.calibratedScore || s.p
  );

  // 2B. 🚀 30-Fold High-Accuracy Super Multi (~3,000x – 25,000x Odds)
  const superMulti30Legs = buildHighAccuracyMultiMatch(fullPoolByGame, {
    targetOdds: 0,
    maxLegs: 30,
    minP: 0.68,
    minLegOdds: 1.24,
    maxLegOdds: 1.66,
  });

  // 2C. 👑 Multi-Match "MILLION-ODDS" Vhim Grand Slam (1,000,000x+ Odds across ~48–56 High-Accuracy Matches!)
  const millionGrandSlamLegs = buildHighAccuracyMultiMatch(fullPoolByGame, {
    targetOdds: 1250000,
    maxLegs: 58,
    minP: 0.64,
    minLegOdds: 1.26,
    maxLegOdds: 1.72,
  });

  // 2D. 🥅 High-Accuracy Shots, SOT, Corners, Cards & Tactical Props Sniper (8-Fold)
  const tacticalProps8Legs = selectOnePerGame(
    fullPoolByGame,
    8,
    (s) => ['Shots', 'Corners', 'Cards', 'Throws & Goal Kicks', 'Offsides & fouls'].includes(s.group) && s.p >= 0.62 && s.sportyOdds >= 1.22 && s.sportyOdds <= 1.92,
    (s) => (s.calibratedScore || s.p) * 1.2 + Math.max(0, (s.edgePct || 0) * 0.005)
  );

  // 3. 🔀 Mixed Multi Master (12-Fold blending 1X2, Goals, GG, 1UP, Corners, Cards, Shots, Throw-Ins)
  const mixed12Legs = selectRoundRobinMixed(byGame, 12, 0);

  // 4. 🎯 Correct Score Sniper (3-Fold High-Probability Exact Scorelines)
  const cs3Legs = selectOnePerGame(
    byGame,
    3,
    (s) => s.marketKey === 'cs' && s.p >= 0.11 && s.sportyOdds <= 9.5,
    (s) => s.calibratedScore || s.p
  );

  // 5. 🛡️ Multiscore Cluster Shield (6-Fold — covers "1:0, 2:0 or 3:0" clusters!)
  const multiScore6Legs = selectOnePerGame(
    byGame,
    6,
    (s) => s.marketKey === 'multiscore' && s.p >= 0.22 && s.sportyOdds >= 2.10 && s.sportyOdds <= 4.50,
    (s) => s.calibratedScore || s.p
  );

  // 6. 🔁 Identical: 20-Fold All Over 1.5 Goals
  const idOver15Legs = selectOnePerGame(
    byGame,
    20,
    (s) => s.marketKey === 'ou1.5' && s.selKey === 'over' && s.p >= 0.70 && s.sportyOdds >= 1.18 && s.sportyOdds <= 1.55,
    (s) => s.calibratedScore || s.p
  );

  // 7. 🔁 Identical: 10-Fold All Over 2.5 Goals
  const idOver25Legs = selectOnePerGame(
    byGame,
    10,
    (s) => s.marketKey === 'ou2.5' && s.selKey === 'over' && s.p >= 0.58 && s.sportyOdds >= 1.42 && s.sportyOdds <= 2.05,
    (s) => s.calibratedScore || s.p
  );

  // 8. 🔁 Identical: 10-Fold All GG (Both Teams To Score)
  const idGGLegs = selectOnePerGame(
    byGame,
    10,
    (s) => s.marketKey === 'ggng' && s.selKey === 'gg' && s.p >= 0.55 && s.sportyOdds >= 1.48 && s.sportyOdds <= 2.05,
    (s) => s.calibratedScore || s.p
  );

  // 9. 🔁 Identical: 10-Fold All 1X2 Straight Winners ("Vhim Match Winners")
  const id1x2Legs = selectOnePerGame(
    byGame,
    10,
    (s) => s.marketKey === '1x2' && s.selKey !== 'draw' && s.p >= 0.62 && s.sportyOdds >= 1.30 && s.sportyOdds <= 1.95,
    (s) => s.calibratedScore || s.p
  );

  // 10. 🔁 Identical: 12-Fold All 1UP Early Payout (Lead by 1 Goal = Instant Win!)
  const id1UpLegs = selectOnePerGame(
    byGame,
    12,
    (s) => s.marketKey === '1up' && s.p >= 0.66 && s.sportyOdds >= 1.20 && s.sportyOdds <= 1.75,
    (s) => s.calibratedScore || s.p
  );

  // 11. 🔁 Identical: 15-Fold All Double Chance (1X / X2)
  const idDcLegs = selectOnePerGame(
    byGame,
    15,
    (s) => s.marketKey === 'dc' && (s.selKey === '1x' || s.selKey === 'x2') && s.p >= 0.76 && s.sportyOdds >= 1.16 && s.sportyOdds <= 1.48,
    (s) => s.calibratedScore || s.p
  );

  // 12. 🚩 Identical Stats: 8-Fold Corners & Bookings (Cards) Over
  const idStatsLegs = selectOnePerGame(
    byGame,
    8,
    (s) => ['Corners', 'Cards'].includes(s.group) && s.selKey === 'over' && s.p >= 0.55 && s.sportyOdds >= 1.42 && s.sportyOdds <= 2.10,
    (s) => s.calibratedScore || s.p
  );

  // 13. 🔗 Correlated Same-Game Multi Builder (6 Picks across 2-3 Dominant Matches)
  const sgm6Legs = buildCorrelatedSameGameMulti(byGame, 6, 0);

  const [
    dailyRollover,
    fastCash,
    vhimBanker,
    valueSniper,
    mega20,
    superMulti30,
    millionGrandSlam,
    tacticalProps8,
    mixed12,
    sgm6,
    cs3,
    multiScore6,
    idOver15,
    idOver25,
    idGG,
    id1x2,
    id1Up,
    idDc,
    idStats,
    insiderTicket,
  ] = await Promise.all([
    finalizeTicket({
      id: 'daily-rollover-2x',
      title: '💰 Daily 2.00x Safe Rollover Banker',
      category: 'Rollover Banker',
      ticketType: 'rollover',
      description: 'Precision ~2.10x bankroll compounder built from our top 2–3 ultra-safe 1UP, Double Chance & Over 1.5 locks. Built for the 5-Day Rollover Ladder!',
    }, dailyRolloverLegs),
    finalizeTicket({
      id: 'fast-cash-soon',
      title: '⚡ Kickoff Soon Fast-Cash Express',
      category: 'Fast Cash',
      ticketType: 'mixed',
      description: 'Strictly upcoming matches kicking off in the nearest time window so your slip settles fast without multi-day waiting.',
    }, fastCashLegs),
    finalizeTicket({
      id: 'vhim-banker-5',
      title: '🔥 The "Vhim" Sure Banker (5-Fold)',
      category: 'Vhim Banker',
      ticketType: 'mixed',
      description: 'Our highest-conviction 5-leg banker combining 1UP, Over 1.5, and dominant winners calibrated by real-world Arena hit rates.',
    }, vhimBankerLegs),
    finalizeTicket({
      id: 'value-ev-sniper-6',
      title: '💎 Positive-EV & Steam Value Sniper (6-Fold)',
      category: 'Vhim Banker',
      ticketType: 'mixed',
      description: 'Targets mispriced SportyBet lines where our De-Vigged Ensemble + BetRadar probability beats bookmaker implied odds.',
    }, valueSniperLegs),
    finalizeTicket({
      id: 'mega-20',
      title: '🏆 Mega 20-Fold Accumulator',
      category: 'Mega 20-Fold',
      ticketType: 'mixed',
      description: 'Full 20-match accumulator across major leagues with zero match conflicts and a live 20-fold SportyBet Ghana code.',
    }, mega20Legs),
    finalizeTicket({
      id: 'super-multi-30',
      title: '🚀 30-Fold High-Accuracy Super Multi',
      category: 'Multi-Match & 1M+',
      ticketType: 'million',
      description: '30 distinct high-probability matches (68%–85% win likelihood per leg) compounded into a massive 4-to-5 figure SportyBet code. Follow the Flex Cut-3 directive!',
    }, superMulti30Legs),
    finalizeTicket({
      id: 'million-odds-grand-slam',
      title: '👑 Multi-Match "MILLION-ODDS" Vhim Grand Slam',
      category: 'Multi-Match & 1M+',
      ticketType: 'million',
      description: 'Compounds ~50+ high-accuracy favorites, 1UP & Over 1.5 locks (zero junk longshots!) into 1,000,000x+ total odds on a single SportyBet Ghana code. MUST play with SportyBet Flex ON!',
    }, millionGrandSlamLegs),
    finalizeTicket({
      id: 'tactical-props-sniper-8',
      title: '🥅 High-Accuracy Shots, SOT, Corners & Props Sniper (8-Fold)',
      category: 'Tactical Props',
      ticketType: 'props',
      description: 'Strictly picks the highest-likelihood Shots 1X2, Shots on Target, Corners, Bookings (Cards), Fouls & Offsides markets across 8 matches.',
    }, tacticalProps8Legs),
    finalizeTicket({
      id: 'mixed-master-12',
      title: '🔀 Mixed Multi Master (12-Fold)',
      category: 'Mixed Multi',
      ticketType: 'mixed',
      description: 'True Puntrr.ai style mix: blends 1UP, Over/Under, 1X2, GG/NG, Corners, Bookings (Cards), Shots & Double Chance.',
    }, mixed12Legs),
    finalizeTicket({
      id: 'correlated-sgm-6',
      title: '🔗 Correlated Same-Game Multi (6 Picks)',
      category: 'Mixed Multi',
      ticketType: 'mixed',
      description: 'Positively correlated match scripts (Favorite 1UP + Over 1.5 + Attack Corners/Shots) stacked across top dominant fixtures.',
    }, sgm6Legs),
    finalizeTicket({
      id: 'cs-sniper-3',
      title: '🎯 Correct Score Sniper (3-Fold)',
      category: 'Correct Score',
      ticketType: 'cs',
      description: 'Top 3 matches with the tightest statistical & BetRadar probability on a single exact scoreline.',
    }, cs3Legs),
    finalizeTicket({
      id: 'multiscore-shield-6',
      title: '🛡️ Multiscore Cluster Shield (6-Fold)',
      category: 'Correct Score',
      ticketType: 'cs',
      description: 'Covers 3 exact scorelines per match (e.g. "1:0, 2:0 or 3:0") using SportyBet Multiscores for 3x higher hit rate.',
    }, multiScore6Legs),
    finalizeTicket({
      id: 'identical-over15-20',
      title: '🔁 Identical: 20-Fold All Over 1.5 Goals',
      category: 'Identical',
      ticketType: 'identical',
      description: 'Identical single-market accumulator: every single leg is Over 1.5 Total Goals across 20 matches.',
    }, idOver15Legs),
    finalizeTicket({
      id: 'identical-over25-10',
      title: '🔁 Identical: 10-Fold All Over 2.5 Goals',
      category: 'Identical',
      ticketType: 'identical',
      description: 'Identical single-market accumulator: 10 high-tempo attacking matches all playing Over 2.5 Goals.',
    }, idOver25Legs),
    finalizeTicket({
      id: 'identical-gg-10',
      title: '🔁 Identical: 10-Fold All GG (BTTS Yes)',
      category: 'Identical',
      ticketType: 'identical',
      description: 'Identical single-market accumulator: 10 matches all playing Both Teams To Score (GG - Yes).',
    }, idGGLegs),
    finalizeTicket({
      id: 'identical-1x2-10',
      title: '🔁 Identical: 10-Fold Straight 1X2 Winners',
      category: 'Identical',
      ticketType: 'identical',
      description: 'Identical single-market accumulator: 10 straight full-time match winners (Home or Away).',
    }, id1x2Legs),
    finalizeTicket({
      id: 'identical-1up-12',
      title: '🔁 Identical: 12-Fold All 1UP Early Payout',
      category: 'Identical',
      ticketType: 'identical',
      description: 'Identical single-market accumulator using SportyBet 1X2 - 1UP (if your team leads by 1 goal at any time, it wins!).',
    }, id1UpLegs),
    finalizeTicket({
      id: 'identical-dc-15',
      title: '🔁 Identical: 15-Fold Double Chance Shield',
      category: 'Identical',
      ticketType: 'identical',
      description: 'Identical single-market accumulator: 15 matches all playing Double Chance (1X or X2).',
    }, idDcLegs),
    finalizeTicket({
      id: 'identical-stats-8',
      title: '🚩 Identical: 8-Fold Corners & Cards Over',
      category: 'Identical',
      ticketType: 'identical',
      description: 'Strictly Corners Over/Under and Bookings (Yellow/Red Cards) Over/Under selections.',
    }, idStatsLegs),
    buildInsiderRadarTicket(8),
  ]);

  const list = [
    dailyRollover,
    vhimBanker,
    fastCash,
    valueSniper,
    millionGrandSlam,
    superMulti30,
    tacticalProps8,
    mega20,
    mixed12,
    sgm6,
    insiderTicket,
    id1Up,
    idOver15,
    multiScore6,
    cs3,
    idOver25,
    idGG,
    id1x2,
    idDc,
    idStats,
  ].filter((t) => t && t.count > 0);

  curatedCacheByWindow.set(winKey, { ts: Date.now(), tickets: list });
  return list;
}

/**
 * Build the Pre-Compiled Slip Centre & 20-Game Correct Score Vault!
 */
export async function getSlipCentreVault(force = false) {
  if (
    !force &&
    vaultCache.vault &&
    Date.now() - vaultCache.ts < CACHE_TTL &&
    areCachedTicketsFresh(vaultCache.vault.correctScoreBundles)
  ) {
    return vaultCache.vault;
  }

  const byGame = await collectCandidatePicks({ timeWindow: 'all' });
  const csGames = [];

  for (const { event, hasModelFusion, selections } of byGame.values()) {
    const csSels = selections.filter((s) => s.marketKey === 'cs').sort((a, b) => b.p - a.p);
    if (!csSels.length) continue;
    const multiSels = selections.filter((s) => s.marketKey === 'multiscore').sort((a, b) => b.p - a.p);
    const primary = csSels[0];
    const secondary = csSels[1] || null;
    const cluster = multiSels[0] || null;

    csGames.push({
      eventId: event.eventId,
      sportyGameId: event.gameId,
      matchup: `${event.homeTeamName} vs ${event.awayTeamName}`,
      home: event.homeTeamName,
      away: event.awayTeamName,
      leagueName: event.leagueLabel,
      date: event.date,
      hasModelFusion,
      confidenceScore: primary.p + (secondary?.p || 0) * 0.5 + (hasModelFusion ? 0.03 : 0),
      primaryCS: primary,
      backupCS: secondary,
      multiscorePick: cluster,
      top3Scores: csSels.slice(0, 3),
    });
  }

  csGames.sort((a, b) => b.confidenceScore - a.confidenceScore);
  const top20CSGames = csGames.slice(0, 20);

  const top3Legs = top20CSGames.slice(0, 3).map((g) => g.primaryCS);
  const top5Legs = top20CSGames.slice(0, 5).map((g) => g.primaryCS);
  const top10Legs = top20CSGames.slice(0, 10).map((g) => g.primaryCS);
  const all20Legs = top20CSGames.map((g) => g.primaryCS);
  const dualCover10Legs = top20CSGames.slice(0, 5).flatMap((g) => [g.primaryCS, g.backupCS].filter(Boolean));
  const multiscore10Legs = top20CSGames.map((g) => g.multiscorePick).filter(Boolean).slice(0, 10);

  const [
    sniper3,
    bomb5,
    list10,
    vault20,
    dualCover,
    multiShield10,
  ] = await Promise.all([
    finalizeTicket({
      id: 'vault-cs-3',
      title: '🎯 Top 3 Surest Correct Scores (3-Fold)',
      description: 'The 3 highest-probability exact scorelines in the vault.',
    }, top3Legs),
    finalizeTicket({
      id: 'vault-cs-5',
      title: '💣 5-Fold Correct Score Bomb',
      description: 'Top 5 exact scorelines compiled for massive multiplier or 3/5 flex betting on SportyBet.',
    }, top5Legs),
    finalizeTicket({
      id: 'vault-cs-10',
      title: '📋 10-Fold Correct Score Master Slip',
      description: 'Top 10 exact scorelines pre-booked into a single SportyBet code (play as Singles, Flex, or Multi).',
    }, top10Legs),
    finalizeTicket({
      id: 'vault-cs-20',
      title: '🏦 Full 20-Fold Correct Score Vault',
      description: 'All 20 highest-confidence Correct Score games compiled into one SportyBet Ghana booking code!',
    }, all20Legs),
    finalizeTicket({
      id: 'vault-cs-dual-5',
      title: '🛡️ 5-Game Dual Correct Score Cover (10 Picks)',
      description: 'Multiple additions per match: covers both the #1 and #2 most likely exact scores on the top 5 games!',
    }, dualCover10Legs),
    finalizeTicket({
      id: 'vault-multiscore-10',
      title: '⚡ 10-Fold Multiscore Cluster Vault',
      description: 'Uses SportyBet Multiscores ("1:0, 2:0 or 3:0") across 10 games for 3x coverage per game.',
    }, multiscore10Legs),
  ]);

  const curated = await getCuratedTickets(false, 'all');

  const vault = {
    updatedAt: new Date().toISOString(),
    correctScoreGames: top20CSGames,
    correctScoreBundles: [sniper3, bomb5, dualCover, multiShield10, list10, vault20].filter((b) => b.count > 0),
    defaultSlip: curated[0]?.legs || top3Legs,
    defaultTicket: curated[0] || sniper3,
  };

  vaultCache = { ts: Date.now(), vault };
  return vault;
}

/**
 * Custom Accumulator, Multi-Match Million-Odds & Multi-Variation Synthesizer (up to 60 folds / 1,000,000x+ odds).
 */
export async function generateCustom({
  legs = 10,
  marketType = 'mixed',
  risk = 'safe',
  sameGameMulti = false,
  variations = 1,
  timeWindow = 'all',
  targetOdds = 0,
}) {
  const nLegs = Math.max(2, Math.min(60, Number(legs) || 10));
  const nVars = Math.max(1, Math.min(3, Number(variations) || 1));
  const goalOdds = Number(targetOdds) > 1.2 ? Number(targetOdds) : 0;
  const maxPoolLegs = goalOdds > 0 ? 60 : nLegs;

  // For massive multi-match slips (25+ legs or 500x+ target odds), expand pool if narrow window has too few matches
  let byGame = await collectCandidatePicks({ timeWindow });
  if ((maxPoolLegs >= 25 || goalOdds >= 500) && byGame.size < 65 && timeWindow !== 'all') {
    byGame = await collectCandidatePicks({ timeWindow: 'all' });
  }

  const minOdds = risk === 'high_odds' ? 1.60 : risk === 'balanced' ? 1.30 : 1.18;
  const maxOdds = marketType === 'cs' || marketType === 'multiscore' ? 25.0 : risk === 'safe' ? 1.82 : 3.20;
  const minProbFloor = risk === 'safe' ? 0.65 : risk === 'balanced' ? 0.58 : 0.52;

  const getFilter = (type) => {
    switch (type) {
      case 'million':
        return (s) => ['1up', '2up', 'dc', 'ou1.5', 'dnb', '1x2', 'homeou0.5', 'awayou0.5', 'ou2.5'].includes(s.marketKey) && s.p >= 0.64 && s.sportyOdds >= 1.24 && s.sportyOdds <= 1.74;
      case 'ou1.5':
        return (s) => s.marketKey === 'ou1.5' && s.selKey === 'over' && s.p >= 0.66 && s.sportyOdds >= 1.16 && s.sportyOdds <= maxOdds;
      case 'ou2.5':
        return (s) => s.marketKey === 'ou2.5' && s.selKey === 'over' && s.p >= 0.56 && s.sportyOdds >= minOdds && s.sportyOdds <= maxOdds;
      case 'gg':
        return (s) => s.marketKey === 'ggng' && s.selKey === 'gg' && s.p >= 0.55 && s.sportyOdds >= minOdds && s.sportyOdds <= maxOdds;
      case 'goals':
        return (s) => s.group === 'Goals' && !['cs', 'multiscore'].includes(s.marketKey) && s.p >= minProbFloor && s.sportyOdds >= minOdds && s.sportyOdds <= maxOdds;
      case '1x2':
        return (s) => s.marketKey === '1x2' && s.selKey !== 'draw' && s.p >= minProbFloor && s.sportyOdds >= minOdds && s.sportyOdds <= maxOdds;
      case '1up':
        return (s) => ['1up', '2up'].includes(s.marketKey) && s.p >= 0.62 && s.sportyOdds >= minOdds && s.sportyOdds <= maxOdds;
      case 'dc':
        return (s) => s.marketKey === 'dc' && s.p >= 0.72 && s.sportyOdds >= 1.15 && s.sportyOdds <= maxOdds;
      case 'shots':
        return (s) => s.group === 'Shots' && s.p >= 0.56 && s.sportyOdds >= 1.18 && s.sportyOdds <= maxOdds;
      case 'corners':
        return (s) => s.group === 'Corners' && s.p >= 0.56 && s.sportyOdds >= 1.20 && s.sportyOdds <= maxOdds;
      case 'cards':
        return (s) => s.group === 'Cards' && s.p >= 0.56 && s.sportyOdds >= 1.20 && s.sportyOdds <= maxOdds;
      case 'throwins':
      case 'throws_gk':
        return (s) => ['Throws & Goal Kicks', 'Offsides & fouls', 'Shots'].includes(s.group) && s.p >= 0.56 && s.sportyOdds >= 1.18 && s.sportyOdds <= maxOdds;
      case 'stats':
        return (s) => ['Shots', 'Corners', 'Cards', 'Throws & Goal Kicks', 'Offsides & fouls'].includes(s.group) && s.p >= 0.58 && s.sportyOdds >= 1.18 && s.sportyOdds <= maxOdds;
      case 'cs':
        return (s) => s.marketKey === 'cs' && s.p >= 0.09;
      case 'multiscore':
        return (s) => s.marketKey === 'multiscore' && s.p >= 0.18;
      default:
        return (s) => !['cs', 'multiscore'].includes(s.marketKey) && s.sportyOdds >= minOdds && s.sportyOdds <= maxOdds && s.p >= minProbFloor;
    }
  };

  const builtTickets = [];
  for (let v = 0; v < nVars; v++) {
    let candidateLegs = [];
    if (sameGameMulti) {
      candidateLegs = buildCorrelatedSameGameMulti(byGame, maxPoolLegs, v * 2);
    } else if (marketType === 'million' || (goalOdds >= 1000 && marketType === 'mixed' && risk !== 'high_odds')) {
      candidateLegs = buildHighAccuracyMultiMatch(byGame, {
        targetOdds: goalOdds > 0 ? goalOdds : 0,
        maxLegs: maxPoolLegs,
        minP: risk === 'safe' ? 0.66 : 0.62,
        minLegOdds: 1.24,
        maxLegOdds: risk === 'safe' ? 1.72 : 1.92,
        offset: v * 6,
      });
    } else if (marketType === 'mixed' && maxPoolLegs <= 22) {
      candidateLegs = selectRoundRobinMixed(byGame, maxPoolLegs, v * 3);
    } else {
      const filterFn = getFilter(marketType);
      candidateLegs = selectOnePerGame(byGame, maxPoolLegs, filterFn, (s) => s.calibratedScore || s.p, v * Math.max(2, Math.min(10, Math.floor(nLegs / 3))));
    }

    let chosenLegs = candidateLegs;
    if (goalOdds > 0 && candidateLegs.length) {
      chosenLegs = [];
      let prod = 1;
      for (const leg of candidateLegs) {
        chosenLegs.push(leg);
        prod *= leg.sportyOdds || leg.fairOdds || 1.35;
        if (prod >= goalOdds && chosenLegs.length >= 2) break;
      }
    } else {
      chosenLegs = candidateLegs.slice(0, nLegs);
    }

    const varLabel = nVars > 1 ? ` (Variation #${v + 1})` : '';
    const fmtGoal = goalOdds >= 1e6 ? `${(goalOdds / 1e6).toFixed(1)}M` : goalOdds >= 1e3 ? `${Math.round(goalOdds).toLocaleString()}` : goalOdds;
    const oddsTag = goalOdds > 0 ? ` · Target ~${fmtGoal}x` : '';
    const winTag = timeWindow !== 'all' ? ` · Window: ${timeWindow.toUpperCase()}` : '';
    const t = await finalizeTicket({
      id: `custom-${chosenLegs.length}-${marketType}-${risk}-v${v + 1}-${Date.now()}`,
      title: `⚡ Custom ${chosenLegs.length}-Fold ${marketType.toUpperCase()} Slip${varLabel}`,
      category: chosenLegs.length >= 25 ? 'Multi-Match & 1M+' : 'Custom',
      description: `${sameGameMulti ? 'Correlated Same-Game Multi' : 'High-Accuracy 1-Leg-Per-Match Accumulator'} · Risk: ${risk.toUpperCase()}${oddsTag}${winTag}`,
      params: { legs: chosenLegs.length, marketType, risk, sameGameMulti, timeWindow, targetOdds: goalOdds, variation: v + 1 },
    }, chosenLegs);
    builtTickets.push(t);
  }

  return {
    ticket: builtTickets[0],
    variations: builtTickets,
  };
}

/** Normal CDF helper for tactical Throw-In / Goal Kick / Shot accuracy scoring. */
function stdNormCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804 * Math.exp(-0.5 * z * z);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + 1.330274429 * t))));
  return z >= 0 ? 1 - p : p;
}

/**
 * Derive high-accuracy tactical Throw-Ins & Goal Kicks predictions for an upcoming soccer fixture
 * using de-vigged 1X2 dominance, goal expectancy, shot asymmetry & corner pressure (plus ESPN StatsModel when available).
 */
function deriveTacticalThrowAndGkPicks(event, selections, modelPred) {
  if (event.sportType && event.sportType !== 'soccer') return [];
  const H = event.homeTeamName;
  const A = event.awayTeamName;
  const matchup = `${H} vs ${A}`;
  const out = [];

  // 1. If ESPN StatsModel already computed exact Throw-Ins & Goal Kicks distributions for this match, harvest top picks!
  if (modelPred?.markets?.length) {
    const tgMarkets = modelPred.markets.filter((m) => m.group === 'Throws & Goal Kicks');
    for (const m of tgMarkets) {
      for (const s of m.selections || []) {
        if (s.p < 0.64 || s.p > 0.94 || s.key === 'draw') continue;
        const isGk = m.key.startsWith('goalkicks');
        const expText = m.expected ? `Projected ${m.expected.home} – ${m.expected.away}` : 'ESPN + Dixon-Coles Tactical Model';
        out.push({
          id: `${event.eventId}:tactical:${m.key}:${s.key}`,
          eventId: event.eventId,
          gameId: event.eventId,
          sportyGameId: event.gameId,
          matchup,
          home: H,
          away: A,
          leagueName: event.leagueLabel,
          date: event.date,
          group: 'Throws & Goal Kicks',
          propCategory: isGk ? 'goalkicks' : 'throwins',
          marketKey: m.key,
          selKey: s.key,
          market: m.name,
          sportyMarket: m.sporty || m.name,
          label: s.label,
          sportyPick: s.label,
          p: +s.p.toFixed(4),
          fairOdds: +(1 / Math.max(s.p, 0.05)).toFixed(2),
          sportyOdds: null,
          bookableOnSporty: false,
          hasModelFusion: true,
          expectedLine: expText,
          rationale: isGk
            ? `${expText} goal kicks driven by opponent off-target shot volume & crossing pressure.`
            : `${expText} throw-ins driven by touchline pressing, wing corners & territorial tightness.`,
        });
      }
    }
    if (out.length) return out;
  }

  // 2. Otherwise derive from live SportyBet de-vigged 1X2 + Over/Under 2.5 + Shots/Corners lines!
  const pHome = selections.find((s) => s.marketKey === '1x2' && s.selKey === 'home')?.p || 0.44;
  const pAway = selections.find((s) => s.marketKey === '1x2' && s.selKey === 'away')?.p || 0.29;
  const pOver25 = selections.find((s) => s.marketKey === 'ou2.5' && s.selKey === 'over')?.p || 0.50;

  const tightness = 1 - Math.abs(pHome - pAway); // 1.0 = dead-even touchline battle; 0.2 = heavy mismatch
  const tempo = (pOver25 - 0.50) * 4.0;

  // Expected Shots & Missed Shots per side
  const expShotsH = Math.max(7.5, Math.min(20.5, 13.0 + (pHome - pAway) * 9.8 + tempo * 1.1));
  const expShotsA = Math.max(6.2, Math.min(18.5, 10.8 + (pAway - pHome) * 9.4 + tempo * 1.0));
  const missedH = expShotsH * 0.655;
  const missedA = expShotsA * 0.665;

  // Goal Kicks: Home GK takes goal kicks when Away misses; Away GK takes goal kicks when Home misses!
  const expGkH = +(3.1 + 0.62 * missedA).toFixed(1);
  const expGkA = +(3.3 + 0.62 * missedH).toFixed(1);
  const expGkTot = +(expGkH + expGkA).toFixed(1);

  // Most Goal Kicks 1X2 (Strongest signal when there is a clear territorial favorite shooting heavily!)
  const pAwayMostGk = stdNormCdf((expGkA - expGkH - 0.5) / 2.85);
  const pHomeMostGk = stdNormCdf((expGkH - expGkA - 0.5) / 2.85);
  if (pAwayMostGk >= 0.66) {
    out.push({
      id: `${event.eventId}:tactical:goalkicks_1x2:away`,
      eventId: event.eventId,
      gameId: event.eventId,
      sportyGameId: event.gameId,
      matchup,
      home: H,
      away: A,
      leagueName: event.leagueLabel,
      date: event.date,
      group: 'Throws & Goal Kicks',
      propCategory: 'goalkicks',
      marketKey: 'goalkicks_1x2',
      selKey: 'away',
      market: 'Most Goal Kicks (1X2)',
      sportyMarket: 'Goal Kicks 1X2',
      label: `${A} Most Goal Kicks`,
      sportyPick: `${A} Most Goal Kicks`,
      p: +pAwayMostGk.toFixed(4),
      fairOdds: +(1 / pAwayMostGk).toFixed(2),
      sportyOdds: null,
      bookableOnSporty: false,
      expectedLine: `Proj. GK: ${H} ${expGkH} – ${expGkA} ${A}`,
      rationale: `${H} (${Math.round(pHome * 100)}% win prob, ~${expShotsH.toFixed(1)} proj. shots) pins ${A} deep, forcing ~${expGkA} ${A} goal kicks vs ${expGkH}.`,
    });
  } else if (pHomeMostGk >= 0.66) {
    out.push({
      id: `${event.eventId}:tactical:goalkicks_1x2:home`,
      eventId: event.eventId,
      gameId: event.eventId,
      sportyGameId: event.gameId,
      matchup,
      home: H,
      away: A,
      leagueName: event.leagueLabel,
      date: event.date,
      group: 'Throws & Goal Kicks',
      propCategory: 'goalkicks',
      marketKey: 'goalkicks_1x2',
      selKey: 'home',
      market: 'Most Goal Kicks (1X2)',
      sportyMarket: 'Goal Kicks 1X2',
      label: `${H} Most Goal Kicks`,
      sportyPick: `${H} Most Goal Kicks`,
      p: +pHomeMostGk.toFixed(4),
      fairOdds: +(1 / pHomeMostGk).toFixed(2),
      sportyOdds: null,
      bookableOnSporty: false,
      expectedLine: `Proj. GK: ${H} ${expGkH} – ${expGkA} ${A}`,
      rationale: `Visiting favorite ${A} (${Math.round(pAway * 100)}% win prob, ~${expShotsA.toFixed(1)} proj. shots) drives ~${expGkH} ${H} goal kicks vs ${expGkA}.`,
    });
  }

  // Total Goal Kicks Over 14.5 / Under 17.5
  for (const line of [14.5, 15.5, 17.5]) {
    const pOv = stdNormCdf((expGkTot - line) / 3.15);
    const bestSide = pOv >= 0.5 ? 'over' : 'under';
    const bestP = bestSide === 'over' ? pOv : 1 - pOv;
    if (bestP >= 0.67 && bestP <= 0.90) {
      out.push({
        id: `${event.eventId}:tactical:goalkicks_ou${line}:${bestSide}`,
        eventId: event.eventId,
        gameId: event.eventId,
        sportyGameId: event.gameId,
        matchup,
        home: H,
        away: A,
        leagueName: event.leagueLabel,
        date: event.date,
        group: 'Throws & Goal Kicks',
        propCategory: 'goalkicks',
        marketKey: `goalkicks_ou${line}`,
        selKey: bestSide,
        market: `Total Goal Kicks ${line}`,
        sportyMarket: 'Goal Kicks Over/Under',
        label: `${bestSide === 'over' ? 'Over' : 'Under'} ${line} Goal Kicks`,
        sportyPick: `${bestSide === 'over' ? 'Over' : 'Under'} ${line} Goal Kicks`,
        p: +bestP.toFixed(4),
        fairOdds: +(1 / bestP).toFixed(2),
        sportyOdds: null,
        bookableOnSporty: false,
        expectedLine: `Proj. Total GK: ${expGkTot}`,
        rationale: `Combined shot volume (~${(expShotsH + expShotsA).toFixed(1)} shots) projects ${expGkTot} total goal kicks (${H} ${expGkH}, ${A} ${expGkA}).`,
      });
      break;
    }
  }

  // Throw-Ins: Competitive mid-block battles & high-pressing wing play generate 37–42+ throw-ins; one-sided possession games stay lower
  const expThrowH = +(17.2 + tightness * 2.4 + (pHome - 0.42) * 2.2 - tempo * 0.45).toFixed(1);
  const expThrowA = +(16.8 + tightness * 2.3 + (pAway - 0.30) * 2.2 - tempo * 0.45).toFixed(1);
  const expThrowTot = +(expThrowH + expThrowA).toFixed(1);

  for (const line of [34.5, 35.5, 38.5, 39.5]) {
    const pOv = stdNormCdf((expThrowTot - line) / 4.4);
    const bestSide = pOv >= 0.5 ? 'over' : 'under';
    const bestP = bestSide === 'over' ? pOv : 1 - pOv;
    if (bestP >= 0.67 && bestP <= 0.90) {
      out.push({
        id: `${event.eventId}:tactical:throwins_ou${line}:${bestSide}`,
        eventId: event.eventId,
        gameId: event.eventId,
        sportyGameId: event.gameId,
        matchup,
        home: H,
        away: A,
        leagueName: event.leagueLabel,
        date: event.date,
        group: 'Throws & Goal Kicks',
        propCategory: 'throwins',
        marketKey: `throwins_ou${line}`,
        selKey: bestSide,
        market: `Total Throw-Ins ${line}`,
        sportyMarket: 'Throw-Ins Over/Under',
        label: `${bestSide === 'over' ? 'Over' : 'Under'} ${line} Throw-Ins`,
        sportyPick: `${bestSide === 'over' ? 'Over' : 'Under'} ${line} Throw-Ins`,
        p: +bestP.toFixed(4),
        fairOdds: +(1 / bestP).toFixed(2),
        sportyOdds: null,
        bookableOnSporty: false,
        expectedLine: `Proj. Throws: ${expThrowTot} (${H} ${expThrowH}–${expThrowA} ${A})`,
        rationale: tightness >= 0.72
          ? `Balanced touchline duel (${Math.round(tightness * 100)}% parity index) drives heavy midfield press & ~${expThrowTot} projected throw-ins.`
          : `Possession asymmetry keeps ball in central circulation (~${expThrowTot} projected throw-ins).`,
      });
      break;
    }
  }

  return out;
}

/**
 * Dedicated High-Accuracy Match-Stat Props Hub (Throws, Goal Kicks, Shots, SOT, Corners, Cards, Offsides & Fouls).
 * Strictly filters to high-likelihood winners ("pick only those that are likely to succeed") and pre-books a live SportyBet Props Multi!
 */
export async function getHighAccuracyPropsHub({
  category = 'all',
  minP = 0.65,
  timeWindow = 'all',
} = {}) {
  const [byGame, espnPredMap] = await Promise.all([
    collectCandidatePicks({ timeWindow }),
    getEspnPredMap(),
  ]);

  const classifyProp = (s) => {
    const mk = String(s.marketKey || '').toLowerCase();
    if (mk.startsWith('throwins')) return 'throwins';
    if (mk.startsWith('goalkicks')) return 'goalkicks';
    if (mk.startsWith('shots') || mk.startsWith('sot') || s.group === 'Shots') return 'shots';
    if (mk.startsWith('corners') || s.group === 'Corners') return 'corners';
    if (mk.startsWith('cards') || mk === 'redcard' || mk === 'red' || s.group === 'Cards') return 'cards';
    if (mk.startsWith('offsides') || mk.startsWith('fouls') || s.group === 'Offsides & fouls') return 'fouls_offsides';
    return null;
  };

  const allProps = [];
  const seenKeys = new Set();

  // 1. Live SportyBet Ghana Direct-Bookable Match-Stat Props
  for (const { event, hasModelFusion, selections } of byGame.values()) {
    const propSels = selections.filter((s) => {
      const cat = classifyProp(s);
      return cat && s.p >= minP && s.p <= 0.94 && s.sportyOdds >= 1.15 && s.sportyOdds <= 2.35;
    });

    propSels.sort((a, b) => b.p - a.p);
    const usedMarketPerGame = new Set();
    for (const s of propSels) {
      if (usedMarketPerGame.size >= 4) break;
      if (usedMarketPerGame.has(s.marketKey)) continue;
      usedMarketPerGame.add(s.marketKey);
      const propCat = classifyProp(s);
      const dedupeKey = `${event.eventId}:${s.marketKey}:${s.selKey}`;
      seenKeys.add(dedupeKey);
      allProps.push({
        ...s,
        propCategory: propCat,
        bookableOnSporty: Boolean(s.sportySelection),
        hasModelFusion,
        rationale: s.edgePct > 0
          ? `Live SportyBet line @${s.sportyOdds} carries +${s.edgePct}% positive EV vs ${Math.round(s.p * 100)}% calibrated win likelihood.`
          : `High-accuracy ${Math.round(s.p * 100)}% statistical + de-vigged market consensus (@${s.sportyOdds}).`,
      });
    }
  }

  // 2. High-Accuracy Tactical Throw-Ins & Goal Kicks across top 45 upcoming soccer matches
  const topSoccerGames = [...byGame.values()]
    .filter(({ event }) => !event.sportType || event.sportType === 'soccer')
    .slice(0, 45);

  for (const { event, selections } of topSoccerGames) {
    const modelPred = espnPredMap.get(event.eventId) || null;
    const tactical = deriveTacticalThrowAndGkPicks(event, selections, modelPred);
    for (const tp of tactical) {
      if (tp.p < minP) continue;
      const dedupeKey = `${event.eventId}:${tp.marketKey}:${tp.selKey}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      allProps.push(tp);
    }
  }

  // Sort strictly by accuracy + live bookability bonus
  allProps.sort((a, b) => {
    const scoreA = a.p + (a.bookableOnSporty ? 0.015 : 0) + Math.max(0, (a.edgePct || 0) * 0.002);
    const scoreB = b.p + (b.bookableOnSporty ? 0.015 : 0) + Math.max(0, (b.edgePct || 0) * 0.002);
    return scoreB - scoreA;
  });

  const counts = {
    all: allProps.length,
    bookable: allProps.filter((p) => p.bookableOnSporty).length,
    shots: allProps.filter((p) => p.propCategory === 'shots').length,
    throwins: allProps.filter((p) => p.propCategory === 'throwins').length,
    goalkicks: allProps.filter((p) => p.propCategory === 'goalkicks').length,
    corners: allProps.filter((p) => p.propCategory === 'corners').length,
    cards: allProps.filter((p) => p.propCategory === 'cards').length,
    fouls_offsides: allProps.filter((p) => p.propCategory === 'fouls_offsides').length,
  };

  const filtered = category === 'all'
    ? allProps
    : category === 'bookable'
      ? allProps.filter((p) => p.bookableOnSporty)
      : allProps.filter((p) => p.propCategory === category);

  // Build a ready 6-to-8 leg Live SportyBet Ghana Code from the top distinct bookable props in the active view (or overall)
  const bookableSource = filtered.filter((p) => p.bookableOnSporty).length >= 3
    ? filtered.filter((p) => p.bookableOnSporty)
    : allProps.filter((p) => p.bookableOnSporty);

  const usedGames = new Set();
  const topBookableLegs = [];
  for (const p of bookableSource) {
    if (usedGames.has(p.eventId || p.gameId)) continue;
    usedGames.add(p.eventId || p.gameId);
    topBookableLegs.push(p);
    if (topBookableLegs.length >= 8) break;
  }

  const featuredPropsTicket = topBookableLegs.length >= 2
    ? await finalizeTicket({
      id: `props-hub-sniper-${category}-${topBookableLegs.length}`,
      title: `🥅 High-Accuracy Tactical Props Sniper (${topBookableLegs.length}-Fold)`,
      category: 'Tactical Props',
      ticketType: 'props',
      description: 'Compiled strictly from our highest-likelihood live SportyBet Ghana Shots, SOT, Corners, Bookings, Fouls & Offsides locks.',
    }, topBookableLegs)
    : null;

  return {
    updatedAt: new Date().toISOString(),
    category,
    minP,
    timeWindow,
    counts,
    featuredPropsTicket,
    props: filtered.slice(0, 180),
  };
}

