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
    [Buffer.from("vault7"), vaultOwner.toBuffer()], program.programId
  );
  const [lpMintPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint7"), vaultOwner.toBuffer()], program.programId
  );

  const vaultState = await program.account.vaultState.fetch(vaultStatePDA);
  const lpSupply = await provider.connection.getTokenSupply(lpMintPDA);
  const totalLp = lpSupply.value.uiAmount || 0;
  const now = Math.floor(Date.now() / 1000);

  const vaultBalance = (vaultState as any).balance.toNumber();
  const minDepositLamports = (vaultState as any).minDeposit.toNumber();
  const feePercent = (vaultState as any).feePercent ?? 0;
  const totalYieldAdded = (vaultState as any).totalYieldAdded?.toNumber() ?? 0;

  // Elastic LP price
  const currentLpPriceLamports = totalLp > 0 ? vaultBalance / totalLp : minDepositLamports;
  const currentLpPriceSol = currentLpPriceLamports / LAMPORTS_PER_SOL;

  const allDepositors = (await program.account.depositorState.all([
    {
      memcmp: {
        offset: 8 + 32,
        bytes: vaultOwner.toBase58(),
      },
    },
  ])).filter((d) => {
    const [expectedPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("depositor7"), d.account.depositor.toBuffer(), vaultOwner.toBuffer()],
      program.programId
    );
    return expectedPDA.equals(d.publicKey);
  });

  console.log("═══════════════════════════════════════════════════════");
  console.log("              VAULT USERS");
  console.log("═══════════════════════════════════════════════════════");
  console.log("Vault owner      :", vaultOwner.toString());
  console.log("───────────────────────────────────────────────────────");
  console.log("VAULT INFO:");
  console.log("Vault balance    :", vaultBalance / LAMPORTS_PER_SOL, "SOL");
  console.log("Total LP supply  :", totalLp, "LP");
  console.log("LP price (entry) :", minDepositLamports / LAMPORTS_PER_SOL, "SOL per LP");
  console.log("LP price (now)   :", currentLpPriceSol.toFixed(6), "SOL per LP  ← elastic");
  console.log("Total yield added:", totalYieldAdded / LAMPORTS_PER_SOL, "SOL");
  console.log("Admin fee        :", feePercent, "%");
  console.log("Total users      :", allDepositors.length);
  console.log("───────────────────────────────────────────────────────");

  for (let i = 0; i < allDepositors.length; i++) {
    const d = allDepositors[i];
    const addr = d.account.depositor;
    const lockedAmount = d.account.lockedAmount.toNumber();
    const unlockTime = d.account.unlockTime.toNumber();
    const depositTime = d.account.depositTime.toNumber();

    let lpBalance = 0;
    try {
      const tokenAddr = await getAssociatedTokenAddress(lpMintPDA, addr);
      const bal = await provider.connection.getTokenAccountBalance(tokenAddr);
      lpBalance = bal.value.uiAmount || 0;
    } catch (_) {}

    // Elastic worth = (lpBalance × vaultBalance) / totalLp
    const lpWorthLamports = totalLp > 0 ? (lpBalance * vaultBalance) / totalLp : 0;
    const lpWorthSol = lpWorthLamports / LAMPORTS_PER_SOL;
    const yieldEarned = lpWorthLamports - lockedAmount;
    const profitPercent = lockedAmount > 0 ? ((yieldEarned / lockedAmount) * 100).toFixed(4) : "0";
    const sharePercent = totalLp > 0 ? ((lpBalance / totalLp) * 100).toFixed(2) : "0";

    const isLocked = now < unlockTime && lockedAmount > 0;
    const secondsLeft = unlockTime - now;
    const daysLeft = Math.max(0, Math.floor(secondsLeft / 86400));
    const hoursLeft = Math.max(0, Math.floor((secondsLeft % 86400) / 3600));
    const minsLeft = Math.max(0, Math.floor((secondsLeft % 3600) / 60));

    console.log("User #" + (i + 1));
    console.log("  Wallet         :", addr.toString());
    console.log("  ─────────────────────────────────────────────────");
    console.log("  POSITION:");
    console.log("  LP tokens       :", lpBalance, "LP");
    console.log("  Vault share     :", sharePercent, "%");
    console.log("  Original deposit:", lockedAmount / LAMPORTS_PER_SOL, "SOL");
    console.log("  Current worth   :", lpWorthSol.toFixed(6), "SOL  ← elastic");
    console.log("  Yield earned    :", yieldEarned > 0 ? (yieldEarned / LAMPORTS_PER_SOL).toFixed(6) : "0", "SOL 🎉");
    console.log("  Profit %        :", profitPercent, "%");
    console.log("  ─────────────────────────────────────────────────");
    console.log("  LOCK STATUS:");
    if (lockedAmount === 0) {
      console.log("  Status          : No active deposit");
    } else if (isLocked) {
      console.log("  Status          : 🔒 LOCKED");
      console.log("  Deposit time    :", new Date(depositTime * 1000).toLocaleString());
      console.log("  Unlock time     :", new Date(unlockTime * 1000).toLocaleString());
      console.log("  Time left       :", daysLeft + "d " + hoursLeft + "h " + minsLeft + "m");
      console.log("  Will receive    :", lpWorthSol.toFixed(6), "SOL at unlock");
    } else {
      console.log("  Status          : 🔓 UNLOCKED — ready to withdraw!");
      console.log("  Will receive    :", lpWorthSol.toFixed(6), "SOL");
    }
    console.log("───────────────────────────────────────────────────────");
  }
  console.log("═══════════════════════════════════════════════════════");
}
main().catch(console.error);
