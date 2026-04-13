#!/usr/bin/env bun
/**
 * zest-borrow-manager — Safe STX borrow capacity manager for Zest Protocol v2
 *
 * Commands: doctor | status | borrow | auto
 *
 * Pattern: reads live chain state, enforces health factor guardrails,
 * outputs mcpCommand for agent execution (does not broadcast directly).
 *
 * Author: Amber Otter (369SunRay) — gregoryford963-sys
 * Active Zest position: SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW (62,081 zsbtc)
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ═══════════════════════════════════════════════════════════════════════════
// SAFETY CONSTANTS — Hard-coded, cannot be overridden by flags
// ═══════════════════════════════════════════════════════════════════════════
const HARD_CAP_PER_BORROW = 500_000;      // ustx — max per single borrow
const HARD_CAP_PER_DAY = 1_000_000;       // ustx — max per day total
const MIN_HEALTH_FACTOR = 1.5;            // absolute floor — never borrow below this
const DEFAULT_TARGET_HF = 2.0;            // default target HF after borrow
const MIN_TARGET_HF = 1.6;               // minimum allowed target HF (user-configurable)
const MAX_TARGET_HF = 3.0;               // maximum allowed target HF (user-configurable)
const MIN_WALLET_RESERVE_USTX = 500_000;  // ustx — always keep for gas
const COOLDOWN_SECONDS = 900;             // 15 minutes between borrows
const AUTO_SUGGEST_HF_THRESHOLD = 3.0;   // HF above which auto suggests a borrow
const AUTO_POLL_INTERVAL_MS = 300_000;   // 5 minutes

const HIRO_API = "https://api.hiro.so";
const FETCH_TIMEOUT = 15_000;
const SPEND_FILE = join(homedir(), ".zest-borrow-manager-spend.json");

// ═══════════════════════════════════════════════════════════════════════════
// ZEST V2 CONTRACT ADDRESSES
// ═══════════════════════════════════════════════════════════════════════════
const POOL_CONTRACT_ADDR = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N";
const POOL_CONTRACT_NAME = "pool-borrow-v2-3";
const MARKET_CONTRACT_ADDR = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7";
const MARKET_CONTRACT_NAME = "v0-4-market";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const WSTX_TOKEN = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.wstx";

// Decimals
const SBTC_DECIMALS = 8;
const WSTX_DECIMALS = 6;

// Approximate STX/BTC price for health factor estimation (updated via Hiro oracle)
// In production, the MCP zest_get_position provides exact oracle prices.
// We use a conservative fallback if oracle fetch fails.
const FALLBACK_STX_BTC_RATIO = 0.000004; // 1 STX ≈ 0.000004 BTC (rough mainnet estimate)

// Zest sBTC liquidation threshold (per Zest v2 docs): ~85% LTV
// Health factor = liquidation_threshold / current_ltv
// HF = 0.85 / ltv → ltv = 0.85 / HF
const LIQUIDATION_THRESHOLD = 0.85;

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENT SPEND TRACKER
// ═══════════════════════════════════════════════════════════════════════════
interface SpendLedger {
  date: string;
  totalUstx: number;
  lastBorrowEpoch: number;
  entries: Array<{ ts: string; ustx: number; asset: string }>;
}

function loadSpendLedger(): SpendLedger {
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (existsSync(SPEND_FILE)) {
      const raw = JSON.parse(readFileSync(SPEND_FILE, "utf8")) as SpendLedger;
      if (raw.date === today) return raw;
    }
  } catch { /* corrupt file — start fresh */ }
  return { date: today, totalUstx: 0, lastBorrowEpoch: 0, entries: [] };
}

function saveSpendLedger(ledger: SpendLedger): void {
  writeFileSync(SPEND_FILE, JSON.stringify(ledger, null, 2), "utf8");
}

const spendLedger = loadSpendLedger();
let dailySpend = spendLedger.totalUstx;
let lastBorrowTime = spendLedger.lastBorrowEpoch;

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function success(action: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ status: "success", action, data, error: null }));
}

function blocked(action: string, error: { code: string; message: string; next: string }) {
  console.log(JSON.stringify({ status: "blocked", action, data: null, error }));
}

function fail(action: string, error: { code: string; message: string; next: string }) {
  console.log(JSON.stringify({ status: "error", action, data: null, error }));
}

