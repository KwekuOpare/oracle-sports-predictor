// Oracle — Sports Predictor frontend (vanilla JS, no build step)

const state = {
  catalog: [],
  aiEnabled: false,
  sport: null,
  league: localStorage.getItem('league') || 'eng.1',
  date: '',
  filter: 'all',
  view: 'tickets',
  games: null,
  slip: JSON.parse(localStorage.getItem('oracle_betslip') || '[]'),
  mktTab: 'All',
  picksMinP: 0.65,
  picksTimeWindow: 'all',
  picksSort: 'prob',
  picksGroup: 'all',
  picksEvOnly: false,
  picksSearch: '',
  propsCategory: 'all',
  propsMinP: 0.65,
  propsWindow: 'all',
  propsSearch: '',
  ticketsTimeWindow: 'all',
  ticketCategoryFilter: 'all',
  ticketSearch: '',
  ticketGenLegs: 8,
  ticketGenTargetOdds: 0,
  ticketGenType: 'mixed',
  ticketGenRisk: 'safe',
  arenaFilter: 'all',
  arenaSearch: '',
  arenaAutoSync: true,
  investigations: {},
};

let arenaAutoTimer = null;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => el.querySelectorAll(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (p) => (p == null || Number.isNaN(p) ? '–' : `${Math.round(p * 100)}%`);
const pct1 = (p) => (p == null ? '–' : `${(p * 100).toFixed(1)}%`);
const fx = (n, d = 3) => (n == null ? '–' : Number(n).toFixed(d));
const fairOdds = (p) => (p > 0 ? (1 / p).toFixed(2) : '–');
const fmtOdds = (o) => {
  const n = Number(o);
  if (!Number.isFinite(n) || n <= 0) return '–';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M (${Math.round(n).toLocaleString()})`;
  if (n >= 1e3) return Math.round(n).toLocaleString();
  return n.toFixed(2);
};
const OUT = ['home', 'draw', 'away'];
const pickOf = (p) => OUT.reduce((b, o) => ((p?.[o] || 0) > (p?.[b] || 0) ? o : b), 'home');

function showToast(msg, kind = 'ok') {
  const root = $('#toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s ease';
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function leagueInfo(id = state.league) {
  for (const s of state.catalog) {
    const l = s.leagues.find((x) => x.id === id);
    if (l) return { ...l, sport: s.id, icon: s.icon };
  }
  return null;
}
const homeFirst = () => ['soccer', 'tennis', 'mma'].includes(leagueInfo()?.sport);
const teamLabel = (side, g) => (side === 'home' ? g.home.short || g.home.name : side === 'away' ? g.away.short || g.away.name : 'Draw');

function logo(t, size = 32) {
  if (t?.logo) return `<img src="${esc(t.logo)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
  return `<span class="logo-ph" aria-hidden="true">${esc((t?.abbr || t?.name || '?').slice(0, 3))}</span>`;
}

function bar(p, draws) {
  if (!p) return '<div class="bar"></div>';
  const [first, second] = homeFirst() ? ['home', 'away'] : ['away', 'home'];
  const cls = { home: 'h', away: 'a' };
  return `<div class="bar" role="img" aria-label="Win probabilities: home ${pct(p.home)}${draws ? `, draw ${pct(p.draw)}` : ''}, away ${pct(p.away)}">
    <span class="${cls[first]}" style="width:${p[first] * 100}%"></span>
    ${draws ? `<span class="d" style="width:${(p.draw || 0) * 100}%"></span>` : ''}
    <span class="${cls[second]}" style="width:${p[second] * 100}%"></span></div>`;
}

function fmtTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtKickoffRelative(iso) {
  if (!iso) return '';
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return '';
  if (diffMs <= 0) return 'Live / Started';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `Starts in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hrs < 24) return `Starts in ${hrs}h ${remM}m`;
  const days = Math.floor(hrs / 24);
  return `In ${days}d ${hrs % 24}h`;
}

// ---------- SportyBet Ghana Slip Centre & Live Booking Code Engine ----------

function updateSlipBadge() {
  const b = $('#slip-badge');
  if (!b) return;
  const n = state.slip.length;
  b.textContent = n;
  b.hidden = n === 0;
}

function saveSlip() {
  state.activeSlipCode = null; // reset cached booking code when slip changes
  localStorage.setItem('oracle_betslip', JSON.stringify(state.slip));
  updateSlipBadge();
  renderSlip();
  $$('[data-slip-pick]').forEach((btn) => {
    const id = btn.dataset.slipPick;
    const inSlip = state.slip.some((s) => s.id === id);
    btn.classList.toggle('in-slip', inSlip);
    const lbl = btn.querySelector('.sel-status');
    if (lbl) lbl.textContent = inSlip ? '✓ Slip' : '+ Slip';
  });
}

const SPORTY_MAX_SLIP = 50; // SportyBet Ghana strict 50-game betslip limit

function addToSlip(item, forceAdd = false) {
  const idx = state.slip.findIndex((s) => s.id === item.id);
  if (idx >= 0 && !forceAdd) {
    state.slip.splice(idx, 1);
    showToast(`Removed ${item.sportyPick || item.label} from Slip`, 'info');
  } else if (idx < 0) {
    if (state.slip.length >= SPORTY_MAX_SLIP) {
      showToast(`⚠️ SportyBet Ghana caps betslips at ${SPORTY_MAX_SLIP} games! Remove a leg or book this 50-game slip first.`, 'err');
      return;
    }
    state.slip.push({
      ...item,
      fairOdds: item.fairOdds || +(1 / Math.max(item.p || 0.5, 1e-4)).toFixed(2),
      userOdds: item.userOdds || item.sportyOdds || null,
      addedAt: new Date().toISOString(),
    });
    showToast(`✓ Added ${item.sportyPick || item.label} (@${item.sportyOdds || item.fairOdds || ''}) to Slip (${state.slip.length}/${SPORTY_MAX_SLIP})`, 'ok');
  }
  saveSlip();
}

function loadTicketIntoSlip(legs, append = false, preBookedCode = null) {
  if (!append) state.slip = [];
  let skippedCap = 0;
  legs.forEach((leg) => {
    if (!state.slip.some((s) => s.id === leg.id)) {
      if (state.slip.length >= SPORTY_MAX_SLIP) {
        skippedCap++;
        return;
      }
      state.slip.push({
        ...leg,
        fairOdds: leg.fairOdds || +(1 / Math.max(leg.p || 0.5, 1e-4)).toFixed(2),
        userOdds: leg.userOdds || leg.sportyOdds || null,
        addedAt: new Date().toISOString(),
      });
    }
  });
  saveSlip();
  if (!append && preBookedCode && skippedCap === 0) {
    state.activeSlipCode = {
      shareCode: preBookedCode,
      shareURL: `https://www.sportybet.com/gh/?shareCode=${preBookedCode}`,
    };
    renderSlip();
  }
  state.slipDrawerTab = 'slip';
  openSlip();
  if (skippedCap > 0) {
    showToast(`Loaded up to SportyBet Ghana's ${SPORTY_MAX_SLIP}-game limit (${skippedCap} extra skipped)`, 'info');
  } else {
    showToast(
      append
        ? `Stacked ${legs.length} picks onto your active Slip (${state.slip.length}/${SPORTY_MAX_SLIP} games)`
        : `Loaded ${state.slip.length}-Game Slip${preBookedCode ? ` (Code: ${preBookedCode})` : ''}`,
      'ok'
    );
  }
}

function removeFromSlip(id) {
  state.slip = state.slip.filter((s) => s.id !== id);
  saveSlip();
}

function updateSlipOdds(id, val) {
  const item = state.slip.find((s) => s.id === id);
  if (!item) return;
  const num = parseFloat(val);
  item.userOdds = Number.isFinite(num) && num > 1 ? num : null;
  saveSlip();
}

function clearSlip() {
  if (!state.slip.length) return;
  state.slip = [];
  saveSlip();
  showToast('Cleared active Slip', 'info');
}

async function ensureSlipVaultLoaded() {
  if (state.slipVault) return state.slipVault;
  try {
    if (state.slip.length > SPORTY_MAX_SLIP) {
      state.slip = state.slip.slice(0, SPORTY_MAX_SLIP);
      localStorage.setItem('oracle_betslip', JSON.stringify(state.slip));
      updateSlipBadge();
    }
    state.slipVault = await api('/api/slip-vault');
    if (!state.slip.length && !sessionStorage.getItem('oracle_slip_initialized') && state.slipVault?.defaultSlip?.length) {
      sessionStorage.setItem('oracle_slip_initialized', '1');
      state.slip = state.slipVault.defaultSlip.slice(0, SPORTY_MAX_SLIP).map((leg) => ({
        ...leg,
        userOdds: leg.sportyOdds || leg.fairOdds,
      }));
      if (state.slipVault.defaultTicket?.shareCode) {
        state.activeSlipCode = {
          shareCode: state.slipVault.defaultTicket.shareCode,
          shareURL: state.slipVault.defaultTicket.shareURL,
        };
      }
      localStorage.setItem('oracle_betslip', JSON.stringify(state.slip));
      updateSlipBadge();
    }
    return state.slipVault;
  } catch {
    return null;
  }
}

async function openSlip() {
  const bd = $('#slip-backdrop');
  const dr = $('#slip-drawer');
  if (bd) { bd.hidden = false; bd.removeAttribute('hidden'); }
  if (dr) { dr.hidden = false; dr.removeAttribute('hidden'); }
  renderSlip();
  if (!state.slipVault) {
    await ensureSlipVaultLoaded();
    if (dr && !dr.hidden) renderSlip();
  }
}

function closeSlip() {
  const bd = $('#slip-backdrop');
  const dr = $('#slip-drawer');
  if (bd) { bd.hidden = true; bd.setAttribute('hidden', ''); }
  if (dr) { dr.hidden = true; dr.setAttribute('hidden', ''); }
}

$('#open-slip')?.addEventListener('click', () => {
  const dr = $('#slip-drawer');
  if (dr && !dr.hidden) closeSlip();
  else openSlip();
});
document.addEventListener('click', (e) => {
  if (e.target.closest('#close-slip') || e.target.closest('[data-close-slip]') || e.target.id === 'slip-backdrop') {
    closeSlip();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#slip-drawer')?.hidden) closeSlip();
});

async function copyCodeString(code, btnEl) {
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    showToast(`🇬🇭 Copied SportyBet Ghana Code: ${code}`, 'ok');
    if (btnEl) {
      const orig = btnEl.innerHTML;
      btnEl.innerHTML = `✓ ${esc(code)}`;
      setTimeout(() => { btnEl.innerHTML = orig; }, 2000);
    }
  } catch {
    prompt('Copy your SportyBet Ghana Booking Code:', code);
  }
}

async function bookActiveSlipOnSportyBet() {
  if (!state.slip.length) return;
  const btn = $('#book-sporty-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Booking on SportyBet GH…';
  }
  try {
    const res = await api('/api/sportybet/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selections: state.slip, stakeGHS: Number(state.slipStake) || 100 }),
    });
    if (res.ok && res.shareCode) {
      state.activeSlipCode = res;
      renderSlip();
      showToast(`🇬🇭 Live SportyBet Code Ready: ${res.shareCode} (Also tracked in Arena!)`, 'ok');
    } else {
      showToast(res.error || 'Could not generate live code — ensure selections are upcoming SportyBet fixtures.', 'err');
    }
  } catch (err) {
    showToast('SportyBet booking error: ' + err.message, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '🇬🇭 Generate Live SportyBet Code';
    }
  }
}

async function copySlipForSporty() {
  if (!state.slip.length) return;
  const lines = ['🔮 Oracle Vhim AI — SportyBet Ghana Betslip'];
  if (state.activeSlipCode?.shareCode) {
    lines.push(`🇬🇭 SPORTYBET GHANA BOOKING CODE: ${state.activeSlipCode.shareCode}`);
    lines.push(`🔗 Direct Load Link: ${state.activeSlipCode.shareURL}`);
  }
  lines.push(`Date: ${new Date().toLocaleDateString()}`);
  lines.push('----------------------------------------');
  state.slip.forEach((s, i) => {
    const oddsStr = s.userOdds || s.sportyOdds ? `Sporty: @${s.userOdds || s.sportyOdds}` : `Fair: @${s.fairOdds}`;
    lines.push(`${i + 1}. [${s.leagueName || s.league}] ${s.matchup}`);
    lines.push(`   Market: ${s.sportyMarket || s.market} → Pick: ${s.sportyPick || s.label} (${pct(s.p)}, ${oddsStr})`);
  });
  lines.push('----------------------------------------');
  const combP = state.slip.reduce((a, b) => a * (b.p || 0.5), 1);
  const combOdds = state.slip.reduce((a, b) => a * (b.userOdds || b.sportyOdds || b.fairOdds || 1.5), 1);
  lines.push(`Total Selections: ${state.slip.length}`);
  lines.push(`Combined Win Prob: ${pct1(combP)}`);
  lines.push(`Total Combined Odds: @${combOdds.toFixed(2)}`);

  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast('✓ Copied full Slip & SportyBet Code to clipboard!', 'ok');
    const btn = $('#copy-slip-btn');
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '✓ Copied!';
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    }
  } catch {
    prompt('Copy slip text:', text);
  }
}

function buildTicketShareText(ticket) {
  const lines = [`🔮 Oracle AI — ${ticket.title || 'SportyBet Ghana Slip'}`];
  if (ticket.shareCode) {
    lines.push(`🇬🇭 SPORTYBET GH CODE: *${ticket.shareCode}*`);
    lines.push(`🔗 Direct Load: ${ticket.shareURL || `https://www.sportybet.com/gh/?shareCode=${ticket.shareCode}`}`);
  }
  lines.push(`📊 ${ticket.count || ticket.legs?.length || 0} Folds · Total Odds: *@${ticket.totalSportyOdds || ticket.combinedFairOdds}*`);
  if (ticket.playAdvice) lines.push(`💡 Strategy: ${ticket.playAdvice}`);
  lines.push('----------------------------------------');
  (ticket.legs || []).slice(0, 20).forEach((s, i) => {
    lines.push(`${i + 1}. ${s.matchup} → *${s.sportyPick || s.label}* (@${s.sportyOdds || s.fairOdds})`);
  });
  return lines.join('\n');
}

async function copyTicketText(ticket) {
  const text = buildTicketShareText(ticket);
  try {
    await navigator.clipboard.writeText(text);
    showToast(ticket.shareCode ? `✓ Copied Ticket & Code ${ticket.shareCode}!` : '✓ Ticket copied to clipboard!', 'ok');
  } catch {
    prompt('Copy ticket:', text);
  }
}

function shareTicketWhatsApp(ticket) {
  const text = buildTicketShareText(ticket);
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}

function renderSportyCodeBanner(code, url, count = null, totalOdds = null) {
  if (!code) return '';
  const loadUrl = url || `https://www.sportybet.com/gh/?shareCode=${code}`;
  const waMsg = `🇬🇭 SportyBet Ghana Booking Code: *${code}*${count ? ` (${count} Folds` : ''}${totalOdds ? ` · @${totalOdds})` : count ? ')' : ''}\n🔗 Load 1-Click: ${loadUrl}`;
  return `
    <div class="sporty-code-box">
      <div>
        <span class="sporty-code-label">🇬🇭 Live SportyBet Ghana Code${count ? ` (${count} Legs)` : ''}</span>
        <span class="sporty-code-val">${esc(code)}</span>
      </div>
      <div class="sporty-code-btns">
        <button type="button" class="btn" onclick="window.oracleCopyCode('${esc(code)}', this)">📋 Copy</button>
        <a class="btn btn-whatsapp" href="https://wa.me/?text=${encodeURIComponent(waMsg)}" target="_blank" rel="noopener" title="Share code to WhatsApp">📲 WhatsApp</a>
        <a class="btn btn-sporty" href="${esc(loadUrl)}" target="_blank" rel="noopener">🚀 Load Slip</a>
      </div>
    </div>`;
}

function renderSlip() {
  const c = $('#slip-content');
  if (!c) return;
  const activeTab = state.slipDrawerTab || 'slip';

  const tabsNav = `
    <div class="slip-tabs" role="tablist">
      <button type="button" class="slip-tab-btn ${activeTab === 'slip' ? 'active' : ''}" onclick="window.oracleSetSlipTab('slip')">
        📋 Active Slip (${state.slip.length})
      </button>
      <button type="button" class="slip-tab-btn ${activeTab === 'csvault' ? 'active' : ''}" onclick="window.oracleSetSlipTab('csvault')">
        🎯 CS Vault (20)
      </button>
      <button type="button" class="slip-tab-btn ${activeTab === 'loadcode' ? 'active' : ''}" onclick="window.oracleSetSlipTab('loadcode')">
        🔍 Audit Code
      </button>
    </div>`;

  // TAB 2: PRE-COMPILED 20-GAME CORRECT SCORE VAULT INSIDE SLIP CENTRE
  if (activeTab === 'csvault') {
    const vault = state.slipVault;
    if (!vault) {
      c.innerHTML = `${tabsNav}<p class="loading"><span class="spinner"></span> Compiling 20-Game Correct Score Vault & SportyBet Codes…</p>`;
      return;
    }
    const bundlesHtml = (vault.correctScoreBundles || []).map((b) => {
      const legsJson = JSON.stringify(b.legs).replace(/"/g, '&quot;');
      return `
        <div class="slip-item" style="border-left:3px solid var(--brand)">
          <div class="slip-item-top">
            <div>
              <div class="slip-item-title">${esc(b.title)}</div>
              <div class="slip-item-meta">${esc(b.description)}</div>
            </div>
            <span class="tag pick">@${b.totalSportyOdds || b.combinedFairOdds}</span>
          </div>
          ${renderSportyCodeBanner(b.shareCode, b.shareURL, b.count)}
          <div style="display:flex;gap:.4rem;margin-top:.35rem">
            <button class="btn primary" style="flex:1" onclick="window.oracleLoadTicket(${legsJson}, false, '${esc(b.shareCode || '')}')">📥 Load in Slip</button>
            <button class="btn" onclick="window.oracleLoadTicket(${legsJson}, true)">➕ Stack / Add</button>
          </div>
        </div>`;
    }).join('');

    const gamesHtml = (vault.correctScoreGames || []).map((g, idx) => {
      const p1 = g.primaryCS;
      const p2 = g.backupCS;
      const ms = g.multiscorePick;
      const p1Json = JSON.stringify(p1).replace(/"/g, '&quot;');
      const p2Json = p2 ? JSON.stringify(p2).replace(/"/g, '&quot;') : '';
      const msJson = ms ? JSON.stringify(ms).replace(/"/g, '&quot;') : '';
      return `
        <div class="slip-item">
          <div class="slip-item-title">${idx + 1}. ${esc(g.matchup)}</div>
          <div class="slip-item-meta">${esc(g.leagueName)} · ${fmtTime(g.date)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.35rem">
            <button class="btn primary" style="font-size:.75rem;padding:.28rem .5rem" onclick="window.oracleAddPick(${p1Json})">
              🎯 #1 ${esc(p1.sportyPick)} (@${p1.sportyOdds}, ${pct(p1.p)})
            </button>
            ${p2 ? `<button class="btn" style="font-size:.75rem;padding:.28rem .5rem" onclick="window.oracleAddPick(${p2Json})">
              ➕ #2 ${esc(p2.sportyPick)} (@${p2.sportyOdds})
            </button>` : ''}
            ${ms ? `<button class="btn" style="font-size:.75rem;padding:.28rem .5rem" onclick="window.oracleAddPick(${msJson})">
              🛡️ ${esc(ms.sportyPick)} (@${ms.sportyOdds})
            </button>` : ''}
          </div>
        </div>`;
    }).join('');

    c.innerHTML = `
      ${tabsNav}
      <div style="display:grid;gap:.75rem">
        <div style="background:var(--panel2);padding:.65rem .8rem;border-radius:10px;font-size:.8rem">
          <b>🎯 Pre-Compiled Correct Score Vault (Up to 20 Folds)</b><br>
          <span class="muted">All surest Correct Scores and Multiscores are already compiled below with live SportyBet Ghana codes. Tap any bundle or add individual scores (#1, #2, or Multiscore) to mix & stack!</span>
        </div>
        <h4 style="margin:.2rem 0 0;font-size:.85rem">⚡ Ready Correct Score Bundles (With SportyBet Codes)</h4>
        ${bundlesHtml}
        <h4 style="margin:.4rem 0 0;font-size:.85rem">📋 All 20 Compiled Correct Score Matches (Tap to Add Multiple)</h4>
        ${gamesHtml}
      </div>`;
    return;
  }

  // TAB 3: LOAD & AUDIT ANY SPORTYBET GHANA BOOKING CODE (+ 1-CLICK STRIP STARTED & REBOOK)
  if (activeTab === 'loadcode') {
    const res = state.auditedCodeResult;
    const legsJson = res?.legs ? JSON.stringify(res.legs).replace(/"/g, '&quot;') : '[]';
    const cleanRes = state.rebookedAuditResult;
    c.innerHTML = `
      ${tabsNav}
      <div style="display:grid;gap:.8rem">
        <div class="slip-item">
          <div class="slip-item-title">🔍 Decode, Audit &amp; Clean Any SportyBet Ghana Code</div>
          <div class="slip-item-meta">Paste any 6-character SportyBet Ghana Booking Code (e.g. 9YG45J) to inspect every leg, detect started/locked games, and mint a fresh upcoming-only code in 1 click.</div>
          <div style="display:flex;gap:.4rem;margin-top:.5rem">
            <input id="audit-code-input" type="text" placeholder="Enter code e.g. 9YG45J" value="${esc(state.auditCodeInput || '')}" style="flex:1;padding:.5rem .7rem;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);font-weight:800;text-transform:uppercase">
            <button type="button" class="btn primary" onclick="window.oracleAuditSportyCode()">Check Code</button>
          </div>
        </div>
        ${res ? `
          <div class="slip-item" style="border-left:3px solid var(--brand)">
            <div class="slip-item-top">
              <div>
                <div class="slip-item-title">Code: ${esc(res.shareCode)} (${res.count} Legs)</div>
                <div class="slip-item-meta">Verdict: <b>${esc(res.overallRating)}</b> · Total Odds: <b>@${fmtOdds(res.totalSportyOdds)}</b></div>
              </div>
              <div style="display:flex;gap:.3rem;flex-wrap:wrap;justify-content:flex-end">
                ${res.startedCount ? `<span class="tag miss">🔒 ${res.startedCount} Started/Locked</span>` : `<span class="tag ok">🟢 All ${res.activeCount ?? res.count} Active</span>`}
                <span class="tag ${res.trapsCount ? 'miss' : 'ok'}">${res.trapsCount} Trap Legs</span>
              </div>
            </div>
            <div style="display:grid;gap:.35rem;max-height:240px;overflow-y:auto;margin:.4rem 0">
              ${res.legs.map((l, i) => `
                <div class="ticket-leg" style="${(l.isStarted || l.isLocked) ? 'opacity:.62' : ''}">
                  <span><b>${i + 1}.</b> ${(l.isStarted || l.isLocked) ? '🔒 ' : ''}${esc(l.matchup)} — <b>${esc(l.sportyPick)}</b></span>
                  <span class="tag ${(l.isStarted || l.isLocked) ? 'muted' : l.p >= 0.65 ? 'ok' : l.p < 0.40 ? 'miss' : 'value'}" style="font-size:.7rem">${(l.isStarted || l.isLocked) ? 'Started/Locked' : `${pct(l.p)} (@${l.sportyOdds})`}</span>
                </div>`).join('')}
            </div>
            ${cleanRes?.ok && cleanRes.shareCode ? renderSportyCodeBanner(cleanRes.shareCode, cleanRes.shareURL, cleanRes.keptCount, fmtOdds(cleanRes.totalSportyOdds)) : ''}
            <div style="display:flex;gap:.4rem;flex-wrap:wrap">
              <button type="button" class="btn btn-sporty" style="flex:1" onclick="window.oracleRebookClean({ shareCode: '${esc(res.shareCode)}', fromAudit: true }, this)">
                🧹 ${res.startedCount ? `Strip ${res.startedCount} Started & Mint Fresh Code` : 'Mint Fresh Verified Code'}
              </button>
              <button type="button" class="btn primary" onclick="window.oracleLoadTicket(${legsJson}, false, '${esc(res.shareCode)}')">📥 Load Slip</button>
              <button type="button" class="btn" onclick="window.oracleLoadTicket(${legsJson}, true)">➕ Stack</button>
            </div>
          </div>` : ''}
      </div>`;
    return;
  }

  // TAB 1: ACTIVE SLIP & LIVE SPORTYBET GHANA CODE GENERATOR
  if (!state.slip.length) {
    const vTickets = state.slipVault?.correctScoreBundles || [];
    c.innerHTML = `
      ${tabsNav}
      <div style="text-align:center;padding:1.5rem 1rem;color:var(--muted)">
        <div style="font-size:2.2rem;margin-bottom:.4rem">🏦</div>
        <p style="margin:.2rem 0"><b>Your Active Slip is empty</b></p>
        <p class="small">Load one of our pre-compiled Vhim or Correct Score slips below in 1 click, or switch to the <b>🎯 CS Vault (20)</b> tab above!</p>
        <div style="display:grid;gap:.5rem;margin-top:1rem;text-align:left">
          ${state.slipVault?.defaultTicket ? `
            <button class="btn primary" style="width:100%;justify-content:space-between;display:flex" onclick="window.oracleLoadTicket(${JSON.stringify(state.slipVault.defaultTicket.legs).replace(/"/g, '&quot;')}, false, '${esc(state.slipVault.defaultTicket.shareCode || '')}')">
              <span>🔥 Load Default Vhim Banker (${state.slipVault.defaultTicket.count} Folds)</span>
              <b>${state.slipVault.defaultTicket.shareCode ? `CODE: ${state.slipVault.defaultTicket.shareCode}` : `@${state.slipVault.defaultTicket.totalSportyOdds}`}</b>
            </button>` : ''}
          ${vTickets.slice(0, 3).map((b) => `
            <button class="btn" style="width:100%;justify-content:space-between;display:flex" onclick="window.oracleLoadTicket(${JSON.stringify(b.legs).replace(/"/g, '&quot;')}, false, '${esc(b.shareCode || '')}')">
              <span>${esc(b.title)}</span>
              <b>${b.shareCode ? `CODE: ${b.shareCode}` : `@${b.totalSportyOdds}`}</b>
            </button>`).join('')}
        </div>
      </div>`;
    return;
  }

  const gameCounts = {};
  state.slip.forEach((s) => { gameCounts[s.gameId] = (gameCounts[s.gameId] || 0) + 1; });
  const multiSameGameCount = Object.values(gameCounts).filter((cnt) => cnt > 1).length;
  const nowMs = Date.now();
  const startedInSlip = state.slip.filter((s) => s.date && new Date(s.date).getTime() <= nowMs + 60000).length;

  const itemsHtml = state.slip.map((s, idx) => {
    const activeOdds = s.userOdds || s.sportyOdds || s.fairOdds;
    const edge = ((s.p || 0.5) * activeOdds - 1) * 100;
    const isPos = edge >= 0;
    const isPast = s.date && new Date(s.date).getTime() <= nowMs + 60000;
    const edgeHtml = `<span class="slip-edge ${isPos ? '' : 'neg'}" title="Value edge vs fair price">${isPos ? '+' : ''}${edge.toFixed(1)}% edge</span>`;
    return `
      <div class="slip-item" style="${isPast ? 'border-left:3px solid var(--bad);opacity:.78' : ''}">
        <div class="slip-item-top">
          <div>
            <div class="slip-item-title">${idx + 1}. ${isPast ? '🔒 ' : ''}${esc(s.matchup)}</div>
            <div class="slip-item-meta">${esc(s.leagueName || s.league || '')} · ${esc(s.sportyMarket || s.market)}${isPast ? ' · <b style="color:var(--bad)">Started</b>' : ''}</div>
          </div>
          <button type="button" class="close" style="width:1.6rem;height:1.6rem;font-size:.9rem" onclick="window.oracleRemoveSlip('${esc(s.id)}')" aria-label="Remove pick">✕</button>
        </div>
        <div class="slip-pick-row">
          <span class="slip-pick-name">${esc(s.sportyPick || s.label)}</span>
          <span class="slip-pick-prob">Win Prob: <b>${pct(s.p)}</b> (Fair: @${s.fairOdds})</span>
        </div>
        ${s.lineupBadge ? `<div class="small" style="font-size:.72rem;color:var(--brand)">${esc(s.lineupBadge)}</div>` : ''}
        ${s.historySummary || s.historyBadge ? `<div class="small muted" style="font-size:.73rem;line-height:1.3">📜 ${esc(s.historySummary || s.historyBadge)}</div>` : ''}
        <div class="slip-odds-row">
          <label class="small muted">SportyBet Odds:
            <input type="number" step="0.01" min="1.01" placeholder="@ ${s.sportyOdds || s.fairOdds}" value="${s.userOdds || s.sportyOdds || ''}" onchange="window.oracleUpdateOdds('${esc(s.id)}', this.value)">
          </label>
          ${edgeHtml}
        </div>
      </div>`;
  }).join('');

  const combP = state.slip.reduce((a, b) => a * (b.p || 0.5), 1);
  const combFair = 1 / Math.max(combP, 1e-10);
  const totalSporty = state.slip.reduce((a, b) => a * (b.userOdds || b.sportyOdds || b.fairOdds || 1.4), 1);
  const stake = Number(state.slipStake) || 10;
  const estPayout = stake * totalSporty;
  const fmtPayout = estPayout >= 1e6
    ? `${(estPayout / 1e6).toFixed(2)}M (${Math.round(estPayout).toLocaleString()})`
    : estPayout.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  c.innerHTML = `
    ${tabsNav}
    ${ state.activeSlipCode?.shareCode ? renderSportyCodeBanner(state.activeSlipCode.shareCode, state.activeSlipCode.shareURL, state.slip.length, fmtOdds(totalSporty)) : `
      <button type="button" id="book-sporty-btn" class="btn btn-sporty" style="width:100%;justify-content:center;padding:.65rem;margin-bottom:.5rem;font-size:.9rem" onclick="window.oracleBookActiveSlip()">
        🇬🇭 Generate Live SportyBet Ghana Code (${state.slip.length}/${SPORTY_MAX_SLIP} Games)
      </button>` }
    <button type="button" class="btn" style="width:100%;justify-content:center;margin-bottom:.6rem;font-size:.8rem;border-color:${startedInSlip ? 'var(--bad)' : 'var(--line)'}" onclick="window.oracleRebookClean({ updateActiveSlip: true }, this)">
      🧹 ${startedInSlip ? `Strip ${startedInSlip} Started Match(es) & Mint Fresh Code` : 'Verify Active Legs & Mint Clean SportyBet Code'}
    </button>
    ${multiSameGameCount > 0 ? `<div class="slip-warn">⚡ <b>Multi-Additions Active (${multiSameGameCount} match${multiSameGameCount > 1 ? 'es' : ''} with multiple picks)</b>: SportyBet will book all selections into your code for BetBuilder, Singles, or System/Flex play.</div>` : ''}
    <div style="display:grid;gap:.55rem;max-height:320px;overflow-y:auto;padding-right:.2rem">${itemsHtml}</div>
    <div class="slip-summary" style="margin-top:.75rem">
      <div class="slip-summary-row"><span>Total Games (SportyBet Max 50):</span><b>${state.slip.length} / ${SPORTY_MAX_SLIP}</b></div>
      <div class="slip-summary-row"><span>Combined Win Probability:</span><b>${combP < 0.001 ? `${(combP * 100).toExponential(2)}%` : pct1(combP)}</b></div>
      <div class="slip-summary-row"><span>Combined Fair Odds:</span><b>@ ${fmtOdds(combFair)}</b></div>
      <div class="slip-summary-row" style="color:var(--brand);font-size:1rem"><span>Total SportyBet Odds:</span><b>@ ${fmtOdds(totalSporty)}</b></div>
      <div class="slip-summary-row" style="align-items:center">
        <span>Stake (GHS ₵):</span>
        <input type="number" min="1" step="5" value="${stake}" style="width:80px;padding:.25rem .45rem;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--text);text-align:right;font-weight:700" onchange="window.oracleUpdateStake(this.value)">
      </div>
      <div class="slip-summary-row" style="color:var(--good);font-size:1.05rem">
        <span>Potential Return:</span>
        <b>GHS ₵ ${fmtPayout}</b>
      </div>
      <div class="slip-actions" style="grid-template-columns:1fr auto auto">
        <button type="button" id="copy-slip-btn" class="btn primary" onclick="window.oracleCopySlip()">📋 Copy Slip &amp; Code</button>
        <button type="button" class="btn" onclick="window.oracleClearSlip()">Clear</button>
        <button type="button" class="btn" data-close-slip="1" onclick="window.oracleCloseSlip()">✕ Close</button>
      </div>
    </div>`;
}

