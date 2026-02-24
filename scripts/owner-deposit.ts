import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
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
  console.log("       VAULT DEPOSITOR CLI");
  console.log("═══════════════════════════════════════════");

  const walletPath = await askQuestion("Enter your wallet keypair path (e.g. /root/.config/solana/id.json): ");

  if (!fs.existsSync(walletPath)) {
    console.log("❌ Wallet file not found at:", walletPath);
    rl.close(); return;
  }

  let userKeypair: Keypair;
  try {
    userKeypair = Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));
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
    [Buffer.from("vault4"), vaultOwner.toBuffer()], program.programId
  );
  const [lpMintPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint4"), vaultOwner.toBuffer()], program.programId
  );
  const [depositorStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("depositor4"), userKeypair.publicKey.toBuffer(), vaultOwner.toBuffer()],
    program.programId
  );

  let vaultState: any;
  try {
    vaultState = await program.account.vaultState.fetch(vaultStatePDA);
  } catch (e) {
    console.log("❌ Vault not found for this owner address!");
    rl.close(); return;
  }

  const solBalance = await connection.getBalance(userKeypair.publicKey);
  const minDepositLamports = vaultState.minDeposit.toNumber();
  const minDepositSol = minDepositLamports / LAMPORTS_PER_SOL;

  console.log("───────────────────────────────────────────");
  console.log("Your wallet   :", userKeypair.publicKey.toString());
  console.log("Your SOL bal  :", solBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("Vault owner   :", vaultOwner.toString());
  console.log("Vault balance :", vaultState.balance.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("Lock period   :", Number(vaultState.lockPeriod) / 86400, "days");
  console.log("Min deposit   :", minDepositSol, "SOL");
  console.log("───────────────────────────────────────────");

  let isRegistered = false;
  try {
    await program.account.depositorState.fetch(depositorStatePDA);
    isRegistered = true;
    console.log("✅ You are already registered in this vault");
  } catch (e) {
    console.log("⚠️  You are NOT registered in this vault yet");
  }

  console.log("\nWhat do you want to do?");
  console.log("1. Register into vault");
  console.log("2. Deposit SOL");
  console.log("3. Exit");

  const choice = await askQuestion("\nEnter choice (1/2/3): ");

  // ─────────────────────────────────────────
  // OPTION 1 — Register
  // ─────────────────────────────────────────
  if (choice === "1") {
    if (isRegistered) {
      console.log("❌ You are already registered!");
      rl.close(); return;
    }

    const confirm = await askQuestion(`\nRegister your wallet into vault? (yes/no): `);
    if (confirm.toLowerCase() !== "yes") {
      console.log("❌ Cancelled.");
      rl.close(); return;
    }

    const tx = await program.methods
      .registerDepositor()
      .accountsPartial({
        depositor: userKeypair.publicKey,
        vaultState: vaultStatePDA,
        depositorState: depositorStatePDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("\n✅ Registered successfully!");
    console.log("TX      :", tx);
    console.log("Explorer: https://explorer.solana.com/tx/" + tx + "?cluster=devnet");
  }

  // ─────────────────────────────────────────
  // OPTION 2 — Deposit
  // ─────────────────────────────────────────
  else if (choice === "2") {
    if (!isRegistered) {
      console.log("❌ You must register first! Run again and choose option 1.");
      rl.close(); return;
    }

    const amountInput = await askQuestion(`\nEnter amount to deposit in SOL (min ${minDepositSol} SOL, multiples only): `);
    const solAmount = parseFloat(amountInput);

    if (isNaN(solAmount) || solAmount <= 0) {
      console.log("❌ Invalid amount!");
      rl.close(); return;
    }

    const lamports = Math.round(solAmount * LAMPORTS_PER_SOL);

    if (lamports < minDepositLamports) {
      console.log("❌ Amount below minimum deposit of", minDepositSol, "SOL!");
      rl.close(); return;
    }

    if (lamports % minDepositLamports !== 0) {
      console.log("❌ Amount must be a multiple of", minDepositSol, "SOL!");
      rl.close(); return;
    }

    if (solBalance < lamports) {
      console.log("❌ Not enough SOL in your wallet!");
      rl.close(); return;
    }

    const unlockDate = new Date(Date.now() + Number(vaultState.lockPeriod) * 1000);
    console.log("\n⚠️  Your SOL will be locked until:", unlockDate.toLocaleString());

    const confirm = await askQuestion(`\nConfirm deposit of ${solAmount} SOL? (yes/no): `);
    if (confirm.toLowerCase() !== "yes") {
      console.log("❌ Deposit cancelled.");
      rl.close(); return;
    }

    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      connection, userKeypair, lpMintPDA, userKeypair.publicKey
    );

    const amount = new anchor.BN(lamports);
    const vaultBefore = vaultState.balance.toNumber();

    const tx = await program.methods
      .depositByDepositor(amount)
      .accountsPartial({
        depositor: userKeypair.publicKey,
        depositorState: depositorStatePDA,
        vaultState: vaultStatePDA,
        lpMint: lpMintPDA,
        depositorTokenAccount: tokenAccount.address,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const vaultAfter = (await program.account.vaultState.fetch(vaultStatePDA)).balance.toNumber();
    const lpBalance = await connection.getTokenAccountBalance(tokenAccount.address);
    const depState = await program.account.depositorState.fetch(depositorStatePDA);
    const lpMinted = lamports / minDepositLamports;

    console.log("\n═══════════════════════════════════════════");
    console.log("✅ Deposit successful!");
    console.log("───────────────────────────────────────────");
    console.log("Deposited     :", solAmount, "SOL");
    console.log("LP received   :", lpMinted, "LP tokens");
    console.log("Vault before  :", vaultBefore / LAMPORTS_PER_SOL, "SOL");
    console.log("Vault after   :", vaultAfter / LAMPORTS_PER_SOL, "SOL");
    console.log("Your LP total :", lpBalance.value.uiAmount, "LP");
    console.log("Unlock time   :", new Date(depState.unlockTime.toNumber() * 1000).toLocaleString());
    console.log("───────────────────────────────────────────");
    console.log("TX      :", tx);
    console.log("Explorer: https://explorer.solana.com/tx/" + tx + "?cluster=devnet");
    console.log("═══════════════════════════════════════════");
  }

  else if (choice === "3") {
    console.log("Goodbye!");
  } else {
    console.log("❌ Invalid choice!");
  }

  rl.close();
}
main().catch((e) => { console.error(e); rl.close(); });
