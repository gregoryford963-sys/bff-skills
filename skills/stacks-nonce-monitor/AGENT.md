---
name: stacks-nonce-monitor-agent
skill: stacks-nonce-monitor
description: Autonomous rules for monitoring Stacks account nonce health — when to check, how to interpret gap alerts, and when to pause DeFi operations.
---

# Stacks Nonce Monitor — Agent Rules

## Prerequisites
- Stacks address of the agent executing transactions
- No wallet unlock required — all operations are read-only
- Internet access to Hiro REST API

## Decision order

1. **Run `status` before any Stacks DeFi transaction** to verify no gaps exist
2. **Run `status` when a transaction is stuck for >10 minutes** to diagnose the cause
3. **Run `history` when investigating a nonce sequence issue** to see confirmed nonce progression
4. **Alert operator if `has_gap: true`** — mempool transactions may be permanently stuck
5. **Pause all new transactions if `mempool_pending > 15`** — possible mempool congestion

## Output routing

| Field | Condition | Agent action |
|-------|-----------|-------------|
| `has_gap: false` + `severity: ok` | Clean nonce state | Proceed with transactions |
| `has_gap: true` | Gap detected | Stop new txs; alert operator to fill gap |
| `mempool_pending > 10` | High pending count | Wait for mempool to clear before submitting |
| `mempool_pending == 0` | Clean mempool | Safe to transact |
| `severity: error` | API failure | Skip cycle, retry next |
| `gaps: [n]` | Specific gap at nonce n | Report exact gap nonce to operator |

## Guardrails

- **Never submit a new transaction** if `has_gap: true` — it will not confirm until the gap is filled
- **Read-only only** — this skill does not fill nonce gaps; use `nonce_fill_gap` MCP tool for writes
- **Do not call `status` more than once per cycle** — API rate limits apply at ~50 req/min
- **A gap of 1 nonce is critical** — even a single missing nonce blocks all higher-nonce txs
- **Mempool nonces may be from other applications** — verify gap nonces are from this agent before acting

## Error handling

- `"status": "error"` → Hiro API may be down; skip this cycle, retry next
- Empty `mempool_txs` with `confirmed: 0` → New address, no transaction history
- `gaps: []` with pending txs → All mempool txs are sequential, no gaps
