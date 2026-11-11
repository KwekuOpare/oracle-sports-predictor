// Pre-Kickoff Lineups, Key Injuries, Squad Rotation, Referee & Season Prop Stats Veto Gate (server/lineups.js)
// Queries 100% real live pre-match feeds:
//   1. Sportradar Gismo `match_info/{matchNum}` -> official assigned Referee, Stadium, Neutral Venue & Season ID
//   2. Sportradar Gismo `match_squads/{matchNum}` -> confirmed Starting XI (~60m pre-kickoff), Substitutes, Managers,
//      AND `previous.home` / `previous.away` Starting XIs (exact Squad Rotation % computation!)
//   3. Sportradar Gismo `match_funfacts/{matchNum}` -> official Sportradar pre-match streak & statistical facts
//   4. Sportradar Gismo `stats_season_uniqueteamstats/{seasonId}` & `stats_season_topgoals/{seasonId}` ->
//      official season Shots, SOT, Corners, Yellow/Red Cards, Offsides, Free-Kicks & Top Scorers per team
//   5. ESPN `getSummary(league, eventId)` -> real `injuries` (`Out`/`Doubtful`/`Questionable`), `officials`, & `rosters`

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCompetitorUid } from './history.js';
import { teamMatchScore } from './sportybet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'lineups_cache.json');

const GISMO_BASE = 'https://stats.fn.sportradar.com/sportybet/en/Etc:UTC/gismo';
const GISMO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.sportybet.com/gh/',
};

const MATCH_NEAR_TTL_MS = 5 * 60 * 1000;   // 5 mins when <= 85 mins before kickoff (catches confirmed XIs live!)
const MATCH_FAR_TTL_MS = 35 * 60 * 1000;   // 35 mins when > 85 mins before kickoff
const SEASON_TTL_MS = 6 * 60 * 60 * 1000;  // 6 hours for season-wide team prop stats & top scorers

const memStore = {
  matches: new Map(), // eventId -> { ts, data }
  seasons: new Map(), // seasonId -> { ts, teamStats, topScorersByTeam }
  loaded: false,
  dirty: false,
};

function loadDiskCache() {
  if (memStore.loaded) return;
  memStore.loaded = true;
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(raw.matches || {})) {
      if (v?.ts && now - v.ts < MATCH_FAR_TTL_MS * 2) memStore.matches.set(k, v);
    }
    for (const [k, v] of Object.entries(raw.seasons || {})) {
      if (v?.ts && now - v.ts < SEASON_TTL_MS * 2) memStore.seasons.set(k, v);
    }
  } catch {
    // ignore unreadable cache
  }
}

let saveTimer = null;
function scheduleDiskSave() {
  memStore.dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!memStore.dirty) return;
    memStore.dirty = false;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const matchesObj = Object.fromEntries([...memStore.matches.entries()].slice(-300));
      const seasonsObj = Object.fromEntries([...memStore.seasons.entries()].slice(-120));
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ matches: matchesObj, seasons: seasonsObj }));
    } catch {
      // non-fatal
    }
  }, 3000);
  saveTimer.unref?.();
}

