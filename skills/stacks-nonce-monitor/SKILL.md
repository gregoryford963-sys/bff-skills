---
name: stacks-nonce-monitor
description: "Monitor Stacks account nonce health — detect nonce gaps that block mempool transactions, check pending tx counts, and review confirmed nonce history."
metadata:
  author: "gregoryford963-sys"
  author-agent: "369SunRay"
  user-invocable: "false"
  arguments: "status [--address <stx>] | history [--address <stx>] [--limit <n>] | install-packs"
  entry: "stacks-nonce-monitor/stacks-nonce-monitor.ts"
  requires: "none"
  tags: "infrastructure, read-only, mainnet-only, stacks, nonce"
---

# Stacks Nonce Monitor

## What it does

Read-only monitoring of Stacks account nonce health. Calls the Hiro REST API to compare confirmed account nonce against pending mempool transactions, detecting gaps that would cause stuck transactions. Also provides a confirmed transaction history with nonce values to diagnose sequencing issues.

## Why agents need it

Agents executing DeFi transactions on Stacks (supply, swap, stake, repay) can get blocked by nonce gaps — missing nonce values that prevent higher-nonce mempool transactions from confirming. This is one of the most common causes of stuck agent operations. This skill enables read-only nonce health checks before any transaction, helping agents detect gaps early and avoid cascading failures.

## On-chain / Off-chain

| API | Endpoint | Purpose |
|-----|----------|---------|
| Hiro Extended | `/v2/accounts/{address}` | Confirmed nonce and STX balance |
| Hiro Extended | `/extended/v1/tx/mempool` | Pending mempool transactions |
| Hiro Extended | `/extended/v1/address/{address}/transactions` | Confirmed tx history |

## Commands

### status [--address]
Full nonce health check: confirmed nonce, mempool pending count, gap detection.
```bash
bun run skills/stacks-nonce-monitor/stacks-nonce-monitor.ts status
bun run skills/stacks-nonce-monitor/stacks-nonce-monitor.ts status --address SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW
```

### history [--address] [--limit]
Show recent confirmed transactions and their nonces (default 20, max 50).
```bash
bun run skills/stacks-nonce-monitor/stacks-nonce-monitor.ts history
bun run skills/stacks-nonce-monitor/stacks-nonce-monitor.ts history --address SP3GX... --limit 10
```

### install-packs
Reports dependency status (no additional packages required beyond Bun builtins).
```bash
bun run skills/stacks-nonce-monitor/stacks-nonce-monitor.ts install-packs
```

## Output contract

### status output
```json
{
  "status": "ok",
  "address": "SP3GX...",
  "nonce": {
    "confirmed": 68,
    "mempool_pending": 2,
    "mempool_max_nonce": 70,
    "gaps": [69],
    "has_gap": true
  },
  "mempool_txs": [
    {"tx_id": "0xabc...", "nonce": 68, "status": "pending"},
    {"tx_id": "0xdef...", "nonce": 70, "status": "pending"}
  ],
  "summary": "Nonce gap detected at 69 — 2 mempool txs may be stuck",
  "severity": "warn"
}
```

### history output
```json
{
  "status": "ok",
  "address": "SP3GX...",
  "transactions": [
    {"tx_id": "0x...", "nonce": 68, "tx_status": "success", "block_height": 173200}
  ],
  "count": 20,
  "nonce_range": {"min": 49, "max": 68},
  "note": "20 recent confirmed transactions"
}
```

## Safety notes

- **Read-only.** No transactions are submitted. No wallet required.
- **Mainnet only.** Default address is on Stacks mainnet; pass `--address` for other networks.
- **Uses Hiro public API.** Rate limits apply at ~50 req/min.
- **Gap detection is heuristic.** A gap may be intentional (skipped nonce) or a bug — always verify before attempting to fill.
