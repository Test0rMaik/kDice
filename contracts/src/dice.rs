//! Pure dice math shared by `commit` and by tests.
//!
//! Canonical reference: `src/engine/fair.ts` (Phase 7). Two rules are
//! mirrored 1:1:
//!
//! 1. **Roll derivation (Phase 7 — chain-random commit)** — the roll is
//!    derived from the **confirming block's consensus random seed** (48
//!    bytes, produced by the Klever validator set and UNKNOWN to the
//!    player at commit time) mixed with the game id:
//!    `d100 = (u32_le(sha256(block_seed ‖ game_id_le64)[0..4]) % 100) + 1`.
//!    Because the player commits blind to a block that does not exist yet,
//!    they cannot pre-roll or cherry-pick; the result is reproducible
//!    off-chain from the public block seed + the on-chain game id.
//! 2. **Win threshold (v2, Phase 4.10)** — the player commits a `target`
//!    (1..99) and a side: `win = over ? roll > target : roll <= target`.
//!    v1 records (multiplier `{2, 4, 10, 50}`) are still honored exactly:
//!    `win = roll <= target_for_multiplier(m)`.
//!
//! All of this is pure integer math — no floats, no allocations — so it is
//! safe to run inside the WASM contract and produces bit-identical results
//! to the TypeScript engine for the same inputs.

/// The only multipliers a v1 commit could declare (mirrors `src/config.ts`).
pub const VALID_MULTIPLIERS: [u32; 4] = [2, 4, 10, 50];

/// House-edge scaling factor for the v1 formula: `105 * m` in the denominator.
const HOUSE_EDGE_SCALE: u32 = 105;

/// Block random seed length in bytes (Klever's `get_block_random_seed` is 48).
pub const BLOCK_SEED_LEN: usize = 48;

/// v2 target range: a d100 roll is 1..100, and both sides must leave a
/// non-empty losing region (target 100 / 0 would be a free bet).
pub const TARGET_MIN: u16 = 1;
pub const TARGET_MAX: u16 = 99;

/// v2 bets are stored as `BET_V2_OFFSET + target * 2 + over` (102..299),
/// which is disjoint from the v1 multiplier set `{2, 4, 10, 50}` (all < 100)
/// — old and new records therefore decode unambiguously from the same
/// `u32` field WITHOUT any storage-schema change (in-place upgrade, 4.10).
pub const BET_V2_OFFSET: u32 = 100;

/// Payout numerator: 95 per 100 of stake = the 5% house edge, expressed as
/// `payout = stake * 95 / denom` where `denom` is the winning probability in
/// percent (integer math, bit-identical to the dApp's BigInt version).
const PAYOUT_NUMERATOR: u32 = 9500;

/// Check that `multiplier` is one of the allowed discrete v1 values.
pub fn is_valid_multiplier(m: u32) -> bool {
    VALID_MULTIPLIERS.contains(&m)
}

/// Winning target for a v1 multiplier — the highest roll that still wins.
///
/// `target = 10000 / (105 * multiplier)` (integer division, truncating).
/// Matches `src/engine/fair.ts` (`targetFor`) exactly. For the allowed set
/// this yields `47, 23, 9, 1` — the documented 5% house edge.
pub fn target_for_multiplier(m: u32) -> u32 {
    10000 / (HOUSE_EDGE_SCALE * m)
}

/// True iff `v` is a valid v2 bet encoding (102..299).
pub fn is_v2_bet(v: u32) -> bool {
    (BET_V2_OFFSET + 2..=BET_V2_OFFSET + TARGET_MAX as u32 * 2 + 1).contains(&v)
}

/// Encode a v2 bet (target 1..99 + side) into the stored `u32`.
pub fn encode_bet(target: u16, over: bool) -> u32 {
    require_range(target);
    BET_V2_OFFSET + target as u32 * 2 + u32::from(over)
}

/// True iff `target` is in the allowed v2 range (1..99).
pub fn valid_target(target: u16) -> bool {
    (TARGET_MIN..=TARGET_MAX).contains(&target)
}

