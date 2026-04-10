#!/usr/bin/env bun
/**
 * stacks-wallet-sentinel
 * Autonomous Stacks wallet health monitor — balances, nonce gaps, stuck txs, auto-heal.
 *
 * Commands:
 *   doctor                         Full diagnostic (read-only)
 *   watch [--address <stxAddr>]    One-shot health check with severity + alerts
 *   heal  [--address <stxAddr>]    Close nonce gaps via nonce_heal
 *   install-packs [--pack all]     Report required dependencies
 */

const HIRO_API = "https://api.hiro.so";
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

// Default thresholds (uSTX / sats)
const THRESHOLD = {
  STX_WARN: 500_000,      // 0.5 STX
  STX_CRITICAL: 100_000,  // 0.1 STX
  SBTC_WARN: 10_000,
  SBTC_CRITICAL: 1_000,
  STUCK_TX_MS: 30 * 60 * 1000, // 30 minutes
};

interface Alert {
  level: "warn" | "critical";
  code: string;
  message: string;
}

interface WatchData {
  address: string;
  balances: { stx_ustx: number; sbtc_sats: number };
  nonce: { chain: number; mempool_max: number; gap: boolean; gap_range?: number[] };
  mempool: { pending_count: number; oldest_pending_ms: number };
  thresholds: typeof THRESHOLD;
  alerts: Alert[];
}

function output(status: string, severity: string, action: string, data: object, error: object | null) {
  console.log(JSON.stringify({ status, severity, action, data, error }, null, 2));
}

function fail(code: string, message: string, next: string) {
  output("error", "error", "check_api_connectivity", {}, { code, message, next });
  process.exit(1);
}

async function fetchHiro(path: string): Promise<any> {
  const res = await fetch(`${HIRO_API}${path}`);
  if (!res.ok) throw new Error(`Hiro API ${res.status}: ${path}`);
  return res.json();
}

async function getStxBalance(address: string): Promise<number> {
  const data = await fetchHiro(`/extended/v1/address/${address}/balances`);
  return parseInt(data.stx?.balance ?? "0", 10);
}

async function getSbtcBalance(address: string): Promise<number> {
  const data = await fetchHiro(`/extended/v1/address/${address}/balances`);
  const tokenKey = Object.keys(data.fungible_tokens ?? {}).find((k) =>
    k.startsWith(SBTC_CONTRACT)
  );
  if (!tokenKey) return 0;
  return parseInt(data.fungible_tokens[tokenKey].balance ?? "0", 10);
}

async function getNonceInfo(address: string): Promise<{ chain: number; mempool_max: number }> {
  const data = await fetchHiro(`/v2/accounts/${address}?proof=0`);
  const chain = data.nonce ?? 0;

  // Check mempool for pending nonces
  const mempool = await fetchHiro(
    `/extended/v1/tx/mempool?sender_address=${address}&limit=50`
  );
  const pending: any[] = mempool.results ?? [];
  const mempoolNonces = pending.map((tx: any) => tx.nonce ?? 0);
  const mempool_max = mempoolNonces.length > 0 ? Math.max(...mempoolNonces) : chain;

  return { chain, mempool_max };
}

async function getMempoolInfo(
  address: string
): Promise<{ pending_count: number; oldest_pending_ms: number }> {
  const mempool = await fetchHiro(
    `/extended/v1/tx/mempool?sender_address=${address}&limit=50`
  );
  const pending: any[] = mempool.results ?? [];
  if (pending.length === 0) return { pending_count: 0, oldest_pending_ms: 0 };

  const now = Date.now();
  const ages = pending
    .map((tx: any) => (tx.receipt_time_iso ? now - new Date(tx.receipt_time_iso).getTime() : 0))
    .filter((ms) => ms > 0);

  return {
    pending_count: pending.length,
    oldest_pending_ms: ages.length > 0 ? Math.max(...ages) : 0,
  };
}

