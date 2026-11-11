import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'history_cache.json');

const GISMO_BASE = 'https://stats.fn.sportradar.com/sportybet/en/Etc:UTC/gismo';
const GISMO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.sportybet.com/gh/',
};

const TEAM_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const H2H_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const memStore = {
  teams: new Map(), // teamUid -> { ts, matches }
  h2h: new Map(),   // "uidA:uidB" -> { ts, matches }
  uids: new Map(),  // matchNumId -> { homeUid, awayUid }
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
    for (const [k, v] of Object.entries(raw.teams || {})) {
      if (v?.ts && now - v.ts < TEAM_TTL_MS * 2) memStore.teams.set(k, v);
    }
    for (const [k, v] of Object.entries(raw.h2h || {})) {
      if (v?.ts && now - v.ts < H2H_TTL_MS * 2) memStore.h2h.set(k, v);
    }
    for (const [k, v] of Object.entries(raw.uids || {})) {
      memStore.uids.set(k, v);
    }
  } catch {
    // ignore corrupt cache
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
      // Keep cache compact (max 600 teams, 400 H2H pairs)
      const teamsObj = {};
      for (const [k, v] of [...memStore.teams.entries()].slice(-600)) teamsObj[k] = v;
      const h2hObj = {};
      for (const [k, v] of [...memStore.h2h.entries()].slice(-400)) h2hObj[k] = v;
      const uidsObj = Object.fromEntries([...memStore.uids.entries()].slice(-600));
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ teams: teamsObj, h2h: h2hObj, uids: uidsObj }));
    } catch {
      // non-fatal
    }
  }, 2500);
}

export function extractCompetitorUid(rawId) {
  if (!rawId) return null;
  const m = String(rawId).match(/(\d+)$/);
  return m ? m[1] : null;
}