// 1-Click Strip Started / Locked Matches & Mint Fresh SportyBet Ghana Code
async function rebookCleanSportySlip(opts = {}, btnEl = null) {
  const origHtml = btnEl?.innerHTML;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = '<span class="spinner"></span> Stripping started & booking…';
  }
  try {
    const payload = {
      shareCode: opts.shareCode || null,
      selections: opts.updateActiveSlip ? state.slip : (opts.selections || null),
      stakeGHS: Number(state.slipStake) || 100,
    };
    const res = await api('/api/sportybet/rebook-clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.shareCode) {
      showToast(res.error || 'No upcoming active legs remained to re-book.', 'err');
      return;
    }
    if (opts.fromAudit) {
      state.rebookedAuditResult = res;
      renderSlip();
    } else if (opts.updateActiveSlip) {
      const activeIds = new Set((res.activeSelections || []).map((a) => `${a.eventId}:${a.marketId}:${a.outcomeId}`));
      const nowCutoff = Date.now() + 60000;
      const filtered = state.slip.filter((s) => {
        if (s.sportySelection) {
          return activeIds.has(`${s.sportySelection.eventId}:${s.sportySelection.marketId}:${s.sportySelection.outcomeId}`);
        }
        return !s.date || new Date(s.date).getTime() > nowCutoff;
      });
      if (filtered.length) state.slip = filtered;
      saveSlip();
      state.activeSlipCode = { shareCode: res.shareCode, shareURL: res.shareURL };
      renderSlip();
    } else {
      try { await navigator.clipboard.writeText(res.shareCode); } catch { /* ignore */ }
    }
    const stripNote = res.removedCount > 0 ? `Stripped ${res.removedCount} started/locked game(s) → ` : '';
    showToast(`🇬🇭 ${stripNote}Fresh Code: ${res.shareCode} (${res.keptCount} active legs · @${fmtOdds(res.totalSportyOdds)})`, 'ok');
    if (btnEl && !opts.fromAudit && !opts.updateActiveSlip) {
      btnEl.disabled = false;
      btnEl.innerHTML = `✓ Clean Code: ${esc(res.shareCode)}`;
      setTimeout(() => { if (origHtml) btnEl.innerHTML = origHtml; }, 5000);
      return;
    }
  } catch (err) {
    showToast('Clean re-book failed: ' + err.message, 'err');
  } finally {
    if (btnEl && (opts.fromAudit || opts.updateActiveSlip)) {
      btnEl.disabled = false;
      if (origHtml) btnEl.innerHTML = origHtml;
    } else if (btnEl && btnEl.disabled) {
      btnEl.disabled = false;
      if (origHtml) btnEl.innerHTML = origHtml;
    }
  }
}

// ---------- Instant Telegram + Browser Push Alert Engine UI ----------

function updateAlertsBadge(unread = 0) {
  const b = $('#alerts-badge');
  if (!b) return;
  b.textContent = unread;
  b.hidden = !(unread > 0);
}

async function pollAlertsBackground(isInitial = false) {
  try {
    const data = await api('/api/alerts');
    state.alertState = data;
    updateAlertsBadge(data.unreadCount || 0);

    let seen = [];
    try { seen = JSON.parse(localStorage.getItem('oracle_seen_alerts') || 'null'); } catch { seen = null; }
    const allIds = (data.alerts || []).map((a) => a.id);

    // Seed baseline on very first browser visit so past alerts don't burst desktop notifications
    if (seen === null || isInitial && !seen.length && allIds.length) {
      localStorage.setItem('oracle_seen_alerts', JSON.stringify(allIds.slice(0, 120)));
      return;
    }

    const seenSet = new Set(seen);
    const freshAlerts = (data.alerts || []).filter((a) => !seenSet.has(a.id));
    if (freshAlerts.length) {
      for (const a of freshAlerts.slice(0, 3)) {
        seenSet.add(a.id);
        showToast(`${a.title}`, 'ok');
        if (
          localStorage.getItem('oracle_browser_push') !== '0' &&
          'Notification' in window &&
          Notification.permission === 'granted'
        ) {
          try {
            const notif = new Notification(a.title, {
              body: a.message,
              tag: a.id,
            });
            notif.onclick = () => {
              window.focus();
              if (a.shareURL) window.open(a.shareURL, '_blank', 'noopener');
              else openAlertsDialog();
            };
          } catch { /* ignore notification quirk */ }
        }
      }
      allIds.forEach((id) => seenSet.add(id));
      localStorage.setItem('oracle_seen_alerts', JSON.stringify([...seenSet].slice(-150)));
    }
  } catch { /* ignore transient poll hiccup */ }
}

