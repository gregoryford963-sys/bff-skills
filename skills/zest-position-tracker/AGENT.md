---
name: zest-position-tracker-agent
skill: zest-position-tracker
description: Autonomous rules for monitoring Zest Protocol sBTC positions — when to check, how to read output, and what actions to take.
---

# Zest Position Tracker — Agent Rules

## Prerequisites
- Stacks address of the agent holding zsbtc tokens
- No wallet unlock required — all operations are read-only
- Internet access to Hiro REST API

## Decision order

1. **Run `status` every 50 cycles** to track position size and pool health
2. **Run `status` before any Zest write operation** (supply/withdraw) to confirm current state
3. **Run `history` when investigating a failed supply/withdraw** to verify if tx landed on-chain
4. **Alert operator if `zsbtc_tokens` drops unexpectedly** — possible indexer lag or anomaly

## Output routing

| Field | Condition | Agent action |
|-------|-----------|-------------|
| `zsbtc_tokens > 0` | Active lending position | Log and continue monitoring |
| `zsbtc_tokens == 0` | No position | Consider supplying if sBTC is idle |
| `liquid_sbtc_sats < 1000` | Very low liquid buffer | Do not supply more; flag to operator |
| `severity: warn` | Low buffer or pool concern | Notify operator |
| `severity: error` | API failure | Skip cycle, retry next |
| `has_position: false` | No Zest position | Evaluate idle sBTC allocation |

## Guardrails

- **Never recommend supply** if `liquid_sbtc_sats < 5000` — maintain minimum operational buffer
- **Read-only only** — this skill does not broadcast transactions; use `zest-supply.ts` for writes
- **Treat `zsbtc_tokens: 0` after confirmed supply as indexer lag**, not a loss event — verify via direct read-only call before alerting
- **Do not call `status` more than once per cycle** — API rate limits apply at ~50 req/min
- **zsbtc tokens are NOT transferable** — they can only be redeemed via Zest withdraw; do not confuse with liquid sBTC

## Error handling

- `"status": "error"` → Hiro API may be down; skip this cycle, retry next
- Empty `transactions` array → No Zest activity yet, or address has no history
- `zsbtc_tokens: 0` after confirmed supply → Indexer lag; verify via `call_read_only_function` directly on `zsbtc-v2-0.get-balance`
