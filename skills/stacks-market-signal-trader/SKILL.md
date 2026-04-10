---
name: stacks-market-signal-trader
description: "Autonomous prediction market trading on stacksmarket.app driven by aibtc.news signals — reads recent signals, matches them to open markets, places yes/no bets based on sentiment, tracks positions, and redeems resolved markets for P&L."
author: gregoryford963-sys
author_agent: 369SunRay
user-invocable: true
arguments: doctor | run --action scan | run --action trade [--dry-run] | run --action positions | run --action redeem | install-packs
entry: stacks-market-signal-trader/stacks-market-signal-trader.ts
requires: [wallet, signing, settings]
tags: [defi, write, mainnet-only, l2, requires-funds]
---

# Stacks Market Signal Trader

## What it does

Reads the latest signals from [aibtc.news](https://aibtc.news) and cross-references them against open prediction markets on [stacksmarket.app](https://stacksmarket.app). For each signal with a positive or negative sentiment the skill identifies a matching market, gets a live quote, and places a yes or no position within a configurable budget. Resolved markets are automatically detected and redeemed. The skill produces a running P&L summary after every cycle.

## Why agents need it

Prediction markets on Stacks are high-signal, high-reward venues that go untraded because agents lack a structured way to map news to markets and size positions safely. This skill closes that gap: it ingests live intelligence (aibtc.news), converts sentiment to a directional bet, enforces per-market and total spend limits, and books profits when markets close — all without human intervention.

## Safety notes

- **Writes to chain.** Every confirmed trade call submits a Stacks transaction. STX is spent immediately and is not recoverable.
- **Funds required.** Wallet must hold STX. Default budget: 1,000 STX per market, 5,000 STX total per run.
- **Dry-run by default.** Without `--confirm` the `trade` action outputs a preview of intended bets. Pass `--confirm` to execute.
- **Mainnet only.** stacksmarket.app contracts are deployed on Stacks mainnet.
- **No leverage / no short.** Positions are binary yes/no token purchases — max loss is the amount wagered.
- **Budget guards are enforced locally.** The MCP tools do not cap spend — this skill does.

## Phases

### Phase 1 — Signal Ingestion

Call `news_list_signals` to fetch the 10 most recent approved signals from aibtc.news. For each signal extract:
- `headline` — the claim being made
- `beat` — topic area (e.g. `infrastructure`, `governance`, `agent-trading`)
- `sentiment` — inferred from headline polarity (bullish → YES, bearish → NO, neutral → skip)
- `source_url` — for audit trail

### Phase 2 — Market Discovery

For each signal call `stacks_market_search` with keywords extracted from the headline. Also call `stacks_market_list` to get all open markets. Filter to markets that are:
- Status: `open` (accepting bets)
- Resolution date: in the future
- Relevance score above threshold (keyword overlap ≥ 2 terms with signal headline)

### Phase 3 — Quote and Sizing

For each (signal, market) pair call `stacks_market_quote_buy` for the sentiment-aligned side (YES or NO). Size the position as:
```
position_size = min(BUDGET_PER_MARKET, available_budget_remaining)
```
Skip if the implied odds are worse than 1.1x (insufficient edge).

### Phase 4 — Trade Execution

With `--confirm`, call `stacks_market_buy_yes` or `stacks_market_buy_no` with the quoted amount. Record the transaction ID and position details to local state. Decrement available budget.

### Phase 5 — Position Monitoring

Call `stacks_market_get_position` for every tracked open position. Identify markets that have resolved. Flag resolved positions for redemption.

### Phase 6 — Redemption

For each resolved market with a winning position, call `stacks_market_redeem`. Record redemption tx and realized P&L.

### Phase 7 — P&L Report

Emit a JSON summary:
```json
{
  "signals_processed": 10,
  "markets_matched": 3,
  "bets_placed": 2,
  "stx_deployed": 1500,
  "positions_redeemed": 1,
  "stx_redeemed": 900,
  "realized_pnl": -600,
  "open_positions": 1,
  "unrealized_exposure": 500
}
```

## Commands

### doctor

Checks wallet readiness, aibtc.news API reachability, and stacksmarket.app connectivity.

```bash
bun run stacks-market-signal-trader/stacks-market-signal-trader.ts doctor
```

Example output:
```json
{
  "status": "success",
  "action": "All systems ready. Run with --action scan to preview signal-market matches.",
  "data": {
    "checks": {
      "wallet_unlocked": { "ok": true, "detail": "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW" },
      "stx_balance": { "ok": true, "detail": "12400 STX available" },
      "news_api": { "ok": true, "detail": "10 recent signals fetched" },
      "markets_api": { "ok": true, "detail": "7 open markets found" }
    }
  },
  "error": null
}
```

### run --action scan

Fetches signals and open markets, computes matches, and shows intended bets — no trades executed.

```bash
bun run stacks-market-signal-trader/stacks-market-signal-trader.ts run --action scan
```

Example output:
```json
{
  "status": "success",
  "action": "3 matches found. Run --action trade --dry-run to preview sizing, or --action trade --confirm to execute.",
  "data": {
    "signals": 10,
    "matches": [
      {
        "signal_headline": "Nakamoto upgrade final testnet milestone reached",
        "beat": "infrastructure",
        "sentiment": "bullish",
        "market_title": "Will the Nakamoto upgrade ship before Q3 2026?",
        "market_id": "SM1234...ABC",
        "side": "YES",
        "current_odds": 1.45
      }
    ]
  },
  "error": null
}
```

### run --action trade

Executes trades. Dry-run without `--confirm`.

```bash
# Dry-run — safe to call anytime
bun run stacks-market-signal-trader/stacks-market-signal-trader.ts run \
  --action trade \
  --budget-per-market 1000 \
  --total-budget 5000 \
  --dry-run

# Live execution
bun run stacks-market-signal-trader/stacks-market-signal-trader.ts run \
  --action trade \
  --budget-per-market 1000 \
  --total-budget 5000 \
  --confirm
```

Example dry-run output:
```json
{
  "status": "success",
  "action": "DRY RUN — 2 trades previewed. Pass --confirm to execute.",
  "data": {
    "dry_run": true,
    "trades": [
      {
        "market_id": "SM1234...ABC",
        "market_title": "Will the Nakamoto upgrade ship before Q3 2026?",
        "side": "YES",
        "amount_stx": 1000,
        "quoted_tokens": 1450,
        "implied_return": "1.45x",
        "signal": "Nakamoto upgrade final testnet milestone reached"
      }
    ],
    "total_stx": 1000,
    "budget_remaining": 4000
  },
  "error": null
}
```

Example confirmed output:
```json
{
  "status": "success",
  "action": "2 trades executed. Run --action positions to monitor open bets.",
  "data": {
    "trades_executed": 2,
    "txids": [
      "0xabc123...",
      "0xdef456..."
    ],
    "stx_deployed": 1500,
    "budget_remaining": 3500
  },
  "error": null
}
```

### run --action positions

Lists all tracked open positions and their current status.

```bash
bun run stacks-market-signal-trader/stacks-market-signal-trader.ts run --action positions
```

Example output:
```json
{
  "status": "success",
  "action": "1 position ready to redeem. Run --action redeem to claim winnings.",
  "data": {
    "open_positions": [
      {
        "market_id": "SM1234...ABC",
        "market_title": "Will the Nakamoto upgrade ship before Q3 2026?",
        "side": "YES",
        "tokens_held": 1450,
        "status": "resolved_win",
        "claimable_stx": 1800
      }
    ],
    "unredeemed_wins": 1,
    "unrealized_exposure_stx": 500
  },
  "error": null
}
```

### run --action redeem

Redeems all resolved winning positions and reports P&L.

```bash
bun run stacks-market-signal-trader/stacks-market-signal-trader.ts run --action redeem
```

Example output:
```json
{
  "status": "success",
  "action": "1 position redeemed. Check journal for full P&L.",
  "data": {
    "redeemed": [
      {
        "market_id": "SM1234...ABC",
        "stx_received": 1800,
        "cost_basis_stx": 1000,
        "realized_pnl_stx": 800
      }
    ],
    "total_redeemed_stx": 1800,
    "total_cost_stx": 1000,
    "session_pnl_stx": 800
  },
  "error": null
}
```

### install-packs

```bash
bun run stacks-market-signal-trader/stacks-market-signal-trader.ts install-packs
```

Output:
```json
{
  "status": "success",
  "data": { "command": "# No additional packages required" }
}
```

## Output contract

All outputs are strict JSON to stdout:
```json
{
  "status": "success | error | blocked",
  "action": "human-readable next step for the agent",
  "data": {},
  "error": null | { "code": "string", "message": "string", "next": "string" }
}
```

## Budget configuration

| Parameter | Default | Description |
|---|---|---|
| `--budget-per-market` | 1000 STX | Maximum spend on a single market per run |
| `--total-budget` | 5000 STX | Maximum total spend across all markets per run |
| `--min-odds` | 1.1x | Skip bets with implied return below this threshold |

## MCP tools used

| Tool | Phase | Purpose |
|---|---|---|
| `news_list_signals` | 1 | Fetch recent aibtc.news approved signals |
| `stacks_market_list` | 2 | List all open prediction markets |
| `stacks_market_search` | 2 | Keyword search for relevant markets |
| `stacks_market_get` | 2 | Get detailed market info and status |
| `stacks_market_quote_buy` | 3 | Get live quote for a YES/NO position |
| `stacks_market_buy_yes` | 4 | Place a YES bet on a market |
| `stacks_market_buy_no` | 4 | Place a NO bet on a market |
| `stacks_market_get_position` | 5 | Check position status and claimable amount |
| `stacks_market_redeem` | 6 | Redeem tokens from a resolved winning market |

## Known constraints

- Requires wallet unlock before any trade action
- `stacks_market_search` keyword matching is fuzzy — always review scan output before confirming trades
- Markets with less than 24 hours to resolution are skipped by default (insufficient time for information edge)
- Budget state is local (in-memory per run); agent state file should persist `open_positions` between runs
- Redemption is only possible on markets where the agent holds the winning side token
- aibtc.news signal quality varies; the skill skips signals with no source URL
