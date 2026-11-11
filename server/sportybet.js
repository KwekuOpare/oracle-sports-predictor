// Live SportyBet Ghana API Integration Engine.
// Connects directly to https://www.sportybet.com/api/gh/ to:
// 1. Fetch real upcoming fixtures, live odds, BetRadar probabilities, and market/outcome IDs
//    across Football (Soccer), Basketball, Tennis, Ice Hockey, American Football, and Baseball.
// 2. Map predictions (1X2, 1UP, 2UP, Over/Under, GG/NG, Double Chance, Draw No Bet, Handicap,
//    Correct Score, Multiscores, HT/FT, Corners, Bookings/Cards, Shots, SOT, Offsides, Fouls,
//    Throw-Ins, Clean Sheet, Win to Nil, Odd/Even) to exact SportyBet Ghana selections.
// 3. Call POST /api/gh/orders/share to generate REAL 6-character SportyBet Ghana Booking Codes
//    (e.g. "9YG45J") and direct share URLs (https://www.sportybet.com/gh/?shareCode=9YG45J).
// 4. Load & decode any existing SportyBet Ghana Booking Code via GET /api/gh/orders/share/:code.

const SPORTY_BASE = 'https://www.sportybet.com/api/gh';

const SPORTY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'ClientId': 'web',
  'Platform': 'web',
  'OperId': '2',
  'Origin': 'https://www.sportybet.com',
  'Referer': 'https://www.sportybet.com/gh/',
};

// All key football market IDs supported by SportyBet Ghana in bulk queries:
// 1=1X2, 60200=1UP, 60100=2UP, 18=O/U, 10=DC, 29=GG/NG, 11=DNB, 14=Handicap,
// 19=Home O/U, 20=Away O/U, 26=Odd/Even, 31=Home CS, 32=Away CS, 33=Home WTN, 34=Away WTN,
// 45=Correct Score, 47=HT/FT, 548=Multigoals, 551=Multiscores,
// 166=Corners O/U, 162=Corners 1X2, 139=Bookings O/U, 136=Bookings 1X2,
// 900394=Shots O/U, 900393=SOT O/U, 900396=Offsides O/U, 900342=Fouls O/U, 900769=Throw-Ins O/U
const SOCCER_BULK_MARKETS = [
  '1', '60200', '60100', '18', '10', '29', '11', '14',
  '19', '20', '26', '31', '32', '33', '34',
  '45', '47', '548', '551', '900984',
  '166', '162', '177', '900300', '900301',
  '139', '136', '900304', '900305',
  '900394', '900320', '900552', '900553',
  '900393', '900318', '900546', '900547',
  '900396', '900568', '900569',
  '900342', '900539', '900544', '900545',
  '900769', '900770',
].join(',');

const OTHER_SPORTS_CONFIG = [
  { sportId: 'sr:sport:2', sport: 'basketball', label: 'Basketball', markets: '219,18,223' },
  { sportId: 'sr:sport:5', sport: 'tennis', label: 'Tennis', markets: '186,189' },
  { sportId: 'sr:sport:4', sport: 'hockey', label: 'Ice Hockey', markets: '1,18,10' },
  { sportId: 'sr:sport:16', sport: 'football', label: 'American Football', markets: '219,18,223,1' },
  { sportId: 'sr:sport:3', sport: 'baseball', label: 'Baseball', markets: '251,258' },
];

// In-memory caches
const catalogCache = { ts: 0, events: [], byId: new Map() };
const eventDetailCache = new Map(); // eventId -> { ts, data }
const shareCodeCache = new Map(); // fingerprint -> { ts, shareCode, shareURL, outcomes }

const CATALOG_TTL = 10 * 60 * 1000; // 10 minutes
const DETAIL_TTL = 15 * 60 * 1000;

/** Normalize team names for fuzzy matching between ESPN and SportyBet. */
export function normTeam(name = '') {
  return String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|sc|ac|afc|ssc|rc|ud|cd|fk|sk|bk|if|ik|sv|vfb|vfl|tsg|rb|bsc|1\.|sporting|real|club|deportivo|atletico|athletic|united|utd|city|town|rovers|wanderers|albion|hotspur|county|forest|palace|villa|ham|saint|st)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function teamMatchScore(a, b) {
  if (!a || !b) return 0;
  const al = String(a).toLowerCase().trim();
  const bl = String(b).toLowerCase().trim();
  if (al === bl) return 1;
  // Common aliases
  const aliasMap = {
    'man utd': 'manchester united',
    'man united': 'manchester united',
    'man city': 'manchester city',
    'spurs': 'tottenham hotspur',
    'tottenham': 'tottenham hotspur',
    'wolves': 'wolverhampton wanderers',
    'nottm forest': 'nottingham forest',
    'newcastle': 'newcastle united',
    'west ham': 'west ham united',
    'leeds': 'leeds united',
    'brighton': 'brighton and hove albion',
    'inter': 'internazionale',
    'inter milan': 'internazionale',
    'psg': 'paris saint germain',
    'paris sg': 'paris saint germain',
    'atletico madrid': 'atletico de madrid',
    'athletic bilbao': 'athletic club',
    'bayern': 'bayern munich',
    'bayern munchen': 'bayern munich',
    'dortmund': 'borussia dortmund',
    'gladbach': 'borussia monchengladbach',
    'leverkusen': 'bayer leverkusen',
    'bodoe/glimt': 'bodo glimt',
  };
  const ca = aliasMap[al] || al;
  const cb = aliasMap[bl] || bl;
  if (ca === cb) return 0.98;
  if (ca.includes(cb) || cb.includes(ca)) return 0.9;

  const na = normTeam(ca);
  const nb = normTeam(cb);
  if (na && nb && (na === nb || na.includes(nb) || nb.includes(na))) return 0.85;

  const toksA = new Set(na.split(' ').filter((w) => w.length >= 3));
  const toksB = new Set(nb.split(' ').filter((w) => w.length >= 3));
  if (!toksA.size || !toksB.size) return 0;
  let overlap = 0;
  for (const t of toksA) if (toksB.has(t)) overlap++;
  return overlap / Math.max(toksA.size, toksB.size);
}

