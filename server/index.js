import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog, getLeague } from './leagues.js';
import { getScoreboard, getSummary } from './espn.js';
import { defaultParams } from './models.js';
import { aiEnabled, analyzeGame } from './ai.js';
import { getModel } from './engine.js';
import * as brain from './brain.js';
import * as tracker from './tracker.js';
import * as lessons from './lessons.js';
import * as scheduler from './scheduler.js';
import * as tickets from './tickets.js';
import * as intelligence from './intelligence.js';
import * as sportybet from './sportybet.js';
import * as arena from './arena.js';
import * as lineups from './lineups.js';
import * as oddsTracker from './odds-tracker.js';
import * as alerts from './alerts.js';

const app = express();
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Server error' });
  });

const leagueInfo = (l) => ({ id: l.id, name: l.name, sport: l.sport, kind: l.kind, draws: l.draws });

function modelInfo(m) {
  return { games: m.games, from: m.from, to: m.to, weights: m.weights, metrics: m.metrics, vsMarket: m.vsMarket, version: m.version };
}

async function findGame(league, id, date) {
  let games = await getScoreboard(league, date || undefined);
  let g = games.find((x) => x.id === id || x.eventId === id);
  if (!g && date) {
    games = await getScoreboard(league);
    g = games.find((x) => x.id === id || x.eventId === id);
  }
  if (!g) {
    const e = new Error('Game not found');
    e.status = 404;
    throw e;
  }
  return g;
}

/** Prediction + learned "smart pick" (ours / market / AI blended with trust weights). */
async function predictFull(league, model, g, opts = {}) {
  const p = model.predict(g, opts);
  p.version = model.version;
  const state = await brain.getState(league.id);
  p.smart = brain.smartBlend(state, league, { ours: p.ensemble.probs, market: p.market, ai: opts.ai || null });
  return p;
}

// ---------- API ----------

app.get('/api/catalog', (req, res) => res.json({ sports: catalog(), aiEnabled: aiEnabled() }));

app.get('/api/games/:league', wrap(async (req, res) => {
  const league = getLeague(req.params.league);
  brain.touch(league.id).catch(() => {});
  const [model, games] = await Promise.all([getModel(league), getScoreboard(league, req.query.date)]);
  const out = [];
  for (const g of games) {
    const prediction = await predictFull(league, model, g);
    const tracked = g.state === 'pre' ? model.trackedMarkets(g) : null;
    out.push({ ...g, prediction, ...(tracked ? { tracked } : {}) });
  }
  tracker.record(league.id, out).catch(() => {});
  res.json({ league: leagueInfo(league), model: modelInfo(model), games: out.map(({ tracked, ...g }) => g) });
}));

app.get('/api/game/:league/:id', wrap(async (req, res) => {
  const league = getLeague(req.params.league);
  const [model, game] = await Promise.all([getModel(league), findGame(league, req.params.id, req.query.date)]);
  const [summary, prediction, sportyEv] = await Promise.all([
    getSummary(league, game.eventId).catch(() => null),
    predictFull(league, model, game, { markets: true }),
    sportybet.findSportyEventForGame(game).catch(() => null),
  ]);
  const fullSportyEv = sportyEv ? (await sportybet.getSportyEventDetail(sportyEv.eventId).catch(() => null)) || sportyEv : null;
  const [sportyBookable, lineupIntel] = await Promise.all([
    Promise.resolve(fullSportyEv ? sportybet.extractBookableSelections(fullSportyEv, prediction) : []),
    fullSportyEv ? lineups.inspectMatchLineupAndReferee(fullSportyEv, summary).catch(() => null) : Promise.resolve(null),
  ]);
  res.json({
    league: leagueInfo(league),
    game,
    prediction,
    summary,
    lineupIntel,
    sportyEvent: fullSportyEv ? { eventId: fullSportyEv.eventId, gameId: fullSportyEv.gameId, selectionsCount: sportyBookable.length } : null,
    sportySelections: sportyBookable,
    oddsHistory: fullSportyEv ? oddsTracker.getEventOddsHistory(fullSportyEv.eventId) : null,
    model: modelInfo(model),
    aiEnabled: aiEnabled(),
  });
}));

