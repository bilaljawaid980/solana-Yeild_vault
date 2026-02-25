import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import * as readline from "readline";
import fs from "fs";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function askQuestion(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main() {
  const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");

  console.log("═══════════════════════════════════════════");
  console.log("         MY ACCOUNT STATUS");
  console.log("═══════════════════════════════════════════");

  const walletPath = await askQuestion("Enter your wallet keypair path: ");
  if (!fs.existsSync(walletPath)) {
    console.log("❌ Wallet file not found at:", walletPath);
    rl.close(); return;
  }

  let userKeypair: Keypair;
  try {
    userKeypair = Keypair.fromSecretKey(
      Buffer.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
    );
  } catch (e) {
    console.log("❌ Invalid keypair file!");
    rl.close(); return;
  }

  const vaultOwnerInput = await askQuestion("Enter vault owner address: ");
  let vaultOwner: PublicKey;
  try {
    vaultOwner = new PublicKey(vaultOwnerInput);
  } catch (e) {
    console.log("❌ Invalid vault owner address!");
    rl.close(); return;
  }

  const wallet = new anchor.Wallet(userKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as Program<Vault>;

  const [vaultStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault7"), vaultOwner.toBuffer()], program.programId
  );
  const [lpMintPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint7"), vaultOwner.toBuffer()], program.programId
  );
  const [depositorStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("depositor7"), userKeypair.publicKey.toBuffer(), vaultOwner.toBuffer()],
    program.programId
  );

  // Fetch vault state
  let vaultState: any;
  try {
    vaultState = await program.account.vaultState.fetch(vaultStatePDA);
  } catch (e) {
    console.log("❌ Vault not found for this owner address!");
    rl.close(); return;
  }

  const solBalance = await connection.getBalance(userKeypair.publicKey);
  const lpSupplyInfo = await connection.getTokenSupply(lpMintPDA);
  const totalLp = lpSupplyInfo.value.uiAmount || 0;
  const vaultBalance = vaultState.balance.toNumber();
  const feePercent = vaultState.feePercent ?? 0;
  const totalYieldAdded = vaultState.totalYieldAdded.toNumber();
  const minDepositLamports = vaultState.minDeposit.toNumber();

  // Elastic LP price
  const currentLpPriceLamports = totalLp > 0
    ? vaultBalance / totalLp
    : minDepositLamports;
  const currentLpPriceSol = currentLpPriceLamports / LAMPORTS_PER_SOL;

  // Fetch depositor state
  let isRegistered = false;
  let myLp = 0;
  let lockedAmount = 0;
  let depositTime = 0;
  let unlockTime = 0;
  let tokenAddress: PublicKey | null = null;

  try {
    const depState = await program.account.depositorState.fetch(depositorStatePDA);
    isRegistered = true;
    lockedAmount = depState.lockedAmount.toNumber();
    depositTime = depState.depositTime.toNumber();
    unlockTime = depState.unlockTime.toNumber();

    tokenAddress = await getAssociatedTokenAddress(lpMintPDA, userKeypair.publicKey);
    try {
      const lpBalance = await connection.getTokenAccountBalance(tokenAddress);
      myLp = lpBalance.value.uiAmount || 0;
    } catch (_) {}
  } catch (_) {}

  // Elastic calculations
  const mySharePercent = totalLp > 0 ? ((myLp / totalLp) * 100).toFixed(2) : "0.00";
  const myLpWorthLamports = totalLp > 0 ? (myLp * vaultBalance) / totalLp : 0;
  const myLpWorthSol = myLpWorthLamports / LAMPORTS_PER_SOL;
  const myYieldEarned = myLpWorthLamports - lockedAmount;

  const now = Math.floor(Date.now() / 1000);
  const isLocked = now < unlockTime && lockedAmount > 0;
  const secondsLeft = unlockTime - now;
  const daysLeft = Math.max(0, Math.floor(secondsLeft / 86400));
  const hoursLeft = Math.max(0, Math.floor((secondsLeft % 86400) / 3600));
  const minsLeft = Math.max(0, Math.floor((secondsLeft % 3600) / 60));

  console.log("───────────────────────────────────────────");
  console.log("VAULT INFO:");
  console.log("Vault owner     :", vaultOwnerInput);
  console.log("Vault balance   :", vaultBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("Total LP supply :", totalLp, "LP");
  console.log("Current LP price:", currentLpPriceSol.toFixed(6), "SOL per LP");
  console.log("Total yield ever:", totalYieldAdded / LAMPORTS_PER_SOL, "SOL");
  console.log("Admin fee       :", feePercent, "%");
  console.log("Lock period     :", Number(vaultState.lockPeriod) / 86400, "days");
  console.log("Min deposit     :", minDepositLamports / LAMPORTS_PER_SOL, "SOL");
  console.log("───────────────────────────────────────────");
  console.log("YOUR WALLET:");
  console.log("Address         :", userKeypair.publicKey.toString());
  console.log("SOL balance     :", solBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("Registered      :", isRegistered ? "✅ Yes" : "❌ No — deposit to auto-register");

  if (isRegistered) {
    console.log("───────────────────────────────────────────");
    console.log("YOUR VAULT POSITION:");
    console.log("LP token account:", tokenAddress?.toString() || "N/A");
    console.log("My LP tokens    :", myLp, "LP");
    console.log("My vault share  :", mySharePercent, "%");
    console.log("───────────────────────────────────────────");
    console.log("EARNINGS:");
    console.log("Original deposit:", lockedAmount / LAMPORTS_PER_SOL, "SOL");
    console.log("Current worth   :", myLpWorthSol.toFixed(6), "SOL  ← elastic (includes yield)");
    console.log("Yield earned    :", myYieldEarned > 0 ? (myYieldEarned / LAMPORTS_PER_SOL).toFixed(6) : "0", "SOL");
    console.log("LP price at dep :", (minDepositLamports / LAMPORTS_PER_SOL).toFixed(6), "SOL per LP");
    console.log("LP price now    :", currentLpPriceSol.toFixed(6), "SOL per LP");
    console.log("───────────────────────────────────────────");
    console.log("LOCK STATUS:");
    console.log("Locked SOL      :", lockedAmount / LAMPORTS_PER_SOL, "SOL");

    if (lockedAmount === 0) {
      console.log("Status          : No active deposit");
    } else if (isLocked) {
      console.log("Status          : 🔒 LOCKED");
      console.log("Deposit time    :", new Date(depositTime * 1000).toLocaleString());
      console.log("Unlock time     :", new Date(unlockTime * 1000).toLocaleString());
      console.log("Time left       :", daysLeft + "d " + hoursLeft + "h " + minsLeft + "m");
    } else {
      console.log("Status          : 🔓 UNLOCKED — ready to withdraw!");
      console.log("You will receive:", myLpWorthSol.toFixed(6), "SOL");
    }
  }

  console.log("═══════════════════════════════════════════");
  rl.close();
}
main().catch((e) => { console.error(e); rl.close(); });