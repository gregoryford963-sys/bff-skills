#!/usr/bin/env bun
/**
 * stackspot-pot-executor — Direct on-chain Stackspot pot participation
 *
 * Commands: list | status --pot <name> | join --pot <name> --amount <stx> [--dry-run]
 *
 * Broadcasts join-pot transactions directly via @stacks/transactions.
 * No MCP delegation — every write call goes on-chain from this process.
 *
 * Safety limits: GAS_RESERVE_STX kept after every join; per-op and daily caps.
 */

import { Command } from "commander";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
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

// ─── Config ──────────────────────────────────────────────────────────────────
const POT_DEPLOYER       = "SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85";
const HIRO_API           = "https://api.hiro.so";
const EXPLORER_BASE      = "https://explorer.hiro.so/txid";
const TX_FEE_USTX        = 3_000;          // 0.003 STX per tx
const GAS_RESERVE_STX    = 1;              // keep 1 STX post-join
const PER_OP_CAP_STX     = 500;            // max STX per single join
const DAILY_CAP_STX      = 2_000;          // max STX joins per day
const LEDGER_FILE        = join(homedir(), ".stackspot-pot-executor-ledger.json");
const DAY_MS             = 86_400_000;

const KNOWN_POTS: { name: string; contractName: string; minAmountStx: number; maxParticipants: number }[] = [
  { name: "Genesis",        contractName: "Genesis",        minAmountStx: 20,  maxParticipants: 2   },
  { name: "BuildOnBitcoin", contractName: "BuildOnBitcoin", minAmountStx: 100, maxParticipants: 10  },
  { name: "STXLFG",         contractName: "STXLFG",         minAmountStx: 21,  maxParticipants: 100 },
];

// ─── Ledger ───────────────────────────────────────────────────────────────────
interface Ledger {
  dailyUstx: number;
  dayEpoch: number;
  entries: { ts: string; pot: string; ustx: number; txid: string }[];
}

function loadLedger(): Ledger {
  if (!existsSync(LEDGER_FILE)) return { dailyUstx: 0, dayEpoch: Date.now(), entries: [] };
  try {
    const l = JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as Ledger;
    if (Date.now() - l.dayEpoch > DAY_MS) { l.dailyUstx = 0; l.dayEpoch = Date.now(); }
    return l;
  } catch { return { dailyUstx: 0, dayEpoch: Date.now(), entries: [] }; }
}

function saveLedger(l: Ledger): void {
  writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 2));
}

// ─── Output helpers ───────────────────────────────────────────────────────────
function out(status: string, action: string, data: unknown, error: unknown = null): void {
  console.log(JSON.stringify({ status, action, data, error }, null, 2));
}
function fail(code: string, message: string, next = ""): void {
  out("error", code, null, { code, message, next });
}
function blocked(code: string, message: string, next = ""): void {
  out("blocked", code, null, { code, message, next });
}

// ─── Wallet key resolution ─────────────────────────────────────────────────────
async function resolveWalletKey(): Promise<{ privateKey: string; address: string } | null> {
  const raw = process.env.CLIENT_PRIVATE_KEY || process.env.STACKS_PRIVATE_KEY || "";
  if (!raw) return null;
  const key = raw.endsWith("01") ? raw : raw + "01";
  const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
  return { privateKey: key, address };
}

// ─── Hiro read-only helpers ────────────────────────────────────────────────────
async function callReadOnly(
  contractAddr: string,
  contractName: string,
  fnName: string,
  args: string[] = []
): Promise<unknown> {
  const url = `${HIRO_API}/v2/contracts/call-read/${contractAddr}/${contractName}/${fnName}`;
  const body = { sender: contractAddr, arguments: args };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Read-only call ${contractName}::${fnName} failed: ${res.status}`);
  const data = await res.json() as { okay: boolean; result?: string };
  if (!data.okay) throw new Error(`${contractName}::${fnName} returned error`);
  return data.result;
}

async function getStxBalance(address: string): Promise<number> {
  const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/stx`);
  if (!res.ok) throw new Error(`Balance check failed: ${res.status}`);
  const d = await res.json() as { balance: string };
  return parseInt(d.balance, 10);
}