/** Fetch a page of upcoming events from SportyBet Ghana. */
async function fetchUpcomingPage(sportId = 'sr:sport:1', marketIds = SOCCER_BULK_MARKETS, pageNum = 1, pageSize = 100) {
  const url = `${SPORTY_BASE}/factsCenter/pcUpcomingEvents?sportId=${encodeURIComponent(sportId)}&marketId=${encodeURIComponent(marketIds)}&pageSize=${pageSize}&pageNum=${pageNum}&_t=${Date.now()}`;
  const res = await fetch(url, { headers: SPORTY_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`SportyBet HTTP ${res.status}`);
  const json = await res.json();
  if (json.bizCode !== 10000 || !json.data?.tournaments) return [];

  const minStart = Date.now() + 5 * 60 * 1000;
  const out = [];
  for (const t of json.data.tournaments) {
    for (const ev of t.events || []) {
      if (ev.banned || ev.ai) continue;
      if (Number(ev.estimateStartTime) <= minStart) continue;
      out.push({
        eventId: ev.eventId,
        gameId: ev.gameId,
        homeTeamId: ev.homeTeamId,
        awayTeamId: ev.awayTeamId,
        homeTeamName: ev.homeTeamName,
        awayTeamName: ev.awayTeamName,
        homeTeamIcon: ev.homeTeamIcon,
        awayTeamIcon: ev.awayTeamIcon,
        estimateStartTime: ev.estimateStartTime,
        date: new Date(ev.estimateStartTime).toISOString(),
        sportId,
        categoryName: t.categoryName || '',
        tournamentId: t.id,
        tournamentName: t.name || '',
        leagueLabel: `${t.categoryName ? t.categoryName + ' · ' : ''}${t.name || ''}`,
        markets: ev.markets || [],
      });
    }
  }
  return out;
}

/** Get cached or fresh catalog of upcoming SportyBet Ghana events across soccer & major sports. */
export async function getSportyCatalog(force = false) {
  const minBookableStart = Date.now() + 5 * 60 * 1000;
  if (!force && catalogCache.events.length && Date.now() - catalogCache.ts < CATALOG_TTL) {
    return catalogCache.events.filter((ev) => ev.estimateStartTime > minBookableStart);
  }

  try {
    // Fetch 5 pages of football (up to 500 matches for 50–60 fold Million-Odds multis!) + 1 page each of other sports
    const [soccerP1, soccerP2, soccerP3, soccerP4, soccerP5, ...otherPages] = await Promise.all([
      fetchUpcomingPage('sr:sport:1', SOCCER_BULK_MARKETS, 1, 100).catch(() => []),
      fetchUpcomingPage('sr:sport:1', SOCCER_BULK_MARKETS, 2, 100).catch(() => []),
      fetchUpcomingPage('sr:sport:1', SOCCER_BULK_MARKETS, 3, 100).catch(() => []),
      fetchUpcomingPage('sr:sport:1', SOCCER_BULK_MARKETS, 4, 100).catch(() => []),
      fetchUpcomingPage('sr:sport:1', SOCCER_BULK_MARKETS, 5, 100).catch(() => []),
      ...OTHER_SPORTS_CONFIG.map((cfg) =>
        fetchUpcomingPage(cfg.sportId, cfg.markets, 1, 45)
          .then((list) => list.map((ev) => ({ ...ev, sportType: cfg.sport })))
          .catch(() => [])
      ),
    ]);

    const byId = new Map();
    for (const ev of [...soccerP1, ...soccerP2, ...soccerP3, ...soccerP4, ...soccerP5]) {
      ev.sportType = 'soccer';
      byId.set(ev.eventId, ev);
    }
    for (const page of otherPages) {
      for (const ev of page) {
        if (!byId.has(ev.eventId)) byId.set(ev.eventId, ev);
      }
    }

    // Deep-enrich top 16 marquee soccer matches with full 350+ market details (Shots 1X2, SOT, Team Shots, Throw-Ins, Goal Kicks, Cards, Corners)
    const marquee = [...byId.values()]
      .filter((ev) => ev.sportType === 'soccer' && (ev.markets?.length || 0) >= 6)
      .slice(0, 16);
    await Promise.all(marquee.map(async (ev) => {
      const det = await getSportyEventDetail(ev.eventId);
      if (det?.markets?.length) {
        const existingKeys = new Set((ev.markets || []).map((m) => `${m.id}|${m.specifier || ''}`));
        for (const dm of det.markets) {
          const k = `${dm.id}|${dm.specifier || ''}`;
          if (!existingKeys.has(k)) {
            ev.markets.push(dm);
            existingKeys.add(k);
          }
        }
      }
    }));

    const events = [...byId.values()]
      .filter((ev) => ev.estimateStartTime > minBookableStart)
      .sort((a, b) => a.estimateStartTime - b.estimateStartTime);
    if (events.length) {
      catalogCache.events = events;
      catalogCache.byId = byId;
      catalogCache.ts = Date.now();
    }
    return catalogCache.events.filter((ev) => ev.estimateStartTime > minBookableStart);
  } catch (err) {
    console.error('[sportybet] catalog fetch error:', err.message);
    return catalogCache.events.filter((ev) => ev.estimateStartTime > minBookableStart);
  }
}

/** Fetch full 350+ market details for a single SportyBet eventId. */
export async function getSportyEventDetail(eventId) {
  if (!eventId) return null;
  const cached = eventDetailCache.get(eventId);
  if (cached && Date.now() - cached.ts < DETAIL_TTL) return cached.data;

  try {
    const url = `${SPORTY_BASE}/factsCenter/event?eventId=${encodeURIComponent(eventId)}&_t=${Date.now()}`;
    const res = await fetch(url, { headers: SPORTY_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.bizCode !== 10000 || !json.data) return null;
    eventDetailCache.set(eventId, { ts: Date.now(), data: json.data });
    return json.data;
  } catch {
    return null;
  }
}

/** Find the matching SportyBet Ghana event for an ESPN game object. */
export async function findSportyEventForGame(game) {
  const catalog = await getSportyCatalog();
  if (!catalog.length || !game?.home?.name || !game?.away?.name) return null;

  const gTime = new Date(game.date).getTime();
  let best = null;
  let bestScore = 0;

  for (const ev of catalog) {
    // Must be within 36 hours of kickoff
    if (Number.isFinite(gTime) && Math.abs(ev.estimateStartTime - gTime) > 36 * 3600 * 1000) continue;
    const hScore = teamMatchScore(game.home.name, ev.homeTeamName);
    const aScore = teamMatchScore(game.away.name, ev.awayTeamName);
    if (hScore >= 0.65 && aScore >= 0.65) {
      const total = hScore + aScore;
      if (total > bestScore) {
        bestScore = total;
        best = ev;
      }
    }
  }
  return best;
}

/**
 * Extract rich bookable selections from a SportyBet event.
 * Combines BetRadar's internal true probability (`outcome.probability`) with optional model probabilities
 * and attaches the exact `{ eventId, marketId, outcomeId, specifier }` payload required to generate a
 * real SportyBet Ghana booking code!
 */
function buildCrossMarketFairMap(markets, sportType = 'soccer') {
  const map = new Map();
  if (sportType !== 'soccer' || !Array.isArray(markets)) return map;

  const m1x2 = markets.find((x) => String(x.id) === '1');
  const mOu25 = markets.find((x) => String(x.id) === '18' && /total=2\.5(?:\b|$)/.test(x.specifier || ''));
  const mOu15 = markets.find((x) => String(x.id) === '18' && /total=1\.5(?:\b|$)/.test(x.specifier || ''));
  if (!mOu25 && !mOu15) return map;

  let pH = null, pD = null, pA = null;
  if (m1x2?.outcomes?.length) {
    const act = m1x2.outcomes.filter((o) => o.isActive === 1 && Number(o.odds) > 1.01);
    const inv = act.reduce((s, o) => s + 1 / Number(o.odds), 0);
    if (inv > 0.90) {
      for (const o of act) {
        const dp = (1 / Number(o.odds)) / inv;
        if (o.id === '1') pH = dp;
        else if (o.id === '2') pD = dp;
        else if (o.id === '3') pA = dp;
      }
    }
  }
  if (pH == null || pA == null) return map;

  // Infer total goal expectancy lamTotal from sharp O/U 2.5 (or O/U 1.5 fallback)
  let lamTotal = 2.62;
  if (mOu25?.outcomes?.length) {
    const act = mOu25.outcomes.filter((o) => o.isActive === 1 && Number(o.odds) > 1.01);
    const inv = act.reduce((s, o) => s + 1 / Number(o.odds), 0);
    const overOut = act.find((o) => o.id === '12' || /^over/i.test(o.desc));
    if (inv > 0.90 && overOut) {
      const targetOver25 = (1 / Number(overOut.odds)) / inv;
      let lo = 1.15, hi = 5.20;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        const p3Plus = 1 - Math.exp(-mid) * (1 + mid + (mid * mid) / 2);
        if (p3Plus < targetOver25) lo = mid; else hi = mid;
      }
      lamTotal = (lo + hi) / 2;
    }
  } else if (mOu15?.outcomes?.length) {
    const act = mOu15.outcomes.filter((o) => o.isActive === 1 && Number(o.odds) > 1.01);
    const inv = act.reduce((s, o) => s + 1 / Number(o.odds), 0);
    const overOut = act.find((o) => o.id === '12' || /^over/i.test(o.desc));
    if (inv > 0.90 && overOut) {
      const targetOver15 = (1 / Number(overOut.odds)) / inv;
      let lo = 1.15, hi = 5.20;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        const p2Plus = 1 - Math.exp(-mid) * (1 + mid);
        if (p2Plus < targetOver15) lo = mid; else hi = mid;
      }
      lamTotal = (lo + hi) / 2;
    }
  }

  // Split lamTotal between Home and Away to match 1X2 win ratio
  const winRatioH = pH / Math.max(0.05, pH + pA);
  let shareLo = 0.08, shareHi = 0.92;
  const poisPmf = (lam, maxG = 9) => {
    const arr = new Float64Array(maxG + 1);
    arr[0] = Math.exp(-lam);
    for (let k = 1; k <= maxG; k++) arr[k] = (arr[k - 1] * lam) / k;
    return arr;
  };
  for (let iter = 0; iter < 10; iter++) {
    const sh = (shareLo + shareHi) / 2;
    const ph = poisPmf(lamTotal * sh, 8);
    const pa = poisPmf(lamTotal * (1 - sh), 8);
    let wH = 0, wA = 0;
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const pr = ph[i] * pa[j];
        if (i > j) wH += pr; else if (j > i) wA += pr;
      }
    }
    const r = wH / Math.max(1e-6, wH + wA);
    if (r < winRatioH) shareLo = sh; else shareHi = sh;
  }

  const shareH = (shareLo + shareHi) / 2;
  const lamH = Math.max(0.2, lamTotal * shareH);
  const lamA = Math.max(0.2, lamTotal * (1 - shareH));
  const ph = poisPmf(lamH, 9);
  const pa = poisPmf(lamA, 9);
  const rho = -0.085; // Dixon-Coles low-score correlation

  const grid = [];
  let sumG = 0;
  for (let i = 0; i <= 9; i++) {
    grid[i] = new Float64Array(10);
    for (let j = 0; j <= 9; j++) {
      let tau = 1;
      if (i === 0 && j === 0) tau = 1 - lamH * lamA * rho;
      else if (i === 0 && j === 1) tau = 1 + lamH * rho;
      else if (i === 1 && j === 0) tau = 1 + lamA * rho;
      else if (i === 1 && j === 1) tau = 1 - rho;
      const v = Math.max(0, ph[i] * pa[j] * tau);
      grid[i][j] = v;
      sumG += v;
    }
  }
  if (sumG <= 0) return map;

  let cH = 0, cD = 0, cA = 0, gg = 0;
  const totOver = { '0.5': 0, '1.5': 0, '2.5': 0, '3.5': 0, '4.5': 0 };
  const hOver = { '0.5': 0, '1.5': 0, '2.5': 0 };
  const aOver = { '0.5': 0, '1.5': 0, '2.5': 0 };

  for (let i = 0; i <= 9; i++) {
    for (let j = 0; j <= 9; j++) {
      const p = grid[i][j] / sumG;
      if (i > j) cH += p; else if (i === j) cD += p; else cA += p;
      if (i >= 1 && j >= 1) gg += p;
      const tot = i + j;
      if (tot >= 1) totOver['0.5'] += p;
      if (tot >= 2) totOver['1.5'] += p;
      if (tot >= 3) totOver['2.5'] += p;
      if (tot >= 4) totOver['3.5'] += p;
      if (tot >= 5) totOver['4.5'] += p;
      if (i >= 1) hOver['0.5'] += p;
      if (i >= 2) hOver['1.5'] += p;
      if (i >= 3) hOver['2.5'] += p;
      if (j >= 1) aOver['0.5'] += p;
      if (j >= 2) aOver['1.5'] += p;
      if (j >= 3) aOver['2.5'] += p;
    }
  }

  const early1UpBoost = Math.min(0.11, 0.28 * cD + 0.042);
  map.set('1up:home', Math.min(0.95, cH + early1UpBoost));
  map.set('1up:away', Math.min(0.95, cA + early1UpBoost));
  map.set('dc:1x', Math.min(0.97, cH + cD));
  map.set('dc:12', Math.min(0.97, cH + cA));
  map.set('dc:x2', Math.min(0.97, cD + cA));
  map.set('dnb:home', cH / Math.max(0.05, cH + cA));
  map.set('dnb:away', cA / Math.max(0.05, cH + cA));
  map.set('ggng:gg', gg);
  map.set('ggng:ng', 1 - gg);
  for (const [ln, pv] of Object.entries(totOver)) {
    map.set(`ou${ln}:over`, pv);
    map.set(`ou${ln}:under`, 1 - pv);
  }
  for (const [ln, pv] of Object.entries(hOver)) {
    map.set(`homeou${ln}:over`, pv);
    map.set(`homeou${ln}:under`, 1 - pv);
  }
  for (const [ln, pv] of Object.entries(aOver)) {
    map.set(`awayou${ln}:over`, pv);
    map.set(`awayou${ln}:under`, 1 - pv);
  }
  return map;
}

