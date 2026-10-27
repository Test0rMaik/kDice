//! On-chain storage: config, commit records, and settlement (roll) records.
//!
//! kDice is a record-only contract — it never holds or moves funds (the
//! ROADMAP moved all payout logic to off-chain dApp/server reconciliation).
//! The on-chain role is a verifiable, immutable history of:
//!
//! - **commits** — the bet (v1 multiplier or v2 target+side) and stake, plus
//!   the entropy source that determines the roll. In v3 (Phase 7) this is the
//!   48-byte confirming-block random seed, from which `dice::derive_roll`
//!   derives the d100 roll mixed with the game id;
//! - **settlements** — the deterministic d100 roll, the win/loss outcome and
//!   the block timestamp, written in the SAME transaction as the commit.
//!
//! Storage mappers are namespaced by `#[storage_mapper("<key>")]` exactly as
//! in the Ogmara reference contract.

use klever_sc::derive_imports::*;
use klever_sc::imports::*;

/// Active commit: a stake that has been committed but not yet settled.
#[type_abi]
#[derive(TopEncode, TopDecode, NestedEncode, NestedDecode)]
pub struct CommitRecord<M: ManagedTypeApi> {
    /// The player who created this commit (caller of `commit`).
    pub player: ManagedAddress<M>,
    /// Multiplier at commit time — the winning threshold derives from it.
    ///
    /// v2 (Phase 4.10) reuses this field as a **versioned bet encoding** so
    /// the storage schema stays byte-identical across the in-place upgrade:
    /// v1 records hold a multiplier `{2, 4, 10, 50}` (under at 47/23/9/1);
    /// v2 records hold `100 + target*2 + over` (target 1..99). The ranges
    /// are disjoint — see `dice::bet_target_and_side` for the decoder.
    pub multiplier: u32,
    /// Stake in smallest KLV units (0 = "free" record commit).
    pub stake: BigUint<M>,
    /// Entropy source for the roll. v1/v2: the 32-byte SHA256 commitment over
    /// the client seeds. v3 (Phase 7): the 48-byte confirming-block random
    /// seed, from which the roll is derived via `dice::derive_roll(seed, id)` —
    /// the dApp re-derives the roll from these bytes to prove fairness.
    pub hash: ManagedBuffer<M>,
    /// Block timestamp of the commit.
    pub created_at: u64,
    /// Whether this commit is still pending settlement. Always false in v3
    /// (Phase 7) — the game settles in the same transaction as the commit;
    /// the field is retained for record-schema stability across upgrades.
    pub active: bool,
}

/// Settlement record: the immutable, verifiable outcome of one game.
#[type_abi]
#[derive(TopEncode, TopDecode, NestedEncode, NestedDecode)]
pub struct RollRecord<M: ManagedTypeApi> {
    /// Roll result in the inclusive range `[1, 100]`.
    pub roll: u32,
    /// Whether the roll beat the target derived from `multiplier`.
    pub win: bool,
    /// Multiplier the game was committed with.
    pub multiplier: u32,
    /// Stake in smallest KLV units (echoed from the commit record).
    pub stake: BigUint<M>,
    /// Block timestamp of the settlement.
    pub settled_at: u64,
}

#[klever_sc::module]
pub trait StorageModule {
    // --- Protocol / admin config ---

    /// Contract owner (admin). Set to the deployer in `init`; gates `upgrade`
    /// and the admin setters via `require_owner`.
    #[storage_mapper("owner")]
    fn owner(&self) -> SingleValueMapper<ManagedAddress<Self::Api>>;

    /// Protocol version marker, bumped on every `upgrade()` pass.
    #[storage_mapper("protocolVersion")]
    fn protocol_version(&self) -> SingleValueMapper<u32>;

    /// Human-readable contract name (admin-settable).
    #[storage_mapper("contractName")]
    fn contract_name(&self) -> SingleValueMapper<ManagedBuffer<Self::Api>>;

    /// Hard cap on simultaneously *active* (unsettled) commits per player.
    #[storage_mapper("maxActiveCommits")]
    fn max_active_commits(&self) -> SingleValueMapper<u16>;

    /// Total number of commits ever recorded (monotonic counter).
    #[storage_mapper("commitsCount")]
    fn commits_count(&self) -> SingleValueMapper<u64>;

    /// Total number of settlements ever recorded (monotonic counter).
    #[storage_mapper("rollsCount")]
    fn rolls_count(&self) -> SingleValueMapper<u64>;

    // --- Per-game records ---

    /// Active-commit bookkeeping: per-player count of unsettled commits.
    #[storage_mapper("activeCommits")]
    fn active_commits(&self, player: &ManagedAddress) -> SingleValueMapper<u16>;

    /// Maps commit ID → the pending/active commit record.
    ///
    /// NOTE: named `commit_record` (not `commit`) because the `commit`
    /// endpoint in `CommitModule` would otherwise shadow it — Rust method
    /// resolution prefers the trait's own `commit` function, which breaks
    /// `self.commit(id).set(...)`. The on-chain storage key is unchanged.
    #[storage_mapper("commit")]
    fn commit_record(&self, id: u64) -> SingleValueMapper<CommitRecord<Self::Api>>;

    /// Maps commit ID → the immutable settlement (roll) record.
    #[storage_mapper("roll")]
    fn roll(&self, id: u64) -> SingleValueMapper<RollRecord<Self::Api>>;
}
