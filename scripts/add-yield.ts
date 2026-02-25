import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as readline from "readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function askQuestion(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as Program<Vault>;
  const owner = provider.wallet.publicKey;

  const [vaultStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault7"), owner.toBuffer()], program.programId
  );
  const [lpMintPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint7"), owner.toBuffer()], program.programId
  );

  const state = await program.account.vaultState.fetch(vaultStatePDA);
  const lpSupply = await provider.connection.getTokenSupply(lpMintPDA);
  const ownerBalance = await provider.connection.getBalance(owner);

  const totalLp = lpSupply.value.uiAmount || 0;
  const vaultBalance = state.balance.toNumber();
  const feePercent = (state as any).feePercent ?? 0;
  const currentLpPrice = totalLp > 0 ? vaultBalance / totalLp : state.minDeposit.toNumber();

  console.log("═══════════════════════════════════════════");
  console.log("         ADD YIELD");
  console.log("═══════════════════════════════════════════");
  console.log("Admin wallet     :", owner.toString());
  console.log("Your SOL balance :", ownerBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("───────────────────────────────────────────");
  console.log("VAULT STATUS:");
  console.log("Vault balance    :", vaultBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("Total LP supply  :", totalLp, "LP tokens");
  console.log("Current LP price :", currentLpPrice / LAMPORTS_PER_SOL, "SOL per LP");
  console.log("Total yield added:", state.totalYieldAdded.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("Admin fee        :", feePercent, "%");
  console.log("───────────────────────────────────────────");

  if (totalLp === 0) {
    console.log("❌ No depositors in vault yet! Cannot add yield.");
    rl.close(); return;
  }

  const amountInput = await askQuestion("Enter yield amount in SOL (e.g. 0.1, 0.5, 1): ");
  const solAmount = parseFloat(amountInput);

  if (isNaN(solAmount) || solAmount <= 0) {
    console.log("❌ Invalid amount!");
    rl.close(); return;
  }

  const lamports = Math.round(solAmount * LAMPORTS_PER_SOL);

  if (ownerBalance < lamports + 5000000) {
    console.log("❌ Not enough SOL in admin wallet!");
    rl.close(); return;
  }

  // Calculate impact
  const adminCut = Math.floor(lamports * feePercent / 100);
  const depositorYield = lamports - adminCut;
  const newVaultBalance = vaultBalance + depositorYield;
  const newLpPrice = totalLp > 0 ? newVaultBalance / totalLp : currentLpPrice;

  console.log("───────────────────────────────────────────");
  console.log("YIELD BREAKDOWN:");
  console.log("Total yield      :", solAmount, "SOL");
  console.log("Admin cut (" + feePercent + "%)   :", adminCut / LAMPORTS_PER_SOL, "SOL");
  console.log("To depositors    :", depositorYield / LAMPORTS_PER_SOL, "SOL");
  console.log("───────────────────────────────────────────");
  console.log("IMPACT ON LP PRICE:");
  console.log("LP price before  :", currentLpPrice / LAMPORTS_PER_SOL, "SOL per LP");
  console.log("LP price after   :", newLpPrice / LAMPORTS_PER_SOL, "SOL per LP");
  console.log("Price increase   :", ((newLpPrice - currentLpPrice) / LAMPORTS_PER_SOL).toFixed(6), "SOL per LP");
  console.log("───────────────────────────────────────────");

  const confirm = await askQuestion("Confirm adding yield? (yes/no): ");
  if (confirm.toLowerCase() !== "yes") {
    console.log("❌ Cancelled.");
    rl.close(); return;
  }

  const tx = await program.methods
    .addYield(new anchor.BN(lamports))
    .accountsPartial({
      owner: owner,
      vaultState: vaultStatePDA,
      lpMint: lpMintPDA,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  const updatedState = await program.account.vaultState.fetch(vaultStatePDA);
  const updatedLpSupply = await provider.connection.getTokenSupply(lpMintPDA);
  const updatedTotalLp = updatedLpSupply.value.uiAmount || 0;
  const updatedBalance = updatedState.balance.toNumber();
  const updatedLpPrice = updatedTotalLp > 0 ? updatedBalance / updatedTotalLp : 0;

  console.log("\n═══════════════════════════════════════════");
  console.log("✅ Yield added successfully!");
  console.log("───────────────────────────────────────────");
  console.log("Yield deposited  :", solAmount, "SOL");
  console.log("Admin kept       :", adminCut / LAMPORTS_PER_SOL, "SOL");
  console.log("Depositors got   :", depositorYield / LAMPORTS_PER_SOL, "SOL");
  console.log("New vault balance:", updatedBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("New LP price     :", updatedLpPrice / LAMPORTS_PER_SOL, "SOL per LP");
  console.log("Total yield ever :", updatedState.totalYieldAdded.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("───────────────────────────────────────────");
  console.log("TX      :", tx);
  console.log("Explorer: https://explorer.solana.com/tx/" + tx + "?cluster=devnet");
  console.log("═══════════════════════════════════════════");

  rl.close();
}
main().catch((e) => { console.error(e); rl.close(); });