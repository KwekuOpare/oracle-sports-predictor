// Real SportyBet Ghana Time-Series Odds-Drop & Steam Recorder (server/odds-tracker.js)
// Records timestamped live SportyBet Ghana odds snapshots every 15 minutes (and on catalog refreshes)
// into `data/odds-history.json` so we track genuine opening -> previous -> current odds movements,
// multi-point sparklines, implied probability jumps, and hourly steam velocity with zero synthetic data.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'odds-history.json');

const MIN_POINT_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes between unchanged/minor points
const MIN_ODDS_DELTA = 0.015; // record immediately if odds move >= 0.015
const MAX_POINTS_PER_SEL = 24;
const PRUNE_AFTER_KICKOFF_MS = 24 * 3600 * 1000; // prune matches >24h past kickoff

// Core markets worth tracking time-series odds movements on across upcoming events:
// 1 = 1X2, 60200 = 1UP, 18 = Over/Under (1.5, 2.5), 29 = GG/NG, 10 = Double Chance,
// 219/186/251 = Basketball/NFL/Tennis/Baseball Moneyline
const TRACKED_MARKET_IDS = new Set(['1', '60200', '18', '29', '10', '219', '186', '251']);

let store = null;
let dirty = false;
let saveChain = Promise.resolve();
let saveTimer = null;

function ensureLoaded() {
  if (store) return store;
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (raw && typeof raw === 'object' && raw.events) {
        store = raw;
        return store;
      }
    }
  } catch {
    // start clean if file missing or unreadable
  }
  store = {
    updatedAt: null,
    snapshotsRecorded: 0,
    events: {},
  };
  return store;
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushOddsHistory();
  }, 2500);
  saveTimer.unref?.();
}

export function flushOddsHistory() {
  if (!dirty || !store) return saveChain;
  dirty = false;
  const payload = JSON.stringify(store);
  saveChain = saveChain.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${HISTORY_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, payload, 'utf8');
    await fsp.rename(tmp, HISTORY_FILE);
  }).catch(() => {});
  return saveChain;
}

function makeSelKey(marketId, specifier = '', outcomeId) {
  return `${marketId}|${specifier || ''}|${outcomeId}`;
}

function shouldTrackMarket(mid, spec = '') {
  if (!TRACKED_MARKET_IDS.has(mid)) return false;
  if (mid === '18') {
    return /total=(1\.5|2\.5|3\.5)(?:\b|$)/.test(spec);
  }
  return true;
}

/**
 * Record a live timestamped snapshot of SportyBet Ghana odds across all upcoming catalog events.
 */
