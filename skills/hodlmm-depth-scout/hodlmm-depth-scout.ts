#!/usr/bin/env bun
/**
 * hodlmm-depth-scout — Liquidity depth analyzer for Bitflow HODLMM pools
 *
 * Analyzes bin liquidity distribution to determine execution depth, one-sided
 * concentration, and estimated price impact for autonomous LP and trading agents.
 *
 * Self-contained: uses Bitflow HODLMM API directly, no external deps beyond commander.
 * HODLMM bonus eligible: reads live HODLMM pool bins and active bin state.
 *
 * Usage: bun run skills/hodlmm-depth-scout/hodlmm-depth-scout.ts <subcommand> [options]
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
}

interface HodlmmPoolInfo {
  pool_id: string;
  active_bin: number;
  bin_step: number;
  token_x: string;
  token_y: string;
  pool_symbol?: string;
  active?: boolean;
}

interface HodlmmBinListResponse {
  active_bin_id?: number;
  bins: HodlmmBinData[];
}

interface HodlmmPoolsResponse {
  pools: HodlmmPoolInfo[];
}

type DepthSignal = "SHALLOW" | "MODERATE" | "DEEP";
type ConcentrationLabel = "single-sided-x" | "single-sided-y" | "balanced";

interface DepthResult {
  poolId: string;
  pair: string;
  activeBinId: number;
  currentPrice: number;
  binsWithLiquidity: number;
  binsAbove: number;
  binsBelow: number;
  totalReserveX: bigint;
  totalReserveY: bigint;
  nearDepthBins: number;
  depthSignal: DepthSignal;
  concentration: ConcentrationLabel;
  concentrationNote: string;
  depthScore: number;
}

interface SwapImpactResult {
  poolId: string;
  pair: string;
  side: "buy" | "sell";
  inputAmount: number;
  binsConsumed: number;
  binsRemaining: number;
  priceMovePercent: number;
  avgExecutionPrice: number;
  startPrice: number;
  endPrice: number;
  fillable: boolean;
  impactSignal: "LOW" | "MEDIUM" | "HIGH" | "UNFILLABLE";
  impactNote: string;
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
// Helpers
// ---------------------------------------------------------------------------
function poolLabel(pool: HodlmmPoolInfo): string {
  if (pool.pool_symbol) return pool.pool_symbol;
  const x = pool.token_x.split(".").pop() ?? "?";
  const y = pool.token_y.split(".").pop() ?? "?";
  return `${x}/${y}`;
}

function getActiveBinPrice(
  bins: HodlmmBinData[],
  activeBinId: number,
  binStep: number
): number {
  const activeBin = bins.find((b) => b.bin_id === activeBinId);
  if (activeBin?.price) {
    const p = Number(activeBin.price);
    if (p > 0) return p;
  }
  const binsWithPrice = bins
    .filter((b) => b.price && Number(b.price) > 0)
    .sort((a, b) => Math.abs(a.bin_id - activeBinId) - Math.abs(b.bin_id - activeBinId));
  if (binsWithPrice.length === 0) throw new Error("No price data in bins response.");
  const ref = binsWithPrice[0];
  const binDiff = activeBinId - ref.bin_id;
  return Number(ref.price) * Math.pow(1 + binStep / 10_000, binDiff);
}

// ---------------------------------------------------------------------------
// Depth scoring
// ---------------------------------------------------------------------------
/**
 * Score 0-100 based on:
 * - 50 pts: total bins with liquidity (max at 200 bins)
 * - 30 pts: near-depth bins within ±25 bins of active (max at 25 bins each side)
 * - 20 pts: dual-sided vs single-sided
 */
function computeDepthScore(
  binsWithLiquidity: number,
  nearDepthBins: number,
  binsAbove: number,
  binsBelow: number
): number {
  const totalScore = Math.min(50, (binsWithLiquidity / 200) * 50);
  const nearScore = Math.min(30, (nearDepthBins / 50) * 30);
  const balanceScore = binsAbove > 0 && binsBelow > 0 ? 20 : 0;
  return parseFloat((totalScore + nearScore + balanceScore).toFixed(1));
}