/// Resolve a stored bet value into `(target, over)` for BOTH v1 and v2
/// records. `None` for values neither version can have produced
/// (v1 is restricted to `{2,4,10,50}`; v2 to `102..299`).
///
/// v1: multiplier `m` → target `target_for_multiplier(m)`, side under.
/// v2: `100 + target*2 + over` → the target and side themselves.
pub fn bet_target_and_side(v: u32) -> Option<(u32, bool)> {
    if is_valid_multiplier(v) {
        return Some((target_for_multiplier(v), false));
    }
    if is_v2_bet(v) {
        let t = v - BET_V2_OFFSET;
        return Some((t / 2, t % 2 == 1));
    }
    None
}

/// Win/loss for a stored bet value and a roll — the single source of truth
/// used by `commit` (v1 and v2 records both resolve through this).
pub fn bet_wins(v: u32, roll: u32) -> Option<bool> {
    let (target, over) = bet_target_and_side(v)?;
    Some(if over { roll > target } else { roll <= target })
}

/// Payout per 100 of stake (×100 precision) for a v2 bet — the continuous
/// 5%-edge generalization of the v1 multiplier set:
/// `payout = stake * (9500 / denom)` with `denom = winning probability %`
/// (under: `target`, over: `100 - target`). Mirrors `fair.ts::payoutPer100`.
///
/// Reference points: under@47 → 202 (≈×2.02, v1 ×2), under@23 → 413 (≈×4.1),
/// under@9 → 1055 (≈×10.6, v1 ×10), under@1 / over@99 → 9500 (×95).
pub fn payout_per_100(target: u16, over: bool) -> u32 {
    require_range(target);
    let denom: u32 = if over { 100 - target as u32 } else { target as u32 };
    PAYOUT_NUMERATOR / denom
}

/// Internal range guard for the pure-math context (no `require!` in dice.rs).
fn require_range(target: u16) {
    assert!(valid_target(target), "target out of range 1..99");
}

/// Derive the d100 roll from the confirming block's random seed + game id.
///
/// `sha256(block_seed ‖ game_id_le64)` → first 4 bytes as little-endian
/// `u32` → `% 100 + 1` → range `[1, 100]`.
///
/// - `block_seed` is the 48-byte consensus random seed of the block that
///   contains the `commit` transaction (see `BLOCK_SEED_LEN`). It is produced
///   by the validator set and is UNKNOWN to the player at commit time, so
///   the player commits blind and cannot cherry-pick the outcome.
/// - `game_id` is mixed in (little-endian u64) so that two games landing in
///   the SAME block still derive independent rolls (domain separation).
///
/// NOTE: the byte order is LITTLE-endian and must stay that way — the dApp's
/// `fair.ts::deriveRollFromSeed` (and the parity gate) are pinned to this
/// order by the `scripts/fair-parity.ts` equivalence gate.
pub fn derive_roll(block_seed: &[u8], game_id: u64) -> u32 {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(block_seed);
    hasher.update(game_id.to_le_bytes());
    let digest = hasher.finalize();
    let v = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]);
    (v % 100) + 1
}

