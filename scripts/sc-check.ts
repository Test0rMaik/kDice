/**
 * scripts/sc-check.ts — gate test: run the scClient view calls against the
 * live testnet contract and cross-check the on-chain records with the
 * local fair.ts derivation (Phase 4.5; v2 bets in Phase 4.10).
 *
 * Contract v2 stores the bet in the `multiplier` field as either a v1
 * multiplier {2,4,10,50} or a v2 encoded bet `100 + target·2 + over` —
 * the checks below accept both (decode via `resolveBet`/`betLabel`).
 *
 * Run: npx esbuild scripts/sc-check.ts --bundle --format=esm --platform=node \
 *        --outfile=/tmp/sc-check.mjs && node /tmp/sc-check.mjs
 */
import { betLabel, betTargetAndSide, deriveRollFromBlockSeed, evaluateOutcome, parseBlockSeedHex } from '../src/engine/fair';
import {
  DEFAULT_SC_CONFIG,
  SCError,
  bech32Encode,
  getCommit,
  getCommitsCount,
  getMaxActiveCommits,
  getPayout,
  getProtocolVersion,
  getRoll,
  getRollsCount,
  getTarget,
  hexFromBech32,
} from '../src/services/scClient';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

const cfg = { ...DEFAULT_SC_CONFIG };
console.log('node:', cfg.nodeUrl);
console.log('contract:', cfg.contract);
console.log('');

// bech32 round-trip: decode to hex and re-encode must be the identity.
const hex = hexFromBech32(cfg.contract);
check('bech32 decode → 32-byte hex', hex.length === 64, hex);
check('bech32 round-trip', bech32Encode('klv', Uint8Array.from(hex.match(/../g)!.map((p) => Number.parseInt(p, 16)))) === cfg.contract);

const name = await fetch(cfg.nodeUrl + '/vm/query', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ scAddress: cfg.contract, funcName: 'getName', args: [] }),
}).then((r) => r.json() as Promise<{ data: { data: { returnData: string[] } } } >);
const nameStr = Buffer.from(name.data.data.returnData[0], 'base64').toString('utf8');
check('getName', nameStr === 'kDice', nameStr);

const commits = await getCommitsCount(cfg);
const rolls = await getRollsCount(cfg);
check('getCommitsCount', commits >= 1, String(commits));
check('getRollsCount', rolls >= 1, String(rolls));

const target = await getTarget(cfg, 2);
check('getTarget(2) === 47', target === 47, String(target));

const version = await getProtocolVersion(cfg);
check('getProtocolVersion', version >= 1, String(version));
const maxActive = await getMaxActiveCommits(cfg);
check('getMaxActiveCommits', maxActive >= 1, String(maxActive));

// Phase 4.10: the v2 payout view — continuous 5% edge. Fails on a v1
// contract (the view is absent), so this doubles as the upgrade gate.
check('getPayout(50, under) === 190', (await getPayout(cfg, 50, false)) === 190);
check('getPayout(50, over) === 190', (await getPayout(cfg, 50, true)) === 190);
check('getPayout(99, over) === 9500', (await getPayout(cfg, 99, true)) === 9500);

// Every recorded commit: decode the record. v3 records (protocol ≥ 3, Phase 7)
// carry a 48-byte confirming-block seed (96 hex) in `hash` — for those we
// cross-check the on-chain roll against the LOCAL block-seed derivation (the
// core v3 fairness proof). Legacy v1/v2 records (pre-upgrade) carry a 32-byte
// player commitment (64 hex) — historical: we only sanity-check the roll range
// + the win rule (re-deriving a roll from a commitment is impossible by design;
// the commitment was never the entropy source).
let sawV3 = false;
for (let id = 1; id <= commits; id++) {
  const c = await getCommit(cfg, id);
  const isV3 = c.hash.length === 96; // 48-byte block seed (Phase 7)
  const isLegacy = c.hash.length === 64; // 32-byte commitment (v1/v2)
  const kind = isV3 ? 'v3 block seed' : isLegacy ? 'legacy commitment' : `UNKNOWN ${c.hash.length} hex`;
  console.log(`\ncommit #${id}: player=${c.player} bet=${betLabel(c.multiplier)} stake=${c.stake} active=${c.active}`);
  console.log(`           hash=${c.hash} createdAt=${c.createdAt} [${kind}]`);
  check(`commit #${id} hash is 48B (v3) or 32B (legacy)`, isV3 || isLegacy, `${c.hash.length} hex`);
  if (isV3) sawV3 = true;
  check(`commit #${id} bet decodes (v1 or v2)`, betTargetAndSide(c.multiplier) !== null, String(c.multiplier));
  try {
    const r = await getRoll(cfg, id);
    console.log(`roll   #${id}: roll=${r.roll} win=${r.win} bet=${betLabel(r.multiplier)} settledAt=${r.settledAt}`);
    const ev = evaluateOutcome(r.roll, r.multiplier);
    check(`roll #${id} in 1..100`, r.roll >= 1 && r.roll <= 100);
    check(`roll #${id} win flag == local bet rule`, r.win === ev.win, `roll=${r.roll} target=${ev.target} over=${ev.over} win=${r.win}`);
    check(`roll #${id} matches commit mult`, r.multiplier === c.multiplier);
    if (isV3) {
      // THE v3 parity proof: the on-chain roll must equal the local derivation
      // from the stored block seed + game id (dice.rs::derive_roll).
      const localRoll = await deriveRollFromBlockSeed(parseBlockSeedHex(c.hash), id);
      check(`roll #${id} (v3) == local block-seed derivation`, r.roll === localRoll, `on-chain=${r.roll} local=${localRoll}`);
    }
  } catch (e) {
    if (e instanceof SCError && e.requireFailed) {
      console.log(`roll   #${id}: not settled yet (require failed) — expected if commit is active`);
      check(`roll #${id} absent ⇒ commit active`, c.active === true);
    } else {
      throw e;
    }
  }
}
check('live contract produced ≥1 v3 (48-byte seed) record', sawV3);

// Local derivation sanity: a fixed block seed + game id must produce a
// deterministic roll (mirrors `dice.rs::derive_roll`). `deriveRollFromBlockSeed`
// is async (Web Crypto) so every call is awaited to get a concrete number.
const seed = new Uint8Array(48).fill(0xab);
const r1 = await deriveRollFromBlockSeed(seed, 42);
const r2 = await deriveRollFromBlockSeed(seed, 42);
check('local derivation deterministic', r1 === r2, `roll=${r1}`);
check('local roll in 1..100', r1 >= 1 && r1 <= 100);
const r3 = await deriveRollFromBlockSeed(seed, 43);
check('game id domain-separates the roll', r1 !== r3, `id=42→${r1} id=43→${r3}`);

console.log('');
if (failed > 0) {
  console.log(`${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('ALL GATE CHECKS PASSED');