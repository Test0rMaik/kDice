//! kDice — a record-only, verifiable d100 chain-random bet contract.
//!
//! This contract mirrors the deterministic dice engine in `src/engine/fair.ts`
//! but deliberately moves **all** fund handling off-chain (see ROADMAP): the
//! on-chain role is to create an immutable, tamper-evident history of each
//! bet and its deterministic roll + win/loss outcome. Payout reconciliation
//! is performed by the dApp / game server.
//!
//! Protocol v3 (Phase 7, chain-random commit): a single
//! `commit(target, over, stake)` transaction settles the game immediately.
//! The d100 roll is derived from the **confirming block's consensus random
//! seed** (48 bytes, produced by the Klever validator set and unknown to the
//! caller at sign-time) mixed with the assigned game id — so the player
//! commits blind and cannot pre-roll or cherry-pick. There is no `settle`
//! endpoint and no client seed reveal: the roll is reproducible off-chain
//! from the public block seed + the on-chain game id alone.
//!
//! Module layout (follows the Ogmara reference contract):
//! - `storage`  — mappers + record types
//! - `dice`     — pure, shared d100 / target math (unit-tested)
//! - `commit`   — the single `commit` endpoint (commit + settle in one tx)
//! - `upgrade`  — `upgrade` + admin setters (owner-gated)
//! - `query`    — read-only views
//! - `events`   — emitted blockchain events
//! - `lib`      — composes the `KDiceContract` trait (this file)

#![no_std]
#![allow(clippy::arithmetic_side_effects)]

pub mod dice;
pub mod events;
pub mod query;
pub mod storage;
pub mod upgrade;

pub mod commit;

/// Contract assembly.
///
/// `#[klever_sc::contract]` aggregates every `#[klever_sc::module]` listed in
/// the super-traits into a single deployable contract object. Per the 0.45.0
/// pattern, `#[init]` (runs once on first deploy) and `#[upgrade]` (runs on
/// every redeploy) are declared in this trait body.
#[klever_sc::contract]
pub trait KDiceContract:
    crate::storage::StorageModule
    + crate::commit::CommitModule
    + crate::upgrade::UpgradeModule
    + crate::query::QueryModule
    + crate::events::EventsModule
{
    /// Runs once on first deploy: grant ownership to the deployer and seed the
    /// protocol metadata with sensible defaults. A fresh deploy is already
    /// protocol v3 (chain-random commit).
    #[init]
    fn init(&self) {
        let caller = self.blockchain().get_caller();
        self.owner().set(&caller);
        self.protocol_version().set(3u32);
        self.contract_name().set(ManagedBuffer::from("kDice"));
        self.max_active_commits().set(100u16);
    }

    /// Runs on every redeploy: the storage schema is forward-compatible —
    /// `CommitRecord.multiplier` is a versioned bet encoding (see
    /// `dice::bet_target_and_side`) and `CommitRecord.hash` now carries the
    /// 48-byte block random seed instead of a 32-byte player commitment, so
    /// existing commits / rolls / counters remain readable. Bumps the protocol
    /// marker to 3 (Phase 7, chain-random commit).
    #[upgrade]
    fn upgrade(&self) {
        self.protocol_version().set(3u32);
    }
}