function simplifyMatchRow(m) {
  const resH = m?.periods?.ft?.home ?? m?.result?.home;
  const resA = m?.periods?.ft?.away ?? m?.result?.away;
  if (resH == null || resA == null || !Number.isFinite(Number(resH)) || !Number.isFinite(Number(resA))) {
    return null;
  }
  const p1H = m?.periods?.p1?.home;
  const p1A = m?.periods?.p1?.away;
  return {
    id: m._id,
    uts: m?.time?.uts || 0,
    date: m?.time?.date || '',
    hUid: String(m?.teams?.home?.uid || ''),
    aUid: String(m?.teams?.away?.uid || ''),
    hName: m?.teams?.home?.name || '',
    aName: m?.teams?.away?.name || '',
    hg: Number(resH),
    ag: Number(resA),
    p1Goals: Number.isFinite(Number(p1H)) && Number.isFinite(Number(p1A)) ? Number(p1H) + Number(p1A) : null,
  };
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

async function getTeamRecentMatches(uid) {
  if (!uid) return [];
  loadDiskCache();
  const key = String(uid);
  const cached = memStore.teams.get(key);
  if (cached && Date.now() - cached.ts < TEAM_TTL_MS) return cached.matches || [];

  const data = await fetchGismoJson(`stats_team_lastx/${key}/15`);
  const matches = (data?.matches || [])
    .map(simplifyMatchRow)
    .filter(Boolean)
    .sort((a, b) => b.uts - a.uts)
    .slice(0, 15);

  if (matches.length) {
    memStore.teams.set(key, { ts: Date.now(), matches });
    scheduleDiskSave();
  } else if (cached?.matches) {
    return cached.matches;
  }
  return matches;
}

async function getDirectH2HMatches(homeUid, awayUid) {
  if (!homeUid || !awayUid) return [];
  loadDiskCache();
  const pairKey = [String(homeUid), String(awayUid)].sort().join(':');
  const cached = memStore.h2h.get(pairKey);
  if (cached && Date.now() - cached.ts < H2H_TTL_MS) return cached.matches || [];

  const data = await fetchGismoJson(`stats_team_versusrecent/${homeUid}/${awayUid}`);
  const matches = (data?.matches || [])
    .map(simplifyMatchRow)
    .filter(Boolean)
    .sort((a, b) => b.uts - a.uts)
    .slice(0, 10);

  memStore.h2h.set(pairKey, { ts: Date.now(), matches });
  scheduleDiskSave();
  return matches;
}

async function resolveMatchUids(event) {
  let homeUid = extractCompetitorUid(event?.homeTeamId);
  let awayUid = extractCompetitorUid(event?.awayTeamId);
  if (homeUid && awayUid) return { homeUid, awayUid };

  const matchNum = extractCompetitorUid(event?.eventId);
  if (!matchNum) return { homeUid: null, awayUid: null };
  loadDiskCache();
  const cached = memStore.uids.get(matchNum);
  if (cached?.homeUid && cached?.awayUid) return cached;

  const data = await fetchGismoJson(`stats_match_head2head/${matchNum}`);
  homeUid = data?.teams?.home?.uid ? String(data.teams.home.uid) : null;
  awayUid = data?.teams?.away?.uid ? String(data.teams.away.uid) : null;
  if (homeUid && awayUid) {
    memStore.uids.set(matchNum, { homeUid, awayUid });
    scheduleDiskSave();
  }
  return { homeUid, awayUid };
}

function summarizeTeamSample(matches, uid, isTargetHome, isSoccer = true) {
  const u = String(uid);
  const sample = matches.slice(0, 10);
  const n = sample.length;
  if (!n) return null;

  let wins = 0, draws = 0, losses = 0;
  let gf = 0, ga = 0;
  let over15 = 0, over25 = 0, under35 = 0, btts = 0, cleanSheets = 0, failedToScore = 0, scored1p = 0, scored2p = 0;
  let fhKnown = 0, fhOver05 = 0;
  let venuePlayed = 0, venueWins = 0, venueDraws = 0, venueGf = 0, venueGa = 0;
  const formChars = [];

  for (let i = 0; i < n; i++) {
    const m = sample[i];
    const wasHome = m.hUid === u;
    const myG = wasHome ? m.hg : m.ag;
    const oppG = wasHome ? m.ag : m.hg;
    const tot = myG + oppG;

    gf += myG;
    ga += oppG;
    if (myG > oppG) { wins++; if (i < 5) formChars.push('W'); }
    else if (myG === oppG) { draws++; if (i < 5) formChars.push('D'); }
    else { losses++; if (i < 5) formChars.push('L'); }

    if (tot >= 2) over15++;
    if (tot >= 3) over25++;
    if (tot <= 3) under35++;
    if (myG >= 1 && oppG >= 1) btts++;
    if (oppG === 0) cleanSheets++;
    if (myG === 0) failedToScore++;
    if (myG >= 1) scored1p++;
    if (myG >= 2) scored2p++;

    if (m.p1Goals != null) {
      fhKnown++;
      if (m.p1Goals >= 1) fhOver05++;
    }

    if ((isTargetHome && wasHome) || (!isTargetHome && !wasHome)) {
      venuePlayed++;
      venueGf += myG;
      venueGa += oppG;
      if (myG > oppG) venueWins++;
      else if (myG === oppG) venueDraws++;
    }
  }

  // Also examine full 15-game venue split if 10-game had < 4 venue games
  if (venuePlayed < 4 && matches.length > 10) {
    for (let i = 10; i < matches.length; i++) {
      const m = matches[i];
      const wasHome = m.hUid === u;
      if ((isTargetHome && wasHome) || (!isTargetHome && !wasHome)) {
        const myG = wasHome ? m.hg : m.ag;
        const oppG = wasHome ? m.ag : m.hg;
        venuePlayed++;
        venueGf += myG;
        venueGa += oppG;
        if (myG > oppG) venueWins++;
        else if (myG === oppG) venueDraws++;
      }
    }
  }

  return {
    played: n,
    wins,
    draws,
    losses,
    form5: formChars.join(''),
    recordStr: `${wins}W-${draws}D-${losses}L`,
    winRate: +(wins / n).toFixed(3),
    unbeatenRate: +((wins + draws) / n).toFixed(3),
    loseRate: +(losses / n).toFixed(3),
    gfAvg: +(gf / n).toFixed(2),
    gaAvg: +(ga / n).toFixed(2),
    totalGoalsAvg: +((gf + ga) / n).toFixed(2),
    over15Rate: isSoccer ? +(over15 / n).toFixed(3) : null,
    over25Rate: isSoccer ? +(over25 / n).toFixed(3) : null,
    under35Rate: isSoccer ? +(under35 / n).toFixed(3) : null,
    bttsRate: isSoccer ? +(btts / n).toFixed(3) : null,
    cleanSheetRate: isSoccer ? +(cleanSheets / n).toFixed(3) : null,
    failedToScoreRate: isSoccer ? +(failedToScore / n).toFixed(3) : null,
    scored1plusRate: isSoccer ? +(scored1p / n).toFixed(3) : null,
    scored2plusRate: isSoccer ? +(scored2p / n).toFixed(3) : null,
    fhOver05Rate: isSoccer && fhKnown >= 4 ? +(fhOver05 / fhKnown).toFixed(3) : null,
    venuePlayed,
    venueWinRate: venuePlayed >= 3 ? +(venueWins / venuePlayed).toFixed(3) : null,
    venueUnbeatenRate: venuePlayed >= 3 ? +((venueWins + venueDraws) / venuePlayed).toFixed(3) : null,
    venueGfAvg: venuePlayed >= 3 ? +(venueGf / venuePlayed).toFixed(2) : null,
    venueGaAvg: venuePlayed >= 3 ? +(venueGa / venuePlayed).toFixed(2) : null,
  };
}

function summarizeH2H(h2hMatches, homeUid, awayUid, isSoccer = true) {
  if (!h2hMatches?.length) return { count: 0 };
  const hU = String(homeUid);
  const sample = h2hMatches.slice(0, 8);
  const n = sample.length;
  let homeWins = 0, draws = 0, awayWins = 0, totalGoals = 0, over15 = 0, over25 = 0, btts = 0;
  const lastScores = [];

  for (let i = 0; i < n; i++) {
    const m = sample[i];
    // Align scores from the perspective of today's Home team vs today's Away team
    const hg = m.hUid === hU ? m.hg : m.ag;
    const ag = m.hUid === hU ? m.ag : m.hg;
    const tot = hg + ag;
    totalGoals += tot;
    if (hg > ag) homeWins++;
    else if (hg === ag) draws++;
    else awayWins++;
    if (tot >= 2) over15++;
    if (tot >= 3) over25++;
    if (hg >= 1 && ag >= 1) btts++;
    if (i < 4) lastScores.push(`${hg}-${ag}`);
  }

  return {
    count: n,
    homeWins,
    draws,
    awayWins,
    recordStr: `${homeWins}W-${draws}D-${awayWins}L`,
    homeWinRate: +(homeWins / n).toFixed(3),
    homeUnbeatenRate: +((homeWins + draws) / n).toFixed(3),
    awayWinRate: +(awayWins / n).toFixed(3),
    awayUnbeatenRate: +((awayWins + draws) / n).toFixed(3),
    avgGoals: +(totalGoals / n).toFixed(2),
    over15Rate: isSoccer ? +(over15 / n).toFixed(3) : null,
    over25Rate: isSoccer ? +(over25 / n).toFixed(3) : null,
    bttsRate: isSoccer ? +(btts / n).toFixed(3) : null,
    lastScores,
  };
}

/** Analyze full historical Last-15 form, venue splits & H2H for a single SportyBet event. */
export async function analyzeMatchHistory(event) {
  if (!event) return null;
  const { homeUid, awayUid } = await resolveMatchUids(event);
  if (!homeUid || !awayUid) return null;

  const isSoccer = !event.sportType || event.sportType === 'soccer';
  const [homeMatches, awayMatches, h2hMatches] = await Promise.all([
    getTeamRecentMatches(homeUid),
    getTeamRecentMatches(awayUid),
    getDirectH2HMatches(homeUid, awayUid),
  ]);

  const home = summarizeTeamSample(homeMatches, homeUid, true, isSoccer);
  const away = summarizeTeamSample(awayMatches, awayUid, false, isSoccer);
  if (!home || !away) return null;

  const h2h = summarizeH2H(h2hMatches, homeUid, awayUid, isSoccer);

  // Historical goal expectancy (soccer)
  let histLambdaHome = null;
  let histLambdaAway = null;
  let histTotalGoals = null;
  if (isSoccer) {
    const baseH = ((home.venueGfAvg ?? home.gfAvg) * 0.55 + (away.venueGaAvg ?? away.gaAvg) * 0.45);
    const baseA = ((away.venueGfAvg ?? away.gfAvg) * 0.55 + (home.venueGaAvg ?? home.gaAvg) * 0.45);
    histLambdaHome = +Math.max(0.25, Math.min(4.2, baseH)).toFixed(2);
    histLambdaAway = +Math.max(0.20, Math.min(3.8, baseA)).toFixed(2);
    const rawTot = histLambdaHome + histLambdaAway;
    histTotalGoals = +(h2h.count >= 3 ? rawTot * 0.75 + h2h.avgGoals * 0.25 : rawTot).toFixed(2);
  }

  return {
    verified: true,
    isSoccer,
    homeUid,
    awayUid,
    home,
    away,
    h2h,
    histLambdaHome,
    histLambdaAway,
    histTotalGoals,
  };
}

/**
 * Batch pre-fetch & analyze match history across a list of SportyBet events with bounded concurrency
 * so ticket/prop synthesis checks real match history fast (~1.5s cold, <5ms warm).
 */
export async function batchAnalyzeMatchHistory(events = [], { maxEvents = 110, concurrency = 14 } = {}) {
  const map = new Map();
  const targets = events.slice(0, maxEvents);
  let idx = 0;

  async function worker() {
    while (idx < targets.length) {
      const ev = targets[idx++];
      if (!ev?.eventId) continue;
      const hist = await analyzeMatchHistory(ev);
      if (hist) map.set(ev.eventId, hist);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length || 1) }, () => worker()));
  return map;
}

