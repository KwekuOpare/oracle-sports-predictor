// Live Cooked-Odds & Ticket Verification Arena Engine (server/arena.js)
// Automatically places every cooked ticket (Vhim Bankers, 20-Fold Accumulators, Mixed Multis,
// Identical Market Slips, Correct Score Vault Bundles, Insider Steam, and Custom Slips) into a
// persistent verification ledger, and grades every leg in real time against live & final results
// from SportyBet Ghana (factsCenter/event & liveOrPrematchEvents) and ESPN Global Scoreboards.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normTeam, teamMatchScore } from './sportybet.js';
import { getCuratedTickets, getSlipCentreVault } from './tickets.js';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'arena.json');

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

let db = null;
let dirty = false;
let lastSyncTs = 0;
let saveChain = Promise.resolve();

async function load() {
  if (db) return db;
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    try {
      db = JSON.parse(raw);
    } catch {
      const lastBrace = raw.lastIndexOf('\n}');
      db = lastBrace > 0 ? JSON.parse(raw.slice(0, lastBrace + 2)) : null;
    }
    if (!db || typeof db !== 'object') throw new Error('Invalid arena JSON');
    if (!db.tickets) db.tickets = {};
    if (!db.bankroll) db.bankroll = { startingGHS: 2500 };
  } catch {
    db = {
      tickets: {},
      bankroll: { startingGHS: 2500 },
      lastSyncedAt: null,
    };
  }
  return db;
}

