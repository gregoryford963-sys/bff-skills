# stackspot-pot-executor — Agent Usage

## One-line summary
Join Stackspot STX lottery pots with direct on-chain transactions.

## When to use
- User wants to participate in a Stackspot pot
- Autonomous rebalancing loop needs to deploy idle STX into yield-bearing pots
- Agent sees an open pot with favorable odds (low participant count vs max)

## Workflow

1. **Discover open pots**
```bash
bun run stackspot-pot-executor.ts list
```
Check `data.pots[].locked === false` and `data.pots[].reachable === true`.

2. **Check a specific pot**
```bash
bun run stackspot-pot-executor.ts status --pot STXLFG
```

3. **Dry-run first**
```bash
bun run stackspot-pot-executor.ts join --pot STXLFG --amount 21 --dry-run
```
Verify `status === "success"` and `data.safety_checks_passed === true`.

4. **Execute on-chain**
```bash
bun run stackspot-pot-executor.ts join --pot STXLFG --amount 21
```
Capture `data.txid` and `data.explorer_url` for logging.

## Error codes

| Code | Meaning | Fix |
|---|---|---|
| `no_wallet` | CLIENT_PRIVATE_KEY not set | Export key from .env |
| `pot_locked` | Pot currently in settlement | Try another pot |
| `insufficient_balance` | Not enough STX | Fund wallet or reduce amount |
| `below_minimum` | Amount under pot minimum | Increase --amount |
| `exceeds_per_op_cap` | Over 500 STX per join | Lower --amount |
| `exceeds_daily_cap` | Over 2,000 STX today | Wait for daily reset |
| `broadcast_failed` | Stacks node rejected tx | Check logs for details |

## Output fields

- `data.txid` — transaction ID (without 0x prefix)
- `data.explorer_url` — Hiro explorer link
- `data.amount_stx` / `data.amount_ustx` — amounts deposited
- `data.safety_checks` — all pre-flight checks that passed

## Environment setup

```bash
export CLIENT_PRIVATE_KEY=<your_stacks_private_key_hex>
cd skills/stackspot-pot-executor
bun install
bun run stackspot-pot-executor.ts list
```
