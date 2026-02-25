import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as Program<Vault>;
  const owner = provider.wallet.publicKey;

  const [vaultStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault7"), owner.toBuffer()],
    program.programId
  );
  const [lpMintPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint7"), owner.toBuffer()],
    program.programId
  );

  console.log("═══════════════════════════════════════════");
  console.log("         VAULT REGISTRATION");
  console.log("═══════════════════════════════════════════");
  console.log("Owner wallet  :", owner.toString());
  console.log("Vault PDA     :", vaultStatePDA.toString());
  console.log("LP Mint PDA   :", lpMintPDA.toString());
  console.log("───────────────────────────────────────────");

  // Check if already registered
  try {
    const existing = await program.account.vaultState.fetch(vaultStatePDA);
    console.log("⚠️  Vault already registered!");
    console.log("Balance     :", existing.balance.toNumber() / LAMPORTS_PER_SOL, "SOL");
    console.log("Lock period :", Number(existing.lockPeriod) / 86400, "days");
    console.log("Min deposit :", existing.minDeposit.toNumber() / LAMPORTS_PER_SOL, "SOL");
    console.log("═══════════════════════════════════════════");
    return;
  } catch (_) {
    console.log("No existing vault found — registering now...");
  }

  const tx = await program.methods
    .register()
    .accountsPartial({
      user: owner,
      vaultState: vaultStatePDA,
      lpMint: lpMintPDA,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  const state = await program.account.vaultState.fetch(vaultStatePDA);

  console.log("✅ Vault registered successfully!");
  console.log("───────────────────────────────────────────");
  console.log("Owner       :", state.owner.toString());
  console.log("Vault PDA   :", vaultStatePDA.toString());
  console.log("LP Mint     :", state.lpMint.toString());
  console.log("Balance     :", state.balance.toNumber(), "lamports");
  console.log("Lock period :", Number(state.lockPeriod) / 86400, "days");
  console.log("Min deposit :", state.minDeposit.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("───────────────────────────────────────────");
  console.log("TX      :", tx);
  console.log("Explorer: https://explorer.solana.com/tx/" + tx + "?cluster=devnet");
  console.log("═══════════════════════════════════════════");
}
main().catch(console.error);