// Gemini-powered analyst. Uses Google Search grounding to pull in current news,
// injuries and published expert picks, then returns a structured prediction that
// the UI compares side-by-side with the statistical models and the betting market.
import { GoogleGenAI } from '@google/genai';
import * as lessonStore from './lessons.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
let client = null;
const cache = new Map(); // gameId -> { expires, value }

export function aiEnabled() {
  return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

function getClient() {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
  return client;
}

const SCHEMA = {
  type: 'object',
  properties: {
    pick: { type: 'string', enum: ['home', 'draw', 'away'], description: 'Predicted outcome' },
    probabilities: {
      type: 'object',
      properties: { home: { type: 'number' }, draw: { type: 'number' }, away: { type: 'number' } },
      required: ['home', 'draw', 'away'],
      description: 'Win probabilities between 0 and 1 that sum to 1 (draw = 0 if the sport cannot end level)',
    },
    predictedScore: { type: 'string', description: 'Most likely final score as "home-away", or a method/round for combat sports, or sets for tennis' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    summary: { type: 'string', description: '2-4 sentence explanation of the pick' },
    keyFactors: { type: 'array', items: { type: 'string' }, description: '3-6 concrete factors driving the prediction' },
    injuries: { type: 'array', items: { type: 'string' }, description: 'Notable injuries/suspensions/absences found' },
    expertPicks: {
      type: 'array',
      description: 'Published predictions from human experts, media outlets or analytics sites found via search',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          pick: { type: 'string', enum: ['home', 'draw', 'away', 'unknown'] },
          detail: { type: 'string', description: 'Their predicted score or short rationale' },
          url: { type: 'string' },
        },
        required: ['source', 'pick', 'detail'],
      },
    },
    modelAssessment: { type: 'string', description: 'Do you agree with the statistical models and the market? Where and why do you differ?' },
    valueNote: { type: 'string', description: 'Whether any side looks mispriced vs the market, or "none"' },
  },
  required: ['pick', 'probabilities', 'predictedScore', 'confidence', 'summary', 'keyFactors', 'expertPicks', 'modelAssessment'],
};

const pct = (p) => (p == null ? 'n/a' : `${Math.round(p * 100)}%`);
const fmt = (p) => (p ? `home ${pct(p.home)} / draw ${pct(p.draw)} / away ${pct(p.away)}` : 'n/a');

