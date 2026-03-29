---
name: hodlmm-il-estimator
description: "Estimates impermanent loss for HODLMM LP positions by comparing current pool price to initial price — returns IL percentage, break-even fee yield, and a HOLD/EXIT signal to guide autonomous LP agents."
metadata:
  author: "gregoryford963-sys"
  author-agent: "369SunRay"
  user-invocable: "false"
  arguments: "doctor | estimate-il | scan-il | break-even"
  entry: "hodlmm-il-estimator/hodlmm-il-estimator.ts"
  requires: ""
  tags: "read-only, defi, l2, mainnet-only"
---

# HODLMM IL Estimator

## What it does

Calculates impermanent loss (IL) for Bitflow HODLMM pools by comparing the current active bin price to the pool's initial price. Returns IL as a percentage, the fee yield required to break even, and a HOLD / EXIT signal. For known positions, also estimates net P&L when combined with earned fees.

## Why agents need it

Impermanent loss silently erodes LP returns. An autonomous agent managing HODLMM positions must know:
- How much IL has accumulated since the pool launched
- Whether earned fees have offset that IL (break-even check)
- Whether current conditions favor holding the position or exiting to reduce further IL

Without this data, agents can't make rational hold/exit decisions on LP positions.

## Safety notes

- **Read-only** — no wallet required, no transactions submitted.
- No funds are moved. Safe to run at any frequency.
- Mainnet only — Bitflow HODLMM pools are mainnet-only.
- IL estimates are approximations using the standard CPMM formula. DLMM IL deviates from this when the position spans many bin steps — treat as a lower bound.

## Commands

### doctor
Checks API connectivity and lists all HODLMM pools with current vs. initial price.
```bash
bun run skills/hodlmm-il-estimator/hodlmm-il-estimator.ts doctor
```

### estimate-il
Estimates IL for a specific pool since inception.
```bash
bun run skills/hodlmm-il-estimator/hodlmm-il-estimator.ts estimate-il --pool-id dlmm_1
bun run skills/hodlmm-il-estimator/hodlmm-il-estimator.ts estimate-il --pool-id dlmm_1 --entry-price 65000000000
```

`--entry-price` overrides the pool's `initial_price` with a custom entry point (useful when the agent entered at a different time than pool launch).

### scan-il
Scans all active pools and ranks by current IL exposure.
```bash
bun run skills/hodlmm-il-estimator/hodlmm-il-estimator.ts scan-il
```

### break-even
Calculates the cumulative fee yield (%) needed to offset current IL.
```bash
bun run skills/hodlmm-il-estimator/hodlmm-il-estimator.ts break-even --pool-id dlmm_2 --fee-earned-pct 0.5
```

`--fee-earned-pct` is the % of liquidity earned as fees so far. If unknown, omit to get the raw break-even target.

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{
  "status": "success",
  "action": "HOLD",
  "data": {
    "poolId": "dlmm_1",
    "pair": "sBTC-USDCx",
    "initialPrice": 66194479380,
    "currentPrice": 68900000000,
    "priceChangePct": 4.09,
    "ilPct": -0.08,
    "ilSeverity": "negligible",
    "breakEvenFeePct": 0.08,
    "signal": "HOLD",
    "signalReason": "IL is negligible (0.08%). No action needed."
  },
  "error": null
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## IL severity thresholds

| IL % | Severity | Signal |
|------|----------|--------|
| 0–0.5% | negligible | HOLD |
| 0.5–2% | minor | HOLD |
| 2–5% | moderate | HOLD with warning |
| 5–10% | significant | EXIT consideration |
| >10% | severe | EXIT recommended |

## Known constraints

- IL estimate uses the standard CPMM formula: `IL = 2√r/(1+r) - 1` where `r = P_current/P_initial`. This is a lower bound for concentrated DLMM positions.
- `initial_price` is denominated in the pool's native units (microtoken/microtoken). Current price from `active_bin` requires bin step conversion.
- Requires Bitflow HODLMM API (`bff.bitflowapis.finance`). Override with `BITFLOW_HODLMM_API_HOST`.
