---
name: stx-to-sbtc-normalizer
description: "Converts idle STX wallet balance to sBTC via a single Bitflow swap, routing capital into yield-ready form for deployment to Zest lending or HODLMM liquidity pools. This is the DCA entry-leg primitive for composed yield strategies."
metadata:
  author: "gregoryford963-sys"
  author-agent: "369SunRay"
  user-invocable: "false"
  arguments: "doctor | status | run [--amount <stx>] [--slippage <pct>] [--confirm]"
  entry: "stx-to-sbtc-normalizer/stx-to-sbtc-normalizer.ts"
  requires: "wallet"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# STX-to-sBTC Normalizer

## What it does

Detects idle STX in the agent wallet and converts it to sBTC via a single Bitflow swap.
No DCA schedule — one swap on demand, with mandatory quote preview before broadcast.

This skill is the capital-normalization leg that `sbtc-yield-maximizer` explicitly left out of scope:
before deploying to Zest or HODLMM, excess STX must be converted to sBTC.
This primitive does exactly that, then returns the received sBTC amount for the next
skill in the chain to deploy.

## Why agents need it

An agent running `sbtc-yield-maximizer` may accumulate STX from PoX rewards, stacking payouts,
or prior swaps. That STX sits idle unless explicitly converted. This skill closes the loop:
detect idle STX → get live quote → confirm → swap → sBTC in wallet → yield strategies can deploy.

## Safety notes

- **Writes to chain.** Executes a Bitflow swap transaction on Stacks mainnet.
- **Moves funds.** STX leaves the wallet; sBTC enters.
- **Mainnet only.** Will not work on testnet.
- **Requires confirmation.** `run` without `--confirm` returns a quote preview only — no funds move.
- **Slippage guardrail.** Default 3%, hard max 10%. Refuses swap if price impact > 5%.
- **Balance check.** Refuses if remaining STX after swap would fall below gas reserve (1 STX).
- **Quote freshness gate.** Refuses if Bitflow quote is older than 30s at broadcast time.

## Commands

### doctor
Checks wallet readiness, STX balance, Bitflow API reachability, and route availability.
```bash
bun run skills/stx-to-sbtc-normalizer/stx-to-sbtc-normalizer.ts doctor
```

### status
Read-only: shows current STX and sBTC balances, and a live quote preview for the minimum swap.
```bash
bun run skills/stx-to-sbtc-normalizer/stx-to-sbtc-normalizer.ts status
```

### run
Executes the STX→sBTC swap. Without `--confirm`, returns quote and blocks. With `--confirm`, broadcasts.
```bash
# Preview quote (safe — no transaction)
bun run skills/stx-to-sbtc-normalizer/stx-to-sbtc-normalizer.ts run --amount 10

# Execute swap (broadcasts on-chain)
bun run skills/stx-to-sbtc-normalizer/stx-to-sbtc-normalizer.ts run --amount 10 --confirm
```

Options:
| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--amount` | No | All swappable STX (after gas reserve) | STX amount to swap |
| `--slippage` | No | `3` | Slippage tolerance % (max 10) |
| `--confirm` | No | — | Required to broadcast; omit for quote preview |
| `--wallet-password` | No | `AIBTC_WALLET_PASSWORD` env var | Wallet decrypt password |

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{
  "status": "success",
  "action": "swap_executed",
  "data": {
    "amountInStx": 10.0,
    "amountOutSbtcSats": 2341,
    "txId": "0x...",
    "explorerUrl": "https://explorer.hiro.so/txid/0x...?chain=mainnet",
    "quote": { "expectedSbtcSats": 2360, "priceImpact": 0.002 }
  },
  "error": null
}
```

**Blocked (quote preview, no confirm):**
```json
{
  "status": "blocked",
  "action": "add_--confirm_to_execute",
  "data": {
    "amountInStx": 10.0,
    "expectedSbtcSats": 2360,
    "priceImpactPct": 0.2,
    "quoteAgeMs": 420,
    "slippagePct": 3
  },
  "error": null
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Known constraints

- Mainnet only — Bitflow routes not available on testnet
- Requires `CLIENT_PRIVATE_KEY` or `STACKS_PRIVATE_KEY` env var, or AIBTC wallet file with password
- Bitflow API must be reachable at `https://api.bitflowapis.finance`
- STX/sBTC route must exist (verified in `doctor` — currently available)
- Gas reserve of 1 STX is always preserved post-swap
- `PostConditionMode.Deny` with explicit sender STX and minimum sBTC received — no blank checks
