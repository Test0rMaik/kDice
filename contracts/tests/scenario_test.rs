//! Scenario (whitebox) tests for the kDice chain-random commit contract (v3).
//!
//! Follows the Ogmara `anchoring_whitebox_test.rs` pattern using the
//! `klever-sc-scenario` 0.45 facade API (`ScenarioWorld` + `WhiteboxContract`).
//!
//! Protocol v3 (Phase 7): a single `commit(target, over, stake)` transaction
//! settles the game. The d100 roll is derived from the CONFIRMING BLOCK's
//! random seed (48 bytes) mixed with the assigned game id:
//!
//!     roll = u32_le(sha256(block_seed || game_id_le64)[0..4]) % 100 + 1
//!
//! The block seed is fixed in the scenario's `SetStateStep`
//! (`block_random_seed`), so the roll is deterministic. The expected roll is
//! computed with the contract's own (separately unit-tested)
//! `dice::derive_roll`, and the on-chain (WASM) result is asserted to match it.
//!
//! Requires the deployable wasm at `output/kdice-contract.wasm`.
//! Run: `cargo test --test scenario_test`

use core::cell::Cell;
use kdice_contract::{
    commit::CommitModule, dice, query::QueryModule, storage::StorageModule,
    upgrade::UpgradeModule, ContractObj, KDiceContract,
};
use klever_sc_scenario::imports::*;

const WASM: &str = "file:output/kdice-contract.wasm";
const SC: &str = "sc:kdice";
const OWNER: &str = "address:owner";
const PLAYER: &str = "address:player";
const ATTACKER: &str = "address:attacker";

/// 48-byte confirming-block random seed fixed by the scenario so every roll is
/// deterministic (Klever's `get_block_random_seed` is exactly 48 bytes). The
/// specific bytes are arbitrary: the assertions compare the ON-CHAIN roll
/// (WASM) against `dice::derive_roll` run on this same seed, so any 48-byte
/// value works.
const BLOCK_SEED: [u8; 48] = [0x5A; 48];

/// Stake used in the fixtures (1 KLV at 6 decimals).
const STAKE: u64 = 1_000_000;

fn wb() -> WhiteboxContract<ContractObj<DebugApi>> {
    WhiteboxContract::new(SC, kdice_contract::contract_obj)
}

/// Scenario address to a managed address for queries/comparisons.
fn addr(expr: &str) -> ManagedAddress<DebugApi> {
    AddressValue::from(expr).to_address().into()
}

/// Deploy the contract (runs real `init`) and fix the block random seed so
/// rolls are deterministic.
fn setup() -> ScenarioWorld {
    let mut world = ScenarioWorld::new();
    world.register_contract(WASM, kdice_contract::ContractBuilder);
    let step = SetStateStep::new()
        .put_account(OWNER, Account::new().nonce(1).balance("1000000000000"))
        .put_account(SC, Account::new().code(WASM).owner(OWNER))
        .put_account(PLAYER, Account::new().nonce(1).balance("1000000000000"))
        .put_account(ATTACKER, Account::new().nonce(1).balance("1000000000000"))
        .block_timestamp(1_700_000_000)
        .block_random_seed(BLOCK_SEED.to_vec());
    world.set_state_step(step);
    world.whitebox_call(&wb(), ScCallStep::new().from(OWNER), |sc| sc.init());
    world
}

/// Place a bet (a single transaction) as `caller`; returns the assigned id.
fn do_commit(
    world: &mut ScenarioWorld,
    caller: &str,
    target: u16,
    over: bool,
    stake: u64,
) -> u64 {
    let id = Cell::new(0u64);
    world.whitebox_call(&wb(), ScCallStep::new().from(caller), |sc| {
        id.set(sc.commit(target, over, managed_biguint!(stake)));
    });
    id.get()
}

/// Expect a `require!` user-error revert with the exact message.
fn expect_user_error(
    world: &mut ScenarioWorld,
    from: &str,
    msg: &str,
    f: impl FnOnce(ContractObj<DebugApi>),
) {
    world.whitebox_call_check(
        &wb(),
        // `require!` user errors serialize as "str:<message>".
        ScCallStep::new().from(from).expect(TxExpect::user_error(format!("str:{msg}"))),
        f,
        |_| {},
    );
}

// ---------------------------------------------------------------------------
// init -- defaults
// ---------------------------------------------------------------------------

#[test]
fn init_seeds_protocol_defaults_and_ownership() {
    let mut world = setup();
    world.whitebox_query(&wb(), |sc| {
        assert_eq!(sc.get_name(), ManagedBuffer::from("kDice"));
        assert_eq!(sc.get_protocol_version(), 3u32);
        assert_eq!(sc.get_max_active_commits(), 100u16);
        assert_eq!(sc.get_commits_count(), 0u64);
        assert_eq!(sc.get_rolls_count(), 0u64);
        assert_eq!(sc.owner().get(), addr(OWNER));
    });
}

// ---------------------------------------------------------------------------
// commit -- input validation
// ---------------------------------------------------------------------------

#[test]
fn commit_rejects_invalid_target() {
    let mut world = setup();
    // 0 and 100 leave no losing region on one side; 1000 is out of sanity.
    for t in [0u16, 100u16, 1000u16] {
        expect_user_error(&mut world, PLAYER, "Target must be 1..99", |sc| {
            sc.commit(t, false, managed_biguint!(STAKE));
        });
    }
    world.whitebox_query(&wb(), |sc| {
        assert_eq!(sc.get_commits_count(), 0);
        assert_eq!(sc.get_rolls_count(), 0);
    });
}

