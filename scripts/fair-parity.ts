/**
 * scripts/fair-parity.mjs — equivalence gate: `src/engine/fair.ts` (used by
 * the hero table + ProvablyFair panel) must derive EXACTLY the same roll as
 * the contract's `dice.rs::derive_roll` reference (Phase 7 chain-random):
 * `sha256(block_seed ‖ game_id_le64)` → little-endian u32 → `%100 + 1`.
 *
 * Why this file exists (bug fixed 2026-10-24): fair.ts's roll derivation
 * was written big-endian while the contract uses `u32::from_le_bytes` —
 * every on-chain roll "mismatched" the local derivation (~99% of digests).
 * The sc-check gate could not catch it (it only cross-checked the on-chain
 * win flag vs the on-chain roll). This gate pins byte order + the full
 * formula to the reference with hundreds of random vectors.
 *
 * Run: node scripts/fair-parity.mjs   (exit 1 on any divergence)
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  betWins,
  blockSeedHash,
  deriveRollFromBlockSeed,
  encodeBet,
  payoutFor,
  targetFor,
  VALID_MULTIPLIERS,
} from '../src/engine/fair';

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

// Reference implementation — byte-for-byte the contract's dice.rs::derive_roll
// (Phase 7 chain-random): sha256(block_seed ‖ game_id_le64) → first 4 bytes
// as little-endian u32 → %100 + 1. `block_seed` is 48 bytes.
function refDerive(blockSeed, gameId) {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(gameId));
  const h = createHash('sha256').update(Buffer.concat([Buffer.from(blockSeed), idBuf])).digest();
  const v = BigInt(h[0]) | (BigInt(h[1]) << 8n) | (BigInt(h[2]) << 16n) | (BigInt(h[3]) << 24n);
  return { hash: h, roll: Number(v % 100n) + 1 };
}

// 1) Fixed vectors, including the 0xd5… case whose first digest byte has
//    bit 7 set (the exact corruption the deploy-verify comment warns about).
//    Each vector pairs a 48-byte block seed with a game id (domain separation).
const fixed = [
  [Buffer.from('ab'.repeat(48), 'hex'), 1],
  [Buffer.from('00'.repeat(47) + '01', 'hex'), 7],
  [Buffer.from('d5'.repeat(48), 'hex'), 42],
  [randomBytes(48), 12345],
];
for (let i = 0; i < fixed.length; i++) {
  const [seed, id] = fixed[i];
  const ref = refDerive(seed, id);
  const hash = await blockSeedHash(new Uint8Array(seed), id);
  const roll = await deriveRollFromBlockSeed(new Uint8Array(seed), id);
  const hashOk = Buffer.from(hash).equals(ref.hash);
  check(`fixed vector #${i} hash == reference`, hashOk, ref.hash.toString('hex').slice(0, 16) + '…');
  check(`fixed vector #${i} roll == reference`, roll === ref.roll, `local=${roll} ref=${ref.roll}`);
}

// 2) 500 random block-seed + game-id pairs — a BE/LE (or any formula)
//    divergence would hit within the first few vectors (P(match per random
//    digest) ≈ 1/100).
let allMatch = true;
let firstMismatch = '';
for (let i = 0; i < 500; i++) {
  const seed = randomBytes(48);
  const id = 1 + (i % 97);
  const ref = refDerive(seed, id);
  const roll = await deriveRollFromBlockSeed(new Uint8Array(seed), id);
  if (roll !== ref.roll) {
    allMatch = false;
    firstMismatch = `vector #${i}: local=${roll} ref=${ref.roll}`;
    break;
  }
}
check('500 random block-seed vectors match reference roll', allMatch, firstMismatch || '500/500');

// 3) Target formula parity (contract: 10000 / (105 * m), integer division).
let targetOk = true;
for (const m of VALID_MULTIPLIERS) {
  const expected = Math.floor(10000 / (105 * m));
  if (targetFor(m) !== expected) {
    targetOk = false;
    firstMismatch = `m=${m}: local=${targetFor(m)} ref=${expected}`;
  }
}
check('targetFor matches contract integer formula', targetOk, firstMismatch || `${[...VALID_MULTIPLIERS].map((m) => targetFor(m)).join('/')} for ×${[...VALID_MULTIPLIERS].join('/')}`);

// 4) Phase 4.10 — v2 bet model parity (contract: dice.rs::encode_bet /
//    bet_wins / payout_per_100). Reference implementations copied 1:1
//    from the Rust source so any drift in the TS mirror fails the gate.
const refEncodeBet = (t: number, over: boolean) => 100 + 2 * t + (over ? 1 : 0);
const refPayoutPer100 = (t: number, over: boolean) => Math.floor(9500 / (over ? 100 - t : t));
const refBetWins = (bet: number, roll: number) => {
  const v2 = bet >= 100 && bet <= 299;
  if (!v2) {
    if (![2, 4, 10, 50].includes(bet)) return null;
    return roll <= Math.floor(10000 / (105 * bet));
  }
  const t = bet - 100;
  const over = t % 2 === 1;
  return over ? roll > Math.floor(t / 2) : roll <= Math.floor(t / 2);
};
let v2EncodeOk = true;
for (let t = 1; t <= 99; t++) {
  for (const over of [false, true]) {
    if (encodeBet(t, over) !== refEncodeBet(t, over)) {
      v2EncodeOk = false;
      firstMismatch = `encodeBet(${t},${over}): local=${encodeBet(t, over)} ref=${refEncodeBet(t, over)}`;
    }
  }
}
check('encodeBet matches dice.rs for all 198 targets/sides', v2EncodeOk, firstMismatch || '198/198');

let v2WinsOk = true;
const sampleBets = [2, 4, 10, 50, 102, 103, 150, 151, 202, 203, 298, 299];
for (const bet of sampleBets) {
  for (let roll = 1; roll <= 100; roll++) {
    const l = betWins(bet, roll);
    const r = refBetWins(bet, roll);
    if (l !== r) {
      v2WinsOk = false;
      firstMismatch = `betWins(${bet},${roll}): local=${l} ref=${r}`;
    }
  }
}
check('betWins matches dice.rs (12 bets × 100 rolls)', v2WinsOk, firstMismatch || '1200/1200');

let v2PayoutOk = true;
for (let t = 1; t <= 99; t++) {
  for (const over of [false, true]) {
    if (payoutFor(t, over) !== refPayoutPer100(t, over)) {
      v2PayoutOk = false;
      firstMismatch = `payoutFor(${t},${over}): local=${payoutFor(t, over)} ref=${refPayoutPer100(t, over)}`;
    }
  }
}
check('payoutFor matches dice.rs for all 198 targets/sides', v2PayoutOk, firstMismatch || '198/198');

console.log('');
if (failed > 0) {
  console.log(`${failed} check(s) FAILED — fair.ts DIVERGES from the contract reference`);
  process.exit(1);
}
console.log('ALL FAIR-PARITY CHECKS PASSED');