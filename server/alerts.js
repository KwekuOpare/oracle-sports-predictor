// Instant Telegram & Web Browser Push Alert Engine (server/alerts.js)
// Persists real, deduplicated alerts & notification settings in `data/alerts.json`.
// Supports:
//   1. 🛡️ Live Arena Hedge-Lock & Cashout Window Alerts (when N-1 / >=2 legs won & 1-2 legs remain)
//   2. 🏆 Settled Winning Ticket Alerts (Full Accumulator or SportyBet Flex Cut-1/2/3 Wins)
//   3. 🚨 High-Severity SportyBet Ghana Odds Crash / Syndicate Steam Alerts
//   4. 🇬🇭 One-Click / Scheduled Daily SportyBet Ghana Codes Digest (Rollover 2x, Vhim 5-Fold, Props, 20M+ & Pods)
// Never exposes raw `telegramBotToken` to the browser (`getPublicAlertState` masks secrets).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');

const MAX_ALERTS = 120;
const MAX_SENT_KEYS = 800;

let state = null;
let dirty = false;
let saveChain = Promise.resolve();
let saveTimer = null;
let arenaBaselineInitialized = false;

function ensureLoaded() {
  if (state) return state;
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        state = {
          config: {
            enabledBrowser: true,
            enabledTelegram: Boolean(raw.config?.enabledTelegram ?? (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)),
            telegramBotToken: raw.config?.telegramBotToken || '',
            telegramChatId: raw.config?.telegramChatId || '',
            notifyHedge: raw.config?.notifyHedge ?? true,
            notifyWins: raw.config?.notifyWins ?? true,
            notifySteam: raw.config?.notifySteam ?? true,
            notifyDailyCodes: raw.config?.notifyDailyCodes ?? true,
            minSteamDropPct: Number(raw.config?.minSteamDropPct) || 9.0,
          },
          alerts: Array.isArray(raw.alerts) ? raw.alerts : [],
          sentKeys: raw.sentKeys && typeof raw.sentKeys === 'object' ? raw.sentKeys : {},
        };
        return state;
      }
    }
  } catch {
    // create fresh state
  }
  state = {
    config: {
      enabledBrowser: true,
      enabledTelegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      telegramBotToken: '',
      telegramChatId: '',
      notifyHedge: true,
      notifyWins: true,
      notifySteam: true,
      notifyDailyCodes: true,
      minSteamDropPct: 9.0,
    },
    alerts: [],
    sentKeys: {},
  };
  return state;
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushAlerts();
  }, 1500);
  saveTimer.unref?.();
}

export function flushAlerts() {
  if (!dirty || !state) return saveChain;
  dirty = false;
  const payload = JSON.stringify(state, null, 2);
  saveChain = saveChain.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${ALERTS_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, payload, 'utf8');
    await fsp.rename(tmp, ALERTS_FILE);
  }).catch(() => {});
  return saveChain;
}