async function isPotLocked(contractName: string): Promise<boolean | null> {
  try {
    const r = await callReadOnly(POT_DEPLOYER, contractName, "is-locked") as string;
    return r === "0x03";
  } catch { return null; }
}

async function getPotValue(contractName: string): Promise<bigint | null> {
  try {
    const r = await callReadOnly(POT_DEPLOYER, contractName, "get-pot-value") as string;
    const hex = (r as string).replace(/^0x0[0-9a-f]/, "");
    return hex ? BigInt("0x" + hex) : null;
  } catch { return null; }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdList(): Promise<void> {
  const results = await Promise.all(
    KNOWN_POTS.map(async (pot) => {
      const [locked, potValueRaw] = await Promise.all([
        isPotLocked(pot.contractName),
        getPotValue(pot.contractName),
      ]);
      return {
        name: pot.name,
        contract: `${POT_DEPLOYER}.${pot.contractName}`,
        minAmountStx: pot.minAmountStx,
        maxParticipants: pot.maxParticipants,
        locked: locked,
        potValueStx: potValueRaw !== null ? Number(potValueRaw) / 1_000_000 : null,
        reachable: locked !== null,
      };
    })
  );
  const open = results.filter((p) => p.reachable && p.locked === false);
  out("success", "list", {
    total: results.length,
    open: open.length,
    pots: results,
    hint: open.length > 0
      ? `Join with: stackspot-pot-executor join --pot <name> --amount <stx>`
      : "No open pots right now — all locked or unreachable",
  });
}

async function cmdStatus(potName: string): Promise<void> {
  const known = KNOWN_POTS.find((p) => p.contractName.toLowerCase() === potName.toLowerCase());
  const contractName = known ? known.contractName : potName;
  const [locked, potValue] = await Promise.all([
    isPotLocked(contractName),
    getPotValue(contractName),
  ]);
  out("success", "status", {
    pot: contractName,
    contract: `${POT_DEPLOYER}.${contractName}`,
    locked,
    potValueStx: potValue !== null ? Number(potValue) / 1_000_000 : null,
    minAmountStx: known?.minAmountStx ?? "unknown",
    maxParticipants: known?.maxParticipants ?? "unknown",
    eligible_to_join: locked === false,
  });
}

async function cmdJoin(potName: string, amountStx: number, dryRun: boolean): Promise<void> {
  // ── Resolve wallet ──────────────────────────────────────────────────────────
  const wallet = await resolveWalletKey();
  if (!wallet) {
    fail("no_wallet", "CLIENT_PRIVATE_KEY not set", "Export CLIENT_PRIVATE_KEY from your .env");
    return;
  }

  const ledger = loadLedger();
  const amountUstx = Math.round(amountStx * 1_000_000);

  // ── Find pot ────────────────────────────────────────────────────────────────
  const known = KNOWN_POTS.find((p) => p.contractName.toLowerCase() === potName.toLowerCase());
  const contractName = known ? known.contractName : potName;

  // ── Safety checks ───────────────────────────────────────────────────────────
  if (amountStx < (known?.minAmountStx ?? 1)) {
    blocked("below_minimum", `Pot minimum is ${known?.minAmountStx} STX, got ${amountStx}`, "Increase --amount");
    return;
  }
  if (amountStx > PER_OP_CAP_STX) {
    blocked("exceeds_per_op_cap", `Per-op cap is ${PER_OP_CAP_STX} STX`, "Lower --amount");
    return;
  }
  if ((ledger.dailyUstx + amountUstx) > DAILY_CAP_STX * 1_000_000) {
    blocked("exceeds_daily_cap", `Daily cap ${DAILY_CAP_STX} STX reached`, "Wait for daily reset");
    return;
  }

  const [locked, stxBalance] = await Promise.all([
    isPotLocked(contractName),
    getStxBalance(wallet.address),
  ]);

  if (locked === null) {
    fail("pot_unreachable", `Cannot read state for pot ${contractName}`, "Check pot name");
    return;
  }
  if (locked === true) {
    blocked("pot_locked", `Pot ${contractName} is locked (in-progress or settled)`, "Check a different pot");
    return;
  }

  const reserveUstx = GAS_RESERVE_STX * 1_000_000;
  if (stxBalance < amountUstx + reserveUstx + TX_FEE_USTX) {
    blocked(
      "insufficient_balance",
      `Balance ${stxBalance} uSTX < ${amountUstx + reserveUstx + TX_FEE_USTX} required`,
      `Available for join: ${Math.floor(Math.max(0, stxBalance - reserveUstx - TX_FEE_USTX) / 1_000_000)} STX`
    );
    return;
  }

  const safetyChecks = {
    pot_open: true,
    balance_sufficient: true,
    within_per_op_cap: true,
    within_daily_cap: true,
    gas_reserve_ok: true,
  };

  if (dryRun) {
    out("success", "dry-run", {
      pot: contractName,
      contract: `${POT_DEPLOYER}.${contractName}`,
      function: "join-pot",
      amount_stx: amountStx,
      amount_ustx: amountUstx,
      wallet: wallet.address,
      stx_balance_ustx: stxBalance,
      tx_fee_ustx: TX_FEE_USTX,
      safety_checks: safetyChecks,
      note: "Add --confirm (omit --dry-run) to broadcast on-chain",
    });
    return;
  }

  // ── Build and broadcast transaction ─────────────────────────────────────────
  let txid: string;
  try {
    const tx = await makeContractCall({
      contractAddress: POT_DEPLOYER,
      contractName,
      functionName: "join-pot",
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

    const broadcastRes = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
    if (broadcastRes.error) {
      throw new Error(`Broadcast failed: ${broadcastRes.error} — ${broadcastRes.reason ?? ""}`);
    }
    txid = broadcastRes.txid as string;
  } catch (e: any) {
    fail("broadcast_failed", e.message, "Check balance, contract name, and network status");
    return;
  }

  // ── Update ledger ────────────────────────────────────────────────────────────
  ledger.dailyUstx += amountUstx;
  ledger.entries.push({ ts: new Date().toISOString(), pot: contractName, ustx: amountUstx, txid });
  saveLedger(ledger);

  out("success", "joined", {
    pot: contractName,
    contract: `${POT_DEPLOYER}.${contractName}`,
    txid,
    explorer_url: `${EXPLORER_BASE}/0x${txid}?chain=mainnet`,
    amount_stx: amountStx,
    amount_ustx: amountUstx,
    wallet: wallet.address,
    safety_checks: safetyChecks,
    note: "Transaction broadcast. Check explorer for confirmation.",
  });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
const program = new Command();

program
  .name("stackspot-pot-executor")
  .description("Direct on-chain Stackspot pot joiner — broadcasts join-pot via @stacks/transactions");

program
  .command("list")
  .description("List all known Stackspot pots and their current state")
  .action(() => cmdList().catch((e) => fail("list_error", e.message)));

program
  .command("status")
  .description("Show state of a specific pot")
  .requiredOption("--pot <name>", "Pot name (Genesis | BuildOnBitcoin | STXLFG)")
  .action((opts) => cmdStatus(opts.pot).catch((e) => fail("status_error", e.message)));

program
  .command("join")
  .description("Join a Stackspot pot with a direct on-chain transaction")
  .requiredOption("--pot <name>", "Pot name (Genesis | BuildOnBitcoin | STXLFG)")
  .requiredOption("--amount <stx>", "STX amount to deposit (whole STX, e.g. 21)")
  .option("--dry-run", "Simulate the join without broadcasting", false)
  .action((opts) =>
    cmdJoin(opts.pot, parseFloat(opts.amount), opts.dryRun).catch((e) =>
      fail("join_error", e.message)
    )
  );

program.parse(process.argv);
