# 🔮 Oracle — Multi-Match Sports Predictor, SportyBet Ghana Code Cooker & Live Verification Arena

Predicts sports games across **soccer, basketball, football, hockey, baseball, tennis, and MMA** with a self-learning statistical + Gemini AI ensemble, models **70+ betting & tactical prop markets** (**Throw-Ins, Goal Kicks, Shots, Shots on Target, Corners, Yellow/Red Cards, Offsides, Fouls, GG/NG, Halves & Correct Scores**), synthesizes **2-fold to 60-fold (`1,000,000x+` Million-Odds) accumulators** with **real SportyBet Ghana 6-character booking codes**, issues exact **SportyBet Flex / Cut-X Directives**, and verifies every cooked slip against live & final real-world scores in the **Verification Arena**.

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

### 1. 👑 Multi-Match Compounding up to `1,000,000x+` Odds (Live SportyBet Ghana Codes)
- Pulls a live **500+ upcoming match pool** directly from SportyBet Ghana (`POST /api/gh/orders/share` verified up to **60 folds per single booking code**).
- Compounds **high-accuracy individual legs (`64%–85%+` win probability per leg)** across 30 to 60 distinct matches to reach `500x`, `10,000x`, `100,000x`, and **`1,000,000x+` ("Million-Odds Vhim Grand Slam")** multipliers without padding slips with low-probability upsets.
- Includes curated daily slips:
  - 🛡️ **Daily 2.00x–3.00x Rollover Banker**
  - 🔥 **Vhim Sure Banker (5-Fold)**
  - 🚀 **30-Fold High-Accuracy Super Multi**
  - 👑 **Multi-Match "MILLION-ODDS" Vhim Grand Slam (`1,000,000x+`)**
  - 🥅 **High-Accuracy Shots, SOT, Corners & Props Sniper (8-Fold)**
  - 🎯 **Correct Score Sniper & Sleep Centre 20-Fold Vault (`#/vault`)**

### 2. 🛡️ Exact SportyBet Flex / Cut-X Directive Engine
Every cooked or custom ticket runs **exact Poisson-Binomial Dynamic Programming** over its leg probabilities to calculate `expectedHits`, `P(Full Acca)`, `P(Cut-1)`, `P(Cut-2)`, `P(Cut-3)`, and `P(Cut-5)`, surfacing an explicit **Oracle Flex Directive Banner**:
- **🟢 PLAY STRAIGHT (NO FLEX NEEDED)**: Short high-confidence Rollover Bankers (`2–5` folds) where full-multiplier EV dominates.
- **🛡️ ENABLE SPORTYBET FLEX: CUT-1**: Medium multis (`6–11` folds) where 1 upset slip still locks profit.
- **🛡️ ENABLE SPORTYBET FLEX: CUT-2 (OR CUT-1)**: `12–24` fold multis where variance requires a 2-cut cushion.
- **🚨 MANDATORY SPORTYBET MAX-FLEX (CUT-3 / CUT-5) + POD SPLIT**: `25–60` fold & `1,000,000x+` Grand Slams — includes one-click **Pod A / Pod B / Pod C / Pod D (`15`-fold sub-slips)** loading in the Slip Centre alongside the full single-code lotto ticket.

### 3. 🥅 High-Accuracy Throws, Goal Kicks, Shots, SOT, Corners & Cards (`#/props`)
- Dedicated **`#/props` ("Throws, GK & Shots")** hub + full per-match breakdowns (`#/games`) and section filters (`#/picks`):
  - **Throw-Ins**: Full-Time Over/Under (`33.5`–`39.5`), 1st Half Throw-Ins (`17.5`), Most Throw-Ins `1X2`, plus touchline/pressing tactical rationale.
  - **Goal Kicks**: Full-Time Over/Under (`14.5`–`17.5`), Home/Away Team Goal Kicks, Most Goal Kicks `1X2`.
  - **Shots & Shots on Target (SOT)**: Match & Team Shots O/U, Match & Team SOT O/U, Most Shots `1X2`, Most SOT `1X2` (with live SportyBet Ghana booking).
  - **Corners, Bookings/Cards, Fouls & Offsides**: Negative-Binomial overdispersed modeling (`r` dispersion parameter) for totals, team lines, and `1X2` supremacy.
- Strictly filters `#/props` to **high-likelihood selections (`65%–90%+` confidence)** so weak coin-flip props are never surfaced.

### 4. 🧪 Live Cooked Odds & Ticket Verification Arena (`#/arena`)
- Automatically registers every cooked ticket, Million-Odds multi, Props Sniper, and Correct Score Vault slip prior to kick-off.
- Syncs live in-play and final scores + match stats (corners, cards, shots, SOT, offsides, fouls) from SportyBet Ghana and ESPN Global Scoreboards.
- Grades full accumulators, **SportyBet Flex (`Cut-1`, `Cut-2`, `Cut-3`) payouts**, and flat-singles ROI, feeding settled market calibration weights back into the AI Ticket Cooker.

### 5. 🧠 Self-Learning Brain & Market Integrity Radar (`#/lab` & `#/radar`)
- **Genetic Algorithm Evolution (`server/brain.js`)** with Champion vs. Challenger holdout validation, learned ensemble trust weights, and Gemini AI mistake post-mortems (`server/lessons.js`).
- **Market Surveillance Radar (`#/radar`)** detecting sharp odds crashes, syndicate steam moves, and model-vs-market divergences.

---

## API Reference

- `GET /api/overview`: Command deck snapshot (Rollover Banker, Million-Odds Grand Slam, Props Sniper, Arena P&L)
- `GET /api/tickets`: Curated AI & SportyBet Ghana booked multi-match tickets with Flex Directives
- `POST /api/tickets/generate`: Custom Accumulator Synthesizer (`2`–`60` folds, `targetOdds` up to `1,000,000+`, modes: `mixed`, `million`, `shots`, `throws_gk`, `stats`, `goals`, `1x2`, `correct_score`)
- `GET /api/props?category=all&minP=0.65`: High-accuracy Throw-Ins, Goal Kicks, Shots, SOT, Corners, Cards & Fouls hub + booked Props Sniper ticket
- `POST /api/sportybet/book`: Live SportyBet Ghana share-code generator (`POST /api/gh/orders/share`)
- `GET /api/arena`: Live & historical real-world verification ledger for all cooked tickets and legs
- `GET /api/picks?minP=0.65&group=all`: Cross-league high-probability & `+EV` picks scanner
- `GET /api/games/:league` & `GET /api/game/:league/:id`: Full match & 70+ market statistical predictions

> Predictions are probabilistic estimates for research, analytical testing, and entertainment — always apply bankroll discipline and follow the Oracle Flex Directives on high-fold accumulators.