export function extractBookableSelections(ev, modelPred = null) {
  if (!ev?.markets?.length) return [];
  const selections = [];
  const matchTitle = `${ev.awayTeamName} @ ${ev.homeTeamName}`;
  const sportyMatchup = `${ev.homeTeamName} vs ${ev.awayTeamName}`;

  // Build quick lookup from ESPN statistical model (when matched) + Dixon-Coles cross-market fair grid
  const modelMap = new Map();
  if (modelPred?.markets) {
    for (const m of modelPred.markets) {
      for (const s of m.selections || []) {
        modelMap.set(`${m.key}:${s.key}`, s.p);
      }
    }
  }
  const crossMap = buildCrossMarketFairMap(ev.markets, ev.sportType || 'soccer');

  let curInvSum = 0; // tracks current market overround sum(1/odds)

  const pushSel = ({
    group,
    marketKey,
    marketName,
    sportyMarket,
    selKey,
    label,
    sportyPick,
    marketId,
    outcomeId,
    specifier = '',
    odds,
    brProb,
    modelP = null,
  }) => {
    const numOdds = Number(odds);
    if (!Number.isFinite(numOdds) || numOdds <= 1.01) return;

    // Proportional de-vigged fair market probability from SportyBet's full market outcome book
    const devigP = curInvSum > 0.90 && curInvSum < 1.45
      ? +((1 / numOdds) / curInvSum).toFixed(4)
      : +(0.945 / numOdds).toFixed(4);
    const marginPct = curInvSum > 0.90 ? +((curInvSum - 1) * 100).toFixed(1) : 5.5;

    const rawBr = Number(brProb);
    const validBr = Number.isFinite(rawBr) && rawBr > 0.001 && rawBr < 0.999 ? rawBr : devigP;
    const crossP = crossMap.get(`${marketKey}:${selKey}`) ?? null;
    const effModelP = modelP != null && Number.isFinite(modelP) ? modelP : crossP;

    // Tri-source ensemble blend: Statistical/Cross-Market Model + BetRadar True Prob + De-Vigged Market Consensus
    const p = effModelP != null && Number.isFinite(effModelP)
      ? +(0.72 * effModelP + 0.16 * validBr + 0.12 * devigP).toFixed(4)
      : +(0.76 * validBr + 0.24 * devigP).toFixed(4);

    const fair = +(1 / Math.max(p, 1e-4)).toFixed(2);
    const edge = +((p * numOdds - 1) * 100).toFixed(1);
    const steamPct = +(((1 / numOdds) - validBr) * 100).toFixed(1);

    // Quarter-Kelly recommended bankroll stake % (capped 0.5% - 6.0%)
    const b = numOdds - 1;
    const fullKelly = b > 0 ? (p * numOdds - 1) / b : 0;
    const kellyPct = fullKelly > 0 ? +Math.min(6.0, Math.max(0.5, fullKelly * 25)).toFixed(2) : 0;

    // Composite Vhim Smart Score: probability + low bookmaker margin + positive EV / steam + model consensus
    const lowJuiceBonus = Math.max(-0.02, Math.min(0.025, (6.5 - marginPct) * 0.004));
    const evBonus = Math.max(-0.025, Math.min(0.045, edge * 0.0035));
    const agreementBonus = modelP != null && Math.abs(modelP - validBr) <= 0.06 ? 0.025 : 0;
    const vhimScore = +(p + lowJuiceBonus + evBonus + agreementBonus).toFixed(4);

    selections.push({
      id: `${ev.eventId}:${marketId}:${specifier}:${outcomeId}`,
      gameId: ev.eventId,
      sportyGameId: ev.gameId,
      eventId: ev.eventId,
      startTime: ev.estimateStartTime,
      date: ev.date,
      matchup: sportyMatchup,
      espnMatchup: matchTitle,
      home: ev.homeTeamName,
      away: ev.awayTeamName,
      homeTeamId: ev.homeTeamId || null,
      awayTeamId: ev.awayTeamId || null,
      homeLogo: ev.homeTeamIcon,
      awayLogo: ev.awayTeamIcon,
      league: ev.tournamentId || 'sporty',
      leagueName: ev.leagueLabel || ev.tournamentName || 'Football',
      sport: ev.sportType || 'soccer',
      group,
      marketKey,
      market: marketName,
      sportyMarket,
      selKey,
      label,
      sportyPick,
      p,
      devigP,
      brProb: validBr,
      modelP: modelP ?? validBr,
      marginPct,
      steamPct,
      kellyPct,
      vhimScore,
      fairOdds: fair,
      sportyOdds: +numOdds.toFixed(2),
      userOdds: +numOdds.toFixed(2),
      edgePct: edge,
      sportySelection: {
        eventId: ev.eventId,
        marketId: String(marketId),
        outcomeId: String(outcomeId),
        specifier: specifier || '',
      },
    });
  };

  // Pre-extract de-vigged 1X2 probabilities so 1UP/2UP can quantify structural early-payout edge
  const base1x2 = { home: null, draw: null, away: null };
  const m1x2 = ev.markets.find((x) => String(x.id) === '1');
  if (m1x2?.outcomes?.length) {
    const act = m1x2.outcomes.filter((o) => o.isActive === 1 && Number(o.odds) > 1.01);
    const inv = act.reduce((s, o) => s + 1 / Number(o.odds), 0);
    if (inv > 0.90) {
      for (const o of act) {
        const k = o.id === '1' ? 'home' : o.id === '2' ? 'draw' : 'away';
        base1x2[k] = (1 / Number(o.odds)) / inv;
      }
    }
  }

  for (const m of ev.markets) {
    const mid = String(m.id);
    const spec = m.specifier || '';
    const outs = (m.outcomes || []).filter((o) => o.isActive === 1 && Number(o.odds) > 1.01);
    if (!outs.length) continue;
    curInvSum = outs.reduce((acc, o) => acc + (1 / Number(o.odds)), 0);

    // 1. 1X2 (Market 1)
    if (mid === '1') {
      for (const o of outs) {
        const key = o.id === '1' ? 'home' : o.id === '2' ? 'draw' : 'away';
        const lbl = o.id === '1' ? `${ev.homeTeamName} (1)` : o.id === '2' ? 'Draw (X)' : `${ev.awayTeamName} (2)`;
        const spPick = o.id === '1' ? 'Home (1)' : o.id === '2' ? 'Draw (X)' : 'Away (2)';
        pushSel({
          group: 'Main',
          marketKey: '1x2',
          marketName: 'Match Result (1X2)',
          sportyMarket: '1X2',
          selKey: key,
          label: lbl,
          sportyPick: spPick,
          marketId: '1',
          outcomeId: o.id,
          specifier: '',
          odds: o.odds,
          brProb: o.probability,
          modelP: modelMap.get(`1x2:${key}`),
        });
      }
    }
    // 2. 1X2 - 1UP / 2UP (Early Payout Markets 60200 & 60100)
    else if (mid === '60200' || mid === '60100') {
      const tag = mid === '60200' ? '1UP' : '2UP';
      for (const o of outs) {
        if (o.id === '2') continue; // 1UP/2UP is best on Home (1) or Away (3)
        const key = o.id === '1' ? 'home' : 'away';
        const team = o.id === '1' ? ev.homeTeamName : ev.awayTeamName;
        const baseWinP = base1x2[key];
        const drawP = base1x2.draw ?? 0.25;
        // Historical early-payout conversion boost: ~26% of FT draws + ~3.8% of FT losses saw this side lead by +1 goal first
        const earlyBoost = mid === '60200'
          ? Math.min(0.105, 0.26 * drawP + 0.038)
          : Math.min(0.032, 0.07 * drawP + 0.010);
        const trueEarlyP = baseWinP != null ? Math.min(0.95, baseWinP + earlyBoost) : Number(o.probability);
        const mod1x2 = modelMap.get(`1x2:${key}`);
        pushSel({
          group: 'Main',
          marketKey: tag.toLowerCase(),
          marketName: `1X2 - ${tag} Early Payout`,
          sportyMarket: `1X2 - ${tag}`,
          selKey: key,
          label: `${team} (${tag})`,
          sportyPick: `${o.desc} (${tag})`,
          marketId: mid,
          outcomeId: o.id,
          specifier: '',
          odds: o.odds,
          brProb: Math.max(Number(o.probability) || 0, trueEarlyP || 0),
          modelP: mod1x2 != null ? Math.min(0.95, mod1x2 + earlyBoost) : null,
        });
      }
    }
    // 3. Double Chance (Market 10)
    else if (mid === '10') {
      for (const o of outs) {
        const key = o.id === '9' ? '1x' : o.id === '10' ? '12' : 'x2';
        const code = o.id === '9' ? '1X (Home or Draw)' : o.id === '10' ? '12 (Home or Away)' : 'X2 (Draw or Away)';
        pushSel({
          group: 'Main',
          marketKey: 'dc',
          marketName: 'Double Chance',
          sportyMarket: 'Double Chance',
          selKey: key,
          label: code,
          sportyPick: o.desc || code,
          marketId: '10',
          outcomeId: o.id,
          specifier: '',
          odds: o.odds,
          brProb: o.probability,
          modelP: modelMap.get(`dc:${key}`),
        });
      }
    }
    // 4. Draw No Bet (Market 11)
    else if (mid === '11') {
      for (const o of outs) {
        const key = o.id === '4' ? 'home' : 'away';
        const team = o.id === '4' ? ev.homeTeamName : ev.awayTeamName;
        pushSel({
          group: 'Main',
          marketKey: 'dnb',
          marketName: 'Draw No Bet',
          sportyMarket: 'Draw No Bet',
          selKey: key,
          label: `${team} DNB`,
          sportyPick: `DNB ${o.desc}`,
          marketId: '11',
          outcomeId: o.id,
          specifier: '',
          odds: o.odds,
          brProb: o.probability,
          modelP: modelMap.get(`dnb:${key}`),
        });
      }
    }
    // 5. Over/Under Goals (Market 18)
    else if (mid === '18') {
      const mLine = spec.match(/total=([0-9.]+)/);
      const line = mLine ? mLine[1] : '';
      if (['0.5', '1.5', '2.5', '3.5', '4.5'].includes(line)) {
        for (const o of outs) {
          const isOver = o.id === '12' || /^over/i.test(o.desc);
          const key = isOver ? 'over' : 'under';
          pushSel({
            group: 'Goals',
            marketKey: `ou${line}`,
            marketName: `Total Goals ${line}`,
            sportyMarket: `Over/Under (${line})`,
            selKey: key,
            label: `${isOver ? 'Over' : 'Under'} ${line} Goals`,
            sportyPick: `${isOver ? 'Over' : 'Under'} ${line}`,
            marketId: '18',
            outcomeId: o.id,
            specifier: spec,
            odds: o.odds,
            brProb: o.probability,
            modelP: modelMap.get(`ou${line}:${key}`),
          });
        }
      }
    }
    // 6. GG / NG - Both Teams To Score (Market 29)
    else if (mid === '29') {
      for (const o of outs) {
        const isGG = o.id === '74' || /yes/i.test(o.desc);
        const key = isGG ? 'gg' : 'ng';
        pushSel({
          group: 'Goals',
          marketKey: 'ggng',
          marketName: 'Both Teams To Score (GG/NG)',
          sportyMarket: 'GG/NG',
          selKey: key,
          label: isGG ? 'GG (Both Score - Yes)' : 'NG (Both Score - No)',
          sportyPick: isGG ? 'GG (Yes)' : 'NG (No)',
          marketId: '29',
          outcomeId: o.id,
          specifier: '',
          odds: o.odds,
          brProb: o.probability,
          modelP: modelMap.get(`ggng:${key}`),
        });
      }
    }
    // 7. Team Over/Under (Markets 19 & 20)
    else if (mid === '19' || mid === '20') {
      const side = mid === '19' ? 'home' : 'away';
      const team = mid === '19' ? ev.homeTeamName : ev.awayTeamName;
      const mLine = spec.match(/total=([0-9.]+)/);
      const line = mLine ? mLine[1] : '';
      if (['0.5', '1.5', '2.5'].includes(line)) {
        for (const o of outs) {
          const isOver = o.id === '12' || /^over/i.test(o.desc);
          const key = isOver ? 'over' : 'under';
          pushSel({
            group: 'Goals',
            marketKey: `${side}ou${line}`,
            marketName: `${team} O/U ${line}`,
            sportyMarket: `${side === 'home' ? 'Home' : 'Away'} O/U (${line})`,
            selKey: key,
            label: `${team} ${isOver ? 'Over' : 'Under'} ${line}`,
            sportyPick: `${team} ${isOver ? 'Over' : 'Under'} ${line}`,
            marketId: mid,
            outcomeId: o.id,
            specifier: spec,
            odds: o.odds,
            brProb: o.probability,
            modelP: modelMap.get(`${side}ou${line}:${key}`),
          });
        }
      }
    }
    // 8. Correct Score (Market 45)
    else if (mid === '45') {
      for (const o of outs) {
        const scoreStr = (o.desc || '').trim().replace(':', '-');
        if (!/^\d+-\d+$/.test(scoreStr)) continue;
        pushSel({
          group: 'Correct Score',
          marketKey: 'cs',
          marketName: 'Correct Score',
          sportyMarket: 'Correct Score',
          selKey: scoreStr,
          label: `Correct Score ${scoreStr}`,
          sportyPick: `CS ${o.desc}`,
          marketId: '45',
          outcomeId: o.id,
          specifier: '',
          odds: o.odds,
          brProb: o.probability,
          modelP: modelMap.get(`cs:${scoreStr}`),
        });
      }
    }
    // 9. Multiscores (Market 551 — e.g. "1:0, 2:0 or 3:0")
    else if (mid === '551') {
      for (const o of outs) {
        pushSel({
          group: 'Correct Score',
          marketKey: 'multiscore',
          marketName: 'Multiscores (Cluster CS)',
          sportyMarket: 'Multiscores',
          selKey: o.id,
          label: `Multiscore: ${o.desc}`,
          sportyPick: `Multiscore ${o.desc}`,
          marketId: '551',
          outcomeId: o.id,
          specifier: '',
          odds: o.odds,
          brProb: o.probability,
        });
      }
    }
    // 10. Multigoals (Market 548 — e.g. "1-3", "2-4")
    else if (mid === '548') {
      for (const o of outs) {
        pushSel({
          group: 'Goals',
          marketKey: 'multigoals',
          marketName: 'Multi-Goals Range',
          sportyMarket: 'Multigoals',
          selKey: o.id,
          label: `${o.desc} Goals`,
          sportyPick: `Multigoals ${o.desc}`,
          marketId: '548',
          outcomeId: o.id,
          specifier: '',
          odds: o.odds,
          brProb: o.probability,
        });
      }
    }
    // 11. Corners Over/Under (Market 166) & Corners 1X2 (Market 162)
    else if (mid === '166') {
      const mLine = spec.match(/total=([0-9.]+)/);
      const line = mLine ? mLine[1] : '';
      for (const o of outs) {
        const isOver = o.id === '12' || /^over/i.test(o.desc);
        const key = isOver ? 'over' : 'under';
        pushSel({
          group: 'Corners',
          marketKey: `corners_ou${line}`,
          marketName: `Corners O/U ${line}`,
          sportyMarket: `Corners O/U (${line})`,
          selKey: key,
          label: `Corners ${isOver ? 'Over' : 'Under'} ${line}`,
          sportyPick: `Corners ${o.desc}`,
          marketId: '166',
          outcomeId: o.id,
          specifier: spec,
          odds: o.odds,
          brProb: o.probability,
          modelP: modelMap.get(`corners_ou${line}:${key}`),
        });
      }
    } else if (mid === '162') {
      for (const o of outs) {
        const key = o.id === '1' ? 'home' : o.id === '2' ? 'draw' : 'away';
        pushSel({
          group: 'Corners',
          marketKey: 'corners_1x2',
          marketName: 'Most Corners (1X2)',
          sportyMarket: 'Corners 1X2',
          selKey: key,
          label: `Most Corners: ${o.desc}`,
          sportyPick: `Corners ${o.desc}`,
          marketId: '162',
          outcomeId: o.id,
          specifier: '',
          odds: o.odds,
          brProb: o.probability,
        });
      }
    }
    // 12. Bookings / Yellow-Red Cards Over/Under (Market 139) & Bookings 1X2 (Market 136)
    else if (mid === '139') {
      const mLine = spec.match(/total=([0-9.]+)/);
      const line = mLine ? mLine[1] : '';
      for (const o of outs) {
        const isOver = o.id === '12' || /^over/i.test(o.desc);
        const key = isOver ? 'over' : 'under';
        pushSel({
          group: 'Cards',
          marketKey: `cards_ou${line}`,
          marketName: `Bookings (Cards) O/U ${line}`,
          sportyMarket: `Bookings O/U (${line})`,
          selKey: key,
          label: `Cards ${isOver ? 'Over' : 'Under'} ${line}`,
          sportyPick: `Bookings ${o.desc}`,
          marketId: '139',
          outcomeId: o.id,
          specifier: spec,
          odds: o.odds,
          brProb: o.probability,
          modelP: modelMap.get(`cards_ou${line}:${key}`),
        });
      }
    } else if (mid === '136') {
      for (const o of outs) {
        const key = o.id === '1' ? 'home' : o.id === '2' ? 'draw' : 'away';
        pushSel({
          group: 'Cards',
          marketKey: 'cards_1x2',
          marketName: 'Most Bookings/Cards (1X2)',
          sportyMarket: 'Bookings 1X2',
          selKey: key,
          label: `Most Cards: ${o.desc}`,
          sportyPick: `Bookings ${o.desc}`,
          marketId: '136',
          outcomeId: o.id,
          specifier: '',
          odds: o.odds,
          brProb: o.probability,
        });
      }
    }
    // 13. Shots & SOT: Total O/U (900394/900393), Team O/U (900552/900553/900546/900547), Most Shots/SOT 1X2 (900320/900318), Outside Box (800054)
    else if (['900394', '900393', '900552', '900553', '900546', '900547'].includes(mid)) {
      const isSot = ['900393', '900546', '900547'].includes(mid);
      const side = ['900552', '900546'].includes(mid) ? 'home' : ['900553', '900547'].includes(mid) ? 'away' : 'total';
      const sideName = side === 'home' ? ev.homeTeamName : side === 'away' ? ev.awayTeamName : '';
      const mLine = spec.match(/total=([0-9.]+)/);
      const line = mLine ? mLine[1] : '';
      for (const o of outs) {
        const isOver = o.id === '12' || o.id === '30' || /^over/i.test(o.desc);
        const key = isOver ? 'over' : 'under';
        const statTag = isSot ? 'SOT' : 'Shots';
        const prefix = sideName ? `${sideName} ${statTag}` : statTag;
        const mktKey = side === 'total' ? `${isSot ? 'sot' : 'shots'}_ou${line}` : `${isSot ? 'sot' : 'shots'}${side}${line}`;
        pushSel({
          group: 'Shots',
          marketKey: mktKey,
          marketName: `${prefix} O/U ${line}`,
          sportyMarket: `${side === 'total' ? '' : (side === 'home' ? 'Home ' : 'Away ')}${statTag} O/U (${line})`,
          selKey: key,
          label: `${prefix} ${o.desc}`,
          sportyPick: `${prefix} ${o.desc}`,
          marketId: mid,
          outcomeId: o.id,
          specifier: spec,
          odds: o.odds,
          brProb: o.probability,
          modelP: modelMap.get(`${mktKey}:${key}`),
        });
      }
    } else if (mid === '900320' || mid === '900318') {
      const isSot = mid === '900318';
      const statTag = isSot ? 'Shots on Target' : 'Total Shots';
      const mktKey = isSot ? 'sot_1x2' : 'shots_1x2';
      for (const o of outs) {
        if (o.id === '2') continue; // skip rare exact tie on shots
        const key = o.id === '1' ? 'home' : 'away';
        const team = o.id === '1' ? ev.homeTeamName : ev.awayTeamName;
        pushSel({
          group: 'Shots',
          marketKey: mktKey,
          marketName: `Most ${statTag} (1X2)`,
          sportyMarket: `${isSot ? 'SOT' : 'Shots'} 1X2`,
          selKey: key,
          label: `Most ${isSot ? 'SOT' : 'Shots'}: ${team}`,
          sportyPick: `Most ${isSot ? 'SOT' : 'Shots'} - ${o.desc}`,
          marketId: mid,
          outcomeId: o.id,
          specifier: '',
          odds: o.odds,
          brProb: o.probability,
          modelP: modelMap.get(`${mktKey}:${key}`),
        });
      }
    } else if (mid === '800054') {
      for (const o of outs) {
        pushSel({
          group: 'Shots',
          marketKey: 'shots_outbox',
          marketName: 'Match Shots Outside Box',
          sportyMarket: 'Shots Outside Box',
          selKey: o.id,
          label: `Shots Outside Box: ${o.desc}`,
          sportyPick: `Outside Box Shots ${o.desc}`,
          marketId: mid,
          outcomeId: o.id,
          specifier: spec,
          odds: o.odds,
          brProb: o.probability,
        });
      }
    }
    // 13B. Team Corners (900300/900301), 1H Corners (177), Team Bookings (900304/900305), Match Cards (800063)
    else if (['900300', '900301', '177'].includes(mid)) {
      const mLine = spec.match(/total=([0-9.]+)/);
      const line = mLine ? mLine[1] : '';
      const prefix = mid === '900300' ? `${ev.homeTeamName} Corners` : mid === '900301' ? `${ev.awayTeamName} Corners` : '1H Corners';
      const mktKey = mid === '900300' ? `cornershome${line}` : mid === '900301' ? `cornersaway${line}` : `corners_1h_ou${line}`;
      for (const o of outs) {
        const isOver = o.id === '12' || o.id === '30' || /^over/i.test(o.desc);
        const key = isOver ? 'over' : 'under';
        pushSel({
          group: 'Corners',
          marketKey: mktKey,
          marketName: `${prefix} O/U ${line}`,
          sportyMarket: `${prefix} (${line})`,
          selKey: key,
          label: `${prefix} ${o.desc}`,
          sportyPick: `${prefix} ${o.desc}`,
          marketId: mid,
          outcomeId: o.id,
          specifier: spec,
          odds: o.odds,
          brProb: o.probability,
          modelP: modelMap.get(`${mktKey}:${key}`),
        });
      }
    } else if (['900304', '900305', '800063'].includes(mid)) {
      const mLine = spec.match(/total=([0-9.]+)/);
      const line = mLine ? mLine[1] : '';
      const prefix = mid === '900304' ? `${ev.homeTeamName} Cards` : mid === '900305' ? `${ev.awayTeamName} Cards` : 'Match Cards';
      for (const o of outs) {
        const isOver = o.id === '12' || o.id === '30' || /^over|\+/i.test(o.desc);
        const key = mid === '800063' ? o.id : (isOver ? 'over' : 'under');
        pushSel({
          group: 'Cards',
          marketKey: mid === '800063' ? 'cards_milestone' : `cards_${mid === '900304' ? 'home' : 'away'}_ou${line}`,
          marketName: mid === '800063' ? 'Match Cards Milestone' : `${prefix} O/U ${line}`,
          sportyMarket: prefix,
          selKey: key,
          label: `${prefix}: ${o.desc}`,
          sportyPick: `${prefix} ${o.desc}`,
          marketId: mid,
          outcomeId: o.id,
          specifier: spec,
          odds: o.odds,
          brProb: o.probability,
        });
      }
    }
    // 14. Throw-Ins (900769), Goal Kicks (900770 / desc match), Offsides (900396/900568/900569), Fouls (900342/900539/900544/900545)
    else if (
      ['900396', '900568', '900569', '900342', '900539', '900544', '900545', '900769', '900770'].includes(mid) ||
      /throw.?in|goal.?kick/i.test(m.desc || m.name || '')
    ) {
      const rawDesc = m.desc || m.name || '';
      const isThrow = mid === '900769' || /throw.?in/i.test(rawDesc);
      const isGk = mid === '900770' || /goal.?kick/i.test(rawDesc);
      const isOff = ['900396', '900568', '900569'].includes(mid);
      const grp = isThrow || isGk ? 'Throws & Goal Kicks' : 'Offsides & fouls';

      if (mid === '900539') {
        for (const o of outs) {
          if (o.id === '2') continue;
          const key = o.id === '1' ? 'home' : 'away';
          const team = o.id === '1' ? ev.homeTeamName : ev.awayTeamName;
          pushSel({
            group: 'Offsides & fouls',
            marketKey: 'fouls_1x2',
            marketName: 'Most Fouls Committed (1X2)',
            sportyMarket: 'Fouls 1X2',
            selKey: key,
            label: `Most Fouls: ${team}`,
            sportyPick: `Fouls ${o.desc}`,
            marketId: mid,
            outcomeId: o.id,
            specifier: '',
            odds: o.odds,
            brProb: o.probability,
            modelP: modelMap.get(`fouls_1x2:${key}`),
          });
        }
      } else {
        const sidePrefix = ['900568', '900544'].includes(mid)
          ? `${ev.homeTeamName} `
          : ['900569', '900545'].includes(mid)
            ? `${ev.awayTeamName} `
            : '';
        const statLabel = isThrow ? 'Throw-Ins' : isGk ? 'Goal Kicks' : isOff ? 'Offsides' : 'Fouls';
        const statKey = isThrow ? 'throwins' : isGk ? 'goalkicks' : isOff ? 'offsides' : 'fouls';
        const mLine = spec.match(/total=([0-9.]+)/);
        const line = mLine ? mLine[1] : '';
        for (const o of outs) {
          const isOver = o.id === '12' || o.id === '30' || /^over/i.test(o.desc);
          const key = isOver ? 'over' : 'under';
          pushSel({
            group: grp,
            marketKey: `${statKey}${sidePrefix ? '_team' : ''}_ou${line}`,
            marketName: `${sidePrefix}${statLabel} O/U ${line}`,
            sportyMarket: `${sidePrefix}${statLabel} O/U (${line})`,
            selKey: key,
            label: `${sidePrefix}${statLabel} ${o.desc}`,
            sportyPick: `${sidePrefix}${statLabel} ${o.desc}`,
            marketId: mid,
            outcomeId: o.id,
            specifier: spec,
            odds: o.odds,
            brProb: o.probability,
            modelP: modelMap.get(`${statKey}_ou${line}:${key}`),
          });
        }
      }
    }
    // 15. Halftime/Fulltime (47), Odd/Even (26), Clean Sheet (31/32), Win to Nil (33/34)
    else if (mid === '47') {
      for (const o of outs) {
        pushSel({
          group: 'Main',
          marketKey: 'htft',
          marketName: 'Halftime / Fulltime',
          sportyMarket: 'HT/FT',
          selKey: o.id,
          label: `HT/FT: ${o.desc}`,
          sportyPick: `HT/FT ${o.desc}`,
          marketId: '47',
          outcomeId: o.id,
          specifier: '',
          odds: o.odds,
          brProb: o.probability,
        });
      }
    } else if (mid === '26') {
      for (const o of outs) {
        pushSel({
          group: 'Goals',
          marketKey: 'oddeven',
          marketName: 'Odd/Even Total Goals',
          sportyMarket: 'Odd/Even',
          selKey: o.desc.toLowerCase(),
          label: `${o.desc} Goals`,
          sportyPick: `Goals ${o.desc}`,
          marketId: '26',
          outcomeId: o.id,
          specifier: '',
          odds: o.odds,
          brProb: o.probability,
        });
      }
    } else if (['31', '32', '33', '34'].includes(mid)) {
      const mName = m.desc || m.name;
      for (const o of outs) {
        pushSel({
          group: 'Specials',
          marketKey: `sp_${mid}`,
          marketName: mName,
          sportyMarket: mName,
          selKey: o.id,
          label: `${mName}: ${o.desc}`,
          sportyPick: `${mName} - ${o.desc}`,
          marketId: mid,
          outcomeId: o.id,
          specifier: '',
          odds: o.odds,
          brProb: o.probability,
        });
      }
    }
    // 16. Other sports moneyline (Basketball/NFL 219, Tennis 186, Baseball 251)
    else if (['219', '186', '251'].includes(mid)) {
      for (const o of outs) {
        const isHome = o.id === '4' || o.id === '1' || /home/i.test(o.desc);
        const team = isHome ? ev.homeTeamName : ev.awayTeamName;
        pushSel({
          group: 'Main',
          marketKey: 'ml',
          marketName: 'Match Winner',
          sportyMarket: m.desc || 'Winner',
          selKey: isHome ? 'home' : 'away',
          label: `${team} to Win`,
          sportyPick: `${team} (Winner)`,
          marketId: mid,
          outcomeId: o.id,
          specifier: spec,
          odds: o.odds,
          brProb: o.probability,
        });
      }
    }
  }

  return selections;
}

