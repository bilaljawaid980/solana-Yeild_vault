import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import * as readline from "readline";
import fs from "fs";

async function askQuestion(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  console.log("═══════════════════════════════════════════");
  console.log("         MY ACCOUNT STATUS");
  console.log("═══════════════════════════════════════════");

  // Ask wallet path
  const walletPath = await askQuestion(
    "Enter your wallet keypair path (e.g. /root/.config/solana/id.json): "
  );

  if (!fs.existsSync(walletPath)) {
    console.log("❌ Wallet file not found at:", walletPath);
    return;
  }

  let userKeypair: Keypair;
  try {
    userKeypair = Keypair.fromSecretKey(
      Buffer.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
    );
  } catch (e) {
    console.log("❌ Invalid keypair file!");
    return;
  }

  // Ask vault owner address
  const vaultOwnerInput = await askQuestion(
    "Enter vault owner address: "
  );

  let vaultOwner: PublicKey;
  try {
    vaultOwner = new PublicKey(vaultOwnerInput);
  } catch (e) {
    console.log("❌ Invalid vault owner address!");
    return;
  }

  const wallet = new anchor.Wallet(userKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as Program<Vault>;

  const [lpMintPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint4"), vaultOwner.toBuffer()], program.programId
  );
  const [depositorStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("depositor4"), userKeypair.publicKey.toBuffer(), vaultOwner.toBuffer()],
    program.programId
  );
  const [vaultStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault4"), vaultOwner.toBuffer()], program.programId
  );

  // Check vault exists
  try {
    await program.account.vaultState.fetch(vaultStatePDA);
  } catch (e) {
    console.log("❌ Vault not found for this owner address!");
    return;
  }

  const solBalance = await connection.getBalance(userKeypair.publicKey);
  const lpSupply = await connection.getTokenSupply(lpMintPDA);
  const totalLp = lpSupply.value.uiAmount || 0;

  // Check if registered
  let isRegistered = false;
  let myLp = 0;
  let lockedAmount = 0;
  let depositTime = 0;
  let unlockTime = 0;
  let tokenAddress: PublicKey | null = null;

  try {
    await program.account.depositorState.fetch(depositorStatePDA);
    isRegistered = true;

    tokenAddress = await getAssociatedTokenAddress(lpMintPDA, userKeypair.publicKey);

    try {
      const lpBalance = await connection.getTokenAccountBalance(tokenAddress);
      myLp = lpBalance.value.uiAmount || 0;
    } catch (_) {}

    const depState = await program.account.depositorState.fetch(depositorStatePDA);
    lockedAmount = depState.lockedAmount.toNumber();
    depositTime = depState.depositTime.toNumber();
    unlockTime = depState.unlockTime.toNumber();
  } catch (_) {}

  const sharePercent = totalLp > 0 ? ((myLp / totalLp) * 100).toFixed(2) : "0";
  const now = Math.floor(Date.now() / 1000);
  const isLocked = now < unlockTime && lockedAmount > 0;
  const secondsLeft = unlockTime - now;
  const daysLeft = Math.max(0, Math.floor(secondsLeft / 86400));
  const hoursLeft = Math.max(0, Math.floor((secondsLeft % 86400) / 3600));

  console.log("───────────────────────────────────────────");
  console.log("Wallet address  :", userKeypair.publicKey.toString());
  console.log("SOL balance     :", solBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("───────────────────────────────────────────");
  console.log("Vault owner     :", vaultOwnerInput);
  console.log("Registered      :", isRegistered ? "✅ Yes" : "❌ No");

  if (isRegistered) {
    console.log("───────────────────────────────────────────");
    console.log("LP token account:", tokenAddress?.toString() || "N/A");
    console.log("My LP tokens    :", myLp, "LP");
    console.log("Total LP supply :", totalLp, "LP");
    console.log("My vault share  :", sharePercent, "%");
    console.log("My LP worth     :", (myLp * 0.1).toFixed(2), "SOL");
    console.log("───────────────────────────────────────────");
    console.log("Locked SOL      :", lockedAmount / LAMPORTS_PER_SOL, "SOL");

    if (lockedAmount === 0) {
      console.log("Lock status     : No active deposit");
    } else if (isLocked) {
      console.log("Lock status     : 🔒 LOCKED");
      console.log("Deposit time    :", new Date(depositTime * 1000).toLocaleString());
      console.log("Unlock time     :", new Date(unlockTime * 1000).toLocaleString());
      console.log("Time left       :", daysLeft + "d " + hoursLeft + "h");
    } else {
      console.log("Lock status     : 🔓 UNLOCKED — ready to withdraw!");
    }
  } else {
    console.log("───────────────────────────────────────────");
    console.log("⚠️  You are not registered in this vault.");
    console.log("Run depositor-deposit.ts to register first.");
  }

  console.log("═══════════════════════════════════════════");
}
main().catch(console.error);