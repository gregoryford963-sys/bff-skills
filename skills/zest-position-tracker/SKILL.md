---
name: zest-position-tracker
description: "Monitor Zest Protocol sBTC lending positions — check zsbtc balance, yield accrual, supply/withdraw history, and pool utilization on Stacks mainnet."
metadata:
  author: "gregoryford963-sys"
  author-agent: "369SunRay"
  user-invocable: "false"
  arguments: "status [--address <stx>] | history [--address <stx>] | install-packs"
  entry: "zest-position-tracker/zest-position-tracker.ts"
  requires: "wallet"
  tags: "defi, read-only, mainnet-only, l2"
---

# Zest Position Tracker

## What it does

Read-only monitoring of Zest Protocol sBTC lending positions on Stacks mainnet. Calls Zest's on-chain contracts via the Hiro REST API to report zsbtc token balances, estimated yield, and pool utilization. Also fetches recent supply/withdraw transaction history for any Stacks address.

## Why agents need it

Agents supplying sBTC to Zest Protocol need to track their positions across cycles without broadcasting transactions. This skill provides a lightweight read-only view of: (1) how many zsbtc tokens an address holds, (2) what the current pool utilization is, and (3) what recent Zest interactions the address has made. No wallet unlock required — purely observational.

## On-chain contracts

| Contract | Address | Purpose |
|----------|---------|---------|
| `zsbtc-v2-0` | `SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N` | LP token — holds zsbtc balance per address |
| `pool-0-reserve-v2-0` | `SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N` | Pool reserve — total supply and utilization |
| `sbtc-token` | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4` | sBTC token — liquid balance check |

## Commands

### status [--address]
Full position overview: zsbtc balance, liquid sBTC, pool utilization, and health summary.
```bash
bun run skills/zest-position-tracker/zest-position-tracker.ts status
bun run skills/zest-position-tracker/zest-position-tracker.ts status --address SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW
```

### history [--address]
Recent Zest Protocol transactions (supply/withdraw) for the address.
```bash
bun run skills/zest-position-tracker/zest-position-tracker.ts history
bun run skills/zest-position-tracker/zest-position-tracker.ts history --address SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW
```

### install-packs
Reports dependency status (no additional packages required beyond Bun builtins).
```bash
bun run skills/zest-position-tracker/zest-position-tracker.ts install-packs
```

## Output contract

### status output
```json
{
  "status": "ok",
  "address": "SP3GX...",
  "zest_position": {
    "zsbtc_tokens": 62081,
    "has_position": true
  },
  "liquid_sbtc_sats": 15521,
  "pool": {
    "total_supplied_sbtc": 0,
    "utilization_pct": 0,
    "status": "active"
  },
  "summary": "Active position: 62081 zsbtc tokens. Liquid: 15521 sats.",
  "severity": "ok"
}
```

### history output
```json
{
  "status": "ok",
  "address": "SP3GX...",
  "transactions": [
    {
      "txid": "0xbea6b875...",
      "type": "supply",
      "amount_sats": 62081,
      "timestamp": "2026-04-10T20:00:00Z",
      "block_height": 7360000
    }
  ],
  "count": 1
}
```

## Safety notes

- **Read-only.** No transactions are submitted. No wallet unlock required.
- **Mainnet only.** Zest Protocol v2 contracts are on Stacks mainnet.
- **Uses Hiro public API.** Rate limits apply at ~50 req/min.
- **zsbtc is NOT liquid sBTC.** Zest position tokens cannot be transferred — only redeemed via withdraw. Do not confuse zsbtc balance with available sBTC.
