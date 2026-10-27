/**
 * fair.ts — provably-fair chain-random commit core (Phase 7, contract v3).
 *
 * This is the TypeScript mirror of the K5 smart contract's dice math
 * (`contracts/src/dice.rs`), kept 1:1 so a roll can be re-derived locally
 * and compared against the on-chain record:
 *
 *   Protocol v3 (chain-random commit): ONE `commit(target, over, stake)`
 *   transaction settles the game. The d100 roll is derived from the
 *   CONFIRMING BLOCK's consensus random seed (48 bytes, produced by the
 *   Klever validator set and unknown to the caller at sign-time) mixed with
 *   the assigned game id:
 *
 *     hash = SHA256(block_seed ‖ game_id_le64)   // block_seed = 48 bytes
 *     roll = LE_u32(hash[0..4]) % 100 + 1        // range 1..100
 *
 *   Because the player commits blind to a block that does not exist yet,
 *   they cannot pre-roll or cherry-pick. The contract stores the 48-byte
 *   block seed in the commit record's `hash` field, so the dApp re-derives
 *   the roll from `(block seed, game id)` alone and compares it to the
 *   on-chain roll record — that match is the provably-fair proof.
 *
 *   v1 bet (multiplier m ∈ {2,4,10,50}):  win iff roll ≤ floor(10000/(105·m))
 *   v2 bet (target t ∈ 1..99 + side):     win iff over ? roll > t : roll ≤ t
 *
 * Phase 4.10 (v2) bet model: the contract stores the bet in the legacy
 * `multiplier` u32 field using a versioned encoding with disjoint ranges —
 * v1 records hold {2,4,10,50}, v2 records hold `100 + target·2 + over`
 * (102..299) — so one field carries both generations unambiguously.
 * Everything that used to take a "multiplier" now takes a **bet value**
 * (v1 or v2) and decodes through the same single source of truth as
 * `dice.rs::bet_wins`.
 *
 * SHA-256 comes from Web Crypto (`crypto.subtle`) — async, zero npm
 * dependencies (project principle: no SDKs, no crypto libs to audit).
 * NOTE: `crypto.subtle` requires a secure context (https or localhost);
 * the dev server and any proper hosting satisfy this.
 *
 * Byte handling is `Uint8Array` throughout, and every integer op that could
 * overflow JS's 32-bit signed bitwise space runs in BigInt — the same
 * subtle bug class that corrupted the roll derivation in the operator
 * console (see `contracts/tools/lib.js` `deriveRoll` notes).
 */

/** Block random seed length — Klever's `get_block_random_seed` is 48 bytes. */
export const BLOCK_SEED_LEN = 48;

/** Fixed multiplier set — mirrors `contracts/src/dice.rs` `VALID_MULTIPLIERS`. */
export const VALID_MULTIPLIERS = [2, 4, 10, 50] as const;
export type FairMultiplier = (typeof VALID_MULTIPLIERS)[number];

/** True iff `m` is one of the four allowed multipliers. */
export function isValidMultiplier(m: number): boolean {
  return (VALID_MULTIPLIERS as readonly number[]).includes(m);
}

/**
 * Highest d100 roll that still wins at `multiplier` (5% house edge).
 *
 * Integer form `floor(10000 / (105*m))` — bit-identical to the contract's
 * `10000 / (105 * multiplier)` and equal to the old floating-point
 * `floor(100 / (m*1.05))` for the fixed multiplier set (47/23/9/1).
 */
export function targetFor(multiplier: number): number {
  const t = Math.floor(10000 / (105 * multiplier));
  if (!Number.isFinite(t) || t < 0) return 0;
  return Math.min(t, 100);
}

/* ── v2 bet model (Phase 4.10): over/under target 1..99 + side ── */

/** Legal v2 target range — mirrors `valid_target` in dice.rs. */
export const TARGET_MIN = 1;
export const TARGET_MAX = 99;

/**
 * Payout numerator — mirrors `PAYOUT_NUMERATOR` in dice.rs: 100% in
 * ×100 precision minus the 5% house edge.
 */
export const PAYOUT_NUMERATOR = 9500;

/**
 * v2 encoded-bet span: `100 + target·2 + over` → 102 (under@1) ..
 * 299 (over@99). Disjoint from the v1 set {2,4,10,50}, which is what
 * lets one u32 field carry both bet generations.
 */
export const BET_V2_MIN = 102;
export const BET_V2_MAX = 299;