/**
 * Resolve any slip item (even if added from an ESPN game card without a pre-attached sportySelection)
 * to a valid SportyBet `{ eventId, marketId, outcomeId, specifier }` selection.
 */
export async function resolveSportySelection(item) {
  if (item?.sportySelection?.eventId && item?.sportySelection?.marketId && item?.sportySelection?.outcomeId) {
    return item.sportySelection;
  }

  // Try matching by team names in our SportyBet catalog
  const catalog = await getSportyCatalog();
  let ev = null;
  if (item.eventId && String(item.eventId).startsWith('sr:match:')) {
    ev = catalogCache.byId.get(item.eventId);
  }
  if (!ev && (item.home || item.matchup)) {
    let home = item.home;
    let away = item.away;
    if (!home && item.matchup) {
      if (item.matchup.includes('@')) {
        const [a, h] = item.matchup.split('@').map((s) => s.trim());
        home = h;
        away = a;
      } else if (item.matchup.includes(' vs ')) {
        const [h, a] = item.matchup.split(' vs ').map((s) => s.trim());
        home = h;
        away = a;
      }
    }
    if (home && away) {
      let bestScore = 0;
      for (const cand of catalog) {
        const hs = teamMatchScore(home, cand.homeTeamName);
        const as = teamMatchScore(away, cand.awayTeamName);
        if (hs >= 0.6 && as >= 0.6 && hs + as > bestScore) {
          bestScore = hs + as;
          ev = cand;
        }
      }
    }
  }

  if (!ev) return null;
  const bookable = extractBookableSelections(ev);
  if (!bookable.length) return null;

  // Match by marketKey + selKey
  const exact = bookable.find((b) => b.marketKey === item.marketKey && b.selKey === item.selKey);
  if (exact) return exact.sportySelection;

  // Fallback match by marketKey
  const byMkt = bookable.find((b) => b.marketKey === item.marketKey);
  if (byMkt) return byMkt.sportySelection;

  // Fallback to 1X2 / Winner matching home/away/draw
  if (['home', 'away', 'draw'].includes(item.selKey)) {
    const main = bookable.find((b) => ['1x2', 'ml'].includes(b.marketKey) && b.selKey === item.selKey);
    if (main) return main.sportySelection;
  }

  return null;
}

