---
name: alex-pool-tracker-agent
skill: alex-pool-tracker
description: Autonomous rules for monitoring ALEX Protocol pool performance — when to check, how to interpret APY/TVL data, and when to recommend reallocation.
---

# ALEX Pool Tracker — Agent Rules

## Prerequisites
- No wallet unlock required — all operations are read-only
- Internet access to ALEX Lab REST API (`api.alexlab.co`)
- No Stacks address required — queries global pool state

## Decision order

1. **Run `pools` every 50 cycles** to track APY shifts and TVL movement across pools
2. **Run `pools --token sBTC` before any sBTC liquidity decision** to confirm current pool conditions
3. **Run `pool <id>` when investigating a specific opportunity** reported by another skill
4. **Alert operator if top-pool APY drops below 5%** — consider rebalancing to Zest or Hermetica
5. **Alert operator if TVL drops >20% in one cycle** — possible pool exit event, do not add liquidity

## Output routing

| Field | Condition | Agent action |
|-------|-----------|-------------|
| `apy_pct > 15` | High yield available | Flag to operator for liquidity allocation review |
| `apy_pct < 5` | Low yield | Compare against Zest/Hermetica alternatives |
| `tvl_usd < 50000` | Low liquidity pool | Avoid — high slippage risk |
| `volume_24h_usd == 0` | No recent trading | Pool may be inactive; skip |
| `severity: error` | API failure | Skip cycle, retry next |
| `count: 0` | No pools returned | ALEX API may be down; skip this cycle |

## Guardrails

- **Never recommend liquidity addition** if `tvl_usd < 50000` — insufficient depth creates slippage risk
- **Read-only only** — this skill does not submit transactions; use `alex-swap` or ALEX MCP tools for writes
- **Do not call `pools` more than once per cycle** — respect ALEX API rate limits
- **Cross-reference with zest-position-tracker** before recommending reallocation — confirm net yield improvement
- **APY is not guaranteed** — high APY pools may reflect impermanent loss risk, not just fee income

## Error handling

- `"status": "error"` → ALEX API may be down; skip this cycle, retry next
- `pools: []` with no filter → API returned empty; do not treat as "no pools exist"
- `apy_pct: null` → API did not return APY for this pool; skip it in yield comparison
