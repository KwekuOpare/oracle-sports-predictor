// ESPN public data access: fetching, disk/memory caching and normalisation into a
// sport-agnostic "game" shape used by the models and the UI.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cache');
const mem = new Map(); // key -> { expires, value }

// ---------- low level ----------

let active = 0;
const queue = [];
async function limited(fn) {
  if (active >= 6) await new Promise((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

async function fetchJson(url, tries = 3) {
  return limited(async () => {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'sports-predictor/1.0' } });
        if (res.status === 400 || res.status === 404) return null; // no data for that window
        if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`);
        return await res.json();
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw lastErr;
  });
}

function safeName(s) {
  return s.replace(/[^a-z0-9.-]+/gi, '_');
}

/** Cache helper: ttlMs = Infinity means "never expires" (stored on disk). */
async function cached(key, ttlMs, loader) {
  const hit = mem.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const file = path.join(CACHE_DIR, safeName(key) + '.json');
  if (ttlMs === Infinity) {
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      mem.set(key, { expires: Infinity, value });
      return value;
    } catch { /* not cached yet */ }
  }
  const value = await loader();
  mem.set(key, { expires: Date.now() + ttlMs, value });
  if (ttlMs === Infinity && value) {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
  }
  return value;
}

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p.set(k, v);
  return p.toString();
}

// ---------- normalisation ----------

function americanToProb(v) {
  const n = typeof v === 'string' ? parseFloat(v.replace('+', '')) : v;
  if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
}

function pickOdds(o) {
  if (!o) return null;
  const ml = o.moneyline || {};
  const ps = o.pointSpread || {};
  const homeML = ml.home?.close?.odds ?? ml.home?.open?.odds ?? o.homeTeamOdds?.moneyLine;
  const awayML = ml.away?.close?.odds ?? ml.away?.open?.odds ?? o.awayTeamOdds?.moneyLine;
  const drawML = ml.draw?.close?.odds ?? ml.draw?.open?.odds ?? o.drawOdds?.moneyLine;

  const openHomeML = ml.home?.open?.odds ?? null;
  const openAwayML = ml.away?.open?.odds ?? null;
  const openDrawML = ml.draw?.open?.odds ?? null;

  const h = americanToProb(homeML);
  const a = americanToProb(awayML);
  const d = americanToProb(drawML);
  let implied = null;
  if (h && a) {
    const total = h + a + (d || 0); // remove the bookmaker margin ("vig")
    implied = { home: h / total, draw: d ? d / total : 0, away: a / total };
  }

  const oh = americanToProb(openHomeML);
  const oa = americanToProb(openAwayML);
  const od = americanToProb(openDrawML);
  let openImplied = null;
  let movement = null;
  if (oh && oa && implied) {
    const ototal = oh + oa + (od || 0);
    openImplied = { home: oh / ototal, draw: od ? od / ototal : 0, away: oa / ototal };
    movement = {
      home: +(implied.home - openImplied.home).toFixed(3),
      away: +(implied.away - openImplied.away).toFixed(3),
      draw: +(implied.draw - openImplied.draw).toFixed(3),
    };
  }

  const openSpread = ps.home?.open?.line != null ? Number(ps.home.open.line) : null;
  const spread = o.spread != null ? Number(o.spread) : (ps.home?.close?.line != null ? Number(ps.home.close.line) : null);
  const spreadShift = (spread != null && openSpread != null) ? +(spread - openSpread).toFixed(1) : null;

  return {
    provider: o.provider?.name || 'Sportsbook',
    details: o.details || null,
    spread,
    openSpread,
    spreadShift,
    overUnder: o.overUnder ?? null,
    homeML: homeML ?? null,
    awayML: awayML ?? null,
    drawML: drawML ?? null,
    openHomeML,
    openAwayML,
    implied,
    openImplied,
    movement,
  };
}

function side(c) {
  if (!c) return null;
  const t = c.team || c.athlete || {};
  const rec = c.records?.find((r) => r.type === 'total' || r.name === 'overall') || c.records?.[0];
  return {
    id: String(t.id ?? c.id ?? t.displayName),
    name: t.displayName || t.fullName || t.name || 'TBD',
    short: t.shortDisplayName || t.shortName || t.displayName || 'TBD',
    abbr: t.abbreviation || (t.shortName || t.displayName || '').slice(0, 3).toUpperCase(),
    logo: t.logo || t.logos?.[0]?.href || t.flag?.href || t.headshot?.href || null,
    score: c.score !== undefined && c.score !== '' ? Number(c.score?.value ?? c.score) : null,
    linescores: c.linescores?.map((l) => l.value) || null,
    record: rec?.summary || null,
    winner: c.winner === true,
  };
}

function isFirstHalf(clock) {
  const m = /^(\d+)'/.exec(clock || '');
  return m ? Number(m[1]) <= 45 : false;
}

/** Soccer extras: team stats + cards and half-time score derived from the event timeline. */
function soccerExtras(game, comp, homeRaw, awayRaw) {
  const num = (c, name) => {
    const s = c?.statistics?.find((x) => x.name === name);
    const v = s ? Number(s.displayValue) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  const base = (c) => ({
    corners: num(c, 'wonCorners'),
    fouls: num(c, 'foulsCommitted'),
    shots: num(c, 'totalShots'),
    sot: num(c, 'shotsOnTarget'),
    poss: num(c, 'possessionPct'),
    yellow: null,
    red: null,
    offsides: null,
  });
  const hs = base(homeRaw), as = base(awayRaw);
  const hid = String(homeRaw?.team?.id ?? homeRaw?.id), aid = String(awayRaw?.team?.id ?? awayRaw?.id);
  const det = comp.details;
  if (Array.isArray(det) && game.completed) {
    const goals = { home: 0, away: 0 }, ht = { home: 0, away: 0 };
    hs.yellow = 0; hs.red = 0; as.yellow = 0; as.red = 0;
    for (const d of det) {
      const tid = String(d.team?.id ?? '');
      const s = tid === hid ? 'home' : tid === aid ? 'away' : null;
      if (!s) continue;
      const st = s === 'home' ? hs : as;
      if (d.redCard) st.red++;
      else if (d.yellowCard) st.yellow++;
      if (d.scoringPlay) {
        goals[s]++;
        if (isFirstHalf(d.clock?.displayValue)) ht[s]++;
      }
    }
    // Only trust the derived half-time score if the timeline adds up to the final score.
    if (goals.home === game.home.score && goals.away === game.away.score) game.ht = ht;
  }
  if (hs.corners !== null || hs.yellow !== null) {
    game.home.stats = hs;
    game.away.stats = as;
  }
  return game;
}

function normCompetition(event, comp, extra = {}, league = null) {
  const cs = comp.competitors || [];
  let home = cs.find((c) => c.homeAway === 'home');
  let away = cs.find((c) => c.homeAway === 'away');
  if (!home || !away || home === away) {
    const sorted = [...cs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    [home, away] = [sorted[0], sorted[1]];
  }
  const status = comp.status || event.status || {};
  const st = status.type || {};
  const game = {
    id: String(comp.id || event.id),
    eventId: String(event.id),
    date: comp.date || comp.startDate || event.date,
    name: event.name,
    state: st.state || 'pre',
    completed: !!st.completed,
    statusText: st.shortDetail || st.detail || st.description || '',
    neutral: !!comp.neutralSite,
    venue: comp.venue?.fullName || event.venue?.displayName || null,
    home: side(home),
    away: side(away),
    odds: pickOdds(comp.odds?.[0]),
    ...extra,
  };
  if (league?.sport === 'soccer' && game.home && game.away) soccerExtras(game, comp, home, away);
  return game;
}

function normalizeEvents(json, league) {
  const out = [];
  for (const ev of json?.events || []) {
    if (league.kind === 'individual' && ev.groupings) {
      // Tennis: event = tournament, groupings = draws (Men's Singles, ...)
      for (const g of ev.groupings) {
        const gname = g.grouping?.displayName || '';
        if (league.grouping && gname !== league.grouping) continue;
        for (const comp of g.competitions || []) {
          const game = normCompetition(ev, comp, { tournament: ev.name, round: comp.round?.displayName || null, neutral: true });
          if (game.home && game.away) out.push(game);
        }
      }
    } else if (league.kind === 'individual') {
      // MMA: event = fight card, competitions = bouts
      for (const comp of ev.competitions || []) {
        const game = normCompetition(ev, comp, { tournament: ev.name, round: comp.type?.abbreviation || null, neutral: true });
        if (game.home && game.away && !/TBA|TBD/i.test(game.home.name + game.away.name)) out.push(game);
      }
    } else {
      for (const comp of ev.competitions || []) {
        const game = normCompetition(ev, comp, {}, league);
        if (game.home && game.away) out.push(game);
      }
    }
  }
  return out;
}

// ---------- history (training data) ----------

function ym(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function fetchMonth(league, path_, monthDate, params) {
  const key = ym(monthDate);
  const monthEnd = Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 1);
  const final = monthEnd < Date.now() - 3 * 86400e3;
  const ttl = final ? Infinity : 20 * 60e3;
  const lim = league.limit || 1000;
  return cached(`${league.sport === 'soccer' ? 'hist2' : 'hist'}_${path_}_${qs(params)}_${key}`, ttl, async () => {
    const json = await fetchJson(`${BASE}/${path_}/scoreboard?${qs({ ...params, dates: key, limit: lim })}`);
    const n = json?.events?.length || 0;
    if (n < lim && !(n === 0 && league.dayFallback)) return normalizeEvents(json, league);
    // Busy month (e.g. college basketball): split into single days.
    const days = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0)).getUTCDate();
    const parts = await Promise.all(
      Array.from({ length: days }, (_, i) =>
        fetchJson(`${BASE}/${path_}/scoreboard?${qs({ ...params, dates: key + String(i + 1).padStart(2, '0'), limit: lim })}`)
      )
    );
    return parts.flatMap((j) => normalizeEvents(j, league));
  });
}

async function fetchCfbWeeks(league) {
  const now = new Date();
  const curSeason = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const jobs = [];
  for (const season of [curSeason - 1, curSeason]) {
    const ttl = season < curSeason ? Infinity : 20 * 60e3;
    const weeks = [...Array.from({ length: 16 }, (_, i) => [2, i + 1]), [3, 1]];
    for (const [type, week] of weeks) {
      jobs.push(
        cached(`hist_${league.path}_${season}_${type}_${week}_l${league.limit || 1000}`, ttl, async () => {
          const json = await fetchJson(`${BASE}/${league.path}/scoreboard?${qs({ ...league.params, dates: season, seasontype: type, week, limit: league.limit || 1000 })}`);
          return normalizeEvents(json, league);
        })
      );
    }
  }
  return (await Promise.all(jobs)).flat();
}

/** All completed games (deduplicated, chronological) used to train a league's models. */
export async function getHistory(league, extraPaths = []) {
  let games = [];
  if (league.fetch === 'cfbWeeks') {
    games = await fetchCfbWeeks(league);
  } else {
    const paths = [league.path, ...extraPaths];
    const now = new Date();
    const jobs = [];
    for (const p of paths) {
      for (let i = 0; i < league.history; i++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        jobs.push(fetchMonth(league, p, d, league.params || {}).then((g) => g.map((x) => ({ ...x, source: p }))));
      }
    }
    games = (await Promise.all(jobs)).flat();
  }
  const seen = new Set();
  const out = games
    .filter((g) =>
      g.completed &&
      (league.kind === 'individual'
        ? g.home.winner || g.away.winner
        : Number.isFinite(g.home.score) && Number.isFinite(g.away.score))
    )
    .filter((g) => (seen.has(g.id) ? false : (seen.add(g.id), true)))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (league.sport === 'soccer') await attachOffsides(out);
  return out;
}

// ---------- offsides enrichment (only available in per-match reports) ----------

const offsideStores = new Map(); // path -> { data: {gameId: [h, a]}, dirty }

async function offsideStore(p) {
  if (offsideStores.has(p)) return offsideStores.get(p);
  const file = path.join(CACHE_DIR, `offsides_${safeName(p)}.json`);
  let data = {};
  try { data = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* new */ }
  const store = { data, dirty: false, file };
  offsideStores.set(p, store);
  return store;
}

async function attachOffsides(games) {
  for (const g of games) {
    if (!g.home.stats) continue;
    const store = await offsideStore(g.source || '');
    const v = store.data[g.id];
    if (v) { g.home.stats.offsides = v[0]; g.away.stats.offsides = v[1]; }
  }
}

const enriching = new Set();
const noOffsides = new Set(); // reports without offsides data (don't retry this session)
/** Background job: fetch match reports for games missing offsides (cached forever). */
export async function enrichOffsides(games, max = 600) {
  const todo = games.filter((g) => g.home.stats && g.home.stats.offsides === null && g.source && !enriching.has(g.id) && !noOffsides.has(g.id)).slice(-max);
  if (!todo.length) return 0;
  let done = 0;
  await Promise.all(todo.map(async (g) => {
    enriching.add(g.id);
    try {
      const s = await fetchJson(`${BASE}/${g.source}/summary?event=${g.eventId}`);
      const teams = s?.boxscore?.teams || [];
      const get = (id) => {
        const t = teams.find((x) => String(x.team?.id) === id);
        const v = Number(t?.statistics?.find((x) => x.name === 'offsides')?.displayValue);
        return Number.isFinite(v) ? v : null;
      };
      const h = get(g.home.id), a = get(g.away.id);
      if (h !== null && a !== null) {
        const store = await offsideStore(g.source);
        store.data[g.id] = [h, a];
        store.dirty = true;
        g.home.stats.offsides = h; g.away.stats.offsides = a;
        done++;
      } else noOffsides.add(g.id);
    } catch { noOffsides.add(g.id); } finally { enriching.delete(g.id); }
  }));
  for (const store of offsideStores.values()) {
    if (!store.dirty) continue;
    store.dirty = false;
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(store.file, JSON.stringify(store.data));
  }
  return done;
}

// ---------- live / upcoming ----------

export async function getScoreboard(league, date) {
  const params = { ...(league.params || {}), limit: league.limit || 1000 };
  if (date) params.dates = date.replaceAll('-', '');
  return cached(`sb_${league.path}_${qs(params)}`, 60e3, async () => {
    const json = await fetchJson(`${BASE}/${league.path}/scoreboard?${qs(params)}`);
    return normalizeEvents(json, league).sort((a, b) => new Date(a.date) - new Date(b.date));
  });
}

/** Extra per-game context: ESPN's own analytics projection, injuries, recent form, news. */
export async function getSummary(league, eventId) {
  return cached(`sum_${league.path}_${eventId}`, 5 * 60e3, async () => {
    const s = await fetchJson(`${BASE}/${league.path}/summary?event=${encodeURIComponent(eventId)}`);
    if (!s) return null;
    const p = s.predictor;
    const pick = s.pickcenter?.[0];
    return {
      espnPredictor: p
        ? {
            label: p.header || 'ESPN Matchup Predictor',
            homeId: String(p.homeTeam?.id ?? ''),
            awayId: String(p.awayTeam?.id ?? ''),
            home: Number(p.homeTeam?.gameProjection) / 100 || null,
            away: Number(p.awayTeam?.gameProjection) / 100 || null,
            tie: Number(p.homeTeam?.tieProjection ?? p.awayTeam?.tieProjection) / 100 || 0,
          }
        : null,
      pickcenter: pick
        ? { provider: pick.provider?.name, details: pick.details, spread: pick.spread, overUnder: pick.overUnder }
        : null,
      injuries: (s.injuries || []).map((t) => ({
        team: t.team?.displayName,
        teamId: String(t.team?.id ?? ''),
        players: (t.injuries || []).slice(0, 14).map((i) => ({
          name: i.athlete?.displayName,
          position: i.athlete?.position?.abbreviation,
          status: i.status || i.type?.description,
          detail: i.details?.type || i.shortComment || '',
        })),
      })),
      officials: (s.gameInfo?.officials || []).map((o) => ({
        name: o.fullName || o.displayName || '',
        position: o.position?.displayName || o.position?.name || 'Referee',
      })).filter((o) => o.name),
      rosters: (s.rosters || []).map((r) => ({
        homeAway: r.homeAway || null,
        team: r.team?.displayName || '',
        teamId: String(r.team?.id ?? ''),
        formation: r.formation || null,
        starters: (r.roster || [])
          .filter((p) => p.starter)
          .map((p) => ({
            name: p.athlete?.displayName || '',
            position: p.position?.abbreviation || '',
            jersey: p.jersey || '',
          })),
      })),
      lastFive: (s.lastFiveGames || []).map((t) => ({
        team: t.team?.displayName,
        teamId: String(t.team?.id ?? ''),
        games: (t.events || []).map((e) => ({ result: e.gameResult, score: e.score, opponent: e.opponent?.displayName, atVs: e.atVs })),
      })),
      news: (s.news?.articles || s.news || []).slice?.(0, 5).map((a) => ({ headline: a.headline, link: a.links?.web?.href })) || [],
    };
  });
}

export { americanToProb };