app.post('/api/ai/:league/:id', wrap(async (req, res) => {
  const league = getLeague(req.params.league);
  const [model, game] = await Promise.all([getModel(league), findGame(league, req.params.id, req.query.date)]);
  const summary = await getSummary(league, game.eventId).catch(() => null);
  const analysis = await analyzeGame(league, game, model.predict(game), summary, { force: req.query.force === '1' });
  tracker.recordAi(league.id, game, analysis).catch(() => {});
  const p = await predictFull(league, model, game, { ai: analysis.probabilities });
  res.json({ ...analysis, smart: p.smart });
}));

app.get('/api/model/:league', wrap(async (req, res) => {
  const league = getLeague(req.params.league);
  const m = await getModel(league);
  res.json({
    league: leagueInfo(league), ...modelInfo(m),
    recent: m.recent, rankings: m.rankings(), featureImportance: m.featureImportance,
    marketBacktest: m.marketBacktest, statsBacktest: m.statsBacktest, historyDrift: m.historyDrift,
    params: m.params, defaults: defaultParams(league),
    brain: await brain.summary(league.id),
  });
}));

app.get('/api/brain/:league', wrap(async (req, res) => {
  const league = getLeague(req.params.league);
  res.json({ league: leagueInfo(league), defaults: defaultParams(league), ...(await brain.summary(league.id)) });
}));

app.post('/api/brain/:league/evolve', wrap(async (req, res) => {
  const league = getLeague(req.params.league);
  await brain.touch(league.id);
  if (!brain.evolveStatus(league.id)) {
    scheduler.evolveLeague(league.id, 'manual')
      .then(() => scheduler.learnLeague(league.id))
      .catch((e) => console.warn('[brain] manual evolve failed:', e.message));
    await new Promise((r) => setTimeout(r, 50));
  }
  res.status(202).json({ started: true, status: brain.evolveStatus(league.id) });
}));

// Best picks across all active leagues + live SportyBet Ghana feed
app.get('/api/picks', wrap(async (req, res) => {
  const minP = Math.min(0.97, Math.max(0.45, Number(req.query.minP) || 0.65));
  const perGame = Math.max(1, Math.min(5, Number(req.query.perGame) || 3));
  const timeWindow = req.query.window || 'all';
  const sortMode = req.query.sort || 'prob'; // 'prob' | 'ev' | 'vhim'
  const evOnly = req.query.evOnly === '1';
  const groupFilter = req.query.group || 'all';
  const byGame = await tickets.collectCandidatePicks({ timeWindow });
  const picks = [];

  for (const { selections } of byGame.values()) {
    const valid = selections
      .filter((s) =>
        s.p >= minP &&
        s.p <= 0.95 &&
        s.sportyOdds >= 1.15 &&
        !['cs', 'multiscore'].includes(s.marketKey) &&
        (!evOnly || (s.edgePct || 0) > 0) &&
        (groupFilter === 'all' ||
          (groupFilter === 'props' && ['Shots', 'Corners', 'Cards', 'Throws & Goal Kicks', 'Offsides & fouls', 'Player Props'].includes(s.group)) ||
          s.group === groupFilter)
      )
      .sort((a, b) =>
        sortMode === 'ev'
          ? (b.edgePct || 0) - (a.edgePct || 0)
          : sortMode === 'vhim'
            ? (b.vhimScore || 0) - (a.vhimScore || 0)
            : b.p - a.p
      );
    const seenGroups = new Set();
    let taken = 0;
    for (const s of valid) {
      if (taken >= perGame) break;
      if (seenGroups.has(s.marketKey)) continue;
      seenGroups.add(s.marketKey);
      picks.push({
        ...s,
        sporty: s.sportyMarket,
      });
      taken++;
    }
  }

  picks.sort((a, b) =>
    sortMode === 'ev'
      ? (b.edgePct || 0) - (a.edgePct || 0)
      : sortMode === 'vhim'
        ? (b.vhimScore || 0) - (a.vhimScore || 0)
        : b.p - a.p
  );
  res.json({ minP, timeWindow, sortMode, groupFilter, picks: picks.slice(0, 240), errors: [] });
}));

