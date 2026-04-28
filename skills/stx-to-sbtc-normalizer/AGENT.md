---
name: stx-to-sbtc-normalizer-agent
skill: stx-to-sbtc-normalizer
description: "Converts idle STX to sBTC via Bitflow swap; entry-leg normalizer for yield strategies."
---

# Agent Behavior — STX-to-sBTC Normalizer

## When to invoke

Invoke this skill when:
- `sbtc-yield-maximizer` reports insufficient sBTC to deploy but wallet holds STX
- Agent strategy requires sBTC but only STX is available
- Post-PoX-reward: STX received, needs conversion before yield deployment

Do NOT invoke when:
- STX balance is at or below 2 STX (gas reserve + buffer)
- A prior swap tx is still pending in mempool
- Bitflow API quote is unavailable or stale

## Decision order

1. Run `doctor` — if any check fails, surface the blocker and stop.
2. Run `status` — confirm STX balance and preview quote.
3. If quote is acceptable (price impact < 5%, slippage within tolerance):
   - Run `run --amount <N>` to confirm the quote.
   - Review the blocked output (amount in, expected out, price impact).
   - Run `run --amount <N> --confirm` to broadcast.
4. After broadcast: verify `txId` is returned and non-null.
5. Run `status` again to confirm sBTC balance increased.
6. Pass sBTC amount to next skill in chain (e.g., `sbtc-yield-maximizer`).

## Refusal conditions

The skill blocks or errors on these conditions — agent must not retry without resolving:

| Condition | Error code | Resolution |
|-----------|-----------|------------|
| No wallet key found | `NO_WALLET` | Set `CLIENT_PRIVATE_KEY` or `STACKS_PRIVATE_KEY` env var |
| STX balance ≤ gas reserve (1 STX) | `INSUFFICIENT_STX` | Top up wallet |
| No Bitflow route for STX→sBTC | `NO_ROUTE` | Route may be temporarily unavailable; retry next cycle |
| Price impact > 5% | `HIGH_PRICE_IMPACT` | Reduce `--amount`; market depth insufficient |
| Slippage > 10% | `SLIPPAGE_LIMIT` | Hard cap — do not override |
| Quote age > 30s at broadcast | `STALE_QUOTE` | Re-run `run` to refresh quote |
| Broadcast failed | `BROADCAST_ERROR` | Check Stacks node status; do not retry same cycle |
| Pending tx in mempool | `PENDING_TX` | Wait for confirmation before next swap |

## Guardrails

- Never proceed past a `blocked` or `error` status without explicit operator review.
- Never expose `--wallet-password` in logs or summaries.
- Never execute `run --confirm` without first reviewing the `blocked` preview output.
- Default to quoting then waiting for confirmation — autonomous execution only after operator approval.
- After each confirmed swap, wait for `tx_status: success` before treating sBTC as spendable.

## Composition context

This skill is the DCA normalization leg for `sbtc-yield-maximizer`. Typical chain:

```
stx-to-sbtc-normalizer run --amount <N> --confirm
  → sbtc-yield-maximizer scan  (check Zest vs HODLMM yield)
  → sbtc-yield-maximizer run --confirm=MAXIMIZE
```

Declare this dependency in the orchestrating skill's `metadata.requires`.

## On error

- Log the full error JSON payload.
- Do not retry automatically — surface to operator.
- If `BROADCAST_ERROR`: check mempool for pending tx before retrying.
- If `STALE_QUOTE`: re-run `run` (without `--confirm`) to get a fresh quote first.

## On success

- Confirm `txId` is present and non-null in the response.
- Report: amount swapped, sBTC received, explorer link.
- Update any running capital-allocation state before proceeding to yield deployment.