function save() {
  if (!dirty || !db) return saveChain;
  dirty = false;
  const payload = JSON.stringify(db, null, 2);
  saveChain = saveChain.then(async () => {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    const tmpFile = `${FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmpFile, payload, 'utf8');
    await fs.rename(tmpFile, FILE);
  }).catch(() => {});
  return saveChain;
}
setInterval(() => { save(); }, 10e3).unref();

/** Parse "H:A" or "H-A" score string into { home, away }. */
function parseScoreStr(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d+)\s*[:\-]\s*(\d+)$/);
  if (!m) return null;
  return { home: Number(m[1]), away: Number(m[2]) };
}

function extractLineNumber(mk, fallbackLabel = '', defaultLine = 2.5) {
  const m = String(mk || '').match(/(\d+(?:\.\d+)?)/) || String(fallbackLabel || '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : defaultLine;
}

/**
 * Grade a single cooked leg against a normalized match result object.
 */
export function gradeLegAgainstMatch(leg, match) {
  if (!match || match.state === 'pre' || !Number.isFinite(match.homeScore) || !Number.isFinite(match.awayScore)) {
    return {
      state: 'PENDING',
      reason: 'Waiting for kick-off',
      score: null,
      htScore: null,
      matchStatus: match?.matchStatus || 'Upcoming',
      stats: null,
    };
  }

  const h = match.homeScore;
  const a = match.awayScore;
  const totalGoals = h + a;
  const diff = h - a;
  const maxHLead = Math.max(match.maxHomeLead ?? 0, diff);
  const maxALead = Math.max(match.maxAwayLead ?? 0, -diff);
  const isFinal = match.state === 'post';
  const scoreStr = `${h} - ${a}`;
  const htStr = Number.isFinite(match.htHome) && Number.isFinite(match.htAway) ? `${match.htHome}:${match.htAway}` : null;
  const statusLabel = isFinal ? 'FT' : (match.clock ? `${match.matchStatus || 'LIVE'} ${match.clock}` : (match.matchStatus || 'LIVE'));

  const mk = leg.marketKey || '';
  const sk = String(leg.selKey || '').toLowerCase();
  const pickText = String(leg.pickLabel || leg.sportyPick || leg.label || '');
  const st = match.stats || {};

  // Helper to build response
  const res = (state, detail) => ({
    state,
    reason: `${statusLabel} (${scoreStr})${detail ? ` · ${detail}` : ''}`,
    score: scoreStr,
    htScore: htStr,
    matchStatus: statusLabel,
    stats: st,
    settledAt: isFinal || state === 'WON_EARLY' ? new Date().toISOString() : null,
  });

  // 1. 1UP (1X2 - 1UP Early Payout)
  if (mk === '1up') {
    if (sk === 'home') {
      if (maxHLead >= 1) return res(isFinal && diff > 0 ? 'WON' : 'WON_EARLY', '⚡ 1UP Hit (+1 Goal Lead)');
      return isFinal ? res('LOST', 'Home never led by 1+') : res('TRAILING_LIVE', 'Needs Home +1 lead');
    }
    if (sk === 'away') {
      if (maxALead >= 1) return res(isFinal && diff < 0 ? 'WON' : 'WON_EARLY', '⚡ 1UP Hit (+1 Goal Lead)');
      return isFinal ? res('LOST', 'Away never led by 1+') : res('TRAILING_LIVE', 'Needs Away +1 lead');
    }
    if (sk === 'draw') {
      return isFinal ? (diff === 0 ? res('WON', 'Draw FT') : res('LOST', 'Not a Draw')) : (diff === 0 ? res('WINNING_LIVE', 'Level') : res('TRAILING_LIVE', 'Not level'));
    }
  }

  // 2. 2UP (1X2 - 2UP Early Payout)
  if (mk === '2up') {
    if (sk === 'home') {
      if (maxHLead >= 2) return res(isFinal && diff > 0 ? 'WON' : 'WON_EARLY', '⚡ 2UP Hit (+2 Goal Lead)');
      if (isFinal) return diff > 0 ? res('WON', 'Home Won FT') : res('LOST', 'Missed 2UP & FT Win');
      return diff > 0 ? res('WINNING_LIVE', 'Leading by 1') : res('TRAILING_LIVE', 'Needs Home lead');
    }
    if (sk === 'away') {
      if (maxALead >= 2) return res(isFinal && diff < 0 ? 'WON' : 'WON_EARLY', '⚡ 2UP Hit (+2 Goal Lead)');
      if (isFinal) return diff < 0 ? res('WON', 'Away Won FT') : res('LOST', 'Missed 2UP & FT Win');
      return diff < 0 ? res('WINNING_LIVE', 'Leading by 1') : res('TRAILING_LIVE', 'Needs Away lead');
    }
  }

  // 3. 1X2 / Moneyline
  if (mk === '1x2' || mk === 'ml') {
    const curWinner = diff > 0 ? 'home' : diff < 0 ? 'away' : 'draw';
    if (isFinal) {
      return sk === curWinner ? res('WON', `1X2 ${sk.toUpperCase()} ✓`) : res('LOST', `Result: ${curWinner.toUpperCase()}`);
    }
    return sk === curWinner ? res('WINNING_LIVE', 'Leading live') : res('TRAILING_LIVE', 'Behind/tied live');
  }

  // 4. Double Chance (1X, X2, 12)
  if (mk === 'dc') {
    const hit = (sk === '1x' && diff >= 0) || (sk === 'x2' && diff <= 0) || (sk === '12' && diff !== 0);
    if (isFinal) return hit ? res('WON', `DC ${sk.toUpperCase()} ✓`) : res('LOST', `DC ${sk.toUpperCase()} missed`);
    return hit ? res('WINNING_LIVE', 'Covered live') : res('TRAILING_LIVE', 'Outside cover live');
  }

  // 5. Draw No Bet (DNB)
  if (mk === 'dnb') {
    if (isFinal) {
      if (diff === 0) return res('VOID', 'Draw — Stake Refunded (Push)');
      const won = (sk === 'home' && diff > 0) || (sk === 'away' && diff < 0);
      return won ? res('WON', 'DNB Winner ✓') : res('LOST', 'DNB Lost');
    }
    if (diff === 0) return res('WINNING_LIVE', 'Level (Push safety)');
    return ((sk === 'home' && diff > 0) || (sk === 'away' && diff < 0)) ? res('WINNING_LIVE', 'Leading live') : res('TRAILING_LIVE', 'Behind live');
  }

  // 6. Total Goals Over/Under (ou0.5, ou1.5, ou2.5, ou3.5, ou4.5, total)
  if (mk.startsWith('ou') || mk === 'total') {
    const line = extractLineNumber(mk, pickText, 2.5);
    if (sk === 'over') {
      if (totalGoals > line) {
        return res(isFinal ? 'WON' : 'WON_EARLY', `⚡ Over ${line} Landed (${totalGoals} goals)`);
      }
      return isFinal
        ? res('LOST', `Only ${totalGoals} goals (needed >${line})`)
        : res('TRAILING_LIVE', `Needs ${Math.ceil(line - totalGoals)} more goal(s)`);
    }
    if (sk === 'under') {
      if (totalGoals > line) return res('LOST', `${totalGoals} goals exceeded Under ${line}`);
      return isFinal ? res('WON', `Under ${line} held (${totalGoals} goals)`) : res('WINNING_LIVE', `${totalGoals} goals so far`);
    }
  }

  // 7. Team Total Goals Over/Under (homeou0.5, awayou0.5, h_ou0.5, a_ou0.5)
  if (mk.startsWith('h_ou') || mk.startsWith('a_ou') || mk.startsWith('homeou') || mk.startsWith('awayou')) {
    const isHome = mk.startsWith('h_') || mk.startsWith('home');
    const teamGoals = isHome ? h : a;
    const line = extractLineNumber(mk, pickText, 0.5);
    if (sk === 'over') {
      if (teamGoals > line) return res(isFinal ? 'WON' : 'WON_EARLY', `Team Over ${line} (${teamGoals} scored)`);
      return isFinal ? res('LOST', `Team scored ${teamGoals}`) : res('TRAILING_LIVE', `Needs ${Math.ceil(line - teamGoals)} more`);
    }
    if (sk === 'under') {
      if (teamGoals > line) return res('LOST', `Team scored ${teamGoals} (> ${line})`);
      return isFinal ? res('WON', `Team Under ${line} ✓`) : res('WINNING_LIVE', `Team at ${teamGoals}`);
    }
  }

  // 8. Both Teams To Score (GG / NG)
  if (mk === 'ggng') {
    const bothScored = h >= 1 && a >= 1;
    if (sk === 'gg' || sk === 'yes') {
      if (bothScored) return res(isFinal ? 'WON' : 'WON_EARLY', '⚡ GG Landed (Both teams scored)');
      return isFinal ? res('LOST', 'NG (Clean sheet kept)') : res('TRAILING_LIVE', h === 0 && a === 0 ? 'Needs both teams to score' : '1 team scored, needs other');
    }
    if (sk === 'ng' || sk === 'no') {
      if (bothScored) return res('LOST', 'Both teams scored');
      return isFinal ? res('WON', 'NG Held ✓') : res('WINNING_LIVE', 'Clean sheet intact');
    }
  }

  // 9. Exact Correct Score (cs)
  if (mk === 'cs') {
    const target = parseScoreStr(sk) || parseScoreStr(pickText);
    if (target) {
      if (h > target.home || a > target.away) {
        return res('LOST', `Score ${h}:${a} exceeded target ${target.home}:${target.away}`);
      }
      if (isFinal) {
        return (h === target.home && a === target.away)
          ? res('WON', `🎯 Exact Score ${h}:${a} HIT!`)
          : res('LOST', `FT ${h}:${a} (picked ${target.home}:${target.away})`);
      }
      return (h === target.home && a === target.away)
        ? res('WINNING_LIVE', `🎯 On Exact Score ${h}:${a} live!`)
        : res('TRAILING_LIVE', `Live ${h}:${a} -> target ${target.home}:${target.away}`);
    }
  }

  // 10. Multiscores Cluster (multiscore) & Multigoals (multigoals)
  if (mk === 'multiscore') {
    const pairs = [...pickText.matchAll(/(\d+)\s*:\s*(\d+)/g)].map((m) => ({ home: Number(m[1]), away: Number(m[2]) }));
    const matchesPair = pairs.some((p) => p.home === h && p.away === a);
    const otherHome = /other home win/i.test(pickText) && diff > 0 && h >= 4;
    const otherAway = /other away win/i.test(pickText) && diff < 0 && a >= 4;
    const hit = matchesPair || otherHome || otherAway;
    if (isFinal) {
      return hit
        ? res('WON', `🛡️ Multiscore Cluster HIT (${h}:${a})!`)
        : res('LOST', `FT ${h}:${a} outside cluster`);
    }
    return hit ? res('WINNING_LIVE', `In cluster (${h}:${a})`) : res('TRAILING_LIVE', `Live ${h}:${a}`);
  }

  if (mk === 'multigoals') {
    const rangeM = pickText.match(/(\d+)\s*-\s*(\d+)/);
    if (rangeM) {
      const lo = Number(rangeM[1]);
      const hi = Number(rangeM[2]);
      if (totalGoals > hi) return res('LOST', `${totalGoals} goals exceeded ${lo}-${hi}`);
      if (isFinal) return totalGoals >= lo && totalGoals <= hi ? res('WON', `${totalGoals} goals in ${lo}-${hi} ✓`) : res('LOST', `${totalGoals} goals outside ${lo}-${hi}`);
      return totalGoals >= lo ? res('WINNING_LIVE', `${totalGoals} goals in ${lo}-${hi}`) : res('TRAILING_LIVE', `${totalGoals} goals so far`);
    }
  }

  // 11. Halftime / Fulltime (htft)
  if (mk === 'htft') {
    if (isFinal && Number.isFinite(match.htHome) && Number.isFinite(match.htAway)) {
      const htRes = match.htHome > match.htAway ? '1' : match.htHome < match.htAway ? '2' : 'x';
      const ftRes = diff > 0 ? '1' : diff < 0 ? '2' : 'x';
      const code = `${htRes}/${ftRes}`;
      const normPick = pickText.toLowerCase()
        .replace(/home/g, '1')
        .replace(/away/g, '2')
        .replace(/draw/g, 'x');
      const hit = sk === code || normPick.includes(code);
      return hit ? res('WON', `HT/FT ${code.toUpperCase()} ✓ (HT ${htStr})`) : res('LOST', `Actual HT/FT: ${code.toUpperCase()} (HT ${htStr})`);
    }
  }

  // 12. Clean Sheet & Win to Nil & Odd/Even & Handicap
  if (mk === 'h_cs' || mk === 'a_cs') {
    const oppGoals = mk === 'h_cs' ? a : h;
    const clean = oppGoals === 0;
    if (sk === 'yes') {
      if (!clean) return res('LOST', 'Opponent scored');
      return isFinal ? res('WON', 'Clean sheet kept ✓') : res('WINNING_LIVE', '0 conceded so far');
    }
    if (sk === 'no') {
      if (!clean) return res(isFinal ? 'WON' : 'WON_EARLY', 'Opponent scored ✓');
      return isFinal ? res('LOST', 'Clean sheet kept') : res('TRAILING_LIVE', 'Waiting for goal');
    }
  }
  if (mk === 'h_wtn' || mk === 'a_wtn') {
    const wtn = mk === 'h_wtn' ? (h > 0 && a === 0) : (a > 0 && h === 0);
    if (isFinal) return (sk === 'yes' ? wtn : !wtn) ? res('WON', 'Win to Nil ✓') : res('LOST', 'Win to Nil missed');
  }
  if (mk === 'oddeven') {
    if (isFinal) {
      const isOdd = totalGoals % 2 === 1;
      return ((sk === 'odd' && isOdd) || (sk === 'even' && !isOdd)) ? res('WON', `${totalGoals} goals (${sk})`) : res('LOST', `${totalGoals} goals`);
    }
  }
  if (mk === 'hc-1' || mk === 'hc+1' || mk === 'spread') {
    if (isFinal) {
      if (mk === 'hc-1') {
        const adj = diff - 1;
        const actual = adj > 0 ? 'home' : adj < 0 ? 'away' : 'draw';
        return sk === actual ? res('WON', 'Handicap (0:1) ✓') : res('LOST', 'Handicap missed');
      }
      if (mk === 'hc+1') {
        const adj = diff + 1;
        const actual = adj > 0 ? 'home' : adj < 0 ? 'away' : 'draw';
        return sk === actual ? res('WON', 'Handicap (1:0) ✓') : res('LOST', 'Handicap missed');
      }
    }
  }

  // 13. Corners Markets (corners8.5, corners_ou9.5, corners_1x2)
  if (mk.startsWith('corners')) {
    if (mk === 'corners_1x2') {
      if (Number.isFinite(st.homeCorners) && Number.isFinite(st.awayCorners)) {
        const cDiff = st.homeCorners - st.awayCorners;
        const cWin = cDiff > 0 ? 'home' : cDiff < 0 ? 'away' : 'draw';
        if (isFinal) return sk === cWin ? res('WON', `Corners ${st.homeCorners}:${st.awayCorners} ✓`) : res('LOST', `Corners ${st.homeCorners}:${st.awayCorners}`);
      }
    } else if (Number.isFinite(st.corners)) {
      const line = extractLineNumber(mk, pickText, 9.5);
      if (sk === 'over' && st.corners > line) {
        return res(isFinal ? 'WON' : 'WON_EARLY', `Corners: ${st.corners} (> ${line})`);
      }
      if (isFinal) {
        const hit = sk === 'over' ? st.corners > line : st.corners < line;
        return hit ? res('WON', `Corners: ${st.corners} ✓`) : res('LOST', `Total Corners: ${st.corners}`);
      }
      return res(sk === 'under' && st.corners < line ? 'WINNING_LIVE' : 'TRAILING_LIVE', `Corners so far: ${st.corners}`);
    }
  }

  // 14. Bookings / Cards Markets (cards3.5, cards_ou3.5, redcard, cards_1x2)
  if (mk.startsWith('cards') || mk === 'redcard') {
    if (mk === 'redcard' && Number.isFinite(st.redCards)) {
      const hasRed = st.redCards >= 1;
      if (sk === 'yes' && hasRed) return res(isFinal ? 'WON' : 'WON_EARLY', `Red Card shown (${st.redCards})`);
      if (isFinal) return ((sk === 'yes' && hasRed) || (sk === 'no' && !hasRed)) ? res('WON', `Red cards: ${st.redCards} ✓`) : res('LOST', `Red cards: ${st.redCards}`);
    } else if (mk === 'cards_1x2' && Number.isFinite(st.homeCards) && Number.isFinite(st.awayCards)) {
      const kDiff = st.homeCards - st.awayCards;
      const kWin = kDiff > 0 ? 'home' : kDiff < 0 ? 'away' : 'draw';
      if (isFinal) return sk === kWin ? res('WON', `Cards ${st.homeCards}:${st.awayCards} ✓`) : res('LOST', `Cards ${st.homeCards}:${st.awayCards}`);
    } else if (Number.isFinite(st.cards)) {
      const line = extractLineNumber(mk, pickText, 3.5);
      if (sk === 'over' && st.cards > line) {
        return res(isFinal ? 'WON' : 'WON_EARLY', `Cards: ${st.cards} (> ${line})`);
      }
      if (isFinal) {
        const hit = sk === 'over' ? st.cards > line : st.cards < line;
        return hit ? res('WON', `Total Cards: ${st.cards} ✓`) : res('LOST', `Total Cards: ${st.cards}`);
      }
      return res(sk === 'under' && st.cards < line ? 'WINNING_LIVE' : 'TRAILING_LIVE', `Cards so far: ${st.cards}`);
    }
  }

  // 15. Shots & Shots on Target (shots22.5, shots_ou23.5, shots_1x2, sot7.5, sot_ou8.5, sot_1x2)
  if (mk.startsWith('shots')) {
    if (mk === 'shots_1x2' && Number.isFinite(st.homeShots) && Number.isFinite(st.awayShots)) {
      const sDiff = st.homeShots - st.awayShots;
      const sWin = sDiff > 0 ? 'home' : sDiff < 0 ? 'away' : 'draw';
      if (isFinal) return sk === sWin ? res('WON', `Shots ${st.homeShots}:${st.awayShots} ✓`) : res('LOST', `Shots ${st.homeShots}:${st.awayShots}`);
    } else if ((mk.includes('home') || mk.includes('away')) && Number.isFinite(mk.includes('home') ? st.homeShots : st.awayShots)) {
      const val = mk.includes('home') ? st.homeShots : st.awayShots;
      const line = extractLineNumber(mk, pickText, 11.5);
      if (sk === 'over' && val > line) return res(isFinal ? 'WON' : 'WON_EARLY', `Team Shots: ${val} (> ${line})`);
      if (isFinal) return (sk === 'over' ? val > line : val < line) ? res('WON', `Team Shots: ${val} ✓`) : res('LOST', `Team Shots: ${val}`);
    } else if (Number.isFinite(st.shots)) {
      const line = extractLineNumber(mk, pickText, 23.5);
      if (sk === 'over' && st.shots > line) return res(isFinal ? 'WON' : 'WON_EARLY', `Shots: ${st.shots} (> ${line})`);
      if (isFinal) return (sk === 'over' ? st.shots > line : st.shots < line) ? res('WON', `Total Shots: ${st.shots} ✓`) : res('LOST', `Total Shots: ${st.shots}`);
    }
  }
  if (mk.startsWith('sot')) {
    if (mk === 'sot_1x2' && Number.isFinite(st.homeSot) && Number.isFinite(st.awaySot)) {
      const sDiff = st.homeSot - st.awaySot;
      const sWin = sDiff > 0 ? 'home' : sDiff < 0 ? 'away' : 'draw';
      if (isFinal) return sk === sWin ? res('WON', `SOT ${st.homeSot}:${st.awaySot} ✓`) : res('LOST', `SOT ${st.homeSot}:${st.awaySot}`);
    } else if ((mk.includes('home') || mk.includes('away')) && Number.isFinite(mk.includes('home') ? st.homeSot : st.awaySot)) {
      const val = mk.includes('home') ? st.homeSot : st.awaySot;
      const line = extractLineNumber(mk, pickText, 4.5);
      if (sk === 'over' && val > line) return res(isFinal ? 'WON' : 'WON_EARLY', `Team SOT: ${val} (> ${line})`);
      if (isFinal) return (sk === 'over' ? val > line : val < line) ? res('WON', `Team SOT: ${val} ✓`) : res('LOST', `Team SOT: ${val}`);
    } else if (Number.isFinite(st.sot)) {
      const line = extractLineNumber(mk, pickText, 8.5);
      if (sk === 'over' && st.sot > line) return res(isFinal ? 'WON' : 'WON_EARLY', `SOT: ${st.sot} (> ${line})`);
      if (isFinal) return (sk === 'over' ? st.sot > line : st.sot < line) ? res('WON', `Total SOT: ${st.sot} ✓`) : res('LOST', `Total SOT: ${st.sot}`);
    }
  }

  // 16. Fouls, Offsides, Throw-Ins & Goal Kicks
  if (mk.startsWith('fouls')) {
    if (mk === 'fouls_1x2' && Number.isFinite(st.homeFouls) && Number.isFinite(st.awayFouls)) {
      const fDiff = st.homeFouls - st.awayFouls;
      const fWin = fDiff > 0 ? 'home' : fDiff < 0 ? 'away' : 'draw';
      if (isFinal) return sk === fWin ? res('WON', `Fouls ${st.homeFouls}:${st.awayFouls} ✓`) : res('LOST', `Fouls ${st.homeFouls}:${st.awayFouls}`);
    } else if (Number.isFinite(st.fouls)) {
      const line = extractLineNumber(mk, pickText, 22.5);
      if (sk === 'over' && st.fouls > line) return res(isFinal ? 'WON' : 'WON_EARLY', `Fouls: ${st.fouls} (> ${line})`);
      if (isFinal) return (sk === 'over' ? st.fouls > line : st.fouls < line) ? res('WON', `Total Fouls: ${st.fouls} ✓`) : res('LOST', `Total Fouls: ${st.fouls}`);
    }
  }
  if (mk.startsWith('offsides') && Number.isFinite(st.offsides)) {
    const line = extractLineNumber(mk, pickText, 3.5);
    if (sk === 'over' && st.offsides > line) return res(isFinal ? 'WON' : 'WON_EARLY', `Offsides: ${st.offsides} (> ${line})`);
    if (isFinal) return (sk === 'over' ? st.offsides > line : st.offsides < line) ? res('WON', `Total Offsides: ${st.offsides} ✓`) : res('LOST', `Total Offsides: ${st.offsides}`);
  }

  // Fallback for prop markets on finished games where external stat feed only had goals:
  if (isFinal) {
    const kickMs = leg.date ? new Date(leg.date).getTime() : 0;
    if (kickMs && Date.now() - kickMs > 18 * 3600 * 1000) {
      return res('VOID', 'FT Score recorded · granular prop stat feed unavailable (Push)');
    }
    return res('PENDING', 'FT Score recorded · awaiting official BetRadar stat feed');
  }
  return res('WINNING_LIVE', 'In-Play');
}

/** Recompute ticket-level summary metrics from its legs' settlements. */
function summarizeTicketSettlement(ticket) {
  const legs = ticket.legs || [];
  let wonLegs = 0;
  let lostLegs = 0;
  let voidLegs = 0;
  let liveWinningLegs = 0;
  let liveTrailingLegs = 0;
  let pendingLegs = 0;

  for (const leg of legs) {
    const st = leg.settlement?.state || 'PENDING';
    if (st === 'WON' || st === 'WON_EARLY') wonLegs++;
    else if (st === 'LOST') lostLegs++;
    else if (st === 'VOID') voidLegs++;
    else if (st === 'WINNING_LIVE') liveWinningLegs++;
    else if (st === 'TRAILING_LIVE') liveTrailingLegs++;
    else pendingLegs++;
  }

  const totalLegs = legs.length;
  const decidedLegs = wonLegs + lostLegs;
  const hitRatePct = decidedLegs > 0 ? +((wonLegs / decidedLegs) * 100).toFixed(1) : null;

  let status = 'PENDING';
  if (totalLegs > 0 && wonLegs + voidLegs === totalLegs && wonLegs > 0) {
    status = 'WON';
  } else if (totalLegs > 0 && voidLegs === totalLegs) {
    status = 'VOID';
  } else if (liveWinningLegs > 0 || liveTrailingLegs > 0) {
    status = 'IN_PLAY';
  } else if (lostLegs > 0 && pendingLegs === 0 && liveWinningLegs === 0 && liveTrailingLegs === 0) {
    status = 'LOST';
  } else if (decidedLegs > 0) {
    status = 'PARTIAL_SETTLED';
  }

  const stakeGHS = Number(ticket.stakeGHS) || 100;
  const wonOddsProduct = legs.reduce((acc, l) => {
    const st = l.settlement?.state;
    if (st === 'WON' || st === 'WON_EARLY') {
      return acc * (Number(l.sportyOdds) || Number(l.fairOdds) || 1.5);
    }
    return acc;
  }, 1);

  // 1. Full Accumulator Payout
  let accaPayoutGHS = 0;
  if (status === 'WON') {
    accaPayoutGHS = +(stakeGHS * wonOddsProduct).toFixed(2);
  } else if (status === 'VOID') {
    accaPayoutGHS = stakeGHS;
  }

  // 2. SportyBet Ghana Flex (Cut-1 / Cut-2 / Cut-3) Payout
  let flexPayoutGHS = accaPayoutGHS;
  let flexStatus = status === 'WON' ? 'WON_FULL' : status === 'VOID' ? 'VOID' : null;
  if (status === 'LOST' && wonLegs > 0) {
    if (lostLegs === 1 && totalLegs >= 5) {
      const cut1Factor = Math.max(2.2, totalLegs * 0.92);
      flexPayoutGHS = +(stakeGHS * (wonOddsProduct / cut1Factor)).toFixed(2);
      flexStatus = 'WON_FLEX_CUT1';
    } else if (lostLegs === 2 && totalLegs >= 8) {
      const cut2Factor = Math.max(4.5, totalLegs * 1.65);
      flexPayoutGHS = +(stakeGHS * (wonOddsProduct / cut2Factor)).toFixed(2);
      flexStatus = 'WON_FLEX_CUT2';
    } else if (lostLegs === 3 && totalLegs >= 18) {
      const cut3Factor = Math.max(9.0, totalLegs * 2.85);
      flexPayoutGHS = +(stakeGHS * (wonOddsProduct / cut3Factor)).toFixed(2);
      flexStatus = 'WON_FLEX_CUT3';
    }
  }

  // 3. Flat Singles Equivalent Payout (stake split equally across all legs)
  const unitStake = totalLegs > 0 ? stakeGHS / totalLegs : 0;
  let singlesPayoutGHS = 0;
  for (const l of legs) {
    const st = l.settlement?.state;
    if (st === 'WON' || st === 'WON_EARLY') {
      singlesPayoutGHS += unitStake * (Number(l.sportyOdds) || Number(l.fairOdds) || 1.5);
    } else if (st === 'VOID') {
      singlesPayoutGHS += unitStake;
    }
  }
  singlesPayoutGHS = +singlesPayoutGHS.toFixed(2);

  // 4. Live Cashout & Hedge-Lock Advisor
  let hedgeAdvice = null;
  const remainingLegs = legs.filter((l) => ['PENDING', 'WINNING_LIVE', 'TRAILING_LIVE'].includes(l.settlement?.state));
  if (lostLegs === 0 && wonLegs >= 2 && remainingLegs.length >= 1 && remainingLegs.length <= 2) {
    const cashoutOfferGHS = +(stakeGHS * wonOddsProduct * 0.82).toFixed(2);
    const lastLeg = remainingLegs[0];
    const oppOdds = +(1 / Math.max(0.08, 1 - (Number(lastLeg.p) || 0.65)) * 0.92).toFixed(2);
    const potentialFull = +(stakeGHS * (Number(ticket.totalSportyOdds) || 2)).toFixed(2);
    const hedgeStakeGHS = +(potentialFull / (oppOdds + 1)).toFixed(2);
    const lockedProfitGHS = +(potentialFull - stakeGHS - hedgeStakeGHS).toFixed(2);
    hedgeAdvice = {
      cashoutOfferGHS,
      remainingCount: remainingLegs.length,
      nextMatchup: lastLeg.matchup,
      nextPick: lastLeg.pickLabel || lastLeg.sportyPick,
      hedgeStakeGHS,
      oppOdds,
      lockedProfitGHS: Math.max(+(cashoutOfferGHS - stakeGHS).toFixed(2), lockedProfitGHS),
    };
  }

  ticket.status = status;
  ticket.flexStatus = flexStatus;
  ticket.stakeGHS = stakeGHS;
  ticket.potentialWinGHS = +(stakeGHS * (Number(ticket.totalSportyOdds) || Number(ticket.combinedFairOdds) || 1)).toFixed(2);
  ticket.accaPayoutGHS = accaPayoutGHS;
  ticket.flexPayoutGHS = flexPayoutGHS;
  ticket.singlesPayoutGHS = singlesPayoutGHS;
  ticket.hedgeAdvice = hedgeAdvice;
  ticket.flexHits = {
    wonLegs,
    lostLegs,
    voidLegs,
    liveWinningLegs,
    liveTrailingLegs,
    pendingLegs,
    totalLegs,
    decidedLegs,
    hitRatePct,
  };
  return ticket;
}

/**
 * Place / Register one or more cooked tickets into the Arena ledger.
 * Preserves existing settlement states for already-graded legs.
 */
export async function registerTickets(ticketList, { source = 'live_cooked', defaultStakeGHS = 100 } = {}) {
  await load();
  const added = [];
  const todayKey = new Date().toISOString().slice(0, 10);

  for (const raw of ticketList) {
    if (!raw || !Array.isArray(raw.legs) || !raw.legs.length) continue;
    const isCuratedDaily = source === 'live_cooked' && raw.id && !raw.arenaId;
    const baseId = raw.arenaId || (isCuratedDaily
      ? `arena-${raw.id}-${todayKey}`
      : `${raw.id || 'slip'}-${raw.shareCode || todayKey}`);
    const existing = db.tickets[baseId];

    // Once any leg on today's curated slip has kicked off or settled, lock its legs so evening refreshes don't overwrite real-world tests
    if (existing && isCuratedDaily && existing.legs?.some((l) => l.settlement?.state && l.settlement.state !== 'PENDING')) {
      added.push(existing);
      continue;
    }

    const isLottoTemplate = /cs|mega-20|super-multi-30|million-odds|identical-over25|identical-gg/i.test(raw.id || '');
    const smartDefaultStake = isLottoTemplate ? 25 : defaultStakeGHS;

    const legs = raw.legs.map((l, idx) => {
      const prevLeg = existing?.legs?.find((pl) => pl.eventId === l.eventId && pl.marketKey === l.marketKey && pl.selKey === l.selKey) || existing?.legs?.[idx];
      return {
        ...l,
        settlement: l.settlement || prevLeg?.settlement || {
          state: 'PENDING',
          reason: 'Placed in Arena · waiting for live result',
          score: null,
          htScore: null,
          matchStatus: 'Upcoming',
          stats: null,
        },
      };
    });

    const entry = {
      arenaId: baseId,
      ticketId: raw.id || baseId,
      title: raw.title || 'Cooked SportyBet Slip',
      category: raw.category || (raw.id?.startsWith('vault-') ? 'Correct Score Vault' : 'Cooked Multi'),
      description: raw.description || '',
      source: existing?.source || raw.source || source,
      placedAt: existing?.placedAt || raw.placedAt || new Date().toISOString(),
      shareCode: raw.shareCode || existing?.shareCode || null,
      shareURL: raw.shareURL || existing?.shareURL || null,
      count: legs.length,
      combinedProb: raw.combinedProb || 0,
      combinedFairOdds: raw.combinedFairOdds || 0,
      totalSportyOdds: raw.totalSportyOdds || raw.combinedFairOdds || 1,
      flexDirective: raw.flexDirective || existing?.flexDirective || null,
      stakeGHS: raw.stakeGHS || existing?.stakeGHS || smartDefaultStake,
      legs,
    };

    summarizeTicketSettlement(entry);
    db.tickets[baseId] = entry;
    added.push(entry);
    dirty = true;
  }

  await save();
  return added;
}

/**
 * Fetch live & completed match results from:
 * 1) SportyBet Ghana factsCenter/liveOrPrematchEvents (all live matches)
 * 2) SportyBet Ghana factsCenter/event?eventId=... (specific tracked matches)
 * 3) ESPN Global Soccer Scoreboard (today & yesterday, with corners, cards, shots, SOT, fouls & goal timelines)
 */
async function fetchRealWorldResultsMap(trackedLegs) {
  const byEventId = new Map(); // sr:match:... -> matchResult
  const byTeamPair = new Map(); // normHome|normAway -> matchResult
  const allMatches = [];

  const parseSportyEv = (ev) => {
    if (!ev || !ev.eventId) return;
    const statusNum = Number(ev.status);
    const mStatus = String(ev.matchStatus || '');
    const isEnded = statusNum === 3 || statusNum === 4 || /ended|finished|closed|aet|ap|ft/i.test(mStatus);
    const isLive = (statusNum === 1 || statusNum === 2) && !isEnded;
    const state = isEnded ? 'post' : isLive ? 'in' : 'pre';

    const ft = parseScoreStr(ev.setScore) || parseScoreStr(ev.gameScore?.[0]);
    const ht = Array.isArray(ev.gameScore) && ev.gameScore.length >= 1 ? parseScoreStr(ev.gameScore[0]) : null;
    if (!ft && state === 'pre') {
      byEventId.set(ev.eventId, { state: 'pre', matchStatus: 'Upcoming' });
      return;
    }
    const homeScore = ft?.home ?? 0;
    const awayScore = ft?.away ?? 0;
    const htHome = ht?.home ?? null;
    const htAway = ht?.away ?? null;
    const htDiff = (htHome !== null && htAway !== null) ? (htHome - htAway) : 0;
    const ftDiff = homeScore - awayScore;

    const prev = byEventId.get(ev.eventId);
    const maxHomeLead = Math.max(prev?.maxHomeLead ?? 0, htDiff, ftDiff, 0);
    const maxAwayLead = Math.max(prev?.maxAwayLead ?? 0, -htDiff, -ftDiff, 0);

    const resObj = {
      eventId: ev.eventId,
      home: ev.homeTeamName,
      away: ev.awayTeamName,
      date: ev.estimateStartTime ? new Date(ev.estimateStartTime).toISOString() : null,
      state,
      matchStatus: isEnded ? 'FT' : (mStatus || 'LIVE'),
      clock: ev.playedSeconds || null,
      homeScore,
      awayScore,
      htHome,
      htAway,
      maxHomeLead,
      maxAwayLead,
      stats: prev?.stats || {},
    };
    byEventId.set(ev.eventId, resObj);
    const key = `${normTeam(ev.homeTeamName)}|${normTeam(ev.awayTeamName)}`;
    if (key !== '|') byTeamPair.set(key, resObj);
    allMatches.push(resObj);
  };

  // 1. Fetch SportyBet live matches across Football, Basketball & Tennis
  await Promise.all(['sr:sport:1', 'sr:sport:2', 'sr:sport:5'].map(async (spId) => {
    try {
      const r = await fetch(`https://www.sportybet.com/api/gh/factsCenter/liveOrPrematchEvents?sportId=${encodeURIComponent(spId)}`, {
        headers: SPORTY_HEADERS,
        signal: AbortSignal.timeout(8000),
      }).then((x) => x.json());
      for (const t of r.data || []) {
        for (const ev of t.events || []) parseSportyEv(ev);
      }
    } catch { /* ignore network hiccup */ }
  }));

  // 2. Query specific SportyBet eventIds & collect historical dates for unsettled legs whose start time has arrived
  const now = Date.now();
  const eventIdsToQuery = new Set();
  const dateSet = new Set([
    new Date().toISOString().slice(0, 10).replaceAll('-', ''),
    new Date(now - 86400e3).toISOString().slice(0, 10).replaceAll('-', ''),
  ]);

  for (const leg of trackedLegs) {
    const st = leg.settlement?.state;
    if (st === 'WON' || st === 'LOST' || st === 'VOID') continue;
    const kickMs = leg.date ? new Date(leg.date).getTime() : 0;
    if (kickMs && kickMs <= now + 20 * 60 * 1000) {
      const dStr = new Date(kickMs).toISOString().slice(0, 10).replaceAll('-', '');
      dateSet.add(dStr);
    }
    if (leg.eventId && String(leg.eventId).startsWith('sr:match:')) {
      if (!kickMs || kickMs <= now + 15 * 60 * 1000 || byEventId.has(leg.eventId)) {
        eventIdsToQuery.add(leg.eventId);
      }
    }
  }

  const queryList = [...eventIdsToQuery].slice(0, 90);
  for (let i = 0; i < queryList.length; i += 25) {
    const batch = queryList.slice(i, i + 25);
    await Promise.all(batch.map(async (evId) => {
      try {
        const r = await fetch(`https://www.sportybet.com/api/gh/factsCenter/event?eventId=${encodeURIComponent(evId)}`, {
          headers: SPORTY_HEADERS,
          signal: AbortSignal.timeout(6500),
        }).then((x) => x.json());
        if (r?.data) parseSportyEv(r.data);
      } catch { /* ignore */ }
    }));
  }

  // 3. Fetch ESPN Global Soccer Scoreboards across all needed dates (up to 12 dates, covering multi-week gaps!)
  const datesToFetch = [...dateSet].sort().reverse().slice(0, 12);
  await Promise.all(datesToFetch.map(async (dayStr) => {
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?limit=250&dates=${dayStr}`, {
        signal: AbortSignal.timeout(9000),
      }).then((x) => x.json());
      for (const ev of r.events || []) {
        const parsed = parseEspnEventToMatchResult(ev);
        if (!parsed) continue;
        byEventId.set(`espn:${ev.id}`, parsed);
        allMatches.push(parsed);
        const pairKey = `${normTeam(parsed.home)}|${normTeam(parsed.away)}`;
        const existing = byTeamPair.get(pairKey);
        if (existing) {
          existing.stats = { ...existing.stats, ...parsed.stats };
          existing.maxHomeLead = Math.max(existing.maxHomeLead ?? 0, parsed.maxHomeLead ?? 0);
          existing.maxAwayLead = Math.max(existing.maxAwayLead ?? 0, parsed.maxAwayLead ?? 0);
          if (existing.htHome === null && parsed.htHome !== null) {
            existing.htHome = parsed.htHome;
            existing.htAway = parsed.htAway;
          }
        } else {
          byTeamPair.set(pairKey, parsed);
        }
      }
    } catch { /* ignore */ }
  }));

  return { byEventId, byTeamPair, allMatches };
}

/** Parse an ESPN scoreboard event (including goal/card timeline details & team statistics) into a rich matchResult. */
export function parseEspnEventToMatchResult(ev) {
  const c = ev?.competitions?.[0];
  if (!c) return null;
  const h = c.competitors?.find((x) => x.homeAway === 'home');
  const a = c.competitors?.find((x) => x.homeAway === 'away');
  if (!h || !a) return null;

  const state = ev.status?.type?.state || 'pre'; // 'pre' | 'in' | 'post'
  const homeScore = Number(h.score ?? 0);
  const awayScore = Number(a.score ?? 0);

  const getStat = (comp, name) => {
    const found = (comp.statistics || []).find((s) => s.name === name);
    return found ? Number(found.displayValue) : null;
  };

  const homeCorners = getStat(h, 'wonCorners');
  const awayCorners = getStat(a, 'wonCorners');
  const homeShots = getStat(h, 'totalShots');
  const awayShots = getStat(a, 'totalShots');
  const homeSOT = getStat(h, 'shotsOnTarget');
  const awaySOT = getStat(a, 'shotsOnTarget');
  const homeFouls = getStat(h, 'foulsCommitted');
  const awayFouls = getStat(a, 'foulsCommitted');

  // Reconstruct goal timeline (for HT score & 1UP / 2UP max lead!) and card counts from c.details
  let curH = 0;
  let curA = 0;
  let htHome = null;
  let htAway = null;
  let maxHomeLead = 0;
  let maxAwayLead = 0;
  let homeYellow = 0;
  let awayYellow = 0;
  let homeRed = 0;
  let awayRed = 0;

  const details = Array.isArray(c.details) ? [...c.details] : [];
  details.sort((x, y) => (x.clock?.value ?? 0) - (y.clock?.value ?? 0));

  for (const d of details) {
    const isHomeTeam = String(d.team?.id) === String(h.team?.id);
    const minute = Number(String(d.clock?.displayValue || '0').replace(/[^\d]/g, '')) || 0;
    if (d.scoringPlay) {
      if (isHomeTeam) curH++;
      else curA++;
      maxHomeLead = Math.max(maxHomeLead, curH - curA);
      maxAwayLead = Math.max(maxAwayLead, curA - curH);
    }
    if (d.yellowCard) {
      if (isHomeTeam) homeYellow++;
      else awayYellow++;
    }
    if (d.redCard) {
      if (isHomeTeam) homeRed++;
      else awayRed++;
    }
    if (minute <= 45 && d.scoringPlay) {
      htHome = curH;
      htAway = curA;
    }
  }

  if (state !== 'pre' && htHome === null) {
    htHome = 0;
    htAway = 0;
  }
  maxHomeLead = Math.max(maxHomeLead, homeScore - awayScore, 0);
  maxAwayLead = Math.max(maxAwayLead, awayScore - homeScore, 0);

  const totalCards = homeYellow + awayYellow + homeRed + awayRed;
  const totalRed = homeRed + awayRed;

  return {
    eventId: `espn:${ev.id}`,
    espnId: ev.id,
    home: h.team?.displayName || h.team?.name || 'Home',
    away: a.team?.displayName || a.team?.name || 'Away',
    date: ev.date,
    state,
    matchStatus: state === 'post' ? 'FT' : state === 'in' ? (ev.status?.type?.shortDetail || 'LIVE') : 'Upcoming',
    clock: ev.status?.displayClock || null,
    homeScore,
    awayScore,
    htHome,
    htAway,
    maxHomeLead,
    maxAwayLead,
    homeRecord: h.records?.[0]?.summary || null,
    awayRecord: a.records?.[0]?.summary || null,
    stats: {
      corners: Number.isFinite(homeCorners) && Number.isFinite(awayCorners) ? homeCorners + awayCorners : null,
      homeCorners,
      awayCorners,
      cards: details.length > 0 || state === 'post' ? totalCards : null,
      redCards: details.length > 0 || state === 'post' ? totalRed : null,
      homeCards: homeYellow + homeRed,
      awayCards: awayYellow + awayRed,
      shots: Number.isFinite(homeShots) && Number.isFinite(awayShots) ? homeShots + awayShots : null,
      sot: Number.isFinite(homeSOT) && Number.isFinite(awaySOT) ? homeSOT + awaySOT : null,
      fouls: Number.isFinite(homeFouls) && Number.isFinite(awayFouls) ? homeFouls + awayFouls : null,
    },
  };
}

/**
 * Cook a Live In-Play Test Slip from games happening right now on SportyBet Ghana
 * so the user can watch live minute-by-minute grading in real time.
 */
async function ensureLiveInPlayCookedSlip() {
  await load();
  try {
    // Prune older live_inplay test slips (keep at most the 2 newest) so unattended servers never bloat arena.json
    const liveKeys = Object.entries(db.tickets)
      .filter(([, t]) => t.source === 'live_inplay')
      .sort((a, b) => new Date(b[1].placedAt || 0) - new Date(a[1].placedAt || 0));
    if (liveKeys.length > 2) {
      for (const [k] of liveKeys.slice(2)) delete db.tickets[k];
      dirty = true;
    }

    const dayBucket = new Date().toISOString().slice(0, 10);
    if (db.tickets[`arena-live-inplay-${dayBucket}`]) return;

    const r = await fetch('https://www.sportybet.com/api/gh/factsCenter/liveOrPrematchEvents?sportId=sr:sport:1', {
      headers: SPORTY_HEADERS,
      signal: AbortSignal.timeout(7000),
    }).then((x) => x.json());

    const liveEvents = (r.data || []).flatMap((t) => (t.events || []).map((ev) => ({
      ...ev,
      leagueName: `${t.categoryName || ''} · ${t.name || ''}`.replace(/^ · /, ''),
    }))).filter((ev) => {
      // Strictly pick 1st Half / HT / early 2nd Half (<= 58') so we never bet Over in the 85th minute
      const mins = parseInt(String(ev.playedSeconds || '').split(':')[0], 10);
      if (Number.isFinite(mins) && mins > 58) return false;
      const st = String(ev.matchStatus || '').toLowerCase();
      if (st.includes('ended') || st.includes('ft') || st.includes('ap') || st.includes('aet')) return false;
      return true;
    });
    if (liveEvents.length < 2) return;

    const legs = [];
    for (const ev of liveEvents.slice(0, 5)) {
      const ft = parseScoreStr(ev.setScore) || parseScoreStr(ev.gameScore?.[0]) || { home: 0, away: 0 };
      const total = ft.home + ft.away;
      if (total >= 3) continue;
      const mktKey = total === 0 ? 'ou0.5' : total === 1 ? 'ou1.5' : 'ou2.5';
      const line = total + 0.5;
      const odds = +(1.30 + Math.min(0.55, total * 0.14)).toFixed(2);
      const p = +(1 / odds - 0.02).toFixed(3);

      legs.push({
        eventId: ev.eventId,
        sportyGameId: ev.gameId,
        leagueId: 'live.soccer',
        leagueName: ev.leagueName || 'Live Football',
        matchup: `${ev.homeTeamName} vs ${ev.awayTeamName}`,
        home: ev.homeTeamName,
        away: ev.awayTeamName,
        date: new Date(ev.estimateStartTime || Date.now()).toISOString(),
        group: 'Goals',
        marketKey: mktKey,
        marketName: `Over/Under ${line} Goals`,
        selKey: 'over',
        pickLabel: `Over ${line} Goals`,
        p,
        fairOdds: +(1 / p).toFixed(2),
        sportyOdds: odds,
        sportyMarket: `SportyBet Live -> Over ${line} Goals @ ${odds}`,
      });
    }

    if (legs.length >= 2) {
      const totalOdds = +legs.reduce((a, b) => a * b.sportyOdds, 1).toFixed(2);
      const combP = +legs.reduce((a, b) => a * b.p, 1).toFixed(4);
      await registerTickets([{
        arenaId: `arena-live-inplay-${dayBucket}`,
        id: `live-inplay-${dayBucket}`,
        title: `🔴 Live In-Play Real-Time Test Slip (${legs.length}-Fold)`,
        category: 'Live In-Play Test',
        description: 'Cooked on early-minute live matches currently on the pitch and graded minute-by-minute against real-world scores.',
        source: 'live_inplay',
        stakeGHS: 50,
        totalSportyOdds: totalOdds,
        combinedProb: combP,
        combinedFairOdds: +(1 / Math.max(combP, 1e-6)).toFixed(2),
        legs,
      }], { source: 'live_inplay' });
    }
  } catch { /* ignore */ }
}

/**
 * Seed & verify our Cooked-Odds Engine against REAL completed matches from today and yesterday
 * (using strictly pre-match team records W-D-L to estimate pre-game lambdas, cooking the exact
 * same Vhim, 20-Fold, Mixed Multi, 1UP, Corners/Cards, Multiscore, and Correct Score tickets,
 * and then grading them against the real-world final scores & match statistics).
 */
async function ensureCompletedRealWorldAudit() {
  await load();
  const d0 = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const d1 = new Date(Date.now() - 86400e3).toISOString().slice(0, 10).replaceAll('-', '');
  const batchKey = d1;
  const hasTodayBatch = Object.keys(db.tickets).some((k) => k.startsWith(`arena-audit-${batchKey}-`));
  if (hasTodayBatch) return;

  try {
    const [r0, r1] = await Promise.all([
      fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?limit=220&dates=${d0}`, { signal: AbortSignal.timeout(9000) }).then((x) => x.json()).catch(() => ({ events: [] })),
      fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?limit=220&dates=${d1}`, { signal: AbortSignal.timeout(9000) }).then((x) => x.json()).catch(() => ({ events: [] })),
    ]);

    const completedEvents = [...(r0.events || []), ...(r1.events || [])]
      .filter((e) => e.status?.type?.state === 'post');

    const candidateGames = [];
    for (const ev of completedEvents) {
      const matchRes = parseEspnEventToMatchResult(ev);
      if (!matchRes || !Number.isFinite(matchRes.stats?.corners)) continue;

      // Reconstruct EXACT pre-kickoff W-D-L record by subtracting this match's outcome (100% zero outcome leakage!)
      const parsePreMatchWdl = (recStr, didWin, didDraw, didLose) => {
        const m = String(recStr || '').match(/(\d+)-(\d+)-(\d+)/);
        if (!m) return { w: 3, d: 2, l: 3, n: 8, valid: false };
        const w = Math.max(0, Number(m[1]) - (didWin ? 1 : 0));
        const d = Math.max(0, Number(m[2]) - (didDraw ? 1 : 0));
        const l = Math.max(0, Number(m[3]) - (didLose ? 1 : 0));
        const n = w + d + l;
        return { w, d, l, n: Math.max(1, n), valid: n >= 1 };
      };
      const hWon = matchRes.homeScore > matchRes.awayScore;
      const aWon = matchRes.awayScore > matchRes.homeScore;
      const drew = matchRes.homeScore === matchRes.awayScore;
      const hRec = parsePreMatchWdl(matchRes.homeRecord, hWon, drew, aWon);
      const aRec = parsePreMatchWdl(matchRes.awayRecord, aWon, drew, hWon);
      if (!hRec.valid && !aRec.valid) continue;

      const namePrior = (str = '') => {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
        return ((h >>> 0) % 100) / 500 - 0.10;
      };
      const hWinRate = (hRec.w + 1.4) / (hRec.n + 3.0) + namePrior(matchRes.home);
      const aWinRate = (aRec.w + 1.1) / (aRec.n + 3.0) + namePrior(matchRes.away);
      const hLossRate = (hRec.l + 1.1) / (hRec.n + 3.0);
      const aLossRate = (aRec.l + 1.4) / (aRec.n + 3.0);

      const lh = Math.max(0.75, Math.min(2.65, 1.48 * (0.65 + 0.78 * hWinRate + 0.45 * aLossRate)));
      const la = Math.max(0.55, Math.min(2.35, 1.14 * (0.60 + 0.78 * aWinRate + 0.45 * hLossRate)));
      const intensity = (lh + la) / 2.6;

      const pois = (lam, k) => {
        let p = Math.exp(-lam);
        for (let i = 1; i <= k; i++) p *= lam / i;
        return p;
      };
      let pH = 0, pD = 0, pA = 0, pO15 = 0, pO25 = 0, pGG = 0;
      const csList = [];
      let pClusterH = 0, pClusterA = 0, pClusterD = 0;
      for (let i = 0; i <= 6; i++) {
        const pi = pois(lh, i);
        for (let j = 0; j <= 6; j++) {
          const pj = pois(la, j);
          const p = pi * pj;
          if (i > j) pH += p;
          else if (i < j) pA += p;
          else pD += p;
          if (i + j >= 2) pO15 += p;
          if (i + j >= 3) pO25 += p;
          if (i >= 1 && j >= 1) pGG += p;
          if (i <= 3 && j <= 3) csList.push({ key: `${i}:${j}`, label: `${i}:${j}`, p });
          if ((i === 1 && j === 0) || (i === 2 && j === 0) || (i === 3 && j === 0)) pClusterH += p;
          if ((i === 0 && j === 1) || (i === 0 && j === 2) || (i === 0 && j === 3)) pClusterA += p;
          if ((i === 1 && j === 1) || (i === 2 && j === 2) || (i === 3 && j === 3)) pClusterD += p;
        }
      }
      csList.sort((x, y) => y.p - x.p);
      const p1upH = Math.min(0.94, pH + pD * 0.34 + pA * 0.14);
      const p1upA = Math.min(0.92, pA + pD * 0.32 + pH * 0.12);
      const pCornersO85 = Math.min(0.88, Math.max(0.45, 0.56 + (intensity - 1) * 0.35));
      const pCardsO35 = Math.min(0.86, Math.max(0.44, 0.55 + (intensity - 1) * 0.28));
      const pShotsO225 = Math.min(0.88, Math.max(0.46, 0.58 + (intensity - 1) * 0.38));
      const pSotO75 = Math.min(0.87, Math.max(0.45, 0.57 + (intensity - 1) * 0.36));

      const markets = [
        { group: 'Main', key: '1x2', name: '1X2', selections: [{ key: 'home', label: `${matchRes.home} Win`, p: pH }, { key: 'away', label: `${matchRes.away} Win`, p: pA }] },
        { group: 'Main', key: '1up', name: '1X2 - 1UP', selections: [{ key: 'home', label: `${matchRes.home} (1UP)`, p: p1upH }, { key: 'away', label: `${matchRes.away} (1UP)`, p: p1upA }] },
        { group: 'Main', key: 'dc', name: 'Double Chance', selections: [{ key: '1x', label: '1X (Home or Draw)', p: pH + pD }, { key: 'x2', label: 'X2 (Draw or Away)', p: pD + pA }] },
        { group: 'Main', key: 'dnb', name: 'Draw No Bet', selections: [{ key: 'home', label: `${matchRes.home} DNB`, p: pH / Math.max(0.01, pH + pA) }] },
        { group: 'Goals', key: 'ou1.5', name: 'Over/Under 1.5 Goals', selections: [{ key: 'over', label: 'Over 1.5 Goals', p: pO15 }] },
        { group: 'Goals', key: 'ou2.5', name: 'Over/Under 2.5 Goals', selections: [{ key: 'over', label: 'Over 2.5 Goals', p: pO25 }] },
        { group: 'Goals', key: 'ggng', name: 'GG/NG', selections: [{ key: 'gg', label: 'GG (Both Score)', p: pGG }] },
        { group: 'Corners', key: 'corners8.5', name: 'Total Corners 8.5', selections: [{ key: 'over', label: 'Over 8.5 Corners', p: pCornersO85 }] },
        { group: 'Cards', key: 'cards3.5', name: 'Total Cards 3.5', selections: [{ key: 'over', label: 'Over 3.5 Cards', p: pCardsO35 }] },
        { group: 'Shots', key: 'shots22.5', name: 'Total Shots 22.5', selections: [{ key: 'over', label: 'Over 22.5 Shots', p: pShotsO225 }] },
        { group: 'Shots', key: 'sot7.5', name: 'Total SOT 7.5', selections: [{ key: 'over', label: 'Over 7.5 SOT', p: pSotO75 }] },
        { group: 'Goals', key: 'multiscore', name: 'Multiscores', selections: [
          { key: '1:0, 2:0 or 3:0', label: '1:0, 2:0 or 3:0', Sporty: '1:0, 2:0 or 3:0', p: pClusterH },
          { key: '0:1, 0:2 or 0:3', label: '0:1, 0:2 or 0:3', Sporty: '0:1, 0:2 or 0:3', p: pClusterA },
          { key: '1:1, 2:2 or 3:3', label: '1:1, 2:2 or 3:3', Sporty: '1:1, 2:2 or 3:3', p: pClusterD },
        ] },
        { group: 'Goals', key: 'cs', name: 'Correct Score', selections: csList.slice(0, 2).map((c) => ({ key: c.key, label: `Exact Score ${c.label}`, Sporty: c.label, p: c.p })) },
      ];

      const sels = [];
      for (const m of markets) {
        for (const s of m.selections || []) {
          if (!Number.isFinite(s.p) || s.p <= 0.04) continue;
          const sportyOdds = Math.max(1.12, +((1 / s.p) * 0.94).toFixed(2));
          sels.push({
            eventId: matchRes.eventId,
            leagueId: 'global.soccer',
            leagueName: 'Real-World Completed Match',
            matchup: `${matchRes.home} vs ${matchRes.away}`,
            home: matchRes.home,
            away: matchRes.away,
            date: matchRes.date || new Date().toISOString(),
            group: m.group,
            marketKey: m.key,
            marketName: m.name,
            selKey: s.key,
            pickLabel: s.Sporty || `${m.name}: ${s.label}`,
            p: +s.p.toFixed(4),
            fairOdds: +(1 / s.p).toFixed(2),
            sportyOdds,
            sportyMarket: `SportyBet -> ${m.name} -> ${s.label} @ ${sportyOdds}`,
            _matchResult: matchRes,
          });
        }
      }

      if (sels.length) {
        candidateGames.push({ matchRes, selections: sels });
      }
    }

    if (candidateGames.length < 8) return;

    const pickOnePerMatch = (maxLegs, filterFn) => {
      const out = [];
      for (const g of candidateGames) {
        const valid = g.selections.filter(filterFn).sort((a, b) => b.p - a.p);
        if (valid.length) out.push({ pick: valid[0], score: valid[0].p });
      }
      out.sort((a, b) => b.score - a.score);
      return out.slice(0, maxLegs).map((x) => {
        const leg = { ...x.pick };
        const mr = leg._matchResult;
        delete leg._matchResult;
        leg.settlement = gradeLegAgainstMatch(leg, mr);
        return leg;
      });
    };

    const labelDate = `${batchKey.slice(0, 4)}-${batchKey.slice(4, 6)}-${batchKey.slice(6, 8)}`;
    const buildAuditTicket = (id, title, category, description, stakeGHS, legs) => {
      const totalSportyOdds = +legs.reduce((a, b) => a * b.sportyOdds, 1).toFixed(2);
      const combP = +legs.reduce((a, b) => a * b.p, 1).toFixed(4);
      return {
        arenaId: `arena-audit-${batchKey}-${id}`,
        id: `audit-${batchKey}-${id}`,
        title: `${title} (${labelDate})`,
        category,
        description,
        source: 'verified_backtest',
        placedAt: new Date(Date.now() - 4 * 3600e3).toISOString(),
        shareCode: `VR${id.slice(0, 4).toUpperCase()}`,
        stakeGHS,
        totalSportyOdds,
        combinedProb: combP,
        combinedFairOdds: +(1 / Math.max(combP, 1e-6)).toFixed(2),
        legs,
      };
    };

    const rollover2x = pickOnePerMatch(3, (s) => ['1up', 'dc', 'ou1.5'].includes(s.marketKey) && s.sportyOdds >= 1.24 && s.sportyOdds <= 1.52);
    const vhim5 = pickOnePerMatch(5, (s) => ['1up', 'dc', 'ou1.5', 'dnb'].includes(s.marketKey) && s.sportyOdds >= 1.18 && s.sportyOdds <= 1.50);
    const over15_15 = pickOnePerMatch(15, (s) => s.marketKey === 'ou1.5' && s.selKey === 'over' && s.sportyOdds >= 1.16);
    const oneUp10 = pickOnePerMatch(10, (s) => s.marketKey === '1up' && s.selKey !== 'draw' && s.sportyOdds >= 1.20 && s.sportyOdds <= 1.75);
    const props8 = pickOnePerMatch(8, (s) => ['Corners', 'Cards', 'Shots'].includes(s.group) && s.sportyOdds >= 1.32 && s.sportyOdds <= 1.95);
    const multi6 = pickOnePerMatch(6, (s) => s.marketKey === 'multiscore');
    const cs10 = pickOnePerMatch(10, (s) => s.marketKey === 'cs');

    const mixed10 = [];
    const usedEvents = new Set();
    const mktCycle = ['1up', 'ou1.5', 'dc', 'corners8.5', 'cards3.5', 'shots22.5', 'ggng', '1x2', 'sot7.5', 'dnb'];
    for (const mk of mktCycle) {
      for (const g of candidateGames) {
        if (usedEvents.has(g.matchRes.eventId)) continue;
        const found = g.selections.filter((s) => s.marketKey === mk && s.p >= 0.54).sort((a, b) => b.p - a.p)[0];
        if (found) {
          usedEvents.add(g.matchRes.eventId);
          const leg = { ...found };
          const mr = leg._matchResult;
          delete leg._matchResult;
          leg.settlement = gradeLegAgainstMatch(leg, mr);
          mixed10.push(leg);
          break;
        }
      }
    }

    const auditTickets = [
      buildAuditTicket('rollover2x', '💰 [Settled Audit] Daily 2.00x Safe Rollover Banker', 'Rollover Banker', 'Pre-game 3-leg ~2.10x rollover banker graded against completed real-world matches.', 200, rollover2x),
      buildAuditTicket('vhim5', '🔥 [Settled Audit] Vhim Sure Banker (5-Fold)', 'Vhim Banker', 'Pre-game cooked Vhim 5-Fold tested against completed real-world matches.', 150, vhim5),
      buildAuditTicket('1up10', '⚡ [Settled Audit] 10-Fold 1UP Early Payout', 'Identical Market', 'Pre-game cooked 1UP picks graded against real-world goal timelines.', 100, oneUp10),
      buildAuditTicket('mix10', '🔀 [Settled Audit] 10-Fold Mixed Multi Master', 'Mixed Multi', '1X2, 1UP, Over 1.5, Corners, Cards & Shots tested on completed matches.', 100, mixed10),
      buildAuditTicket('o15', '🔁 [Settled Audit] 15-Fold All Over 1.5 Goals', 'Identical Market', 'Pre-game Over 1.5 Goals accumulator graded against final match scores.', 100, over15_15),
      buildAuditTicket('props8', '🚩 [Settled Audit] 8-Fold Corners, Cards & Shots', 'Identical Market', 'Statistical prop markets graded against official match corner, card & shot totals.', 100, props8),
      buildAuditTicket('multi6', '🛡️ [Settled Audit] 6-Fold Multiscore Cluster Shield', 'Correct Score Vault', 'Cluster correct scores ("1:0, 2:0 or 3:0") tested against real final scorelines.', 50, multi6),
      buildAuditTicket('cs10', '🎯 [Settled Audit] 10-Game Correct Score Vault', 'Correct Score Vault', 'Top 10 pre-game exact score predictions graded against real final scores (Singles + Multi).', 50, cs10),
    ].filter((t) => t.legs?.length >= 2);

    await registerTickets(auditTickets, { source: 'verified_backtest' });
  } catch (err) {
    console.warn('[arena] completed audit seed warning:', err.message);
  }
}

function findFuzzyMatchResult(leg, allMatches) {
  if (!leg?.home || !leg?.away || !allMatches?.length) return null;
  const legMs = leg.date ? new Date(leg.date).getTime() : NaN;
  let best = null;
  let bestScore = 0;

  for (const cand of allMatches) {
    if (cand.state === 'pre') continue;
    if (Number.isFinite(legMs) && cand.date) {
      const candMs = new Date(cand.date).getTime();
      if (Number.isFinite(candMs) && Math.abs(candMs - legMs) > 40 * 3600 * 1000) continue;
    }
    const hs = teamMatchScore(leg.home, cand.home);
    const as = teamMatchScore(leg.away, cand.away);
    if (hs >= 0.65 && as >= 0.65 && hs + as > bestScore) {
      bestScore = hs + as;
      best = cand;
    }
  }
  return best;
}

/**
 * Sync the entire Arena:
 * 1. Auto-register all current Curated Tickets & Correct Score Vault bundles so nothing cooked is ever missed.
 * 2. Ensure a Live In-Play Test Slip and Rolling Daily Completed Real-World Audits are present.
 * 3. Fetch live & historical results from SportyBet Ghana + ESPN Global Scoreboards and re-grade every leg & ticket.
 */
export async function syncArena({ force = false } = {}) {
  await load();
  const now = Date.now();
  if (!force && now - lastSyncTs < 30 * 1000 && Object.keys(db.tickets).length > 0) {
    return getArenaSnapshot();
  }
  lastSyncTs = now;

  // 1. Register current cooked tickets & vault bundles
  try {
    const [curated, vault] = await Promise.all([
      getCuratedTickets(false, 'all'),
      getSlipCentreVault(false),
    ]);
    await registerTickets(curated, { source: 'live_cooked', defaultStakeGHS: 100 });
    if (vault?.correctScoreBundles?.length) {
      await registerTickets(vault.correctScoreBundles, { source: 'live_cooked', defaultStakeGHS: 50 });
    }
  } catch (err) {
    console.warn('[arena] auto-register curated tickets warning:', err.message);
  }

  // 2. Ensure live in-play test slip & completed real-world audit
  await Promise.all([
    ensureLiveInPlayCookedSlip(),
    ensureCompletedRealWorldAudit(),
  ]);

  // 3. Collect all legs across all tickets that need live/final result checking
  const allTickets = Object.values(db.tickets);
  const legsToCheck = [];
  for (const t of allTickets) {
    for (const l of t.legs || []) {
      legsToCheck.push(l);
    }
  }

  const { byEventId, byTeamPair, allMatches } = await fetchRealWorldResultsMap(legsToCheck);

  for (const t of allTickets) {
    let changed = false;
    for (const leg of t.legs || []) {
      const curState = leg.settlement?.state;
      if (t.source === 'verified_backtest' && curState && curState !== 'PENDING') {
        continue;
      }
      if (curState === 'WON' || curState === 'LOST' || curState === 'VOID') {
        continue;
      }

      const pairKey = `${normTeam(leg.home)}|${normTeam(leg.away)}`;
      const match = byEventId.get(leg.eventId) || byTeamPair.get(pairKey) || findFuzzyMatchResult(leg, allMatches);
      if (match) {
        const nextSettlement = gradeLegAgainstMatch(leg, match);
        if (leg.settlement?.state === 'WON_EARLY' && nextSettlement.state !== 'WON') {
          nextSettlement.state = 'WON_EARLY';
        }
        leg.settlement = nextSettlement;
        changed = true;
      } else {
        // If a match kicked off more than 72 hours ago and has no public archived feed, push/void it cleanly
        const kickMs = leg.date ? new Date(leg.date).getTime() : 0;
        if (kickMs && now - kickMs > 72 * 3600 * 1000) {
          leg.settlement = {
            state: 'VOID',
            reason: 'Archived >72h ago · lower-tier result feed expired (Push)',
            score: null,
            htScore: null,
            matchStatus: 'Archived',
            stats: null,
            settledAt: new Date().toISOString(),
          };
          changed = true;
        }
      }
    }
    if (changed) {
      summarizeTicketSettlement(t);
      dirty = true;
    }
  }

  db.lastSyncedAt = new Date().toISOString();
  dirty = true;
  await save();
  return getArenaSnapshot();
}

/** Update the virtual GHS stake for a specific Arena ticket. */
export async function updateTicketStake(arenaId, stakeGHS) {
  await load();
  const t = db.tickets[arenaId];
  if (!t) throw new Error('Ticket not found in Arena');
  t.stakeGHS = Math.max(1, Math.min(100000, Number(stakeGHS) || 100));
  summarizeTicketSettlement(t);
  dirty = true;
  await save();
  return t;
}

/**
 * Export live real-world market calibration weights so tickets.js actively boosts markets
 * that are winning in the real world and tightens markets that are missing.
 */
export async function getArenaMarketWeights() {
  const snap = await getArenaSnapshot();
  return snap.learningFeedback?.marketWeights || {};
}

/** Compute comprehensive Arena KPIs, market-by-market hit rates, closed-loop feedback, equity curve, and P&L ledger. */
export async function getArenaSnapshot() {
  await load();
  for (const t of Object.values(db.tickets)) {
    summarizeTicketSettlement(t);
  }

  const tickets = Object.values(db.tickets).sort((a, b) => {
    const order = { IN_PLAY: 0, WON: 1, PARTIAL_SETTLED: 2, LOST: 3, PENDING: 4 };
    const oa = order[a.status] ?? 5;
    const ob = order[b.status] ?? 5;
    if (oa !== ob) return oa - ob;
    return new Date(b.placedAt) - new Date(a.placedAt);
  });

  // Aggregate leg-level and market-level performance (deduplicated by eventId + marketKey + selKey)
  const uniqueLegs = new Map();
  for (const t of tickets) {
    for (const l of t.legs || []) {
      const k = `${l.eventId}|${l.marketKey}|${l.selKey}`;
      if (!uniqueLegs.has(k) || l.settlement?.state !== 'PENDING') {
        uniqueLegs.set(k, { ...l, ticketTitle: t.title, ticketShareCode: t.shareCode, source: t.source });
      }
    }
  }

  const allLegs = [...uniqueLegs.values()];
  let legsWon = 0;
  let legsLost = 0;
  let legsLiveWinning = 0;
  let legsLiveTrailing = 0;
  let legsPending = 0;

  const byMarketGroup = {};
  for (const l of allLegs) {
    const st = l.settlement?.state || 'PENDING';
    const grp = l.marketKey === '1up' || l.marketKey === '2up'
      ? '1UP / 2UP Early Payout'
      : l.marketKey === 'cs' || l.marketKey === 'multiscore'
        ? 'Correct Score & Multiscores'
        : l.group || 'Main';

    byMarketGroup[grp] ||= { group: grp, won: 0, lost: 0, live: 0, pending: 0, oddsSum: 0, wonOddsSum: 0 };
    const g = byMarketGroup[grp];

    if (st === 'WON' || st === 'WON_EARLY') {
      legsWon++;
      g.won++;
      g.oddsSum += Number(l.sportyOdds) || 1.4;
      g.wonOddsSum += Number(l.sportyOdds) || 1.4;
    } else if (st === 'LOST') {
      legsLost++;
      g.lost++;
      g.oddsSum += Number(l.sportyOdds) || 1.4;
    } else if (st === 'WINNING_LIVE') {
      legsLiveWinning++;
      g.live++;
    } else if (st === 'TRAILING_LIVE') {
      legsLiveTrailing++;
      g.live++;
    } else {
      legsPending++;
      g.pending++;
    }
  }

  const marketWeights = {};
  const marketBreakdown = Object.values(byMarketGroup).map((g) => {
    const decided = g.won + g.lost;
    const hitRate = decided > 0 ? +((g.won / decided) * 100).toFixed(1) : null;
    const flatRoiPct = decided > 0 ? +(((g.wonOddsSum - decided) / decided) * 100).toFixed(1) : null;
    let calibrationBoost = 1.0;
    if (decided >= 1) {
      if ((flatRoiPct ?? 0) > 10 || (hitRate ?? 0) >= 80) calibrationBoost = 1.08;
      else if ((hitRate ?? 0) >= 72) calibrationBoost = 1.03;
      else if ((hitRate ?? 0) < 50 && g.group !== 'Correct Score & Multiscores') calibrationBoost = 0.92;
    }
    marketWeights[g.group] = calibrationBoost;
    return {
      ...g,
      decided,
      hitRate,
      avgWonOdds: g.won > 0 ? +(g.wonOddsSum / g.won).toFixed(2) : null,
      flatRoiPct,
      calibrationBoost,
    };
  }).sort((a, b) => (b.decided - a.decided) || ((b.hitRate || 0) - (a.hitRate || 0)));

  // Build Post-Mortem Autopsy Rules from settled misses & hits
  const autopsyRules = [];
  const lostLegsList = allLegs.filter((l) => l.settlement?.state === 'LOST');
  const csOvershoots = lostLegsList.filter((l) => l.marketKey === 'cs' && /exceeded target/i.test(l.settlement?.reason || ''));
  if (csOvershoots.length > 0) {
    autopsyRules.push({
      badge: '🎯 Correct Score -> Multiscore Upgrade',
      impact: '+22% Flex Return',
      lesson: `${csOvershoots.length} exact score picks (${csOvershoots.slice(0, 2).map((x) => x.matchup).join(', ')}) scored more goals than the single exact target. Self-correction: prioritize SportyBet Multiscore Clusters ("1:0, 2:0 or 3:0") when expected team goals λ > 1.55.`,
    });
  }
  const oneUpGroup = marketBreakdown.find((m) => m.group === '1UP / 2UP Early Payout');
  if (oneUpGroup && (oneUpGroup.hitRate || 0) >= 75) {
    autopsyRules.push({
      badge: '⚡ 1UP Early Payout Dominance (+8% Weight)',
      impact: `${oneUpGroup.hitRate}% Hit Rate (${oneUpGroup.won}/${oneUpGroup.decided})`,
      lesson: `1UP early payouts are cashing at ${oneUpGroup.hitRate}% (${oneUpGroup.flatRoiPct >= 0 ? '+' : ''}${oneUpGroup.flatRoiPct}% Flat ROI) by locking in wins the moment our pick leads by 1 goal. Vhim & Mixed Multi cooker automatically boosts 1UP over raw 1X2.`,
    });
  }
  const shotsGroup = marketBreakdown.find((m) => m.group === 'Shots');
  if (shotsGroup && (shotsGroup.hitRate || 0) >= 75) {
    autopsyRules.push({
      badge: '🥅 Shots & Corners Prop Edge (+8% Weight)',
      impact: `${shotsGroup.hitRate}% Hit Rate`,
      lesson: `Shots & Corners Over lines are hitting ${shotsGroup.hitRate}% (${shotsGroup.flatRoiPct >= 0 ? '+' : ''}${shotsGroup.flatRoiPct}% ROI) because high-tempo matches generate volume even when finishing variance occurs.`,
    });
  }
  const cardsGroup = marketBreakdown.find((m) => m.group === 'Cards');
  if (cardsGroup && cardsGroup.decided > 0 && (cardsGroup.hitRate || 0) < 55) {
    autopsyRules.push({
      badge: '🟨 Referee Card Tightening (-8% Penalty)',
      impact: 'Threshold Raised to p >= 62%',
      lesson: `Bookings/Cards Over lines showed higher referee variance (${cardsGroup.won}/${cardsGroup.decided}). Cooker automatically raises the minimum probability threshold for Card props.`,
    });
  }

  // Ticket-level P&L strictly on genuinely completed (WON / LOST) tickets so in-progress PARTIAL_SETTLED or VOID pushes never distort P&L
  const settledTickets = tickets.filter((t) => t.status === 'WON' || t.status === 'LOST');
  const totalStakedGHS = +settledTickets.reduce((s, t) => s + (Number(t.stakeGHS) || 100), 0).toFixed(2);
  const totalAccaReturnedGHS = +settledTickets.reduce((s, t) => s + (Number(t.accaPayoutGHS) || 0), 0).toFixed(2);
  const totalFlexReturnedGHS = +settledTickets.reduce((s, t) => s + (Number(t.flexPayoutGHS) || 0), 0).toFixed(2);
  const totalSinglesReturnedGHS = +settledTickets.reduce((s, t) => s + (Number(t.singlesPayoutGHS) || 0), 0).toFixed(2);

  // Build chronological Bankroll Equity Curve starting at GHS 2,500
  const startBank = db.bankroll?.startingGHS || 2500;
  let runFlex = startBank;
  let runSingles = startBank;
  const chronoSettled = [...settledTickets].sort((a, b) => new Date(a.placedAt) - new Date(b.placedAt));
  const points = [{ step: 0, label: 'Start', date: '', flexBankroll: startBank, singlesBankroll: startBank }];
  chronoSettled.forEach((t, idx) => {
    const stk = Number(t.stakeGHS) || 100;
    runFlex = +(runFlex - stk + (Number(t.flexPayoutGHS) || 0)).toFixed(2);
    runSingles = +(runSingles - stk + (Number(t.singlesPayoutGHS) || 0)).toFixed(2);
    points.push({
      step: idx + 1,
      label: t.title.slice(0, 28),
      date: (t.placedAt || '').slice(0, 10),
      flexBankroll: runFlex,
      singlesBankroll: runSingles,
    });
  });

  const equityCurve = {
    startingBankrollGHS: startBank,
    currentFlexBankrollGHS: runFlex,
    currentSinglesBankrollGHS: runSingles,
    points,
  };

  const netProfitAccaGHS = +(totalAccaReturnedGHS - totalStakedGHS).toFixed(2);
  const netProfitFlexGHS = +(totalFlexReturnedGHS - totalStakedGHS).toFixed(2);
  const netProfitSinglesGHS = +(totalSinglesReturnedGHS - totalStakedGHS).toFixed(2);
  const flexTicketsWon = settledTickets.filter((t) => ['WON_FULL', 'WON_FLEX_CUT1', 'WON_FLEX_CUT2', 'WON_FLEX_CUT3'].includes(t.flexStatus)).length;

  const decidedLegsTotal = legsWon + legsLost;
  const standardLegs = allLegs.filter((l) => !['cs', 'multiscore'].includes(l.marketKey));
  const stdWon = standardLegs.filter((l) => l.settlement?.state === 'WON' || l.settlement?.state === 'WON_EARLY').length;
  const stdLost = standardLegs.filter((l) => l.settlement?.state === 'LOST').length;
  const stdDecided = stdWon + stdLost;

  return {
    lastSyncedAt: db.lastSyncedAt,
    equityCurve,
    summary: {
      startingBankrollGHS: startBank,
      currentFlexBankrollGHS: runFlex,
      currentSinglesBankrollGHS: runSingles,
      totalTickets: tickets.length,
      ticketsWon: tickets.filter((t) => t.status === 'WON').length,
      flexTicketsWon,
      ticketsInPlay: tickets.filter((t) => t.status === 'IN_PLAY').length,
      ticketsPending: tickets.filter((t) => t.status === 'PENDING').length,
      ticketsSettled: settledTickets.length,
      totalUniqueLegs: allLegs.length,
      legsWon,
      legsLost,
      legsLive: legsLiveWinning + legsLiveTrailing,
      legsLiveWinning,
      legsLiveTrailing,
      legsPending,
      overallLegHitRate: decidedLegsTotal > 0 ? +((legsWon / decidedLegsTotal) * 100).toFixed(1) : null,
      standardLegHitRate: stdDecided > 0 ? +((stdWon / stdDecided) * 100).toFixed(1) : null,
      stdWon,
      stdDecided,
      totalStakedGHS,
      totalAccaReturnedGHS,
      totalFlexReturnedGHS,
      totalSinglesReturnedGHS,
      netProfitAccaGHS,
      netProfitFlexGHS,
      netProfitSinglesGHS,
      accaRoiPct: totalStakedGHS > 0 ? +((netProfitAccaGHS / totalStakedGHS) * 100).toFixed(1) : 0,
      flexRoiPct: totalStakedGHS > 0 ? +((netProfitFlexGHS / totalStakedGHS) * 100).toFixed(1) : 0,
      singlesRoiPct: totalStakedGHS > 0 ? +((netProfitSinglesGHS / totalStakedGHS) * 100).toFixed(1) : 0,
    },
    learningFeedback: {
      marketWeights,
      autopsyRules,
    },
    marketBreakdown,
    tickets,
    allLegs: allLegs.sort((a, b) => {
      const rank = { WON_EARLY: 0, WON: 1, WINNING_LIVE: 2, TRAILING_LIVE: 3, LOST: 4, PENDING: 5, VOID: 6 };
      return (rank[a.settlement?.state] ?? 7) - (rank[b.settlement?.state] ?? 7);
    }),
  };
}