// Dedicated High-Accuracy Match-Stat, Player Prop, 1st-Half & Combo Shield Hub
app.get('/api/props', wrap(async (req, res) => {
  const category = req.query.category || 'all';
  const minP = Math.min(0.92, Math.max(0.52, Number(req.query.minP) || 0.65));
  const timeWindow = req.query.window || 'all';
  const hub = await tickets.getHighAccuracyPropsHub({ category, minP, timeWindow });
  if (hub.featuredPropsTicket?.legs?.length) {
    arena.registerTickets([hub.featuredPropsTicket], { source: 'live_cooked', defaultStakeGHS: 50 }).catch(() => {});
  }
  res.json(hub);
}));

// Pre-compiled accumulator tickets (with real 6-character SportyBet Ghana booking codes + Pre-Booked Pod A-D codes)
app.get('/api/tickets', wrap(async (req, res) => {
  const timeWindow = req.query.window || 'all';
  const t = await tickets.getCuratedTickets(req.query.force === '1', timeWindow);
  arena.registerTickets(t, { source: 'live_cooked', defaultStakeGHS: 100 }).catch(() => {});
  res.json({ tickets: t, timeWindow, date: new Date().toISOString().slice(0, 10) });
}));

// Unified Command Center overview (fast single-request hero data for zero-effort daily play)
app.get('/api/overview', wrap(async (req, res) => {
  const [curated, vault, arenaSnap, anomalies, sportyCat] = await Promise.all([
    tickets.getCuratedTickets(false, 'all').catch(() => []),
    tickets.getSlipCentreVault(false).catch(() => null),
    arena.getArenaSnapshot().catch(() => null),
    intelligence.scanMarketAnomalies().catch(() => []),
    sportybet.getSportyCatalog(false).catch(() => []),
  ]);
  const findTicket = (id) => curated.find((x) => x.id === id) || null;
  const alertState = alerts.getPublicAlertState();
  res.json({
    updatedAt: new Date().toISOString(),
    upcomingCount: sportyCat.length,
    rolloverTicket: findTicket('daily-rollover-2x') || curated[0] || null,
    fastCashTicket: findTicket('fast-cash-soon') || curated[1] || null,
    vhimTicket: findTicket('vhim-banker-5') || curated[2] || null,
    valueSniperTicket: findTicket('value-ev-sniper-6') || null,
    comboShieldTicket: findTicket('combo-shield-banker-8') || null,
    twentyMillionTicket: findTicket('twenty-million-mega-50') || null,
    millionTicket: findTicket('twenty-million-mega-50') || findTicket('million-odds-grand-slam') || findTicket('super-multi-30') || null,
    propsTicket: findTicket('tactical-props-sniper-8') || null,
    topCsBundle: vault?.correctScoreBundles?.[0] || null,
    topCsPick: vault?.correctScoreCandidates?.[0] || null,
    topAnomaly: anomalies?.[0] || null,
    anomalyCount: anomalies?.length || 0,
    arenaSummary: arenaSnap?.summary || null,
    equityCurve: arenaSnap?.equityCurve || null,
    alertsUnread: alertState.unreadCount || 0,
    oddsTrackerStats: oddsTracker.getOddsTrackerStats(),
  });
}));

