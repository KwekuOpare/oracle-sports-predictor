# 🔮 Oracle — Multi-Match Sports Predictor, SportyBet Ghana Code Cooker & Live Verification Arena

Predicts sports games across **soccer, basketball, football, hockey, baseball, tennis, and MMA** with a self-learning statistical + Gemini AI ensemble, **checks real team Last-15 form, Home/Away venue splits, and direct Head-to-Head (`H2H`) match history (`server/history.js`) BEFORE suggesting bets**, models **70+ betting & tactical prop markets** (**Throw-Ins, Goal Kicks, Shots, Shots on Target, Corners, Yellow/Red Cards, Offsides, Fouls, GG/NG, Halves & Correct Scores**), synthesizes **2-game to 50-game (`20,000,000x+` / `20M+` Mega-Odds) accumulators** strictly within **SportyBet Ghana's 50-game limit** with **real 6-character booking codes**, issues exact **SportyBet Flex / Cut-X Directives**, and verifies every cooked slip against live & final real-world scores in the **Verification Arena**.

## Quick Start

```powershell
git clone https://github.com/KwekuOpare/oracle-sports-predictor.git
cd oracle-sports-predictor
npm install
copy .env.example .env      # optional: paste GEMINI_API_KEY into .env for Gemini AI search grounding
npm start                   # open http://localhost:3456
```

Or double-click `Start-Sports-Predictor.bat` on Windows.

---

## Key Capabilities

### 1. 📜 Pre-Bet Historical Form, Lineups, Squad Rotation, Referee & Official Season Prop Veto Gate (`server/history.js` & `server/lineups.js`)
- Queries live Sportradar historical feeds (`Last-15` completed matches per team + direct `H2H` meetings), official match info (`match_info`, `match_squads` confirmed Starting XI vs previous XI rotation, `match_funfacts`), official season team & top-scorer telemetry (`stats_season_uniqueteamstats`, `stats_season_topgoals`), and ESPN `injuries` + `officials` + `rosters` **before** suggesting any bet.
- Hard-vetoes heavy lineup rotation (`>= 5` XI changes), missing top goalscorers, injury crises, and conflicting season prop averages (shots, SOT, corners, cards), displaying transparent `📜 Form ... · H2H ...` and `✅ XI Confirmed / 🧑‍⚖️ Ref` badges on every leg.

### 2. 🥅 Deep Per-Match SportyBet Extraction: Player Props, Combo Shields, 1st Half, Throws, GK & Shots (`server/sportybet.js`)
- Queries SportyBet Ghana's full `/api/gh/factsCenter/event` endpoint across top upcoming football fixtures to unlock **200–650+ real bookable markets per match** beyond the lite catalog:
  - **Player Props (`776`, `777`, `800297`, `800289`)**: Player Total Shots, Player Shots on Target (SOT), Goalkeeper Saves, and Player Score/Assist.
  - **Combo & "Or" Shield Markets (`547`, `546`, `37`, `35`, `36`, `854`, `858`, `860`, `862`, `1179`)**: `DC & O/U`, `DC & GG/NG`, `1X2 & O/U`, `Home/Away Win OR Over 2.5`, `Home/Away Win OR GG`, and `1st Half OR FT Result` — modeled via joint Dixon-Coles bivariate Poisson scoreline grids.
  - **1st Half Markets (`60`, `68`, `63`, `64`, `75`, `152`, `800064`)**: 1H `1X2`, 1H `O/U (0.5–2.5)`, 1H Double Chance, 1H Draw No Bet, 1H `GG/NG`, 1H Correct Score, and 1H `1UP`.
  - **Match Tactical Props**: Shots & SOT (`O/U`, Team `O/U`, `1X2`), Corners, Bookings/Cards, Throw-Ins (`O/U` & `1X2`), Goal Kicks (`O/U` & `1X2`), Fouls, and Offsides `1X2` (`900570`).

