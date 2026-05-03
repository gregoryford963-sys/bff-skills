#!/usr/bin/env bun
/**
 * stx-to-sbtc-normalizer — Convert idle STX to sBTC via Bitflow swap
 *
 * Entry-leg normalizer for yield strategies: detects idle STX, gets a live
 * Bitflow quote, and on --confirm executes the swap with PostConditionMode.Deny.
 *
 * This is the DCA leg left out of scope by sbtc-yield-maximizer (aibtcdev/skills#322).
 *
 * Usage:
 *   bun run skills/stx-to-sbtc-normalizer/stx-to-sbtc-normalizer.ts doctor
 *   bun run skills/stx-to-sbtc-normalizer/stx-to-sbtc-normalizer.ts status
 *   bun run skills/stx-to-sbtc-normalizer/stx-to-sbtc-normalizer.ts run --amount 10
 *   bun run skills/stx-to-sbtc-normalizer/stx-to-sbtc-normalizer.ts run --amount 10 --confirm
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Constants ────────────────────────────────────────────────────────────────

const STACKS_API       = "https://api.hiro.so";
const EXPLORER_BASE    = "https://explorer.hiro.so/txid";
const BITFLOW_API_HOST = process.env.BITFLOW_API_HOST || "https://api.bitflowapis.finance";
const WALLETS_FILE     = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR      = path.join(os.homedir(), ".aibtc", "wallets");

const STX_DECIMALS     = 6;
const SBTC_DECIMALS    = 8;

const GAS_RESERVE_STX  = 1;       // always keep 1 STX for gas
const MAX_SLIPPAGE_PCT = 10;       // hard cap
const MAX_PRICE_IMPACT = 0.05;     // 5% price impact gate
const QUOTE_MAX_AGE_MS = 30_000;   // 30s staleness gate
const TX_FEE_USTX      = 50_000n;  // 0.05 STX — sufficient for multi-hop Bitflow routes

// ─── Output helpers ───────────────────────────────────────────────────────────

function out(status: string, action: string, data: unknown, error: unknown = null): void {
  console.log(JSON.stringify({ status, action, data, error }, null, 2));
}

function success(action: string, data: unknown): void {
  out("success", action, data);
}

function blocked(action: string, data: unknown): void {
  out("blocked", action, data);
}

function fail(code: string, message: string, next = ""): void {
  out("error", code, null, { code, message, next });
  process.exit(1);
}

// ─── Bitflow SDK ──────────────────────────────────────────────────────────────

async function getBitflow(): Promise<any> {
  const { BitflowSDK } = await import("@bitflowlabs/core-sdk" as any);
  return new BitflowSDK({
    BITFLOW_API_HOST,
    BITFLOW_API_KEY: process.env.BITFLOW_API_KEY || "",
    READONLY_CALL_API_HOST: process.env.READONLY_CALL_API_HOST || "https://api.mainnet.hiro.so",
    READONLY_CALL_API_KEY: "",
    KEEPER_API_HOST: BITFLOW_API_HOST,
    KEEPER_API_URL: BITFLOW_API_HOST,
    KEEPER_API_KEY: "",
    BITFLOW_PROVIDER_ADDRESS: "",
  });
}

async function resolveTokenIds(sdk: any): Promise<{ stxId: string; sbtcId: string } | null> {
  const tokens: any[] = await sdk.getAvailableTokens();
  const stxToken  = tokens.find((t: any) =>
    (t.symbol ?? "").toUpperCase() === "STX" ||
    (t.tokenId ?? t["token-id"] ?? "").includes("token-stx")
  );
  const sbtcToken = tokens.find((t: any) =>
    (t.symbol ?? "").toUpperCase() === "SBTC" ||
    (t.symbol ?? "").toUpperCase() === "WBTC" ||
    (t.tokenId ?? t["token-id"] ?? "").includes("wrapped-bitcoin") ||
    (t.tokenId ?? t["token-id"] ?? "").includes("sbtc")
  );
  if (!stxToken || !sbtcToken) return null;
  return {
    stxId:  stxToken.tokenId  ?? stxToken["token-id"],
    sbtcId: sbtcToken.tokenId ?? sbtcToken["token-id"],
  };
}

interface QuoteResult {
  expectedSbtcHuman: number;
  expectedSbtcSats: number;
  priceImpact: number;
  route: any;
  fetchedAt: number;
}

async function fetchQuote(
  sdk: any,
  stxId: string,
  sbtcId: string,
  amountStx: number
): Promise<QuoteResult | null> {
  try {
    const result = await sdk.getQuoteForRoute(stxId, sbtcId, amountStx);
    if (!result?.bestRoute?.quote) return null;
    const expectedHuman = result.bestRoute.quote as number;
    return {
      expectedSbtcHuman: expectedHuman,
      expectedSbtcSats: Math.floor(expectedHuman * 1e8),
      priceImpact: result.bestRoute.priceImpact ?? 0,
      route: result.bestRoute.route,
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

// ─── Wallet helpers ───────────────────────────────────────────────────────────

async function decryptAibtcKeystore(enc: any, password: string): Promise<string> {
  const { scryptSync, createDecipheriv } = await import("crypto" as any);
  const { N, r, p, keyLen } = enc.scryptParams;
  const salt       = Buffer.from(enc.salt,       "base64");
  const iv         = Buffer.from(enc.iv,         "base64");
  const authTag    = Buffer.from(enc.authTag,    "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const key        = scryptSync(password, salt, keyLen ?? 32, { N, r, p });
  const decipher   = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted  = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8").trim();
}

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  // 1. Direct env var (automation / smoke tests)
  const directKey = process.env.CLIENT_PRIVATE_KEY || process.env.STACKS_PRIVATE_KEY;
  if (directKey) {
    const { getAddressFromPrivateKey } = await import("@stacks/transactions" as any);
    const address = getAddressFromPrivateKey(directKey, "mainnet");
    return { stxPrivateKey: directKey, stxAddress: address };
  }

  // 2. AIBTC wallets.json + keystore.json
  if (fs.existsSync(WALLETS_FILE)) {
    try {
      const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk" as any);
      const walletsJson  = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
      const activeWallet = (walletsJson.wallets ?? [])[0];
      if (activeWallet?.id) {
        const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
        if (fs.existsSync(keystorePath)) {
          const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
          const enc = keystore.encrypted;
          if (enc?.ciphertext) {
            const mnemonic = await decryptAibtcKeystore(enc, password);
            const wallet   = await generateWallet({ secretKey: mnemonic, password: "" });
            const account  = wallet.accounts[0] ?? deriveAccount(wallet, 0);
            return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
          }
          const legacyEnc = keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
          if (legacyEnc) {
            const { decryptMnemonic } = await import("@stacks/encryption" as any);
            const mnemonic = await decryptMnemonic(legacyEnc, password);
            const wallet   = await generateWallet({ secretKey: mnemonic, password: "" });
            const account  = wallet.accounts[0] ?? deriveAccount(wallet, 0);
            return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
          }
        }
      }
    } catch (e: any) {
      process.stderr.write(`Wallet decrypt error: ${e.message}\n`);
    }
  }

  throw new Error(
    "No wallet found. Set CLIENT_PRIVATE_KEY or STACKS_PRIVATE_KEY env var, " +
    "or ensure AIBTC wallet file exists with password."
  );
}

// ─── Balance helpers ──────────────────────────────────────────────────────────

async function getStxBalanceMicro(address: string): Promise<number> {
  const res = await fetch(`${STACKS_API}/v2/accounts/${address}?proof=0`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`STX balance fetch failed: ${res.status}`);
  const data = await res.json() as { balance: string };
  return parseInt(data.balance, 16);
}

async function getSbtcBalanceSats(address: string): Promise<number> {
  const contractId = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
  const url = `${STACKS_API}/extended/v1/address/${address}/balances`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return 0;
  const data = await res.json() as any;
  const ftEntry = data.fungible_tokens?.[`${contractId}::sbtc-token`];
  return ftEntry?.balance ? parseInt(ftEntry.balance) : 0;
}

async function getMempoolDepth(address: string): Promise<number> {
  const res = await fetch(
    `${STACKS_API}/extended/v1/tx/mempool?sender_address=${address}&limit=1`,
    { signal: AbortSignal.timeout(6000) }
  );
  if (!res.ok) return 0;
  const data = await res.json() as any;
  return data.total ?? 0;
}

// ─── Core commands ────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, { ok: boolean; message: string }> = {};

  // 1. Wallet key
  const directKey = process.env.CLIENT_PRIVATE_KEY || process.env.STACKS_PRIVATE_KEY;
  checks.wallet = directKey
    ? { ok: true, message: "CLIENT_PRIVATE_KEY / STACKS_PRIVATE_KEY env var present" }
    : fs.existsSync(WALLETS_FILE)
      ? { ok: true, message: "AIBTC wallet file found (password required for run)" }
      : { ok: false, message: "No wallet key found — set CLIENT_PRIVATE_KEY env var" };

  // 2. STX balance (if address derivable without password)
  if (directKey) {
    try {
      const { getAddressFromPrivateKey } = await import("@stacks/transactions" as any);
      const address = getAddressFromPrivateKey(directKey, "mainnet");
      const microStx = await getStxBalanceMicro(address);
      const stx = microStx / 1e6;
      checks.balance = stx > GAS_RESERVE_STX + 1
        ? { ok: true, message: `${stx.toFixed(2)} STX available (reserve: ${GAS_RESERVE_STX} STX)` }
        : { ok: false, message: `Only ${stx.toFixed(2)} STX — below minimum (${GAS_RESERVE_STX + 1} STX needed)` };
    } catch (e: any) {
      checks.balance = { ok: false, message: `Balance check failed: ${e.message}` };
    }
  } else {
    checks.balance = { ok: true, message: "Balance check requires wallet password — run status after unlock" };
  }

  // 3. Bitflow API
  try {
    const sdk = await getBitflow();
    const tokens: any[] = await sdk.getAvailableTokens();
    const ids = await resolveTokenIds(sdk);
    if (!ids) {
      checks.bitflow = { ok: false, message: "STX or sBTC token not found in Bitflow token list" };
    } else {
      const quote = await fetchQuote(sdk, ids.stxId, ids.sbtcId, 1);
      checks.bitflow = quote
        ? { ok: true, message: `Bitflow reachable — STX→sBTC route active (${tokens.length} tokens)` }
        : { ok: false, message: "STX→sBTC route unavailable right now" };
    }
  } catch (e: any) {
    checks.bitflow = { ok: false, message: `Bitflow API error: ${e.message}` };
  }

  const allOk = Object.values(checks).every(c => c.ok);
  success("doctor", { ok: allOk, checks });
}

async function cmdStatus(opts: { walletPassword?: string }): Promise<void> {
  let walletKeys: { stxPrivateKey: string; stxAddress: string };
  try {
    walletKeys = await getWalletKeys(opts.walletPassword || process.env.AIBTC_WALLET_PASSWORD || "");
  } catch (e: any) {
    fail("NO_WALLET", e.message, "Set CLIENT_PRIVATE_KEY env var or provide --wallet-password");
    return;
  }
  const { stxAddress: address } = walletKeys;
  const microStx  = await getStxBalanceMicro(address);
  const stxTotal  = microStx / 1e6;
  const sbtcSats  = await getSbtcBalanceSats(address);
  const swappable = Math.max(0, stxTotal - GAS_RESERVE_STX);

  let quotePreview: any = null;
  if (swappable > 0) {
    const sdk  = await getBitflow();
    const ids  = await resolveTokenIds(sdk);
    if (ids) {
      const q = await fetchQuote(sdk, ids.stxId, ids.sbtcId, swappable);
      if (q) {
        quotePreview = {
          amountInStx: swappable,
          expectedSbtcSats: q.expectedSbtcSats,
          priceImpactPct: (q.priceImpact * 100).toFixed(3),
        };
      }
    }
  }

  success("status", {
    address,
    stxBalance: stxTotal,
    sbtcBalanceSats: sbtcSats,
    swappableStx: swappable,
    gasReserveStx: GAS_RESERVE_STX,
    quotePreview,
  });
}

async function cmdRun(opts: {
  amount?: string;
  slippage?: string;
  confirm?: boolean;
  walletPassword?: string;
}): Promise<void> {
  const password = opts.walletPassword || process.env.AIBTC_WALLET_PASSWORD || "";
  const slippage = Math.min(parseFloat(opts.slippage ?? "3"), MAX_SLIPPAGE_PCT);

  // Resolve wallet
  let walletKeys: { stxPrivateKey: string; stxAddress: string };
  try {
    walletKeys = await getWalletKeys(password);
  } catch (e: any) {
    fail("NO_WALLET", e.message, "Set CLIENT_PRIVATE_KEY env var or provide --wallet-password");
    return;
  }

  const { stxPrivateKey, stxAddress } = walletKeys;

  // Check mempool depth
  const pending = await getMempoolDepth(stxAddress);
  if (pending > 0) {
    fail("PENDING_TX", `${pending} tx(s) pending in mempool for this address — wait for confirmation`, "retry next cycle");
    return;
  }

  // Get balance
  const microStx = await getStxBalanceMicro(stxAddress);
  const stxTotal = microStx / 1e6;
  const maxSwap  = Math.max(0, stxTotal - GAS_RESERVE_STX);

  const amountStx = opts.amount ? parseFloat(opts.amount) : maxSwap;

  if (amountStx <= 0 || maxSwap <= 0) {
    fail("INSUFFICIENT_STX", `Swappable STX: ${maxSwap.toFixed(2)} (balance: ${stxTotal.toFixed(2)}, reserve: ${GAS_RESERVE_STX})`, "top up wallet");
    return;
  }
  if (amountStx > maxSwap) {
    fail("INSUFFICIENT_STX", `Requested ${amountStx} STX but only ${maxSwap.toFixed(2)} available after gas reserve`, "reduce --amount");
    return;
  }

  // Get Bitflow quote
  const sdk = await getBitflow();
  const ids = await resolveTokenIds(sdk);
  if (!ids) {
    fail("NO_ROUTE", "STX or sBTC token not found in Bitflow token list", "check Bitflow API");
    return;
  }

  const quote = await fetchQuote(sdk, ids.stxId, ids.sbtcId, amountStx);
  if (!quote) {
    fail("NO_ROUTE", `No Bitflow route for STX→sBTC at amount ${amountStx}`, "try smaller amount");
    return;
  }

  if (quote.priceImpact > MAX_PRICE_IMPACT) {
    fail(
      "HIGH_PRICE_IMPACT",
      `Price impact ${(quote.priceImpact * 100).toFixed(2)}% exceeds ${(MAX_PRICE_IMPACT * 100).toFixed(0)}% gate`,
      "reduce --amount to lower price impact"
    );
    return;
  }

  // Preview mode (no --confirm)
  if (!opts.confirm) {
    blocked("add_--confirm_to_execute", {
      amountInStx: amountStx,
      expectedSbtcSats: quote.expectedSbtcSats,
      expectedSbtcHuman: quote.expectedSbtcHuman,
      priceImpactPct: (quote.priceImpact * 100).toFixed(3),
      slippagePct: slippage,
      quoteAgeMs: Date.now() - quote.fetchedAt,
      note: "No funds moved. Add --confirm to execute.",
    });
    return;
  }

  // Staleness check before broadcast
  const quoteAge = Date.now() - quote.fetchedAt;
  if (quoteAge > QUOTE_MAX_AGE_MS) {
    fail("STALE_QUOTE", `Quote is ${quoteAge}ms old (max ${QUOTE_MAX_AGE_MS}ms) — re-run to refresh`, "re-run without --confirm first");
    return;
  }

  // Execute swap
  const {
    makeContractCall, broadcastTransaction,
    AnchorMode, PostConditionMode,
  } = await import("@stacks/transactions" as any);
  const { STACKS_MAINNET } = await import("@stacks/network" as any);

  const slippageDecimal = slippage / 100;
  const swapParams = await sdk.prepareSwap(
    { route: quote.route, amount: amountStx, tokenXDecimals: STX_DECIMALS, tokenYDecimals: SBTC_DECIMALS },
    stxAddress,
    slippageDecimal
  );

  const tx = await makeContractCall({
    contractAddress: swapParams.contractAddress,
    contractName:    swapParams.contractName,
    functionName:    swapParams.functionName,
    functionArgs:    swapParams.functionArgs,
    postConditions:  swapParams.postConditions,
    postConditionMode: PostConditionMode.Deny,
    network:         STACKS_MAINNET,
    senderKey:       stxPrivateKey,
    anchorMode:      AnchorMode.Any,
    fee:             TX_FEE_USTX,
  });

  const broadcastRes = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ((broadcastRes as any).error) {
    fail("BROADCAST_ERROR", `Broadcast failed: ${(broadcastRes as any).error} — ${(broadcastRes as any).reason ?? ""}`, "check Stacks node status");
    return;
  }

  const txId: string = (broadcastRes as any).txid;
  success("swap_executed", {
    amountInStx: amountStx,
    expectedSbtcSats: quote.expectedSbtcSats,
    txId,
    explorerUrl: `${EXPLORER_BASE}/${txId}?chain=mainnet`,
    quote: {
      expectedSbtcSats: quote.expectedSbtcSats,
      priceImpactPct: (quote.priceImpact * 100).toFixed(3),
      slippagePct: slippage,
    },
    note: "Tx broadcast. Verify tx_status:success before treating sBTC as spendable.",
  });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("stx-to-sbtc-normalizer")
  .description("Convert idle STX to sBTC via Bitflow swap — entry-leg normalizer for yield strategies");

program
  .command("doctor")
  .description("Check wallet readiness, STX balance, and Bitflow route availability")
  .action(async () => {
    try { await cmdDoctor(); }
    catch (e: any) { fail("DOCTOR_ERROR", e.message, "check environment"); }
  });

program
  .command("status")
  .description("Show current STX/sBTC balances and swap quote preview")
  .option("--wallet-password <pw>", "Wallet decrypt password — prefer AIBTC_WALLET_PASSWORD env var")
  .action(async (opts) => {
    try { await cmdStatus(opts); }
    catch (e: any) { fail("STATUS_ERROR", e.message, "check environment"); }
  });

program
  .command("run")
  .description("Execute STX→sBTC swap via Bitflow (requires --confirm to broadcast)")
  .option("--amount <stx>", "STX amount to swap (default: all swappable STX after gas reserve)")
  .option("--slippage <pct>", "Slippage tolerance percent (default 3, max 10)", "3")
  .option("--confirm", "Required to broadcast — omit for quote preview only")
  .option("--wallet-password <pw>", "Wallet decrypt password — prefer AIBTC_WALLET_PASSWORD env var (CLI arg is visible in process list)")
  .action(async (opts) => {
    try { await cmdRun(opts); }
    catch (e: any) { fail("RUN_ERROR", e.message, "check environment and try again"); }
  });

program.parse();