// Custom ticket & multi-variation synthesizer (up to 50 folds / 20,000,000+ odds + same-game multi + real SportyBet code)
app.post('/api/tickets/generate', wrap(async (req, res) => {
  const result = await tickets.generateCustom(req.body || {});
  if (result?.variations?.length) {
    arena.registerTickets(result.variations, { source: 'user_placed', defaultStakeGHS: 100 }).catch(() => {});
  }
  res.json(result);
}));

// Pre-Compiled Slip Centre Vault (20-Game Correct Score Vault + pre-booked bundles + default Vhim slip)
app.get('/api/slip-vault', wrap(async (req, res) => {
  const vault = await tickets.getSlipCentreVault(req.query.force === '1');
  if (vault?.correctScoreBundles?.length) {
    arena.registerTickets(vault.correctScoreBundles, { source: 'live_cooked', defaultStakeGHS: 50 }).catch(() => {});
  }
  res.json(vault);
}));

// Generate a REAL 6-character SportyBet Ghana Booking Code for any custom selections in the Betslip
app.post('/api/sportybet/book', wrap(async (req, res) => {
  const items = Array.isArray(req.body?.selections) ? req.body.selections : [];
  const result = await sportybet.generateSportyBookingCode(items);
  if (result.ok && items.length) {
    const totalSportyOdds = +items.reduce((a, b) => a * (Number(b.sportyOdds) || Number(b.fairOdds) || 1.5), 1).toFixed(2);
    const combP = +items.reduce((a, b) => a * (Number(b.p) || 0.5), 1).toFixed(4);
    arena.registerTickets([{
      arenaId: `arena-booked-${result.shareCode || Date.now()}`,
      id: `booked-${result.shareCode || Date.now()}`,
      title: `🎫 Custom Booked Slip (${items.length}-Fold)`,
      category: 'User Booked Slip',
      description: `Booked in Slip Centre with live SportyBet Ghana code ${result.shareCode || ''}.`,
      source: 'user_placed',
      shareCode: result.shareCode,
      shareURL: result.shareURL,
      stakeGHS: Number(req.body?.stakeGHS) || 100,
      totalSportyOdds,
      combinedProb: combP,
      combinedFairOdds: +(1 / Math.max(combP, 1e-6)).toFixed(2),
      legs: items,
    }], { source: 'user_placed' }).catch(() => {});
  }
  res.json(result);
}));

// 1-Click Strip Started / Locked Games & Re-Book Fresh 6-Char SportyBet Ghana Code
app.post('/api/sportybet/rebook-clean', wrap(async (req, res) => {
  const result = await sportybet.stripStartedAndRebook({
    shareCode: req.body?.shareCode || null,
    selections: Array.isArray(req.body?.selections) ? req.body.selections : null,
  });
  if (result.ok && result.activeSelections?.length) {
    const cleanLegs = result.activeSelections.map((s) => ({
      id: `${s.eventId}:${s.marketId}:${s.outcomeId}`,
      eventId: s.eventId,
      sportyGameId: s.gameId,
      matchup: s.matchup,
      home: s.home,
      away: s.away,
      leagueName: s.leagueName,
      date: s.date,
      startTime: s.estimateStartTime,
      market: s.marketName,
      sportyMarket: s.marketName,
      label: `${s.marketName}: ${s.pick}`,
      sportyPick: s.pick,
      sportyOdds: Number(s.odds) || 1.4,
      fairOdds: Number(s.odds) || 1.4,
      p: s.probability || +(1 / Math.max(1.05, Number(s.odds) || 1.4) * 0.94).toFixed(4),
      sportySelection: s.sportySelection,
    }));
    arena.registerTickets([{
      arenaId: `arena-clean-${result.shareCode || Date.now()}`,
      id: `clean-${result.shareCode || Date.now()}`,
      title: `🧹 Clean Re-Booked Slip (${cleanLegs.length}-Fold)`,
      category: 'Clean Re-Booked Slip',
      description: `Stripped ${result.removedCount || 0} started/locked match(es) and minted fresh SportyBet Ghana code ${result.shareCode}.`,
      source: 'user_placed',
      shareCode: result.shareCode,
      shareURL: result.shareURL,
      stakeGHS: Number(req.body?.stakeGHS) || 100,
      totalSportyOdds: result.totalSportyOdds,
      legs: cleanLegs,
    }], { source: 'user_placed' }).catch(() => {});
  }
  res.json(result);
}));