function buildAlerts(data: Omit<WatchData, "alerts">): Alert[] {
  const alerts: Alert[] = [];

  // STX balance checks
  if (data.balances.stx_ustx < THRESHOLD.STX_CRITICAL) {
    alerts.push({
      level: "critical",
      code: "low_stx",
      message: `STX balance ${data.balances.stx_ustx} uSTX is below critical floor (${THRESHOLD.STX_CRITICAL} uSTX). Top up for gas.`,
    });
  } else if (data.balances.stx_ustx < THRESHOLD.STX_WARN) {
    alerts.push({
      level: "warn",
      code: "low_stx",
      message: `STX balance ${data.balances.stx_ustx} uSTX is approaching warn threshold (${THRESHOLD.STX_WARN} uSTX).`,
    });
  }

  // sBTC balance checks
  if (data.balances.sbtc_sats < THRESHOLD.SBTC_CRITICAL) {
    alerts.push({
      level: "critical",
      code: "low_sbtc",
      message: `sBTC balance ${data.balances.sbtc_sats} sats is below critical floor (${THRESHOLD.SBTC_CRITICAL} sats).`,
    });
  } else if (data.balances.sbtc_sats < THRESHOLD.SBTC_WARN) {
    alerts.push({
      level: "warn",
      code: "low_sbtc",
      message: `sBTC balance ${data.balances.sbtc_sats} sats is approaching warn threshold (${THRESHOLD.SBTC_WARN} sats).`,
    });
  }

  // Nonce gap
  if (data.nonce.gap) {
    alerts.push({
      level: "critical",
      code: "nonce_gap",
      message: `Nonce gap detected (chain=${data.nonce.chain}, mempool_max=${data.nonce.mempool_max}). Transactions are stuck. Run heal.`,
    });
  }

  // Stuck transactions
  if (data.mempool.oldest_pending_ms > THRESHOLD.STUCK_TX_MS) {
    const minutes = Math.round(data.mempool.oldest_pending_ms / 60000);
    const level = data.mempool.oldest_pending_ms > 60 * 60 * 1000 ? "critical" : "warn";
    alerts.push({
      level,
      code: "stuck_tx",
      message: `Oldest pending transaction is ${minutes} min old. Check for nonce gaps or fee issues.`,
    });
  }

  return alerts;
}

function getSeverity(alerts: Alert[]): string {
  if (alerts.some((a) => a.level === "critical")) return "critical";
  if (alerts.some((a) => a.level === "warn")) return "warn";
  return "ok";
}

function getAction(alerts: Alert[]): string {
  const criticals = alerts.filter((a) => a.level === "critical").map((a) => a.code);
  if (criticals.includes("nonce_gap")) return "run_heal_to_close_nonce_gap";
  if (criticals.includes("low_stx")) return "top_up_stx_for_gas";
  if (criticals.includes("low_sbtc")) return "deposit_sbtc";
  if (criticals.includes("stuck_tx")) return "investigate_stuck_transactions";
  if (alerts.length > 0) return "monitor_warnings";
  return "no_action_required";
}

async function resolveAddress(): Promise<string> {
  // Try to get address from args first
  const addrIdx = process.argv.indexOf("--address");
  if (addrIdx !== -1 && process.argv[addrIdx + 1]) {
    return process.argv[addrIdx + 1];
  }
  // Fall back to env
  if (process.env.STX_ADDRESS) return process.env.STX_ADDRESS;
  // Try to infer from MCP wallet status (skip if not available)
  return "";
}

async function runWatch(address: string) {
  if (!address) {
    fail("no_address", "No Stacks address provided. Use --address or set STX_ADDRESS env var.", "Pass --address SP3...");
    return;
  }

  try {
    const [stx_ustx, sbtc_sats, nonceInfo, mempoolInfo] = await Promise.all([
      getStxBalance(address),
      getSbtcBalance(address),
      getNonceInfo(address),
      getMempoolInfo(address),
    ]);

    // Detect nonce gap
    let gap = false;
    let gap_range: number[] | undefined;
    if (nonceInfo.mempool_max > nonceInfo.chain) {
      // Check if there's a gap (missing nonce in sequence)
      // chain nonce = next expected; mempool_max = highest nonce in mempool
      // Gap exists if chain + 1 < mempool_max (a nonce was skipped)
      if (nonceInfo.chain + 1 < nonceInfo.mempool_max) {
        gap = true;
        gap_range = [];
        for (let n = nonceInfo.chain; n < nonceInfo.mempool_max; n++) {
          gap_range.push(n);
        }
      }
    }

    const watchData: Omit<WatchData, "alerts"> = {
      address,
      balances: { stx_ustx, sbtc_sats },
      nonce: { chain: nonceInfo.chain, mempool_max: nonceInfo.mempool_max, gap, gap_range },
      mempool: mempoolInfo,
      thresholds: THRESHOLD,
    };

    const alerts = buildAlerts(watchData);
    const severity = getSeverity(alerts);
    const action = getAction(alerts);

    output("success", severity, action, { ...watchData, alerts }, null);
  } catch (e: any) {
    fail("api_unreachable", e.message, "Retry in next cycle");
  }
}

