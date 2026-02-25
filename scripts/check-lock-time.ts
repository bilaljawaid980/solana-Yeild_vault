import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair } from "@solana/web3.js";
import fs from "fs";

async function main() {
  const depositorKeypair = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync("/root/.config/solana/wallet2.json", "utf-8")))
  );

  const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(depositorKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);

  const program = anchor.workspace.Vault as Program<Vault>;
  const vaultOwner = new PublicKey("7LA1ZMrc4j19sCSnXFmmiLvjo6KVWENwv9aS4oXYKq2E");

  const [depositorStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("depositor7"), depositorKeypair.publicKey.toBuffer(), vaultOwner.toBuffer()],
    program.programId
  );

  const state = await program.account.depositorState.fetch(depositorStatePDA);
  const now = Math.floor(Date.now() / 1000);
  const unlockTime = state.unlockTime.toNumber();
  const depositTime = state.depositTime.toNumber();
  const secondsLeft = unlockTime - now;
  const isLocked = secondsLeft > 0;

  const daysLeft = Math.floor(secondsLeft / 86400);
  const hoursLeft = Math.floor((secondsLeft % 86400) / 3600);
  const minutesLeft = Math.floor((secondsLeft % 3600) / 60);

  console.log("═══════════════════════════════════════════");
  console.log("         LOCK TIME STATUS");
  console.log("═══════════════════════════════════════════");
  console.log("Wallet       :", depositorKeypair.publicKey.toString());
  console.log("───────────────────────────────────────────");
  console.log("Deposit time :", depositTime === 0 ? "No deposit yet" : new Date(depositTime * 1000).toLocaleString());
  console.log("Unlock time  :", unlockTime === 0 ? "No deposit yet" : new Date(unlockTime * 1000).toLocaleString());
  console.log("───────────────────────────────────────────");
  if (depositTime === 0) {
    console.log("Status       : No active deposit");
  } else if (isLocked) {
    console.log("Status       : 🔒 LOCKED");
    console.log("Time left    :", daysLeft + "d " + hoursLeft + "h " + minutesLeft + "m");
  } else {
    console.log("Status       : 🔓 UNLOCKED — ready to withdraw!");
  }
  console.log("═══════════════════════════════════════════");
}
main().catch(console.error);