// Load & audit any existing SportyBet Ghana Booking Code (e.g. "9YG45J")
app.get('/api/sportybet/code/:code', wrap(async (req, res) => {
  const audited = await sportybet.loadSportyBookingCode(req.params.code);
  res.json(audited);
}));

// Real Confirmed Lineups, Squad Rotation, Injuries, Referee & Season Prop Profile for a SportyBet Event
app.get('/api/lineups/:eventId', wrap(async (req, res) => {
  const eventId = req.params.eventId;
  const cat = await sportybet.getSportyCatalog(false);
  let ev = cat.find((x) => x.eventId === eventId);
  if (!ev) {
    ev = await sportybet.getSportyEventDetail(eventId);
  }
  if (!ev) {
    return res.status(404).json({ error: 'Event not found in SportyBet catalog' });
  }
  const espnSum = await tickets.getEspnSummaryForSportyEvent(eventId).catch(() => null);
  const intel = await lineups.inspectMatchLineupAndReferee(ev, espnSum);
  res.json({ ok: true, eventId, lineupIntel: intel });
}));

// Real 15-Minute SportyBet Ghana Odds-Drop Time-Series Telemetry
app.get('/api/odds-movements', wrap(async (req, res) => {
  const minDrop = Math.max(1.5, Number(req.query.minDrop) || 4.0);
  const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 50));
  res.json({
    stats: oddsTracker.getOddsTrackerStats(),
    drops: oddsTracker.getSignificantOddsDrops({ minDropPct: minDrop, limit }),
  });
}));

app.get('/api/odds-movements/:eventId', wrap(async (req, res) => {
  const history = oddsTracker.getEventOddsHistory(req.params.eventId);
  res.json({ ok: Boolean(history), eventId: req.params.eventId, history });
}));

// Instant Telegram + Browser Push Alert Engine Endpoints
app.get('/api/alerts', wrap(async (req, res) => {
  res.json(alerts.getPublicAlertState());
}));

app.post('/api/alerts/config', wrap(async (req, res) => {
  const state = alerts.updateAlertConfig(req.body || {});
  res.json({ ok: true, ...state });
}));

app.post('/api/alerts/read', wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  const state = alerts.markAlertsRead(ids);
  res.json({ ok: true, ...state });
}));

app.post('/api/alerts/test', wrap(async (req, res) => {
  const result = await alerts.sendTestAlert();
  res.json({ ok: true, result, state: alerts.getPublicAlertState() });
}));

app.post('/api/alerts/send-daily-codes', wrap(async (req, res) => {
  const curated = await tickets.getCuratedTickets(false, 'all');
  const result = await alerts.sendDailyCodesDigest(curated, { manual: true });
  res.json({ ok: Boolean(result), result, state: alerts.getPublicAlertState() });
}));

// Live Cooked-Odds & Ticket Verification Arena (places all cooked odds & tests against real-world live/final results)
app.get('/api/arena', wrap(async (req, res) => {
  const snapshot = await arena.syncArena({ force: req.query.force === '1' });
  res.json(snapshot);
}));

app.post('/api/arena/place', wrap(async (req, res) => {
  const ticket = req.body?.ticket;
  const stakeGHS = Number(req.body?.stakeGHS) || 100;
  if (!ticket || !Array.isArray(ticket.legs) || !ticket.legs.length) {
    return res.status(400).json({ error: 'Valid ticket with legs required' });
  }
  const placed = await arena.registerTickets([{ ...ticket, stakeGHS, source: 'user_placed' }], {
    source: 'user_placed',
    defaultStakeGHS: stakeGHS,
  });
  const snapshot = await arena.syncArena({ force: false });
  res.json({ ok: true, placed: placed[0], snapshot });
}));