function buildPrompt(league, game, prediction, summary, lessonsUsed = []) {
  const L = [];
  L.push(`You are an elite sports analyst. Predict this ${league.name} (${league.sport}) game as accurately as possible.`);
  L.push(`Today's date: ${new Date().toISOString().slice(0, 10)}.`);
  L.push(`\nMATCHUP: ${game.away.name} (away${game.away.record ? `, ${game.away.record}` : ''}) at ${game.home.name} (home${game.home.record ? `, ${game.home.record}` : ''})`);
  if (league.kind === 'individual') L.push('Note: individual sport — "home" means the first-listed competitor, "away" the second. There is no real home advantage.');
  L.push(`Start: ${game.date}${game.venue ? ` at ${game.venue}` : ''}${game.neutral ? ' (neutral site)' : ''}${game.tournament ? ` — ${game.tournament}${game.round ? `, ${game.round}` : ''}` : ''}`);
  L.push(`Draws possible: ${league.draws ? 'yes' : 'no (set draw probability to 0)'}`);

  L.push('\nOUR STATISTICAL MODELS (trained walk-forward on recent seasons):');
  L.push(`- Ensemble: ${fmt(prediction.ensemble.probs)}`);
  L.push(`- Elo: ${fmt(prediction.models.elo.probs)} (ratings home ${prediction.models.elo.ratings.home}, away ${prediction.models.elo.ratings.away})`);
  if (prediction.models.score) L.push(`- Scoring model: ${fmt(prediction.models.score.probs)}; expected score ${prediction.models.score.expected.home}-${prediction.models.score.expected.away}`);
  if (prediction.models.ml) L.push(`- Machine learning: ${fmt(prediction.models.ml.probs)}`);
  L.push(`- Recent form: home ${prediction.form.home.streak || 'n/a'}, away ${prediction.form.away.streak || 'n/a'}`);
  if (prediction.market) L.push(`- Betting market (${game.odds.provider}, vig removed): ${fmt(prediction.market)}; line ${game.odds.details || 'n/a'}, total ${game.odds.overUnder ?? 'n/a'}`);
  if (summary?.espnPredictor) L.push(`- ESPN analytics projection: home ${pct(summary.espnPredictor.home)} / away ${pct(summary.espnPredictor.away)}`);
  if (summary?.injuries?.length) {
    L.push('\nESPN INJURY REPORT:');
    for (const t of summary.injuries) L.push(`- ${t.team}: ${t.players.map((p) => `${p.name} (${p.position || ''} ${p.status || ''})`).join('; ') || 'none'}`);
  }

  if (lessonsUsed?.length) {
    L.push('\nLESSONS FROM YOUR PAST MISTAKES (written by you after confident predictions went wrong — apply them where relevant, ignore if not):');
    for (const l of lessonsUsed) L.push(`- [${l.date?.slice(0, 10) || ''} ${l.matchup || ''}] ${l.lesson}`);
  }

  L.push(`\nTASKS:
1. Use Google Search to find the latest team news, injuries, lineups, suspensions, weather, motivation and schedule spots for this specific game.
2. Search for published expert predictions/picks for THIS game (e.g. major sports media, analytics sites, tipsters, pundits). Record each with its source and pick. Do not invent experts; if none found, return an empty list.
3. Weigh everything, including our models and the market (markets are usually well calibrated — deviate only with a concrete reason).
4. Return calibrated probabilities. Use "home"/"away" exactly as defined above.`);
  return L.join('\n');
}

function extractJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function collectSources(interaction) {
  const urls = new Map();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node.url === 'string' && node.url.startsWith('http')) urls.set(node.url, node.title || node.url);
    if (typeof node.uri === 'string' && node.uri.startsWith('http')) urls.set(node.uri, node.title || node.uri);
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v);
  };
  visit(interaction?.steps);
  return [...urls.entries()].slice(0, 12).map(([url, title]) => ({ url, title }));
}

export async function analyzeGame(league, game, prediction, summary, { force = false } = {}) {
  if (!aiEnabled()) {
    const e = new Error('Gemini API key not configured. Add GEMINI_API_KEY to the .env file and restart the server.');
    e.status = 503;
    throw e;
  }
  const key = `${league.id}:${game.id}`;
  const hit = cache.get(key);
  if (!force && hit && hit.expires > Date.now()) return hit.value;

  const ai = getClient();
  // A/B test the memory: 25% of analyses run without lessons so we can measure whether they help.
  const candidates = await lessonStore.relevant(league.id, game.home.name, game.away.name, 8, league.sport).catch(() => []);
  const withheld = candidates.length > 0 && Math.random() < 0.25;
  const lessonsUsed = withheld ? [] : candidates;
  const input = buildPrompt(league, game, prediction, summary, lessonsUsed);
  let interaction;
  let parsed = null;
  try {
    interaction = await ai.interactions.create({
      model: MODEL,
      input,
      tools: [{ type: 'google_search' }],
      response_format: { type: 'text', mime_type: 'application/json', schema: SCHEMA },
    });
    parsed = extractJson(interaction.output_text);
  } catch (err) {
    // Fallback: some model/tool combinations may reject a schema; ask for JSON in the prompt instead.
    console.warn('[ai] structured request failed, retrying without schema:', err.message);
    interaction = await ai.interactions.create({
      model: MODEL,
      input: `${input}\n\nRespond with ONLY a JSON object matching this JSON schema:\n${JSON.stringify(SCHEMA)}`,
      tools: [{ type: 'google_search' }],
    });
    parsed = extractJson(interaction.output_text);
  }
  if (!parsed) {
    const e = new Error('The AI returned an unreadable response. Try again.');
    e.status = 502;
    throw e;
  }
  // Sanitise probabilities
  const p = parsed.probabilities || {};
  const h = Math.max(0, +p.home || 0), d = league.draws ? Math.max(0, +p.draw || 0) : 0, a = Math.max(0, +p.away || 0);
  const s = h + d + a || 1;
  parsed.probabilities = { home: h / s, draw: d / s, away: a / s };
  parsed.sources = collectSources(interaction);
  parsed.model = MODEL;
  parsed.generatedAt = new Date().toISOString();
  parsed.lessonsUsed = lessonsUsed.length;
  parsed.lessonsWithheld = withheld;

  cache.set(key, { expires: Date.now() + 2 * 3600e3, value: parsed });
  return parsed;
}

