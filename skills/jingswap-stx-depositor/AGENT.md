---
name: jingswap-stx-depositor-agent
skill: jingswap-stx-depositor
description: "Direct on-chain JingSwap STX auction deposit agent. Deposits STX into blind batch auctions and cancels deposits via makeContractCall — no MCP relay needed."
---

# jingswap-stx-depositor — Agent Usage

## One-line summary
Deposit STX into JingSwap blind batch auctions with direct on-chain transactions.

## Guardrails

- NEVER deposit in Phase 1 or Phase 2 — skill enforces this and returns `deposits_closed`
- NEVER deposit if `data.total_sbtc_deposited_sats === 0` — no sBTC means no settlement counterparty
- NEVER exceed 5,000 STX per operation or 20,000 STX per day
- Always run `status` first to verify phase before depositing
- Always use `--dry-run` before live broadcast on a new wallet or amount

## Decision order

1. `status` → check `data.accepting_deposits` (must be `true`) and `data.total_sbtc_deposited_sats` (must be > 0)
2. `deposit --amount <stx> --dry-run` → verify safety checks pass
3. `deposit --amount <stx>` → broadcast; capture `data.txid`
4. If phase changes to 1 or 2 while deposit is pending: do NOT cancel — await settlement

## When to use
- Agent wants to exchange idle STX for sBTC via JingSwap's oracle-priced batch settlement
- Rebalancing loop detects STX oversupply and wants to acquire sBTC at oracle price
- Agent needs to cancel a pending deposit before settlement

## Workflow

1. **Check auction phase**
```bash
bun run jingswap-stx-depositor.ts status
```
Only proceed if `data.accepting_deposits === true` (phase 0).

2. **Verify sBTC is in the pool**
Check `data.total_sbtc_deposited_sats > 0` — if no sBTC depositors, your STX won't fill.

3. **Dry run**
```bash
bun run jingswap-stx-depositor.ts deposit --amount 100 --dry-run
```

4. **Execute on-chain**
```bash
bun run jingswap-stx-depositor.ts deposit --amount 100
```
Capture `data.txid` and `data.explorer_url`.

5. **Cancel if needed (phase 0 only)**
```bash
bun run jingswap-stx-depositor.ts cancel
```

## Error codes

| Code | Meaning | Fix |
|---|---|---|
| `no_wallet` | CLIENT_PRIVATE_KEY not set | Export key |
| `deposits_closed` | Auction in phase 1 or 2 | Wait for next cycle |
| `below_minimum` | Amount under auction minimum | Increase --amount |
| `insufficient_balance` | Not enough STX | Fund wallet |
| `exceeds_per_op_cap` | Over 5,000 STX | Lower --amount |
| `broadcast_failed` | Stacks node rejected tx | Check logs |

## Settlement mechanics

JingSwap settles at the Pyth BTC/STX oracle price at cycle close. Your STX deposit fills proportionally against sBTC depositors. The final exchange rate is set on-chain — no slippage, no front-running.

## Environment setup

```bash
export CLIENT_PRIVATE_KEY=<your_stacks_private_key_hex>
cd skills/jingswap-stx-depositor
bun install
bun run jingswap-stx-depositor.ts status
```