/**
 * Generate a REAL 6-character SportyBet Ghana Booking Code (`shareCode`) by posting selections
 * to `https://www.sportybet.com/api/gh/orders/share`.
 */
export const SPORTY_MAX_GAMES = 50;

export async function generateSportyBookingCode(items = []) {
  const validSelections = [];
  const seenKeys = new Set();

  for (const item of items) {
    if (validSelections.length >= SPORTY_MAX_GAMES) break;
    const sel = await resolveSportySelection(item);
    if (sel?.eventId && sel?.marketId && sel?.outcomeId) {
      const k = `${sel.eventId}:${sel.marketId}:${sel.specifier || ''}:${sel.outcomeId}`;
      if (!seenKeys.has(k)) {
        seenKeys.add(k);
        validSelections.push({
          eventId: String(sel.eventId),
          marketId: String(sel.marketId),
          outcomeId: String(sel.outcomeId),
          specifier: sel.specifier ? String(sel.specifier) : '',
        });
      }
    }
  }

  if (!validSelections.length) {
    return { ok: false, error: 'No matching active SportyBet Ghana selections could be resolved.' };
  }

  const fingerprint = validSelections.map((s) => `${s.eventId}|${s.marketId}|${s.specifier}|${s.outcomeId}`).join(';');
  const cached = shareCodeCache.get(fingerprint);
  if (cached && Date.now() - cached.ts < 20 * 60 * 1000) {
    return cached;
  }

  let lastErr = 'SportyBet rejected the selections.';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 450 + Math.random() * 250));
      const res = await fetch(`${SPORTY_BASE}/orders/share`, {
        method: 'POST',
        headers: SPORTY_HEADERS,
        body: JSON.stringify({ selections: validSelections }),
        signal: AbortSignal.timeout(10000),
      });
      const json = await res.json();
      if (json.bizCode === 10000 && json.data?.shareCode) {
        const result = {
          ok: true,
          ts: Date.now(),
          shareCode: json.data.shareCode,
          shareURL: `https://www.sportybet.com/gh/?shareCode=${json.data.shareCode}`,
          bookedCount: json.data.outcomes?.length || validSelections.length,
          requestedCount: items.length,
          deadline: json.data.deadline,
        };
        shareCodeCache.set(fingerprint, result);
        return result;
      }
      lastErr = json.message || json.innerMsg || lastErr;
    } catch (err) {
      lastErr = err.message;
    }
  }
  return { ok: false, error: lastErr };
}