#[test]
fn commit_rejects_zero_stake() {
    let mut world = setup();
    expect_user_error(&mut world, PLAYER, "Stake must be positive", |sc| {
        sc.commit(47, false, managed_biguint!(0));
    });
    world.whitebox_query(&wb(), |sc| assert_eq!(sc.get_commits_count(), 0));
}

// ---------------------------------------------------------------------------
// commit -- deterministic chain-random roll (the Phase 7 core)
// ---------------------------------------------------------------------------

#[test]
fn commit_derives_roll_from_block_seed_and_id() {
    let mut world = setup();
    let target = 47u16;
    let over = false; // under@47
    let id = do_commit(&mut world, PLAYER, target, over, STAKE);
    assert_eq!(id, 1);

    let expected_roll = dice::derive_roll(&BLOCK_SEED, id);
    let expected_win = expected_roll <= target as u32;

    world.whitebox_query(&wb(), |sc| {
        let roll = sc.get_roll(id);
        assert_eq!(roll.roll, expected_roll);
        assert_eq!(roll.win, expected_win);
        assert_eq!(roll.multiplier, dice::encode_bet(target, over));
        assert_eq!(roll.stake, managed_biguint!(STAKE));

        let commit = sc.get_commit(id);
        assert!(!commit.active); // settled in the same transaction
        assert_eq!(commit.hash.len(), 48); // carries the 48-byte block seed
        assert_eq!(commit.multiplier, roll.multiplier);
        assert_eq!(sc.get_rolls_count(), 1);
        assert_eq!(sc.get_commits_count(), 1);
    });
}

#[test]
fn commit_rolls_are_independent_per_game_id() {
    let mut world = setup();
    // Same block seed, two games -> two independent rolls (domain separation
    // is provided by the game id). Both must match the off-chain derivation.
    let id1 = do_commit(&mut world, PLAYER, 50, false, STAKE);
    let id2 = do_commit(&mut world, PLAYER, 50, false, STAKE);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);

    let r1 = dice::derive_roll(&BLOCK_SEED, id1);
    let r2 = dice::derive_roll(&BLOCK_SEED, id2);

    world.whitebox_query(&wb(), |sc| {
        assert_eq!(sc.get_roll(id1).roll, r1);
        assert_eq!(sc.get_roll(id2).roll, r2);
        assert_eq!(sc.get_rolls_count(), 2);
    });
}

#[test]
fn commit_win_rule_matches_bet_side() {
    let mut world = setup();
    // For a spread of bets, the on-chain win flag must equal the local rule
    // `over ? roll > target : roll <= target` applied to the derived roll.
    let cases: [(u16, bool); 6] = [
        (47, false), // under@47
        (47, true),  // over@47
        (1, false),  // under@1  (wins only on roll == 1)
        (1, true),   // over@1   (wins on roll >= 2)
        (99, true),  // over@99  (wins only on roll == 100)
        (99, false), // under@99 (wins on roll <= 99)
    ];
    for (target, over) in cases {
        let id = do_commit(&mut world, PLAYER, target, over, STAKE);
        let expected_roll = dice::derive_roll(&BLOCK_SEED, id);
        let expected_win = if over {
            expected_roll > target as u32
        } else {
            expected_roll <= target as u32
        };
        world.whitebox_query(&wb(), |sc| {
            let roll = sc.get_roll(id);
            assert_eq!(roll.roll, expected_roll);
            assert_eq!(roll.win, expected_win, "target={target} over={over}");
        });
    }
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

#[test]
fn get_target_view_matches_engine() {
    let mut world = setup();
    world.whitebox_query(&wb(), |sc| {
        assert_eq!(sc.get_target(2), 47);
        assert_eq!(sc.get_target(4), 23);
        assert_eq!(sc.get_target(10), 9);
        assert_eq!(sc.get_target(50), 1);
    });
}

#[test]
fn get_payout_view_matches_engine() {
    let mut world = setup();
    world.whitebox_query(&wb(), |sc| {
        // Continuous 5% edge: 9500 / winning-probability-%
        assert_eq!(sc.get_payout(47, false), 202);
        assert_eq!(sc.get_payout(23, false), 413);
        assert_eq!(sc.get_payout(9, false), 1055);
        assert_eq!(sc.get_payout(1, false), 9500);
        assert_eq!(sc.get_payout(99, true), 9500);
        assert_eq!(sc.get_payout(98, true), 4750);
        assert_eq!(sc.get_payout(50, true), 190);
    });
}

// ---------------------------------------------------------------------------
// admin -- owner gating
// ---------------------------------------------------------------------------

#[test]
fn admin_endpoints_are_owner_gated() {
    let mut world = setup();
    expect_user_error(&mut world, ATTACKER, "Not owner", |sc| {
        sc.set_name(ManagedBuffer::from("hacked"));
    });
    expect_user_error(&mut world, ATTACKER, "Not owner", |sc| {
        sc.set_max_active_commits(1);
    });
    expect_user_error(&mut world, ATTACKER, "Not owner", |sc| {
        sc.transfer_owner(addr(ATTACKER));
    });

    // Owner can rename; ownership stays intact after the attacks.
    world.whitebox_call(&wb(), ScCallStep::new().from(OWNER), |sc| {
        sc.set_name(ManagedBuffer::from("kDice v3"));
    });
    world.whitebox_query(&wb(), |sc| {
        assert_eq!(sc.get_name(), ManagedBuffer::from("kDice v3"));
        assert_eq!(sc.owner().get(), addr(OWNER));
    });
}