app.post('/api/arena/stake', wrap(async (req, res) => {
  const updated = await arena.updateTicketStake(req.body?.arenaId, req.body?.stakeGHS);
  const snapshot = await arena.getArenaSnapshot();
  res.json({ ok: true, ticket: updated, snapshot });
}));

// Market Surveillance, Bookmaker Insider & Match-Fixing Radar
app.get('/api/intelligence', wrap(async (req, res) => {
  const [anomalies, insiderTicket] = await Promise.all([
    intelligence.scanMarketAnomalies(),
    intelligence.buildInsiderRadarTicket(8).catch(() => null),
  ]);
  if (insiderTicket?.legs?.length) {
    arena.registerTickets([insiderTicket], { source: 'live_cooked', defaultStakeGHS: 100 }).catch(() => {});
  }
  res.json({
    anomalies,
    insiderTicket,
    count: anomalies.length,
    oddsTracker: oddsTracker.getOddsTrackerStats(),
    aiEnabled: aiEnabled(),
  });
}));

// Deep forensic & AI integrity investigation (works for both global SportyBet and ESPN anomalies)
app.post('/api/intelligence/investigate', wrap(async (req, res) => {
  const anomaly = req.body?.anomaly || null;
  const report = await intelligence.investigateMatch(null, null, anomaly);
  res.json({ match: anomaly?.matchup || 'Match', report });
}));

app.post('/api/intelligence/investigate/:league/:id', wrap(async (req, res) => {
  let league = null;
  let game = null;
  try {
    league = getLeague(req.params.league);
    game = await findGame(league, req.params.id, req.query.date);
  } catch { /* fallback to anomaly payload */ }
  const report = await intelligence.investigateMatch(league, game, req.body?.anomaly || null);
  res.json({ match: game ? `${game.away.name} @ ${game.home.name}` : (req.body?.anomaly?.matchup || 'Match'), report });
}));

app.get('/api/lessons', wrap(async (req, res) => res.json({ lessons: await lessons.list(req.query.league || null), aiEnabled: aiEnabled() })));

app.get('/api/track', wrap(async (req, res) => res.json(await tracker.stats())));

app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

async function prewarmSystem() {
  try {
    const t0 = Date.now();
    await sportybet.getSportyCatalog(false);
    const [curated, vault] = await Promise.all([
      tickets.getCuratedTickets(false, 'all'),
      tickets.getSlipCentreVault(false),
      intelligence.scanMarketAnomalies().catch(() => []),
    ]);
    if (curated?.length) {
      await arena.registerTickets(curated, { source: 'live_cooked', defaultStakeGHS: 100 }).catch(() => {});
    }
    if (vault?.correctScoreBundles?.length) {
      await arena.registerTickets(vault.correctScoreBundles, { source: 'live_cooked', defaultStakeGHS: 50 }).catch(() => {});
    }
    await arena.syncArena({ force: true }).catch(() => {});
    console.log(`[prewarm] Ready in ${((Date.now() - t0) / 1000).toFixed(1)}s (${curated?.length || 0} live SportyBet GH tickets cooked & Arena synced)`);
  } catch (err) {
    console.warn('[prewarm] non-fatal warning:', err.message);
  }
}

process.on('SIGINT', () => {
  oddsTracker.flushOddsHistory();
  alerts.flushAlerts();
  process.exit(0);
});

const PORT = Number(process.env.PORT) || 3456;
app.listen(PORT, () => {
  console.log(`Sports Predictor running at http://localhost:${PORT}`);
  if (!aiEnabled()) console.log('Tip: add GEMINI_API_KEY to .env to enable the AI analyst.');
  setTimeout(() => prewarmSystem(), 300).unref();
  if (process.env.NO_SCHEDULER !== '1') scheduler.start();
});
