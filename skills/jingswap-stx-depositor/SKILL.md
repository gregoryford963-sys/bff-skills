---
name: jingswap-stx-depositor
description: "Direct on-chain JingSwap STX→sBTC blind batch auction depositor. Broadcasts deposit-stx and cancel-stx-deposit transactions directly via @stacks/transactions — no MCP relay required."
metadata:
  author: "gregoryford963-sys"
  author-agent: "369SunRay"
  user-invocable: "false"
  arguments: "status | deposit --amount <stx> [--dry-run] | cancel [--dry-run]"
  entry: "jingswap-stx-depositor/jingswap-stx-depositor.ts"
  requires: "wallet, CLIENT_PRIVATE_KEY"
  tags: "jingswap, sbtc, stx, defi, write, direct-broadcast, mainnet-only, stacks"
---

# jingswap-stx-depositor

Direct on-chain JingSwap STX→sBTC blind batch auction depositor.

## Why agents need it

JingSwap auctions settle at the live Pyth BTC/STX oracle price — not an AMM curve — giving agents oracle-priced sBTC acquisition without slippage or front-running. The existing `jingswap-cycle-agent` skill requires a parent agent to relay the deposit via the `jingswap_deposit_stx` MCP tool. This skill eliminates that relay: it calls `deposit-stx` and `cancel-stx-deposit` directly on-chain and returns the confirmed `txid` immediately.

## Safety notes

- `deposit` requires Phase 0 (deposit window) — rejected in Phase 1 or 2 with a `deposits_closed` error.
- Post-condition on every deposit: `Pc.principal(wallet).willSendEq(amount).ustx()` — transaction aborts on-chain if the wrong amount leaves the wallet.
- Per-op cap: 5,000 STX. Daily cap: 20,000 STX. Gas reserve: 1 STX always kept.
- `cancel` can only succeed if a deposit exists and the cycle is still in Phase 0.
- Mainnet only — `sbtc-stx-jing-v2` is mainnet-only.

## What it does

Participates in JingSwap's STX/sBTC blind batch auctions by broadcasting `deposit-stx` and `cancel-stx-deposit` transactions directly via `@stacks/transactions`. No MCP relay — every write call goes on-chain from this process.

JingSwap auctions run in cycles:
- **Phase 0 (deposit):** STX depositors and sBTC depositors enter the pool
- **Phase 1 (buffer):** Deposits close, settlement pending
- **Phase 2 (settle):** Oracle price (Pyth BTC/STX) used to fill both sides proportionally

## Contract

- **Address:** `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22`
- **Contract:** `sbtc-stx-jing-v2`
- **Write functions:**
  - `deposit-stx(amount: uint)` — deposit `amount` uSTX, post-condition enforces exact transfer
  - `cancel-stx-deposit()` — cancel deposit and reclaim STX before cycle settles

## Commands

### `status`
Read current cycle phase, totals, and minimum deposit requirements.
```
bun run jingswap-stx-depositor.ts status
```

### `deposit --amount <stx> [--dry-run]`
Deposit STX into the current cycle. Only works in Phase 0.
```
# Dry run — simulate
bun run jingswap-stx-depositor.ts deposit --amount 100 --dry-run

# Live broadcast
bun run jingswap-stx-depositor.ts deposit --amount 100
```

### `cancel [--dry-run]`
Cancel your current STX deposit and reclaim funds.
```
bun run jingswap-stx-depositor.ts cancel
```

## Environment

| Variable | Purpose |
|---|---|
| `CLIENT_PRIVATE_KEY` | Stacks private key (hex, with or without `01` suffix) |
| `STACKS_PRIVATE_KEY` | Fallback alias |

## Safety limits

| Limit | Value |
|---|---|
| Per-op cap | 5,000 STX |
| Daily cap | 20,000 STX |
| Gas reserve | 1 STX kept post-deposit |
| TX fee | 0.003 STX |
| Post-condition | `Pc.principal(wallet).willSendEq(amount).ustx()` — aborts if wrong amount leaves wallet |

## Output contract

All outputs are newline-delimited JSON to stdout.

**Success (deposit):**
```json
{
  "status": "success",
  "action": "deposited",
  "data": {
    "txid": "abc123...",
    "explorer_url": "https://explorer.hiro.so/txid/0xabc123?chain=mainnet",
    "amount_stx": 100,
    "amount_ustx": 100000000,
    "cycle": 42,
    "wallet": "SP...",
    "safety_checks": {}
  },
  "error": null
}
```

**Blocked:**
```json
{ "status": "blocked", "action": "deposits_closed", "data": null, "error": { "code": "deposits_closed", "message": "...", "next": "..." } }
```

**Error:**
```json
{ "status": "error", "action": "broadcast_failed", "data": null, "error": { "code": "broadcast_failed", "message": "...", "next": "..." } }
```

## Dependencies

```
bun add @stacks/transactions @stacks/network commander
```

## Agent decision guide

```
if status.accepting_deposits === true:
  if status.total_sbtc_deposited_sats > 0:
    # sBTC is in pool — STX deposit will fill
    deposit --amount <stx>
  else:
    # No sBTC yet — wait for sBTC depositors
    skip

if holding deposit and phase != 0:
  # Cannot cancel — wait for settlement
  monitor
```

For agents: Run `status` to check phase before depositing. If phase changes to 1 or 2 after depositing, settlement is pending — do not attempt to cancel.
