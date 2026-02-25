import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

async function main() {
  const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = anchor.AnchorProvider.env().wallet;
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
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
  const ownerSolBalance = await provider.connection.getBalance(owner);

  const totalLp = lpSupply.value.uiAmount || 0;
  const vaultBalance = state.balance.toNumber();
  const minDepositLamports = state.minDeposit.toNumber();
  const feePercent = (state as any).feePercent ?? 0;
  const totalYieldAdded = (state as any).totalYieldAdded?.toNumber() ?? 0;

  // Elastic LP price
  const currentLpPriceLamports = totalLp > 0 ? vaultBalance / totalLp : minDepositLamports;
  const currentLpPriceSol = currentLpPriceLamports / LAMPORTS_PER_SOL;

  // Total LP worth at current elastic price
  const totalLpWorthSol = totalLp > 0 ? (totalLp * vaultBalance) / totalLp / LAMPORTS_PER_SOL : 0;

  console.log("═══════════════════════════════════════════");
  console.log("         VAULT CURRENT STATE");
  console.log("═══════════════════════════════════════════");
  console.log("Owner wallet     :", owner.toString());
  console.log("Owner SOL bal    :", ownerSolBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("───────────────────────────────────────────");
  console.log("ADDRESSES:");
  console.log("Vault PDA        :", vaultStatePDA.toString());
  console.log("LP Mint          :", state.lpMint.toString());
  console.log("───────────────────────────────────────────");
  console.log("VAULT BALANCE:");
  console.log("Vault balance    :", vaultBalance, "lamports");
  console.log("Vault balance    :", vaultBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("───────────────────────────────────────────");
  console.log("LP TOKEN INFO:");
  console.log("Total LP supply  :", totalLp, "LP tokens");
  console.log("LP price (entry) :", minDepositLamports / LAMPORTS_PER_SOL, "SOL  ← min deposit");
  console.log("LP price (now)   :", currentLpPriceSol.toFixed(6), "SOL  ← elastic (includes yield)");
  console.log("Total LP worth   :", totalLpWorthSol.toFixed(6), "SOL");
  console.log("───────────────────────────────────────────");
  console.log("YIELD INFO:");
  console.log("Total yield added:", totalYieldAdded / LAMPORTS_PER_SOL, "SOL");
  console.log("Admin fee        :", feePercent, "% (kept by admin from each yield deposit)");
  console.log("Depositor share  :", 100 - feePercent, "% (goes to LP holders)");
  console.log("───────────────────────────────────────────");
  console.log("VAULT RULES:");
  console.log("Lock period      :", Number(state.lockPeriod), "seconds");
  console.log("Lock period      :", Number(state.lockPeriod) / 86400, "days");
  console.log("Min deposit      :", minDepositLamports / LAMPORTS_PER_SOL, "SOL");

  // ─────────────────────────────────────────
  // Admin Transfer History
  // ─────────────────────────────────────────
  console.log("───────────────────────────────────────────");
  console.log("       ADMIN TRANSFER HISTORY");
  console.log("───────────────────────────────────────────");

  const signatures = await provider.connection.getSignaturesForAddress(vaultStatePDA, { limit: 20 });
  const adminTransfers: any[] = [];

  for (const sig of signatures) {
    const tx = await provider.connection.getParsedTransaction(sig.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.meta) continue;
    const logs = tx.meta.logMessages || [];
    const isAdminTransfer = logs.some(log => log.includes("Instruction: AdminTransfer"));

    if (isAdminTransfer) {
      let destination = "";
      let amount = "";
      for (const log of logs) {
        if (log.includes("Destination      :")) {
          destination = log.split("Destination      :")[1]?.trim() || "";
        }
        if (log.includes("Amount           :")) {
          amount = log.split("Amount           :")[1]?.trim().replace("lamports", "").trim() || "";
        }
      }
      const date = sig.blockTime ? new Date(sig.blockTime * 1000).toLocaleString() : "Unknown";
      adminTransfers.push({ date, destination, amount, signature: sig.signature });
    }
  }

  if (adminTransfers.length === 0) {
    console.log("No admin transfers found.");
  } else {
    for (let i = 0; i < adminTransfers.length; i++) {
      const t = adminTransfers[i];
      const lamports = parseInt(t.amount) || 0;
      console.log(`Transfer #${i + 1}`);
      console.log("  Date        :", t.date);
      console.log("  Destination :", t.destination);
      console.log("  Amount      :", lamports / LAMPORTS_PER_SOL, "SOL (", lamports, "lamports )");
      console.log("  TX          : https://explorer.solana.com/tx/" + t.signature + "?cluster=devnet");
      if (i < adminTransfers.length - 1) console.log("  ─────────────────────────────────────");
    }
  }

  console.log("═══════════════════════════════════════════");
}
main().catch(console.error);