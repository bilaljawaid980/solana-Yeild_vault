use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount};

declare_id!("H9HEHWSnZ4e4QnBZ7W8jQ8VQUUEEuTcCHQ5npaZCHMLC");

const FOUR_DAYS_IN_SECONDS: i64 = 4 * 24 * 60 * 60;
const DEFAULT_MIN_DEPOSIT: u64 = 100_000_000;
const MIN_LOCK_PERIOD: i64 = 120;
const MAX_LOCK_PERIOD: i64 = 30 * 24 * 60 * 60;

#[program]
pub mod vault {
    use super::*;

    pub fn register(ctx: Context<Register>) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.owner = ctx.accounts.user.key();
        vault_state.balance = 0;
        vault_state.bump = ctx.bumps.vault_state;
        vault_state.lp_mint = ctx.accounts.lp_mint.key();
        vault_state.lp_mint_bump = ctx.bumps.lp_mint;
        vault_state.lock_period = FOUR_DAYS_IN_SECONDS;
        vault_state.min_deposit = DEFAULT_MIN_DEPOSIT;
        vault_state.total_yield_added = 0;
        vault_state.fee_percent = 0;
        msg!("Vault registered for owner: {}", vault_state.owner);
        msg!("LP Mint created: {}", vault_state.lp_mint);
        msg!("Lock period: {} seconds (4 days)", vault_state.lock_period);
        msg!("Min deposit: {} lamports", vault_state.min_deposit);
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroDeposit);
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.vault_state.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, amount)?;
        ctx.accounts.vault_state.balance += amount;
        msg!("Owner deposited: {} lamports", amount);
        msg!("New vault balance: {} lamports", ctx.accounts.vault_state.balance);
        Ok(())
    }

    pub fn deposit_by_depositor(ctx: Context<DepositByDepositor>, amount: u64) -> Result<()> {
        let min_deposit = ctx.accounts.vault_state.min_deposit;
        require!(amount > 0, VaultError::ZeroDeposit);
        require!(amount >= min_deposit, VaultError::BelowMinDeposit);
        require!(amount % min_deposit == 0, VaultError::InvalidDepositAmount);

        let vault_balance_before = ctx.accounts.vault_state.balance;
        let lp_supply_before = ctx.accounts.lp_mint.supply;

        let lp_to_mint: u64 = if lp_supply_before == 0 || vault_balance_before == 0 {
            (amount / min_deposit) * 1_000_000_000u64
        } else {
            (amount as u128)
                .checked_mul(lp_supply_before as u128)
                .unwrap()
                .checked_div(vault_balance_before as u128)
                .unwrap() as u64
        };

        require!(lp_to_mint > 0, VaultError::ZeroLpMinted);

        let depositor_state = &mut ctx.accounts.depositor_state;
        if depositor_state.depositor == Pubkey::default() {
            depositor_state.depositor = ctx.accounts.depositor.key();
            depositor_state.vault_owner = ctx.accounts.vault_state.owner;
            depositor_state.bump = ctx.bumps.depositor_state;
            depositor_state.deposit_time = 0;
            depositor_state.unlock_time = 0;
            depositor_state.locked_amount = 0;
            depositor_state.lp_amount = 0;
            msg!("New depositor auto-registered: {}", depositor_state.depositor);
        }

        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.vault_state.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, amount)?;

        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;
        let lock_period = ctx.accounts.vault_state.lock_period;
        let vault_owner = ctx.accounts.vault_state.owner;
        let lp_mint_bump = ctx.accounts.vault_state.lp_mint_bump;

        ctx.accounts.vault_state.balance += amount;

        let depositor_state = &mut ctx.accounts.depositor_state;
        depositor_state.deposit_time = current_time;
        depositor_state.unlock_time = current_time + lock_period;
        depositor_state.locked_amount += amount;
        depositor_state.lp_amount += lp_to_mint;

        let seeds = &[b"lp_mint7", vault_owner.as_ref(), &[lp_mint_bump]];
        let signer_seeds = &[&seeds[..]];

        let mint_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.lp_mint.to_account_info(),
                to: ctx.accounts.depositor_token_account.to_account_info(),
                authority: ctx.accounts.lp_mint.to_account_info(),
            },
            signer_seeds,
        );
        token::mint_to(mint_ctx, lp_to_mint)?;

        msg!("Depositor sent      : {} lamports", amount);
        msg!("LP tokens minted    : {}", lp_to_mint);
        msg!("Vault balance before: {} lamports", vault_balance_before);
        msg!("LP supply before    : {}", lp_supply_before);
        msg!("Unlock time         : {}", depositor_state.unlock_time);
        msg!("New vault balance   : {} lamports", ctx.accounts.vault_state.balance);
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;
        let unlock_time = ctx.accounts.depositor_state.unlock_time;
        require!(current_time >= unlock_time, VaultError::FundsStillLocked);

        let lp_amount = ctx.accounts.depositor_state.lp_amount;
        let locked_amount = ctx.accounts.depositor_state.locked_amount;
        require!(lp_amount > 0, VaultError::NothingToWithdraw);

        let vault_balance = ctx.accounts.vault_state.balance;
        let lp_supply = ctx.accounts.lp_mint.supply;

        let sol_to_return = (lp_amount as u128)
            .checked_mul(vault_balance as u128)
            .unwrap()
            .checked_div(lp_supply as u128)
            .unwrap() as u64;

        require!(sol_to_return > 0, VaultError::NothingToWithdraw);
        require!(vault_balance >= sol_to_return, VaultError::NotEnoughFunds);

        // Burn LP tokens — authority is the depositor (token account owner)
        let burn_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.lp_mint.to_account_info(),
                from: ctx.accounts.depositor_token_account.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        );
        token::burn(burn_ctx, lp_amount)?;

        **ctx.accounts.vault_state.to_account_info().try_borrow_mut_lamports()? -= sol_to_return;
        **ctx.accounts.depositor.to_account_info().try_borrow_mut_lamports()? += sol_to_return;

        ctx.accounts.vault_state.balance -= sol_to_return;

        let yield_earned = sol_to_return.saturating_sub(locked_amount);

        ctx.accounts.depositor_state.locked_amount = 0;
        ctx.accounts.depositor_state.lp_amount = 0;
        ctx.accounts.depositor_state.deposit_time = 0;
        ctx.accounts.depositor_state.unlock_time = 0;

        msg!("Withdrawal successful!");
        msg!("Original deposit : {} lamports", locked_amount);
        msg!("SOL returned     : {} lamports", sol_to_return);
        msg!("Yield earned     : {} lamports", yield_earned);
        msg!("LP tokens burned : {}", lp_amount);
        msg!("New vault balance: {} lamports", ctx.accounts.vault_state.balance);
        Ok(())
    }

    pub fn add_yield(ctx: Context<AddYield>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroDeposit);
        let lp_supply = ctx.accounts.lp_mint.supply;
        require!(lp_supply > 0, VaultError::NoDepositors);

        let fee_percent = ctx.accounts.vault_state.fee_percent as u64;
        let vault_balance_before = ctx.accounts.vault_state.balance;

        let admin_cut = amount.checked_mul(fee_percent).unwrap().checked_div(100).unwrap();
        let depositor_yield = amount.checked_sub(admin_cut).unwrap();

        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.vault_state.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, amount)?;

        ctx.accounts.vault_state.balance += depositor_yield;
        ctx.accounts.vault_state.total_yield_added += depositor_yield;

        let new_lp_price = ctx.accounts.vault_state.balance.checked_div(lp_supply).unwrap_or(0);

        msg!("Yield added          : {} lamports", amount);
        msg!("Admin fee ({} %)    : {} lamports", fee_percent, admin_cut);
        msg!("Depositor yield      : {} lamports", depositor_yield);
        msg!("Vault balance before : {} lamports", vault_balance_before);
        msg!("Vault balance after  : {} lamports", ctx.accounts.vault_state.balance);
        msg!("Total LP supply      : {}", lp_supply);
        msg!("New LP price         : {} lamports per LP", new_lp_price);
        msg!("Total yield ever     : {} lamports", ctx.accounts.vault_state.total_yield_added);
        Ok(())
    }

    pub fn get_lp_value(ctx: Context<GetLpValue>) -> Result<()> {
        let vault_balance = ctx.accounts.vault_state.balance;
        let lp_supply = ctx.accounts.lp_mint.supply;
        let lp_price = if lp_supply > 0 {
            vault_balance.checked_div(lp_supply).unwrap_or(0)
        } else {
            ctx.accounts.vault_state.min_deposit
        };
        msg!("Vault SOL balance  : {} lamports", vault_balance);
        msg!("Total LP supply    : {} tokens", lp_supply);
        msg!("Current LP price   : {} lamports per LP", lp_price);
        msg!("Total yield added  : {} lamports", ctx.accounts.vault_state.total_yield_added);
        Ok(())
    }

    pub fn admin_transfer(ctx: Context<AdminTransfer>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroDeposit);
        require!(ctx.accounts.vault_state.balance >= amount, VaultError::NotEnoughFunds);

        **ctx.accounts.vault_state.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.destination.to_account_info().try_borrow_mut_lamports()? += amount;

        ctx.accounts.vault_state.balance -= amount;

        msg!("Admin transfer by: {}", ctx.accounts.owner.key());
        msg!("Destination      : {}", ctx.accounts.destination.key());
        msg!("Amount           : {} lamports", amount);
        msg!("New vault balance: {} lamports", ctx.accounts.vault_state.balance);
        Ok(())
    }

    pub fn update_settings(
        ctx: Context<UpdateSettings>,
        new_lock_period: i64,
        new_min_deposit: u64,
        new_fee_percent: u8,
    ) -> Result<()> {
        require!(
            new_lock_period >= MIN_LOCK_PERIOD && new_lock_period <= MAX_LOCK_PERIOD,
            VaultError::InvalidLockPeriod
        );
        require!(new_min_deposit > 0, VaultError::InvalidMinDeposit);
        require!(new_fee_percent <= 100, VaultError::InvalidFeePercent);

        let vault_state = &mut ctx.accounts.vault_state;
        let old_lock = vault_state.lock_period;
        let old_min = vault_state.min_deposit;
        let old_fee = vault_state.fee_percent;

        vault_state.lock_period = new_lock_period;
        vault_state.min_deposit = new_min_deposit;
        vault_state.fee_percent = new_fee_percent;

        msg!("Settings updated!");
        msg!("Lock period : {} → {} seconds", old_lock, new_lock_period);
        msg!("Min deposit : {} → {} lamports", old_min, new_min_deposit);
        msg!("Fee percent : {} → {} %", old_fee, new_fee_percent);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init,
        payer = user,
        space = VaultState::SIZE,
        seeds = [b"vault7", user.key().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        init,
        payer = user,
        mint::decimals = 9,
        mint::authority = lp_mint,
        seeds = [b"lp_mint7", user.key().as_ref()],
        bump
    )]
    pub lp_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault7", user.key().as_ref()],
        bump = vault_state.bump,
        constraint = vault_state.owner == user.key() @ VaultError::UnauthorizedUser
    )]
    pub vault_state: Account<'info, VaultState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositByDepositor<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(
        init_if_needed,
        payer = depositor,
        space = DepositorState::SIZE,
        seeds = [b"depositor7", depositor.key().as_ref(), vault_state.owner.as_ref()],
        bump
    )]
    pub depositor_state: Account<'info, DepositorState>,
    #[account(
        mut,
        seeds = [b"vault7", vault_state.owner.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"lp_mint7", vault_state.owner.as_ref()],
        bump = vault_state.lp_mint_bump,
    )]
    pub lp_mint: Account<'info, Mint>,
    #[account(mut)]
    pub depositor_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(
        mut,
        seeds = [b"depositor7", depositor.key().as_ref(), vault_state.owner.as_ref()],
        bump = depositor_state.bump,
        constraint = depositor_state.depositor == depositor.key() @ VaultError::UnauthorizedUser,
        constraint = depositor_state.vault_owner == vault_state.owner @ VaultError::WrongVault,
    )]
    pub depositor_state: Account<'info, DepositorState>,
    #[account(
        mut,
        seeds = [b"vault7", vault_state.owner.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"lp_mint7", vault_state.owner.as_ref()],
        bump = vault_state.lp_mint_bump,
    )]
    pub lp_mint: Account<'info, Mint>,
    #[account(mut)]
    pub depositor_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddYield<'info> {
    #[account(
        mut,
        constraint = owner.key() == vault_state.owner @ VaultError::UnauthorizedUser
    )]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault7", owner.key().as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        seeds = [b"lp_mint7", owner.key().as_ref()],
        bump = vault_state.lp_mint_bump,
    )]
    pub lp_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GetLpValue<'info> {
    #[account(
        seeds = [b"vault7", vault_state.owner.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        seeds = [b"lp_mint7", vault_state.owner.as_ref()],
        bump = vault_state.lp_mint_bump,
    )]
    pub lp_mint: Account<'info, Mint>,
}

