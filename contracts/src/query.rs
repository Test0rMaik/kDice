//! Read-only view functions for the dApp UI and off-chain reconciliation.

use crate::dice::{is_valid_multiplier, payout_per_100, target_for_multiplier, valid_target};
use crate::storage::{CommitRecord, RollRecord};
use klever_sc::imports::*;

#[klever_sc::module]
pub trait QueryModule: crate::storage::StorageModule {
    /// Human-readable contract name (admin-settable).
    #[view(getName)]
    fn get_name(&self) -> ManagedBuffer {
        self.contract_name().get()
    }

    /// Current protocol version marker.
    #[view(getProtocolVersion)]
    fn get_protocol_version(&self) -> u32 {
        self.protocol_version().get()
    }

    /// Total number of commits ever recorded.
    #[view(getCommitsCount)]
    fn get_commits_count(&self) -> u64 {
        self.commits_count().get()
    }

    /// Total number of settlements ever recorded.
    #[view(getRollsCount)]
    fn get_rolls_count(&self) -> u64 {
        self.rolls_count().get()
    }

    /// Hard cap on simultaneously active commits per player.
    #[view(getMaxActiveCommits)]
    fn get_max_active_commits(&self) -> u16 {
        self.max_active_commits().get()
    }

    /// The pending/active commit for a given game ID (reverts if absent).
    #[view(getCommit)]
    fn get_commit(&self, game_id: u64) -> CommitRecord<Self::Api> {
        let mapper = self.commit_record(game_id);
        require!(!mapper.is_empty(), "Commit not found");
        mapper.get()
    }

    /// The immutable settlement record for a given game ID (reverts if absent).
    #[view(getRoll)]
    fn get_roll(&self, game_id: u64) -> RollRecord<Self::Api> {
        let mapper = self.roll(game_id);
        require!(!mapper.is_empty(), "Roll not found");
        mapper.get()
    }

    /// Number of currently unsettled commits for a player.
    #[view(getActiveCommits)]
    fn get_active_commits(&self, player: ManagedAddress) -> u16 {
        self.active_commits(&player).get()
    }

    /// Highest roll that still wins for the given v1 multiplier (kept for
    /// v1 records). Reverts if the multiplier is not in the fixed set.
    #[view(getTarget)]
    fn get_target(&self, multiplier: u32) -> u32 {
        require!(is_valid_multiplier(multiplier), "Invalid multiplier");
        target_for_multiplier(multiplier)
    }

    /// Payout per 100 of stake (×100 precision) for a v2 bet — the
    /// continuous 5%-edge multiplier: `9500 / (over ? 100 - target : target)`.
    /// Reverts if the target is not in 1..99.
    #[view(getPayout)]
    fn get_payout(&self, target: u16, over: bool) -> u32 {
        require!(valid_target(target), "Target must be 1..99");
        payout_per_100(target, over)
    }
}