/**
 * Load & decode any SportyBet Ghana Booking Code (e.g. "9YG45J" or "DYQ6BF") directly from SportyBet's servers,
 * and evaluate every leg's true win probability, fair odds, and value edge!
 */
export async function loadSportyBookingCode(code) {
  const clean = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!clean || clean.length < 4) {
    throw new Error('Please enter a valid SportyBet Ghana booking code (e.g. 9YG45J).');
  }

  const url = `${SPORTY_BASE}/orders/share/${encodeURIComponent(clean)}?_t=${Date.now()}`;
  const res = await fetch(url, { headers: SPORTY_HEADERS, signal: AbortSignal.timeout(10000) });
  const json = await res.json();
  if (json.bizCode !== 10000 || !json.data?.outcomes) {
    throw new Error(json.message || `Booking code "${clean}" was not found or has expired on SportyBet Ghana.`);
  }

  const legs = [];
  for (const ev of json.data.outcomes) {
    for (const m of ev.markets || []) {
      for (const o of m.outcomes || []) {
        const odds = Number(o.odds) || 1.5;
        const rawProb = Number(o.probability);
        const p = Number.isFinite(rawProb) && rawProb > 0.001 && rawProb < 0.999 ? +rawProb.toFixed(4) : +(0.945 / odds).toFixed(4);
        const fair = +(1 / Math.max(p, 1e-4)).toFixed(2);
        const edge = +((p * odds - 1) * 100).toFixed(1);

        legs.push({
          id: `${ev.eventId}:${m.id}:${m.specifier || ''}:${o.id}`,
          gameId: ev.eventId,
          sportyGameId: ev.gameId,
          eventId: ev.eventId,
          date: new Date(ev.estimateStartTime).toISOString(),
          matchup: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
          home: ev.homeTeamName,
          away: ev.awayTeamName,
          league: ev.sport?.category?.tournament?.id || 'sporty',
          leagueName: `${ev.sport?.category?.name || ''} · ${ev.sport?.category?.tournament?.name || ''}`.replace(/^ · /, ''),
          sport: ev.sport?.id === 'sr:sport:1' ? 'soccer' : (ev.sport?.name || 'soccer').toLowerCase(),
          group: m.group || 'Main',
          marketKey: String(m.id),
          market: m.desc || m.name,
          sportyMarket: m.desc || m.name,
          selKey: String(o.id),
          label: `${m.desc}: ${o.desc}`,
          sportyPick: o.desc,
          p,
          fairOdds: fair,
          sportyOdds: +odds.toFixed(2),
          userOdds: +odds.toFixed(2),
          edgePct: edge,
          verdict: p >= 0.70 ? 'Strong Banker' : edge >= 0 ? 'Positive Value' : p < 0.35 ? 'High Risk Trap' : 'Fair Leg',
          sportySelection: {
            eventId: ev.eventId,
            marketId: String(m.id),
            outcomeId: String(o.id),
            specifier: m.specifier || '',
          },
        });
      }
    }
  }

  const combP = legs.reduce((a, b) => a * b.p, 1);
  const totalSportyOdds = +(legs.reduce((a, b) => a * (b.sportyOdds || b.fairOdds || 1), 1)).toFixed(2);
  const combinedFairOdds = legs.length ? +(1 / Math.max(combP, 1e-6)).toFixed(2) : 0;
  const traps = legs.filter((l) => l.p < 0.42);

  return {
    shareCode: clean,
    shareURL: `https://www.sportybet.com/gh/?shareCode=${clean}`,
    count: legs.length,
    legs,
    combinedProb: +combP.toFixed(4),
    combinedFairOdds,
    totalSportyOdds,
    trapsCount: traps.length,
    overallRating: traps.length === 0 && combP >= 0.15 ? 'A+ Vhim Approved' : traps.length <= 1 ? 'B+ Playable' : 'C — Contains Trap Legs (Remove Weak Picks)',
  };
}