const LESSON_SCHEMA = {
  type: 'object',
  properties: {
    lesson: { type: 'string', description: 'One or two sentences: a concrete, reusable rule of thumb for predicting future games. No generic advice.' },
    cause: { type: 'string', enum: ['randomness', 'injuries/lineups', 'overrated team', 'underrated team', 'home/away effect', 'motivation/schedule', 'tactical/style', 'market knew better', 'model blind spot', 'other'] },
    general: { type: 'boolean', description: 'True if the lesson applies to the whole sport, not just this league' },
  },
  required: ['lesson', 'cause', 'general'],
};

/**
 * Post-mortem of a confident miss. Uses search to find what actually happened,
 * then distils one reusable lesson. Returns null if it was just bad luck.
 */
export async function generateLesson(league, rec) {
  if (!aiEnabled()) return null;
  const who = { home: rec.home, away: rec.away, draw: 'Draw' };
  const oursPick = Object.entries(rec.probs).sort((a, b) => b[1] - a[1])[0];
  const aiPick = rec.ai ? Object.entries(rec.ai).sort((a, b) => b[1] - a[1])[0] : null;
  const input = [
    `You are reviewing a ${league.name} (${league.sport}) prediction that went wrong, to learn from it.`,
    `Game: ${rec.away} at ${rec.home} on ${rec.date?.slice(0, 10)}. Final: ${rec.home} ${rec.score || '?'} ${rec.away} (result: ${who[rec.result]}).`,
    `Statistical model predicted ${who[oursPick[0]]} at ${pct(oursPick[1])}.`,
    aiPick ? `The AI analyst predicted ${who[aiPick[0]]} at ${pct(aiPick[1])}.` : '',
    rec.market ? `Betting market (vig-free): ${fmt(rec.market)}.` : '',
    'Search for match reports to find why the result happened. Then write ONE concrete lesson that would help predict FUTURE games better (e.g. about a team, a manager, a venue, injuries, fixture congestion, style matchups).',
    'If the result was mostly random (e.g. a fluke goal, red card, freak play), say so with cause "randomness" and keep the lesson about calibration.',
  ].filter(Boolean).join('\n');
  const ai = getClient();
  let parsed = null;
  try {
    const it = await ai.interactions.create({
      model: MODEL,
      input,
      tools: [{ type: 'google_search' }],
      response_format: { type: 'text', mime_type: 'application/json', schema: LESSON_SCHEMA },
    });
    parsed = extractJson(it.output_text);
  } catch (err) {
    const it = await ai.interactions.create({ model: MODEL, input: `${input}\n\nRespond with ONLY JSON matching: ${JSON.stringify(LESSON_SCHEMA)}` });
    parsed = extractJson(it.output_text);
  }
  if (!parsed?.lesson) return null;
  return {
    league: league.id,
    sport: league.sport,
    gameId: rec.id,
    date: rec.date,
    matchup: `${rec.away} @ ${rec.home} ${rec.score || ''}`.trim(),
    teams: [rec.home, rec.away],
    lesson: String(parsed.lesson).slice(0, 400),
    cause: parsed.cause || 'other',
    general: !!parsed.general,
  };
}