function depthSignal(score: number): DepthSignal {
  if (score >= 60) return "DEEP";
  if (score >= 30) return "MODERATE";
  return "SHALLOW";
}

function concentrationLabel(
  binsAbove: number,
  binsBelow: number,
  totalX: bigint,
  totalY: bigint
): ConcentrationLabel {
  const hasBothSides = binsAbove > 0 && binsBelow > 0;
  if (!hasBothSides) {
    return binsAbove > 0 ? "single-sided-x" : "single-sided-y";
  }
  const xVal = Number(totalX);
  const yVal = Number(totalY);
  if (xVal === 0 || yVal === 0) return binsAbove > 0 ? "single-sided-x" : "single-sided-y";
  const ratio = xVal / (xVal + yVal);
  if (ratio > 0.8) return "single-sided-x";
  if (ratio < 0.2) return "single-sided-y";
  return "balanced";
}

function concentrationNote(label: ConcentrationLabel): string {
  if (label === "balanced") return "Liquidity is balanced across both tokens.";
  if (label === "single-sided-x")
    return "Pool is primarily token_x (price has risen above entry — LPs converted to base token).";
  return "Pool is primarily token_y (price has fallen below entry — LPs converted to quote token).";
}

// ---------------------------------------------------------------------------
// Core depth analysis
// ---------------------------------------------------------------------------
async function analyzeDepth(pool: HodlmmPoolInfo, nearWindow = 25): Promise<DepthResult> {
  const binsData = await getHodlmmPoolBins(pool.pool_id);
  const activeBinId = binsData.active_bin_id ?? pool.active_bin;
  const currentPrice = getActiveBinPrice(binsData.bins, activeBinId, pool.bin_step);
  const pair = poolLabel(pool);

  const liqBins = binsData.bins.filter(
    (b) => b.reserve_x !== "0" || b.reserve_y !== "0"
  );

  const binsAbove = liqBins.filter((b) => b.bin_id > activeBinId).length;
  const binsBelow = liqBins.filter((b) => b.bin_id < activeBinId).length;
  const nearBins = liqBins.filter((b) => Math.abs(b.bin_id - activeBinId) <= nearWindow);

  const totalReserveX = liqBins.reduce((acc, b) => acc + BigInt(b.reserve_x || "0"), 0n);
  const totalReserveY = liqBins.reduce((acc, b) => acc + BigInt(b.reserve_y || "0"), 0n);

  const score = computeDepthScore(liqBins.length, nearBins.length, binsAbove, binsBelow);
  const signal = depthSignal(score);
  const concLabel = concentrationLabel(binsAbove, binsBelow, totalReserveX, totalReserveY);
  const concNote = concentrationNote(concLabel);

  return {
    poolId: pool.pool_id,
    pair,
    activeBinId,
    currentPrice,
    binsWithLiquidity: liqBins.length,
    binsAbove,
    binsBelow,
    totalReserveX,
    totalReserveY,
    nearDepthBins: nearBins.length,
    depthSignal: signal,
    concentration: concLabel,
    concentrationNote: concNote,
    depthScore: score,
  };
}

// ---------------------------------------------------------------------------
// Swap impact simulation
// ---------------------------------------------------------------------------
/**
 * Walk bins in the swap direction to estimate price impact.
 * buy = price goes up → consume bins above active (reserve_x bins)
 * sell = price goes down → consume bins below active (reserve_y bins)
 *
 * inputAmount is in the smallest unit of the input token.
 */
