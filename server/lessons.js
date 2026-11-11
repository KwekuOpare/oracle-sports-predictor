// AI memory: short lessons Gemini writes after confident misses. Relevant lessons
// are fed back into future prompts, and the tracker compares AI accuracy with
// and without lessons so we can see whether the memory actually helps.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'brain', 'lessons.json');
let lessons = null;
const MAX = 400;

async function load() {
  if (lessons) return lessons;
  try {
    lessons = JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    lessons = [];
  }
  return lessons;
}

async function save() {
  if (lessons.length > MAX) lessons = lessons.slice(-MAX);
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(lessons, null, 1));
}

export async function add(lesson) {
  await load();
  lessons.push({ id: `${lesson.league}:${lesson.gameId}`, created: new Date().toISOString(), ...lesson });
  await save();
}

export async function has(league, gameId) {
  await load();
  return lessons.some((l) => l.id === `${league}:${gameId}`);
}

/** Up to `max` lessons for a league, preferring ones involving either team, then most recent. */
export async function relevant(leagueId, homeName, awayName, max = 8, sport = null) {
  await load();
  const pool = lessons.filter((l) => l.league === leagueId || (l.general && l.sport === sport));
  const score = (l) => (l.teams?.includes(homeName) || l.teams?.includes(awayName) ? 2 : 0) + (l.league === leagueId ? 1 : 0);
  return pool
    .map((l) => ({ l, s: score(l), t: new Date(l.created).getTime() }))
    .sort((a, b) => b.s - a.s || b.t - a.t)
    .slice(0, max)
    .map((x) => x.l);
}

export async function list(leagueId) {
  await load();
  return (leagueId ? lessons.filter((l) => l.league === leagueId) : lessons).slice().reverse();
}
