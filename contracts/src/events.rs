//! Emitted blockchain events. Kept minimal and index-friendly so explorers
//! and the off-chain dApp can cheaply subscribe to commit/settle activity.
//!
//! Indexed parameters are restricted to `u64` / `ManagedAddress` (both are
//! guaranteed indexable by the Klever event ABI).

#[klever_sc::module]
pub trait EventsModule {
    /// A new pending commit was recorded.
    ///
    /// `bet` (v1: multiplier {2,4,10,50}; v2: 100 + target*2 + over) is
    /// indexed so the event carries a single data argument (`stake`), as
    /// required by the `klever-sc-derive` 0.45.0 event ABI.
    #[event("commit")]
    fn commit_event(
        &self,
        #[indexed] game_id: u64,
        #[indexed] player: &ManagedAddress,
        #[indexed] bet: u32,
        stake: &BigUint,
    );

    /// A commit was settled; the deterministic roll and outcome are emitted.
    ///
    /// `roll` is indexed so the event carries a single data argument (`win`).
    #[event("settle")]
    fn settle_event(
        &self,
        #[indexed] game_id: u64,
        #[indexed] player: &ManagedAddress,
        #[indexed] roll: u32,
        win: bool,
    );
}
