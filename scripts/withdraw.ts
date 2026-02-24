import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import fs from "fs";
import * as readline from "readline";

async function askQuestion(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as Program<Vault>;

  console.log("═══════════════════════════════════════════");
  console.log("         WITHDRAW");
  console.log("═══════════════════════════════════════════");

  // Ask wallet path
  const walletPath = await askQuestion("Enter your wallet keypair path: ");

  if (!fs.existsSync(walletPath)) {
    console.log("❌ Wallet file not found:", walletPath);
    return;
  }

  const depositorKeypair = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );

  // Ask vault owner
  const vaultOwnerInput = await askQuestion("Enter vault owner address: ");
  let vaultOwner: PublicKey;
  try {
    vaultOwner = new PublicKey(vaultOwnerInput);
  } catch {
    console.log("❌ Invalid vault owner address!");
    return;
  }

  const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(depositorKeypair);
  const depositorProvider = new anchor.AnchorProvider(connection, wallet, {});
  const depositorProgram = new anchor.Program(program.idl, depositorProvider) as Program<Vault>;

  const [vaultStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault4"), vaultOwner.toBuffer()], program.programId
  );
  const [lpMintPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint4"), vaultOwner.toBuffer()], program.programId
  );
  const [depositorStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("depositor4"), depositorKeypair.publicKey.toBuffer(), vaultOwner.toBuffer()],
    program.programId
  );

  console.log("───────────────────────────────────────────");
  console.log("Wallet      :", depositorKeypair.publicKey.toString());
  console.log("Vault owner :", vaultOwner.toString());

  // Check depositor state exists
  let depState: any;
  try {
    depState = await depositorProgram.account.depositorState.fetch(depositorStatePDA);
  } catch {
    console.log("❌ This wallet is not registered in this vault!");
    console.log("   Run depositor-deposit.ts first to register.");
    return;
  }

  if (depState.lockedAmount.toNumber() === 0) {
    console.log("❌ Nothing to withdraw — no active deposit found.");
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const unlockTime = depState.unlockTime.toNumber();

  if (now < unlockTime) {
    const secondsLeft = unlockTime - now;
    const daysLeft = Math.floor(secondsLeft / 86400);
    const hoursLeft = Math.floor((secondsLeft % 86400) / 3600);
    const minsLeft = Math.floor((secondsLeft % 3600) / 60);
    console.log("───────────────────────────────────────────");
    console.log("🔒 Funds still locked!");
    console.log("Locked amount :", depState.lockedAmount.toNumber() / LAMPORTS_PER_SOL, "SOL");
    console.log("Unlock time   :", new Date(unlockTime * 1000).toLocaleString());
    console.log("Time left     :", daysLeft + "d " + hoursLeft + "h " + minsLeft + "m");
    console.log("═══════════════════════════════════════════");
    return;
  }

  // Funds unlocked — show summary and confirm
  const tokenAddress = await getAssociatedTokenAddress(lpMintPDA, depositorKeypair.publicKey);
  const solBefore = await connection.getBalance(depositorKeypair.publicKey);
  const lpBefore = (await connection.getTokenAccountBalance(tokenAddress)).value.uiAmount || 0;

  console.log("───────────────────────────────────────────");
  console.log("🔓 Funds are UNLOCKED — ready to withdraw!");
  console.log("Locked amount :", depState.lockedAmount.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("LP to burn    :", depState.lpAmount.toNumber(), "LP tokens");
  console.log("Wallet SOL    :", solBefore / LAMPORTS_PER_SOL, "SOL");
  console.log("───────────────────────────────────────────");

  const confirm = await askQuestion("Confirm withdrawal? (yes/no): ");
  if (confirm.toLowerCase() !== "yes") {
    console.log("❌ Cancelled.");
    return;
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

  const solAfter = await connection.getBalance(depositorKeypair.publicKey);
  const lpAfter = (await connection.getTokenAccountBalance(tokenAddress)).value.uiAmount || 0;

  console.log("═══════════════════════════════════════════");
  console.log("✅ Withdrawal successful!");
  console.log("───────────────────────────────────────────");
  console.log("SOL before    :", solBefore / LAMPORTS_PER_SOL, "SOL");
  console.log("SOL after     :", solAfter / LAMPORTS_PER_SOL, "SOL");
  console.log("SOL received  :", (solAfter - solBefore) / LAMPORTS_PER_SOL, "SOL");
  console.log("LP burned     :", lpBefore - (lpAfter || 0), "LP tokens");
  console.log("───────────────────────────────────────────");
  console.log("TX      :", tx);
  console.log("Explorer: https://explorer.solana.com/tx/" + tx + "?cluster=devnet");
  console.log("═══════════════════════════════════════════");
}
main().catch(console.error);