### 3. 👑 Multi-Match Compounding up to `20,000,000x+` (`20M+`), Pre-Booked Pod A–D Codes & 1-Click Clean Re-Booker
- Enforces SportyBet Ghana's strict **`50`-game maximum** across all curated slips, custom synthesizers, booking codes, and the interactive **Slip Centre**.
- **Pre-Booked 6-Char Pod Split Codes (`Pod A / B / C / D`)**: Every `20–50` game accumulator automatically pre-books real 6-character SportyBet Ghana booking codes for its `10–13` leg Pods alongside the main `1M+` / `20M+` code and Poisson-Binomial **Flex / Cut-X Directive**.
- **1-Click "Strip Started & Mint Fresh Code" (`POST /api/sportybet/rebook-clean`)**: Audits any SportyBet Ghana code or active slip against live kickoff/market status, strips locked or already-started matches, and immediately mints a fresh 6-character SportyBet Ghana code for the remaining active pre-match legs.

### 4. 📉 Real 15-Minute SportyBet Ghana Odds-Drop Time-Series Recorder (`server/odds-tracker.js`)
- Continuously snapshots live SportyBet Ghana odds every 15 minutes into `data/odds-history.json`, recording genuine multi-snapshot opening → peak → current odds trajectories, drop percentages, and implied probability jumps.
- Renders inline **SVG Time-Series Sparklines** on `#/radar` (`sporty_time_series_crash`) and boosts real smart-money steam legs in candidate scoring.

### 5. 🔔 Instant Telegram Bot + Browser Push Alert Engine (`server/alerts.js`)
- Delivers deduplicated real-time HTML push notifications via **Telegram Bot API** and **Web Browser Desktop `Notification` API** (configurable in `.env` or live inside the topbar `🔔 Alerts` modal with masked token security) for:
  1. **Live Arena Cashout / Hedge-Lock Windows**
  2. **Settled Winning Tickets (`WON` & `WON_FLEX_CUT*`)**
  3. **Sharp Live SportyBet Odds Crashes**
  4. **Daily Pre-Booked SportyBet Ghana Codes Digest**

### 6. 🧪 Live Cooked Odds & Ticket Verification Arena (`#/arena` — Zero Demos / Zero Simulations)
- Tracks **only genuine pre-kickoff SportyBet Ghana slips & user-booked slips** (zero demos, zero synthetic backtests, zero fake starting bankroll) and grades Main, 1st-Half, Combo Shield, and Prop markets against official SportyBet, Sportradar, and ESPN match feeds.

---

## API Reference

- `GET /api/overview`: Command deck snapshot (Rollover Banker, Combo Shield Banker, 50-Game `20M+` Mega Multi, `1M+` Grand Slam, Arena P&L, Odds Tracker stats, Unread Alerts)
- `GET /api/tickets` & `POST /api/tickets/generate`: History- & lineup-vetted SportyBet Ghana tickets (`≤ 50` games) with Pre-Booked `Pod A–D` codes (`modes`: `mixed`, `20m`, `million`, `combos`, `1h`, `player_props`, `shots`, `throws_gk`, `corners`, `cards`, `ou1.5`, `ou2.5`, `gg`, `1x2`, `cs`)
- `POST /api/sportybet/book` & `POST /api/sportybet/rebook-clean`: Live SportyBet Ghana booking code generator & 1-click started-leg stripper / re-booker
- `GET /api/props?category=all&minP=0.65`: Deep SportyBet Player Props, Combo Shields, 1st Half, Throw-Ins, Goal Kicks, Shots, SOT, Corners & Cards hub
- `GET /api/lineups/:eventId`: Real Sportradar + ESPN Starting XI, squad rotation, injuries, referee, stadium & official season prop profile
- `GET /api/odds-movements` & `GET /api/odds-movements/:eventId`: Real 15-minute SportyBet Ghana odds-drop time-series snapshots
- `GET /api/alerts`, `POST /api/alerts/config`, `POST /api/alerts/test`, `POST /api/alerts/send-daily-codes`: Real-time Telegram & Browser Push Alert Center
- `GET /api/arena`: Live & historical real-world verification ledger for all cooked tickets and legs

> Predictions are probabilistic estimates for research, analytical testing, and entertainment — always apply bankroll discipline and follow the Oracle Flex Directives on high-fold accumulators.