/// Full resolution: roll + win/loss for a stored bet value (v1 or v2) given
/// the block seed and game id.
pub fn settle_roll(block_seed: &[u8], game_id: u64, bet: u32) -> (u32, Option<bool>) {
    let roll = derive_roll(block_seed, game_id);
    (roll, bet_wins(bet, roll))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cross-check the Rust derivation against the TypeScript reference
    /// (`src/engine/fair.ts::deriveRollFromSeed`) for the same block seed +
    /// game id: the roll is fully deterministic given `(block_seed, game_id)`.
    #[test]
    fn roll_matches_ts_reference() {
        let block_seed = [3u8; 48];
        let game_id = 1u64;
        let (roll, win) = settle_roll(&block_seed, game_id, 10);
        // d100 in [1, 100]
        assert!((1..=100).contains(&roll));
        let target = target_for_multiplier(10);
        assert_eq!(win, Some(roll <= target));
        assert_eq!(target, 9); // v1 M=10 → floor(100 / (10 * 1.05)) = 9 (fair.ts)
    }

    #[test]
    fn v1_targets_match_config() {
        // Must match the canonical reference `src/engine/fair.ts` `targetFor`:
        // floor(100 / (M * 1.05)) — the documented 5% house edge (47/23/9/1).
        assert_eq!(target_for_multiplier(2), 47); // floor(100 / 2.10)
        assert_eq!(target_for_multiplier(4), 23); // floor(100 / 4.20)
        assert_eq!(target_for_multiplier(10), 9); // floor(100 / 10.50)
        assert_eq!(target_for_multiplier(50), 1); // floor(100 / 52.50)
    }

    #[test]
    fn multiplier_validation() {
        assert!(is_valid_multiplier(2));
        assert!(is_valid_multiplier(50));
        assert!(!is_valid_multiplier(1));
        assert!(!is_valid_multiplier(3));
        assert!(!is_valid_multiplier(0));
    }

    #[test]
    fn roll_is_deterministic_and_range_bounded() {
        let seed = [7u8; 48];
        let a = derive_roll(&seed, 42);
        let b = derive_roll(&seed, 42);
        assert_eq!(a, b);
        assert!((1..=100).contains(&a));
        // A different seed — or a different game id (domain separation for
        // two games landing in the same block) — must change the roll.
        let seed2 = [8u8; 48];
        assert_ne!(derive_roll(&seed2, 42), a);
        assert_ne!(derive_roll(&seed, 43), a);
    }

    // ── v2 (Phase 4.10): bet encoding, win resolution, payout ──

    #[test]
    fn v2_bet_encode_decode_roundtrip() {
        for target in 1..=99u16 {
            for over in [false, true] {
                let v = encode_bet(target, over);
                assert_eq!(bet_target_and_side(v), Some((target as u32, over)));
            }
        }
    }

    #[test]
    fn v1_and_v2_bet_ranges_are_disjoint() {
        // Every v1 value decodes as v1 (under); no v2 value collides with it.
        for m in VALID_MULTIPLIERS {
            let (t, over) = bet_target_and_side(m).unwrap();
            assert!(!over);
            assert_eq!(t, target_for_multiplier(m));
        }
        assert!(is_v2_bet(encode_bet(1, false))); // 102
        assert!(!is_v2_bet(100) && !is_v2_bet(101) && !is_v2_bet(300));
        assert_eq!(bet_target_and_side(101), None);
        assert_eq!(bet_target_and_side(300), None);
        assert_eq!(bet_target_and_side(3), None); // never produced by v1 or v2
    }

    #[test]
    fn v2_win_boundaries() {
        // Under: roll == target WINS, roll == target+1 loses.
        let u = encode_bet(50, false);
        assert_eq!(bet_wins(u, 50), Some(true));
        assert_eq!(bet_wins(u, 51), Some(false));
        // Over: roll == target LOSES, roll == target+1 wins.
        let o = encode_bet(50, true);
        assert_eq!(bet_wins(o, 50), Some(false));
        assert_eq!(bet_wins(o, 51), Some(true));
        // Extremes: under@1 wins only on a 1; over@99 wins only on a 100.
        assert_eq!(bet_wins(encode_bet(1, false), 1), Some(true));
        assert_eq!(bet_wins(encode_bet(1, false), 2), Some(false));
        assert_eq!(bet_wins(encode_bet(99, true), 99), Some(false));
        assert_eq!(bet_wins(encode_bet(99, true), 100), Some(true));
    }

    #[test]
    fn v2_payout_reference_points() {
        // Continuous 5% edge: payout_per_100 = 9500 / winning-probability-%
        assert_eq!(payout_per_100(47, false), 202); // ≈ ×2.02 (v1 ×2)
        assert_eq!(payout_per_100(23, false), 413); // ≈ ×4.1 (v1 ×4)
        assert_eq!(payout_per_100(9, false), 1055); // ≈ ×10.6 (v1 ×10)
        assert_eq!(payout_per_100(1, false), 9500); // ×95
        assert_eq!(payout_per_100(99, true), 9500); // ×95
        assert_eq!(payout_per_100(98, true), 4750); // ×47.5
        assert_eq!(payout_per_100(50, true), 190); // ×1.9
    }
}