export function recordCatalogOddsSnapshot(events = []) {
  if (!Array.isArray(events) || !events.length) return { recordedEvents: 0, updatedSelections: 0 };
  const db = ensureLoaded();
  const now = Date.now();
  let recordedEvents = 0;
  let updatedSelections = 0;

  // Prune finished events > 24h after scheduled start so disk file stays compact
  for (const [evId, rec] of Object.entries(db.events)) {
    const startMs = Number(rec?.startTime) || 0;
    if (startMs > 0 && now - startMs > PRUNE_AFTER_KICKOFF_MS) {
      delete db.events[evId];
      dirty = true;
    }
  }

  for (const ev of events) {
    if (!ev?.eventId || !Array.isArray(ev.markets) || !ev.markets.length) continue;
    const startMs = Number(ev.estimateStartTime) || 0;
    if (startMs > 0 && startMs <= now) continue; // only record pre-match odds

    let evRec = db.events[ev.eventId];
    if (!evRec) {
      evRec = {
        eventId: ev.eventId,
        gameId: ev.gameId || null,
        home: ev.homeTeamName,
        away: ev.awayTeamName,
        matchup: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        leagueName: ev.leagueLabel || ev.tournamentName || 'Football',
        sport: ev.sportType || 'soccer',
        startTime: startMs,
        date: ev.date || (startMs ? new Date(startMs).toISOString() : null),
        firstSeenTs: now,
        lastSeenTs: now,
        selections: {},
      };
      db.events[ev.eventId] = evRec;
      dirty = true;
    } else {
      evRec.lastSeenTs = now;
      if (startMs) evRec.startTime = startMs;
    }

    let touchedEv = false;
    for (const m of ev.markets) {
      const mid = String(m.id);
      const spec = m.specifier || '';
      if (!shouldTrackMarket(mid, spec)) continue;

      for (const o of m.outcomes || []) {
        if (o.isActive !== 1) continue;
        const odds = +Number(o.odds).toFixed(3);
        if (!Number.isFinite(odds) || odds <= 1.01) continue;
        const brProb = Number.isFinite(Number(o.probability)) ? +Number(o.probability).toFixed(4) : null;
        const sk = makeSelKey(mid, spec, String(o.id));
        const label = `${m.desc || m.name || mid}: ${o.desc || o.id}`;

        let sRec = evRec.selections[sk];
        if (!sRec) {
          sRec = {
            marketId: mid,
            specifier: spec,
            outcomeId: String(o.id),
            marketDesc: m.desc || m.name || mid,
            outcomeDesc: o.desc || String(o.id),
            label,
            openOdds: odds,
            openTs: now,
            prevOdds: odds,
            prevTs: now,
            curOdds: odds,
            curTs: now,
            minOdds: odds,
            maxOdds: odds,
            brProb,
            points: [[now, odds]],
          };
          evRec.selections[sk] = sRec;
          touchedEv = true;
          updatedSelections++;
          dirty = true;
        } else {
          const lastPt = sRec.points[sRec.points.length - 1];
          const lastOdds = lastPt ? lastPt[1] : sRec.curOdds;
          const lastTs = lastPt ? lastPt[0] : sRec.curTs;
          const delta = Math.abs(odds - lastOdds);
          const elapsed = now - lastTs;

          if (delta >= MIN_ODDS_DELTA) {
            sRec.prevOdds = sRec.curOdds;
            sRec.prevTs = sRec.curTs;
          }
          sRec.curOdds = odds;
          sRec.curTs = now;
          if (brProb !== null) sRec.brProb = brProb;
          if (odds < sRec.minOdds) sRec.minOdds = odds;
          if (odds > sRec.maxOdds) sRec.maxOdds = odds;

          if (delta >= MIN_ODDS_DELTA || elapsed >= MIN_POINT_INTERVAL_MS) {
            sRec.points.push([now, odds]);
            if (sRec.points.length > MAX_POINTS_PER_SEL) {
              // Always keep index 0 (opening snapshot) + latest N-1 points
              sRec.points = [sRec.points[0], ...sRec.points.slice(-(MAX_POINTS_PER_SEL - 1))];
            }
            touchedEv = true;
            updatedSelections++;
            dirty = true;
          }
        }
      }
    }
    if (touchedEv) recordedEvents++;
  }

  db.updatedAt = new Date(now).toISOString();
  db.snapshotsRecorded = (db.snapshotsRecorded || 0) + (updatedSelections > 0 ? 1 : 0);
  if (dirty) scheduleSave();

  return { recordedEvents, updatedSelections };
}

/**
 * Compute real observed time-series movement metrics for a specific SportyBet selection.
 */
export function getSelectionMovement(eventId, marketId, specifier = '', outcomeId = '') {
  const db = ensureLoaded();
  const evRec = db.events[eventId];
  if (!evRec) return null;
  const sk = makeSelKey(String(marketId), specifier || '', String(outcomeId));
  const sRec = evRec.selections?.[sk];
  if (!sRec || !sRec.openOdds || !sRec.curOdds) return null;

  const openOdds = Number(sRec.openOdds);
  const curOdds = Number(sRec.curOdds);
  const prevOdds = Number(sRec.prevOdds || openOdds);
  // Peak-to-current drop also captures cases where odds drifted slightly then crashed hard
  const refHigh = Math.max(openOdds, Number(sRec.maxOdds || openOdds));
  const openDropPct = +(((openOdds - curOdds) / openOdds) * 100).toFixed(1); // positive = odds shortened (dropped)
  const peakDropPct = +(((refHigh - curOdds) / refHigh) * 100).toFixed(1);
  const dropPct = Math.max(openDropPct, peakDropPct);
  const impliedOpen = 1 / openOdds;
  const impliedCur = 1 / curOdds;
  const impliedJumpPct = +((impliedCur - impliedOpen) * 100).toFixed(1);
  const elapsedHours = +Math.max(0.05, (sRec.curTs - sRec.openTs) / 3600000).toFixed(2);

  return {
    openOdds: +openOdds.toFixed(2),
    prevOdds: +prevOdds.toFixed(2),
    curOdds: +curOdds.toFixed(2),
    minOdds: +Number(sRec.minOdds || curOdds).toFixed(2),
    maxOdds: +Number(sRec.maxOdds || openOdds).toFixed(2),
    openDropPct,
    dropPct,
    impliedJumpPct,
    snapshotsCount: sRec.points?.length || 1,
    elapsedHours,
    openAt: new Date(sRec.openTs).toISOString(),
    updatedAt: new Date(sRec.curTs).toISOString(),
    points: (sRec.points || []).map(([ts, od]) => ({ ts, odds: +Number(od).toFixed(2) })),
    isSteamCrash: dropPct >= 5.0 && impliedJumpPct >= 2.2,
  };
}

/**
 * Scan all tracked upcoming SportyBet Ghana fixtures for genuine multi-snapshot odds drops (steam plunges).
 */