/** True when `target` is a legal v2 target (integer, 1..99). */
export function isValidTarget(target: number): boolean {
  return Number.isInteger(target) && target >= TARGET_MIN && target <= TARGET_MAX;
}

/**
 * Encode a v2 bet exactly the way the contract stores it:
 * `100 + target·2 + over` — mirrors `dice.rs::encode_bet` bit-for-bit.
 */
export function encodeBet(target: number, over: boolean): number {
  if (!isValidTarget(target)) {
    throw new Error(`target must be ${TARGET_MIN}..${TARGET_MAX}, got ${target}`);
  }
  return 100 + target * 2 + (over ? 1 : 0);
}

/** True for a v2 encoded bet (102..299). */
export function isV2Bet(v: number): boolean {
  return Number.isInteger(v) && v >= BET_V2_MIN && v <= BET_V2_MAX;
}

/**
 * Decode a stored bet value (v1 multiplier OR v2 encoded bet) into
 * (target, side) — mirrors `dice.rs::bet_target_and_side`. Returns null
 * for values that are neither (defensive: the contract rejects those
 * at commit time, so this only guards hand-edited local state).
 */
export function betTargetAndSide(v: number): { target: number; over: boolean } | null {
  if (isValidMultiplier(v)) return { target: targetFor(v), over: false };
  if (isV2Bet(v)) {
    const t = v - 100;
    return { target: Math.floor(t / 2), over: t % 2 === 1 };
  }
  return null;
}

/**
 * Win/loss for a stored bet value and a roll — mirrors
 * `dice.rs::bet_wins`, the single source of truth the contract's
 * `settle` uses. `over` wins strictly above the target; `under` wins
 * at-or-below. Null for an un-decodable bet value.
 */
export function betWins(bet: number, roll: number): boolean | null {
  const bs = betTargetAndSide(bet);
  if (bs === null) return null;
  return bs.over ? roll > bs.target : roll <= bs.target;
}

/**
 * Payout per 100 of stake (×100 precision) for a v2 bet — mirrors
 * `dice.rs::payout_per_100` and the `getPayout(target, over)` view:
 * `floor(9500 / denom)` with `denom = over ? 100−target : target`.
 *
 * Reference points (continuous 5% edge, generalizing the v1 set):
 * under@47 → 202 (≈×2.02) · under@23 → 413 (≈×4.1) · under@9 → 1055 (≈×10.6)
 * · under@1 / over@99 → 9500 (×95) · over@50 → 190 (×1.9).
 */
export function payoutFor(target: number, over: boolean): number {
  if (!isValidTarget(target)) {
    throw new Error(`target must be ${TARGET_MIN}..${TARGET_MAX}, got ${target}`);
  }
  const denom = over ? 100 - target : target;
  return Math.floor(PAYOUT_NUMERATOR / denom);
}

/**
 * Resolve a stored bet value to its (target, side, generation) —
 * v1 multiplier → its fixed target (always an "under" bet).
 */
export function resolveBet(bet: number): { target: number; over: boolean; isV2: boolean } | null {
  const bs = betTargetAndSide(bet);
  if (bs === null) return null;
  return { ...bs, isV2: isV2Bet(bet) };
}

/** Human label for display: v2 → "Under 50"/"Over 55"; v1 → "×2 (≤47)". */
export function betLabel(bet: number): string {
  const r = resolveBet(bet);
  if (r === null) return String(bet);
  return r.isV2 ? `${r.over ? 'Over' : 'Under'} ${r.target}` : `×${bet} (≤${r.target})`;
}

/**
 * Winning payout in KLV for a bet value and stake — v1: stake × multiplier
 * (the original formula); v2: stake × `payoutFor(target, side)` / 100.
 * Display math only (the record-only contract reconciles payouts off-chain).
 */
export function payoutForBet(bet: number, stakeKlv: number): number {
  const r = resolveBet(bet);
  if (r === null) return 0;
  return r.isV2 ? (stakeKlv * payoutFor(r.target, r.over)) / 100 : stakeKlv * bet;
}

/** Win/lose decision for a roll, with the resolved bet (single source). */
export interface Outcome {
  roll: number;
  target: number;
  /** Side of the bet — v1 multipliers are always "under". */
  over: boolean;
  win: boolean;
}