/** Poisson survival P(X > line) helper for historical lambda check. */
function poissonOverProb(lambda, line) {
  const kMax = Math.floor(line);
  let sum = 0;
  let term = Math.exp(-lambda);
  for (let k = 0; k <= kMax; k++) {
    if (k > 0) term = (term * lambda) / k;
    sum += term;
  }
  return Math.max(0.01, Math.min(0.99, 1 - sum));
}

/**
 * Vet a candidate betting selection against real historical form, venue splits & H2H!
 * - Vetoes dangerous form/H2H traps BEFORE suggesting any bet.
 * - Computes empirical historical probability & blends it with de-vigged model probability.
 * - Produces human-readable `historySummary` & `historyBadge` for full transparency.
 */
export function vetSelectionWithHistory(sel, hist) {
  if (!hist || !hist.verified) {
    return {
      veto: false,
      historyVerified: false,
      adjustedP: sel.p,
      historyBoost: 0,
      historyBadge: null,
      historySummary: null,
    };
  }

  const { home, away, h2h, isSoccer, histLambdaHome, histLambdaAway, histTotalGoals } = hist;
  const mkt = sel.marketKey || '';
  const sk = sel.selKey || '';
  const H = sel.home || 'Home';
  const A = sel.away || 'Away';

  let empiricalP = null;
  let veto = false;
  let vetoReason = null;
  let summary = '';

  const h2hShort = h2h.count >= 2
    ? ` · H2H (${h2h.count}): ${h2h.recordStr}${h2h.lastScores?.length ? ` [${h2h.lastScores.slice(0, 3).join(', ')}]` : ''}`
    : '';

  // 1. Match Winner / Moneyline / 1UP / 2UP / DNB
  if (['1x2', 'ml', '1up', '2up', 'dnb'].includes(mkt)) {
    if (sk === 'home') {
      const hWinBase = home.venueWinRate != null ? home.winRate * 0.55 + home.venueWinRate * 0.45 : home.winRate;
      const aLoseBase = away.loseRate;
      let emp = hWinBase * 0.58 + aLoseBase * 0.42;
      if (h2h.count >= 3) emp = emp * 0.78 + h2h.homeWinRate * 0.22;
      if (mkt === '1up') emp = Math.min(0.95, emp + 0.10);
      if (mkt === '2up') emp = Math.min(0.94, emp + 0.04);
      if (mkt === 'dnb') emp = Math.min(0.95, emp + 0.08);
      empiricalP = emp;

      if (home.played >= 5 && home.winRate < 0.30) {
        veto = true;
        vetoReason = `${H} won only ${home.wins}/${home.played} recent games (${home.form5})`;
      } else if (h2h.count >= 4 && h2h.homeWins === 0 && h2h.awayWins >= 3) {
        veto = true;
        vetoReason = `${H} is winless in last ${h2h.count} H2H meetings (${h2h.recordStr})`;
      } else if (away.played >= 6 && away.unbeatenRate >= 0.85 && sel.p < 0.72) {
        veto = true;
        vetoReason = `${A} is unbeaten in ${Math.round(away.unbeatenRate * 100)}% of last ${away.played} games`;
      }
      summary = `${H} Form ${home.form5} (${home.recordStr}, ${home.gfAvg} GF/g) vs ${A} ${away.form5} (${away.recordStr}, ${away.gaAvg} GA/g)${h2hShort}`;
    } else if (sk === 'away') {
      const aWinBase = away.venueWinRate != null ? away.winRate * 0.55 + away.venueWinRate * 0.45 : away.winRate;
      const hLoseBase = home.loseRate;
      let emp = aWinBase * 0.58 + hLoseBase * 0.42;
      if (h2h.count >= 3) emp = emp * 0.78 + h2h.awayWinRate * 0.22;
      if (mkt === '1up') emp = Math.min(0.95, emp + 0.10);
      if (mkt === '2up') emp = Math.min(0.94, emp + 0.04);
      if (mkt === 'dnb') emp = Math.min(0.95, emp + 0.08);
      empiricalP = emp;

      if (away.played >= 5 && away.winRate < 0.30) {
        veto = true;
        vetoReason = `${A} won only ${away.wins}/${away.played} recent games (${away.form5})`;
      } else if (h2h.count >= 4 && h2h.awayWins === 0 && h2h.homeWins >= 3) {
        veto = true;
        vetoReason = `${A} is winless in last ${h2h.count} H2H meetings`;
      } else if (home.venuePlayed >= 4 && home.venueUnbeatenRate >= 0.85 && sel.p < 0.74) {
        veto = true;
        vetoReason = `${H} unbeaten in ${Math.round(home.venueUnbeatenRate * 100)}% of recent home games`;
      }
      summary = `${A} Form ${away.form5} (${away.recordStr}, ${away.gfAvg} GF/g) @ ${H} ${home.form5} (${home.recordStr}, ${home.gaAvg} GA/g)${h2hShort}`;
    }
  }

  // 2. Double Chance (1X / X2 / 12)
  else if (mkt === 'dc') {
    if (sk === '1x') {
      let emp = (home.venueUnbeatenRate ?? home.unbeatenRate) * 0.60 + (1 - away.winRate) * 0.40;
      if (h2h.count >= 3) emp = emp * 0.80 + h2h.homeUnbeatenRate * 0.20;
      empiricalP = emp;
      if (home.played >= 5 && home.loseRate >= 0.60) {
        veto = true;
        vetoReason = `${H} lost ${home.losses}/${home.played} recent matches`;
      }
      summary = `${H} Unbeaten ${Math.round(home.unbeatenRate * 100)}% (${home.recordStr}) · ${A} Away Wins ${Math.round((away.venueWinRate ?? away.winRate) * 100)}%${h2hShort}`;
    } else if (sk === 'x2') {
      let emp = (away.venueUnbeatenRate ?? away.unbeatenRate) * 0.60 + (1 - home.winRate) * 0.40;
      if (h2h.count >= 3) emp = emp * 0.80 + h2h.awayUnbeatenRate * 0.20;
      empiricalP = emp;
      if (away.played >= 5 && away.loseRate >= 0.60) {
        veto = true;
        vetoReason = `${A} lost ${away.losses}/${away.played} recent matches`;
      }
      summary = `${A} Unbeaten ${Math.round(away.unbeatenRate * 100)}% (${away.recordStr}) · ${H} Wins ${Math.round(home.winRate * 100)}%${h2hShort}`;
    } else if (sk === '12') {
      const drawAvg = ((home.draws / home.played) + (away.draws / away.played)) / 2;
      empiricalP = 1 - drawAvg;
      if (drawAvg >= 0.45) {
        veto = true;
        vetoReason = `High historical draw rate (${Math.round(drawAvg * 100)}%)`;
      }
      summary = `Decisive-result rate ${Math.round((1 - drawAvg) * 100)}% (${H} ${home.recordStr} vs ${A} ${away.recordStr})${h2hShort}`;
    }
  }

  // 3. Soccer Goals Over / Under (ou0.5 .. ou4.5)
  else if (isSoccer && /^ou(\d+\.\d+)$/.test(mkt)) {
    const line = parseFloat(mkt.slice(2));
    const poisOver = histTotalGoals ? poissonOverProb(histTotalGoals, line) : sel.p;
    let rateOver = poisOver;
    if (line === 1.5 && home.over15Rate != null && away.over15Rate != null) {
      rateOver = (home.over15Rate + away.over15Rate) / 2;
      if (h2h.count >= 3 && h2h.over15Rate != null) rateOver = rateOver * 0.78 + h2h.over15Rate * 0.22;
      rateOver = rateOver * 0.65 + poisOver * 0.35;
    } else if (line === 2.5 && home.over25Rate != null && away.over25Rate != null) {
      rateOver = (home.over25Rate + away.over25Rate) / 2;
      if (h2h.count >= 3 && h2h.over25Rate != null) rateOver = rateOver * 0.78 + h2h.over25Rate * 0.22;
      rateOver = rateOver * 0.65 + poisOver * 0.35;
    } else if (line === 3.5 && home.under35Rate != null && away.under35Rate != null) {
      const rO35 = 1 - (home.under35Rate + away.under35Rate) / 2;
      rateOver = rO35 * 0.60 + poisOver * 0.40;
    }

    if (sk === 'over') {
      empiricalP = rateOver;
      if (line === 1.5 && ((home.over15Rate + away.over15Rate) / 2 < 0.58 || (h2h.count >= 4 && h2h.over15Rate < 0.45))) {
        veto = true;
        vetoReason = `Low historical O1.5 rate (${Math.round(((home.over15Rate + away.over15Rate) / 2) * 100)}%)`;
      } else if (line === 2.5 && (home.over25Rate + away.over25Rate) / 2 < 0.42) {
        veto = true;
        vetoReason = `Low historical O2.5 rate (${Math.round(((home.over25Rate + away.over25Rate) / 2) * 100)}%)`;
      }
      summary = `Avg Goals: ${H} ${home.totalGoalsAvg}/g (O1.5 ${Math.round(home.over15Rate * 100)}%) · ${A} ${away.totalGoalsAvg}/g (O1.5 ${Math.round(away.over15Rate * 100)}%)${h2h.count >= 2 ? ` · H2H Avg ${h2h.avgGoals}g` : ''}`;
    } else if (sk === 'under') {
      empiricalP = 1 - rateOver;
      if (line <= 2.5 && (home.over25Rate + away.over25Rate) / 2 >= 0.70) {
        veto = true;
        vetoReason = `High-scoring teams (O2.5 hit ${Math.round(((home.over25Rate + away.over25Rate) / 2) * 100)}%)`;
      } else if (line === 3.5 && (home.totalGoalsAvg + away.totalGoalsAvg) / 2 >= 3.55) {
        veto = true;
        vetoReason = `Recent matches average ${((home.totalGoalsAvg + away.totalGoalsAvg) / 2).toFixed(1)} goals`;
      }
      summary = `Avg Goals: ${H} ${home.totalGoalsAvg}/g (U3.5 ${Math.round(home.under35Rate * 100)}%) · ${A} ${away.totalGoalsAvg}/g (U3.5 ${Math.round(away.under35Rate * 100)}%)${h2h.count >= 2 ? ` · H2H Avg ${h2h.avgGoals}g` : ''}`;
    }
  }

  // 4. Team Over/Under Goals (homeou0.5, homeou1.5, awayou0.5, awayou1.5)
  else if (isSoccer && /^(home|away)ou(\d+\.\d+)$/.test(mkt)) {
    const isH = mkt.startsWith('home');
    const line = parseFloat(mkt.replace(/^(home|away)ou/, ''));
    const att = isH ? home : away;
    const def = isH ? away : home;
    const lam = isH ? histLambdaHome : histLambdaAway;
    const poisOver = lam ? poissonOverProb(lam, line) : sel.p;
    const empRate = line <= 0.5
      ? att.scored1plusRate * 0.55 + (1 - def.cleanSheetRate) * 0.45
      : att.scored2plusRate * 0.55 + poisOver * 0.45;

    if (sk === 'over') {
      empiricalP = empRate;
      if (line <= 0.5 && (att.failedToScoreRate >= 0.50 || def.cleanSheetRate >= 0.60)) {
        veto = true;
        vetoReason = `${isH ? H : A} failed to score in ${Math.round(att.failedToScoreRate * 100)}% of recent games`;
      } else if (line === 1.5 && att.scored2plusRate < 0.35) {
        veto = true;
        vetoReason = `${isH ? H : A} scored 2+ goals in only ${Math.round(att.scored2plusRate * 100)}% of recent games`;
      }
    } else {
      empiricalP = 1 - empRate;
    }
    summary = `${isH ? H : A} scores ${att.gfAvg} GF/g (1+ in ${Math.round(att.scored1plusRate * 100)}%) vs ${isH ? A : H} ${def.gaAvg} GA/g${h2hShort}`;
  }

  // 5. GG / NG (Both Teams To Score)
  else if (isSoccer && mkt === 'ggng') {
    let rGg = (home.bttsRate + away.bttsRate) / 2;
    if (h2h.count >= 3 && h2h.bttsRate != null) rGg = rGg * 0.75 + h2h.bttsRate * 0.25;
    if (sk === 'gg') {
      empiricalP = rGg;
      if (rGg < 0.42 || home.failedToScoreRate >= 0.55 || away.failedToScoreRate >= 0.55) {
        veto = true;
        vetoReason = `Historical BTTS rate only ${Math.round(rGg * 100)}%`;
      }
    } else {
      empiricalP = 1 - rGg;
      if (rGg >= 0.72) {
        veto = true;
        vetoReason = `High historical BTTS rate (${Math.round(rGg * 100)}%)`;
      }
    }
    summary = `BTTS History: ${H} ${Math.round(home.bttsRate * 100)}% · ${A} ${Math.round(away.bttsRate * 100)}%${h2h.count >= 2 ? ` · H2H BTTS ${Math.round(h2h.bttsRate * 100)}%` : ''}`;
  }

  // 6. 1st Half Goals (1h_ou0.5 / 1hou0.5)
  else if (isSoccer && (mkt === '1h_ou0.5' || mkt === '1hou0.5') && home.fhOver05Rate != null && away.fhOver05Rate != null) {
    const rFh = (home.fhOver05Rate + away.fhOver05Rate) / 2;
    empiricalP = sk === 'over' ? rFh : 1 - rFh;
    if (sk === 'over' && rFh < 0.55) {
      veto = true;
      vetoReason = `Low 1st-Half goal history (${Math.round(rFh * 100)}%)`;
    }
    summary = `1st-Half Goal Rate: ${H} ${Math.round(home.fhOver05Rate * 100)}% · ${A} ${Math.round(away.fhOver05Rate * 100)}%`;
  }

  // 6B. High-Accuracy Combo & "Or" Shield Markets (dc_ou1.5, home_or_o25, away_or_o25, ht_or_ft, 1x2_ou1.5)
  else if (isSoccer && (mkt.startsWith('dc_ou') || mkt === 'home_or_o25' || mkt === 'away_or_o25' || mkt === 'home_or_gg' || mkt === 'away_or_gg' || mkt === 'ht_or_ft')) {
    const o15Avg = ((home.over15Rate ?? 0.72) + (away.over15Rate ?? 0.72)) / 2;
    const o25Avg = ((home.over25Rate ?? 0.50) + (away.over25Rate ?? 0.50)) / 2;
    if (mkt === 'dc_ou1.5' && (sk === '1x_over' || sk === 'x2_over')) {
      const dcEmp = sk === '1x_over'
        ? (home.venueUnbeatenRate ?? home.unbeatenRate) * 0.6 + (1 - away.winRate) * 0.4
        : (away.venueUnbeatenRate ?? away.unbeatenRate) * 0.6 + (1 - home.winRate) * 0.4;
      empiricalP = Math.min(0.94, dcEmp * o15Avg * 1.06);
      if (o15Avg < 0.56 || dcEmp < 0.55) {
        veto = true;
        vetoReason = `Historical DC/O1.5 rate too weak (${Math.round(dcEmp * 100)}% DC · ${Math.round(o15Avg * 100)}% O1.5)`;
      }
    } else if (mkt === 'home_or_o25' || mkt === 'away_or_o25') {
      const isH = mkt === 'home_or_o25';
      const wEmp = isH ? home.winRate : away.winRate;
      empiricalP = Math.min(0.95, 1 - (1 - wEmp) * (1 - o25Avg));
      if (wEmp < 0.25 && o25Avg < 0.42) {
        veto = true;
        vetoReason = `Both win rate (${Math.round(wEmp * 100)}%) and O2.5 rate (${Math.round(o25Avg * 100)}%) are low`;
      }
    } else if (mkt === 'ht_or_ft' && (sk === 'home' || sk === 'away')) {
      const isH = sk === 'home';
      const mySide = isH ? home : away;
      const oppSide = isH ? away : home;
      if (mySide.played >= 5 && mySide.winRate < 0.28) {
        veto = true;
        vetoReason = `${isH ? H : A} won only ${mySide.wins}/${mySide.played} recent matches`;
      }
      empiricalP = Math.min(0.94, mySide.winRate * 0.62 + oppSide.loseRate * 0.38 + 0.11);
    }
    summary = `Combo Shield Check: ${H} ${home.form5} (${home.recordStr}, O1.5 ${Math.round((home.over15Rate ?? 0) * 100)}%) vs ${A} ${away.form5} (${away.recordStr}, O1.5 ${Math.round((away.over15Rate ?? 0) * 100)}%)${h2hShort}`;
  }

  // 7. Tactical Props (Corners, Shots, SOT, Cards, Throw-Ins, Goal Kicks, Player Props) — attach attacking/tempo history context
  else if (isSoccer) {
    summary = `History Tempo: ${H} ${home.form5} (${home.gfAvg} GF / ${home.gaAvg} GA) vs ${A} ${away.form5} (${away.gfAvg} GF / ${away.gaAvg} GA)${h2hShort}`;
    // Sanity check for team corners / team SOT overs: don't back a dead-attack team for Over corners/shots!
    if (/home/.test(mkt) && sk === 'over' && home.gfAvg < 0.75 && home.winRate < 0.25) {
      veto = true;
      vetoReason = `${H} weak recent attacking output (${home.gfAvg} GF/g)`;
    } else if (/away/.test(mkt) && sk === 'over' && away.gfAvg < 0.70 && away.winRate < 0.25) {
      veto = true;
      vetoReason = `${A} weak recent attacking output (${away.gfAvg} GF/g)`;
    }
  } else {
    summary = `Form: ${H} ${home.form5} (${home.recordStr}) vs ${A} ${away.form5} (${away.recordStr})${h2hShort}`;
  }

  // Blend empirical history with de-vigged model probability
  let adjustedP = sel.p;
  let historyBoost = 0;
  if (empiricalP != null && Number.isFinite(empiricalP)) {
    const clampedEmp = Math.max(0.08, Math.min(0.95, empiricalP));
    adjustedP = +(sel.p * 0.72 + clampedEmp * 0.28).toFixed(4);
    // Reward strong agreement between market/model AND real match history
    if (clampedEmp >= sel.p - 0.04 && clampedEmp >= 0.62) {
      historyBoost = 0.03;
    } else if (clampedEmp < sel.p - 0.16) {
      historyBoost = -0.05;
    }
  }

  return {
    veto,
    vetoReason,
    historyVerified: true,
    empiricalP: empiricalP != null ? +empiricalP.toFixed(3) : null,
    adjustedP,
    historyBoost,
    historyBadge: `📜 Form ${home.form5} vs ${away.form5}${h2h.count ? ` · H2H ${h2h.recordStr}` : ''}`,
    historySummary: summary,
  };
}
