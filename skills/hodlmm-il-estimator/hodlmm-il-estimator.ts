#!/usr/bin/env bun
/**
 * hodlmm-il-estimator — Impermanent loss estimator for Bitflow HODLMM pools
 *
 * Compares current pool price to initial (or custom entry) price to estimate
 * IL, break-even fee yield, and HOLD/EXIT signal for autonomous LP agents.
 *
 * Self-contained: uses Bitflow HODLMM API directly, no external deps beyond commander.
 * HODLMM bonus eligible: Yes — reads live HODLMM pool state and bin prices.
 *
 * IL formula: standard CPMM approximation IL = 2√r/(1+r) - 1 where r = P_current/P_initial
 * This is a lower bound for concentrated DLMM positions.
 *
 * Usage: bun run skills/hodlmm-il-estimator/hodlmm-il-estimator.ts <subcommand> [options]
 */
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HODLMM_API_BASE =
  process.env.BITFLOW_HODLMM_API_HOST ?? "https://bff.bitflowapis.finance";
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface HodlmmBinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price?: string;
  liquidity?: string;
}

interface HodlmmPoolInfo {
  pool_id: string;
  active_bin: number;
  bin_step: number;
  token_x: string;
  token_y: string;
  pool_name?: string;
  pool_symbol?: string;
  active?: boolean;
  initial_price?: string;
  sbtc_incentives?: boolean;
}

interface HodlmmBinListResponse {
  active_bin_id?: number;
  bins: HodlmmBinData[];
}

interface HodlmmPoolsResponse {
  pools: HodlmmPoolInfo[];
}

type ILSeverity = "negligible" | "minor" | "moderate" | "significant" | "severe";
type ILSignal = "HOLD" | "EXIT consideration" | "EXIT recommended";

interface ILResult {
  poolId: string;
  pair: string;
  initialPrice: number;
  currentPrice: number;
  priceChangePct: number;
  ilPct: number;
  ilSeverity: ILSeverity;
  signal: ILSignal;
  signalReason: string;
  breakEvenFeePct: number;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`API error ${res.status} ${res.statusText}: ${url}`);
  return res.json() as Promise<T>;
}

async function getHodlmmPools(): Promise<HodlmmPoolInfo[]> {
  const data = await fetchJson<HodlmmPoolsResponse>(
    `${HODLMM_API_BASE}/api/quotes/v1/pools`
  );
  return data.pools ?? [];
}

async function getHodlmmPool(poolId: string): Promise<HodlmmPoolInfo> {
  const pools = await getHodlmmPools();
  const pool = pools.find((p) => p.pool_id === poolId);
  if (!pool) throw new Error(`Pool not found: ${poolId}. Run doctor to list valid pool IDs.`);
  return pool;
}

