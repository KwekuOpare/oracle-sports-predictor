// Catalog of supported competitions and the per-sport tuning used by the models.
//
// kind:     'team' (home/away teams) or 'individual' (players / fighters)
// scoring:  'goals'  -> low-scoring, modelled with Poisson (soccer, hockey, baseball runs)
//           'points' -> high-scoring, modelled with a Normal margin distribution
//           'none'   -> no score model (tennis, MMA)
// draws:    whether a game can end level (soccer)
// elo:      k = update speed, home = home-advantage in Elo points, mov = margin-of-victory scaling
// sigma:    std-dev of the final margin for 'points' sports
// history:  how many months back to pull results for training
// fetch:    'month' (one request per month) or 'cfbWeeks' (college football week-by-week)

const SOCCER = { kind: 'team', scoring: 'goals', draws: true, elo: { k: 20, home: 65, mov: 'goals' }, maxGoals: 10, history: 25 };
const TOP_SOCCER = ['eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'ned.1', 'por.1', 'uefa.champions', 'uefa.europa'];

export const SPORTS = [
  { id: 'football', name: 'Football', icon: 'ðŸˆ' },
  { id: 'basketball', name: 'Basketball', icon: 'ðŸ€' },
  { id: 'baseball', name: 'Baseball', icon: 'âš¾' },
  { id: 'hockey', name: 'Hockey', icon: 'ðŸ’' },
  { id: 'soccer', name: 'Soccer', icon: 'âš½' },
  { id: 'tennis', name: 'Tennis', icon: 'ðŸŽ¾' },
  { id: 'mma', name: 'MMA', icon: 'ðŸ¥Š' },
];

export const LEAGUES = {
  nfl: { sport: 'football', path: 'football/nfl', name: 'NFL', kind: 'team', scoring: 'points', draws: false, elo: { k: 20, home: 48, mov: 'points' }, sigma: 13.5, totalSigma: 13.5, history: 26 },
  cfb: { sport: 'football', path: 'football/college-football', name: 'College Football (FBS)', kind: 'team', scoring: 'points', draws: false, elo: { k: 25, home: 55, mov: 'points' }, sigma: 16, totalSigma: 17, history: 26, fetch: 'cfbWeeks', params: { groups: 80 }, limit: 300 },
  nba: { sport: 'basketball', path: 'basketball/nba', name: 'NBA', kind: 'team', scoring: 'points', draws: false, elo: { k: 20, home: 70, mov: 'points' }, sigma: 12, totalSigma: 18, history: 26 },
  wnba: { sport: 'basketball', path: 'basketball/wnba', name: 'WNBA', kind: 'team', scoring: 'points', draws: false, elo: { k: 20, home: 60, mov: 'points' }, sigma: 11, totalSigma: 15, history: 28 },
  ncaam: { sport: 'basketball', path: 'basketball/mens-college-basketball', name: "Men's College Basketball", kind: 'team', scoring: 'points', draws: false, elo: { k: 25, home: 85, mov: 'points' }, sigma: 10.5, totalSigma: 15, history: 13, params: { groups: 50 }, dayFallback: true },
  ncaaw: { sport: 'basketball', path: 'basketball/womens-college-basketball', name: "Women's College Basketball", kind: 'team', scoring: 'points', draws: false, elo: { k: 25, home: 80, mov: 'points' }, sigma: 11, totalSigma: 15, history: 13, params: { groups: 50 }, dayFallback: true },
  mlb: { sport: 'baseball', path: 'baseball/mlb', name: 'MLB', kind: 'team', scoring: 'goals', draws: false, elo: { k: 5, home: 24, mov: 'runs' }, maxGoals: 25, history: 20 },
  nhl: { sport: 'hockey', path: 'hockey/nhl', name: 'NHL', kind: 'team', scoring: 'goals', draws: false, elo: { k: 8, home: 35, mov: 'goals' }, maxGoals: 12, history: 26 },

  'eng.1': { ...SOCCER, sport: 'soccer', path: 'soccer/eng.1', name: 'Premier League' },
  'esp.1': { ...SOCCER, sport: 'soccer', path: 'soccer/esp.1', name: 'La Liga' },
  'ita.1': { ...SOCCER, sport: 'soccer', path: 'soccer/ita.1', name: 'Serie A' },
  'ger.1': { ...SOCCER, sport: 'soccer', path: 'soccer/ger.1', name: 'Bundesliga' },
  'fra.1': { ...SOCCER, sport: 'soccer', path: 'soccer/fra.1', name: 'Ligue 1' },
  'ned.1': { ...SOCCER, sport: 'soccer', path: 'soccer/ned.1', name: 'Eredivisie' },
  'por.1': { ...SOCCER, sport: 'soccer', path: 'soccer/por.1', name: 'Primeira Liga' },
  'usa.1': { ...SOCCER, sport: 'soccer', path: 'soccer/usa.1', name: 'MLS' },
  'mex.1': { ...SOCCER, sport: 'soccer', path: 'soccer/mex.1', name: 'Liga MX' },
  'uefa.champions': { ...SOCCER, sport: 'soccer', path: 'soccer/uefa.champions', name: 'Champions League', pool: TOP_SOCCER, history: 13 },
  'uefa.europa': { ...SOCCER, sport: 'soccer', path: 'soccer/uefa.europa', name: 'Europa League', pool: TOP_SOCCER, history: 13 },

  atp: { sport: 'tennis', path: 'tennis/atp', name: 'ATP (Men)', kind: 'individual', scoring: 'none', draws: false, elo: { k: 32, home: 0, mov: 'none', dynamicK: true }, history: 14, grouping: "Men's Singles" },
  wta: { sport: 'tennis', path: 'tennis/wta', name: 'WTA (Women)', kind: 'individual', scoring: 'none', draws: false, elo: { k: 32, home: 0, mov: 'none', dynamicK: true }, history: 14, grouping: "Women's Singles" },
  ufc: { sport: 'mma', path: 'mma/ufc', name: 'UFC', kind: 'individual', scoring: 'none', draws: true, elo: { k: 40, home: 0, mov: 'none', dynamicK: true }, history: 30 },
};

export function getLeague(id) {
  const l = LEAGUES[id];
  if (!l) {
    const err = new Error(`Unknown league "${id}"`);
    err.status = 404;
    throw err;
  }
  return { id, ...l };
}

export function catalog() {
  return SPORTS.map((s) => ({
    ...s,
    leagues: Object.entries(LEAGUES)
      .filter(([, l]) => l.sport === s.id)
      .map(([id, l]) => ({ id, name: l.name, kind: l.kind, draws: l.draws, scoring: l.scoring })),
  }));
}