async function simulateSwapImpact(
  pool: HodlmmPoolInfo,
  side: "buy" | "sell",
  inputAmount: number
): Promise<SwapImpactResult> {
  const binsData = await getHodlmmPoolBins(pool.pool_id);
  const activeBinId = binsData.active_bin_id ?? pool.active_bin;
  const currentPrice = getActiveBinPrice(binsData.bins, activeBinId, pool.bin_step);
  const pair = poolLabel(pool);

  // Get relevant bins sorted in direction of swap
  const liqBins = binsData.bins.filter((b) =>
    side === "buy"
      ? b.bin_id >= activeBinId && b.reserve_x !== "0"
      : b.bin_id <= activeBinId && b.reserve_y !== "0"
  );

  if (side === "buy") {
    liqBins.sort((a, b) => a.bin_id - b.bin_id);
  } else {
    liqBins.sort((a, b) => b.bin_id - a.bin_id);
  }

  let remaining = inputAmount;
  let binsConsumed = 0;
  let lastBinId = activeBinId;
  let totalOutput = 0;
  let totalInput = 0;

  for (const bin of liqBins) {
    const binPrice = Number(bin.price ?? 0);
    if (binPrice <= 0) continue;
    const binReserve = side === "buy" ? Number(bin.reserve_x) : Number(bin.reserve_y);
    if (binReserve <= 0) continue;

    // In a DLMM bin: buy uses reserve_x, sell uses reserve_y
    // Cost to empty this bin in input token units
    const costToEmpty = side === "buy"
      ? binReserve * binPrice  // buying x: pay y per unit of x
      : binReserve / binPrice; // selling x: receive y per unit of x

    if (remaining >= costToEmpty) {
      remaining -= costToEmpty;
      totalInput += costToEmpty;
      totalOutput += binReserve;
      binsConsumed++;
      lastBinId = bin.bin_id;
    } else {
      // Partially fill this bin
      const partialOutput = side === "buy"
        ? remaining / binPrice
        : remaining * binPrice;
      totalOutput += partialOutput;
      totalInput += remaining;
      remaining = 0;
      lastBinId = bin.bin_id;
      break;
    }
  }

  const fillable = remaining <= 0;
  const endPrice = getActiveBinPrice(binsData.bins, lastBinId, pool.bin_step);
  const priceMovePercent = parseFloat(
    (((endPrice - currentPrice) / currentPrice) * 100).toFixed(4)
  );
  const avgExecutionPrice =
    totalOutput > 0 ? parseFloat((totalInput / totalOutput).toFixed(6)) : 0;

  const absPriceMoveAbs = Math.abs(priceMovePercent);
  const impactSignal =
    !fillable ? "UNFILLABLE"
    : absPriceMoveAbs > 5 ? "HIGH"
    : absPriceMoveAbs > 1 ? "MEDIUM"
    : "LOW";

  const impactNote =
    !fillable
      ? `Insufficient depth to fill ${inputAmount} — pool only has ${binsConsumed} bins of ${side} liquidity.`
      : `${side.toUpperCase()} of ${inputAmount} consumes ${binsConsumed} bin(s), moving price ${Math.abs(priceMovePercent).toFixed(2)}% (${impactSignal}).`;

  return {
    poolId: pool.pool_id,
    pair,
    side,
    inputAmount,
    binsConsumed,
    binsRemaining: liqBins.length - binsConsumed,
    priceMovePercent,
    avgExecutionPrice,
    startPrice: currentPrice,
    endPrice,
    fillable,
    impactSignal,
    impactNote,
  };
}

// ---------------------------------------------------------------------------
// JSON serializer (BigInt-safe)
// ---------------------------------------------------------------------------
function safeJson(data: unknown): string {
  return JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name("hodlmm-depth-scout")
  .description(
    "Analyzes HODLMM pool liquidity depth, bin concentration, and swap price impact."
  );

// ── doctor ───────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check API connectivity and list HODLMM pools")
  .action(async () => {
    try {
      const pools = await getHodlmmPools();
      const active = pools.filter((p) => p.active !== false);
      console.log(safeJson({
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
            binStep: p.bin_step,
          })),
        },
        error: null,
      }));
    } catch (err) {
      handleError(err);
    }
  });