async function getHodlmmPoolBins(poolId: string): Promise<HodlmmBinListResponse> {
  return fetchJson<HodlmmBinListResponse>(
    `${HODLMM_API_BASE}/api/quotes/v1/bins/${poolId}`
  );
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Price extraction
// ---------------------------------------------------------------------------

/**
 * Get the current price from the active bin's `price` field.
 * Falls back to reconstructing from bin_step and active_bin_id relative to bin 0.
 * Price in bins API is in token_y per token_x (microtoken/microtoken).
 */
function getCurrentPrice(
  bins: HodlmmBinData[],
  activeBinId: number,
  binStep: number
): number {
  // Try to find the active bin's price directly
  const activeBin = bins.find((b) => b.bin_id === activeBinId);
  if (activeBin?.price) {
    const p = Number(activeBin.price);
    if (p > 0) return p;
  }

  // Fallback: find the closest bin with a price and extrapolate
  const binsWithPrice = bins
    .filter((b) => b.price && Number(b.price) > 0)
    .sort((a, b) => Math.abs(a.bin_id - activeBinId) - Math.abs(b.bin_id - activeBinId));

  if (binsWithPrice.length === 0) throw new Error("No price data available in bins response.");

  const ref = binsWithPrice[0];
  const refPrice = Number(ref.price);
  const binDiff = activeBinId - ref.bin_id;
  // DLMM price grows geometrically: P(n) = P(0) * (1 + binStep/10000)^n
  const stepFactor = 1 + binStep / 10_000;
  return refPrice * Math.pow(stepFactor, binDiff);
}

// ---------------------------------------------------------------------------
// IL calculation
// ---------------------------------------------------------------------------

/**
 * Standard CPMM IL formula:
 *   IL = 2√r / (1 + r) - 1
 * where r = P_current / P_initial
 *
 * Returns IL as a negative percentage (e.g., -2.5 = 2.5% loss vs holding).
 */
function computeIL(initialPrice: number, currentPrice: number): number {
  if (initialPrice <= 0 || currentPrice <= 0) return 0;
  const r = currentPrice / initialPrice;
  const il = (2 * Math.sqrt(r)) / (1 + r) - 1;
  // il is negative (loss). Return as signed percentage.
  return parseFloat((il * 100).toFixed(4));
}

function ilSeverity(ilPct: number): ILSeverity {
  const abs = Math.abs(ilPct);
  if (abs < 0.5) return "negligible";
  if (abs < 2) return "minor";
  if (abs < 5) return "moderate";
  if (abs < 10) return "significant";
  return "severe";
}

function ilSignal(severity: ILSeverity): ILSignal {
  if (severity === "negligible" || severity === "minor" || severity === "moderate") return "HOLD";
  if (severity === "significant") return "EXIT consideration";
  return "EXIT recommended";
}

function signalReason(severity: ILSeverity, ilPct: number, breakEvenPct: number): string {
  const abs = Math.abs(ilPct).toFixed(2);
  const be = breakEvenPct.toFixed(2);
  if (severity === "negligible") return `IL is negligible (${abs}%). No action needed.`;
  if (severity === "minor") return `IL is minor (${abs}%). Continue holding; fees should offset with ${be}% yield.`;
  if (severity === "moderate") return `IL is moderate (${abs}%). Monitor closely; needs ${be}% fee yield to break even.`;
  if (severity === "significant") return `IL is significant (${abs}%). Consider exiting to limit further loss; needs ${be}% yield to break even.`;
  return `IL is severe (${abs}%). Exit recommended to stop loss; ${be}% fee yield needed to recover.`;
}

/**
 * Break-even fee percentage: the fee yield (as % of liquidity) needed to exactly offset IL.
 * This is just abs(ilPct) — the fees must equal the IL to net to zero.
 */
function breakEvenFee(ilPct: number): number {
  return parseFloat(Math.abs(ilPct).toFixed(4));
}

// ---------------------------------------------------------------------------
// Pool label
// ---------------------------------------------------------------------------
function poolLabel(pool: HodlmmPoolInfo): string {
  if (pool.pool_symbol) return pool.pool_symbol;
  const x = pool.token_x.split(".").pop() ?? "?";
  const y = pool.token_y.split(".").pop() ?? "?";
  return `${x}/${y}`;
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------
async function analyzePool(
  pool: HodlmmPoolInfo,
  customEntryPrice?: number
): Promise<ILResult> {
  const binsData = await getHodlmmPoolBins(pool.pool_id);
  const activeBinId = binsData.active_bin_id ?? pool.active_bin;

  const initialPrice = customEntryPrice ?? Number(pool.initial_price ?? 0);
  if (initialPrice <= 0) throw new Error(`Pool ${pool.pool_id} has no initial_price — provide --entry-price`);

  const currentPrice = getCurrentPrice(binsData.bins, activeBinId, pool.bin_step);
  const priceChangePct = parseFloat((((currentPrice - initialPrice) / initialPrice) * 100).toFixed(4));
  const ilPct = computeIL(initialPrice, currentPrice);
  const severity = ilSeverity(ilPct);
  const signal = ilSignal(severity);
  const beePct = breakEvenFee(ilPct);

  return {
    poolId: pool.pool_id,
    pair: poolLabel(pool),
    initialPrice,
    currentPrice,
    priceChangePct,
    ilPct,
    ilSeverity: severity,
    signal,
    signalReason: signalReason(severity, ilPct, beePct),
    breakEvenFeePct: beePct,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name("hodlmm-il-estimator")
  .description(
    "Estimates impermanent loss for HODLMM LP positions and signals HOLD or EXIT."
  );

// ── doctor ───────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check API connectivity and list HODLMM pools with price data")
  .action(async () => {
    try {
      const pools = await getHodlmmPools();
      const active = pools.filter((p) => p.active !== false);
      printJson({
        status: "success",
        action: "ready",
        data: {
          apiReachable: true,
          apiBase: HODLMM_API_BASE,
          totalPools: pools.length,
          activePools: active.length,
          pools: active.map((p) => ({
            id: p.pool_id,
            pair: poolLabel(p),
            activeBin: p.active_bin,
            initialPrice: p.initial_price ?? null,
            hasInitialPrice: !!p.initial_price,
          })),
        },
        error: null,
      });
    } catch (err) {
      handleError(err);
    }
  });

// ── estimate-il ──────────────────────────────────────────────────────────────
program
  .command("estimate-il")
  .description("Estimate IL for a specific HODLMM pool since inception (or custom entry)")
  .requiredOption("--pool-id <poolId>", "HODLMM pool ID (e.g. dlmm_1)")
  .option("--entry-price <price>", "Custom entry price (overrides initial_price)")
  .action(async (opts: { poolId: string; entryPrice?: string }) => {
    try {
      const pool = await getHodlmmPool(opts.poolId);
      const entryPrice = opts.entryPrice ? Number(opts.entryPrice) : undefined;
      const result = await analyzePool(pool, entryPrice);

      printJson({
        status: "success",
        action: result.signal,
        data: result,
        error: null,
      });
    } catch (err) {
      handleError(err);
    }
  });

// ── scan-il ──────────────────────────────────────────────────────────────────
program
  .command("scan-il")
  .description("Scan all active HODLMM pools and rank by IL exposure")
  .option("--limit <number>", "Max pools to scan", "8")
  .action(async (opts: { limit: string }) => {
    try {
      const limit = parseInt(opts.limit, 10) || 8;
      const pools = await getHodlmmPools();
      const targets = pools.filter((p) => p.active !== false && p.initial_price).slice(0, limit);

      const results: ILResult[] = [];
      for (const pool of targets) {
        try {
          results.push(await analyzePool(pool));
        } catch {
          // skip pools with errors
        }
      }

      // Sort by worst IL first
      results.sort((a, b) => a.ilPct - b.ilPct);
      const worst = results[0] ?? null;

      printJson({
        status: "success",
        action: worst?.signal ?? "HOLD",
        data: {
          scannedPools: results.length,
          worstPool: worst ? { poolId: worst.poolId, pair: worst.pair, ilPct: worst.ilPct, signal: worst.signal } : null,
          pools: results.map((r) => ({
            poolId: r.poolId,
            pair: r.pair,
            ilPct: r.ilPct,
            ilSeverity: r.ilSeverity,
            signal: r.signal,
            priceChangePct: r.priceChangePct,
          })),
        },
        error: null,
      });
    } catch (err) {
      handleError(err);
    }
  });

// ── break-even ───────────────────────────────────────────────────────────────
program
  .command("break-even")
  .description("Calculate fee yield needed to offset current IL, factoring in fees already earned")
  .requiredOption("--pool-id <poolId>", "HODLMM pool ID")
  .option("--fee-earned-pct <pct>", "Fee yield already earned as % of liquidity (default: 0)")
  .option("--entry-price <price>", "Custom entry price (overrides initial_price)")
  .action(async (opts: { poolId: string; feeEarnedPct?: string; entryPrice?: string }) => {
    try {
      const pool = await getHodlmmPool(opts.poolId);
      const entryPrice = opts.entryPrice ? Number(opts.entryPrice) : undefined;
      const feeEarned = opts.feeEarnedPct ? parseFloat(opts.feeEarnedPct) : 0;
      const result = await analyzePool(pool, entryPrice);

      const remainingIL = Math.max(0, Math.abs(result.ilPct) - feeEarned);
      const isBreakEven = feeEarned >= Math.abs(result.ilPct);

      printJson({
        status: "success",
        action: isBreakEven ? "HOLD" : result.signal,
        data: {
          poolId: result.poolId,
          pair: result.pair,
          ilPct: result.ilPct,
          ilSeverity: result.ilSeverity,
          feeEarnedPct: feeEarned,
          breakEvenFeePct: result.breakEvenFeePct,
          remainingToBreakEven: parseFloat(remainingIL.toFixed(4)),
          isBreakEven,
          netPnlPct: parseFloat((feeEarned + result.ilPct).toFixed(4)),
          signal: isBreakEven ? "HOLD" : result.signal,
          recommendation: isBreakEven
            ? `Fees (${feeEarned}%) have offset IL (${Math.abs(result.ilPct).toFixed(2)}%). Net positive — hold position.`
            : `Need ${remainingIL.toFixed(2)}% more fee yield to break even. Current net P&L: ${(feeEarned + result.ilPct).toFixed(2)}%.`,
        },
        error: null,
      });
    } catch (err) {
      handleError(err);
    }
  });

program.parse();
