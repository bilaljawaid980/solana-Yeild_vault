import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import fs from "fs";
import * as readline from "readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const LP_FACTOR = 1_000_000_000n;

function askQuestion(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => { resolve(answer.trim()); });
  });
}

function formatDuration(secondsLeft: number): string {
  const daysLeft  = Math.floor(secondsLeft / 86400);
  const hoursLeft = Math.floor((secondsLeft % 86400) / 3600);
  const minsLeft  = Math.floor((secondsLeft % 3600) / 60);
  const secsLeft  = secondsLeft % 60;
  if (daysLeft > 0)  return `${daysLeft}d ${hoursLeft}h ${minsLeft}m`;
  if (hoursLeft > 0) return `${hoursLeft}h ${minsLeft}m ${secsLeft}s`;
  if (minsLeft > 0)  return `${minsLeft}m ${secsLeft}s`;
  return `${secsLeft}s`;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as Program<Vault>;

  console.log("═══════════════════════════════════════════");
  console.log("         WITHDRAW");
  console.log("═══════════════════════════════════════════");

  const walletPath = await askQuestion("Enter your wallet keypair path: ");
  if (!fs.existsSync(walletPath)) {
    console.log("❌ Wallet file not found:", walletPath);
    rl.close(); return;
  }

  const depositorKeypair = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );

  const vaultOwnerInput = await askQuestion("Enter vault owner address: ");
  let vaultOwner: PublicKey;
  try {
    vaultOwner = new PublicKey(vaultOwnerInput);
  } catch {
    console.log("❌ Invalid vault owner address!");
    rl.close(); return;
  }

  const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(depositorKeypair);
  const depositorProvider = new anchor.AnchorProvider(connection, wallet, {});
  const depositorProgram = new anchor.Program(program.idl, depositorProvider) as Program<Vault>;

  const [vaultStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault7"), vaultOwner.toBuffer()], program.programId
  );
  const [lpMintPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint7"), vaultOwner.toBuffer()], program.programId
  );
  const [depositorStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("depositor7"), depositorKeypair.publicKey.toBuffer(), vaultOwner.toBuffer()],
    program.programId
  );

  let vaultState: any;
  try {
    vaultState = await depositorProgram.account.vaultState.fetch(vaultStatePDA);
  } catch {
    console.log("❌ Vault not found!");
    rl.close(); return;
  }

  let depState: any;
  try {
    depState = await depositorProgram.account.depositorState.fetch(depositorStatePDA);
  } catch {
    console.log("❌ This wallet has no deposit in this vault!");
    rl.close(); return;
  }

  if (depState.lockedAmount.toNumber() === 0) {
    console.log("❌ Nothing to withdraw — no active deposit found.");
    rl.close(); return;
  }

  // ── All LP math uses RAW bigint amounts ──
  const vaultBalance    = BigInt(vaultState.balance.toString());
  const lpSupplyInfo    = await connection.getTokenSupply(lpMintPDA);
  const lpSupplyRaw     = BigInt(lpSupplyInfo.value.amount);          // e.g. 4_000_000_000
  const lpSupplyUi      = lpSupplyInfo.value.uiAmount || 0;           // e.g. 4.0  (display only)
  const myLpRaw         = BigInt(depState.lpAmount.toString());       // e.g. 4_000_000_000
  const myLpUi          = Number(myLpRaw) / Number(LP_FACTOR);        // e.g. 4.0
  const lockedAmount    = depState.lockedAmount.toNumber();
  const feePercent      = vaultState.feePercent ?? 0;
  const totalYieldAdded = vaultState.totalYieldAdded?.toNumber() ?? 0;

  // SOL to receive = (myLpRaw × vaultBalance) / lpSupplyRaw  — all raw bigint
  const solToReceiveRaw = lpSupplyRaw > 0n
    ? (myLpRaw * vaultBalance) / lpSupplyRaw
    : BigInt(lockedAmount);
  const solToReceiveLamports = Number(solToReceiveRaw);

  // LP price per 1 whole LP = vaultBalance / lpSupplyUi
  const lpPriceLamports = lpSupplyUi > 0 ? Number(vaultBalance) / lpSupplyUi : vaultState.minDeposit.toNumber();
  const lpPriceSol      = lpPriceLamports / LAMPORTS_PER_SOL;

  // Vault share
  const sharePercent = lpSupplyRaw > 0n
    ? (Number(myLpRaw) / Number(lpSupplyRaw) * 100).toFixed(6)
    : "0";

  const yieldEarned = solToReceiveLamports - lockedAmount;

  const now        = Math.floor(Date.now() / 1000);
  const unlockTime = depState.unlockTime.toNumber();
  const isLocked   = now < unlockTime;

  console.log("───────────────────────────────────────────");
  console.log("Wallet        :", depositorKeypair.publicKey.toString());
  console.log("Vault owner   :", vaultOwner.toString());
  console.log("───────────────────────────────────────────");
  console.log("VAULT INFO:");
  console.log("Vault balance :", Number(vaultBalance) / LAMPORTS_PER_SOL, "SOL");
  console.log("Total LP      :", lpSupplyUi, "LP");
  console.log("LP price now  :", lpPriceSol.toFixed(9), "SOL per LP  ← elastic");
  console.log("Total yield   :", totalYieldAdded / LAMPORTS_PER_SOL, "SOL");
  console.log("Admin fee     :", feePercent, "%");
  console.log("───────────────────────────────────────────");
  console.log("YOUR POSITION:");
  console.log("My LP tokens  :", myLpUi, "LP");
  console.log("Vault share   :", sharePercent, "%");
  console.log("Original dep  :", lockedAmount / LAMPORTS_PER_SOL, "SOL");
  console.log("Current worth :", solToReceiveLamports / LAMPORTS_PER_SOL, "SOL  ← elastic");
  console.log("Yield earned  :", yieldEarned > 0 ? (yieldEarned / LAMPORTS_PER_SOL).toFixed(9) : "0", "SOL");
  console.log("Profit %      :", lockedAmount > 0 ? ((yieldEarned / lockedAmount) * 100).toFixed(4) : "0", "%");
  console.log("───────────────────────────────────────────");

  if (isLocked) {
    const secondsLeft = unlockTime - now;
    console.log("LOCK STATUS   : LOCKED");
    console.log("Unlock time   :", new Date(unlockTime * 1000).toLocaleString());
    console.log("Time left     :", formatDuration(secondsLeft));
    console.log("You will get  :", solToReceiveLamports / LAMPORTS_PER_SOL, "SOL when unlocked");
    console.log("(Amount increases if more yield is added before unlock)");
    console.log("═══════════════════════════════════════════");
    rl.close(); return;
  }

  const tokenAddress = await getAssociatedTokenAddress(lpMintPDA, depositorKeypair.publicKey);
  const solBefore    = await connection.getBalance(depositorKeypair.publicKey);
  const lpBefore     = (await connection.getTokenAccountBalance(tokenAddress)).value.uiAmount || 0;

  console.log("LOCK STATUS   : UNLOCKED — ready to withdraw!");
  console.log("You will get  :", solToReceiveLamports / LAMPORTS_PER_SOL, "SOL");
  console.log("Yield earned  :", yieldEarned > 0 ? (yieldEarned / LAMPORTS_PER_SOL).toFixed(9) : "0", "SOL");
  console.log("LP to burn    :", myLpUi, "LP");
  console.log("───────────────────────────────────────────");

  const confirm = await askQuestion("Confirm withdrawal? (yes/no): ");
  if (confirm.toLowerCase() !== "yes") {
    console.log("❌ Cancelled.");
    rl.close(); return;
  }

  const tx = await depositorProgram.methods
    .withdraw()
    .accountsPartial({
      depositor: depositorKeypair.publicKey,
      depositorState: depositorStatePDA,
      vaultState: vaultStatePDA,
      lpMint: lpMintPDA,
      depositorTokenAccount: tokenAddress,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  const solAfter  = await connection.getBalance(depositorKeypair.publicKey);
  const lpAfter   = (await connection.getTokenAccountBalance(tokenAddress)).value.uiAmount || 0;
  const actualReceived = solAfter - solBefore;

  console.log("═══════════════════════════════════════════");
  console.log("✅ Withdrawal successful!");
  console.log("───────────────────────────────────────────");
  console.log("Original deposit :", lockedAmount / LAMPORTS_PER_SOL, "SOL");
  console.log("SOL received     :", actualReceived / LAMPORTS_PER_SOL, "SOL");
  console.log("Yield earned     :", yieldEarned > 0 ? (yieldEarned / LAMPORTS_PER_SOL).toFixed(9) : "0", "SOL");
  console.log("LP burned        :", (lpBefore - (lpAfter || 0)).toFixed(9), "LP");
  console.log("Wallet before    :", solBefore / LAMPORTS_PER_SOL, "SOL");
  console.log("Wallet after     :", solAfter / LAMPORTS_PER_SOL, "SOL");
  console.log("───────────────────────────────────────────");
  console.log("TX      :", tx);
  console.log("Explorer: https://explorer.solana.com/tx/" + tx + "?cluster=devnet");
  console.log("═══════════════════════════════════════════");

  rl.close();
}
main().catch((e) => { console.error(e); rl.close(); });