#[derive(Accounts)]
pub struct AdminTransfer<'info> {
    #[account(
        mut,
        constraint = owner.key() == vault_state.owner @ VaultError::UnauthorizedUser
    )]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault7", owner.key().as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,
    /// CHECK: destination can be any wallet
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateSettings<'info> {
    #[account(
        mut,
        constraint = owner.key() == vault_state.owner @ VaultError::UnauthorizedUser
    )]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault7", owner.key().as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct VaultState {
    pub owner: Pubkey,           // 32
    pub balance: u64,            // 8
    pub bump: u8,                // 1
    pub lp_mint: Pubkey,         // 32
    pub lp_mint_bump: u8,        // 1
    pub lock_period: i64,        // 8
    pub min_deposit: u64,        // 8
    pub total_yield_added: u64,  // 8
    pub fee_percent: u8,         // 1
}

impl VaultState {
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 32 + 1 + 8 + 8 + 8 + 1;
}

#[account]
pub struct DepositorState {
    pub depositor: Pubkey,    // 32
    pub vault_owner: Pubkey,  // 32
    pub bump: u8,             // 1
    pub deposit_time: i64,    // 8
    pub unlock_time: i64,     // 8
    pub locked_amount: u64,   // 8
    pub lp_amount: u64,       // 8
}

impl DepositorState {
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 8 + 8 + 8 + 8;
}

#[error_code]
pub enum VaultError {
    #[msg("Deposit amount must be greater than zero")]
    ZeroDeposit,
    #[msg("You are not the owner of this vault")]
    UnauthorizedUser,
    #[msg("Depositor is not registered to this vault")]
    WrongVault,
    #[msg("Deposit must be a multiple of minimum deposit amount")]
    InvalidDepositAmount,
    #[msg("Deposit is below the minimum deposit amount")]
    BelowMinDeposit,
    #[msg("Funds are still locked, please wait until unlock time")]
    FundsStillLocked,
    #[msg("Nothing to withdraw")]
    NothingToWithdraw,
    #[msg("Vault does not have enough funds")]
    NotEnoughFunds,
    #[msg("Lock period must be between 120 seconds and 30 days")]
    InvalidLockPeriod,
    #[msg("Minimum deposit must be greater than zero")]
    InvalidMinDeposit,
    #[msg("Fee percent must be between 0 and 100")]
    InvalidFeePercent,
    #[msg("LP minted would be zero, deposit amount too small")]
    ZeroLpMinted,
    #[msg("No depositors in vault yet, cannot add yield")]
    NoDepositors,
}