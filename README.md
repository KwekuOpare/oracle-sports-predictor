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

### 1. 📜 Pre-Bet Historical Form, Venue Split & Direct H2H Verification (`server/history.js`)
- Queries live Sportradar historical feeds (`Last-15` completed matches per team + direct `H2H` meetings) for upcoming SportyBet fixtures **before** suggesting any bet.
- Computes empirical hit rates (Home/Away win/unbeaten rates, Over 1.5/2.5, BTTS, 1st-Half goals, clean sheets, goals scored/conceded, and H2H dominance), **hard-vetoes form/H2H traps** (e.g. poor-form favorites or chronic low-scoring traps), blends empirical history (`28%`) with the de-vigged statistical ensemble (`72%`), and displays transparent `📜 Form ... · H2H ...` proof on every leg.

### 2. 👑 Multi-Match Compounding up to `20,000,000x+` (`20M+`) Within SportyBet's 50-Game Limit
- Enforces SportyBet Ghana's strict **`50`-game maximum** across all curated slips, custom synthesizers, booking codes, and the interactive **Slip Centre**.
- Compounds **history-verified, high-accuracy legs (`@1.35–@1.82` geometric pacing)** across up to 50 distinct matches to reach `1,000,000x+` (`1M+`), `5,000,000x` (`5M+`), `10,000,000x` (`10M+`), and **`20,000,000x+` (`20M+` History-Verified Mega Multi)** without exceeding 50 games.
- Includes curated daily slips:
  - 🛡️ **Daily 2.00x–3.00x Rollover Banker**
  - 🔥 **Vhim Sure Banker (5-Fold)**
  - 🚀 **30-Game High-Accuracy Super Multi**
  - 🔥 **48-Game "MILLION-ODDS" (`1M+`) Vhim Grand Slam**
  - 👑 **50-Game "20-MILLION+" (`20M+`) History-Verified Mega Multi**
  - 🥅 **High-Accuracy Shots, SOT, Corners & Props Sniper (8-Fold)**
  - 🎯 **Correct Score Sniper & Slip Centre 20-Game Vault (`#/vault`)**

### 3. 🛡️ Exact SportyBet Flex / Cut-X Directive Engine
Every cooked or custom ticket runs **exact Poisson-Binomial Dynamic Programming** over its leg probabilities to calculate `expectedHits`, `P(Full Acca)`, `P(Cut-1)`, `P(Cut-2)`, `P(Cut-3)`, and `P(Cut-5)`, surfacing an explicit **Oracle Flex Directive Banner**:
- **🟢 PLAY STRAIGHT (NO FLEX NEEDED)**: Short high-confidence Rollover Bankers (`2–5` games) where full-multiplier EV dominates.
- **🛡️ ENABLE SPORTYBET FLEX: CUT-1**: Medium multis (`6–11` games) where 1 upset slip still locks profit.
- **🛡️ ENABLE SPORTYBET FLEX: CUT-2 (OR CUT-1)**: `12–24` game multis where variance requires a 2-cut cushion.
- **🚨 MANDATORY SPORTYBET MAX-FLEX (CUT-3 / CUT-5) + POD SPLIT**: `25–50` game `1M+` & `20M+` Grand Slams — includes one-click **Pod A / Pod B / Pod C / Pod D (`12–13` game sub-slips)** loading in the Slip Centre alongside the full 50-game lotto code.

### 4. 🥅 High-Accuracy Throws, Goal Kicks, Shots, SOT, Corners & Cards (`#/props`)
- Dedicated **`#/props` ("Throws, GK & Shots")** hub + full per-match breakdowns (`#/games`) and section filters (`#/picks`) backed strictly by **real live SportyBet Ghana bookable markets** and **real ESPN historical `StatsModel` game-log distributions** (zero synthetic `1X2`-guessed prop formulas):
  - **Shots & Shots on Target (SOT)**: Match & Team Shots O/U, Match & Team SOT O/U, Most Shots `1X2`, Most SOT `1X2` (with live SportyBet Ghana booking).
  - **Corners, Bookings/Cards, Fouls, Offsides, Throw-Ins & Goal Kicks**: Negative-Binomial overdispersed modeling (`r` dispersion parameter) for real bookable and historical game-log markets.
- Strictly filters `#/props` to **high-likelihood, history-vetted selections (`65%–90%+` confidence)** so weak coin-flip props are never surfaced.

### 5. 🧪 Live Cooked Odds & Ticket Verification Arena (`#/arena` — Zero Demos / Zero Simulated Backtests)
- Tracks **only genuine pre-kickoff SportyBet Ghana slips & user-booked slips** (zero seeded demo slips, zero retroactive `verified_backtest` simulations, zero fake starting bankroll).
- Syncs live in-play and official final scores + match stats across all 6 SportyBet sports via **SportyBet Ghana live feeds**, **official Sportradar post-match feeds**, and **ESPN Global Scoreboards**.
- Plots a **Real Settled Cumulative Net P&L Curve (`₵0.00` baseline)**, requires official result feeds before settling (`UNVERIFIED` legs never push to false wins), and feeds settled market calibration weights back into the AI Ticket Cooker.

### 6. 🧠 Self-Learning Brain & Market Integrity Radar (`#/lab` & `#/radar`)
- **Genetic Algorithm Evolution (`server/brain.js`)** with Champion vs. Challenger holdout validation, learned ensemble trust weights, and Gemini AI mistake post-mortems (`server/lessons.js`).
- **Market Surveillance Radar (`#/radar`)** detecting sharp odds crashes, syndicate steam moves, and model-vs-market divergences.

---

## API Reference

- `GET /api/overview`: Command deck snapshot (Rollover Banker, 50-Game `20M+` Mega Multi, `1M+` Grand Slam, Props Sniper, Arena P&L)
- `GET /api/tickets`: Curated history-verified & SportyBet Ghana booked multi-match tickets (`≤ 50` games) with Flex Directives
- `POST /api/tickets/generate`: Custom Accumulator Synthesizer (`2`–`50` games max, `targetOdds` up to `20,000,000+`, modes: `mixed`, `20m`, `million`, `shots`, `throws_gk`, `corners`, `cards`, `ou1.5`, `ou2.5`, `gg`, `1x2`, `cs`)
- `GET /api/props?category=all&minP=0.65`: High-accuracy Throw-Ins, Goal Kicks, Shots, SOT, Corners, Cards & Fouls hub + booked Props Sniper ticket
- `POST /api/sportybet/book`: Live SportyBet Ghana share-code generator (`POST /api/gh/orders/share`, capped at 50 games)
- `GET /api/arena`: Live & historical real-world verification ledger for all cooked tickets and legs
- `GET /api/picks?minP=0.65&group=all`: Cross-league history-verified high-probability & `+EV` picks scanner
- `GET /api/games/:league` & `GET /api/game/:league/:id`: Full match & 70+ market statistical predictions

> Predictions are probabilistic estimates for research, analytical testing, and entertainment — always apply bankroll discipline and follow the Oracle Flex Directives on high-fold accumulators.
