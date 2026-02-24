import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as readline from "readline";

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
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as Program<Vault>;
  const owner = provider.wallet.publicKey;

  const [vaultStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault4"), owner.toBuffer()],
    program.programId
  );

  // Fetch current vault state
  const vaultState = await program.account.vaultState.fetch(vaultStatePDA);

  console.log("═══════════════════════════════════════════");
  console.log("         ADMIN TRANSFER");
  console.log("═══════════════════════════════════════════");
  console.log("Admin wallet  :", owner.toString());
  console.log("Vault balance :", vaultState.balance.toNumber() / LAMPORTS_PER_SOL, "SOL");
  console.log("Vault balance :", vaultState.balance.toString(), "lamports");
  console.log("═══════════════════════════════════════════");

  // Ask admin for destination address
  const destInput = await askQuestion("\nEnter destination wallet address: ");

  // Validate address
  let destination: PublicKey;
  try {
    destination = new PublicKey(destInput);
  } catch (e) {
    console.log("❌ Invalid wallet address!");
    return;
  }

  // Ask admin for amount
  const amountInput = await askQuestion("Enter amount to transfer (in SOL): ");
  const solAmount = parseFloat(amountInput);

  if (isNaN(solAmount) || solAmount <= 0) {
    console.log("❌ Invalid amount!");
    return;
  }

  const amount = new anchor.BN(solAmount * LAMPORTS_PER_SOL);

  // Check vault has enough
  if (vaultState.balance.toNumber() < solAmount * LAMPORTS_PER_SOL) {
    console.log("❌ Vault does not have enough funds!");
    console.log("Available:", vaultState.balance.toNumber() / LAMPORTS_PER_SOL, "SOL");
    return;
  }

  // Confirm
  const confirm = await askQuestion(
    `\nConfirm transfer of ${solAmount} SOL to ${destInput}? (yes/no): `
  );

  if (confirm.toLowerCase() !== "yes") {
    console.log("❌ Transfer cancelled.");
    return;
  }

  // Fetch balances before
  const vaultBefore = vaultState.balance.toNumber();
  const destBefore = await provider.connection.getBalance(destination);

  console.log("\n───────────────────────────────────────────");
  console.log("Processing transfer...");
  console.log("───────────────────────────────────────────");

  const tx = await program.methods
    .adminTransfer(amount)
    .accountsPartial({
      owner: owner,
      vaultState: vaultStatePDA,
      destination: destination,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  // Fetch balances after
  const vaultAfter = (await program.account.vaultState.fetch(vaultStatePDA)).balance.toNumber();
  const destAfter = await provider.connection.getBalance(destination);

  console.log("✅ Transfer successful!");
  console.log("───────────────────────────────────────────");
  console.log("Destination   :", destInput);
  console.log("Amount sent   :", solAmount, "SOL");
  console.log("Vault before  :", vaultBefore / LAMPORTS_PER_SOL, "SOL");
  console.log("Vault after   :", vaultAfter / LAMPORTS_PER_SOL, "SOL");
  console.log("Dest before   :", destBefore / LAMPORTS_PER_SOL, "SOL");
  console.log("Dest after    :", destAfter / LAMPORTS_PER_SOL, "SOL");
  console.log("───────────────────────────────────────────");
  console.log("TX      :", tx);
  console.log("Explorer: https://explorer.solana.com/tx/" + tx + "?cluster=devnet");
  console.log("═══════════════════════════════════════════");
}
main().catch(console.error);