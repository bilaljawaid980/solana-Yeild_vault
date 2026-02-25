import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import * as readline from "readline";
import fs from "fs";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const LP_DECIMALS = 9;
const LP_FACTOR = Math.pow(10, LP_DECIMALS); // 1_000_000_000

function askQuestion(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function formatLp(raw: bigint): string {
  const whole = raw / BigInt(LP_FACTOR);
  const frac = raw % BigInt(LP_FACTOR);
  const fracStr = frac.toString().padStart(LP_DECIMALS, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
}

async function main() {
  const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");

  console.log("═══════════════════════════════════════════");
  console.log("       VAULT DEPOSIT");
  console.log("═══════════════════════════════════════════");

  const walletPath = await askQuestion("Enter your wallet keypair path: ");
  if (!fs.existsSync(walletPath)) {
    console.log("❌ Wallet file not found:", walletPath);
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
    [Buffer.from("vault7"), vaultOwner.toBuffer()], program.programId
  );
  const [lpMintPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint7"), vaultOwner.toBuffer()], program.programId
  );
  const [depositorStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("depositor7"), userKeypair.publicKey.toBuffer(), vaultOwner.toBuffer()],
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
  const feePercent = vaultState.feePercent ?? 0;
  const vaultBalance = vaultState.balance.toNumber(); // lamports

  // ── Use RAW amount (not uiAmount) for all LP math ──
  const lpSupplyInfo = await connection.getTokenSupply(lpMintPDA);
  const lpSupplyRaw = BigInt(lpSupplyInfo.value.amount); // e.g. 3_000_000_000
  const lpSupplyUi = lpSupplyInfo.value.uiAmount || 0;   // e.g. 3.0 (display only)

  // Current elastic LP price in lamports per 1 whole LP (1 LP = LP_FACTOR raw)
  // price = vaultBalance / lpSupplyUi
  const currentLpPriceLamports = lpSupplyUi > 0 && vaultBalance > 0
    ? vaultBalance / lpSupplyUi
    : minDepositLamports;
  const currentLpPriceSol = currentLpPriceLamports / LAMPORTS_PER_SOL;

  let isFirstDeposit = false;
  try {
    await program.account.depositorState.fetch(depositorStatePDA);
  } catch (e) {
    isFirstDeposit = true;
  }

  console.log("───────────────────────────────────────────");
  console.log("VAULT INFO:");
  console.log("Vault owner   :", vaultOwner.toString());
  console.log("Vault balance :", vaultBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("Total LP      :", lpSupplyUi, "LP");
  console.log("LP price now  :", currentLpPriceSol.toFixed(9), "SOL per LP  ← elastic");
  console.log("Lock period   :", Number(vaultState.lockPeriod) / 86400, "days");
  console.log("Min deposit   :", minDepositSol, "SOL");
  console.log("Admin fee     :", feePercent, "% (taken from yield only)");
  console.log("───────────────────────────────────────────");
  console.log("YOUR INFO:");
  console.log("Your wallet   :", userKeypair.publicKey.toString());
  console.log("Your SOL bal  :", solBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("Status        :", isFirstDeposit ? "First deposit — account auto-created" : "Returning depositor");
  console.log("───────────────────────────────────────────");

  const amountInput = await askQuestion(
    `Enter amount to deposit in SOL (min ${minDepositSol} SOL, multiples of ${minDepositSol} only): `
  );
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
    console.log("   Valid amounts:", minDepositSol, "/", minDepositSol * 2, "/", minDepositSol * 3, "SOL etc");
    rl.close(); return;
  }

  if (solBalance < lamports + 10000) {
    console.log("❌ Not enough SOL in your wallet (need a little extra for fees)!");
    rl.close(); return;
  }

  // ── Calculate LP to receive using RAW bigint math ──
  // Formula: lpToMint = (lamports × lpSupplyRaw) / vaultBalance
  // First deposit: lpToMint = (lamports / minDeposit) × LP_FACTOR
  let lpToReceiveRaw: bigint;

  if (lpSupplyRaw === 0n || vaultBalance === 0) {
    // First ever deposit — simple formula
    lpToReceiveRaw = BigInt(Math.floor(lamports / minDepositLamports)) * BigInt(LP_FACTOR);
  } else {
    // Elastic formula — full precision with bigint
    lpToReceiveRaw = (BigInt(lamports) * lpSupplyRaw) / BigInt(vaultBalance);
  }

  if (lpToReceiveRaw === 0n) {
    // This should never happen now with decimals=9 and min 0.1 SOL
    // but guard anyway
    console.log("❌ Deposit too small — LP minted would be zero.");
    console.log("   Try a larger amount.");
    rl.close(); return;
  }

  const lpToReceiveUi = Number(lpToReceiveRaw) / LP_FACTOR;
  const shareAfter = lpSupplyUi > 0
    ? (lpToReceiveUi / (lpSupplyUi + lpToReceiveUi)) * 100
    : 100;

  const unlockDate = new Date(Date.now() + Number(vaultState.lockPeriod) * 1000);

  console.log("───────────────────────────────────────────");
  console.log("DEPOSIT SUMMARY:");
  console.log("Deposit amount :", solAmount, "SOL");
  console.log("LP to receive  :", formatLp(lpToReceiveRaw), "LP");
  console.log("LP price       :", currentLpPriceSol.toFixed(9), "SOL per LP");
  console.log("Vault share    :", shareAfter.toFixed(6), "% of vault after deposit");
  console.log("Unlock time    :", unlockDate.toLocaleString());
  console.log("Admin fee      :", feePercent, "% applies to yield only — NOT your deposit");
  console.log("───────────────────────────────────────────");
  console.log("NOTE: With 9 decimal LP tokens, any SOL amount >= min deposit");
  console.log("      always gets a proportional fractional LP share.");
  console.log("───────────────────────────────────────────");

  const confirm = await askQuestion("Confirm deposit? (yes/no): ");
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
  const lpBalanceInfo = await connection.getTokenAccountBalance(tokenAccount.address);
  const depState = await program.account.depositorState.fetch(depositorStatePDA);

  console.log("\n═══════════════════════════════════════════");
  console.log("✅ Deposit successful!");
  console.log("───────────────────────────────────────────");
  console.log("Deposited      :", solAmount, "SOL");
  console.log("LP received    :", formatLp(lpToReceiveRaw), "LP");
  console.log("Your LP total  :", lpBalanceInfo.value.uiAmount, "LP");
  console.log("LP price       :", currentLpPriceSol.toFixed(9), "SOL per LP");
  console.log("Vault before   :", vaultBefore / LAMPORTS_PER_SOL, "SOL");
  console.log("Vault after    :", vaultAfter / LAMPORTS_PER_SOL, "SOL");
  console.log("Unlock time    :", new Date(depState.unlockTime.toNumber() * 1000).toLocaleString());
  console.log("───────────────────────────────────────────");
  console.log("TX      :", tx);
  console.log("Explorer: https://explorer.solana.com/tx/" + tx + "?cluster=devnet");
  console.log("═══════════════════════════════════════════");

  rl.close();
}
main().catch((e) => { console.error(e); rl.close(); });