/**
 * Evaluate a d100 roll against a stored bet value (v1 multiplier or v2
 * encoded bet) using the contract's exact integer rules — no floating
 * point, identical decision path to `dice.rs::bet_wins`.
 */
export function evaluateOutcome(roll: number, bet: number): Outcome {
  const bs = betTargetAndSide(bet);
  if (bs === null) throw new Error(`unknown bet encoding: ${bet}`);
  return { roll, target: bs.target, over: bs.over, win: bs.over ? roll > bs.target : roll <= bs.target };
}

/** SHA-256 over exactly the bytes in `data`. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Copy into a standalone ArrayBuffer: Web Crypto requires an
  // ArrayBuffer-backed view, and a sub-array view over a larger buffer
  // would otherwise hash the whole backing store (silently wrong).
  const standalone = new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', standalone);
  return new Uint8Array(digest);
}

/** Loud guard: the confirming-block seed is exactly 48 bytes. */
function assertBlockSeed(seed: Uint8Array): void {
  if (
    !(seed instanceof Uint8Array) ||
    seed.byteLength !== BLOCK_SEED_LEN ||
    seed.buffer.byteLength !== BLOCK_SEED_LEN
  ) {
    // `buffer.byteLength !== BLOCK_SEED_LEN` rejects sub-arrays (views over
    // a larger buffer) — subtle.digest would hash the whole backing store
    // and silently produce a different digest than the 48 bytes shown.
    throw new Error(`block seed must be exactly ${BLOCK_SEED_LEN} bytes (got ${seed?.byteLength ?? 'n/a'})`);
  }
}

/**
 * Entropy hash the contract derives the roll from:
 * `SHA256(block_seed ‖ game_id_le64)` — block_seed exactly 48 bytes, game_id
 * as 8 little-endian bytes. Mirrors `dice.rs::derive_roll`'s pre-image
 * (`block_seed ++ game_id.to_le_bytes()`).
 */
export async function blockSeedHash(blockSeed: Uint8Array, gameId: number): Promise<Uint8Array> {
  assertBlockSeed(blockSeed);
  if (!Number.isInteger(gameId) || gameId < 0 || gameId > 0xffffffffffffffff) {
    throw new Error(`game id must be a u64 (0..2^64-1), got ${gameId}`);
  }
  const idBytes = new Uint8Array(8);
  let v = BigInt(gameId);
  for (let i = 0; i < 8; i++) {
    idBytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  const concat = new Uint8Array(BLOCK_SEED_LEN + 8);
  concat.set(blockSeed, 0);
  concat.set(idBytes, BLOCK_SEED_LEN);
  return sha256(concat);
}

/**
 * Deterministic d100 roll (1..100) from the confirming-block seed + game id
 * — mirrors `dice.rs::derive_roll`: first 4 digest bytes as little-endian u32
 * (digest[0] is the LEAST significant byte), `% 100 + 1`. BigInt keeps the
 * shift/or path free of 32-bit corruption; byte order must stay LE (the
 * contract uses `u32::from_le_bytes`).
 */
export async function deriveRollFromBlockSeed(blockSeed: Uint8Array, gameId: number): Promise<number> {
  const h = await blockSeedHash(blockSeed, gameId);
  const v = BigInt(h[0]) | (BigInt(h[1]) << 8n) | (BigInt(h[2]) << 16n) | (BigInt(h[3]) << 24n);
  return Number(v % 100n) + 1;
}

/**
 * Full local settlement for a settled game: roll + win from the
 * confirming-block seed + game id + stored bet value (v1 or v2).
 */
export async function settleFromBlockSeed(
  blockSeed: Uint8Array,
  gameId: number,
  bet: number,
): Promise<Outcome> {
  const roll = await deriveRollFromBlockSeed(blockSeed, gameId);
  return evaluateOutcome(roll, bet);
}

// ── Hex helpers (shared UI conventions: even-length lowercase hex) ──

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Parse a hex string to bytes. Rejects odd length and non-hex characters. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error('expected an even-length hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('invalid hex pair at byte ' + i);
    out[i] = byte;
  }
  return out;
}

/** Parse a 48-byte block seed from hex (96 hex chars) — throws otherwise. */
export function parseBlockSeedHex(hex: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes.length !== BLOCK_SEED_LEN) {
    throw new Error(
      `block seed: expected ${BLOCK_SEED_LEN} bytes (${BLOCK_SEED_LEN * 2} hex chars), got ${bytes.length} bytes`,
    );
  }
  return bytes;
}