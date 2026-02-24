import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as Program<Vault>;
  const vaultOwner = provider.wallet.publicKey;

  const [vaultStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault4"), vaultOwner.toBuffer()], program.programId
  );
  const [lpMintPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint4"), vaultOwner.toBuffer()], program.programId
  );

  const vaultState = await program.account.vaultState.fetch(vaultStatePDA);
  const lpSupply = await provider.connection.getTokenSupply(lpMintPDA);
  const totalLp = lpSupply.value.uiAmount || 0;
  const now = Math.floor(Date.now() / 1000);

  const allDepositors = (await program.account.depositorState.all([
    {
      memcmp: {
        offset: 8 + 32,
        bytes: vaultOwner.toBase58(),
      },
    },
  ])).filter((d) => {
    const [expectedPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("depositor4"), d.account.depositor.toBuffer(), vaultOwner.toBuffer()],
      program.programId
    );
    return expectedPDA.equals(d.publicKey);
  });

  console.log("═══════════════════════════════════════════════════════");
  console.log("              VAULT USERS");
  console.log("═══════════════════════════════════════════════════════");
  console.log("Vault owner   :", vaultOwner.toString());
  console.log("Vault balance :", Number(vaultState.balance) / LAMPORTS_PER_SOL, "SOL");
  console.log("Total LP      :", totalLp, "LP");
  console.log("Total users   :", allDepositors.length);
  console.log("───────────────────────────────────────────────────────");

  for (let i = 0; i < allDepositors.length; i++) {
    const d = allDepositors[i];
    const addr = d.account.depositor;

    let lpBalance = 0;
    try {
      const tokenAddr = await getAssociatedTokenAddress(lpMintPDA, addr);
      const bal = await provider.connection.getTokenAccountBalance(tokenAddr);
      lpBalance = bal.value.uiAmount || 0;
    } catch (_) {}

    const unlockTime = d.account.unlockTime.toNumber();
    const lockedAmount = d.account.lockedAmount.toNumber();
    const isLocked = now < unlockTime && lockedAmount > 0;
    const sharePercent = totalLp > 0 ? ((lpBalance / totalLp) * 100).toFixed(2) : "0";
    const secondsLeft = unlockTime - now;
    const daysLeft = Math.max(0, Math.floor(secondsLeft / 86400));
    const hoursLeft = Math.max(0, Math.floor((secondsLeft % 86400) / 3600));

    console.log("User #" + (i + 1));
    console.log("  Wallet       :", addr.toString());
    console.log("  Locked SOL   :", lockedAmount / LAMPORTS_PER_SOL, "SOL");
    console.log("  LP tokens    :", lpBalance, "LP");
    console.log("  Vault share  :", sharePercent, "%");
    console.log("  LP worth     :", (lpBalance * 0.1).toFixed(2), "SOL");
    console.log("  Lock status  :", isLocked ? "🔒 LOCKED (" + daysLeft + "d " + hoursLeft + "h left)" : lockedAmount === 0 ? "No active deposit" : "🔓 UNLOCKED");
    console.log("  Unlock time  :", unlockTime === 0 ? "N/A" : new Date(unlockTime * 1000).toLocaleString());
    console.log("───────────────────────────────────────────────────────");
  }
  console.log("═══════════════════════════════════════════════════════");
}
main().catch(console.error);