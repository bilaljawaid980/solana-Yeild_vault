# SOL Yield Vault

A non-custodial, time-locked yield vault built on Solana using the Anchor framework. Depositors lock SOL for a configurable period and receive LP tokens representing their share of the vault. As the admin distributes yield, the LP token price increases elastically — automatically accruing returns to all existing holders without any action required on their part.

**Program ID:** `DmvnbCoGjvP8zfEZeBkrHft2EMQpkjuQ4wZq1AFt7dEL`  
**Network:** Solana Devnet  
**Framework:** Anchor v0.32.1

---

## Table of Contents

- [Architecture](#architecture)
- [How It Works](#how-it-works)
- [Instructions](#instructions)
- [Fee System](#fee-system)
- [CLI Scripts](#cli-scripts)
- [Quick Command Reference](#quick-command-reference)
- [Error Codes](#error-codes)
- [Development](#development)

---

## Architecture

The program uses three on-chain account types, all derived as PDAs:

| Account | Seeds | Purpose |
|---|---|---|
| `VaultState` | `vault5` + owner pubkey | Stores vault configuration and balance |
| `DepositorState` | `depositor5` + user pubkey + owner pubkey | Tracks each depositor's position |
| `LP Mint` | `lp_mint5` + owner pubkey | SPL token mint, decimals = 0 |

### VaultState Fields

| Field | Type | Description |
|---|---|---|
| `owner` | Pubkey | Admin wallet that controls the vault |
| `balance` | u64 | SOL held on behalf of depositors (lamports) |
| `lock_period` | i64 | Lock duration in seconds (default: 345600 = 4 days) |
| `min_deposit` | u64 | Minimum deposit amount and LP unit size (lamports) |
| `total_yield_added` | u64 | Cumulative yield distributed to depositors |
| `fee_percent` | u8 | Admin share of each yield deposit (0-100) |

---

## How It Works

### Elastic LP Pricing

The LP token price is not fixed. It is a ratio that adjusts automatically as yield is added:

```
LP Price = Vault Balance / Total LP Supply
```

**Deposit formula:**

```
If vault is empty:
    LP to mint = amount / min_deposit

If vault already has funds:
    LP to mint = (amount x total_lp_supply) / vault_balance
```

New depositors pay the current market price. This protects existing holders from dilution.

**Withdrawal formula:**

```
SOL to return = (lp_amount x vault_balance) / total_lp_supply
```

**Example:**

```
Initial state:
  Alice deposits 0.1 SOL  ->  receives 1 LP
  Bob   deposits 0.1 SOL  ->  receives 1 LP
  Vault: 0.2 SOL | LP supply: 2 | Price: 0.1 SOL per LP

Admin adds 0.1 SOL yield (fee = 10%):
  Admin cut         = 0.01 SOL
  Depositor yield   = 0.09 SOL  (added to vault balance)
  Vault: 0.29 SOL | LP supply: 2 | Price: 0.145 SOL per LP

Alice withdraws:
  SOL returned  = (1 x 0.29) / 2 = 0.145 SOL
  Original deposit:  0.1 SOL
  Yield earned:      0.045 SOL
```

---

## Instructions

### `register()`

Initializes a new vault for the caller. Creates `VaultState` and `LP Mint` PDAs. Can only be called once per admin wallet.

- Caller: Admin only
- Default lock period: 4 days (345600 seconds)
- Default min deposit: 0.1 SOL (100,000,000 lamports)
- Default fee percent: 0%

### `deposit_by_depositor(amount: u64)`

Public deposit instruction. Automatically creates a `DepositorState` on the first deposit — no prior registration required.

- Validates: `amount >= min_deposit` and `amount % min_deposit == 0`
- Mints LP tokens using the elastic formula
- Sets `unlock_time = current_time + lock_period`

### `withdraw()`

Withdraws SOL and burns LP tokens after the lock period expires.

- Requires: `current_time >= unlock_time`
- Returns elastic SOL amount including all yield earned
- Burns all LP tokens held by the depositor

### `add_yield(amount: u64)`

Admin-only. Deposits SOL as yield, applies the fee split, and increases vault balance — automatically raising the LP price for all holders.

- Caller: Admin only
- Requires LP supply > 0

### `update_settings(new_lock_period, new_min_deposit, new_fee_percent)`

Updates vault configuration. All three parameters are required.

- Caller: Admin only
- `new_fee_percent` must be between 0 and 100

### `admin_transfer(amount: u64)`

Transfers SOL from the vault balance to any destination wallet. Used to retrieve accumulated admin fee cuts.

- Caller: Admin only
- Requires `vault.balance >= amount`

### `deposit(amount: u64)`

Admin direct deposit. Adds SOL to vault balance without minting LP tokens.

---

## Fee System

The fee applies only to `add_yield()` calls. User deposits are never charged.

```
admin_cut       = yield_amount x fee_percent / 100
depositor_yield = yield_amount - admin_cut

vault.balance  += depositor_yield   (raises LP price for all holders)
admin_cut                           (recoverable via admin_transfer)
```

| fee_percent | Effect |
|---|---|
| 0% | 100% of yield goes to depositors |
| 10% | Admin keeps 10%, depositors receive 90% |
| 50% | Admin and depositors split equally |
| 100% | Admin keeps all yield, LP price does not increase |

---

## CLI Scripts

All scripts are in the `scripts/` directory. Run from the project root.

### Admin Scripts

**`register.ts`** — Initialize the vault

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
npx ts-node -P tsconfig.json scripts/register.ts
```

**`vault-state.ts`** — Full vault dashboard

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
npx ts-node -P tsconfig.json scripts/vault-state.ts
```

Shows vault balance, LP supply, current LP price, total yield added, fee settings, and admin transfer history.

**`vault-settings.ts`** — Update vault configuration

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
npx ts-node -P tsconfig.json scripts/vault-settings.ts
```

Interactive menu to update lock period, minimum deposit, and fee percentage.

**`add-yield.ts`** — Distribute yield to depositors

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
npx ts-node -P tsconfig.json scripts/add-yield.ts
```

Shows admin cut, depositor yield, and LP price impact before confirming.

**`vault-users.ts`** — View all depositor positions

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
npx ts-node -P tsconfig.json scripts/vault-users.ts
```

Shows per-user: LP tokens, vault share, original deposit, current elastic worth, yield earned, lock status.

**`admin-transfer.ts`** — Transfer SOL from vault

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
npx ts-node -P tsconfig.json scripts/admin-transfer.ts
```

### Depositor Scripts

**`owner-deposit.ts`** — Deposit SOL into vault

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/wallet2.json \
npx ts-node -P tsconfig.json scripts/owner-deposit.ts
```

Prompts for wallet path and vault owner address. Auto-registers on first deposit. Shows elastic LP calculation and unlock time before confirming.

**`my-account.ts`** — View your vault position

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/wallet2.json \
npx ts-node -P tsconfig.json scripts/my-account.ts
```

Shows LP tokens, vault share, original deposit, current elastic worth, yield earned, profit percentage, and lock countdown.

**`check-lock-time.ts`** — Check lock status

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/wallet2.json \
npx ts-node -P tsconfig.json scripts/check-lock-time.ts
```

**`withdraw.ts`** — Withdraw after lock expires

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/wallet2.json \
npx ts-node -P tsconfig.json scripts/withdraw.ts
```

If locked: shows current worth, yield earned to date, and exact unlock time.  
If unlocked: shows SOL to receive, yield earned, profit percentage, and requests confirmation.

---

## Quick Command Reference

| Script | Caller | Purpose |
|---|---|---|
| `register.ts` | Admin | Initialize vault |
| `vault-state.ts` | Admin | Full vault dashboard |
| `vault-settings.ts` | Admin | Update lock period, min deposit, fee |
| `add-yield.ts` | Admin | Distribute yield to LP holders |
| `vault-users.ts` | Admin | View all depositor positions |
| `admin-transfer.ts` | Admin | Transfer SOL from vault |
| `owner-deposit.ts` | Any | Deposit SOL |
| `my-account.ts` | Depositor | View personal position and earnings |
| `check-lock-time.ts` | Depositor | Check lock countdown |
| `withdraw.ts` | Depositor | Withdraw principal and yield after unlock |

---

## Error Codes

| Code | Description |
|---|---|
| `ZeroDeposit` | Amount must be greater than zero |
| `UnauthorizedUser` | Caller is not the vault owner |
| `WrongVault` | Depositor PDA does not belong to this vault |
| `InvalidDepositAmount` | Amount must be a multiple of min_deposit |
| `BelowMinDeposit` | Amount is less than min_deposit |
| `FundsStillLocked` | Unlock time has not been reached |
| `NothingToWithdraw` | No active deposit or LP balance is zero |
| `NotEnoughFunds` | Vault balance insufficient for requested transfer |
| `InvalidLockPeriod` | Lock period must be greater than zero |
| `InvalidMinDeposit` | Minimum deposit must be greater than zero |
| `InvalidFeePercent` | Fee percent must be between 0 and 100 |
| `ZeroLpMinted` | Deposit too small to mint LP tokens at current price |
| `NoDepositors` | LP supply is zero, cannot distribute yield |

---

## Development

### Prerequisites

- Rust
- Solana CLI
- Anchor CLI v0.32.1
- Node.js and Yarn

### Build

```bash
anchor build
```

### Deploy

```bash
anchor deploy
```

If the deploy fails due to network congestion:

```bash
solana program deploy target/deploy/vault.so \
  --url devnet \
  --with-compute-unit-price 50000
```

### Test

```bash
anchor test --skip-local-validator
```

### PDA Seed History

Each time `VaultState` grows in size, the PDA seeds are incremented to avoid conflicts with the existing on-chain account.

| Seeds | VaultState Size | Change |
|---|---|---|
| `vault3` / `lp_mint3` | 90 bytes | Initial versions |
| `vault4` / `lp_mint4` | 98 bytes | Added `min_deposit` |
| `vault5` / `lp_mint5` | 107 bytes | Added `total_yield_added` and `fee_percent` |

---

## License

MIT
