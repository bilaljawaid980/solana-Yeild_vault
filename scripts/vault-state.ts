import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

async function main() {
  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );
  const wallet = anchor.AnchorProvider.env().wallet;
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as Program<Vault>;
  const owner = provider.wallet.publicKey;

  const [vaultStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault4"), owner.toBuffer()], program.programId
  );
  const [lpMintPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint4"), owner.toBuffer()], program.programId
  );

  const state = await program.account.vaultState.fetch(vaultStatePDA);
  const lpSupply = await provider.connection.getTokenSupply(lpMintPDA);
  const ownerSolBalance = await provider.connection.getBalance(owner);

  const totalLp = lpSupply.value.uiAmount || 0;
  const vaultSolLamports = state.balance.toNumber();
  const vaultSol = vaultSolLamports / LAMPORTS_PER_SOL;

  console.log("═══════════════════════════════════════════");
  console.log("         VAULT CURRENT STATE");
  console.log("═══════════════════════════════════════════");
  console.log("Owner wallet  :", owner.toString());
  console.log("Owner SOL bal :", ownerSolBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("───────────────────────────────────────────");
  console.log("Vault PDA     :", vaultStatePDA.toString());
  console.log("LP Mint       :", state.lpMint.toString());
  console.log("───────────────────────────────────────────");
  console.log("Vault Balance :", vaultSolLamports, "lamports");
  console.log("Vault Balance :", vaultSol, "SOL");
  console.log("───────────────────────────────────────────");
  console.log("LP Distributed:", totalLp, "LP tokens");
  console.log("LP Value      : 1 LP = 0.1 SOL = 100,000,000 lamports");
  console.log("Total LP worth:", (totalLp * 0.1).toFixed(2), "SOL");
  console.log("───────────────────────────────────────────");
  console.log("Lock Period   :", state.lockPeriod.toString(), "seconds");
  console.log("Lock Period   :", Number(state.lockPeriod) / 86400, "days");

  // ─────────────────────────────────────────
  // Fetch admin transfer history from on-chain logs
  // ─────────────────────────────────────────
  console.log("───────────────────────────────────────────");
  console.log("       ADMIN TRANSFER HISTORY");
  console.log("───────────────────────────────────────────");

  const signatures = await provider.connection.getSignaturesForAddress(
    vaultStatePDA,
    { limit: 20 }
  );

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
        // log format: "Program log: Destination      : <address>"
        if (log.includes("Destination      :")) {
          const parts = log.split("Destination      :");
          destination = parts[1]?.trim() || "";
        }
        // log format: "Program log: Amount           : <number> lamports"
        if (log.includes("Amount           :")) {
          const parts = log.split("Amount           :");
          const raw = parts[1]?.trim() || "";
          amount = raw.replace("lamports", "").trim();
        }
      }

      const date = sig.blockTime
        ? new Date(sig.blockTime * 1000).toLocaleString()
        : "Unknown";

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
      console.log("  Amount      :", lamports, "lamports");
      console.log("  Amount      :", lamports / LAMPORTS_PER_SOL, "SOL");
      console.log("  TX          :", t.signature);
      console.log("  Explorer    : https://explorer.solana.com/tx/" + t.signature + "?cluster=devnet");
      if (i < adminTransfers.length - 1) console.log("  ─────────────────────────────────────");
    }
  }

  console.log("═══════════════════════════════════════════");
}
main().catch(console.error);