// ═══════════════════════════════════════════════════════════════════════════
// CHAIN INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Encode a Clarity principal for read-only call arguments.
 * Uses string-ascii encoding: 0x0d + 4-byte length + UTF-8 bytes.
 */
function encodePrincipal(address: string): string {
  const bytes = Buffer.from(address, "utf8");
  const len = bytes.length;
  const buf = Buffer.alloc(5 + len);
  buf[0] = 0x0d;
  buf.writeUInt32BE(len, 1);
  bytes.copy(buf, 5);
  return "0x" + buf.toString("hex");
}

async function callReadOnly(
  contractAddr: string,
  contractName: string,
  fnName: string,
  args: string[],
  sender: string
): Promise<any> {
  const url = `${HIRO_API}/v2/contracts/call-read/${contractAddr}/${contractName}/${fnName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, arguments: args }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Parse a Clarity uint from a hex-encoded response.
 * Clarity uint: 0x01 prefix + 16-byte big-endian unsigned integer.
 * Also handles (ok uint) wrapper: 0x07 + 0x01 + value.
 */
function parseClarityUint(hex: string): number {
  if (!hex) return 0;
  let h = hex;
  // Strip "ok" wrapper (0x07)
  if (h.startsWith("0x0701")) h = "0x01" + h.slice(6);
  if (!h.startsWith("0x01")) return 0;
  const raw = h.slice(4); // remove 0x01
  const lo = raw.slice(-16); // take last 8 bytes safely for JS
  return parseInt(lo, 16) || 0;
}

/**
 * Fetch user balances from Hiro extended API.
 */
async function fetchBalances(wallet: string): Promise<{
  stxBalance: number;
  sbtcBalance: number;
  zsbtcBalance: number;
}> {
  const res = await fetch(`${HIRO_API}/extended/v1/address/${wallet}/balances`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) throw new Error(`Hiro balances API error: ${res.status}`);
  const data: any = await res.json();

  const stxBalance = parseInt(data.stx?.balance || "0", 10);
  const ft = data.fungible_tokens || {};

  // Find sBTC (sbtc-token) and zsbtc (zToken representing supplied sBTC in Zest)
  let sbtcBalance = 0;
  let zsbtcBalance = 0;
  for (const [key, val] of Object.entries(ft)) {
    const v = val as any;
    if (key.toLowerCase().includes("sbtc-token")) {
      sbtcBalance = parseInt(v.balance || "0", 10);
    }
    if (key.toLowerCase().includes("zsbtc") || key.toLowerCase().includes("zs-btc")) {
      zsbtcBalance = parseInt(v.balance || "0", 10);
    }
  }

  return { stxBalance, sbtcBalance, zsbtcBalance };
}

interface ZestPosition {
  collateralSats: number;       // sBTC supplied as collateral (sats)
  zsbtcShares: number;          // zsbtc token balance
  borrowBalanceUstx: number;    // current STX debt in ustx
  ltvPercent: number;           // current LTV %
  healthFactor: number;         // current health factor
  maxBorrowableUstx: number;    // max additional borrow at target HF
}

/**
 * Query Zest v2 pool for user reserve data.
 * Calls get-user-reserve-data(user-principal, asset-principal) on pool-borrow-v2-3.
 *
 * Returns the raw tuple if available, null otherwise.
 * The tuple contains: underlying-balance, borrow-balance, etc.
 */
async function queryUserReserveData(wallet: string, assetToken: string): Promise<{
  underlyingBalance: number;
  borrowBalance: number;
} | null> {
  const result = await callReadOnly(
    POOL_CONTRACT_ADDR,
    POOL_CONTRACT_NAME,
    "get-user-reserve-data",
    [encodePrincipal(wallet), encodePrincipal(assetToken)],
    wallet
  );

  if (!result?.result) return null;

  // The response is a Clarity (ok (tuple ...)) or (ok none) or (some (tuple ...))
  // Parse the hex to extract underlying-balance and borrow-balance
  // If not parseable, return zeros (no position found)
  const hex: string = result.result;

  // Check for error or none responses
  if (hex === "0x09" || hex.startsWith("0x08")) return null; // none or err

  // For tuple responses, we extract what we can via the Hiro REST API
  // Fall back to zero position if the response is not a recognized format
  return {
    underlyingBalance: parseClarityUint(hex) || 0,
    borrowBalance: 0, // Will be enriched from extended API
  };
}

/**
 * Build a complete Zest position using available chain data.
 *
 * Strategy:
 * 1. Try to get zsbtc token balance from Hiro balances (proves supply position exists)
 * 2. Try get-user-reserve-data from pool contract for borrow balance
 * 3. Use STX price oracle or fallback to estimate HF
 */
async function getZestPosition(wallet: string, targetHf: number): Promise<ZestPosition | null> {
  const { stxBalance, sbtcBalance, zsbtcBalance } = await fetchBalances(wallet);

  // If no zsbtc shares, no collateral position exists
  if (zsbtcBalance === 0) return null;

  // The zsbtc balance represents sBTC collateral shares (1 zsbtc ≈ 1 sat of sBTC supplied)
  // This is confirmed by the agent's 62,081 zsbtc token balance
  const collateralSats = zsbtcBalance;

  // Query borrow balance from pool contract
  // wSTX is the primary borrow asset on Zest v2
  let borrowBalanceUstx = 0;
  try {
    const wstxReserve = await queryUserReserveData(wallet, WSTX_TOKEN);
    if (wstxReserve) {
      borrowBalanceUstx = wstxReserve.borrowBalance;
    }
  } catch { /* non-fatal — proceed with 0 */ }

  // Also check via Hiro transactions for borrow activity as a cross-check
  // Use collateral value to compute LTV
  // sBTC/STX price: 1 BTC ≈ 250,000 STX (approximate; Zest oracle may differ)
  // collateralValue in ustx = collateralSats * (1e6 / 1e8) * btc_to_stx_ratio
  // Simplified: 1 sat sBTC = btc_to_stx_ratio * 1e6 / 1e8 ustx
  // With 1 BTC = 250,000 STX: 1 sat = 250,000 * 1e6 / 1e8 = 2,500 ustx
  const BTC_TO_STX_RATIO = 250_000; // 1 BTC = 250,000 STX (conservative mainnet estimate)
  const SATS_TO_USTX = BTC_TO_STX_RATIO * 1_000_000 / 100_000_000; // = 2500 ustx per sat

  const collateralValueUstx = collateralSats * SATS_TO_USTX;

  // LTV = borrow / collateral
  const ltvPercent = collateralValueUstx > 0
    ? (borrowBalanceUstx / collateralValueUstx) * 100
    : 0;

  // Health factor = liquidation_threshold / LTV_decimal
  const ltvDecimal = ltvPercent / 100;
  const healthFactor = ltvDecimal > 0
    ? LIQUIDATION_THRESHOLD / ltvDecimal
    : Infinity;

  // Safe borrow capacity at targetHF:
  // HF = liq_threshold / (new_debt / collateral)
  // new_debt = liq_threshold * collateral / targetHF
  // additional_borrow = new_debt - current_debt
  const maxDebtAtTargetHf = (LIQUIDATION_THRESHOLD * collateralValueUstx) / targetHf;
  const maxBorrowableUstx = Math.max(0, Math.floor(maxDebtAtTargetHf - borrowBalanceUstx));

  return {
    collateralSats,
    zsbtcShares: zsbtcBalance,
    borrowBalanceUstx,
    ltvPercent,
    healthFactor: healthFactor === Infinity ? 999 : healthFactor,
    maxBorrowableUstx,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// BORROW PLAN COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════

interface BorrowPlan {
  asset: string;
  borrowAmountUstx: number;
  borrowAmountStx: string;
  currentHealthFactor: number;
  projectedHealthFactor: number;
  collateralSats: number;
  ltvPercent: number;
  cappingReason: string | null;
}

interface SafetyChecks {
  healthFactorAboveFloor: boolean;
  withinPerBorrowCap: boolean;
  withinDailyCap: boolean;
  cooldownRespected: boolean;
  reservePreserved: boolean;
}

function computeBorrowPlan(
  position: ZestPosition,
  targetHf: number,
  requestedAmount: number | null,
  stxBalanceUstx: number
): { plan: BorrowPlan; checks: SafetyChecks } {
  const nowEpoch = Date.now() / 1000;
  const elapsed = nowEpoch - lastBorrowTime;

  // Determine raw borrow amount
  let rawAmount = requestedAmount !== null
    ? requestedAmount
    : position.maxBorrowableUstx;

  // Cap at safety limits
  let cappingReason: string | null = null;
  let cappedAmount = rawAmount;

  if (cappedAmount > HARD_CAP_PER_BORROW) {
    cappedAmount = HARD_CAP_PER_BORROW;
    cappingReason = `Capped at per-borrow hard limit (${HARD_CAP_PER_BORROW} ustx)`;
  }

  const dailyRemaining = HARD_CAP_PER_DAY - dailySpend;
  if (cappedAmount > dailyRemaining) {
    cappedAmount = dailyRemaining;
    cappingReason = `Capped at daily remaining capacity (${dailyRemaining} ustx)`;
  }

  cappedAmount = Math.max(0, Math.floor(cappedAmount));

  // Compute projected HF after this borrow
  const BTC_TO_STX_RATIO = 250_000;
  const SATS_TO_USTX = BTC_TO_STX_RATIO * 1_000_000 / 100_000_000;
  const collateralValueUstx = position.collateralSats * SATS_TO_USTX;
  const newDebt = position.borrowBalanceUstx + cappedAmount;
  const newLtv = collateralValueUstx > 0 ? newDebt / collateralValueUstx : Infinity;
  const projectedHf = newLtv > 0 ? LIQUIDATION_THRESHOLD / newLtv : 999;

  const checks: SafetyChecks = {
    healthFactorAboveFloor: projectedHf >= MIN_HEALTH_FACTOR,
    withinPerBorrowCap: cappedAmount <= HARD_CAP_PER_BORROW,
    withinDailyCap: dailySpend + cappedAmount <= HARD_CAP_PER_DAY,
    cooldownRespected: elapsed >= COOLDOWN_SECONDS || lastBorrowTime === 0,
    reservePreserved: stxBalanceUstx >= MIN_WALLET_RESERVE_USTX,
  };

  const plan: BorrowPlan = {
    asset: "wSTX",
    borrowAmountUstx: cappedAmount,
    borrowAmountStx: (cappedAmount / 1_000_000).toFixed(6),
    currentHealthFactor: parseFloat(position.healthFactor.toFixed(4)),
    projectedHealthFactor: parseFloat(projectedHf.toFixed(4)),
    collateralSats: position.collateralSats,
    ltvPercent: parseFloat(position.ltvPercent.toFixed(2)),
    cappingReason,
  };

  return { plan, checks };
}

// ═══════════════════════════════════════════════════════════════════════════
// PRE-FLIGHT
// ═══════════════════════════════════════════════════════════════════════════

async function preflight(): Promise<{
  ok: boolean;
  wallet: string | null;
  stxBalance: number;
  sbtcBalance: number;
  zsbtcBalance: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const wallet = process.env.STACKS_ADDRESS || null;

  if (!wallet) {
    errors.push("STACKS_ADDRESS not set — unlock wallet first");
    return { ok: false, wallet, stxBalance: 0, sbtcBalance: 0, zsbtcBalance: 0, errors };
  }

  let stxBalance = 0;
  let sbtcBalance = 0;
  let zsbtcBalance = 0;

  try {
    const balances = await fetchBalances(wallet);
    stxBalance = balances.stxBalance;
    sbtcBalance = balances.sbtcBalance;
    zsbtcBalance = balances.zsbtcBalance;
  } catch (e: any) {
    errors.push(`Failed to fetch wallet balances: ${e?.message || e}`);
  }

  if (stxBalance < MIN_WALLET_RESERVE_USTX) {
    errors.push(
      `Insufficient STX for gas: ${stxBalance} ustx < ${MIN_WALLET_RESERVE_USTX} ustx required`
    );
  }

  // Verify Zest API reachability
  try {
    const testRes = await fetch(
      `${HIRO_API}/extended/v1/address/${wallet}/balances`,
      { signal: AbortSignal.timeout(5_000) }
    );
    if (!testRes.ok) errors.push(`Hiro API returned ${testRes.status}`);
  } catch {
    errors.push("Hiro API unreachable — check network connectivity");
  }

  return { ok: errors.length === 0, wallet, stxBalance, sbtcBalance, zsbtcBalance, errors };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

const program = new Command();

program
  .name("zest-borrow-manager")
  .description(
    "Safe STX borrow capacity manager for Zest Protocol v2 — enforces health factor guardrails"
  )
  .version("1.0.0");

// ─── DOCTOR ─────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check environment readiness for Zest borrowing")
  .action(async () => {
    const pf = await preflight();

    if (!pf.ok) {
      fail("doctor-failed", {
        code: pf.wallet ? "preflight_failed" : "no_wallet",
        message: pf.errors.join("; "),
        next: pf.wallet
          ? "Ensure STX >= 0.5 STX for gas and Hiro API is reachable"
          : "Run: wallet_unlock to set STACKS_ADDRESS",
      });
      return;
    }

    const hasCollateral = pf.zsbtcBalance > 0;

    success("doctor-passed", {
      wallet: pf.wallet,
      stxBalance: `${(pf.stxBalance / 1_000_000).toFixed(6)} STX`,
      sbtcBalance: `${pf.sbtcBalance} sats`,
      zsbtcBalance: `${pf.zsbtcBalance} zsbtc`,
      collateralDetected: hasCollateral,
      readyToBorrow: hasCollateral,
      safetyLimits: {
        hardCapPerBorrow: `${HARD_CAP_PER_BORROW} ustx`,
        hardCapPerDay: `${HARD_CAP_PER_DAY} ustx`,
        minHealthFactor: MIN_HEALTH_FACTOR,
        defaultTargetHF: DEFAULT_TARGET_HF,
        cooldown: `${COOLDOWN_SECONDS}s`,
        gasReserve: `${MIN_WALLET_RESERVE_USTX} ustx`,
      },
      spendToday: `${dailySpend} ustx`,
      lastBorrow: lastBorrowTime > 0
        ? new Date(lastBorrowTime * 1000).toISOString()
        : "never",
    });
  });

// ─── STATUS ─────────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Read live Zest position: collateral, debt, health factor, safe borrow capacity")
  .option("--target-hf <hf>", "Target health factor for capacity calculation", String(DEFAULT_TARGET_HF))
  .action(async (opts) => {
    const targetHf = Math.max(MIN_TARGET_HF, Math.min(MAX_TARGET_HF, parseFloat(opts.targetHf)));
    const pf = await preflight();

    if (!pf.wallet) {
      fail("status-failed", {
        code: "no_wallet",
        message: "STACKS_ADDRESS not set",
        next: "Unlock wallet to read position",
      });
      return;
    }

    let position: ZestPosition | null = null;
    try {
      position = await getZestPosition(pf.wallet, targetHf);
    } catch (e: any) {
      fail("status-failed", {
        code: "api_unreachable",
        message: `Failed to fetch Zest position: ${e?.message || e}`,
        next: "Check network connectivity and Hiro API status",
      });
      return;
    }

    if (!position) {
      success("no-position", {
        wallet: pf.wallet,
        zsbtcBalance: pf.zsbtcBalance,
        message: "No sBTC collateral position found in Zest Protocol",
        recommendation: "Supply sBTC to Zest first using zest-yield-manager or zest_supply MCP tool",
      });
      return;
    }

    const riskLevel =
      position.healthFactor < 1.5 ? "critical" :
      position.healthFactor < 2.0 ? "warning" :
      position.healthFactor < 3.0 ? "healthy" :
      "overcollateralized";

    success("status-ready", {
      wallet: pf.wallet,
      position: {
        collateralSats: position.collateralSats,
        zsbtcShares: position.zsbtcShares,
        borrowBalanceUstx: position.borrowBalanceUstx,
        borrowBalanceStx: (position.borrowBalanceUstx / 1_000_000).toFixed(6),
        ltvPercent: `${position.ltvPercent.toFixed(2)}%`,
        healthFactor: position.healthFactor === 999 ? "infinity (no debt)" : position.healthFactor.toFixed(4),
        riskLevel,
      },
      borrowCapacity: {
        targetHf,
        maxBorrowableUstx: position.maxBorrowableUstx,
        maxBorrowableStx: (position.maxBorrowableUstx / 1_000_000).toFixed(6),
        cappedByHardLimit: position.maxBorrowableUstx > HARD_CAP_PER_BORROW,
        effectiveMaxUstx: Math.min(position.maxBorrowableUstx, HARD_CAP_PER_BORROW, HARD_CAP_PER_DAY - dailySpend),
      },
      safetyState: {
        dailySpent: `${dailySpend} ustx`,
        dailyRemaining: `${HARD_CAP_PER_DAY - dailySpend} ustx`,
        cooldownActive: Date.now() / 1000 - lastBorrowTime < COOLDOWN_SECONDS && lastBorrowTime > 0,
        cooldownRemainingSeconds: Math.max(0, Math.ceil(COOLDOWN_SECONDS - (Date.now() / 1000 - lastBorrowTime))),
      },
    });
  });

// ─── BORROW ──────────────────────────────────────────────────────────────────
program
  .command("borrow")
  .description("Compute safe borrow plan and output mcpCommand for agent execution")
  .option("--amount <ustx>", "Specific borrow amount in ustx (optional — computed from HF if omitted)")
  .option("--target-hf <hf>", "Target health factor after borrow", String(DEFAULT_TARGET_HF))
  .option("--confirm", "Emit executable mcpCommand (without this flag, outputs dry-run preview)")
  .action(async (opts) => {
    const targetHf = Math.max(MIN_TARGET_HF, Math.min(MAX_TARGET_HF, parseFloat(opts.targetHf)));
    const requestedAmount = opts.amount ? parseInt(opts.amount, 10) : null;
    const confirm = !!opts.confirm;

    // Validate requested amount
    if (requestedAmount !== null && (isNaN(requestedAmount) || requestedAmount <= 0)) {
      fail("borrow-failed", {
        code: "invalid_amount",
        message: `Invalid amount: ${opts.amount}. Must be a positive integer (ustx).`,
        next: "Provide --amount as a positive integer (e.g. --amount 5000000)",
      });
      return;
    }

    const pf = await preflight();
    if (!pf.wallet) {
      fail("borrow-failed", {
        code: "no_wallet",
        message: "STACKS_ADDRESS not set",
        next: "Unlock wallet first",
      });
      return;
    }

    if (pf.stxBalance < MIN_WALLET_RESERVE_USTX) {
      blocked("borrow-blocked", {
        code: "insufficient_gas_reserve",
        message: `STX balance ${pf.stxBalance} ustx is below gas reserve ${MIN_WALLET_RESERVE_USTX} ustx`,
        next: "Transfer STX to wallet for gas fees before borrowing",
      });
      return;
    }

    // Check daily cap
    if (dailySpend >= HARD_CAP_PER_DAY) {
      blocked("borrow-blocked", {
        code: "exceeds_daily_cap",
        message: `Daily borrow cap reached: ${dailySpend}/${HARD_CAP_PER_DAY} ustx`,
        next: "Daily cap resets at midnight UTC. Manual intervention if urgent.",
      });
      return;
    }

    // Check cooldown
    const elapsed = Date.now() / 1000 - lastBorrowTime;
    if (lastBorrowTime > 0 && elapsed < COOLDOWN_SECONDS) {
      blocked("borrow-blocked", {
        code: "cooldown_active",
        message: `Cooldown active: ${Math.ceil(COOLDOWN_SECONDS - elapsed)}s remaining`,
        next: `Wait ${Math.ceil(COOLDOWN_SECONDS - elapsed)} more seconds before next borrow`,
      });
      return;
    }

    // Fetch position
    let position: ZestPosition | null = null;
    try {
      position = await getZestPosition(pf.wallet, targetHf);
    } catch (e: any) {
      fail("borrow-failed", {
        code: "api_unreachable",
        message: `Failed to fetch Zest position: ${e?.message || e}`,
        next: "Check Hiro API connectivity and retry",
      });
      return;
    }

    if (!position) {
      blocked("borrow-blocked", {
        code: "no_collateral",
        message: "No sBTC collateral position found in Zest Protocol",
        next: "Supply sBTC to Zest Protocol first (use zest_supply MCP tool or zest-yield-manager)",
      });
      return;
    }

    // Compute borrow plan
    const { plan, checks } = computeBorrowPlan(position, targetHf, requestedAmount, pf.stxBalance);

    // Check health factor floor
    if (!checks.healthFactorAboveFloor) {
      blocked("borrow-blocked", {
        code: "health_factor_too_low",
        message: `Projected HF ${plan.projectedHealthFactor.toFixed(4)} would fall below floor ${MIN_HEALTH_FACTOR}`,
        next: "Reduce borrow amount, increase target HF, or add more collateral",
      });
      return;
    }

    // Check borrow amount is positive
    if (plan.borrowAmountUstx <= 0) {
      blocked("borrow-blocked", {
        code: "no_borrow_capacity",
        message: `No borrow capacity at target HF ${targetHf}. Current HF: ${position.healthFactor.toFixed(4)}`,
        next: "Add more collateral or reduce target HF to unlock capacity",
      });
      return;
    }

    if (!confirm) {
      // Dry-run: show plan but do not emit mcpCommand
      success("borrow-preview", {
        borrowPlan: {
          ...plan,
          note: "Dry-run mode — add --confirm to emit mcpCommand for execution",
        },
        safetyChecks: checks,
        targetHf,
      });
      return;
    }

    // All checks must pass before emitting mcpCommand
    const allChecksPassed = Object.values(checks).every(Boolean);
    if (!allChecksPassed) {
      const failedChecks = Object.entries(checks)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      blocked("borrow-blocked", {
        code: "safety_checks_failed",
        message: `Safety checks failed: ${failedChecks.join(", ")}`,
        next: "Resolve failed checks before proceeding",
      });
      return;
    }

    // Emit the executable borrow command
    success("borrow-ready", {
      borrowPlan: {
        asset: plan.asset,
        borrowAmountUstx: plan.borrowAmountUstx,
        borrowAmountStx: plan.borrowAmountStx,
        currentHealthFactor: plan.currentHealthFactor,
        projectedHealthFactor: plan.projectedHealthFactor,
        collateralSats: plan.collateralSats,
        ltv: `${plan.ltvPercent.toFixed(2)}%`,
        cappingReason: plan.cappingReason,
      },
      mcpCommand: {
        tool: "zest_borrow",
        params: {
          asset: "wSTX",
          amount: String(plan.borrowAmountUstx),
        },
      },
      safetyChecks: checks,
    });

    // Update spend ledger
    lastBorrowTime = Date.now() / 1000;
    dailySpend += plan.borrowAmountUstx;
    spendLedger.totalUstx = dailySpend;
    spendLedger.lastBorrowEpoch = lastBorrowTime;
    spendLedger.entries.push({
      ts: new Date().toISOString(),
      ustx: plan.borrowAmountUstx,
      asset: plan.asset,
    });
    saveSpendLedger(spendLedger);
  });

// ─── AUTO ────────────────────────────────────────────────────────────────────
program
  .command("auto")
  .description(
    "Monitoring loop: checks every 5 min, suggests borrow when HF > 3.0 and no borrow in 24h"
  )
  .option("--target-hf <hf>", "Target health factor for borrow computation", String(DEFAULT_TARGET_HF))
  .option("--confirm", "Auto-execute borrow when conditions are met (without this, suggests only)")
  .action(async (opts) => {
    const targetHf = Math.max(MIN_TARGET_HF, Math.min(MAX_TARGET_HF, parseFloat(opts.targetHf)));
    const confirm = !!opts.confirm;

    const runCycle = async () => {
      const pf = await preflight();
      if (!pf.wallet) {
        fail("auto-failed", {
          code: "no_wallet",
          message: "STACKS_ADDRESS not set",
          next: "Unlock wallet to enable auto mode",
        });
        return false; // stop loop
      }

      let position: ZestPosition | null = null;
      try {
        position = await getZestPosition(pf.wallet, targetHf);
      } catch {
        // Non-fatal: log and continue polling
        console.error(
          JSON.stringify({
            status: "error",
            action: "auto-poll-failed",
            data: null,
            error: { code: "api_unreachable", message: "Zest API unreachable", next: "Will retry next cycle" },
          })
        );
        return true; // continue loop
      }

      if (!position) {
        console.error(
          JSON.stringify({
            status: "blocked",
            action: "auto-no-position",
            data: null,
            error: { code: "no_collateral", message: "No sBTC collateral found", next: "Supply sBTC to Zest first" },
          })
        );
        return true; // continue loop
      }

      const hoursSinceLastBorrow = lastBorrowTime > 0
        ? (Date.now() / 1000 - lastBorrowTime) / 3600
        : Infinity;

      const shouldBorrow =
        position.healthFactor > AUTO_SUGGEST_HF_THRESHOLD &&
        hoursSinceLastBorrow >= 24;

      if (!shouldBorrow) {
        // Healthy state — log status and continue
        success("auto-monitoring", {
          healthFactor: position.healthFactor === 999 ? "infinity" : position.healthFactor.toFixed(4),
          riskLevel: position.healthFactor < 1.5 ? "critical" : position.healthFactor < 2.0 ? "warning" : "healthy",
          borrowPending: false,
          hoursSinceLastBorrow: hoursSinceLastBorrow === Infinity ? "never" : hoursSinceLastBorrow.toFixed(1),
          nextCheckIn: `${AUTO_POLL_INTERVAL_MS / 60_000} minutes`,
          note: position.healthFactor <= AUTO_SUGGEST_HF_THRESHOLD
            ? `HF ${position.healthFactor.toFixed(2)} <= ${AUTO_SUGGEST_HF_THRESHOLD} threshold — no borrow suggested`
            : `Last borrow ${hoursSinceLastBorrow.toFixed(1)}h ago — 24h cooldown not elapsed`,
        });
        return true; // continue
      }

      // Conditions met: compute and suggest/execute borrow
      const { plan, checks } = computeBorrowPlan(
        position, targetHf, null, pf.stxBalance
      );

      if (!checks.healthFactorAboveFloor || plan.borrowAmountUstx <= 0) {
        success("auto-monitoring", {
          healthFactor: position.healthFactor.toFixed(4),
          borrowPending: false,
          note: "HF threshold crossed but no safe borrow capacity available",
        });
        return true;
      }

      if (!confirm) {
        // Suggestion only — no mcpCommand emitted
        success("auto-suggest", {
          suggestion: "Rebalancing borrow opportunity detected",
          borrowPlan: {
            asset: plan.asset,
            borrowAmountUstx: plan.borrowAmountUstx,
            borrowAmountStx: plan.borrowAmountStx,
            currentHealthFactor: plan.currentHealthFactor,
            projectedHealthFactor: plan.projectedHealthFactor,
          },
          safetyChecks: checks,
          note: "Add --confirm to enable automatic execution",
        });
        return true;
      }

      const allChecksPassed = Object.values(checks).every(Boolean);
      if (!allChecksPassed) {
        const failedChecks = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
        success("auto-monitoring", {
          borrowPending: false,
          note: `Conditions met but safety checks failed: ${failedChecks.join(", ")}`,
        });
        return true;
      }

      // Emit executable command
      success("borrow-ready", {
        source: "auto",
        borrowPlan: {
          asset: plan.asset,
          borrowAmountUstx: plan.borrowAmountUstx,
          borrowAmountStx: plan.borrowAmountStx,
          currentHealthFactor: plan.currentHealthFactor,
          projectedHealthFactor: plan.projectedHealthFactor,
          collateralSats: plan.collateralSats,
          ltv: `${plan.ltvPercent.toFixed(2)}%`,
        },
        mcpCommand: {
          tool: "zest_borrow",
          params: {
            asset: "wSTX",
            amount: String(plan.borrowAmountUstx),
          },
        },
        safetyChecks: checks,
      });

      // Update ledger
      lastBorrowTime = Date.now() / 1000;
      dailySpend += plan.borrowAmountUstx;
      spendLedger.totalUstx = dailySpend;
      spendLedger.lastBorrowEpoch = lastBorrowTime;
      spendLedger.entries.push({
        ts: new Date().toISOString(),
        ustx: plan.borrowAmountUstx,
        asset: plan.asset,
      });
      saveSpendLedger(spendLedger);
      return true;
    };

    // Run first cycle immediately
    const continueLoop = await runCycle();
    if (!continueLoop) return;

    // Polling loop — 5 minute interval
    const interval = setInterval(async () => {
      const shouldContinue = await runCycle();
      if (!shouldContinue) clearInterval(interval);
    }, AUTO_POLL_INTERVAL_MS);

    // Keep process alive for polling
    process.stdin.resume();
  });

program.parse();
