//! Owner-gated admin configuration for the kDice contract.
//!
//! Ownership is granted to the deployer in the contract's `#[init]` (see
//! `lib.rs`) and the protocol metadata ships with sensible defaults. Every
//! admin endpoint below is gated behind `require_owner`.

use klever_sc::imports::*;

#[klever_sc::module]
pub trait UpgradeModule: crate::storage::StorageModule {
    /// Enforce that the current caller is the owner.
    ///
    /// The `owner` mapper is declared in `StorageModule` (see `storage.rs`);
    /// it is read here via the inherited `self.owner()` accessor.
    fn require_owner(&self) {
        let caller = self.blockchain().get_caller();
        require!(caller == self.owner().get(), "Not owner");
    }

    /// Admin: change the human-readable contract name.
    #[endpoint(setName)]
    fn set_name(&self, name: ManagedBuffer) {
        self.require_owner();
        require!(!name.is_empty(), "Contract name cannot be empty");
        self.contract_name().set(name);
    }

    /// Admin: change the per-player cap on simultaneously active commits.
    #[endpoint(setMaxActiveCommits)]
    fn set_max_active_commits(&self, max: u16) {
        self.require_owner();
        require!(max >= 1, "Max active commits must be >= 1");
        self.max_active_commits().set(max);
    }

    /// Admin: hand ownership to a new address.
    #[endpoint(transferOwner)]
    fn transfer_owner(&self, new_owner: ManagedAddress) {
        self.require_owner();
        self.owner().set(&new_owner);
    }
}