async function openAlertsDialog() {
  const dlg = $('#alerts-dialog');
  if (!dlg) return;
  $('#alerts-dialog-body').innerHTML = `<div class="d-head"><h2 id="alerts-dialog-title">🔔 Live Alerts &amp; Telegram Push</h2><form method="dialog"><button class="close" aria-label="Close">✕</button></form></div><div class="d-body"><p class="loading"><span class="spinner"></span> Loading alert feed &amp; Telegram settings…</p></div>`;
  dlg.showModal();
  try {
    state.alertState = await api('/api/alerts');
    updateAlertsBadge(state.alertState.unreadCount || 0);
    renderAlertsDialog();
  } catch (err) {
    $('#alerts-dialog-body .d-body').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

function renderAlertsDialog() {
  const body = $('#alerts-dialog-body');
  if (!body || !state.alertState) return;
  const cfg = state.alertState.config || {};
  const list = state.alertState.alerts || [];
  const notifSupported = 'Notification' in window;
  const notifPerm = notifSupported ? Notification.permission : 'unsupported';
  const browserPushOn = notifPerm === 'granted' && localStorage.getItem('oracle_browser_push') !== '0';

  const feedHtml = list.length ? list.slice(0, 35).map((a) => {
    const kindCls = a.type === 'WINNING_TICKET' ? 'win' : a.type === 'HEDGE_LOCK' ? 'hedge' : a.type === 'SHARP_ODDS_CRASH' ? 'crash' : '';
    return `
      <div class="alert-feed-item ${a.read ? '' : 'unread'} ${kindCls}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:.4rem;flex-wrap:wrap">
          <b style="font-size:.88rem">${esc(a.title)}</b>
          <div style="display:flex;gap:.3rem;align-items:center">
            ${a.telegramSent ? `<span class="tag ok" style="font-size:.68rem">✓ Telegram</span>` : ''}
            <span class="small muted">${fmtTime(a.createdAt)}</span>
          </div>
        </div>
        <div class="small" style="line-height:1.38">${esc(a.message)}</div>
        ${a.shareCode ? `
          <div style="display:flex;gap:.35rem;flex-wrap:wrap;margin-top:.15rem">
            <button type="button" class="btn" style="padding:.2rem .5rem;font-size:.73rem" onclick="window.oracleCopyCode('${esc(a.shareCode)}', this)">📋 Copy ${esc(a.shareCode)}</button>
            <a class="btn btn-sporty" style="padding:.2rem .55rem;font-size:.73rem" href="${esc(a.shareURL || `https://www.sportybet.com/gh/?shareCode=${a.shareCode}`)}" target="_blank" rel="noopener">🚀 Load on SportyBet</a>
          </div>` : ''}
      </div>`;
  }).join('') : `<p class="muted small">No alerts fired yet. Click <b>🔔 Send Test Alert</b> or <b>📤 Push Today's Codes</b> below to verify instant delivery!</p>`;

  body.innerHTML = `
    <div class="d-head">
      <h2 id="alerts-dialog-title">🔔 Instant Telegram &amp; Browser Push Alerts</h2>
      <form method="dialog"><button class="close" aria-label="Close">✕</button></form>
    </div>
    <div class="d-body" style="display:grid;gap:1rem">
      <section class="panel" style="margin:0;display:grid;gap:.75rem">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
          <div>
            <h3 style="margin:0">🖥️ Browser Desktop Push Notifications</h3>
            <span class="small muted">Fires native OS desktop alerts when a live Arena slip enters a Hedge-Lock cashout window, settles as WON, or when a SportyBet line crashes.</span>
          </div>
          <button type="button" class="btn ${browserPushOn ? 'ok' : 'primary'}" onclick="window.oracleEnableBrowserPush()">
            ${browserPushOn ? '✅ Desktop Push Active' : notifPerm === 'denied' ? '⚠️ Blocked in Browser Settings' : '🔔 Enable Desktop Push'}
          </button>
        </div>
      </section>

      <section class="panel" style="margin:0;display:grid;gap:.75rem;border-left:4px solid #0ea5e9">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
          <div>
            <h3 style="margin:0">✈️ Telegram Bot Push Configuration</h3>
            <span class="small muted">Create a bot via <code>@BotFather</code> on Telegram, message it once, and paste your Bot Token &amp; Chat ID below.</span>
          </div>
          <span class="tag ${cfg.hasBotToken && cfg.telegramChatId ? 'ok' : 'muted'}">
            ${cfg.hasBotToken && cfg.telegramChatId ? (cfg.telegramEnabled ? '🟢 Telegram Connected' : '⏸ Paused') : '⚪ Not Configured'}
          </span>
        </div>

        <div class="alerts-config-grid">
          <label class="small">
            <b>Telegram Bot Token</b> ${cfg.hasBotToken ? `<span class="muted">(Saved: ${esc(cfg.telegramBotTokenMasked)})</span>` : ''}
            <input id="tg-bot-token" type="password" class="alerts-input" placeholder="${cfg.hasBotToken ? 'Leave blank to keep saved token' : '123456789:AAH...'}" autocomplete="off">
          </label>
          <label class="small">
            <b>Telegram Chat / Channel ID</b>
            <input id="tg-chat-id" type="text" class="alerts-input" placeholder="e.g. 123456789 or @mychannel" value="${esc(cfg.telegramChatId || '')}">
          </label>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:.8rem;font-size:.82rem">
          <label style="display:inline-flex;align-items:center;gap:.3rem"><input id="tg-enabled" type="checkbox" ${cfg.telegramEnabled || (!cfg.hasBotToken) ? 'checked' : ''}> <b>Enable Telegram Push</b></label>
          <label style="display:inline-flex;align-items:center;gap:.3rem"><input id="tg-hedge" type="checkbox" ${cfg.notifyHedgeLock !== false ? 'checked' : ''}> 🛡️ Hedge-Lock Cashout</label>
          <label style="display:inline-flex;align-items:center;gap:.3rem"><input id="tg-wins" type="checkbox" ${cfg.notifyWinningTickets !== false ? 'checked' : ''}> 🏆 Winning Slips</label>
          <label style="display:inline-flex;align-items:center;gap:.3rem"><input id="tg-crashes" type="checkbox" ${cfg.notifyOddsCrash !== false ? 'checked' : ''}> 📉 Sharp Odds Crashes (-8%+)</label>
          <label style="display:inline-flex;align-items:center;gap:.3rem"><input id="tg-daily" type="checkbox" ${cfg.notifyDailyCodes !== false ? 'checked' : ''}> 🇬🇭 Daily SportyBet Codes</label>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:.45rem">
          <button type="button" class="btn primary" onclick="window.oracleSaveAlertConfig(this)">💾 Save Alert Settings</button>
          <button type="button" class="btn" onclick="window.oracleTestAlert(this)">🔔 Send Test Alert</button>
          <button type="button" class="btn btn-sporty" onclick="window.oraclePushDailyCodes(this)">📤 Push Today's Codes Now</button>
        </div>
      </section>

      <section class="panel" style="margin:0;display:grid;gap:.65rem">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
          <h3 style="margin:0">📡 Live Alert Feed (${list.length})</h3>
          ${state.alertState.unreadCount ? `<button type="button" class="btn" style="padding:.22rem .6rem;font-size:.76rem" onclick="window.oracleMarkAlertsRead()">✓ Mark All Read (${state.alertState.unreadCount})</button>` : ''}
        </div>
        <div style="display:grid;gap:.5rem;max-height:300px;overflow-y:auto;padding-right:.2rem">${feedHtml}</div>
      </section>
    </div>`;
}

// Global hooks for inline event handlers
window.oracleCloseSlip = closeSlip;
window.oracleRemoveSlip = removeFromSlip;
window.oracleUpdateOdds = updateSlipOdds;
window.oracleClearSlip = clearSlip;
window.oracleCopySlip = copySlipForSporty;
window.oracleLoadTicket = loadTicketIntoSlip;
window.oracleCopyTicket = copyTicketText;
window.oracleShareWhatsApp = shareTicketWhatsApp;
window.oracleCopyCode = copyCodeString;
window.oracleBookActiveSlip = bookActiveSlipOnSportyBet;
window.oracleRebookClean = rebookCleanSportySlip;
window.oracleAddPick = (pick) => { addToSlip(pick, true); };
window.oracleSetSlipTab = (tab) => { state.slipDrawerTab = tab; renderSlip(); };
window.oracleUpdateStake = (val) => { state.slipStake = Math.max(1, Number(val) || 10); renderSlip(); };
window.oracleAuditSportyCode = async () => {
  const inp = $('#audit-code-input');
  const code = inp?.value?.trim();
  if (!code) return;
  state.auditCodeInput = code;
  state.rebookedAuditResult = null;
  try {
    state.auditedCodeResult = await api(`/api/sportybet/code/${encodeURIComponent(code)}`);
    renderSlip();
    showToast(`✓ Decoded SportyBet Code ${code.toUpperCase()} (${state.auditedCodeResult.count} legs)`, 'ok');
  } catch (err) {
    showToast(err.message, 'err');
  }
};
window.oracleEnableBrowserPush = async () => {
  if (!('Notification' in window)) {
    showToast('Desktop Notifications are not supported in this browser.', 'err');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    localStorage.setItem('oracle_browser_push', '1');
    showToast('✅ Browser Desktop Push Alerts enabled!', 'ok');
  } else {
    showToast('Notification permission was not granted.', 'err');
  }
  renderAlertsDialog();
};
window.oracleSaveAlertConfig = async (btn) => {
  const tokenVal = $('#tg-bot-token')?.value?.trim() || '';
  const chatId = $('#tg-chat-id')?.value?.trim() || '';
  const payload = {
    telegramChatId: chatId,
    telegramEnabled: Boolean($('#tg-enabled')?.checked),
    notifyHedgeLock: Boolean($('#tg-hedge')?.checked),
    notifyWinningTickets: Boolean($('#tg-wins')?.checked),
    notifyOddsCrash: Boolean($('#tg-crashes')?.checked),
    notifyDailyCodes: Boolean($('#tg-daily')?.checked),
  };
  if (tokenVal) payload.telegramBotToken = tokenVal;
  if (btn) btn.disabled = true;
  try {
    state.alertState = await api('/api/alerts/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    updateAlertsBadge(state.alertState.unreadCount || 0);
    renderAlertsDialog();
    showToast('✓ Saved Alert & Telegram Push configuration!', 'ok');
  } catch (err) {
    showToast('Failed to save settings: ' + err.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
};
window.oracleTestAlert = async (btn) => {
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/alerts/test', { method: 'POST' });
    state.alertState = res.state;
    updateAlertsBadge(state.alertState.unreadCount || 0);
    renderAlertsDialog();
    showToast(res.result?.telegramSent ? '✈️ Test Alert delivered to Telegram & Feed!' : '🔔 Test Alert added to Live Feed (configure Telegram token/chat ID for Telegram push)!', 'ok');
  } catch (err) {
    showToast('Test alert error: ' + err.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
};
window.oraclePushDailyCodes = async (btn) => {
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Pushing Codes…'; }
  try {
    const res = await api('/api/alerts/send-daily-codes', { method: 'POST' });
    state.alertState = res.state;
    updateAlertsBadge(state.alertState.unreadCount || 0);
    renderAlertsDialog();
    showToast(res.result?.telegramSent ? '🇬🇭 Pushed Today\'s SportyBet Codes to Telegram!' : '🇬🇭 Generated Today\'s SportyBet Codes Digest in Alert Feed!', 'ok');
  } catch (err) {
    showToast('Push error: ' + err.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '📤 Push Today\'s Codes Now'; }
  }
};
window.oracleMarkAlertsRead = async () => {
  try {
    state.alertState = await api('/api/alerts/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    updateAlertsBadge(0);
    renderAlertsDialog();
  } catch { /* ignore */ }
};
$('#open-alerts')?.addEventListener('click', () => openAlertsDialog());

// ---------- selector ----------

function renderSelector() {
  const info = leagueInfo();
  state.sport = info?.sport || state.catalog[0]?.id;
  $('#sports').innerHTML = state.catalog
    .map((s) => `<button class="sport-btn" role="tab" aria-selected="${s.id === state.sport}" data-sport="${s.id}">${s.icon} ${esc(s.name)}</button>`)
    .join('');
  const sport = state.catalog.find((s) => s.id === state.sport);
  $('#leagues').innerHTML = (sport?.leagues || [])
    .map((l) => `<button class="chip" aria-pressed="${l.id === state.league}" data-league="${l.id}">${esc(l.name)}</button>`)
    .join('');
  $('.selector').hidden = ['track', 'picks', 'props', 'tickets', 'vault', 'radar', 'arena'].includes(state.view);
}

document.addEventListener('click', (e) => {
  const sb = e.target.closest('[data-sport]');
  if (sb) {
    const sport = state.catalog.find((s) => s.id === sb.dataset.sport);
    setLeague(sport.leagues[0].id);
    return;
  }
  const lb = e.target.closest('[data-league]');
  if (lb) setLeague(lb.dataset.league);
});

function setLeague(id) {
  state.league = id;
  state.date = '';
  localStorage.setItem('league', id);
  renderSelector();
  render();
}

// ---------- games view ----------

function shiftDate(days) {
  const base = state.date ? new Date(state.date + 'T12:00:00') : new Date();
  base.setDate(base.getDate() + days);
  state.date = base.toISOString().slice(0, 10);
  render();
}

function modelBanner(m) {
  if (!m) return '';
  const e = m.metrics.ensemble;
  const vm = m.vsMarket;
  const ver = m.version ? `<span class="tag ok" style="margin-right:.4rem">Champion v${m.version}</span>` : '';
  return `<div class="model-banner">
    <span>🧠 ${ver}<b>${m.games.toLocaleString()}</b> games learned <span class="muted">(${new Date(m.from).toLocaleDateString()} – ${new Date(m.to).toLocaleDateString()})</span></span>
    ${e?.n ? `<span>🎯 Holdout accuracy <b>${pct1(e.accuracy)}</b> <span class="muted">(${e.n} games)</span></span>
    <span>📉 Brier <b>${fx(e.brier)}</b></span>` : ''}
    ${vm ? `<span>📊 vs market: ours ${pct1(vm.ensemble.accuracy)} / market ${pct1(vm.market.accuracy)}</span>` : ''}
    <a href="#/lab">Model details & evolution →</a>
  </div>`;
}

function card(g, L) {
  const p = g.prediction?.ensemble?.probs;
  const pick = g.prediction?.ensemble?.pick;
  const order = homeFirst() ? ['home', 'away'] : ['away', 'home'];
  const showScore = g.state !== 'pre';
  const rows = order.map((s) => {
    const t = g[s];
    const cls = g.completed ? (t.winner ? 'winner' : (g.home.winner || g.away.winner) ? 'loser' : '') : '';
    return `<div class="team-row ${cls}">
      ${logo(t)}
      <span class="team-name">${esc(t.name)}${t.record ? `<span class="rec">${esc(t.record)}</span>` : ''}</span>
      <span class="pct" style="color:var(--${s === 'home' ? 'home' : 'away'})">${pct(p?.[s])}</span>
      ${showScore ? `<span class="score">${t.score ?? (t.linescores ? t.linescores.join(' ') : '')}</span>` : ''}
    </div>`;
  }).join('');

  const tags = [];
  if (pick) tags.push(`<span class="tag pick">Pick: ${esc(teamLabel(pick, g))} ${pct(p[pick])} (@${fairOdds(p[pick])})</span>`);
  if (L.draws && p) tags.push(`<span class="tag">Draw ${pct(p.draw)}</span>`);
  const mk = g.prediction?.market;
  if (mk) {
    const edge = p[pick] - mk[pick];
    tags.push(`<span class="tag" title="Betting market implied probability (vig removed)">Market ${pct(mk[pick])}</span>`);
    if (g.state === 'pre' && Math.abs(edge) >= 0.07) tags.push(`<span class="tag value" title="Our model disagrees with the market">${edge > 0 ? '+' : ''}${Math.round(edge * 100)}% vs market</span>`);
  }
  if (g.completed && pick) {
    const actual = g.home.winner ? 'home' : g.away.winner ? 'away' : (g.home.score === g.away.score ? 'draw' : g.home.score > g.away.score ? 'home' : 'away');
    tags.push(actual === pick ? '<span class="tag ok">✓ Correct</span>' : '<span class="tag miss">✗ Missed</span>');
  }
  if (g.prediction?.dataQuality === 'low') tags.push('<span class="tag" title="Few past games for one side — lower confidence">Low data</span>');

  const status = g.state === 'in' ? `<span class="live">${esc(g.statusText)}</span>` : g.state === 'post' ? esc(g.statusText || 'Final') : fmtTime(g.date);
  return `<button class="card" data-game="${esc(g.id)}">
    <div class="card-head"><span>${status}</span><span>${esc(g.tournament ? `${g.tournament}${g.round ? ' · ' + g.round : ''}` : g.venue || '')}</span></div>
    ${rows}
    ${bar(p, L.draws)}
    <div class="card-foot">${tags.join('')}</div>
  </button>`;
}

async function renderGames() {
  const main = $('#main');
  const L = leagueInfo();
  const today = new Date().toISOString().slice(0, 10);
  main.innerHTML = `
    <div class="toolbar">
      <div class="date-nav">
        <button class="btn" id="prev" aria-label="Previous day">◀</button>
        <input type="date" id="date" value="${state.date || today}" aria-label="Date">
        <button class="btn" id="next" aria-label="Next day">▶</button>
        <button class="btn" id="today">Current</button>
      </div>
      <div class="filters" role="group" aria-label="Filter games">
        ${['all', 'upcoming', 'live', 'final'].map((f) => `<button class="chip" data-filter="${f}" aria-pressed="${state.filter === f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}
      </div>
    </div>
    <div id="games-area"><p class="loading"><span class="spinner"></span> Loading ${esc(L?.name)} predictions…</p></div>`;
  $('#prev').onclick = () => shiftDate(-1);
  $('#next').onclick = () => shiftDate(1);
  $('#today').onclick = () => { state.date = ''; render(); };
  $('#date').onchange = (e) => { state.date = e.target.value; render(); };
  main.querySelectorAll('[data-filter]').forEach((b) => (b.onclick = () => { state.filter = b.dataset.filter; render(); }));

  const reqLeague = state.league;
  try {
    const data = await api(`/api/games/${state.league}${state.date ? `?date=${state.date}` : ''}`);
    if (reqLeague !== state.league || state.view !== 'games') return;
    state.games = data;
    const area = $('#games-area');
    let games = data.games;
    if (state.filter === 'upcoming') games = games.filter((g) => g.state === 'pre');
    if (state.filter === 'live') games = games.filter((g) => g.state === 'in');
    if (state.filter === 'final') games = games.filter((g) => g.state === 'post');
    const legend = `<div class="legend"><span><i style="background:var(--home)"></i>Home / first listed</span>${data.league.draws ? '<span><i style="background:var(--draw)"></i>Draw</span>' : ''}<span><i style="background:var(--away)"></i>Away / second listed</span></div>`;
    area.innerHTML = modelBanner(data.model) +
      (games.length
        ? `${legend}<div class="grid" style="margin-top:.75rem">${games.map((g) => card(g, data.league)).join('')}</div>`
        : `<p class="empty">No ${state.filter === 'all' ? '' : state.filter + ' '}games for this date. Try another day or press <b>Current</b>.</p>`);
  } catch (err) {
    $('#games-area').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

$('#main').addEventListener('click', (e) => {
  const c = e.target.closest('[data-game]');
  if (c) openGame(c.dataset.game);
});

// ---------- game detail dialog ----------

const dialog = $('#detail');
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const outside = (e, dlg) => {
    const r = dlg.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dlg of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dlg.addEventListener('pointerdown', (e) => { pressedOutside = outside(e, dlg); });
    dlg.addEventListener('pointerup', (e) => { if (pressedOutside && outside(e, dlg)) dlg.close(); });
  }
}

let detail = null;

async function openGame(id) {
  $('#detail-body').innerHTML = `<div class="d-head"><h2 id="detail-title">Loading…</h2><form method="dialog"><button class="close" aria-label="Close">✕</button></form></div><div class="d-body"><p class="loading"><span class="spinner"></span> Loading matchup…</p></div>`;
  dialog.showModal();
  try {
    const data = await api(`/api/game/${state.league}/${encodeURIComponent(id)}${state.date ? `?date=${state.date}` : ''}`);
    detail = { data, ai: null, aiLoading: false, aiError: null };
    state.mktTab = 'All';
    renderDetail();
  } catch (err) {
    $('#detail-body .d-body').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

function sourcesRows() {
  const { data, ai } = detail;
  const { game, prediction: P, summary, league } = data;
  const rows = [];
  rows.push({ name: '⭐ Our ensemble', note: 'Weighted blend of the statistical models', p: P.ensemble.probs, hl: true });
  rows.push({ name: 'Elo ratings', note: `${P.models.elo.ratings.home} vs ${P.models.elo.ratings.away}`, p: P.models.elo.probs });
  if (P.models.score) rows.push({ name: league.draws || ['hockey', 'baseball'].includes(league.sport) ? 'Poisson scoring model' : 'Points model (normal)', note: `Exp. ${P.models.score.expected.home}–${P.models.score.expected.away}`, p: P.models.score.probs });
  if (P.models.ml) rows.push({ name: 'Machine learning', note: 'Logistic regression', p: P.models.ml.probs });
  if (P.market) rows.push({ name: `💰 Betting market`, note: `${game.odds.provider}${game.odds.details ? ' · ' + game.odds.details : ''}`, p: P.market });
  const ep = summary?.espnPredictor;
  if (ep && ep.home != null) {
    const flip = ep.homeId && ep.homeId !== game.home.id && ep.homeId === game.away.id;
    const p = flip ? { home: ep.away, draw: ep.tie || 0, away: ep.home } : { home: ep.home, draw: ep.tie || 0, away: ep.away };
    rows.push({ name: '📺 ESPN analytics', note: ep.label, p });
  }
  if (ai) {
    rows.push({ name: '🤖 Gemini AI', note: `${ai.confidence} confidence · ${ai.predictedScore || ''}`, p: ai.probabilities });
    const ex = (ai.expertPicks || []).filter((x) => x.pick && x.pick !== 'unknown');
    if (ex.length) {
      const c = { home: 0, draw: 0, away: 0 };
      ex.forEach((x) => c[x.pick]++);
      rows.push({ name: '🗣️ Human experts', note: `${ex.length} published pick${ex.length > 1 ? 's' : ''} (share of picks)`, p: { home: c.home / ex.length, draw: c.draw / ex.length, away: c.away / ex.length } });
    }
  }
  return rows;
}

function comparisonTable() {
  const { data } = detail;
  const { game, league } = data;
  const rows = sourcesRows();
  const ours = pickOf(rows[0].p);
  const agree = rows.slice(1).filter((r) => pickOf(r.p) === ours).length;
  return `<section class="panel">
    <h3>Prediction comparison <span class="muted">models vs market vs experts</span></h3>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Source</th><th class="n">${esc(game.home.short)}</th>${league.draws ? '<th class="n">Draw</th>' : ''}<th class="n">${esc(game.away.short)}</th><th>Pick</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.hl ? 'highlight' : ''}">
        <td>${esc(r.name)}<div class="muted small">${esc(r.note || '')}</div></td>
        <td class="n">${pct(r.p.home)}</td>${league.draws ? `<td class="n">${pct(r.p.draw)}</td>` : ''}<td class="n">${pct(r.p.away)}</td>
        <td>${esc(teamLabel(pickOf(r.p), game))}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="small muted" style="margin:.75rem 0 0">Consensus: <b>${agree} of ${rows.length - 1}</b> other sources agree with our pick (${esc(teamLabel(ours, game))}).</p>
  </section>`;
}

function smartPickBanner(smart, g) {
  if (!smart?.probs) return '';
  const pick = pickOf(smart.probs);
  const w = smart.weights;
  const parts = [];
  if (w.ours) parts.push(`Ours ${(w.ours * 100).toFixed(0)}%`);
  if (w.market) parts.push(`Market ${(w.market * 100).toFixed(0)}%`);
  if (w.ai) parts.push(`AI ${(w.ai * 100).toFixed(0)}%`);
  return `
    <div class="smart-banner">
      <div class="smart-banner-head">
        <b>🧠 Smart Pick: ${esc(teamLabel(pick, g))} <span class="num">${pct(smart.probs[pick])}</span> (@${fairOdds(smart.probs[pick])})</b>
        <span class="tag pick">${smart.learned ? 'Learned trust' : 'Prior trust'}</span>
      </div>
      <div class="smart-weights">
        <span>Trust blend: ${parts.join(' · ')}</span>
        <span class="muted">Optimized to minimize log loss on graded results.</span>
      </div>
    </div>`;
}

function renderMarketsSection(markets, g, league) {
  if (!markets?.length) return '';
  const groups = ['All', ...new Set(markets.map((m) => m.group))];
  const activeTab = state.mktTab || 'All';
  const visible = activeTab === 'All' ? markets : markets.filter((m) => m.group === activeTab);

  const tabsHtml = groups.map((grp) => `<button type="button" class="chip" aria-selected="${grp === activeTab}" data-mkt-tab="${esc(grp)}">${esc(grp)}</button>`).join('');

  const cardsHtml = visible.map((m) => {
    const selsHtml = m.selections.map((s) => {
      const pickId = `${g.id}:${m.key}:${s.key}`;
      const inSlip = state.slip.some((x) => x.id === pickId);
      const payload = JSON.stringify({
        id: pickId,
        gameId: g.id,
        matchup: `${g.away.name} @ ${g.home.name}`,
        date: g.date,
        league: league.id,
        leagueName: league.name,
        sport: league.sport,
        marketKey: m.key,
        market: m.name,
        sportyMarket: m.sporty || m.name,
        selKey: s.key,
        label: s.label,
        sportyPick: s.sportyPick || s.label,
        p: s.p,
      }).replace(/"/g, '&quot;');
      return `
        <button type="button" class="sel-btn ${inSlip ? 'in-slip' : ''}" data-slip-pick="${esc(pickId)}" data-slip-payload="${payload}">
          <span class="sel-lbl">${esc(s.label)}</span>
          <span class="sel-meta">
            <b>${pct(s.p)}</b>
            <span class="muted">@ ${fairOdds(s.p)}</span>
            <span class="sel-status" style="color:var(--brand);font-weight:700">${inSlip ? '✓ Slip' : '+ Slip'}</span>
          </span>
        </button>`;
    }).join('');

    return `
      <div class="mkt-card">
        <div class="mkt-card-head">
          <span>${esc(m.name)}${m.expected ? ` <span class="muted small">(exp. ${m.expected.home}–${m.expected.away})</span>` : ''}</span>
          <span class="sporty-tag">SportyBet: ${esc(m.sporty || m.name)}</span>
        </div>
        <div class="sel-grid">${selsHtml}</div>
      </div>`;
  }).join('');

  return `
    <section class="panel">
      <h3>All betting markets <span class="muted">SportyBet Ghana options · tap any pick to add to Betslip</span></h3>
      <div class="mkt-tabs" role="tablist">${tabsHtml}</div>
      <div class="mkt-group">${cardsHtml}</div>
    </section>`;
}

function formStr(s) {
  return s ? `<span class="form-str">${[...s].map((c) => `<span class="${c}">${c}</span>`).join('')}</span>` : '<span class="muted">–</span>';
}

function renderDirectSportyStrip(sportySelections) {
  if (!sportySelections?.length) return '';
  const topSels = sportySelections
    .filter((s) => s.p >= 0.55 && s.sportyOdds >= 1.15 && !['cs', 'multiscore'].includes(s.marketKey))
    .slice(0, 10);
  if (!topSels.length) return '';
  return `
    <section class="panel" style="border-left:4px solid #e41827">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.6rem">
        <h3 style="margin:0">🇬🇭 Live SportyBet Ghana Direct-Bookable Markets (${sportySelections.length} Real Selections)</h3>
        <span class="tag ok">✓ Matched to Live SportyBet Feed</span>
      </div>
      <div class="sel-grid">
        ${topSels.map((s) => {
          const inSlip = state.slip.some((x) => x.id === s.id);
          const payload = JSON.stringify(s).replace(/"/g, '&quot;');
          const om = s.oddsMovement;
          return `
            <button type="button" class="sel-btn ${inSlip ? 'in-slip' : ''}" data-slip-pick="${esc(s.id)}" data-slip-payload="${payload}">
              <span class="sel-lbl">${esc(s.sportyPick)} <span class="muted small">(${esc(s.sportyMarket)})</span></span>
              <span class="sel-meta">
                <b>@${s.sportyOdds}</b>
                <span class="muted">${pct(s.p)}</span>
                ${om?.isSteamCrash ? `<span class="tag ok" style="font-size:.66rem">📉 -${om.dropPct}%</span>` : ''}
                ${(s.edgePct || 0) >= 1.5 ? `<span class="tag value" style="font-size:.68rem">+${s.edgePct}% EV</span>` : ''}
                <span class="sel-status" style="color:var(--brand);font-weight:700">${inSlip ? '✓ Slip' : '+ Slip'}</span>
              </span>
            </button>`;
        }).join('')}
      </div>
    </section>`;
}

function renderLineupAndRefereePanel(li, g) {
  if (!li) return '';
  const renderSideXI = (sideObj, teamName) => {
    if (!sideObj) return '';
    const rotTxt = sideObj.rotatedCount != null
      ? `${sideObj.rotatedCount} change${sideObj.rotatedCount === 1 ? '' : 's'} vs previous XI (${sideObj.retainedStarters}/11 retained)`
      : sideObj.prevStartersCount
        ? `Previous XI benchmarked (${sideObj.prevStartersCount} starters${sideObj.prevFormation ? ` · ${sideObj.prevFormation}` : ''})`
        : 'Official XI posts ~60m pre-kickoff';
    const startersLine = sideObj.confirmed && sideObj.starters?.length
      ? `<div class="small" style="margin-top:.3rem;line-height:1.4"><b>Starting XI${sideObj.formation ? ` (${esc(sideObj.formation)})` : ''}:</b> ${sideObj.starters.map((p) => esc(p.name)).join(', ')}</div>`
      : '';
    const missingScorersLine = sideObj.missingTopScorers?.length
      ? `<div class="small" style="color:var(--bad);margin-top:.2rem">⚠ Missing Top Scorer(s): ${sideObj.missingTopScorers.map((p) => `${esc(p.name)} (${p.goals}g)`).join(', ')}</div>`
      : sideObj.topScorers?.length
        ? `<div class="small muted" style="margin-top:.2rem">⚽ Season Top Scorers: ${sideObj.topScorers.slice(0, 3).map((p) => `${esc(p.name)} (${p.goals}g)`).join(', ')}</div>`
        : '';
    return `
      <div style="background:var(--bg-alt);border:1px solid var(--border);border-radius:9px;padding:.6rem .75rem">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:.35rem;flex-wrap:wrap">
          <b>${esc(teamName)}</b>
          <span class="tag ${sideObj.confirmed ? 'ok' : 'muted'}">${sideObj.confirmed ? '✅ Confirmed XI' : '⏳ Pre-Lineup Check'}</span>
        </div>
        <div class="small muted" style="margin-top:.15rem">${esc(rotTxt)}</div>
        ${startersLine}
        ${missingScorersLine}
      </div>`;
  };

  const sp = li.seasonPropProfile;
  return `
    <section class="panel" style="border-left:4px solid var(--brand)">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.6rem">
        <h3 style="margin:0">🧑‍⚖️ Lineups, Squad Rotation, Referee &amp; Official Season Prop Averages</h3>
        <span class="tag ${li.lineupConfirmed ? 'ok' : 'pick'}">${esc(li.lineupStatusLabel || 'Pre-Match Veto Gate Active')}</span>
      </div>
      <div style="display:flex;gap:.55rem;flex-wrap:wrap;margin-bottom:.65rem;font-size:.82rem">
        ${li.referee ? `<span class="tag">🧑‍⚖️ Referee: <b>${esc(li.referee.name)}</b>${li.referee.country ? ` (${esc(li.referee.country)})` : ''}</span>` : '<span class="tag muted">🧑‍⚖️ Referee: Pending official assignment</span>'}
        ${li.stadium ? `<span class="tag">🏟️ ${esc(li.stadium.name)}${li.stadium.city ? `, ${esc(li.stadium.city)}` : ''}${li.stadium.capacity ? ` (${Number(li.stadium.capacity).toLocaleString()})` : ''}</span>` : ''}
        ${sp ? `<span class="tag ok">📊 Combined Season Avgs: <b>${sp.combinedShotsAvg}</b> Shots · <b>${sp.combinedSotAvg}</b> SOT · <b>${sp.combinedCornersAvg}</b> Crn · <b>${sp.combinedCardsAvg}</b> Cards</span>` : ''}
      </div>
      <div class="cols">
        ${renderSideXI(li.homeLineup, g.home.name)}
        ${renderSideXI(li.awayLineup, g.away.name)}
      </div>
      ${li.funFacts?.length ? `<ul class="clean small muted" style="margin:.6rem 0 0">${li.funFacts.map((f) => `<li>📌 ${esc(f)}</li>`).join('')}</ul>` : ''}
    </section>`;
}

function renderDetail() {
  const { data, ai, aiLoading, aiError } = detail;
  const { game: g, prediction: P, summary: S, league } = data;
  const sc = P.models.score;
  const first = homeFirst() ? 'home' : 'away';
  const second = first === 'home' ? 'away' : 'home';
  const side = (s) => `<div>${logo(g[s], 64)}<div><b>${esc(g[s].name)}</b></div><div class="muted small">${esc(g[s].record || '')} · ${s === 'home' && league.kind === 'team' ? 'Home' : s === 'away' && league.kind === 'team' ? 'Away' : ''}</div>
    ${g.state !== 'pre' ? `<div class="big">${g[s].score ?? (g[s].linescores || []).join(' ')}</div>` : `<div class="big" style="color:var(--${s})">${pct(P.ensemble.probs[s])}</div>`}</div>`;

  const injuries = (S?.injuries || []).filter((t) => t.players.length);
  $('#detail-body').innerHTML = `
    <div class="d-head">
      <h2 id="detail-title">${esc(g[first].name)} ${homeFirst() ? 'vs' : '@'} ${esc(g[second].name)}</h2>
      <form method="dialog"><button class="close" aria-label="Close">✕</button></form>
    </div>
    <div class="d-body">
      <div class="matchup">${side(first)}<div class="vs">${g.state === 'pre' ? fmtTime(g.date) : esc(g.statusText)}<div class="small muted">${esc(g.tournament || g.venue || '')}</div>${league.draws && g.state === 'pre' ? `<div class="small">Draw ${pct(P.ensemble.probs.draw)}</div>` : ''}</div>${side(second)}</div>
      ${bar(P.ensemble.probs, league.draws)}

      ${smartPickBanner(P.smart, g)}

      ${renderLineupAndRefereePanel(data.lineupIntel, g)}

      ${renderDirectSportyStrip(data.sportySelections)}

      ${comparisonTable()}

      ${renderMarketsSection(P.markets, g, league)}

      <div class="cols">
        ${sc ? `<section class="panel"><h3>Score projection</h3>
          <div class="stat-grid">
            <div class="stat"><div class="k">Expected</div><div class="v">${sc.expected.home}–${sc.expected.away}</div><div class="small muted">home–away</div></div>
            <div class="stat"><div class="k">Most likely</div><div class="v">${esc(sc.likely)}</div></div>
            <div class="stat"><div class="k">Total</div><div class="v">${sc.total}</div>${g.odds?.overUnder ? `<div class="small muted">Market O/U ${g.odds.overUnder}</div>` : ''}</div>
            ${sc.spread != null ? `<div class="stat"><div class="k">Spread (home)</div><div class="v">${sc.spread > 0 ? '+' : ''}${sc.spread}</div>${g.odds?.details ? `<div class="small muted">Market ${esc(g.odds.details)}</div>` : ''}</div>` : ''}
          </div></section>` : ''}
        <section class="panel"><h3>Form & ratings</h3>
          <table><tbody>
            <tr><th></th><th>${esc(g.home.short)}</th><th>${esc(g.away.short)}</th></tr>
            <tr><td>Last 5</td><td>${formStr(P.form.home.streak)}</td><td>${formStr(P.form.away.streak)}</td></tr>
            <tr><td>Elo</td><td class="num">${P.models.elo.ratings.home}</td><td class="num">${P.models.elo.ratings.away}</td></tr>
            <tr><td>Rest (days)</td><td class="num">${Math.round(P.form.home.rest)}</td><td class="num">${Math.round(P.form.away.rest)}</td></tr>
            <tr><td>Games in data</td><td class="num">${P.form.home.n}</td><td class="num">${P.form.away.n}</td></tr>
          </tbody></table>
          ${P.dataQuality !== 'good' ? `<p class="small" style="color:var(--warn)">⚠ ${P.dataQuality === 'low' ? 'Very little' : 'Limited'} history for one side — treat with caution.</p>` : ''}
        </section>
      </div>

      ${injuries.length ? `<section class="panel"><h3>Injury report <span class="muted">ESPN</span></h3><div class="cols">
        ${injuries.map((t) => `<div><b>${esc(t.team)}</b><ul class="clean small">${t.players.map((p) => `<li>${esc(p.name)} <span class="muted">${esc(p.position || '')}</span> — ${esc(p.status || '')} ${esc(p.detail || '')}</li>`).join('')}</ul></div>`).join('')}
      </div></section>` : ''}

      <section class="panel ai-box" aria-live="polite">
        <h3>🤖 AI analyst <span class="muted">Gemini + Google Search: news, injuries & expert picks</span></h3>
        ${ai ? aiResult(ai, g) : aiLoading
          ? '<p><span class="spinner"></span> Gemini is researching the latest news and expert predictions… (15–60s)</p>'
          : data.aiEnabled
            ? `${aiError ? `<p class="error">${esc(aiError)}</p>` : ''}<button class="btn primary" id="run-ai">Run AI analysis</button>`
            : '<p class="muted">Add <code>GEMINI_API_KEY</code> to the <code>.env</code> file and restart the server to enable the AI analyst and expert comparison.</p>'}
      </section>

      ${S?.news?.length ? `<section class="panel"><h3>Latest news</h3><ul class="clean small">${S.news.map((n) => `<li>${n.link ? `<a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.headline)}</a>` : esc(n.headline)}</li>`).join('')}</ul></section>` : ''}
    </div>`;

  $('#run-ai')?.addEventListener('click', () => runAi());
  $('#rerun-ai')?.addEventListener('click', () => runAi(true));

  // Market tabs event delegation
  $('#detail-body').addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-mkt-tab]');
    if (tabBtn) {
      state.mktTab = tabBtn.dataset.mktTab;
      renderDetail();
      return;
    }
    const slipBtn = e.target.closest('[data-slip-payload]');
    if (slipBtn) {
      const item = JSON.parse(slipBtn.dataset.slipPayload);
      addToSlip(item);
      renderDetail();
    }
  });
}

function aiResult(ai, g) {
  const pickName = teamLabel(ai.pick, g);
  return `
    <p class="ai-summary"><b>Pick: ${esc(pickName)}</b> (${pct(ai.probabilities[ai.pick])}, ${esc(ai.confidence)} confidence)${ai.predictedScore ? ` · Predicted: <b>${esc(ai.predictedScore)}</b>` : ''}</p>
    ${ai.lessonsUsed ? `<div class="tag ok" style="margin-bottom:.5rem">🧠 ${ai.lessonsUsed} past lesson(s) applied to this analysis</div>` : ai.lessonsWithheld ? `<div class="tag" style="margin-bottom:.5rem">🔬 Memory holdout test (lessons withheld to evaluate impact)</div>` : ''}
    <p>${esc(ai.summary)}</p>
    <div class="cols">
      <div><h4>Key factors</h4><ul class="clean small">${(ai.keyFactors || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>
      ${ai.injuries?.length ? `<div><h4>Absences found</h4><ul class="clean small">${ai.injuries.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
    </div>
    <h4>Expert picks found</h4>
    ${(ai.expertPicks || []).length ? ai.expertPicks.map((x) => `<div class="expert"><div><b>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.source)}</a>` : esc(x.source)}</b><div class="small muted">${esc(x.detail)}</div></div><span class="tag ${x.pick === ai.pick ? 'ok' : ''}">${esc(x.pick === 'unknown' ? '?' : teamLabel(x.pick, g))}</span></div>`).join('') : '<p class="small muted">No published expert picks found for this game.</p>'}
    <h4>Vs. our models & the market</h4>
    <p class="small">${esc(ai.modelAssessment)}</p>
    ${ai.valueNote && ai.valueNote.toLowerCase() !== 'none' ? `<p class="small"><span class="tag value">Value</span> ${esc(ai.valueNote)}</p>` : ''}
    ${ai.sources?.length ? `<div class="sources small"><span class="muted">Sources: </span>${ai.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}">${esc(s.title)}</a>`).join('')}</div>` : ''}
    <p class="small muted">Generated ${new Date(ai.generatedAt).toLocaleString()} by ${esc(ai.model)} · <button class="btn" id="rerun-ai" style="padding:.2rem .6rem">Refresh</button></p>`;
}

async function runAi(force = false) {
  const { game } = detail.data;
  detail.aiLoading = true;
  detail.aiError = null;
  detail.ai = null;
  renderDetail();
  try {
    const qsParts = [state.date ? `date=${state.date}` : '', force ? 'force=1' : ''].filter(Boolean).join('&');
    detail.ai = await api(`/api/ai/${state.league}/${encodeURIComponent(game.id)}${qsParts ? '?' + qsParts : ''}`, { method: 'POST' });
  } catch (err) {
    detail.aiError = err.message;
  }
  detail.aiLoading = false;
  if (dialog.open) renderDetail();
}

// ---------- AI Tickets & Live SportyBet Ghana Code View (Command Center + Rollover + Synthesizer) ----------

function renderFlexDirectiveBanner(fd, legs = [], podSplits = null) {
  if (!fd) return '';
  const tierCls = fd.tier === 'MANDATORY_MAX_FLEX'
    ? 'tier-mandatory'
    : fd.tier === 'FLEX_CUT2'
      ? 'tier-cut2'
      : fd.tier === 'FLEX_CUT1'
        ? 'tier-cut1'
        : 'tier-straight';

  const n = legs.length;
  let podBtnsHtml = '';
  if (Array.isArray(podSplits) && podSplits.length >= 2) {
    podBtnsHtml = `
      <div style="margin-top:.35rem">
        <div class="small" style="font-weight:800;margin-bottom:.2rem">🇬🇭 Pre-Booked SportyBet Ghana Pod Split Codes (Ready 6-Char Codes):</div>
        <div class="pod-codes-grid">
          ${podSplits.map((pod) => {
            const podLegsJson = JSON.stringify(pod.legs || []).replace(/"/g, '&quot;');
            return `
              <div class="pod-code-card">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:.25rem">
                  <b>✂️ ${esc(pod.podLabel || `Pod ${pod.podId}`)}</b>
                  <span class="muted" style="font-size:.68rem">${esc(pod.legRange || `${pod.count} Games`)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:baseline;gap:.3rem">
                  <span class="pod-code-val">${esc(pod.shareCode || 'LIVE')}</span>
                  <span style="font-weight:800;font-size:.76rem">@${fmtOdds(pod.totalSportyOdds)}</span>
                </div>
                <div style="display:flex;gap:.25rem;flex-wrap:wrap">
                  ${pod.shareCode ? `<button type="button" class="btn" style="padding:.16rem .42rem;font-size:.68rem" onclick="window.oracleCopyCode('${esc(pod.shareCode)}', this)">📋 Copy</button>` : ''}
                  ${pod.shareURL ? `<a class="btn btn-sporty" style="padding:.16rem .45rem;font-size:.68rem;text-decoration:none" href="${esc(pod.shareURL)}" target="_blank" rel="noopener">🚀 Book</a>` : ''}
                  <button type="button" class="btn" style="padding:.16rem .42rem;font-size:.68rem" onclick="window.oracleLoadTicket(${podLegsJson}, false, '${esc(pod.shareCode || '')}')">📥 Slip</button>
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  } else if (n >= 20) {
    const numPods = n >= 40 ? 4 : n >= 27 ? 3 : 2;
    const podSize = Math.ceil(n / numPods);
    const btns = [];
    for (let p = 0; p < numPods; p++) {
      const slice = legs.slice(p * podSize, (p + 1) * podSize);
      if (slice.length < 2) continue;
      const sliceJson = JSON.stringify(slice).replace(/"/g, '&quot;');
      btns.push(`<button type="button" class="btn" style="padding:.22rem .5rem;font-size:.72rem" onclick="window.oracleLoadTicket(${sliceJson}, false, null)">✂️ Load Pod #${p + 1} (${slice.length} Games)</button>`);
    }
    if (btns.length > 1) {
      podBtnsHtml = `<div style="display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.25rem">${btns.join('')}</div>`;
    }
  }

  return `
    <div class="flex-directive-box ${tierCls}">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.35rem">
        <b style="font-size:.82rem">${esc(fd.badge)}</b>
        <span class="small" style="font-weight:800">Exp. Hits: ${fd.expectedHits}/${n} (${Math.round((fd.avgLegProb || 0.7) * 100)}% Avg Leg)</span>
      </div>
      <div class="muted" style="line-height:1.35">${esc(fd.detail)}</div>
      <div class="flex-prob-strip">
        <span class="flex-prob-pill">Straight (${n}/${n}): ${(fd.pFull * 100).toFixed(1)}%</span>
        ${n >= 4 ? `<span class="flex-prob-pill">Flex Cut-1 (${n - 1}+/${n}): ${(fd.pCut1 * 100).toFixed(1)}%</span>` : ''}
        ${n >= 7 ? `<span class="flex-prob-pill">Flex Cut-2 (${n - 2}+/${n}): ${(fd.pCut2 * 100).toFixed(1)}%</span>` : ''}
        ${n >= 15 ? `<span class="flex-prob-pill">Flex Cut-3 (${n - 3}+/${n}): ${(fd.pCut3 * 100).toFixed(1)}%</span>` : ''}
        ${n >= 30 ? `<span class="flex-prob-pill">Cut-5 Zone (${n - 5}+/${n}): ${(fd.pCut5 * 100).toFixed(1)}%</span>` : ''}
      </div>
      ${podBtnsHtml}
    </div>`;
}

function renderTicketCard(t, highlight = false) {
  const legsHtml = (t.legs || []).map((leg, i) => {
    const evTag = (leg.edgePct || 0) >= 2.0 ? `<span class="tag value" style="font-size:.66rem;padding:.08rem .35rem">+${leg.edgePct}% EV</span>` : '';
    const om = leg.oddsMovement;
    const steamTag = om?.isSteamCrash
      ? `<span class="tag ok" style="font-size:.66rem;padding:.08rem .35rem" title="Real observed SportyBet drop @${om.openOdds} → @${om.curOdds}">📉 -${om.dropPct}%</span>`
      : (leg.steamPct || 0) >= 4.0
        ? `<span class="tag ok" style="font-size:.66rem;padding:.08rem .35rem">📉 Steam</span>`
        : '';
    const histLine = leg.historySummary || leg.historyBadge;
    const luLine = leg.lineupBadge;
    return `
      <div class="ticket-leg" style="flex-wrap:wrap">
        <span style="flex:1.25;min-width:185px">
          <b>${i + 1}.</b>
          <span class="small muted">${esc(leg.leagueName || leg.league)}:</span>
          ${esc(leg.matchup)}
        </span>
        <span class="leg-pick" style="text-align:right">
          ${esc(leg.sportyPick || leg.label)}
          <span class="muted small">(${pct(leg.p)})</span>
          ${evTag}${steamTag}
        </span>
        <span class="leg-odds">@${leg.sportyOdds || leg.fairOdds}</span>
        ${histLine ? `<div style="flex-basis:100%;font-size:.7rem;color:var(--muted);padding-left:1rem;margin-top:.1rem">📜 ${esc(histLine)}</div>` : ''}
        ${luLine ? `<div style="flex-basis:100%;font-size:.68rem;color:var(--good);padding-left:1rem;margin-top:.06rem">${esc(luLine)}</div>` : ''}
      </div>`;
  }).join('');

  const legsPayload = JSON.stringify(t.legs || []).replace(/"/g, '&quot;');
  const ticketPayload = JSON.stringify(t).replace(/"/g, '&quot;');
  const totalOdds = t.totalSportyOdds || t.combinedFairOdds || 1;
  const stakeSample = totalOdds >= 50000 ? 10 : 50;
  const rawWin = stakeSample * totalOdds;
  const estReturnSample = rawWin >= 1e6
    ? `${(rawWin / 1e6).toFixed(2)}M (${Math.round(rawWin).toLocaleString()})`
    : rawWin.toLocaleString(undefined, { minimumFractionDigits: rawWin >= 1000 ? 0 : 2, maximumFractionDigits: rawWin >= 1000 ? 0 : 2 });
  const kickoffRel = t.earliestKickoff ? fmtKickoffRelative(t.earliestKickoff) : '';
  const histCount = (t.legs || []).filter((l) => l.historyVerified || l.historySummary || l.historyBadge).length;

  return `
    <div class="ticket-card" style="${highlight ? 'border:2px solid var(--brand)' : ''}">
      <div class="ticket-card-head">
        <div>
          <h3>${esc(t.title)}</h3>
          <p class="ticket-desc">${esc(t.description || '')}</p>
        </div>
        <span class="tag ${t.shareCode ? 'ok' : 'pick'}">${esc(t.category || `${t.count} Games`)}</span>
      </div>

      <div class="ticket-meta-strip">
        ${kickoffRel ? `<span class="tag">⏱ ${esc(kickoffRel)}</span>` : ''}
        ${histCount > 0 ? `<span class="tag ok">📜 ${histCount}/${t.count} History &amp; H2H Verified</span>` : ''}
        ${Array.isArray(t.podSplits) && t.podSplits.length ? `<span class="tag ok">✂️ ${t.podSplits.length} Pod Codes Ready</span>` : ''}
        ${t.playAdvice ? `<span class="tag pick">💡 ${esc(t.playAdvice)}</span>` : ''}
        ${t.avgEdgePct != null && t.avgEdgePct > 0 ? `<span class="tag value">+${t.avgEdgePct}% Avg Edge</span>` : ''}
        ${t.recommendedBankrollPct ? `<span class="tag muted">Kelly Stake: ${t.recommendedBankrollPct}%</span>` : ''}
      </div>

      ${renderFlexDirectiveBanner(t.flexDirective, t.legs || [], t.podSplits)}

      ${renderSportyCodeBanner(t.shareCode, t.shareURL, t.count, fmtOdds(totalOdds))}

      <div class="ticket-stats">
        <div><span>Games: </span><b>${t.count} / 50</b></div>
        <div><span>Sporty Odds: </span><b>@ ${fmtOdds(totalOdds)}</b></div>
        <div><span>₵${stakeSample} Pays: </span><b style="color:var(--good)">₵${estReturnSample}</b></div>
      </div>

      <div class="ticket-legs">${legsHtml}</div>

      <div class="ticket-actions">
        <button class="btn primary" onclick="window.oracleLoadTicket(${legsPayload}, false, '${esc(t.shareCode || '')}')">📥 Load Slip</button>
        <button class="btn" title="Strip any started/locked games & mint a fresh SportyBet Ghana code" onclick="window.oracleRebookClean({ shareCode: '${esc(t.shareCode || '')}', selections: ${legsPayload} }, this)">🧹 Clean Code</button>
        <button class="btn" title="Stack these picks onto your active slip" onclick="window.oracleLoadTicket(${legsPayload}, true)">➕ Stack</button>
        <button class="btn" title="Track in Live Arena against real-world results" onclick="window.oraclePlaceInArena(${ticketPayload})">🧪 Arena</button>
        <button class="btn btn-whatsapp" onclick="window.oracleShareWhatsApp(${ticketPayload})" title="Share full slip & code on WhatsApp">📲 Share</button>
        <button class="btn" onclick="window.oracleCopyTicket(${ticketPayload})">📋 Copy</button>
      </div>
    </div>`;
}

function renderCommandHero(ov) {
  if (!ov) return '';
  const roll = ov.rolloverTicket;
  const fast = ov.fastCashTicket;
  const mill = ov.twentyMillionTicket || ov.millionTicket;
  const as = ov.arenaSummary;
  const anom = ov.topAnomaly;

  const rollLegsJson = roll?.legs ? JSON.stringify(roll.legs).replace(/"/g, '&quot;') : '[]';
  const fastLegsJson = fast?.legs ? JSON.stringify(fast.legs).replace(/"/g, '&quot;') : '[]';
  const millLegsJson = mill?.legs ? JSON.stringify(mill.legs).replace(/"/g, '&quot;') : '[]';

  return `
    <section class="command-hero" aria-label="Today's Command Center">
      <div class="hero-card rollover">
        <div class="hero-kicker">
          <span>💰 Daily 2.00x Rollover Banker</span>
          ${roll?.earliestKickoff ? `<span>${esc(fmtKickoffRelative(roll.earliestKickoff))}</span>` : ''}
        </div>
        ${roll ? `
          <div class="hero-big" style="color:var(--good)">Code: ${esc(roll.shareCode || 'LIVE')} <span style="font-size:.95rem;color:var(--text)">· @${fmtOdds(roll.totalSportyOdds)}</span></div>
          <div class="small muted">${roll.count} history-verified legs · Avg prob ${pct(roll.legs?.reduce((s, l) => s + (l.p || 0.8), 0) / Math.max(roll.count || 1, 1))} · Straight Play</div>
          <div style="display:flex;gap:.35rem;flex-wrap:wrap;margin-top:auto">
            ${roll.shareCode ? `<button class="btn" style="padding:.32rem .6rem;font-size:.78rem" onclick="window.oracleCopyCode('${esc(roll.shareCode)}', this)">📋 Copy ${esc(roll.shareCode)}</button>` : ''}
            ${roll.shareURL ? `<a class="btn btn-sporty" style="padding:.32rem .65rem;font-size:.78rem" href="${esc(roll.shareURL)}" target="_blank" rel="noopener">🚀 Load</a>` : ''}
            <button class="btn" style="padding:.32rem .55rem;font-size:.78rem" onclick="window.oracleLoadTicket(${rollLegsJson}, false, '${esc(roll.shareCode || '')}')">📥 Slip</button>
          </div>
        ` : '<div class="small muted">Cooking rollover slip…</div>'}
      </div>

      <div class="hero-card million">
        <div class="hero-kicker">
          <span>👑 20-Million+ (50-Game Max)</span>
          <span>${mill ? `${mill.count}/50 Games${mill.podSplits?.length ? ` · ${mill.podSplits.length} Pods` : ''}` : 'Max 50 Games'}</span>
        </div>
        ${mill ? `
          <div class="hero-big" style="color:#a855f7">Code: ${esc(mill.shareCode || 'LIVE')} <span style="font-size:.92rem;color:var(--text)">· @${fmtOdds(mill.totalSportyOdds)}</span></div>
          <div class="small muted">History &amp; Lineup Vetted · Avg <b>${pct(mill.avgLegProb || 0.72)}</b> · 🛡️ <b>MUST FLEX + PODS</b></div>
          <div style="display:flex;gap:.35rem;flex-wrap:wrap;margin-top:auto">
            ${mill.shareCode ? `<button class="btn" style="padding:.32rem .6rem;font-size:.78rem" onclick="window.oracleCopyCode('${esc(mill.shareCode)}', this)">📋 Copy ${esc(mill.shareCode)}</button>` : ''}
            ${mill.shareURL ? `<a class="btn btn-sporty" style="padding:.32rem .65rem;font-size:.78rem" href="${esc(mill.shareURL)}" target="_blank" rel="noopener">🚀 Load 20M+</a>` : ''}
            <button class="btn" style="padding:.32rem .55rem;font-size:.78rem" onclick="window.oracleLoadTicket(${millLegsJson}, false, '${esc(mill.shareCode || '')}')">📥 Slip</button>
          </div>
        ` : '<div class="small muted">Compounding 50 history-verified matches…</div>'}
      </div>

      <div class="hero-card fastcash">
        <div class="hero-kicker">
          <span>⚡ Kickoff Soon &amp; Props</span>
          ${fast?.earliestKickoff ? `<span>${esc(fmtKickoffRelative(fast.earliestKickoff))}</span>` : ''}
        </div>
        ${fast ? `
          <div class="hero-big">Code: ${esc(fast.shareCode || 'LIVE')} <span style="font-size:.95rem;color:var(--brand)">· @${fmtOdds(fast.totalSportyOdds)}</span></div>
          <div class="small muted">${fast.count}-Fold nearest kickoffs · Plus <a href="#/props"><b>Props, 1H &amp; Players →</b></a></div>
          <div style="display:flex;gap:.35rem;flex-wrap:wrap;margin-top:auto">
            ${fast.shareCode ? `<button class="btn" style="padding:.32rem .6rem;font-size:.78rem" onclick="window.oracleCopyCode('${esc(fast.shareCode)}', this)">📋 Copy ${esc(fast.shareCode)}</button>` : ''}
            ${fast.shareURL ? `<a class="btn btn-sporty" style="padding:.32rem .65rem;font-size:.78rem" href="${esc(fast.shareURL)}" target="_blank" rel="noopener">🚀 Load</a>` : ''}
            <button class="btn" style="padding:.32rem .55rem;font-size:.78rem" onclick="window.oracleLoadTicket(${fastLegsJson}, false, '${esc(fast.shareCode || '')}')">📥 Slip</button>
          </div>
        ` : '<div class="small muted">Scanning imminent fixtures…</div>'}
      </div>

      <div class="hero-card arena-pulse">
        <div class="hero-kicker">
          <span>🧪 Real-World Arena Proof</span>
          <span>${as?.totalTickets || 0} Slips Tested</span>
        </div>
        <div class="hero-big" style="color:var(--good)">
          ${as?.standardLegHitRate != null ? `${as.standardLegHitRate}% Leg Hit Rate` : 'Live Grading Active'}
        </div>
        <div class="small muted">
          Flex P&amp;L: <b style="color:${(as?.netProfitFlexGHS || 0) >= 0 ? 'var(--good)' : 'var(--text)'}">${(as?.netProfitFlexGHS || 0) >= 0 ? '+' : ''}₵${(as?.netProfitFlexGHS || 0).toLocaleString()} (${(as?.flexRoiPct || 0) >= 0 ? '+' : ''}${as?.flexRoiPct || 0}% ROI)</b>
          · ${anom ? `<a href="#/radar">🚨 ${ov.anomalyCount} Alerts</a>` : `🔴 ${as?.legsLive || 0} Live`}
        </div>
        <div style="margin-top:auto">
          <a href="#/arena" class="btn primary" style="display:inline-flex;padding:.32rem .7rem;font-size:.78rem;text-decoration:none">🧪 Inspect Real-World Results →</a>
        </div>
      </div>
    </section>`;
}

async function renderTickets() {
  const main = $('#main');
  const win = state.ticketsTimeWindow || 'all';
  main.innerHTML = `<p class="loading"><span class="spinner"></span> Checking team Last-15 form, H2H history &amp; lineups across SportyBet Ghana fixtures &amp; cooking Multi-Match Accumulators + Pre-Booked Pod Codes (≤ 50 Games · up to 20,000,000x+ Odds)…</p>`;

  try {
    const [data, overview] = await Promise.all([
      api(`/api/tickets?window=${encodeURIComponent(win)}`),
      api('/api/overview').catch(() => null),
    ]);
    if (state.view !== 'tickets') return;

    const allTickets = data.tickets || [];
    const activeCat = state.ticketCategoryFilter || 'all';
    const q = (state.ticketSearch || '').trim().toLowerCase();

    const matchTicketCategory = (t, cat) => {
      if (cat === 'rollover') return ['Rollover Banker', 'Fast Cash'].includes(t.category);
      if (cat === 'million') return t.category === 'Multi-Match & 1M+' || t.category === 'Multi-Match & 20M+' || t.ticketType === 'million' || (t.count || 0) >= 25;
      if (cat === 'combos') return t.category === 'Combo Shields' || t.ticketType === 'combos' || t.id === 'combo-shield-banker-8';
      if (cat === 'props') return t.category === 'Tactical Props' || t.ticketType === 'props' || t.id === 'identical-stats-8';
      if (cat === 'vhim') return ['Vhim Banker', 'Mega 20-Fold'].includes(t.category);
      if (cat === 'ev') return ['Positive EV', 'Correlated SGM'].includes(t.category) || t.id === 'value-ev-sniper-6' || t.id === 'correlated-sgm-6';
      if (cat === 'mixed') return t.category === 'Mixed Multi' || t.ticketType === 'mixed';
      if (cat === 'identical') return t.category === 'Identical' || t.ticketType === 'identical';
      if (cat === 'cs') return t.category === 'Correct Score' || t.ticketType === 'cs';
      if (cat === 'insider') return t.category === 'Insider';
      return true;
    };

    const filtered = allTickets.filter((t) => {
      if (!matchTicketCategory(t, activeCat)) return false;
      if (q) {
        const hay = `${t.title} ${t.category} ${t.shareCode || ''} ${(t.legs || []).map((l) => `${l.matchup} ${l.leagueName} ${l.sportyPick}`).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const featuredIds = ['daily-rollover-2x', 'combo-shield-banker-8', 'twenty-million-mega-50', 'million-odds-grand-slam', 'value-ev-sniper-6'];
    const curatedHtml = filtered.length
      ? filtered.map((t) => renderTicketCard(t, featuredIds.includes(t.id))).join('')
      : `<p class="empty">No tickets match "${esc(state.ticketSearch)}". Clear the search or switch category.</p>`;

    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem;margin-bottom:1rem">
        <div>
          <h2 style="margin:0">🤖 Oracle Command Center — History &amp; Lineup-Vetted Multi-Match AI Tickets &amp; 20M+ Codes</h2>
          <p class="muted" style="margin:.25rem 0">Every match is checked against real <b>Last-15 Form, H2H History, Starting XIs, Injuries &amp; Season Prop Averages</b> — with pre-booked 6-char <b>Pod A–D Codes</b> on all 20–50 game multis.</p>
        </div>
        <div style="display:flex;gap:.45rem;flex-wrap:wrap">
          <a href="#/props" class="btn" style="border-color:var(--brand);color:var(--brand);font-weight:700;text-decoration:none">🥅 Props, 1H &amp; Players →</a>
          <a href="#/arena" class="btn" style="border-color:var(--good);color:var(--good);font-weight:700;text-decoration:none">🧪 Live Results Arena →</a>
          <a href="#/vault" class="btn primary" style="text-decoration:none">🎯 20-Game CS Vault →</a>
          <button class="btn" id="refresh-tickets-btn">🔄 Refresh Codes</button>
        </div>
      </div>

      ${renderCommandHero(overview)}

      <div class="generator-box">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
          <div>
            <h3 style="margin:0;font-size:1.08rem">⚡ Multi-Match &amp; 20-Million+ Synthesizer (2 to 50 Games SportyBet Max · Up to 20,000,000x+ Odds + Live Pod Codes)</h3>
            <span class="small muted">Vets team Last-15 form, H2H history &amp; lineups first, enforces SportyBet Ghana's <b>50-Game maximum</b>, and pre-books <b>Pod A–D 6-char codes</b> on 20–50 leg multis.</span>
          </div>
          <button id="run-gen-btn" class="btn btn-sporty" style="padding:.6rem 1.1rem">🇬🇭 Synthesize &amp; Book SportyBet Code</button>
        </div>

        <div class="gen-row">
          <span class="small" style="font-weight:700;min-width:130px">Kickoff Window:</span>
          <div class="filters" role="group">
            ${[
              ['all', '🌍 All Upcoming (500+ Matches)'],
              ['soon', '⚡ Kickoff Soon (Next 6h)'],
              ['today', '📅 Today (Next 24h)'],
              ['48h', '📆 Next 48 Hours'],
            ].map(([k, lbl]) => `<button type="button" class="chip" data-time-win="${k}" aria-pressed="${win === k}">${lbl}</button>`).join('')}
          </div>
        </div>

        <div class="gen-row">
          <span class="small" style="font-weight:700;min-width:130px">Target Multiplier:</span>
          <div class="filters" role="group">
            ${[
              [0, '🔢 Use Game Count Below'],
              [2, '💰 ~2x Rollover'],
              [5, '🎯 ~5x'],
              [10, '🔥 ~10x'],
              [50, '💎 ~50x'],
              [250, '🚀 ~250x'],
              [1000, '⚡ ~1,000x'],
              [10000, '🌟 ~10,000x'],
              [100000, '🏆 ~100,000x'],
              [1000000, '🔥 1,000,000x (1M+)'],
              [5000000, '🚀 5,000,000x (5M+)'],
              [10000000, '💎 10,000,000x (10M+)'],
              [20000000, '👑 20,000,000x+ (20M+ Mega)'],
            ].map(([val, lbl]) => `<button type="button" class="chip" data-target-odds="${val}" aria-pressed="${(state.ticketGenTargetOdds || 0) === val}">${lbl}</button>`).join('')}
          </div>
        </div>

        ${!(state.ticketGenTargetOdds > 0) ? `
          <div class="gen-row">
            <span class="small" style="font-weight:700;min-width:130px">Number of Games:</span>
            <div class="filters" role="group" id="gen-legs-group">
              ${[2, 3, 5, 8, 10, 15, 20, 30, 40, 50].map((n) => `<button type="button" class="chip" data-gen-legs="${Math.min(50, n)}" aria-pressed="${Math.min(50, state.ticketGenLegs || 8) === n}">${n === 50 ? '50 Games (Max)' : `${n} Games`}</button>`).join('')}
            </div>
          </div>` : ''}

        <div class="gen-row">
          <span class="small" style="font-weight:700;min-width:130px">Market Mode:</span>
          <div class="filters" role="group" id="gen-type-group">
            ${[
              ['mixed', '🔀 Mixed Multi (All Markets)'],
              ['20m', '👑 50-Game 20M+ History-Verified Mega'],
              ['million', '🔥 High-Accuracy 1M+ Compounder'],
              ['combos', '🛡️ Combo & "Or" Shields'],
              ['1h', '⏱️ 1st Half Markets'],
              ['player_props', '👤 Player Shots / SOT / Saves'],
              ['ou1.5', '🔁 Identical: All Over 1.5'],
              ['ou2.5', '🔁 Identical: All Over 2.5'],
              ['gg', '🔁 Identical: All GG (BTTS)'],
              ['1x2', '🔁 Identical: All 1X2 Winners'],
              ['1up', '🔁 Identical: All 1UP Early Payout'],
              ['dc', '🔁 Identical: All Double Chance'],
              ['shots', '🎯 Shots & Shots on Target (SOT)'],
              ['corners', '🚩 Identical: All Corners'],
              ['cards', '🟨 Identical: All Cards/Bookings'],
              ['throws_gk', '🤾 Throw-Ins, Goal Kicks & Fouls'],
              ['cs', '🎯 Correct Scores'],
              ['multiscore', '🛡️ Multiscores (Cluster CS)'],
            ].map(([k, label]) => `<button type="button" class="chip" data-gen-type="${k}" aria-pressed="${(state.ticketGenType || 'mixed') === k}">${label}</button>`).join('')}
          </div>
        </div>

        <div class="gen-row">
          <span class="small" style="font-weight:700;min-width:130px">Risk &amp; Additions:</span>
          <div class="filters" role="group">
            ${[
              ['safe', '🛡️ High-Accuracy Safe (Recommended)'],
              ['balanced', '⚖️ Balanced +EV Value'],
              ['high_odds', '🚀 High Odds Boost'],
            ].map(([k, label]) => `<button type="button" class="chip" data-gen-risk="${k}" aria-pressed="${(state.ticketGenRisk || 'safe') === k}">${label}</button>`).join('')}
            <button type="button" class="chip" id="toggle-sgm-btn" aria-pressed="${Boolean(state.ticketGenSGM)}">
              🔗 Same-Game Multi: ${state.ticketGenSGM ? 'ON' : 'OFF'}
            </button>
            <button type="button" class="chip" id="toggle-vars-btn" aria-pressed="${(state.ticketGenVars || 1) === 3}">
              🎲 3 Variations: ${(state.ticketGenVars || 1) === 3 ? 'ON (3 Codes)' : 'OFF (1 Code)'}
            </button>
          </div>
        </div>

        <div id="gen-result"></div>
      </div>

      <div class="toolbar" style="margin:1.25rem 0 .85rem">
        <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
          <h3 style="margin:0">📋 Pre-Compiled Live Tickets (${filtered.length})</h3>
          <input id="ticket-search-input" class="search-input" type="search" placeholder="🔍 Search team, league, or code…" value="${esc(state.ticketSearch || '')}">
        </div>
        <div class="filters" role="group">
          ${[
            ['all', 'All Tickets'],
            ['million', '👑 Multi-Match, 1M+ & 20M+'],
            ['rollover', '💰 Rollover & Fast-Cash'],
            ['combos', '🛡️ Combo Shields'],
            ['props', '🥅 Shots, Throws & Props'],
            ['vhim', '🔥 Vhim & 20-Fold'],
            ['ev', '💎 +EV & Correlated SGM'],
            ['mixed', '🔀 Mixed'],
            ['identical', '🔁 Identical'],
            ['cs', '🎯 Correct Scores'],
            ['insider', '🕵️ Insider'],
          ].map(([k, lbl]) => `<button type="button" class="chip" data-cat-filter="${k}" aria-pressed="${activeCat === k}">${lbl}</button>`).join('')}
        </div>
      </div>

      <div class="ticket-grid" id="curated-tickets-grid">${curatedHtml}</div>`;

    // Handlers
    $('#refresh-tickets-btn')?.addEventListener('click', async () => {
      main.innerHTML = `<p class="loading"><span class="spinner"></span> Refreshing live SportyBet Ghana fixtures, checking match history &amp; booking fresh codes…</p>`;
      await api(`/api/tickets?force=1&window=${encodeURIComponent(win)}`);
      showToast('✓ Fresh history-verified SportyBet Ghana codes booked!', 'ok');
      renderTickets();
    });

    $('#ticket-search-input')?.addEventListener('input', (e) => {
      state.ticketSearch = e.target.value;
      const qNow = state.ticketSearch.trim().toLowerCase();
      const sub = allTickets.filter((t) => {
        if (!matchTicketCategory(t, activeCat)) return false;
        if (qNow) {
          const hay = `${t.title} ${t.category} ${t.shareCode || ''} ${(t.legs || []).map((l) => `${l.matchup} ${l.leagueName} ${l.sportyPick}`).join(' ')}`.toLowerCase();
          if (!hay.includes(qNow)) return false;
        }
        return true;
      });
      const grid = $('#curated-tickets-grid');
      if (grid) {
        grid.innerHTML = sub.length
          ? sub.map((t) => renderTicketCard(t, featuredIds.includes(t.id))).join('')
          : `<p class="empty">No tickets match "${esc(state.ticketSearch)}".</p>`;
      }
    });

    main.querySelectorAll('[data-time-win]').forEach((b) => (b.onclick = () => {
      state.ticketsTimeWindow = b.dataset.timeWin;
      renderTickets();
    }));
    main.querySelectorAll('[data-target-odds]').forEach((b) => (b.onclick = () => {
      state.ticketGenTargetOdds = Number(b.dataset.targetOdds) || 0;
      renderTickets();
    }));
    main.querySelectorAll('[data-cat-filter]').forEach((b) => (b.onclick = () => {
      state.ticketCategoryFilter = b.dataset.catFilter;
      renderTickets();
    }));
    main.querySelectorAll('[data-gen-legs]').forEach((b) => (b.onclick = () => {
      state.ticketGenLegs = parseInt(b.dataset.genLegs, 10);
      renderTickets();
    }));
    main.querySelectorAll('[data-gen-type]').forEach((b) => (b.onclick = () => {
      state.ticketGenType = b.dataset.genType;
      renderTickets();
    }));
    main.querySelectorAll('[data-gen-risk]').forEach((b) => (b.onclick = () => {
      state.ticketGenRisk = b.dataset.genRisk;
      renderTickets();
    }));
    $('#toggle-sgm-btn')?.addEventListener('click', () => {
      state.ticketGenSGM = !state.ticketGenSGM;
      renderTickets();
    });
    $('#toggle-vars-btn')?.addEventListener('click', () => {
      state.ticketGenVars = (state.ticketGenVars || 1) === 3 ? 1 : 3;
      renderTickets();
    });

    $('#run-gen-btn')?.addEventListener('click', async () => {
      const btn = $('#run-gen-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Booking on SportyBet Ghana…';
      try {
        const res = await api('/api/tickets/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            legs: state.ticketGenLegs || 8,
            targetOdds: state.ticketGenTargetOdds || 0,
            timeWindow: state.ticketsTimeWindow || 'all',
            marketType: state.ticketGenType || 'mixed',
            risk: state.ticketGenRisk || 'safe',
            sameGameMulti: Boolean(state.ticketGenSGM),
            variations: state.ticketGenVars || 1,
          }),
        });
        const list = res.variations?.length ? res.variations : [res.ticket];
        const target = $('#gen-result');
        if (target) {
          target.innerHTML = `<div class="ticket-grid" style="margin-top:.75rem">${list.map((t) => renderTicketCard(t, true)).join('')}</div>`;
        }
        showToast(`🇬🇭 Synthesized ${list.length} live SportyBet slip${list.length > 1 ? 's' : ''}${list[0]?.shareCode ? ` (Code: ${list[0].shareCode})` : ''}!`, 'ok');
      } catch (err) {
        showToast('Generation failed: ' + err.message, 'err');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '🇬🇭 Synthesize & Book SportyBet Code';
      }
    });
  } catch (err) {
    main.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ---------- Dedicated 20-Game Correct Score & Pre-Compiled Slip Vault View (#/vault) ----------

async function renderVault() {
  const main = $('#main');
  main.innerHTML = `<p class="loading"><span class="spinner"></span> Compiling 20-Game Correct Score Vault & Live SportyBet Ghana Booking Codes…</p>`;

  try {
    const vault = await ensureSlipVaultLoaded();
    if (state.view !== 'vault') return;
    if (!vault) throw new Error('Could not load Correct Score Vault.');

    const bundlesHtml = (vault.correctScoreBundles || []).map((b) => renderTicketCard(b, b.id === 'vault-cs-20' || b.id === 'vault-cs-3')).join('');

    const gamesRowsHtml = (vault.correctScoreGames || []).map((g, i) => {
      const p1 = g.primaryCS;
      const p2 = g.backupCS;
      const ms = g.multiscorePick;
      const p1Json = JSON.stringify(p1).replace(/"/g, '&quot;');
      const p2Json = p2 ? JSON.stringify(p2).replace(/"/g, '&quot;') : '';
      const msJson = ms ? JSON.stringify(ms).replace(/"/g, '&quot;') : '';
      const inSlip1 = state.slip.some((s) => s.id === p1.id);
      const inSlip2 = p2 && state.slip.some((s) => s.id === p2.id);
      const inSlipMs = ms && state.slip.some((s) => s.id === ms.id);

      return `
        <tr>
          <td><b>${i + 1}</b></td>
          <td>
            <b>${esc(g.matchup)}</b>
            <div class="small muted">${esc(g.leagueName)} · ${fmtTime(g.date)}</div>
          </td>
          <td>
            <button type="button" class="btn ${inSlip1 ? 'primary' : ''}" data-slip-pick="${esc(p1.id)}" onclick="window.oracleAddPick(${p1Json})">
              🎯 <b>${esc(p1.sportyPick)}</b> · @${p1.sportyOdds} (${pct1(p1.p)}) <span class="sel-status">${inSlip1 ? '✓ Slip' : '+ Slip'}</span>
            </button>
          </td>
          <td>
            ${p2 ? `
              <button type="button" class="btn ${inSlip2 ? 'primary' : ''}" data-slip-pick="${esc(p2.id)}" onclick="window.oracleAddPick(${p2Json})">
                ➕ <b>${esc(p2.sportyPick)}</b> · @${p2.sportyOdds} (${pct1(p2.p)}) <span class="sel-status">${inSlip2 ? '✓ Slip' : '+ Slip'}</span>
              </button>` : '–'}
          </td>
          <td>
            ${ms ? `
              <button type="button" class="btn ${inSlipMs ? 'primary' : ''}" data-slip-pick="${esc(ms.id)}" onclick="window.oracleAddPick(${msJson})">
                🛡️ <b>${esc(ms.sportyPick)}</b> · @${ms.sportyOdds} (${pct1(ms.p)}) <span class="sel-status">${inSlipMs ? '✓ Slip' : '+ Slip'}</span>
              </button>` : '–'}
          </td>
        </tr>`;
    }).join('');

    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem;margin-bottom:1.25rem">
        <div>
          <h2 style="margin:0">🎯 20-Game Correct Score & Multiscore Slip Centre Vault</h2>
          <p class="muted" style="margin:.25rem 0">We automatically compiled the 20 surest Correct Score matches and pre-booked them onto SportyBet Ghana. Load all 20 folds at once, pick a 3/5/10-fold sniper bundle, or tap multiple scores per match!</p>
        </div>
        <button class="btn btn-sporty" onclick="window.oracleSetSlipTab('slip'); document.getElementById('open-slip').click();">
          🏦 Open My Active Slip (${state.slip.length} Picks)
        </button>
      </div>

      <h3 style="margin:0 0 .75rem">⚡ Pre-Booked Correct Score & Multiscore Tickets (Ready SportyBet Ghana Codes)</h3>
      <div class="ticket-grid" style="margin-bottom:1.75rem">${bundlesHtml}</div>

      <section class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.75rem">
          <h3 style="margin:0">📋 All 20 Compiled Correct Score Matches (Tap Any Score to Add/Mix into Slip)</h3>
          <span class="small muted">Tip: You can add both #1 Exact Score and #2 Backup Score from the same game into your slip!</span>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Match & Competition</th>
                <th>#1 Surest Exact Score</th>
                <th>#2 Backup Exact Score</th>
                <th>🛡️ Multiscore Cluster (Covers 3 Scores)</th>
              </tr>
            </thead>
            <tbody>${gamesRowsHtml}</tbody>
          </table>
        </div>
      </section>`;
  } catch (err) {
    main.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ---------- Market Surveillance, Bookmaker Insider & 15m Time-Series Odds-Drop Radar ----------

function renderOddsSparklineSvg(points) {
  if (!Array.isArray(points) || points.length < 2) return '';
  const w = 150, h = 38, padX = 6, padY = 5;
  const vals = points.map((p) => Number(p.odds ?? p[1]) || 1);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const span = Math.max(maxV - minV, 0.02);
  const sx = (i) => padX + (i / Math.max(points.length - 1, 1)) * (w - padX * 2);
  const sy = (v) => h - padY - ((v - minV) / span) * (h - padY * 2);
  const poly = vals.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
  const firstY = sy(vals[0]).toFixed(1);
  const lastY = sy(vals[vals.length - 1]).toFixed(1);
  return `
    <svg viewBox="0 0 ${w} ${h}" class="sparkline-svg" role="img" aria-label="SportyBet odds drop sparkline">
      <polyline points="${poly}" fill="none" stroke="var(--good)" stroke-width="2.2" />
      <circle cx="${sx(0).toFixed(1)}" cy="${firstY}" r="2.8" fill="var(--muted)" />
      <circle cx="${sx(vals.length - 1).toFixed(1)}" cy="${lastY}" r="3.4" fill="var(--good)" />
    </svg>`;
}

async function renderRadar() {
  const main = $('#main');
  main.innerHTML = `<p class="loading"><span class="spinner"></span> Scanning SportyBet Ghana 15-minute time-series odds snapshots, BetRadar feeds &amp; ESPN lines for insider slashes, abnormal draws &amp; syndicate steam…</p>`;

  try {
    const [data, oddsMov] = await Promise.all([
      api('/api/intelligence'),
      api('/api/odds-movements').catch(() => null),
    ]);
    if (state.view !== 'radar') return;

    const allAnomalies = data.anomalies || [];
    const trackerStats = oddsMov?.stats || null;
    state.radarAnomaliesById = {};
    allAnomalies.forEach((a) => { state.radarAnomaliesById[a.id] = a; });

    const activeFilter = state.radarTypeFilter || 'all';
    const anomalies = activeFilter === 'all'
      ? allAnomalies
      : allAnomalies.filter((a) => a.type === activeFilter);

    const typeMeta = {
      sporty_time_series_crash: { icon: '📉', label: 'Live 15m SportyBet Time-Series Odds Crash' },
      biscotto_draw: { icon: '🤝', label: 'Abnormal Draw ("Biscotto" / Stalemate Alert)' },
      liability_slash: { icon: '🚨', label: 'Syndicate Liability Slash (Odds Cut)' },
      goals_fixing_alert: { icon: '⚽', label: 'Extreme Goals Crash (Defensive Collapse)' },
      exact_score_cluster: { icon: '🎯', label: 'Correct Score Lock' },
      odds_plunge: { icon: '📉', label: 'Sharp Opening-to-Current Steam Plunge' },
      spread_shift: { icon: '⚡', label: 'Handicap Line Jump' },
      model_divergence: { icon: '🔍', label: 'Bookmaker Private Intel vs Public Stats' },
    };

    const cardsHtml = anomalies.length ? anomalies.map((a) => {
      const o = a.odds || {};
      const tm = typeMeta[a.type] || { icon: '🔍', label: 'Market Anomaly' };
      const pick = a.recommendedPick;
      const pickJson = pick ? JSON.stringify(pick).replace(/"/g, '&quot;') : '';
      const dossier = state.investigations?.[a.id] || a.forensicDossier;
      const od = a.oddsDrop;

      return `
        <div class="radar-card ${a.severity}">
          <div class="radar-head">
            <div>
              <span class="tag ${a.severity === 'high' ? 'miss' : 'value'}" style="font-weight:700">${tm.icon} ${esc(tm.label)}</span>
              <h3 style="margin:.35rem 0 .15rem">${esc(a.matchup)}</h3>
              <span class="small muted">${esc(a.leagueName)} · ${fmtTime(a.date)}</span>
            </div>
            <span class="tag pick">${esc(a.severity.toUpperCase())}</span>
          </div>

          <div class="radar-detail">${esc(a.detail)}</div>

          ${od && od.points?.length >= 2 ? `
            <div class="ts-crash-strip">
              <div>
                <div class="small" style="font-weight:800;color:var(--good)">📉 @${od.openOdds} → @${od.curOdds} (-${od.dropPct}% Drop · +${od.impliedJumpPct}% Prob)</div>
                <div class="small muted">${od.snapshotsCount} real SportyBet snapshots over ${od.elapsedHours}h</div>
              </div>
              ${renderOddsSparklineSvg(od.points)}
            </div>` : ''}

          ${pick ? `
            <div class="insider-pick-box">
              <div>
                <span class="small muted" style="display:block;font-weight:700">🕵️ What the Bookmaker / Smart Money is Backing:</span>
                <b style="font-size:.96rem;color:var(--brand)">${esc(pick.label)} (@${pick.sportyOdds || pick.fairOdds})</b>
                <span class="small muted"> · True Prob: ${pct1(pick.p)}</span>
              </div>
              <button type="button" class="btn primary" onclick="window.oracleAddPick(${pickJson})">➕ Add Insider Pick to Slip</button>
            </div>` : ''}

          <div class="radar-metrics">
            <div>
              <span class="muted small">Bookmaker (${esc(o.provider || 'SportyBet / BetRadar')})</span>
              <b>${esc(o.homeML || '')} ${o.awayML ? `/ ${esc(o.awayML)}` : ''}</b>
              ${o.drawOdds ? `<span class="small" style="color:var(--bad)">Draw Priced at @${esc(o.drawOdds)}</span>` : ''}
            </div>
            <div>
              <span class="muted small">Surveillance Signal</span>
              <b>Divergence / Slash: ${a.divergence}%</b>
              <span class="small" style="color:var(--brand)">${a.sportyGameId ? `SportyBet Game ID: ${esc(a.sportyGameId)}` : 'Live Market Feed'}</span>
            </div>
          </div>

          <div id="invest-area-${esc(a.id)}">
            ${dossier ? renderInvestigationResult(dossier, a) : ''}
          </div>
        </div>`;
    }).join('') : `<p class="muted">No anomalies matching this filter yet (15-minute time-series recorder continuously snapshots upcoming SportyBet Ghana lines).</p>`;

    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem;margin-bottom:1.25rem">
        <div>
          <h2 style="margin:0">🚨 Bookmaker Insider, 15m SportyBet Time-Series Odds-Drop &amp; Match-Fixing Radar</h2>
          <p class="muted" style="margin:.25rem 0">Continuously records SportyBet Ghana odds every 15 minutes to catch <b>Real Multi-Snapshot Odds Crashes</b> alongside <b>Liability Slashes</b>, <b>"Biscotto" Draw Compression (@2.10–@2.95)</b>, and <b>Goals Crashes</b>.</p>
          ${trackerStats ? `<div style="display:flex;gap:.45rem;flex-wrap:wrap;margin-top:.35rem">
            <span class="tag ok">⏱ 15m Time-Series Recorder Active</span>
            <span class="tag">📊 ${trackerStats.eventsTracked || 0} Fixtures Tracked</span>
            <span class="tag">📈 ${(trackerStats.selectionsTracked || 0).toLocaleString()} Selections Monitored</span>
            <span class="tag pick">📉 ${trackerStats.multiPointSelections || 0} Multi-Snapshot Series</span>
          </div>` : ''}
        </div>
      </div>

      ${data.insiderTicket && data.insiderTicket.count ? `
        <div style="margin-bottom:1.5rem">
          ${renderTicketCard(data.insiderTicket, true)}
        </div>` : ''}

      <div class="toolbar" style="margin-bottom:1rem">
        <span class="small" style="font-weight:700">Filter by Surveillance Signature (${anomalies.length} Flagged Matches):</span>
        <div class="filters" role="group">
          ${[
            ['all', `All Signals (${allAnomalies.length})`],
            ['sporty_time_series_crash', '📉 Live 15m Odds Crashes'],
            ['liability_slash', '🚨 Liability Slash'],
            ['biscotto_draw', '🤝 Abnormal Draw ("Biscotto")'],
            ['goals_fixing_alert', '⚽ Extreme Goals Crash'],
            ['exact_score_cluster', '🎯 Correct Score Lock'],
            ['model_divergence', '🔍 Insider vs Stats Divergence'],
          ].map(([k, lbl]) => `<button type="button" class="chip" data-radar-filter="${k}" aria-pressed="${activeFilter === k}">${lbl}</button>`).join('')}
        </div>
      </div>

      <div class="radar-grid">${cardsHtml}</div>`;

    main.querySelectorAll('[data-radar-filter]').forEach((b) => (b.onclick = () => {
      state.radarTypeFilter = b.dataset.radarFilter;
      renderRadar();
    }));
  } catch (err) {
    main.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

function renderInvestigationResult(rep, anomaly = null) {
  const badgeCls = rep.suspicionLevel === 'abnormal_integrity_alert' ? 'miss' : rep.suspicionLevel === 'sharp_syndicate_action' ? 'value' : 'ok';
  return `
    <div class="investigate-box">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.35rem">
        <b>🕵️ Forensic Intelligence Dossier:</b>
        <span class="tag ${badgeCls}">${esc(rep.suspicionLevel)}</span>
      </div>
      <div><b>What the Betting Companies Know:</b> <span class="small">${esc(rep.marketIntelligence)}</span></div>
      ${rep.drivers?.length ? `<div><b>How the Odds Moved:</b><ul class="clean small">${rep.drivers.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>` : ''}
      ${rep.recommendedAction ? `<div class="small" style="color:var(--good)"><b>✓ Strategy:</b> ${esc(rep.recommendedAction)}</div>` : ''}
      ${rep.integrityWarning && !rep.integrityWarning.toLowerCase().startsWith('none') ? `<div class="small" style="color:var(--bad)"><b>⚠ Integrity Watch:</b> ${esc(rep.integrityWarning)}</div>` : ''}
      ${state.aiEnabled && anomaly ? `
        <button type="button" class="btn" style="font-size:.75rem;padding:.3rem .6rem;margin-top:.25rem" onclick="window.oracleInvestigate('${esc(anomaly.id)}')">
          🌐 Run Live Google Search Grounding Check
        </button>` : ''}
    </div>`;
}

window.oracleInvestigate = async function(anomalyId) {
  const anomaly = state.radarAnomaliesById?.[anomalyId];
  const container = document.getElementById(`invest-area-${anomalyId}`);
  if (!container || !anomaly) return;
  container.innerHTML = `<p class="small muted"><span class="spinner"></span> Running deep web integrity & team news search…</p>`;
  try {
    const res = await api('/api/intelligence/investigate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anomaly }),
    });
    if (!state.investigations) state.investigations = {};
    state.investigations[anomalyId] = res.report;
    container.innerHTML = renderInvestigationResult(res.report, null);
  } catch (err) {
    container.innerHTML = renderInvestigationResult(anomaly.forensicDossier, null);
  }
};

// ---------- best picks view ----------

async function renderPicks() {
  const main = $('#main');
  const win = state.picksTimeWindow || 'all';
  const sortMode = state.picksSort || 'prob';
  const grp = state.picksGroup || 'all';
  const evOnly = state.picksEvOnly ? '1' : '0';
  main.innerHTML = `<p class="loading"><span class="spinner"></span> Scanning de-vigged top probability &amp; +EV value picks across 500+ SportyBet Ghana fixtures…</p>`;

  try {
    const data = await api(`/api/picks?minP=${state.picksMinP}&window=${encodeURIComponent(win)}&sort=${encodeURIComponent(sortMode)}&group=${encodeURIComponent(grp)}&evOnly=${evOnly}`);
    if (state.view !== 'picks') return;

    const allPicks = data.picks || [];
    const q = (state.picksSearch || '').trim().toLowerCase();
    const visiblePicks = q
      ? allPicks.filter((p) => `${p.matchup || ''} ${p.leagueName || ''} ${p.sportyPick || p.label || ''} ${p.sporty || p.market || ''}`.toLowerCase().includes(q))
      : allPicks;

    const probFilters = [0.55, 0.65, 0.70, 0.75, 0.80].map((p) =>
      `<button type="button" class="chip" data-minp="${p}" aria-pressed="${state.picksMinP === p}">${Math.round(p * 100)}%+ Prob</button>`
    ).join('');

    const renderPickCards = (list) => list.length ? list.map((p) => {
      const pickId = p.id || `${p.gameId}:${p.marketKey}:${p.selKey}`;
      const inSlip = state.slip.some((x) => x.id === pickId);
      const matchupStr = p.matchup || `${p.home || ''} vs ${p.away || ''}`;
      const payloadObj = {
        ...p,
        id: pickId,
        matchup: matchupStr,
        sportyMarket: p.sporty || p.sportyMarket || p.market,
        sportyPick: p.sportyPick || p.label,
      };
      const payload = JSON.stringify(payloadObj).replace(/"/g, '&quot;');
      const edge = Number(p.edgePct || 0);
      const kickoffRel = p.date ? fmtKickoffRelative(p.date) : '';

      return `
        <div class="pick-card">
          <div class="pick-card-head">
            <span><b>${esc(p.leagueName)}</b></span>
            <span>${kickoffRel ? `${esc(kickoffRel)} · ` : ''}${fmtTime(p.date)}</span>
          </div>
          <div class="pick-card-match">${esc(matchupStr)}</div>
          <div class="pick-card-market">
            <div>
              <div class="small muted">${esc(p.sporty || p.sportyMarket || p.market)}</div>
              <div class="pick-card-sel">${esc(p.sportyPick || p.label)}</div>
              <div style="display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.25rem">
                <span class="tag" style="font-size:.68rem">${esc(p.group || 'Main')}</span>
                ${edge > 0 ? `<span class="tag value" style="font-size:.7rem">+${edge}% EV</span>` : ''}
                ${p.oddsMovement?.isSteamCrash
                  ? `<span class="tag ok" style="font-size:.7rem" title="@${p.oddsMovement.openOdds} → @${p.oddsMovement.curOdds}">📉 -${p.oddsMovement.dropPct}%</span>`
                  : (p.steamPct || 0) >= 4 ? `<span class="tag ok" style="font-size:.7rem">📉 Steam</span>` : ''}
                ${p.kellyPct ? `<span class="tag muted" style="font-size:.7rem">Kelly ${p.kellyPct}%</span>` : ''}
              </div>
            </div>
            <div style="text-align:right">
              <span class="tag pick" style="font-size:.9rem">${pct(p.p)}</span>
              <div class="pick-card-odds small" style="margin-top:.2rem"><b>Sporty: @${p.sportyOdds || fairOdds(p.p)}</b></div>
              <div class="small muted">Fair: @${p.fairOdds || fairOdds(p.p)}</div>
            </div>
          </div>
          ${(p.historySummary || p.historyBadge) ? `<div class="prop-rationale" style="font-size:.75rem;color:var(--good);margin-bottom:.25rem">📜 ${esc(p.historySummary || p.historyBadge)}</div>` : ''}
          ${p.lineupBadge ? `<div class="small" style="font-size:.72rem;color:var(--brand);margin-bottom:.35rem">${esc(p.lineupBadge)}</div>` : ''}
          <button type="button" class="btn ${inSlip ? 'primary' : ''}" data-slip-pick="${esc(pickId)}" data-slip-payload="${payload}" style="width:100%">
            <span class="sel-status">${inSlip ? '✓ In Slip' : '+ Add to Slip'}</span>
          </button>
        </div>`;
    }).join('') : `<p class="empty">No upcoming picks match your current filters. Try lowering the probability threshold or switching section.</p>`;

    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem;margin-bottom:.85rem">
        <div>
          <h2 style="margin:0">⚡ Best Picks &amp; +EV Value Scanner (History &amp; Lineup-Vetted)</h2>
          <p class="muted" style="margin:.25rem 0">De-vigged ensemble probabilities vetted against real <b>Last-15 Form, H2H History, Starting XIs, Injuries &amp; Season Prop Profiles</b> across SportyBet Ghana fixtures.</p>
        </div>
        <div style="display:flex;gap:.45rem;flex-wrap:wrap">
          <a href="#/props" class="btn" style="text-decoration:none">🥅 Props, 1H &amp; Players Hub →</a>
          <button id="book-top5-btn" class="btn btn-sporty" ${visiblePicks.length === 0 ? 'disabled' : ''}>🇬🇭 Book Top 5 Live Code</button>
          <button id="add-top5-btn" class="btn primary" ${visiblePicks.length === 0 ? 'disabled' : ''}>➕ Add Top 5 to Slip</button>
        </div>
      </div>

      <div class="panel" style="margin-bottom:1.15rem;display:grid;gap:.65rem;padding:.85rem 1rem">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.6rem">
          <div class="filters" role="group" aria-label="Market Section">
            ${[
              ['all', '🌐 All Sections'],
              ['Main', '🏆 Main (1X2 / 1UP / DC)'],
              ['Combos', '🛡️ Combo & "Or" Shields'],
              ['1st Half', '⏱️ 1st Half'],
              ['Goals', '⚽ Goals & GG'],
              ['Player Props', '👤 Player Props'],
              ['props', '🥅 All Match Props'],
              ['Shots', '🎯 Shots & SOT'],
              ['Corners', '🚩 Corners'],
              ['Cards', '🟨 Bookings / Cards'],
              ['Throws & Goal Kicks', '🤾 Throws & Goal Kicks'],
              ['Offsides & fouls', '🚩 Fouls & Offsides'],
            ].map(([k, lbl]) => `<button type="button" class="chip" data-pick-grp="${esc(k)}" aria-pressed="${grp === k}">${lbl}</button>`).join('')}
          </div>
          <input id="picks-search-input" class="search-input" type="search" placeholder="🔍 Filter team, player, league, or market…" value="${esc(state.picksSearch || '')}">
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.6rem">
          <div class="filters" role="group" aria-label="Time window">
            ${[
              ['all', '🌍 All Upcoming'],
              ['soon', '⚡ Soon (6h)'],
              ['today', '📅 Today (24h)'],
              ['48h', '📆 48h'],
            ].map(([k, lbl]) => `<button type="button" class="chip" data-pick-win="${k}" aria-pressed="${win === k}">${lbl}</button>`).join('')}
          </div>
          <div class="filters" role="group" aria-label="Filter probability">${probFilters}</div>
          <div class="filters" role="group" aria-label="Sort mode">
            ${[
              ['prob', '🎯 Highest Win %'],
              ['ev', '💎 Best +EV'],
              ['vhim', '🔥 Vhim Score'],
            ].map(([k, lbl]) => `<button type="button" class="chip" data-pick-sort="${k}" aria-pressed="${sortMode === k}">${lbl}</button>`).join('')}
            <button type="button" class="chip" id="toggle-ev-only" aria-pressed="${Boolean(state.picksEvOnly)}">💎 +EV Only: ${state.picksEvOnly ? 'ON' : 'OFF'}</button>
          </div>
          <span class="small muted"><b>${visiblePicks.length}</b> bookable picks</span>
        </div>
      </div>

      <div class="picks-grid" id="picks-cards-grid">${renderPickCards(visiblePicks)}</div>`;

    main.querySelectorAll('[data-minp]').forEach((b) => (b.onclick = () => {
      state.picksMinP = parseFloat(b.dataset.minp);
      renderPicks();
    }));
    main.querySelectorAll('[data-pick-grp]').forEach((b) => (b.onclick = () => {
      state.picksGroup = b.dataset.pickGrp;
      renderPicks();
    }));
    main.querySelectorAll('[data-pick-win]').forEach((b) => (b.onclick = () => {
      state.picksTimeWindow = b.dataset.pickWin;
      renderPicks();
    }));
    main.querySelectorAll('[data-pick-sort]').forEach((b) => (b.onclick = () => {
      state.picksSort = b.dataset.pickSort;
      renderPicks();
    }));
    $('#toggle-ev-only')?.addEventListener('click', () => {
      state.picksEvOnly = !state.picksEvOnly;
      renderPicks();
    });
    $('#picks-search-input')?.addEventListener('input', (e) => {
      state.picksSearch = e.target.value;
      const qNow = state.picksSearch.trim().toLowerCase();
      const filteredNow = qNow
        ? allPicks.filter((p) => `${p.matchup || ''} ${p.leagueName || ''} ${p.sportyPick || p.label || ''} ${p.sporty || p.market || ''}`.toLowerCase().includes(qNow))
        : allPicks;
      const grid = $('#picks-cards-grid');
      if (grid) grid.innerHTML = renderPickCards(filteredNow);
    });

    $('#picks-cards-grid')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-slip-payload]');
      if (btn) {
        const item = JSON.parse(btn.dataset.slipPayload);
        addToSlip(item);
      }
    });

    const getTop5Distinct = () => {
      const qNow = (state.picksSearch || '').trim().toLowerCase();
      const src = qNow
        ? allPicks.filter((p) => `${p.matchup || ''} ${p.leagueName || ''} ${p.sportyPick || p.label || ''} ${p.sporty || p.market || ''}`.toLowerCase().includes(qNow))
        : allPicks;
      const usedGames = new Set();
      const chosen = [];
      for (const p of src) {
        if (usedGames.has(p.gameId)) continue;
        usedGames.add(p.gameId);
        chosen.push({
          ...p,
          id: p.id || `${p.gameId}:${p.marketKey}:${p.selKey}`,
          matchup: p.matchup || `${p.home || ''} vs ${p.away || ''}`,
          sportyMarket: p.sporty || p.sportyMarket || p.market,
          sportyPick: p.sportyPick || p.label,
        });
        if (chosen.length >= 5) break;
      }
      return chosen;
    };

    $('#add-top5-btn')?.addEventListener('click', () => {
      const top5 = getTop5Distinct();
      top5.forEach((item) => addToSlip(item, true));
      openSlip();
    });

    $('#book-top5-btn')?.addEventListener('click', async () => {
      const top5 = getTop5Distinct();
      if (!top5.length) return;
      loadTicketIntoSlip(top5, false, null);
      await bookActiveSlipOnSportyBet();
    });
  } catch (err) {
    main.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ---------- High-Accuracy Throws, Goal Kicks, Shots, SOT, Player Props, Combo Shields & 1st Half Hub (#/props) ----------

async function renderProps() {
  const main = $('#main');
  const cat = state.propsCategory || 'all';
  const minP = state.propsMinP || 0.65;
  const win = state.propsWindow || 'all';
  main.innerHTML = `<p class="loading"><span class="spinner"></span> Extracting deep per-match SportyBet Ghana Player Props, Combo Shields, 1st Half, Throw-Ins, Goal Kicks, Shots &amp; SOT…</p>`;

  try {
    const data = await api(`/api/props?category=${encodeURIComponent(cat)}&minP=${minP}&window=${encodeURIComponent(win)}`);
    if (state.view !== 'props') return;

    const allProps = data.props || [];
    const counts = data.counts || {};
    const featuredTicket = data.featuredPropsTicket;
    const q = (state.propsSearch || '').trim().toLowerCase();

    const visible = q
      ? allProps.filter((p) => `${p.matchup || ''} ${p.leagueName || ''} ${p.sportyPick || p.label || ''} ${p.sportyMarket || p.market || ''}`.toLowerCase().includes(q))
      : allProps;

    const catIconMap = {
      player_props: '👤 Player Props',
      combos: '🛡️ Combo Shields',
      first_half: '⏱️ 1st Half',
      throwins: '🤾 Throw-Ins',
      goalkicks: '🥅 Goal Kicks',
      shots: '🎯 Shots & SOT',
      corners: '🚩 Corners',
      cards: '🟨 Cards / Bookings',
      fouls_offsides: '🚩 Fouls & Offsides',
    };

    const renderPropCards = (list) => list.length ? list.map((p) => {
      const pickId = p.id || `${p.gameId}:${p.marketKey}:${p.selKey}`;
      const inSlip = state.slip.some((x) => x.id === pickId);
      const payload = JSON.stringify({
        ...p,
        id: pickId,
        sportyMarket: p.sportyMarket || p.market,
        sportyPick: p.sportyPick || p.label,
      }).replace(/"/g, '&quot;');
      const kickoffRel = p.date ? fmtKickoffRelative(p.date) : '';
      const edge = Number(p.edgePct || 0);

      return `
        <div class="pick-card" style="border-top:3px solid ${p.bookableOnSporty ? 'var(--good)' : 'var(--brand)'}">
          <div class="pick-card-head">
            <span><b>${esc(p.leagueName)}</b></span>
            <span>${kickoffRel ? `${esc(kickoffRel)} · ` : ''}${fmtTime(p.date)}</span>
          </div>
          <div class="pick-card-match">${esc(p.matchup)}</div>
          <div style="display:flex;gap:.35rem;flex-wrap:wrap;margin:.15rem 0">
            <span class="tag pick">${esc(catIconMap[p.propCategory] || p.group || 'Prop')}</span>
            ${p.bookableOnSporty
              ? `<span class="tag ok">🇬🇭 Live SportyBet Code Ready</span>`
              : `<span class="tag">📊 Tactical High-Accuracy Prop</span>`}
            ${p.expectedLine ? `<span class="tag muted">${esc(p.expectedLine)}</span>` : ''}
            ${p.lineupBadge ? `<span class="tag ok">${esc(p.lineupBadge)}</span>` : ''}
          </div>
          <div class="pick-card-market">
            <div>
              <div class="small muted">${esc(p.sportyMarket || p.market)}</div>
              <div class="pick-card-sel">${esc(p.sportyPick || p.label)}</div>
              ${edge > 0 ? `<span class="tag value" style="font-size:.7rem;margin-top:.2rem">+${edge}% EV Edge</span>` : ''}
            </div>
            <div style="text-align:right">
              <span class="tag ok" style="font-size:.95rem;font-weight:900">${pct(p.p)} Likely</span>
              <div class="pick-card-odds small" style="margin-top:.2rem">
                <b>${p.sportyOdds ? `Sporty: @${p.sportyOdds}` : `Fair Line: @${p.fairOdds || fairOdds(p.p)}`}</b>
              </div>
            </div>
          </div>
          ${p.rationale ? `<div class="prop-rationale">🧠 ${esc(p.rationale)}</div>` : ''}
          <button type="button" class="btn ${inSlip ? 'primary' : ''}" data-slip-pick="${esc(pickId)}" data-slip-payload="${payload}" style="width:100%">
            <span class="sel-status">${inSlip ? '✓ In Slip' : (p.bookableOnSporty ? '+ Add to SportyBet Slip' : '+ Track in Slip')}</span>
          </button>
        </div>`;
    }).join('') : `<p class="empty">No tactical props above ${Math.round(minP * 100)}% accuracy in this category right now. Try 60%+ or "All High-Accuracy".</p>`;

    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem;margin-bottom:1rem">
        <div>
          <h2 style="margin:0">🥅 Deep SportyBet Props, Player Shots/SOT, Combo Shields, 1st Half, Throws &amp; Goal Kicks</h2>
          <p class="muted" style="margin:.25rem 0">Unlocks 200–650+ real markets per game from SportyBet Ghana's full event feed — filtering strictly for <b>high-accuracy picks (${Math.round(minP * 100)}%+ to 90%+)</b> across Player Props, Combo Shields, 1st Half, Throw-Ins, Goal Kicks, Shots, Corners &amp; Cards.</p>
        </div>
        <div style="display:flex;gap:.45rem;flex-wrap:wrap">
          <button id="book-top-props-btn" class="btn btn-sporty" ${!counts.bookable ? 'disabled' : ''}>🇬🇭 Book Top SportyBet Props Code</button>
          <a href="#/tickets" class="btn" style="text-decoration:none">🤖 Back to Multi-Match Tickets →</a>
        </div>
      </div>

      ${featuredTicket && featuredTicket.count >= 2 ? `
        <div style="margin-bottom:1.25rem">
          ${renderTicketCard(featuredTicket, true)}
        </div>
      ` : ''}

      <div class="panel" style="margin-bottom:1.15rem;display:grid;gap:.65rem;padding:.85rem 1rem">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.6rem">
          <div class="filters" role="group" aria-label="Prop Category">
            ${[
              ['all', `🌐 All High-Accuracy (${counts.all || 0})`],
              ['bookable', `🇬🇭 SportyBet Code-Ready (${counts.bookable || 0})`],
              ['player_props', `👤 Player Props (${counts.player_props || 0})`],
              ['combos', `🛡️ Combo Shields (${counts.combos || 0})`],
              ['first_half', `⏱️ 1st Half (${counts.first_half || 0})`],
              ['shots', `🎯 Shots & SOT (${counts.shots || 0})`],
              ['corners', `🚩 Corners (${counts.corners || 0})`],
              ['cards', `🟨 Bookings / Cards (${counts.cards || 0})`],
              ['throwins', `🤾 Throw-Ins (${counts.throwins || 0})`],
              ['goalkicks', `🥅 Goal Kicks (${counts.goalkicks || 0})`],
              ['fouls_offsides', `🚩 Fouls & Offsides (${counts.fouls_offsides || 0})`],
            ].map(([k, lbl]) => `<button type="button" class="chip" data-prop-cat="${k}" aria-pressed="${cat === k}">${lbl}</button>`).join('')}
          </div>
          <input id="props-search-input" class="search-input" type="search" placeholder="🔍 Search match, player, team, or stat…" value="${esc(state.propsSearch || '')}">
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.6rem">
          <div class="filters" role="group" aria-label="Minimum Accuracy">
            ${[
              [0.60, '60%+ Solid'],
              [0.65, '65%+ High Likelihood (Default)'],
              [0.70, '70%+ Very Likely'],
              [0.75, '75%+ Elite Banker'],
              [0.80, '80%+ Ultra Lock'],
            ].map(([val, lbl]) => `<button type="button" class="chip" data-prop-minp="${val}" aria-pressed="${minP === val}">${lbl}</button>`).join('')}
          </div>
          <div class="filters" role="group" aria-label="Time Window">
            ${[
              ['all', '🌍 All Upcoming'],
              ['soon', '⚡ Next 6h'],
              ['today', '📅 Today (24h)'],
              ['48h', '📆 48h'],
            ].map(([k, lbl]) => `<button type="button" class="chip" data-prop-win="${k}" aria-pressed="${win === k}">${lbl}</button>`).join('')}
          </div>
          <span class="small muted">Showing <b>${visible.length}</b> high-likelihood props</span>
        </div>
      </div>

      <div class="picks-grid" id="props-cards-grid">${renderPropCards(visible)}</div>`;

    main.querySelectorAll('[data-prop-cat]').forEach((b) => (b.onclick = () => {
      state.propsCategory = b.dataset.propCat;
      renderProps();
    }));
    main.querySelectorAll('[data-prop-minp]').forEach((b) => (b.onclick = () => {
      state.propsMinP = parseFloat(b.dataset.propMinp);
      renderProps();
    }));
    main.querySelectorAll('[data-prop-win]').forEach((b) => (b.onclick = () => {
      state.propsWindow = b.dataset.propWin;
      renderProps();
    }));
    $('#props-search-input')?.addEventListener('input', (e) => {
      state.propsSearch = e.target.value;
      const qNow = state.propsSearch.trim().toLowerCase();
      const sub = qNow
        ? allProps.filter((p) => `${p.matchup || ''} ${p.leagueName || ''} ${p.sportyPick || p.label || ''} ${p.sportyMarket || p.market || ''}`.toLowerCase().includes(qNow))
        : allProps;
      const grid = $('#props-cards-grid');
      if (grid) grid.innerHTML = renderPropCards(sub);
    });
    $('#props-cards-grid')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-slip-payload]');
      if (btn) {
        const item = JSON.parse(btn.dataset.slipPayload);
        addToSlip(item);
      }
    });
    $('#book-top-props-btn')?.addEventListener('click', async () => {
      const bookable = visible.filter((p) => p.bookableOnSporty);
      const used = new Set();
      const top = [];
      for (const p of bookable) {
        const gid = p.eventId || p.gameId;
        if (used.has(gid)) continue;
        used.add(gid);
        top.push(p);
        if (top.length >= 6) break;
      }
      if (!top.length && featuredTicket?.legs?.length) {
        loadTicketIntoSlip(featuredTicket.legs, false, featuredTicket.shareCode);
        return;
      }
      if (!top.length) return;
      loadTicketIntoSlip(top, false, null);
      await bookActiveSlipOnSportyBet();
    });
  } catch (err) {
    main.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ---------- model lab & brain evolution ----------

function metricRow(name, m, w) {
  if (!m?.n) return `<tr><td>${esc(name)}</td><td colspan="5" class="muted">not available</td></tr>`;
  return `<tr><td>${esc(name)}</td><td class="n">${pct1(m.accuracy)}</td><td class="n">${fx(m.brier)}</td><td class="n">${fx(m.logLoss)}</td><td class="n">${m.n}</td><td class="n">${w != null ? pct(w) : '—'}</td></tr>`;
}

function renderTimelineSvg(timeline) {
  if (!timeline?.length) return '<p class="small muted">No timeline points yet. Click "Evolve Now" to start training.</p>';
  const pts = timeline.slice(-25);
  const w = 600, h = 140, pad = 24;
  const minAcc = Math.min(...pts.map((p) => p.accuracy || 0.4), 0.35);
  const maxAcc = Math.max(...pts.map((p) => p.accuracy || 0.6), 0.65);
  const scaleX = (i) => pad + (i / Math.max(pts.length - 1, 1)) * (w - pad * 2);
  const scaleY = (v) => h - pad - ((v - minAcc) / Math.max(maxAcc - minAcc, 0.01)) * (h - pad * 2);

  const points = pts.map((p, i) => `${scaleX(i)},${scaleY(p.accuracy)}`).join(' ');
  const dots = pts.map((p, i) => {
    const col = p.event === 'promoted' ? 'var(--good)' : p.event === 'kept' ? 'var(--muted)' : 'var(--brand)';
    const tip = `${p.date.slice(0, 10)}: v${p.version} acc ${(p.accuracy * 100).toFixed(1)}% (${p.event})`;
    return `<circle cx="${scaleX(i)}" cy="${scaleY(p.accuracy)}" r="${p.event === 'promoted' ? 5 : 3.5}" fill="${col}"><title>${esc(tip)}</title></circle>`;
  }).join('');

  return `
    <svg viewBox="0 0 ${w} ${h}" class="growth-chart" role="img" aria-label="Growth timeline chart">
      <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--line)" />
      <line x1="${pad}" y1="${pad}" x2="${w - pad}" y2="${pad}" stroke="var(--line)" stroke-dasharray="3,3" />
      <polyline points="${points}" fill="none" stroke="var(--brand)" stroke-width="2.5" />
      ${dots}
      <text x="${pad}" y="${h - 6}" font-size="10" fill="var(--muted)">Older versions</text>
      <text x="${w - pad}" y="${h - 6}" font-size="10" fill="var(--muted)" text-anchor="end">Latest (v${pts.at(-1).version})</text>
      <text x="${pad}" y="${pad - 6}" font-size="10" fill="var(--good)">Acc: ${(maxAcc * 100).toFixed(0)}%</text>
    </svg>`;
}

async function renderLab() {
  const main = $('#main');
  const L = leagueInfo();
  main.innerHTML = `<p class="loading"><span class="spinner"></span> Loading ${esc(L?.name)} model and self-learning brain…</p>`;
  const reqLeague = state.league;

  try {
    const m = await api(`/api/model/${state.league}`);
    if (reqLeague !== state.league || state.view !== 'lab') return;

    const b = m.brain || {};
    const champ = b.champion || { version: 1, params: m.params };
    const drift = b.drift || { status: 'waiting', message: 'Checking drift…' };
    const maxW = Math.max(...m.featureImportance.map((f) => Math.abs(f.weight)), 0.001);

    const trust = b.trust?.weights || { ours: 0.5, market: 0.5, ai: 0.25 };
    const tSum = (trust.ours || 0) + (trust.market || 0) + (trust.ai || 0) || 1;
    const trustRows = [
      { name: '⭐ Our statistical ensemble', w: trust.ours / tSum },
      { name: '💰 Betting market closing odds', w: trust.market / tSum },
      { name: '🤖 Gemini AI analyst', w: trust.ai / tSum },
    ];

    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem;margin-bottom:1rem">
        <div>
          <h2 style="margin:0">${L.icon} ${esc(m.league.name)} — Self-Learning Brain & Model Lab</h2>
          <p class="muted" style="margin:.25rem 0">Walk-forward validation, genetic algorithm parameter evolution, learned trust weights, and drift detection.</p>
        </div>
        <button id="evolve-btn" class="btn primary" ${b.evolving ? 'disabled' : ''}>
          ${b.evolving ? '<span class="spinner"></span> Evolving…' : '🚀 Evolve Now (Self-Tune)'}
        </button>
      </div>

      <div class="stat-grid" style="margin-bottom:1rem">
        <div class="stat"><div class="k">Champion</div><div class="v">v${champ.version}</div><div class="small muted">Genetic evolution</div></div>
        <div class="stat"><div class="k">Ensemble Accuracy</div><div class="v">${pct1(m.metrics.ensemble?.accuracy)}</div><div class="small muted">Holdout backtest</div></div>
        <div class="stat"><div class="k">Ensemble Brier</div><div class="v">${fx(m.metrics.ensemble?.brier)}</div><div class="small muted">Calibration score</div></div>
        <div class="stat">
          <div class="k">Drift Status</div>
          <div class="v" style="font-size:1.1rem;margin-top:.2rem">
            <span class="drift-badge ${drift.status}">${drift.status.toUpperCase()}</span>
          </div>
          <div class="small muted">${esc(drift.message)}</div>
        </div>
      </div>

      <div class="cols">
        <section class="panel">
          <h3>Growth Timeline <span class="muted">Accuracy progression across self-tuned versions</span></h3>
          ${renderTimelineSvg(b.timeline)}
          <div class="tbl-wrap" style="max-height:160px;overflow-y:auto;margin-top:.75rem">
            <table>
              <thead><tr><th>Date</th><th>Version</th><th class="n">Accuracy</th><th class="n">LogLoss</th><th>Event</th></tr></thead>
              <tbody>
                ${(b.timeline || []).slice().reverse().map((t) => `
                  <tr>
                    <td>${t.date ? t.date.slice(0, 10) : '–'}</td>
                    <td>v${t.version}</td>
                    <td class="n">${pct1(t.accuracy)}</td>
                    <td class="n">${fx(t.logLoss)}</td>
                    <td><span class="tag ${t.event === 'promoted' ? 'ok' : ''}">${esc(t.event)}</span></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel">
          <h3>Learned Trust Weights <span class="muted">Optimal blend for Smart Picks</span></h3>
          <table>
            <thead><tr><th>Source</th><th class="mini-bar">Weight</th><th class="n">Share</th></tr></thead>
            <tbody>
              ${trustRows.map((t) => `
                <tr>
                  <td>${esc(t.name)}</td>
                  <td class="mini-bar"><div class="bar"><span class="h" style="width:${(t.w * 100).toFixed(0)}%"></span></div></td>
                  <td class="n">${(t.w * 100).toFixed(1)}%</td>
                </tr>`).join('')}
            </tbody>
          </table>
          <p class="small muted" style="margin:.75rem 0 0">Learned via simplex optimization against actual outcomes: higher weights mean more reliable probabilities.</p>

          <h4 style="margin:1rem 0 .5rem">Champion Model Parameters</h4>
          <div class="tbl-wrap">
            <table>
              <thead><tr><th>Param</th><th class="n">Current (v${champ.version})</th><th class="n">Default</th></tr></thead>
              <tbody>
                ${Object.entries(champ.params || {}).map(([k, val]) => `
                  <tr>
                    <td><code>${esc(k)}</code></td>
                    <td class="n"><b>${val}</b></td>
                    <td class="n muted">${m.defaults?.[k] ?? '–'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div class="cols" style="margin-top:1rem">
        <section class="panel">
          <h3>Market-Level Backtest <span class="muted">Tested walk-forward vs naive base rate</span></h3>
          ${m.marketBacktest?.length ? `
            <div class="tbl-wrap"><table>
              <thead><tr><th>Market</th><th class="n">Accuracy</th><th class="n">Base Rate</th><th class="n">Brier ↓</th><th class="n">Base Brier</th><th class="n">Games</th></tr></thead>
              <tbody>
                ${m.marketBacktest.map((b) => `
                  <tr>
                    <td><b>${esc(b.name)}</b></td>
                    <td class="n"><b>${pct1(b.accuracy)}</b></td>
                    <td class="n muted">${pct1(b.baseAccuracy)}</td>
                    <td class="n">${fx(b.brier)}</td>
                    <td class="n muted">${fx(b.baseBrier)}</td>
                    <td class="n">${b.n}</td>
                  </tr>`).join('')}
              </tbody>
            </table></div>` : '<p class="muted">No market backtest data available for this sport type.</p>'}

          ${m.statsBacktest?.length ? `
            <h4 style="margin:1rem 0 .5rem">Match Stats Models (Negative Binomial)</h4>
            <div class="tbl-wrap"><table>
              <thead><tr><th>Stat</th><th class="n">Avg/Game</th><th class="n">Model MAE ↓</th><th class="n">Base MAE</th><th class="n">Line</th><th class="n">Line Acc</th></tr></thead>
              <tbody>
                ${m.statsBacktest.map((s) => `
                  <tr>
                    <td><b>${esc(s.name)}</b></td>
                    <td class="n">${s.avg}</td>
                    <td class="n"><b>${s.mae}</b></td>
                    <td class="n muted">${s.baseMae}</td>
                    <td class="n">O/U ${s.line}</td>
                    <td class="n">${pct1(s.accuracy)}</td>
                  </tr>`).join('')}
              </tbody>
            </table></div>` : ''}
        </section>

        <section class="panel">
          <h3>Component Model Comparison</h3>
          <div class="tbl-wrap"><table>
            <thead><tr><th>Model</th><th class="n">Accuracy</th><th class="n">Brier ↓</th><th class="n">Log loss ↓</th><th class="n">Games</th><th class="n">Weight</th></tr></thead>
            <tbody>
              ${metricRow('Elo ratings', m.metrics.elo, m.weights.elo)}
              ${metricRow('Scoring model', m.metrics.score, m.weights.score)}
              ${metricRow('Machine learning', m.metrics.ml, m.weights.ml)}
              <tr class="highlight">${metricRow('⭐ Ensemble', m.metrics.ensemble).slice(4, -5)}</tr>
            </tbody>
          </table></div>

          <h4 style="margin:1rem 0 .5rem">What the ML Model Learned</h4>
          ${m.featureImportance?.length ? `<table><tbody>${m.featureImportance.map((f) => `<tr><td>${esc(f.name)}</td><td class="mini-bar"><div class="bar"><span class="${f.weight >= 0 ? 'h' : 'a'}" style="width:${(Math.abs(f.weight) / maxW) * 100}%"></span></div></td><td class="n">${f.weight}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Not enough data to train ML.</p>'}
        </section>
      </div>

      <div class="cols" style="margin-top:1rem">
        <section class="panel">
          <h3>Power rankings <span class="muted">Elo ratings</span></h3>
          <div class="tbl-wrap" style="max-height:520px;overflow:auto"><table>
            <thead><tr><th class="n">#</th><th>${m.league.kind === 'team' ? 'Team' : 'Competitor'}</th><th class="n">Elo</th><th class="n">Games</th></tr></thead>
            <tbody>${(m.rankings || []).slice(0, 80).map((t, i) => `<tr><td class="n">${i + 1}</td><td>${esc(t.name)}</td><td class="n">${t.rating}</td><td class="n">${t.games}</td></tr>`).join('')}</tbody>
          </table></div>
        </section>

        <section class="panel">
          <h3>Recent holdout predictions</h3>
          <div class="tbl-wrap" style="max-height:520px;overflow:auto"><table>
            <thead><tr><th>Game</th><th>Score</th><th>Pick</th><th></th></tr></thead>
            <tbody>${(m.recent || []).map((r) => `<tr><td>${esc(r.away)} @ ${esc(r.home)}<div class="small muted">${new Date(r.date).toLocaleDateString()}</div></td><td class="num">${esc(r.score || '')}</td><td>${esc(r.pick === 'home' ? r.home : r.pick === 'away' ? r.away : 'Draw')} ${pct(r.probs[r.pick])}</td><td>${r.correct ? '<span class="tag ok">✓</span>' : '<span class="tag miss">✗</span>'}</td></tr>`).join('')}</tbody>
          </table></div>
        </section>
      </div>`;

    $('#evolve-btn')?.addEventListener('click', async () => {
      const btn = $('#evolve-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Starting genetic algorithm…';
      try {
        await api(`/api/brain/${state.league}/evolve`, { method: 'POST' });
        // Poll status
        const interval = setInterval(async () => {
          const st = await api(`/api/brain/${state.league}`);
          if (!st.evolving) {
            clearInterval(interval);
            renderLab();
          } else {
            btn.innerHTML = `<span class="spinner"></span> Generation ${st.evolving.generation || 1}/${st.evolving.generations || 6} (${st.evolving.evaluated || 0} evaluated)`;
          }
        }, 1500);
      } catch (err) {
        alert('Evolution failed: ' + err.message);
        renderLab();
      }
    });

  } catch (err) {
    main.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ---------- track record ----------

function gradeCells(x) {
  return x?.n ? `<td class="n">${pct1(x.accuracy)}</td><td class="n">${fx(x.brier)}</td><td class="n">${x.n}</td>` : '<td class="n muted">–</td><td class="n muted">–</td><td class="n muted">0</td>';
}

// ---------- Live Cooked-Odds & Ticket Verification Arena ----------

window.oraclePlaceInArena = async (ticket) => {
  try {
    const defaultStake = ticket?.id?.includes('cs') ? '50' : '100';
    const input = prompt(`Place "${ticket.title || 'Cooked Slip'}" in the Live Verification Arena.\nEnter stake in GHS (₵):`, defaultStake);
    if (input === null) return;
    const stakeGHS = Math.max(1, Number(input) || 100);
    await api('/api/arena/place', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, stakeGHS }),
    });
    showToast(`🧪 Placed "${ticket.title || 'Slip'}" in Arena (₵${stakeGHS})!`, 'ok');
    location.hash = '#/arena';
    if (state.view === 'arena') renderArena();
  } catch (err) {
    showToast('Could not place ticket in Arena: ' + err.message, 'err');
  }
};

window.oracleUpdateArenaStake = async (arenaId, currentStake) => {
  const input = prompt('Update stake in GHS (₵) for this ticket:', String(currentStake || 100));
  if (input === null) return;
  const stakeGHS = Math.max(1, Number(input) || 100);
  try {
    await api('/api/arena/stake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arenaId, stakeGHS }),
    });
    showToast(`✓ Updated stake to ₵${stakeGHS}`, 'ok');
    renderArena(false, true);
  } catch (err) {
    showToast('Failed to update stake: ' + err.message, 'err');
  }
};

function renderEquityCurveSvg(eq) {
  const pts = eq?.points || [];
  if (pts.length < 2) return '';
  const startB = 0;
  const w = 780, h = 185, padX = 46, padY = 24;
  const allVals = pts.flatMap((p) => [p.flexBankroll ?? 0, p.singlesBankroll ?? 0, 0]);
  const minRaw = Math.min(...allVals);
  const maxRaw = Math.max(...allVals);
  const padVal = Math.max((maxRaw - minRaw) * 0.12, 25);
  const minV = minRaw - padVal;
  const maxV = maxRaw + padVal;
  const spanV = Math.max(maxV - minV, 50);

  const sx = (i) => padX + (i / Math.max(pts.length - 1, 1)) * (w - padX * 2);
  const sy = (v) => h - padY - ((v - minV) / spanV) * (h - padY * 2);
  const fmtSigned = (n) => `${n >= 0 ? '+' : '-'}₵${Math.abs(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const flexPoly = pts.map((p, i) => `${sx(i).toFixed(1)},${sy(p.flexBankroll ?? 0).toFixed(1)}`).join(' ');
  const singPoly = pts.map((p, i) => `${sx(i).toFixed(1)},${sy(p.singlesBankroll ?? 0).toFixed(1)}`).join(' ');
  const baseY = sy(startB).toFixed(1);

  const flexDots = pts.map((p, i) => {
    const tip = `${p.label}${p.date ? ` (${p.date})` : ''} → Flex Net P&L: ${fmtSigned(p.flexBankroll)} | Singles Net P&L: ${fmtSigned(p.singlesBankroll)}`;
    return `<circle cx="${sx(i).toFixed(1)}" cy="${sy(p.flexBankroll ?? 0).toFixed(1)}" r="${i === pts.length - 1 ? 4.5 : 3}" fill="var(--good)"><title>${esc(tip)}</title></circle>`;
  }).join('');

  const curFlex = Number(eq.currentFlexBankrollGHS) || 0;
  const curSing = Number(eq.currentSinglesBankrollGHS) || 0;

  return `
    <section class="panel" style="margin-bottom:1.25rem">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.5rem">
        <div>
          <h3 style="margin:0">📈 Real Settled Cumulative Net P&amp;L Curve (₵0.00 Baseline)</h3>
          <span class="small muted">Chronological real-world settlement curve across ${pts.length - 1} completed SportyBet slips — comparing SportyBet Flex (Cut-1/Cut-2) vs Flat-Singles staking.</span>
        </div>
        <div style="display:flex;gap:1rem;font-size:.82rem;font-weight:700">
          <span style="color:var(--good)">● SportyBet Flex Net: ${fmtSigned(curFlex)}</span>
          <span style="color:var(--brand)">● Flat Singles Net: ${fmtSigned(curSing)}</span>
        </div>
      </div>
      <div class="equity-chart-wrap">
        <svg viewBox="0 0 ${w} ${h}" class="equity-svg" role="img" aria-label="Cumulative settled net P&L curve">
          <line x1="${padX}" y1="${baseY}" x2="${w - padX}" y2="${baseY}" stroke="var(--line)" stroke-dasharray="4,4" />
          <text x="${padX + 4}" y="${Math.max(14, Number(baseY) - 5)}" font-size="10" fill="var(--muted)">₵0.00 Break-Even</text>
          <polyline points="${singPoly}" fill="none" stroke="var(--brand)" stroke-width="2.2" stroke-opacity="0.85" />
          <polyline points="${flexPoly}" fill="none" stroke="var(--good)" stroke-width="3" />
          ${flexDots}
          <text x="${padX}" y="${h - 6}" font-size="10" fill="var(--muted)">Slip #0 (₵0.00)</text>
          <text x="${w - padX}" y="${h - 6}" font-size="10" fill="var(--muted)" text-anchor="end">Latest Settled (#${pts.length - 1})</text>
        </svg>
      </div>
    </section>`;
}

function renderArenaLegBadge(settlement) {
  const st = settlement?.state || 'PENDING';
  if (st === 'WON') return `<span class="tag ok" style="font-weight:700">✅ WON</span>`;
  if (st === 'WON_EARLY') return `<span class="tag ok" style="font-weight:700;background:rgba(16,185,129,.22)">⚡ WON EARLY</span>`;
  if (st === 'LOST') return `<span class="tag miss" style="font-weight:700">❌ LOST</span>`;
  if (st === 'VOID') return `<span class="tag" style="font-weight:700">⚪ VOID/PUSH</span>`;
  if (st === 'UNVERIFIED') return `<span class="tag muted" style="font-weight:700">⚪ UNVERIFIED FEED</span>`;
  if (st === 'WINNING_LIVE') return `<span class="tag ok" style="border:1px solid var(--good)">🟢 WINNING LIVE</span>`;
  if (st === 'TRAILING_LIVE') return `<span class="tag" style="color:var(--warn);border:1px solid var(--warn)">🟡 IN-PLAY</span>`;
  return `<span class="tag muted">⏳ UPCOMING</span>`;
}

function renderArenaTicketStatusBadge(status, flexHits, flexStatus) {
  if (status === 'WON') return `<span class="tag ok" style="font-size:.82rem;font-weight:800">🏆 FULL ACCA WON (${flexHits.wonLegs}/${flexHits.totalLegs})</span>`;
  if (flexStatus === 'WON_FLEX_CUT1') return `<span class="tag ok" style="font-size:.82rem;font-weight:800;background:rgba(16,185,129,.22)">🎯 FLEX CUT-1 WON (${flexHits.wonLegs}/${flexHits.totalLegs} HIT!)</span>`;
  if (flexStatus === 'WON_FLEX_CUT2') return `<span class="tag ok" style="font-size:.82rem;font-weight:800;background:rgba(16,185,129,.18)">🎯 FLEX CUT-2 WON (${flexHits.wonLegs}/${flexHits.totalLegs} HIT!)</span>`;
  if (flexStatus === 'WON_FLEX_CUT3') return `<span class="tag ok" style="font-size:.82rem;font-weight:800;background:rgba(16,185,129,.15)">🎯 FLEX CUT-3 WON (${flexHits.wonLegs}/${flexHits.totalLegs} HIT!)</span>`;
  if (status === 'IN_PLAY') return `<span class="tag" style="background:rgba(239,68,68,.16);color:#ef4444;font-weight:800">🔴 LIVE IN-PLAY (${flexHits.wonLegs} Won · ${flexHits.liveWinningLegs + flexHits.liveTrailingLegs} Live)</span>`;
  if (status === 'PARTIAL_SETTLED') return `<span class="tag pick" style="font-weight:700">⚡ ${flexHits.wonLegs}/${flexHits.decidedLegs} Settled (${flexHits.pendingLegs} Pending)</span>`;
  if (status === 'INCOMPLETE') return `<span class="tag muted" style="font-weight:700">⚪ ${flexHits.wonLegs}/${flexHits.totalLegs} Verified (${flexHits.unverifiedLegs || 0} Feed Unavailable)</span>`;
  if (status === 'LOST') return `<span class="tag miss" style="font-weight:700">📊 SETTLED: ${flexHits.wonLegs}/${flexHits.totalLegs} HIT (${flexHits.hitRatePct ?? 0}%)</span>`;
  return `<span class="tag">⏳ PLACED &amp; WAITING (${flexHits.totalLegs} Folds)</span>`;
}

function ensureArenaAutoTimer() {
  if (arenaAutoTimer) {
    clearInterval(arenaAutoTimer);
    arenaAutoTimer = null;
  }
  if (state.view === 'arena' && state.arenaAutoSync) {
    arenaAutoTimer = setInterval(() => {
      if (state.view !== 'arena' || !state.arenaAutoSync) return;
      if (document.activeElement?.id === 'arena-search-input') return;
      renderArena(false, true);
    }, 45000);
  }
}

async function renderArena(forceSync = false, silent = false) {
  const main = $('#main');
  if (!silent) {
    main.innerHTML = `<p class="loading"><span class="spinner"></span> Syncing all pre-booked SportyBet Ghana slips against real-world live &amp; final scores from SportyBet, Sportradar &amp; ESPN…</p>`;
  }
  ensureArenaAutoTimer();

  try {
    const data = await api(`/api/arena${forceSync ? '?force=1' : ''}`);
    if (state.view !== 'arena') return;
    if (forceSync) showToast('✓ Synced live & completed real-world match scores!', 'ok');

    const S = data.summary || {};
    const tickets = data.tickets || [];
    const mktRows = data.marketBreakdown || [];
    const autopsyRules = data.learningFeedback?.autopsyRules || [];
    const allLegs = data.allLegs || [];
    const filter = state.arenaFilter || 'all';
    const q = (state.arenaSearch || '').trim().toLowerCase();

    const filteredTickets = tickets.filter((t) => {
      if (filter === 'live' && !(t.status === 'IN_PLAY' || (t.flexHits?.liveWinningLegs + t.flexHits?.liveTrailingLegs) > 0)) return false;
      if (filter === 'settled' && !(t.status === 'WON' || t.status === 'LOST' || (t.flexHits?.decidedLegs || 0) > 0)) return false;
      if (filter === 'upcoming' && t.status !== 'PENDING') return false;
      if (q) {
        const hay = `${t.title} ${t.shareCode || ''} ${(t.legs || []).map((l) => `${l.matchup} ${l.leagueName} ${l.pickLabel || l.sportyPick}`).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const filteredLegs = q
      ? allLegs.filter((l) => `${l.matchup} ${l.leagueName || ''} ${l.ticketTitle || ''} ${l.pickLabel || l.sportyPick || ''} ${l.marketName || ''}`.toLowerCase().includes(q))
      : allLegs;

    const ticketsHtml = filteredTickets.map((t) => {
      const fh = t.flexHits || { wonLegs: 0, lostLegs: 0, totalLegs: t.count || 1, decidedLegs: 0 };
      const winPct = fh.totalLegs > 0 ? Math.round((fh.wonLegs / fh.totalLegs) * 100) : 0;
      const lossPct = fh.totalLegs > 0 ? Math.round((fh.lostLegs / fh.totalLegs) * 100) : 0;
      const livePct = fh.totalLegs > 0 ? Math.round(((fh.liveWinningLegs + fh.liveTrailingLegs) / fh.totalLegs) * 100) : 0;

      const legsRowsHtml = (t.legs || []).map((leg, i) => {
        const st = leg.settlement || {};
        const statsBadges = [];
        if (st.stats?.corners != null) statsBadges.push(`🚩 ${st.stats.corners} Crn`);
        if (st.stats?.cards != null) statsBadges.push(`🟨 ${st.stats.cards} Crd`);
        if (st.stats?.shots != null) statsBadges.push(`🥅 ${st.stats.shots} Sh (${st.stats.sot ?? 0} SOT)`);
        return `
          <div class="ticket-leg" style="align-items:center;gap:.6rem;padding:.55rem .4rem;border-bottom:1px solid var(--border)">
            <div style="flex:1.4;min-width:190px">
              <div><b>${i + 1}. ${esc(leg.matchup)}</b></div>
              <div class="small muted">${esc(leg.leagueName || leg.leagueId || '')} · ${leg.date ? fmtTime(leg.date) : ''}</div>
            </div>
            <div style="flex:1.1;min-width:150px">
              <span class="leg-pick" style="font-weight:700">${esc(leg.pickLabel || leg.sportyPick || leg.label)}</span>
              <span class="leg-odds" style="margin-left:.35rem">@${leg.sportyOdds || leg.fairOdds}</span>
              <div class="small muted">${esc(leg.marketName || leg.group || '')} · Model ${pct(leg.p)}</div>
            </div>
            <div style="flex:1.1;min-width:150px;text-align:right">
              <div>${renderArenaLegBadge(st)}</div>
              <div class="small" style="margin-top:.15rem;font-weight:600">${esc(st.reason || 'Waiting for kick-off')}</div>
              ${statsBadges.length ? `<div class="small muted">${statsBadges.join(' · ')}</div>` : ''}
            </div>
          </div>`;
      }).join('');

      const sourceTag = t.source === 'user_placed'
        ? `<span class="tag ok">👤 User Booked Slip</span>`
        : `<span class="tag pick">🇬🇭 Pre-Booked SportyBet GH Slip</span>`;

      const isFlexWin = t.flexStatus === 'WON_FULL' || t.flexStatus === 'WON_FLEX_CUT1' || t.flexStatus === 'WON_FLEX_CUT2' || t.flexStatus === 'WON_FLEX_CUT3';

      return `
        <div class="ticket-card" style="border-left:4px solid ${isFlexWin ? 'var(--good)' : t.status === 'IN_PLAY' ? '#ef4444' : fh.wonLegs > fh.lostLegs ? 'var(--brand)' : 'var(--border)'}">
          <div class="ticket-card-head">
            <div>
              <div style="display:flex;gap:.45rem;align-items:center;flex-wrap:wrap;margin-bottom:.3rem">
                ${sourceTag}
                ${renderArenaTicketStatusBadge(t.status, fh, t.flexStatus)}
              </div>
              <h3>${esc(t.title)}</h3>
              <p class="ticket-desc">${esc(t.description || '')}</p>
            </div>
            <div style="text-align:right">
              <div class="small muted">Stake (₵)</div>
              <button type="button" class="btn" style="padding:.22rem .55rem;font-weight:700" onclick="window.oracleUpdateArenaStake('${esc(t.arenaId)}', ${t.stakeGHS || 100})">
                ₵${(t.stakeGHS || 100).toLocaleString()} ✎
              </button>
            </div>
          </div>

          ${t.shareCode ? renderSportyCodeBanner(t.shareCode, t.shareURL, t.count, t.totalSportyOdds) : ''}
          ${t.flexDirective ? renderFlexDirectiveBanner(t.flexDirective, t.legs, t.podSplits) : ''}

          <div class="ticket-stats" style="grid-template-columns:repeat(4,1fr)">
            <div><span>Folds / Odds</span><b>${t.count} · @${fmtOdds(t.totalSportyOdds)}</b></div>
            <div><span>Legs Hit</span><b style="color:var(--good)">${fh.wonLegs}/${fh.decidedLegs || fh.totalLegs}${fh.hitRatePct != null ? ` (${fh.hitRatePct}%)` : ''}</b></div>
            <div>
              <span>Sporty Flex Payout</span>
              <b style="color:${(t.flexPayoutGHS || 0) > 0 ? 'var(--good)' : 'var(--muted)'}">₵${(t.flexPayoutGHS || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
            </div>
            <div>
              <span>Flat Singles Return</span>
              <b style="color:${t.singlesPayoutGHS >= t.stakeGHS ? 'var(--good)' : 'var(--fg)'}">₵${(t.singlesPayoutGHS || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
            </div>
          </div>

          ${t.hedgeAdvice ? `
            <div style="background:rgba(16,185,129,.1);border:1px solid var(--good);border-radius:8px;padding:.55rem .75rem;font-size:.82rem">
              <b>🛡️ Live Cashout / Hedge-Lock Alert:</b> Est. SportyBet Cashout: <b style="color:var(--good)">₵${t.hedgeAdvice.cashoutOfferGHS.toLocaleString()}</b> — OR hedge <b>₵${t.hedgeAdvice.hedgeStakeGHS.toLocaleString()}</b> against <i>${esc(t.hedgeAdvice.nextMatchup)}</i> (@${t.hedgeAdvice.oppOdds}) to lock in <b style="color:var(--good)">+₵${t.hedgeAdvice.lockedProfitGHS.toLocaleString()} guaranteed profit</b>!
            </div>
          ` : ''}

          <div style="height:8px;background:var(--bg-alt);border-radius:99px;overflow:hidden;display:flex;margin:.35rem 0" title="${fh.wonLegs} Won, ${fh.liveWinningLegs + fh.liveTrailingLegs} Live, ${fh.lostLegs} Lost, ${fh.pendingLegs} Pending">
            <div style="width:${winPct}%;background:var(--good)"></div>
            <div style="width:${livePct}%;background:#f59e0b"></div>
            <div style="width:${lossPct}%;background:var(--bad)"></div>
          </div>

          <div class="ticket-legs" style="max-height:360px">${legsRowsHtml}</div>

          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;padding-top:.4rem;font-size:.82rem">
            <span class="muted">Full Acca Potential: <b>₵${(t.potentialWinGHS || 0).toLocaleString()}</b> · Flex Cut-1/2 Payout: <b style="color:${(t.flexPayoutGHS || 0) > 0 ? 'var(--good)' : 'var(--muted)'}">₵${(t.flexPayoutGHS || 0).toLocaleString()}</b></span>
            <div style="display:flex;gap:.35rem;flex-wrap:wrap">
              <button type="button" class="btn" style="padding:.25rem .65rem" title="Strip started games & mint a fresh SportyBet Ghana code for the remaining active legs" onclick="window.oracleRebookClean({ shareCode: '${esc(t.shareCode || '')}', selections: ${JSON.stringify(t.legs || []).replace(/"/g, '&quot;')} }, this)">🧹 Clean Active Code</button>
              <button type="button" class="btn" style="padding:.25rem .65rem" onclick="window.oracleLoadTicket(${JSON.stringify(t.legs || []).replace(/"/g, '&quot;')}, false, '${esc(t.shareCode || '')}')">📥 Load in Slip Centre</button>
            </div>
          </div>
        </div>`;
    }).join('');

    const allLegsLedgerHtml = filteredLegs.map((l, idx) => {
      const st = l.settlement || {};
      return `
        <tr>
          <td class="num">${idx + 1}</td>
          <td>
            <b>${esc(l.matchup)}</b>
            <div class="small muted">${esc(l.leagueName || '')} · ${esc(l.ticketTitle || '')}</div>
          </td>
          <td><span class="tag">${esc(l.marketName || l.group || '')}</span></td>
          <td><b>${esc(l.pickLabel || l.sportyPick || l.label)}</b></td>
          <td class="n num"><b>@${l.sportyOdds || l.fairOdds}</b></td>
          <td class="n num">${pct(l.p)}</td>
          <td>${renderArenaLegBadge(st)}</td>
          <td class="small">${esc(st.reason || 'Waiting for kick-off')}</td>
        </tr>`;
    }).join('');

    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem;margin-bottom:1.1rem">
        <div>
          <h2 style="margin:0">🧪 Cooked Odds &amp; Ticket Verification Arena</h2>
          <p class="muted" style="margin:.25rem 0">Every genuine pre-kickoff SportyBet Ghana ticket, Rollover Banker, Correct Score Vault bundle, and user-booked slip is placed here, graded in real time against live &amp; final results from <b>SportyBet Ghana, Sportradar &amp; ESPN</b>, and fed back into the AI Cooker.</p>
        </div>
        <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
          <span class="small muted">Last synced: ${data.lastSyncedAt ? new Date(data.lastSyncedAt).toLocaleTimeString() : 'just now'}</span>
          <button type="button" class="chip" id="arena-autosync-btn" aria-pressed="${Boolean(state.arenaAutoSync)}">
            ${state.arenaAutoSync ? '🟢 Live 45s Auto-Sync: ON' : '⚪ Auto-Sync: OFF'}
          </button>
          <button type="button" class="btn primary" id="arena-sync-btn">🔄 Sync Live Scores Now</button>
        </div>
      </div>

      <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(195px,1fr));gap:.85rem;margin-bottom:1.25rem">
        <div class="panel" style="margin:0;border-left:4px solid var(--good)">
          <div class="small muted">Standard Cooked Legs Hit Rate</div>
          <div style="font-size:1.75rem;font-weight:900;color:var(--good);margin:.2rem 0">${S.standardLegHitRate != null ? `${S.standardLegHitRate}%` : '–'}</div>
          <div class="small muted"><b>${S.stdWon || 0}/${S.stdDecided || 0}</b> non-CS legs won · All legs: <b>${S.overallLegHitRate ?? '–'}${S.overallLegHitRate != null ? '%' : ''}</b> (${S.legsWon || 0}/${(S.legsWon || 0) + (S.legsLost || 0)})</div>
        </div>

        <div class="panel" style="margin:0;border-left:4px solid var(--brand)">
          <div class="small muted">Real SportyBet Slips Tracked</div>
          <div style="font-size:1.75rem;font-weight:900;margin:.2rem 0">${S.totalTickets || 0} <span style="font-size:.95rem;color:var(--good)">(${S.flexTicketsWon || 0}/${S.ticketsSettled || 0} Flex Won)</span></div>
          <div class="small muted">🔴 <b>${S.ticketsInPlay || 0}</b> Live In-Play · ⏳ <b>${S.ticketsPending || 0}</b> Upcoming</div>
        </div>

        <div class="panel" style="margin:0;border-left:4px solid #ef4444">
          <div class="small muted">Live In-Play Right Now</div>
          <div style="font-size:1.75rem;font-weight:900;color:#ef4444;margin:.2rem 0">${S.legsLive || 0} Legs</div>
          <div class="small muted">🟢 <b>${S.legsLiveWinning || 0}</b> Winning live · 🟡 <b>${S.legsLiveTrailing || 0}</b> Trailing live</div>
        </div>

        <div class="panel" style="margin:0;border-left:4px solid ${(S.netProfitFlexGHS || 0) >= 0 ? 'var(--good)' : 'var(--brand)'}">
          <div class="small muted">SportyBet Flex (Cut-1/Cut-2) Net P&amp;L</div>
          <div style="font-size:1.65rem;font-weight:900;color:${(S.netProfitFlexGHS || 0) >= 0 ? 'var(--good)' : 'var(--fg)'};margin:.2rem 0">
            ${(S.netProfitFlexGHS || 0) >= 0 ? '+' : ''}₵${(S.netProfitFlexGHS || 0).toLocaleString()} (${(S.flexRoiPct || 0) >= 0 ? '+' : ''}${S.flexRoiPct || 0}% ROI)
          </div>
          <div class="small muted">Settled Staked: <b>₵${(S.totalStakedGHS || 0).toLocaleString()}</b> → Flex Return: <b>₵${(S.totalFlexReturnedGHS || 0).toLocaleString()}</b></div>
        </div>

        <div class="panel" style="margin:0;border-left:4px solid ${S.netProfitSinglesGHS >= 0 ? 'var(--good)' : 'var(--warn)'}">
          <div class="small muted">Flat-Singles Net P&amp;L (Settled)</div>
          <div style="font-size:1.65rem;font-weight:900;color:${S.netProfitSinglesGHS >= 0 ? 'var(--good)' : 'var(--bad)'};margin:.2rem 0">
            ${S.netProfitSinglesGHS >= 0 ? '+' : ''}₵${(S.netProfitSinglesGHS || 0).toLocaleString()} (${S.singlesRoiPct >= 0 ? '+' : ''}${S.singlesRoiPct}%)
          </div>
          <div class="small muted">Settled Staked: <b>₵${(S.totalStakedGHS || 0).toLocaleString()}</b> → Returned: <b>₵${(S.totalSinglesReturnedGHS || 0).toLocaleString()}</b></div>
        </div>
      </div>

      ${renderEquityCurveSvg(data.equityCurve)}

      ${autopsyRules.length ? `
        <section class="panel" style="margin-bottom:1.25rem;border-left:4px solid var(--brand)">
          <h3 style="margin-top:0">🧠 Closed-Loop AI Self-Correction (Rules Learned from Settled Real-World Legs)</h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:.75rem">
            ${autopsyRules.map((r) => `
              <div style="background:var(--bg-alt);border:1px solid var(--border);border-radius:10px;padding:.75rem">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:.4rem;margin-bottom:.35rem">
                  <b style="font-size:.88rem">${esc(r.badge)}</b>
                  <span class="tag ok">${esc(r.impact)}</span>
                </div>
                <div class="small muted">${esc(r.lesson)}</div>
              </div>
            `).join('')}
          </div>
        </section>
      ` : ''}

      <section class="panel" style="margin-bottom:1.25rem">
        <h3 style="margin-top:0">📊 Real-World Performance by Market Category (Cooked Odds vs. Actual Results)</h3>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Market Category</th>
                <th class="n">Won ✅</th>
                <th class="n">Lost ❌</th>
                <th class="n">Live Now 🔴</th>
                <th class="n">Upcoming ⏳</th>
                <th class="n">Hit Rate %</th>
                <th class="n">Avg Winning Odds</th>
                <th class="n">1-Unit Flat ROI</th>
                <th class="n">AI Cooker Weight</th>
              </tr>
            </thead>
            <tbody>
              ${mktRows.map((m) => `
                <tr>
                  <td><b>${esc(m.group)}</b></td>
                  <td class="n num" style="color:var(--good);font-weight:700">${m.won}</td>
                  <td class="n num" style="color:var(--bad)">${m.lost}</td>
                  <td class="n num" style="color:#ef4444">${m.live}</td>
                  <td class="n num muted">${m.pending}</td>
                  <td class="n num"><b>${m.hitRate != null ? `${m.hitRate}%` : '–'}</b></td>
                  <td class="n num">${m.avgWonOdds ? `@${m.avgWonOdds}` : '–'}</td>
                  <td class="n num" style="color:${(m.flatRoiPct || 0) >= 0 ? 'var(--good)' : 'var(--bad)'};font-weight:700">
                    ${m.flatRoiPct != null ? `${m.flatRoiPct >= 0 ? '+' : ''}${m.flatRoiPct}%` : '–'}
                  </td>
                  <td class="n num"><span class="tag ${(m.calibrationBoost || 1) > 1 ? 'ok' : (m.calibrationBoost || 1) < 1 ? 'miss' : ''}">${((m.calibrationBoost || 1) * 100).toFixed(0)}%</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>

      <div class="toolbar" style="margin-bottom:1rem">
        <div class="mkt-tabs" style="margin-bottom:0">
          ${[
            ['all', `🎫 All Placed Tickets (${tickets.length})`],
            ['settled', `✅ Settled & Verified Slips (${tickets.filter((t) => t.status === 'WON' || t.status === 'LOST' || (t.flexHits?.decidedLegs || 0) > 0).length})`],
            ['live', `🔴 Live In-Play (${tickets.filter((t) => t.status === 'IN_PLAY' || (t.flexHits?.liveWinningLegs + t.flexHits?.liveTrailingLegs) > 0).length})`],
            ['upcoming', `⏳ Upcoming Slips (${tickets.filter((t) => t.status === 'PENDING').length})`],
            ['ledger', `📋 Individual Legs Ledger (${allLegs.length})`],
          ].map(([id, label]) => `
            <button type="button" class="chip" aria-selected="${filter === id}" data-arena-filter="${id}">${label}</button>
          `).join('')}
        </div>
        <input id="arena-search-input" class="search-input" type="search" placeholder="🔍 Search Arena team, slip, or code…" value="${esc(state.arenaSearch || '')}">
      </div>

      ${filter === 'ledger' ? `
        <section class="panel">
          <h3>📋 Complete Individual Cooked Odds Ledger (${filteredLegs.length} Picks Shown)</h3>
          <div class="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Match &amp; Ticket</th>
                  <th>Market</th>
                  <th>Cooked Pick</th>
                  <th class="n">Odds</th>
                  <th class="n">Model Prob</th>
                  <th>Status</th>
                  <th>Real-World Result &amp; Stats</th>
                </tr>
              </thead>
              <tbody>${allLegsLedgerHtml}</tbody>
            </table>
          </div>
        </section>
      ` : `
        <div class="ticket-grid">${ticketsHtml || '<p class="muted">No tickets match this filter.</p>'}</div>
      `}
    `;

    $('#arena-sync-btn')?.addEventListener('click', () => renderArena(true, false));
    $('#arena-autosync-btn')?.addEventListener('click', () => {
      state.arenaAutoSync = !state.arenaAutoSync;
      ensureArenaAutoTimer();
      renderArena(false, true);
    });
    $('#arena-search-input')?.addEventListener('change', (e) => {
      state.arenaSearch = e.target.value;
      renderArena(false, true);
    });
    $('#arena-search-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        state.arenaSearch = e.target.value;
        renderArena(false, true);
      }
    });
    main.querySelectorAll('[data-arena-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.arenaFilter = btn.dataset.arenaFilter;
        renderArena(false, true);
      });
    });
  } catch (err) {
    main.innerHTML = `<p class="error">Arena failed to load: ${esc(err.message)}</p>`;
  }
}

async function renderTrack() {
  const main = $('#main');
  main.innerHTML = '<p class="loading"><span class="spinner"></span> Loading track record & learning metrics…</p>';
  try {
    const [t, arenaSnap] = await Promise.all([
      api('/api/track'),
      api('/api/arena').catch(() => null),
    ]);
    const name = (id) => leagueInfo(id)?.name || id;
    const AS = arenaSnap?.summary;

    const lessonsData = await api('/api/lessons').catch(() => ({ lessons: [] }));
    const recentLessons = lessonsData.lessons || [];

    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;margin-bottom:1rem">
        <div>
          <h2 style="margin:0">📈 Live Track Record & Learning Scorecard</h2>
          <p class="muted" style="margin:.25rem 0">Every pre-game prediction and cooked SportyBet ticket is permanently recorded before kick-off and graded automatically against real-world results. Game 1X2 tracked: <b>${t.tracked}</b>, graded: <b>${t.graded}</b>, pending: <b>${t.pending || 0}</b>.</p>
        </div>
        <a href="#/arena" class="btn primary">🧪 Open Cooked Odds & Ticket Arena (${AS?.totalTickets || 0} Slips) →</a>
      </div>

      ${AS ? `
        <section class="panel" style="margin-bottom:1rem;border-left:4px solid var(--good)">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
            <div>
              <h3 style="margin:0">🧪 Cooked Odds & SportyBet Tickets Real-World Summary</h3>
              <p class="small muted" style="margin:.2rem 0">Live performance of all cooked Vhim Bankers, 20-Fold Multis, Identical Slips & Correct Score Vault picks against real match outcomes.</p>
            </div>
            <a href="#/arena" class="btn">Inspect All Settled & Live Tickets →</a>
          </div>
          <div class="stat-grid" style="margin-top:.75rem">
            <div class="stat"><div class="k">Standard Leg Hit Rate</div><div class="v" style="color:var(--good)">${AS.standardLegHitRate ?? 0}%</div><div class="small muted">${AS.stdWon}/${AS.stdDecided} legs won</div></div>
            <div class="stat"><div class="k">Full Accas Won</div><div class="v">${AS.ticketsWon}/${AS.ticketsSettled}</div><div class="small muted">${AS.totalTickets} total placed</div></div>
            <div class="stat"><div class="k">Flex / Singles ROI</div><div class="v" style="color:${AS.singlesRoiPct >= 0 ? 'var(--good)' : 'var(--bad)'}">${AS.singlesRoiPct >= 0 ? '+' : ''}${AS.singlesRoiPct}%</div><div class="small muted">${AS.netProfitSinglesGHS >= 0 ? '+' : ''}₵${AS.netProfitSinglesGHS}</div></div>
            <div class="stat"><div class="k">Full Acca ROI</div><div class="v" style="color:${AS.accaRoiPct >= 0 ? 'var(--good)' : 'var(--fg)'}">${AS.accaRoiPct >= 0 ? '+' : ''}${AS.accaRoiPct}%</div><div class="small muted">Returned ₵${AS.totalAccaReturnedGHS}</div></div>
          </div>
        </section>` : ''}

      <div class="cols">
        <section class="panel">
          <h3>Overall 1X2 Performance</h3>
          <div class="tbl-wrap"><table>
            <thead><tr><th>Predictor</th><th class="n">Accuracy</th><th class="n">Brier ↓</th><th class="n">Games</th></tr></thead>
            <tbody>
              <tr class="highlight"><td>⭐ Our ensemble</td>${gradeCells(t.overall.ours)}</tr>
              <tr><td>💰 Betting market</td>${gradeCells(t.overall.market)}</tr>
              <tr><td>🤖 Gemini AI</td>${gradeCells(t.overall.ai)}</tr>
            </tbody></table></div>
        </section>

        <section class="panel">
          <h3>AI Memory Impact (A/B Test)</h3>
          <div class="tbl-wrap"><table>
            <thead><tr><th>Condition</th><th class="n">Accuracy</th><th class="n">Brier ↓</th><th class="n">Predictions</th></tr></thead>
            <tbody>
              <tr class="highlight"><td>🧠 With past lessons applied</td>${gradeCells(t.aiLessons?.with)}</tr>
              <tr><td>Without lessons (early games)</td>${gradeCells(t.aiLessons?.without)}</tr>
              <tr><td>🔬 Withheld (control group)</td>${gradeCells(t.aiLessons?.withheld)}</tr>
            </tbody></table>
          </div>
          <p class="small muted" style="margin:.6rem 0 0">25% of live analyses withhold past lessons to scientifically evaluate whether AI mistake-memory improves accuracy.</p>
        </section>
      </div>

      ${t.markets?.length ? `
        <section class="panel" style="margin-top:1rem">
          <h3>Extra Markets Track Record</h3>
          <div class="tbl-wrap"><table>
            <thead><tr><th>Market</th><th class="n">Model Accuracy</th><th class="n">Base Accuracy</th><th class="n">Brier Score ↓</th><th class="n">Graded</th></tr></thead>
            <tbody>
              ${t.markets.map((m) => `
                <tr>
                  <td><b>${esc(m.name)}</b></td>
                  <td class="n"><b>${pct1(m.accuracy)}</b></td>
                  <td class="n muted">${pct1(m.baseAccuracy)}</td>
                  <td class="n">${fx(m.brier)}</td>
                  <td class="n">${m.n}</td>
                </tr>`).join('')}
            </tbody>
          </table></div>
        </section>` : ''}

      ${recentLessons.length ? `
        <section class="panel" style="margin-top:1rem">
          <h3>Recent Lessons Learned by Gemini AI</h3>
          <div style="display:grid;gap:.6rem;margin-top:.5rem">
            ${recentLessons.slice(0, 6).map((l) => `
              <div class="lesson-card">
                <div><b>${esc(l.matchup || l.league)}</b> <span class="tag" style="font-size:.72rem">${esc(l.cause)}</span> <span class="small muted">${l.date ? l.date.slice(0, 10) : ''}</span></div>
                <div>${esc(l.lesson)}</div>
              </div>`).join('')}
          </div>
        </section>` : ''}

      ${Object.keys(t.leagues).length ? `<section class="panel" style="margin-top:1rem"><h3>By league</h3><div class="tbl-wrap"><table>
        <thead><tr><th>League</th><th class="n">Ours</th><th class="n">Market</th><th class="n">AI</th><th class="n">Games</th></tr></thead>
        <tbody>${Object.entries(t.leagues).map(([id, x]) => `<tr><td>${esc(name(id))}</td><td class="n">${x.ours.n ? pct1(x.ours.accuracy) : '–'}</td><td class="n">${x.market.n ? pct1(x.market.accuracy) : '–'}</td><td class="n">${x.ai.n ? pct1(x.ai.accuracy) : '–'}</td><td class="n">${x.ours.n}</td></tr>`).join('')}</tbody>
      </table></div></section>` : ''}

      <section class="panel" style="margin-top:1rem"><h3>Recently graded games</h3>
        ${t.recent.length ? `<div class="tbl-wrap"><table><thead><tr><th>Game</th><th>League</th><th>Score</th><th>Our pick</th><th></th></tr></thead><tbody>
        ${t.recent.map((r) => `<tr><td>${esc(r.away)} @ ${esc(r.home)}<div class="small muted">${new Date(r.date).toLocaleDateString()}</div></td><td>${esc(name(r.league))}</td><td class="num">${esc(r.score || '')}</td><td>${esc(r.pick === 'home' ? r.home : r.pick === 'away' ? r.away : 'Draw')} ${pct(r.probs[r.pick])}</td><td>${r.correct ? '<span class="tag ok">✓</span>' : '<span class="tag miss">✗</span>'}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">Nothing graded yet — browse some upcoming games, then come back after they finish.</p>'}
      </section>`;
  } catch (err) {
    main.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ---------- routing ----------

function render() {
  if (state.view !== 'arena' && arenaAutoTimer) {
    clearInterval(arenaAutoTimer);
    arenaAutoTimer = null;
  }
  document.querySelectorAll('.views a').forEach((a) => (a.dataset.view === state.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  renderSelector();
  updateSlipBadge();
  if (state.view === 'tickets') return renderTickets();
  if (state.view === 'props') return renderProps();
  if (state.view === 'vault') return renderVault();
  if (state.view === 'arena') return renderArena();
  if (state.view === 'picks') return renderPicks();
  if (state.view === 'radar') return renderRadar();
  if (state.view === 'lab') return renderLab();
  if (state.view === 'track') return renderTrack();
  return renderGames();
}

function route() {
  const v = location.hash.replace(/^#\//, '').split('/')[0];
  state.view = ['games', 'tickets', 'props', 'vault', 'arena', 'picks', 'radar', 'lab', 'track'].includes(v) ? v : 'tickets';
  render();
}

async function init() {
  try {
    const c = await api('/api/catalog');
    state.catalog = c.sports;
    state.aiEnabled = c.aiEnabled;
    if (!leagueInfo()) state.league = 'eng.1';
    const s = $('#ai-status');
    s.textContent = c.aiEnabled ? '● SportyBet GH Live + Gemini AI' : '● SportyBet GH Live Engine';
    s.classList.add('on');
    window.addEventListener('hashchange', route);
    updateSlipBadge();
    ensureSlipVaultLoaded();
    pollAlertsBackground(true);
    setInterval(() => pollAlertsBackground(false), 45000);
    route();
  } catch (err) {
    $('#main').innerHTML = `<p class="error">Could not reach the server: ${esc(err.message)}</p>`;
  }
}

init();
