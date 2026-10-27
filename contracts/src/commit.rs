//! `commit` endpoint — Phase 7: single-transaction "chain-random commit".
//!
//! The player sends ONE transaction (bet + stake). The contract derives the
//! d100 roll from the **confirming block's consensus random seed** (48 bytes,
//! produced by the Klever validator set and UNKNOWN to the caller at sign-time)
//! mixed with the assigned game id:
//!
//! `d100 = LE_u32(sha256(block_random_seed ‖ game_id_le64)[0..4]) % 100 + 1`
//!
//! Because the block that confirms this transaction does not exist yet when
//! the player signs it, the player commits BLIND to the seed and cannot
//! pre-roll / cherry-pick the outcome. The roll record is written in the same
//! transaction, so there is no second `settle` call and no reveal of client
//! seeds. The 48-byte block seed is stored in the commit record's `hash` field
//! so the dApp's ProvablyFair panel can re-derive the roll off-chain from
//! `(seed, game id)` and compare it to the on-chain roll.
//!
//! Record-only: no KLV moves (payouts reconcile off-chain — see storage.rs).

use crate::dice::{derive_roll, encode_bet, valid_target};
use crate::storage::{CommitRecord, RollRecord};
use klever_sc::imports::*;

/// v2 encoded bet values start at 102, so any value < 102 is a legacy v1
/// multiplier (kept for the "encoded-bet" invariant test below).
#[cfg(test)]
const V2_MIN_ENCODED_BET: u16 = 102;

#[klever_sc::module]
pub trait CommitModule: crate::storage::StorageModule + crate::events::EventsModule {
    /// Place a bet and settle it in a single transaction.
    ///
    /// `target` is the win line on the d100 (1..99); `over` selects the side:
    /// under wins `roll <= target`, over wins `roll > target`. The roll is
    /// derived from the confirming block's random seed + the assigned id, so
    /// the outcome is fixed by the chain — the caller cannot influence it.
    /// Returns the newly assigned game id.
    #[endpoint(commit)]
    fn commit(&self, target: u16, over: bool, stake: BigUint) -> u64 {
        require!(valid_target(target), "Target must be 1..99");
        require!(stake > 0, "Stake must be positive");

        let player = self.blockchain().get_caller();
        let id = self.commits_count().get() + 1;
        let now = self.blockchain().get_block_timestamp();
        let bet = encode_bet(target, over);

        // Chain-random entropy: the CONFIRMING block's 48-byte seed. It is
        // unknown to the caller at sign-time → the player commits blind →
        // no cherry-picking / pre-rolling. Mixed with the id so two games in
        // the same block still derive independent rolls.
        let block_seed = self.blockchain().get_block_random_seed().to_byte_array();
        let roll = derive_roll(&block_seed, id);
        let win = if over { roll > target as u32 } else { roll <= target as u32 };

        // Commit record. v3 repurposes `hash` to carry the 48-byte block seed
        // (the entropy source) instead of a 32-byte player commitment — this
        // is what the dApp re-derives the roll from. `active` is false: the
        // game settles in this same transaction (no second `settle` call).
        let record = CommitRecord::<Self::Api> {
            player: player.clone(),
            multiplier: bet,
            stake: stake.clone(),
            hash: ManagedBuffer::from(block_seed.as_slice()),
            created_at: now,
            active: false,
        };
        self.commit_record(id).set(record);
        self.commits_count().set(id);

        // Emit the commit event before `stake` is moved into the roll record.
        self.commit_event(id, &player, bet, &stake);

        // Roll record — written in the SAME transaction (no second `settle`).
        let roll_record = RollRecord::<Self::Api> {
            roll,
            win,
            multiplier: bet,
            stake,
            settled_at: now,
        };
        self.roll(id).set(roll_record);
        self.rolls_count().set(self.rolls_count().get() + 1);

        self.settle_event(id, &player, roll, win);
        id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_encoded_bet_is_above_v1_max() {
        // v2 bets occupy 102..=299, disjoint from the v1 multiplier set {2,4,10,50}.
        assert!(encode_bet(1, false) > 50); // min v2 bet (102) exceeds the max v1 multiplier (50)
        assert!(encode_bet(1, false) as u16 >= V2_MIN_ENCODED_BET); // min v2 bet == the offset base
        assert!((encode_bet(99, true) as u16) < V2_MIN_ENCODED_BET + 200); // max v2 bet (299) stays in the 200-slot band
    }
}