// ── depth-check ──────────────────────────────────────────────────────────────
program
  .command("depth-check")
  .description("Analyze liquidity depth distribution for a pool")
  .requiredOption("--pool-id <poolId>", "HODLMM pool ID (e.g. dlmm_2)")
  .option("--near-window <bins>", "Bins to consider as 'near' the active bin", "25")
  .action(async (opts: { poolId: string; nearWindow: string }) => {
    try {
      const pool = await getHodlmmPool(opts.poolId);
      const nearWindow = parseInt(opts.nearWindow, 10) || 25;
      const result = await analyzeDepth(pool, nearWindow);

      console.log(safeJson({
        status: "success",
        action: result.depthSignal,
        data: {
          poolId: result.poolId,
          pair: result.pair,
          activeBinId: result.activeBinId,
          currentPrice: result.currentPrice,
          binsWithLiquidity: result.binsWithLiquidity,
          binsAboveActive: result.binsAbove,
          binsBelowActive: result.binsBelow,
          nearDepthBins: result.nearDepthBins,
          nearWindowBins: nearWindow,
          totalReserveX: result.totalReserveX.toString(),
          totalReserveY: result.totalReserveY.toString(),
          depthScore: result.depthScore,
          depthSignal: result.depthSignal,
          concentration: result.concentration,
          concentrationNote: result.concentrationNote,
        },
        error: null,
      }));
    } catch (err) {
      handleError(err);
    }
  });

// ── swap-impact ───────────────────────────────────────────────────────────────
program
  .command("swap-impact")
  .description("Estimate price impact for a swap of given size through bin liquidity")
  .requiredOption("--pool-id <poolId>", "HODLMM pool ID")
  .requiredOption(
    "--side <side>",
    "Swap direction: buy (token_x, price rises) or sell (token_x, price falls)"
  )
  .requiredOption("--amount <amount>", "Input amount in smallest token units")
  .action(async (opts: { poolId: string; side: string; amount: string }) => {
    try {
      const side = opts.side.toLowerCase() as "buy" | "sell";
      if (side !== "buy" && side !== "sell")
        throw new Error("--side must be 'buy' or 'sell'");
      const pool = await getHodlmmPool(opts.poolId);
      const amount = parseFloat(opts.amount);
      if (isNaN(amount) || amount <= 0) throw new Error("--amount must be a positive number");
      const result = await simulateSwapImpact(pool, side, amount);

      console.log(safeJson({
        status: "success",
        action: result.impactSignal,
        data: result,
        error: null,
      }));
    } catch (err) {
      handleError(err);
    }
  });

// ── scan-depth ────────────────────────────────────────────────────────────────
program
  .command("scan-depth")
  .description("Scan all active pools and rank by liquidity depth score")
  .option("--limit <number>", "Max pools to scan", "8")
  .action(async (opts: { limit: string }) => {
    try {
      const limit = parseInt(opts.limit, 10) || 8;
      const pools = await getHodlmmPools();
      const targets = pools.filter((p) => p.active !== false).slice(0, limit);

      const results: DepthResult[] = [];
      for (const pool of targets) {
        try {
          results.push(await analyzeDepth(pool));
        } catch {
          // skip pools with errors
        }
      }

      results.sort((a, b) => b.depthScore - a.depthScore);
      const deepest = results[0] ?? null;

      console.log(safeJson({
        status: "success",
        action: deepest?.depthSignal ?? "SHALLOW",
        data: {
          scannedPools: results.length,
          skippedPools: targets.length - results.length,
          deepestPool: deepest
            ? {
                poolId: deepest.poolId,
                pair: deepest.pair,
                depthScore: deepest.depthScore,
                depthSignal: deepest.depthSignal,
              }
            : null,
          pools: results.map((r) => ({
            poolId: r.poolId,
            pair: r.pair,
            depthScore: r.depthScore,
            depthSignal: r.depthSignal,
            concentration: r.concentration,
            binsWithLiquidity: r.binsWithLiquidity,
            binsAboveActive: r.binsAbove,
            binsBelowActive: r.binsBelow,
          })),
        },
        error: null,
      }));
    } catch (err) {
      handleError(err);
    }
  });

program.parse();