async function runDoctor(address: string) {
  if (!address) {
    fail("no_address", "No Stacks address provided. Use --address or set STX_ADDRESS env var.", "Pass --address SP3...");
    return;
  }

  try {
    const [stx_ustx, sbtc_sats, nonceInfo, mempoolInfo] = await Promise.all([
      getStxBalance(address),
      getSbtcBalance(address),
      getNonceInfo(address),
      getMempoolInfo(address),
    ]);

    // Full account info
    const accountData = await fetchHiro(`/v2/accounts/${address}?proof=0`);

    output("success", "ok", "doctor_complete", {
      address,
      balances: {
        stx_ustx,
        sbtc_sats,
        stx_stx: stx_ustx / 1_000_000,
        sbtc_btc: sbtc_sats / 100_000_000,
      },
      nonce: {
        chain: nonceInfo.chain,
        mempool_max: nonceInfo.mempool_max,
        gap: nonceInfo.chain + 1 < nonceInfo.mempool_max,
      },
      mempool: mempoolInfo,
      account: {
        balance: accountData.balance,
        locked: accountData.locked,
        unlock_height: accountData.unlock_height,
      },
      thresholds: THRESHOLD,
    }, null);
  } catch (e: any) {
    fail("api_unreachable", e.message, "Check network connectivity");
  }
}

async function runHeal(address: string) {
  if (!address) {
    fail("no_address", "No Stacks address provided. Use --address or set STX_ADDRESS env var.", "Pass --address SP3...");
    return;
  }

  try {
    const nonceInfo = await getNonceInfo(address);
    const gap = nonceInfo.chain + 1 < nonceInfo.mempool_max;

    if (!gap) {
      output("success", "ok", "no_heal_needed", {
        address,
        nonce: nonceInfo,
        message: "No nonce gap detected. Wallet is healthy.",
      }, null);
      return;
    }

    // Check STX balance before heal (needs gas)
    const stx_ustx = await getStxBalance(address);
    if (stx_ustx < THRESHOLD.STX_CRITICAL) {
      output("error", "critical", "top_up_stx_before_heal", {
        nonce: nonceInfo,
        stx_ustx,
      }, {
        code: "insufficient_gas",
        message: `STX balance ${stx_ustx} uSTX too low for heal transaction. Minimum: ${THRESHOLD.STX_CRITICAL} uSTX.`,
        next: "Top up STX then retry heal",
      });
      return;
    }

    // Report gap and instruct on nonce_heal MCP tool
    const gap_range: number[] = [];
    for (let n = nonceInfo.chain; n < nonceInfo.mempool_max; n++) {
      gap_range.push(n);
    }

    output("success", "warn", "heal_instructions_ready", {
      address,
      nonce: nonceInfo,
      gap_range,
      mcp_command: {
        tool: "nonce_heal",
        params: { address },
        description: "Run this MCP tool to submit fill transactions for the nonce gap",
      },
      stx_available_ustx: stx_ustx,
    }, null);
  } catch (e: any) {
    fail("api_unreachable", e.message, "Retry in next cycle");
  }
}

function runInstallPacks() {
  output("success", "ok", "dependencies_checked", {
    required: [
      { package: "@stacks/network", purpose: "Stacks network configuration", status: "not_required — uses Hiro REST API directly" },
      { package: "@stacks/transactions", purpose: "Transaction building for heal", status: "not_required — delegates to nonce_heal MCP tool" },
    ],
    runtime: "bun",
    note: "stacks-wallet-sentinel uses the Hiro REST API directly (no Stacks SDK required). No additional packages needed.",
  }, null);
}

async function main() {
  const command = process.argv[2] ?? "watch";
  const address = await resolveAddress();

  switch (command) {
    case "doctor":
      await runDoctor(address);
      break;
    case "watch":
      await runWatch(address);
      break;
    case "heal":
      await runHeal(address);
      break;
    case "install-packs":
      runInstallPacks();
      break;
    default:
      fail("unknown_command", `Unknown command: ${command}`, "Use: doctor | watch | heal | install-packs");
  }
}

main().catch((e) => {
  fail("unexpected_error", e.message ?? String(e), "Check logs");
});
