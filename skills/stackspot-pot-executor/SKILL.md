---
name: stackspot-pot-executor
description: "Direct on-chain Stackspot STX lottery pot joiner. Broadcasts join-pot(amount: uint) directly via @stacks/transactions — no MCP relay required."
metadata:
  author: "gregoryford963-sys"
  author-agent: "369SunRay"
  user-invocable: "false"
  arguments: "list | status --pot <name> | join --pot <name> --amount <stx> [--dry-run]"
  entry: "stackspot-pot-executor/stackspot-pot-executor.ts"
  requires: "wallet, CLIENT_PRIVATE_KEY"
  tags: "stackspot, stx, defi, write, direct-broadcast, mainnet-only, stacks, lottery"
---

# stackspot-pot-executor

Direct on-chain Stackspot pot participation for autonomous agents.

## Why agents need it

Stackspot pots offer lottery-style STX yield with a small number of participants and a fixed minimum entry. The existing `stackspot-skill` (PR #513) outputs MCP params for a parent agent to relay the join. This skill calls `join-pot(amount: uint)` directly on-chain and returns the confirmed `txid` — no relay required.

The low participant count on Genesis (max 2) means a depositor has a 50% chance of winning the entire pot, making timing and direct execution critical.

## Safety notes

- Post-condition on every join: `Pc.principal(wallet).willSendEq(amount).ustx()` — transaction aborts on-chain if the wrong amount leaves the wallet.
- Phase check: pot must be unlocked (`is-locked === false`) or the join is rejected with `pot_locked`.
- Per-op cap: 500 STX. Daily cap: 2,000 STX. Gas reserve: 1 STX always kept.
- Mainnet only — Stackspot contracts are mainnet-only.

## What it does

Joins Stackspot STX lottery pots by broadcasting `join-pot` transactions directly via `@stacks/transactions`. No MCP delegation — every write call is broadcast on-chain from this skill.

## Contract

- **Deployer:** `SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85`
- **Write function:** `join-pot(amount: uint)` — transfers `amount` uSTX from sender into the pot
- **Known pots:** Genesis (min 20 STX, max 2 participants), BuildOnBitcoin (min 100 STX, max 10), STXLFG (min 21 STX, max 100)

## Commands

### `list`
Read current state of all known pots.
```
bun run stackspot-pot-executor.ts list
```

### `status --pot <name>`
Show locked/unlocked state, current pot value, and join eligibility for one pot.
```
bun run stackspot-pot-executor.ts status --pot STXLFG
```

### `join --pot <name> --amount <stx> [--dry-run]`
Join a pot with a direct on-chain transaction.
```
# Dry run — simulate only
bun run stackspot-pot-executor.ts join --pot STXLFG --amount 21 --dry-run

# Live broadcast
bun run stackspot-pot-executor.ts join --pot STXLFG --amount 21
```

## Environment

| Variable | Purpose |
|---|---|
| `CLIENT_PRIVATE_KEY` | Stacks private key (hex, with or without `01` suffix) |
| `STACKS_PRIVATE_KEY` | Fallback alias |

## Safety limits

| Limit | Value |
|---|---|
| Per-op cap | 500 STX |
| Daily cap | 2,000 STX |
| Gas reserve | 1 STX kept post-join |
| TX fee | 0.003 STX |

## Output contract

All outputs are JSON to stdout.

**Success (join):**
```json
{
  "status": "success",
  "action": "joined",
  "data": {
    "pot": "STXLFG",
    "contract": "SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG",
    "txid": "abc123...",
    "explorer_url": "https://explorer.hiro.so/txid/0xabc123?chain=mainnet",
    "amount_stx": 21,
    "amount_ustx": 21000000,
    "wallet": "SP...",
    "safety_checks": {}
  },
  "error": null
}
```

**Blocked:**
```json
{ "status": "blocked", "action": "pot_locked", "data": null, "error": { "code": "pot_locked", "message": "...", "next": "..." } }
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
Conditions for joining:
- pot.locked === false           → pot is accepting new entrants
- stx_balance > amount + 1 STX  → reserve maintained
- amount >= pot.minAmountStx     → meets pot minimum
- daily_cap not exceeded         → under 2,000 STX/day
```

For agents: Use `stackspot-pot-executor list` to discover open pots, then `join` to participate on-chain.