async function fetchGismoJson(endpoint, timeoutMs = 4500) {
  try {
    const res = await fetch(`${GISMO_BASE}/${endpoint}`, {
      headers: GISMO_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const doc0 = json?.doc?.[0];
    if (!doc0 || doc0.event === 'exception') return null;
    return doc0.data || null;
  } catch {
    return null;
  }
}

function formatPersonName(rawName = '') {
  if (!rawName) return '';
  const s = String(rawName).trim();
  if (s.includes(',')) {
    const [last, first] = s.split(',').map((x) => x.trim());
    return first ? `${first} ${last}` : last;
  }
  return s;
}

function parseLineupBlock(sideObj) {
  const lu = sideObj?.startinglineup;
  const players = Array.isArray(lu?.players) ? lu.players : [];
  return {
    formation: lu?.formation || null,
    confirmed: players.length >= 11,
    players: players.map((p) => ({
      id: String(p.playerid || p._id || ''),
      name: formatPersonName(p.playername || p.name || ''),
      rawName: p.playername || p.name || '',
      pos: p.pos || p.matchpos || '',
      shirt: p.shirtnumber || '',
    })),
    manager: formatPersonName(sideObj?.manager?.name || ''),
  };
}

async function getSeasonIntel(seasonId) {
  if (!seasonId) return null;
  loadDiskCache();
  const key = String(seasonId);
  const cached = memStore.seasons.get(key);
  if (cached && Date.now() - cached.ts < SEASON_TTL_MS) return cached;

  const [utData, tgData] = await Promise.all([
    fetchGismoJson(`stats_season_uniqueteamstats/${key}`, 5000),
    fetchGismoJson(`stats_season_topgoals/${key}`, 5000),
  ]);

  const teamStats = {};
  const rawTeams = utData?.stats?.uniqueteams || {};
  for (const [uid, t] of Object.entries(rawTeams)) {
    const mCount = Number(t?.matches?.matches || t?.matches?.total || 0);
    if (!mCount) continue;
    const sotAvg = Number(t?.shots_on_goal?.average || 0);
    const offAvg = Number(t?.shots_off_goal?.average || 0);
    const blkAvg = Number(t?.shots_blocked?.average || 0);
    const shotsAvg = +(sotAvg + offAvg + blkAvg).toFixed(2);
    const cornersAvg = +Number(t?.corner_kicks?.average || 0).toFixed(2);
    const cardsAvg = +Number(t?.cards_given?.average ?? t?.yellow_cards?.average ?? 0).toFixed(2);
    const yellowAvg = +Number(t?.yellow_cards?.average || 0).toFixed(2);
    const redAvg = +Number(t?.red_cards?.average || 0).toFixed(3);
    const offsidesAvg = +Number(t?.offside?.average || 0).toFixed(2);
    const freekicksAvg = +Number(t?.freekicks?.average || 0).toFixed(2);
    const possessionAvg = +Number(t?.ball_possession?.average || 0).toFixed(1);
    const cleanSheets = Number(t?.clean_sheet?.total || 0);

    teamStats[String(uid)] = {
      uid: String(uid),
      name: t?.uniqueteam?.name || '',
      matches: mCount,
      shotsAvg,
      sotAvg: +sotAvg.toFixed(2),
      cornersAvg,
      cardsAvg,
      yellowAvg,
      redAvg,
      offsidesAvg,
      freekicksAvg,
      possessionAvg,
      cleanSheetRate: +(cleanSheets / mCount).toFixed(3),
    };
  }

  const topScorersByTeam = {};
  for (const entry of tgData?.players || []) {
    const goals = Number(entry?.total?.goals || 0);
    if (goals < 1) continue;
    const pid = String(entry?.playerid || entry?._id || '');
    const pName = formatPersonName(entry?.player?.name || entry?.player?.fullname || '');
    const pMatches = Number(entry?.total?.matches || 0);
    for (const tUid of Object.keys(entry?.teams || {})) {
      topScorersByTeam[tUid] ||= [];
      if (topScorersByTeam[tUid].length < 4) {
        topScorersByTeam[tUid].push({ id: pid, name: pName, goals, matches: pMatches });
      }
    }
  }

  const record = { ts: Date.now(), teamStats, topScorersByTeam };
  memStore.seasons.set(key, record);
  scheduleDiskSave();
  return record;
}

function computeRotationMetrics(currentXI, prevXI, topScorers = [], espnStarters = []) {
  // Prefer Sportradar confirmed XI; fallback to ESPN confirmed starters if posted
  const hasSrXI = currentXI?.confirmed && currentXI.players.length >= 11;
  const hasEspnXI = !hasSrXI && Array.isArray(espnStarters) && espnStarters.length >= 11;
  const confirmed = hasSrXI || hasEspnXI;

  const activeNames = hasSrXI
    ? currentXI.players.map((p) => p.name)
    : hasEspnXI
      ? espnStarters.map((p) => p.name)
      : [];

  let retainedStarters = null;
  let rotatedCount = null;
  let missingPrevStarters = [];

  if (hasSrXI && prevXI?.players?.length >= 11) {
    const curIds = new Set(currentXI.players.map((p) => p.id).filter(Boolean));
    retainedStarters = 0;
    for (const prevP of prevXI.players) {
      if (prevP.id && curIds.has(prevP.id)) retainedStarters++;
      else missingPrevStarters.push(prevP.name);
    }
    rotatedCount = Math.max(0, 11 - retainedStarters);
  }

  let missingTopScorers = [];
  if (confirmed && topScorers.length) {
    for (const ts of topScorers.filter((x) => x.goals >= 2)) {
      const inXI = hasSrXI
        ? currentXI.players.some((p) => p.id === ts.id || teamMatchScore(p.name, ts.name) >= 0.85)
        : activeNames.some((nm) => teamMatchScore(nm, ts.name) >= 0.80);
      if (!inXI) missingTopScorers.push(ts);
    }
  }

  return {
    confirmed,
    formation: currentXI?.formation || null,
    prevFormation: prevXI?.formation || null,
    manager: currentXI?.manager || null,
    starters: hasSrXI ? currentXI.players : (hasEspnXI ? espnStarters : []),
    prevStartersCount: prevXI?.players?.length || 0,
    retainedStarters,
    rotatedCount,
    missingPrevStarters: missingPrevStarters.slice(0, 5),
    topScorers,
    missingTopScorers,
  };
}

function summarizeEspnInjuries(espnSummary, teamName, topScorers = []) {
  if (!espnSummary?.injuries?.length || !teamName) {
    return { outCount: 0, doubtfulCount: 0, keyOut: [], all: [] };
  }
  const block = espnSummary.injuries.find((b) => teamMatchScore(b.team, teamName) >= 0.65);
  if (!block?.players?.length) {
    return { outCount: 0, doubtfulCount: 0, keyOut: [], all: [] };
  }

  let outCount = 0;
  let doubtfulCount = 0;
  const keyOut = [];
  const all = [];

  for (const p of block.players) {
    const st = String(p.status || '').toLowerCase();
    const isOut = /out|suspended|injured reserve|ir\b/i.test(st);
    const isDoubt = /doubtful|questionable/i.test(st);
    const matchedScorer = topScorers.find((ts) => teamMatchScore(ts.name, p.name) >= 0.80);
    const item = {
      name: p.name,
      position: p.position || '',
      status: p.status || 'Out',
      detail: p.detail || '',
      goals: matchedScorer?.goals || 0,
    };
    all.push(item);
    if (isOut) {
      outCount++;
      if (matchedScorer || ['F', 'FW', 'ST', 'CF', 'AM', 'M', 'G', 'GK'].includes(String(p.position || '').toUpperCase())) {
        keyOut.push(item);
      }
    } else if (isDoubt) {
      doubtfulCount++;
    }
  }

  return { outCount, doubtfulCount, keyOut: keyOut.slice(0, 5), all: all.slice(0, 10) };
}

function findSeasonTeamStat(seasonIntel, uid, teamName) {
  if (!seasonIntel?.teamStats) return null;
  if (uid && seasonIntel.teamStats[String(uid)]) return seasonIntel.teamStats[String(uid)];
  for (const st of Object.values(seasonIntel.teamStats)) {
    if (teamMatchScore(st.name, teamName) >= 0.80) return st;
  }
  return null;
}

/**
 * Fetch & assemble real pre-match Lineup, Squad Rotation, Injuries, Referee, Stadium & Season Prop Stats
 * for a single SportyBet event.
 */
export async function inspectMatchLineupAndReferee(event, espnSummary = null) {
  if (!event?.eventId) return null;
  loadDiskCache();

  const now = Date.now();
  const startMs = Number(event.estimateStartTime) || (event.date ? new Date(event.date).getTime() : 0);
  const minsToKickoff = startMs ? (startMs - now) / 60000 : 999;
  const ttl = minsToKickoff <= 85 ? MATCH_NEAR_TTL_MS : MATCH_FAR_TTL_MS;

  const cached = memStore.matches.get(event.eventId);
  if (cached && now - cached.ts < ttl && (!espnSummary || cached.data?.hasEspnSummary)) {
    return cached.data;
  }

  const matchNum = extractCompetitorUid(event.eventId);
  const homeUid = extractCompetitorUid(event.homeTeamId);
  const awayUid = extractCompetitorUid(event.awayTeamId);
  const isSoccer = !event.sportType || event.sportType === 'soccer';

  let infoData = null;
  let squadsData = null;
  let factsData = null;

  if (matchNum && isSoccer) {
    [infoData, squadsData, factsData] = await Promise.all([
      fetchGismoJson(`match_info/${matchNum}`),
      fetchGismoJson(`match_squads/${matchNum}`),
      fetchGismoJson(`match_funfacts/${matchNum}`),
    ]);
  }

  const seasonId = infoData?.season?._id ? String(infoData.season._id) : null;
  const seasonIntel = seasonId ? await getSeasonIntel(seasonId) : null;

  const srRef = infoData?.referee || infoData?.match?.referee || null;
  const espnRef = espnSummary?.officials?.[0] || null;
  const referee = srRef?.name
    ? {
        id: srRef._id ? String(srRef._id) : null,
        name: formatPersonName(srRef.name),
        country: srRef.nationality?.name || srRef.nationality?.ioc || null,
        source: 'Sportradar Official Assignment',
      }
    : espnRef?.name
      ? {
          id: null,
          name: espnRef.name,
          country: null,
          source: 'ESPN Match Official',
        }
      : null;

  const stadium = infoData?.stadium?.name
    ? {
        name: infoData.stadium.name,
        city: infoData.stadium.city || null,
        capacity: infoData.stadium.capacity || null,
        neutral: Boolean(infoData?.match?.neutralground),
      }
    : null;

  const homeTopScorers = (homeUid && seasonIntel?.topScorersByTeam?.[homeUid]) || [];
  const awayTopScorers = (awayUid && seasonIntel?.topScorersByTeam?.[awayUid]) || [];

  const curHomeXI = parseLineupBlock(squadsData?.home);
  const curAwayXI = parseLineupBlock(squadsData?.away);
  const prevHomeXI = parseLineupBlock(squadsData?.previous?.home);
  const prevAwayXI = parseLineupBlock(squadsData?.previous?.away);

  const espnHomeRoster = espnSummary?.rosters?.find((r) => r.homeAway === 'home' || teamMatchScore(r.team, event.homeTeamName) >= 0.65);
  const espnAwayRoster = espnSummary?.rosters?.find((r) => r.homeAway === 'away' || teamMatchScore(r.team, event.awayTeamName) >= 0.65);

  const homeLineup = computeRotationMetrics(curHomeXI, prevHomeXI, homeTopScorers, espnHomeRoster?.starters || []);
  const awayLineup = computeRotationMetrics(curAwayXI, prevAwayXI, awayTopScorers, espnAwayRoster?.starters || []);

  const homeInjuries = summarizeEspnInjuries(espnSummary, event.homeTeamName, homeTopScorers);
  const awayInjuries = summarizeEspnInjuries(espnSummary, event.awayTeamName, awayTopScorers);

  const homeSeasonStats = findSeasonTeamStat(seasonIntel, homeUid, event.homeTeamName);
  const awaySeasonStats = findSeasonTeamStat(seasonIntel, awayUid, event.awayTeamName);

  // Build combined match prop expectations from real official season stats when both teams have >= 3 games
  let seasonPropProfile = null;
  if (homeSeasonStats?.matches >= 3 && awaySeasonStats?.matches >= 3) {
    const combinedCardsAvg = +(homeSeasonStats.cardsAvg + awaySeasonStats.cardsAvg).toFixed(2);
    const combinedCornersAvg = +(homeSeasonStats.cornersAvg + awaySeasonStats.cornersAvg).toFixed(2);
    const combinedShotsAvg = +(homeSeasonStats.shotsAvg + awaySeasonStats.shotsAvg).toFixed(1);
    const combinedSotAvg = +(homeSeasonStats.sotAvg + awaySeasonStats.sotAvg).toFixed(2);
    const combinedOffsidesAvg = +(homeSeasonStats.offsidesAvg + awaySeasonStats.offsidesAvg).toFixed(2);
    const cardDiscipline = combinedCardsAvg >= 4.4 ? 'strict_high_cards' : combinedCardsAvg <= 2.8 ? 'lenient_low_cards' : 'normal';
    seasonPropProfile = {
      home: homeSeasonStats,
      away: awaySeasonStats,
      combinedCardsAvg,
      combinedCornersAvg,
      combinedShotsAvg,
      combinedSotAvg,
      combinedOffsidesAvg,
      cardDiscipline,
    };
  }

  const funFacts = (factsData?.funfacts || [])
    .map((f) => (typeof f === 'string' ? f : f?.fact || ''))
    .filter(Boolean)
    .slice(0, 4);

  const lineupConfirmed = homeLineup.confirmed && awayLineup.confirmed;
  const result = {
    eventId: event.eventId,
    matchup: `${event.homeTeamName} vs ${event.awayTeamName}`,
    home: event.homeTeamName,
    away: event.awayTeamName,
    minsToKickoff: Math.round(minsToKickoff),
    lineupConfirmed,
    lineupStatusLabel: lineupConfirmed
      ? `✅ Official Starting XIs Confirmed (${homeLineup.formation || 'XI'} vs ${awayLineup.formation || 'XI'})`
      : `📋 Pre-Lineup Squad & Injury Check (Official XI posts ~60m pre-kickoff)`,
    referee,
    stadium,
    homeLineup,
    awayLineup,
    homeInjuries,
    awayInjuries,
    seasonPropProfile,
    funFacts,
    hasEspnSummary: Boolean(espnSummary),
    checkedAt: new Date(now).toISOString(),
  };

  memStore.matches.set(event.eventId, { ts: now, data: result });
  scheduleDiskSave();
  return result;
}

/**
 * Batch-inspect top upcoming matches with controlled concurrency.
 */
export async function batchInspectLineupsAndReferees(events = [], espnSummaryMap = new Map(), { maxEvents = 55, concurrency = 8 } = {}) {
  const out = new Map();
  const targets = events.slice(0, maxEvents);
  for (let i = 0; i < targets.length; i += concurrency) {
    const slice = targets.slice(i, i + concurrency);
    const rows = await Promise.all(
      slice.map((ev) => inspectMatchLineupAndReferee(ev, espnSummaryMap.get(ev.eventId) || null).catch(() => null))
    );
    for (let j = 0; j < slice.length; j++) {
      if (rows[j]) out.set(slice[j].eventId, rows[j]);
    }
  }
  return out;
}

/**
 * Vet and calibrate a SportyBet candidate selection against real Confirmed Lineups, Squad Rotation,
 * Key Injuries, Referee Assignment, and Official Season Team Prop Stats.
 */
export function vetSelectionWithLineupAndReferee(sel, intel) {
  if (!intel) return { veto: false };

  const mk = String(sel.marketKey || '').toLowerCase();
  const sk = String(sel.selKey || '').toLowerCase();
  let pDelta = 0;
  let veto = false;
  let vetoReason = null;
  const badges = [];
  const notes = [];

  // Identify if this selection backs Home or Away specifically
  const backsHome = (
    (['1x2', '1up', '2up', 'dnb', 'ml', '1h_1x2', '1h_dnb', 'ht_or_ft'].includes(mk) && sk === 'home') ||
    (mk === 'dc' && sk === '1x') ||
    (mk.startsWith('dc_ou') && sk.startsWith('1x_')) ||
    (mk.startsWith('1x2_ou') && sk.startsWith('home_')) ||
    mk === 'home_or_o25' ||
    mk === 'home_or_gg'
  );
  const backsAway = (
    (['1x2', '1up', '2up', 'dnb', 'ml', '1h_1x2', '1h_dnb', 'ht_or_ft'].includes(mk) && sk === 'away') ||
    (mk === 'dc' && sk === 'x2') ||
    (mk.startsWith('dc_ou') && sk.startsWith('x2_')) ||
    (mk.startsWith('1x2_ou') && sk.startsWith('away_')) ||
    mk === 'away_or_o25' ||
    mk === 'away_or_gg'
  );

  if (backsHome || backsAway) {
    const myLU = backsHome ? intel.homeLineup : intel.awayLineup;
    const oppLU = backsHome ? intel.awayLineup : intel.homeLineup;
    const myInj = backsHome ? intel.homeInjuries : intel.awayInjuries;
    const oppInj = backsHome ? intel.awayInjuries : intel.homeInjuries;
    const myTeam = backsHome ? intel.home : intel.away;

    // 1. Confirmed Starting XI Squad Rotation Check
    if (myLU?.confirmed) {
      if (myLU.rotatedCount !== null) {
        const oppRot = oppLU?.rotatedCount ?? 2;
        if (myLU.rotatedCount >= 5 && oppRot <= 2) {
          veto = true;
          vetoReason = `Heavy squad rotation: ${myTeam} rotated ${myLU.rotatedCount}/11 starters vs previous match`;
        } else if (myLU.rotatedCount >= 4 && myLU.missingTopScorers?.length >= 1) {
          veto = true;
          vetoReason = `${myTeam} rotated ${myLU.rotatedCount}/11 starters & rested top scorer ${myLU.missingTopScorers[0].name}`;
        } else if (myLU.retainedStarters >= 8) {
          pDelta += 0.014;
          badges.push(`✅ XI Confirmed (${myLU.retainedStarters}/11 regulars)`);
        } else {
          pDelta -= 0.018;
          badges.push(`⚠️ XI Rotated (${myLU.rotatedCount} changes)`);
        }
      } else {
        badges.push(`✅ Confirmed XI${myLU.formation ? ` (${myLU.formation})` : ''}`);
      }
      if (!veto && myLU.missingTopScorers?.length >= 1) {
        pDelta -= 0.022;
        notes.push(`Top scorer ${myLU.missingTopScorers[0].name} (${myLU.missingTopScorers[0].goals}G) not in Starting XI`);
      }
    }

    // 2. ESPN Verified Injury List Check
    if (!veto && (myInj?.outCount > 0 || oppInj?.outCount > 0)) {
      const asym = (myInj?.outCount || 0) - (oppInj?.outCount || 0);
      if ((myInj?.keyOut?.length || 0) >= 3 && asym >= 3 && sel.p < 0.78) {
        veto = true;
        vetoReason = `Severe injury crisis: ${myTeam} has ${myInj.outCount} players Out (${myInj.keyOut.map((x) => x.name).slice(0, 2).join(', ')})`;
      } else if (asym >= 3) {
        pDelta -= 0.02;
        badges.push(`🩺 ${myInj.outCount} Out Injured`);
      } else if (asym <= -3) {
        pDelta += 0.015;
        badges.push(`🩺 Opponent missing ${oppInj.outCount} players`);
      }
    }
  }

  // 3. Official Season Team Prop Profile & Referee Discipline Check (Shots, SOT, Corners, Cards, Offsides)
  const prof = intel.seasonPropProfile;
  if (!veto && prof) {
    if (mk.startsWith('cards') || sel.group === 'Cards') {
      const lineMatch = mk.match(/(\d+(?:\.\d+)?)/) || String(sel.label || '').match(/(\d+(?:\.\d+)?)/);
      const line = lineMatch ? Number(lineMatch[1]) : 3.5;
      if (sk === 'over' || /\+/.test(sel.label || '')) {
        if (prof.combinedCardsAvg < line - 1.05) {
          veto = true;
          vetoReason = `Lenient card profile: teams average only ${prof.combinedCardsAvg} cards/match combined (line ${line})`;
        } else if (prof.combinedCardsAvg >= line + 0.55) {
          pDelta += 0.018;
          badges.push(`🟨 ${prof.combinedCardsAvg} Cards/g avg`);
        }
      } else if (sk === 'under' && prof.combinedCardsAvg > line + 0.9) {
        veto = true;
        vetoReason = `High-card teams (${prof.combinedCardsAvg} cards/g) conflict with Under ${line}`;
      }
    } else if (mk.startsWith('corners') && mk !== 'corners_1x2') {
      const lineMatch = mk.match(/(\d+(?:\.\d+)?)/);
      const line = lineMatch ? Number(lineMatch[1]) : 9.5;
      const isTeam = mk.includes('home') || mk.includes('away');
      const expected = isTeam
        ? (mk.includes('home') ? prof.home.cornersAvg : prof.away.cornersAvg)
        : (mk.includes('1h') ? prof.combinedCornersAvg * 0.48 : prof.combinedCornersAvg);
      if (sk === 'over' && expected < line - 1.6) {
        veto = true;
        vetoReason = `Season corners avg (${expected.toFixed(1)}) well below Over ${line}`;
      } else if (sk === 'over' && expected >= line + 0.8) {
        pDelta += 0.016;
        badges.push(`🚩 ${expected.toFixed(1)} Corners/g avg`);
      }
    } else if (mk === 'shots_1x2' || mk === 'sot_1x2') {
      const myStat = sk === 'home'
        ? (mk === 'sot_1x2' ? prof.home.sotAvg : prof.home.shotsAvg)
        : (mk === 'sot_1x2' ? prof.away.sotAvg : prof.away.shotsAvg);
      const oppStat = sk === 'home'
        ? (mk === 'sot_1x2' ? prof.away.sotAvg : prof.away.shotsAvg)
        : (mk === 'sot_1x2' ? prof.home.sotAvg : prof.home.shotsAvg);
      if (myStat < oppStat - 1.2) {
        veto = true;
        vetoReason = `Season ${mk === 'sot_1x2' ? 'SOT' : 'Shots'} avg (${myStat} vs ${oppStat}) contradicts pick`;
      } else if (myStat >= oppStat + 2.2) {
        pDelta += 0.02;
        badges.push(`🎯 ${myStat} vs ${oppStat} ${mk === 'sot_1x2' ? 'SOT' : 'Shots'}/g`);
      }
    } else if ((mk.startsWith('shots') || mk.startsWith('sot')) && (sk === 'over' || sk === 'under')) {
      const isSot = mk.startsWith('sot');
      const lineMatch = mk.match(/(\d+(?:\.\d+)?)/);
      const line = lineMatch ? Number(lineMatch[1]) : (isSot ? 8.5 : 23.5);
      const expected = mk.includes('home')
        ? (isSot ? prof.home.sotAvg : prof.home.shotsAvg)
        : mk.includes('away')
          ? (isSot ? prof.away.sotAvg : prof.away.shotsAvg)
          : (isSot ? prof.combinedSotAvg : prof.combinedShotsAvg);
      if (sk === 'over' && expected < line - (isSot ? 1.5 : 3.5)) {
        veto = true;
        vetoReason = `Season ${isSot ? 'SOT' : 'Shots'} avg (${expected.toFixed(1)}) below Over ${line}`;
      } else if (sk === 'over' && expected >= line + (isSot ? 0.9 : 2.2)) {
        pDelta += 0.016;
        badges.push(`🎯 ${expected.toFixed(1)} ${isSot ? 'SOT' : 'Shots'}/g avg`);
      }
    }
  }

  if (intel.referee?.name && (sel.group === 'Cards' || mk.startsWith('fouls') || badges.length === 0)) {
    badges.push(`👨‍⚖️ Ref: ${intel.referee.name}`);
  }
  if (intel.funFacts?.[0]) {
    notes.push(intel.funFacts[0]);
  }

  return {
    veto,
    vetoReason,
    pDelta: +Math.max(-0.04, Math.min(0.03, pDelta)).toFixed(4),
    lineupConfirmed: intel.lineupConfirmed,
    lineupBadge: badges.slice(0, 2).join(' · ') || null,
    lineupNote: notes[0] || null,
    refereeName: intel.referee?.name || null,
  };
}