export function getSignificantOddsDrops({ minDropPct = 4.5, limit = 60 } = {}) {
  const db = ensureLoaded();
  const now = Date.now();
  const drops = [];

  for (const evRec of Object.values(db.events)) {
    if (!evRec?.startTime || evRec.startTime <= now + 3 * 60 * 1000) continue;
    for (const sRec of Object.values(evRec.selections || {})) {
      if (!sRec.points || sRec.points.length < 2) continue;
      const openOdds = Number(sRec.openOdds);
      const curOdds = Number(sRec.curOdds);
      const refHigh = Math.max(openOdds, Number(sRec.maxOdds || openOdds));
      if (!Number.isFinite(openOdds) || !Number.isFinite(curOdds) || curOdds >= refHigh) continue;
      if (curOdds > 4.80) continue; // focus on playable favorites/contenders/totals, not 25.0 -> 22.0 noise

      const dropPct = +(((refHigh - curOdds) / refHigh) * 100).toFixed(1);
      const impliedJumpPct = +(((1 / curOdds) - (1 / refHigh)) * 100).toFixed(1);
      if (dropPct < minDropPct || impliedJumpPct < 1.8) continue;

      const firstTs = sRec.points[0]?.[0] || sRec.openTs;
      const elapsedHours = +Math.max(0.1, (sRec.curTs - firstTs) / 3600000).toFixed(2);
      const velocityPerHour = +(dropPct / Math.max(0.25, elapsedHours)).toFixed(1);

      drops.push({
        id: `drop:${evRec.eventId}:${sRec.marketId}:${sRec.specifier}:${sRec.outcomeId}`,
        eventId: evRec.eventId,
        gameId: evRec.gameId,
        matchup: evRec.matchup,
        home: evRec.home,
        away: evRec.away,
        leagueName: evRec.leagueName,
        sport: evRec.sport,
        date: evRec.date,
        startTime: evRec.startTime,
        marketId: sRec.marketId,
        specifier: sRec.specifier,
        outcomeId: sRec.outcomeId,
        marketDesc: sRec.marketDesc,
        outcomeDesc: sRec.outcomeDesc,
        label: sRec.label,
        openOdds: +openOdds.toFixed(2),
        peakOdds: +refHigh.toFixed(2),
        prevOdds: +Number(sRec.prevOdds || openOdds).toFixed(2),
        curOdds: +curOdds.toFixed(2),
        dropPct,
        impliedJumpPct,
        velocityPerHour,
        snapshotsCount: sRec.points.length,
        elapsedHours,
        severity: dropPct >= 11 || impliedJumpPct >= 6.0 ? 'high' : 'medium',
        points: sRec.points.map(([ts, od]) => ({ ts, odds: +Number(od).toFixed(2) })),
        sportySelection: {
          eventId: evRec.eventId,
          marketId: String(sRec.marketId),
          outcomeId: String(sRec.outcomeId),
          specifier: sRec.specifier || '',
        },
      });
    }
  }

  drops.sort((a, b) => (b.dropPct + b.impliedJumpPct * 0.8) - (a.dropPct + a.impliedJumpPct * 0.8));
  return drops.slice(0, limit);
}

/**
 * Retrieve the full recorded time-series odds history for a single SportyBet eventId.
 */
export function getEventOddsHistory(eventId) {
  const db = ensureLoaded();
  const evRec = db.events[eventId];
  if (!evRec) return null;
  const selections = Object.values(evRec.selections || {}).map((s) => {
    const mov = getSelectionMovement(eventId, s.marketId, s.specifier, s.outcomeId);
    return {
      marketId: s.marketId,
      specifier: s.specifier,
      outcomeId: s.outcomeId,
      label: s.label,
      marketDesc: s.marketDesc,
      outcomeDesc: s.outcomeDesc,
      ...mov,
    };
  });
  return {
    eventId: evRec.eventId,
    matchup: evRec.matchup,
    leagueName: evRec.leagueName,
    date: evRec.date,
    firstSeenAt: new Date(evRec.firstSeenTs).toISOString(),
    lastSeenAt: new Date(evRec.lastSeenTs).toISOString(),
    selections,
  };
}

export function getOddsTrackerStats() {
  const db = ensureLoaded();
  const eventsCount = Object.keys(db.events || {}).length;
  let selectionsCount = 0;
  let multiPointSelections = 0;
  for (const ev of Object.values(db.events || {})) {
    for (const s of Object.values(ev.selections || {})) {
      selectionsCount++;
      if ((s.points?.length || 0) >= 2) multiPointSelections++;
    }
  }
  return {
    updatedAt: db.updatedAt,
    snapshotsRecorded: db.snapshotsRecorded || 0,
    eventsTracked: eventsCount,
    selectionsTracked: selectionsCount,
    multiPointSelections,
  };
}