function getEffectiveTelegramCreds() {
  const s = ensureLoaded();
  const token = (s.config.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (s.config.telegramChatId || process.env.TELEGRAM_CHAT_ID || '').trim();
  return {
    token,
    chatId,
    configured: Boolean(token && chatId),
    fromEnv: Boolean(!s.config.telegramBotToken && process.env.TELEGRAM_BOT_TOKEN),
  };
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendTelegramHtml(htmlText, overrideCreds = null) {
  const creds = overrideCreds || getEffectiveTelegramCreds();
  if (!creds.token || !creds.chatId) {
    return { ok: false, error: 'Telegram Bot Token and Chat ID are not configured yet.' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${creds.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: creds.chatId,
        text: htmlText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(9000),
    });
    const json = await res.json();
    if (json.ok) return { ok: true, messageId: json.result?.message_id || null };
    return { ok: false, error: json.description || `Telegram HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function pruneSentKeys(s) {
  const entries = Object.entries(s.sentKeys || {});
  if (entries.length <= MAX_SENT_KEYS) return;
  entries.sort((a, b) => a[1] - b[1]);
  const toKeep = entries.slice(-Math.floor(MAX_SENT_KEYS * 0.75));
  s.sentKeys = Object.fromEntries(toKeep);
}

/**
 * Push a deduplicated real-world alert into the Alert Hub and (when enabled) dispatch via Telegram.
 */
export async function triggerAlert({
  dedupeKey,
  type = 'system',
  severity = 'high',
  title,
  message,
  telegramHtml = null,
  shareCode = null,
  shareURL = null,
  ticketId = null,
  eventId = null,
  bypassDedupe = false,
}) {
  const s = ensureLoaded();
  if (dedupeKey && !bypassDedupe && s.sentKeys[dedupeKey]) {
    return { ok: true, skippedDuplicate: true };
  }

  const nowIso = new Date().toISOString();
  if (dedupeKey) {
    s.sentKeys[dedupeKey] = Date.now();
    pruneSentKeys(s);
  }

  let telegramSent = false;
  let telegramError = null;
  const creds = getEffectiveTelegramCreds();
  if (s.config.enabledTelegram && creds.configured) {
    const html = telegramHtml || [
      `<b>${escapeHtml(title)}</b>`,
      escapeHtml(message),
      shareCode ? `\n🇬🇭 <b>SportyBet Code:</b> <code>${escapeHtml(shareCode)}</code>` : '',
      shareURL ? `🔗 <a href="${escapeHtml(shareURL)}">Load Slip on SportyBet Ghana</a>` : '',
    ].filter(Boolean).join('\n');
    const tgRes = await sendTelegramHtml(html, creds);
    telegramSent = tgRes.ok;
    if (!tgRes.ok) telegramError = tgRes.error;
  }

  const entry = {
    id: `alt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    severity,
    title,
    message,
    shareCode,
    shareURL,
    ticketId,
    eventId,
    createdAt: nowIso,
    read: false,
    telegramSent,
    ...(telegramError ? { telegramError } : {}),
  };

  s.alerts.unshift(entry);
  if (s.alerts.length > MAX_ALERTS) s.alerts.length = MAX_ALERTS;
  scheduleSave();

  return { ok: true, alert: entry, telegramSent, telegramError };
}

/**
 * Evaluate Arena tickets after a live settlement sync:
 *   1. Fire 🛡️ Hedge-Lock / Cashout Window Alert when `t.hedgeAdvice` is active on an unsettled ticket.
 *   2. Fire 🏆 Winning Ticket Alert when a ticket settles WON or WON_FLEX_CUT1/2/3.
 */
export async function evaluateArenaAlerts(tickets = []) {
  const s = ensureLoaded();
  if (!Array.isArray(tickets) || !tickets.length) return;

  // On initial boot, seed already-finished wins into sentKeys so historical wins don't spam notifications
  if (!arenaBaselineInitialized) {
    arenaBaselineInitialized = true;
    for (const t of tickets) {
      if (t.status === 'WON' || (t.flexStatus && t.flexStatus.startsWith('WON_FLEX'))) {
        const winKey = `win:${t.arenaId}:${t.flexStatus || t.status}`;
        if (!s.sentKeys[winKey]) {
          s.sentKeys[winKey] = Date.now();
          dirty = true;
        }
      }
    }
    if (dirty) scheduleSave();
  }

  for (const t of tickets) {
    // 1. Live Hedge-Lock / Cashout Window Alert
    if (
      s.config.notifyHedge &&
      t.hedgeAdvice &&
      ['PARTIAL_SETTLED', 'IN_PLAY'].includes(t.status) &&
      (t.flexHits?.lostLegs || 0) === 0 &&
      (t.flexHits?.wonLegs || 0) >= 2
    ) {
      const h = t.hedgeAdvice;
      const hedgeKey = `hedge:${t.arenaId}:${t.flexHits.wonLegs}of${t.flexHits.totalLegs}`;
      if (!s.sentKeys[hedgeKey]) {
        await triggerAlert({
          dedupeKey: hedgeKey,
          type: 'hedge_lock',
          severity: 'high',
          title: `🛡️ Hedge-Lock Window: ${t.title} (${t.flexHits.wonLegs}/${t.flexHits.totalLegs} Won!)`,
          message: `Only ${h.remainingCount} leg(s) left (${h.nextMatchup} · ${h.nextPick})! Est. SportyBet Cashout: ₵${h.cashoutOfferGHS.toLocaleString()} — OR hedge ₵${h.hedgeStakeGHS.toLocaleString()} on opposite outcome (@${h.oppOdds}) to lock in +₵${h.lockedProfitGHS.toLocaleString()} guaranteed profit!`,
          shareCode: t.shareCode || null,
          shareURL: t.shareURL || null,
          ticketId: t.arenaId,
        });
      }
    }

    // 2. Newly Settled Winning Ticket Alert
    const isFullWin = t.status === 'WON';
    const isFlexWin = !isFullWin && t.flexStatus && t.flexStatus.startsWith('WON_FLEX');
    if (s.config.notifyWins && (isFullWin || isFlexWin)) {
      const winKey = `win:${t.arenaId}:${t.flexStatus || t.status}`;
      if (!s.sentKeys[winKey]) {
        const payout = isFullWin ? t.accaPayoutGHS : t.flexPayoutGHS;
        const winTag = isFullWin ? 'FULL ACCA WON' : t.flexStatus.replace(/_/g, ' ');
        await triggerAlert({
          dedupeKey: winKey,
          type: 'ticket_won',
          severity: 'high',
          title: `🏆 ${winTag}: ${t.title}`,
          message: `Hit ${t.flexHits?.wonLegs}/${t.flexHits?.totalLegs} legs${t.shareCode ? ` (Code ${t.shareCode})` : ''}! Stake ₵${t.stakeGHS} returned ₵${Number(payout || 0).toLocaleString()}.`,
          shareCode: t.shareCode || null,
          shareURL: t.shareURL || null,
          ticketId: t.arenaId,
        });
      }
    }
  }
}

/**
 * Evaluate live SportyBet odds-drop time-series crashes & high-severity market anomalies.
 */
export async function evaluateOddsCrashAlerts(drops = []) {
  const s = ensureLoaded();
  if (!s.config.notifySteam || !Array.isArray(drops) || !drops.length) return;

  const minDrop = Math.max(5.0, Number(s.config.minSteamDropPct) || 9.0);
  for (const d of drops.slice(0, 6)) {
    if (d.dropPct < minDrop) continue;
    // Bucket dedupe key by 5% drop steps so we only alert once unless it plunges another 5%+
    const stepBucket = Math.floor(d.dropPct / 5) * 5;
    const key = `steam:${d.eventId}:${d.marketId}:${d.outcomeId}:${stepBucket}`;
    if (s.sentKeys[key]) continue;

    await triggerAlert({
      dedupeKey: key,
      type: 'odds_crash',
      severity: d.dropPct >= 12 ? 'high' : 'medium',
      title: `🚨 SportyBet Odds Crash (-${d.dropPct}%): ${d.matchup}`,
      message: `${d.label} plunged from @${d.peakOdds} → @${d.curOdds} (-${d.dropPct}% drop, +${d.impliedJumpPct}% implied prob jump across ${d.snapshotsCount} live snapshots) in ${d.leagueName}.`,
      eventId: d.eventId,
    });
  }
}

/**
 * Push a formatted Daily SportyBet Ghana Codes Digest (Rollover 2x, Vhim 5-Fold, Tactical Props, 20M+ & Pod Codes).
 */
export async function sendDailyCodesDigest(curatedTickets = [], { manual = false } = {}) {
  const s = ensureLoaded();
  if (!manual && !s.config.notifyDailyCodes) return { ok: false, error: 'Daily codes alerts disabled in settings.' };
  if (!Array.isArray(curatedTickets) || !curatedTickets.length) {
    return { ok: false, error: 'No live SportyBet tickets available yet.' };
  }

  const todayKey = new Date().toISOString().slice(0, 10);
  const dedupeKey = `daily-digest:${todayKey}`;

  const pickIds = ['daily-rollover-2x', 'vhim-banker-5', 'combo-shield-banker-8', 'tactical-props-sniper-8', 'million-odds-grand-slam', 'twenty-million-mega-50'];
  const featured = pickIds.map((id) => curatedTickets.find((t) => t.id === id)).filter(Boolean);
  if (!featured.length) featured.push(...curatedTickets.slice(0, 4));

  const lines = [`<b>🇬🇭 ORACLE LIVE SPORTYBET GHANA CODES (${todayKey})</b>\n`];
  const plainParts = [];

  for (const t of featured) {
    if (!t.shareCode) continue;
    const oddsTxt = t.totalSportyOdds >= 1e6
      ? `${(t.totalSportyOdds / 1e6).toFixed(2)}M+`
      : `${Number(t.totalSportyOdds).toLocaleString()}x`;
    lines.push(
      `• <b>${escapeHtml(t.title)}</b> (${t.count} legs · @${oddsTxt})\n` +
      `  Code: <code>${escapeHtml(t.shareCode)}</code> — <a href="${escapeHtml(t.shareURL)}">Open Slip</a>`
    );
    plainParts.push(`${t.title}: ${t.shareCode} (@${oddsTxt})`);
    if (Array.isArray(t.podSplits) && t.podSplits.some((p) => p.shareCode)) {
      const podTxt = t.podSplits
        .filter((p) => p.shareCode)
        .map((p) => `${escapeHtml(p.podLabel)}: <code>${escapeHtml(p.shareCode)}</code>`)
        .join(' | ');
      lines.push(`  ↳ Split Pods: ${podTxt}`);
    }
  }

  return triggerAlert({
    dedupeKey,
    bypassDedupe: manual,
    type: 'daily_codes',
    severity: 'medium',
    title: `🇬🇭 Fresh SportyBet Ghana Codes Ready (${featured.length} Slips)`,
    message: plainParts.join(' · '),
    telegramHtml: lines.join('\n'),
    shareCode: featured[0]?.shareCode || null,
    shareURL: featured[0]?.shareURL || null,
  });
}

export async function sendTestAlert() {
  return triggerAlert({
    dedupeKey: `test:${Date.now()}`,
    bypassDedupe: true,
    type: 'test',
    severity: 'medium',
    title: '🔔 Oracle Alert Engine Connected!',
    message: 'Real-time Hedge-Lock Cashout Windows, Sharp SportyBet Odds Crashes, and Winning Slip alerts are active.',
  });
}

export function getPublicAlertState() {
  const s = ensureLoaded();
  const creds = getEffectiveTelegramCreds();
  const rawTok = s.config.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || '';
  const maskedToken = rawTok.length > 8 ? `••••••••${rawTok.slice(-4)}` : (rawTok ? '••••' : '');

  return {
    config: {
      enabledBrowser: Boolean(s.config.enabledBrowser),
      enabledTelegram: Boolean(s.config.enabledTelegram),
      telegramConfigured: creds.configured,
      telegramFromEnv: creds.fromEnv,
      telegramBotTokenMasked: maskedToken,
      telegramChatId: s.config.telegramChatId || process.env.TELEGRAM_CHAT_ID || '',
      notifyHedge: Boolean(s.config.notifyHedge),
      notifyWins: Boolean(s.config.notifyWins),
      notifySteam: Boolean(s.config.notifySteam),
      notifyDailyCodes: Boolean(s.config.notifyDailyCodes),
      minSteamDropPct: Number(s.config.minSteamDropPct) || 9.0,
    },
    unreadCount: s.alerts.filter((a) => !a.read).length,
    alerts: s.alerts.slice(0, 60),
  };
}

export function updateAlertConfig(patch = {}) {
  const s = ensureLoaded();
  if (typeof patch.enabledBrowser === 'boolean') s.config.enabledBrowser = patch.enabledBrowser;
  if (typeof patch.enabledTelegram === 'boolean') s.config.enabledTelegram = patch.enabledTelegram;
  if (typeof patch.notifyHedge === 'boolean') s.config.notifyHedge = patch.notifyHedge;
  if (typeof patch.notifyWins === 'boolean') s.config.notifyWins = patch.notifyWins;
  if (typeof patch.notifySteam === 'boolean') s.config.notifySteam = patch.notifySteam;
  if (typeof patch.notifyDailyCodes === 'boolean') s.config.notifyDailyCodes = patch.notifyDailyCodes;
  if (patch.minSteamDropPct !== undefined) {
    s.config.minSteamDropPct = Math.max(4, Math.min(35, Number(patch.minSteamDropPct) || 9.0));
  }
  if (typeof patch.telegramBotToken === 'string') {
    const trimmed = patch.telegramBotToken.trim();
    // Ignore masked placeholder if client re-submits unchanged form
    if (!trimmed.startsWith('••••')) {
      s.config.telegramBotToken = trimmed;
      if (trimmed) s.config.enabledTelegram = true;
    }
  }
  if (typeof patch.telegramChatId === 'string') {
    s.config.telegramChatId = patch.telegramChatId.trim();
  }
  scheduleSave();
  return getPublicAlertState();
}

export function markAlertsRead(ids = null) {
  const s = ensureLoaded();
  if (Array.isArray(ids) && ids.length) {
    const set = new Set(ids);
    for (const a of s.alerts) if (set.has(a.id)) a.read = true;
  } else {
    for (const a of s.alerts) a.read = true;
  }
  scheduleSave();
  return getPublicAlertState();
}
