#!/usr/bin/env bun
/**
 * jingswap-stx-depositor — Direct on-chain JingSwap STX auction deposit
 *
 * Commands: status | deposit --amount <stx> [--dry-run] | cancel
 *
 * Calls deposit-stx(amount: uint) and cancel-stx-deposit() directly via
 * @stacks/transactions — no MCP relay required. Both write paths broadcast
 * on-chain from this process and return the confirmed txid.
 *
 * JingSwap runs blind batch auctions: STX depositors exchange for sBTC at a
 * Pyth oracle price settled at end of cycle. Deposits accepted during Phase 0.
 */

import { Command } from "commander";
import {
  makeContractCall,
  broadcastTransaction,
  uintCV,
  AnchorMode,
  PostConditionMode,
  Pc,
  getAddressFromPrivateKey,
  TransactionVersion,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

// ─── Constants ─────────────────────────────────────────────────────────────────
const JING_ADDR        = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const JING_CONTRACT    = "sbtc-stx-jing-v2";
const HIRO_API         = "https://api.hiro.so";
const EXPLORER_BASE    = "https://explorer.hiro.so/txid";
const TX_FEE_USTX      = 3_000;
const GAS_RESERVE_STX  = 1;
const PER_OP_CAP_STX   = 5_000;  // max STX per single deposit
const DAILY_CAP_STX    = 20_000; // daily deposit ceiling

const CYCLE_PHASES: Record<number, string> = { 0: "deposit", 1: "buffer", 2: "settle" };

// ─── Output helpers ────────────────────────────────────────────────────────────
function out(status: string, action: string, data: unknown, error: unknown = null): void {
  console.log(JSON.stringify({ status, action, data, error }, null, 2));
}
function fail(code: string, msg: string, next = ""): void {
  out("error", code, null, { code, message: msg, next });
}
function blocked(code: string, msg: string, next = ""): void {
  out("blocked", code, null, { code, message: msg, next });
}

// ─── Wallet resolution ─────────────────────────────────────────────────────────
async function resolveWallet(): Promise<{ privateKey: string; address: string } | null> {
  const raw = process.env.CLIENT_PRIVATE_KEY || process.env.STACKS_PRIVATE_KEY || "";
  if (!raw) return null;
  const key = raw.endsWith("01") ? raw : raw + "01";
  const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
  return { privateKey: key, address };
}

// ─── On-chain read helpers ─────────────────────────────────────────────────────
async function callReadOnly(fnName: string, args: string[] = []): Promise<string | null> {
  try {
    const url = `${HIRO_API}/v2/contracts/call-read/${JING_ADDR}/${JING_CONTRACT}/${fnName}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: JING_ADDR, arguments: args }),
    });
    if (!res.ok) return null;
    const d = await res.json() as { okay: boolean; result?: string };
    return d.okay ? (d.result ?? null) : null;
  } catch { return null; }
}

function parseUint(hex: string | null): number | null {
  if (!hex) return null;
  const stripped = hex.replace(/^0x0[0-9a-f]/, "");
  return stripped ? Number(BigInt("0x" + stripped)) : 0;
}

async function getStxBalance(address: string): Promise<number> {
  const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/stx`);
  if (!res.ok) throw new Error(`Balance check failed: ${res.status}`);
  const d = await res.json() as { balance: string };
  return parseInt(d.balance, 10);
}

// ─── Status / phase check ──────────────────────────────────────────────────────
interface CycleState {
  phase: number;
  phaseName: string;
  cycle: number | null;
  totalStxUstx: number | null;
  totalSbtcSats: number | null;
  minStxUstx: number | null;
  minSbtcSats: number | null;
}

async function getCycleState(): Promise<CycleState | null> {
  const [phaseRaw, cycleRaw, totStxRaw, totSbtcRaw, minStxRaw, minSbtcRaw] = await Promise.all([
    callReadOnly("get-phase"),
    callReadOnly("get-current-cycle"),
    callReadOnly("get-total-stx"),
    callReadOnly("get-total-sbtc"),
    callReadOnly("get-min-stx-deposit"),
    callReadOnly("get-min-sbtc-deposit"),
  ]);

  const phase = parseUint(phaseRaw) ?? 0;
  return {
    phase,
    phaseName: CYCLE_PHASES[phase] ?? "unknown",
    cycle: parseUint(cycleRaw),
    totalStxUstx: parseUint(totStxRaw),
    totalSbtcSats: parseUint(totSbtcRaw),
    minStxUstx: parseUint(minStxRaw),
    minSbtcSats: parseUint(minSbtcRaw),
  };
}

// ─── Commands ──────────────────────────────────────────────────────────────────
async function cmdStatus(): Promise<void> {
  const state = await getCycleState();
  if (!state) {
    fail("read_failed", "Could not read JingSwap cycle state from Hiro API");
    return;
  }
  out("success", "status", {
    contract: `${JING_ADDR}.${JING_CONTRACT}`,
    phase: state.phase,
    phase_name: state.phaseName,
    accepting_deposits: state.phase === 0,
    cycle: state.cycle,
    total_stx_deposited_stx: state.totalStxUstx !== null ? (state.totalStxUstx / 1e6).toFixed(2) : null,
    total_sbtc_deposited_sats: state.totalSbtcSats,
    min_stx_deposit_stx: state.minStxUstx !== null ? (state.minStxUstx / 1e6).toFixed(2) : null,
    min_sbtc_deposit_sats: state.minSbtcSats,
    hint: state.phase === 0
      ? "Phase 0: Deposits open. Use `deposit --amount <stx>` to participate."
      : `Phase ${state.phase} (${state.phaseName}): Deposits closed. Wait for next cycle.`,
  });
}

async function cmdDeposit(amountStx: number, dryRun: boolean): Promise<void> {
  const wallet = await resolveWallet();
  if (!wallet) {
    fail("no_wallet", "CLIENT_PRIVATE_KEY not set", "Export CLIENT_PRIVATE_KEY from your .env");
    return;
  }

  if (amountStx > PER_OP_CAP_STX) {
    blocked("exceeds_per_op_cap", `Per-op cap is ${PER_OP_CAP_STX} STX`, "Lower --amount");
    return;
  }

  const amountUstx = Math.round(amountStx * 1_000_000);

  const [state, stxBalance] = await Promise.all([
    getCycleState(),
    getStxBalance(wallet.address),
  ]);

  if (!state) {
    fail("read_failed", "Could not read JingSwap cycle state", "Check Hiro API connectivity");
    return;
  }
  if (state.phase !== 0) {
    blocked("deposits_closed",
      `Auction is in ${state.phaseName} phase (${state.phase}) — deposits are closed`,
      "Wait for next cycle to open (phase 0)"
    );
    return;
  }

  const minUstx = state.minStxUstx ?? 0;
  if (amountUstx < minUstx) {
    blocked("below_minimum",
      `Minimum deposit is ${(minUstx / 1e6).toFixed(2)} STX, got ${amountStx}`,
      "Increase --amount"
    );
    return;
  }

  const reserveUstx = GAS_RESERVE_STX * 1_000_000;
  if (stxBalance < amountUstx + reserveUstx + TX_FEE_USTX) {
    blocked("insufficient_balance",
      `Balance ${stxBalance} uSTX < ${amountUstx + reserveUstx + TX_FEE_USTX} required`,
      `Available: ${Math.floor(Math.max(0, stxBalance - reserveUstx - TX_FEE_USTX) / 1e6)} STX`
    );
    return;
  }

  const safetyChecks = {
    phase_is_deposit: true,
    meets_minimum: true,
    balance_sufficient: true,
    within_per_op_cap: true,
  };

  if (dryRun) {
    out("success", "dry-run", {
      contract: `${JING_ADDR}.${JING_CONTRACT}`,
      function: "deposit-stx",
      amount_stx: amountStx,
      amount_ustx: amountUstx,
      wallet: wallet.address,
      stx_balance_ustx: stxBalance,
      tx_fee_ustx: TX_FEE_USTX,
      cycle: state.cycle,
      safety_checks: safetyChecks,
      note: "Omit --dry-run to broadcast on-chain",
    });
    return;
  }

  // ── Broadcast ────────────────────────────────────────────────────────────────
  let txid: string;
  try {
    const tx = await makeContractCall({
      contractAddress: JING_ADDR,
      contractName: JING_CONTRACT,
      functionName: "deposit-stx",
      functionArgs: [uintCV(amountUstx)],
      postConditionMode: PostConditionMode.Deny,
      postConditions: [
        Pc.principal(wallet.address).willSendEq(amountUstx).ustx(),
      ],
      network: STACKS_MAINNET,
      senderKey: wallet.privateKey,
      anchorMode: AnchorMode.Any,
      fee: BigInt(TX_FEE_USTX),
    });
    const res = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
    if (res.error) throw new Error(`Broadcast failed: ${res.error} — ${res.reason ?? ""}`);
    txid = res.txid as string;
  } catch (e: any) {
    fail("broadcast_failed", e.message, "Check balance and network status");
    return;
  }

  out("success", "deposited", {
    contract: `${JING_ADDR}.${JING_CONTRACT}`,
    function: "deposit-stx",
    txid,
    explorer_url: `${EXPLORER_BASE}/0x${txid}?chain=mainnet`,
    amount_stx: amountStx,
    amount_ustx: amountUstx,
    cycle: state.cycle,
    wallet: wallet.address,
    safety_checks: safetyChecks,
    note: "STX deposited. Settlement at Pyth oracle price when cycle closes.",
  });
}

async function cmdCancel(dryRun: boolean): Promise<void> {
  const wallet = await resolveWallet();
  if (!wallet) {
    fail("no_wallet", "CLIENT_PRIVATE_KEY not set", "Export CLIENT_PRIVATE_KEY from your .env");
    return;
  }

  if (dryRun) {
    out("success", "dry-run", {
      contract: `${JING_ADDR}.${JING_CONTRACT}`,
      function: "cancel-stx-deposit",
      wallet: wallet.address,
      note: "Omit --dry-run to broadcast on-chain",
    });
    return;
  }

  let txid: string;
  try {
    const tx = await makeContractCall({
      contractAddress: JING_ADDR,
      contractName: JING_CONTRACT,
      functionName: "cancel-stx-deposit",
      functionArgs: [],
      postConditionMode: PostConditionMode.Allow,
      postConditions: [],
      network: STACKS_MAINNET,
      senderKey: wallet.privateKey,
      anchorMode: AnchorMode.Any,
      fee: BigInt(TX_FEE_USTX),
    });
    const res = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
    if (res.error) throw new Error(`Broadcast failed: ${res.error} — ${res.reason ?? ""}`);
    txid = res.txid as string;
  } catch (e: any) {
    fail("broadcast_failed", e.message, "Check deposit exists and is in deposit phase");
    return;
  }

  out("success", "cancelled", {
    contract: `${JING_ADDR}.${JING_CONTRACT}`,
    function: "cancel-stx-deposit",
    txid,
    explorer_url: `${EXPLORER_BASE}/0x${txid}?chain=mainnet`,
    wallet: wallet.address,
    note: "Deposit cancelled. STX returned to wallet.",
  });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
const program = new Command();

program
  .name("jingswap-stx-depositor")
  .description("Direct on-chain JingSwap STX auction deposit and cancellation");

program
  .command("status")
  .description("Show current auction cycle phase, totals, and deposit eligibility")
  .action(() => cmdStatus().catch((e) => fail("status_error", e.message)));

program
  .command("deposit")
  .description("Deposit STX into the current JingSwap auction cycle (Phase 0 only)")
  .requiredOption("--amount <stx>", "STX amount to deposit (e.g. 100)")
  .option("--dry-run", "Simulate without broadcasting", false)
  .action((opts) =>
    cmdDeposit(parseFloat(opts.amount), opts.dryRun).catch((e) => fail("deposit_error", e.message))
  );

program
  .command("cancel")
  .description("Cancel your STX deposit and reclaim funds (deposit phase only)")
  .option("--dry-run", "Simulate without broadcasting", false)
  .action((opts) =>
    cmdCancel(opts.dryRun).catch((e) => fail("cancel_error", e.message))
  );

program.parse(process.argv);
