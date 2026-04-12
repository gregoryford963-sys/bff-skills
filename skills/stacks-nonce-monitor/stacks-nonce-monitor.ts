#!/usr/bin/env bun
/**
 * stacks-nonce-monitor.ts — Monitor Stacks account nonce health and detect gaps
 *
 * Usage:
 *   bun run stacks-nonce-monitor.ts status [--address <stx>]
 *   bun run stacks-nonce-monitor.ts history [--address <stx>] [--limit <n>]
 *   bun run stacks-nonce-monitor.ts install-packs
 */

import { program } from "commander";

// ── Config ──────────────────────────────────────────────────────────────────

const HIRO_API = "https://api.hiro.so";
const DEFAULT_ADDRESS = "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW";

// ── Types ────────────────────────────────────────────────────────────────────

interface AccountInfo {
  nonce: number;
  balance: string;
  locked: string;
}

interface MempoolTx {
  tx_id: string;
  nonce: number;
  tx_status: string;
  fee_rate: string;
}

interface MempoolResponse {
  results?: MempoolTx[];
  total?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getAccountInfo(address: string): Promise<AccountInfo | null> {
  try {
    const res = await fetch(`${HIRO_API}/v2/accounts/${address}?proof=0`);
    if (!res.ok) return null;
    return (await res.json()) as AccountInfo;
  } catch {
    return null;
  }
}

async function getMempoolTxs(address: string): Promise<MempoolTx[]> {
  try {
    const url = `${HIRO_API}/extended/v1/tx/mempool?sender_address=${address}&limit=25`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as MempoolResponse;
    return data.results ?? [];
  } catch {
    return [];
  }
}

async function getRecentTxs(
  address: string,
  limit: number
): Promise<Array<{ tx_id: string; nonce: number; tx_status: string; block_height: number }>> {
  try {
    const url = `${HIRO_API}/extended/v1/address/${address}/transactions?limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{
        tx_id: string;
        nonce: number;
        tx_status: string;
        block_height: number;
      }>;
    };
    return (data.results ?? []).map((tx) => ({
      tx_id: tx.tx_id,
      nonce: tx.nonce,
      tx_status: tx.tx_status,
      block_height: tx.block_height,
    }));
  } catch {
    return [];
  }
}

function detectNonceGaps(
  confirmedNonce: number,
  mempoolTxs: MempoolTx[]
): number[] {
  if (mempoolTxs.length === 0) return [];
  const mempoolNonces = mempoolTxs.map((tx) => tx.nonce).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let n = confirmedNonce; n < mempoolNonces[mempoolNonces.length - 1]; n++) {
    if (!mempoolNonces.includes(n)) {
      gaps.push(n);
    }
  }
  return gaps;
}

// ── Commands ─────────────────────────────────────────────────────────────────

program
  .name("stacks-nonce-monitor")
  .description("Monitor Stacks account nonce health and detect gaps");

program
  .command("status")
  .description("Show nonce health for a Stacks address")
  .option("--address <stx>", "Stacks address to check", DEFAULT_ADDRESS)
  .action(async (options: { address: string }) => {
    const address = options.address;

    const [account, mempoolTxs] = await Promise.all([
      getAccountInfo(address),
      getMempoolTxs(address),
    ]);

    if (!account) {
      console.log(
        JSON.stringify(
          {
            status: "error",
            address,
            error: "Failed to fetch account info from Hiro API",
            severity: "error",
          },
          null,
          2
        )
      );
      process.exit(1);
    }

    const confirmedNonce = account.nonce;
    const mempoolNonces = mempoolTxs.map((tx) => tx.nonce).sort((a, b) => a - b);
    const gaps = detectNonceGaps(confirmedNonce, mempoolTxs);
    const maxMempoolNonce = mempoolNonces.length > 0 ? mempoolNonces[mempoolNonces.length - 1] : null;

    const hasGap = gaps.length > 0;
    const severity = hasGap ? "warn" : mempoolTxs.length > 10 ? "warn" : "ok";

    const summary = hasGap
      ? `Nonce gap detected at ${gaps.join(", ")} — ${mempoolTxs.length} mempool txs may be stuck`
      : mempoolTxs.length > 0
        ? `Nonce healthy. ${mempoolTxs.length} txs in mempool, max nonce ${maxMempoolNonce}`
        : `Nonce healthy. No pending mempool transactions`;

    console.log(
      JSON.stringify(
        {
          status: "ok",
          address,
          nonce: {
            confirmed: confirmedNonce,
            mempool_pending: mempoolTxs.length,
            mempool_max_nonce: maxMempoolNonce,
            gaps,
            has_gap: hasGap,
          },
          mempool_txs: mempoolTxs.map((tx) => ({
            tx_id: tx.tx_id,
            nonce: tx.nonce,
            status: tx.tx_status,
          })),
          summary,
          severity,
        },
        null,
        2
      )
    );
  });

program
  .command("history")
  .description("Show recent confirmed transactions and their nonces")
  .option("--address <stx>", "Stacks address to check", DEFAULT_ADDRESS)
  .option("--limit <n>", "Number of recent transactions to fetch", "20")
  .action(async (options: { address: string; limit: string }) => {
    const address = options.address;
    const limit = Math.min(parseInt(options.limit, 10) || 20, 50);

    const txs = await getRecentTxs(address, limit);

    if (txs.length === 0) {
      console.log(
        JSON.stringify(
          {
            status: "ok",
            address,
            transactions: [],
            count: 0,
            note: "No confirmed transactions found",
          },
          null,
          2
        )
      );
      return;
    }

    const nonces = txs.map((tx) => tx.nonce);
    const minNonce = Math.min(...nonces);
    const maxNonce = Math.max(...nonces);

    console.log(
      JSON.stringify(
        {
          status: "ok",
          address,
          transactions: txs,
          count: txs.length,
          nonce_range: { min: minNonce, max: maxNonce },
          note: `${txs.length} recent confirmed transactions`,
        },
        null,
        2
      )
    );
  });

program
  .command("install-packs")
  .description("Check skill dependencies")
  .action(() => {
    console.log(
      JSON.stringify(
        {
          status: "ok",
          dependencies: {
            bun: "required (runtime)",
            commander: "required (argument parsing)",
            fetch: "built-in (Bun global)",
          },
          note: "No additional packages required. Run with: bun run stacks-nonce-monitor.ts",
        },
        null,
        2
      )
    );
  });

program.parse();
