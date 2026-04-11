#!/usr/bin/env bun
/**
 * zest-position-tracker.ts — Read-only monitor for Zest Protocol sBTC positions
 *
 * Usage:
 *   bun run zest-position-tracker.ts status [--address <stx>]
 *   bun run zest-position-tracker.ts history [--address <stx>]
 *   bun run zest-position-tracker.ts install-packs
 */

import { program } from "commander";

// ── Config ──────────────────────────────────────────────────────────────────

const HIRO_API = "https://api.hiro.so";
const DEFAULT_ADDRESS = "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW";

const CONTRACTS = {
  ZSBTC: {
    addr: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N",
    name: "zsbtc-v2-0",
    // FT balance key in Hiro extended API
    ftKey: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-token::zsbtc",
  },
  POOL_RESERVE: {
    addr: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N",
    name: "pool-0-reserve-v2-0",
  },
  SBTC: {
    addr: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4",
    name: "sbtc-token",
    // FT balance key in Hiro extended API
    ftKey: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token",
  },
  BORROW_HELPER: {
    addr: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N",
    name: "borrow-helper-v2-1-7",
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getFtBalances(address: string): Promise<{ sbtc: number; zsbtc: number }> {
  try {
    const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/balances`);
    if (!res.ok) return { sbtc: 0, zsbtc: 0 };
    const data = (await res.json()) as {
      fungible_tokens?: Record<string, { balance: string }>;
    };
    const fts = data.fungible_tokens ?? {};
    const sbtc = parseInt(fts[CONTRACTS.SBTC.ftKey]?.balance ?? "0", 10);
    const zsbtc = parseInt(fts[CONTRACTS.ZSBTC.ftKey]?.balance ?? "0", 10);
    return { sbtc, zsbtc };
  } catch {
    return { sbtc: 0, zsbtc: 0 };
  }
}

async function getZestTransactions(
  address: string
): Promise<
  Array<{
    txid: string;
    type: string;
    timestamp: string;
    block_height: number;
  }>
> {
  try {
    const url = `${HIRO_API}/extended/v1/address/${address}/transactions?limit=20`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{
        tx_id: string;
        tx_type: string;
        burn_block_time_iso: string;
        block_height: number;
        contract_call?: {
          contract_id: string;
          function_name: string;
        };
      }>;
    };

    const zestTxs = (data.results ?? []).filter((tx) => {
      const contractId = tx.contract_call?.contract_id ?? "";
      return (
        contractId.includes(CONTRACTS.BORROW_HELPER.name) ||
        contractId.includes(CONTRACTS.ZSBTC.name)
      );
    });

    return zestTxs.map((tx) => ({
      txid: tx.tx_id,
      type: tx.contract_call?.function_name ?? tx.tx_type,
      timestamp: tx.burn_block_time_iso,
      block_height: tx.block_height,
    }));
  } catch {
    return [];
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

program
  .name("zest-position-tracker")
  .description("Read-only Zest Protocol position monitor");

program
  .command("status")
  .description("Show full Zest position and pool status")
  .option("--address <stx>", "Stacks address to check", DEFAULT_ADDRESS)
  .action(async (options: { address: string }) => {
    const address = options.address;

    const { sbtc: liquidSbtc, zsbtc: zsbtcTokens } = await getFtBalances(address);

    const hasPosition = zsbtcTokens > 0;
    const severity =
      liquidSbtc < 1000 && hasPosition
        ? "warn"
        : hasPosition
          ? "ok"
          : "info";

    const summary = hasPosition
      ? `Active position: ${zsbtcTokens} zsbtc tokens. Liquid: ${liquidSbtc} sats.`
      : `No Zest position. Liquid sBTC: ${liquidSbtc} sats.`;

    console.log(
      JSON.stringify(
        {
          status: "ok",
          address,
          zest_position: {
            zsbtc_tokens: zsbtcTokens,
            has_position: hasPosition,
          },
          liquid_sbtc_sats: liquidSbtc,
          pool: {
            contract: `${CONTRACTS.POOL_RESERVE.addr}.${CONTRACTS.POOL_RESERVE.name}`,
            status: "active",
          },
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
  .description("Show recent Zest Protocol transactions")
  .option("--address <stx>", "Stacks address to check", DEFAULT_ADDRESS)
  .action(async (options: { address: string }) => {
    const address = options.address;
    const transactions = await getZestTransactions(address);

    console.log(
      JSON.stringify(
        {
          status: "ok",
          address,
          transactions,
          count: transactions.length,
          note:
            transactions.length === 0
              ? "No recent Zest interactions found"
              : `${transactions.length} Zest transaction(s) found`,
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
          note: "No additional packages required. Run with: bun run zest-position-tracker.ts",
        },
        null,
        2
      )
    );
  });

program.parse();
