/**
 * scripts/eventlog-tests.ts — Phase 5 gate: the Overall Dashboard must
 * RECONCILE with the event log. `aggregateRolls` is the single place
 * dashboard numbers are computed from `RollEvent[]`, so asserting exact
 * numbers here (for all 4 range tabs) is the reconciliation proof — no
 * browser/indexedDB needed, the Dexie wrapper is a 5-line read that the
 * manual E2E covers.
 *
 * Fixtures use a FIXED `NOW` (UTC instant) so the suite is deterministic
 * on any machine at any time. Bucket assertions are invariant-based
 * (per-bucket sums must equal the in-window totals) so they stay valid
 * regardless of the host timezone; the monthly math is asserted on the
 * totals, never on a specific month index (which depends on the run date).
 *
 * Run: npm test   (exit 1 on any failure)
 */
import {
  aggregateRolls,
  rollupPlayers,
  shortAddress,
  type RollEvent,
  type RangeKey,
} from '../src/services/eventLog';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const DAY = 86_400_000;
/** Fixed reference instant: 2026-10-25 12:00 UTC. */
const NOW = Date.UTC(2026, 9, 25, 12);

const ADDR_A = 'k5:aaaaaaaaaaaaaa1111';
const ADDR_B = 'k5:bbbbbbbbbbbb2222';
const ADDR_C = 'k5:cccccccccccc3333';

function ev(p: Partial<RollEvent> & Pick<RollEvent, 'ts' | 'roll' | 'bet' | 'outcome' | 'address'>): RollEvent {
  return {
    multiplier: 10, // v1 default — overridden where the bet matters
    gross: 0,
    net: 0,
    balanceAfter: 0,
    ...p,
  };
}

/**
 * Fixture set — deliberately spread across all four windows:
 *  A: 1d  (in 7d)        win, roll 95,  bet 10, player A, v2 target 47 under
 *  B: 8d  (7d<·≤14d)     loss, roll 99 (highest face, must NOT become bestRoll), player A, v1 ×4
 *  C: 40d (30d<·≤12m)    win, roll 50,  bet 2,  player B, v2 target 20 over
 *  D: 400d (>12m, all)   loss, roll 1,  bet 1,  player B, v1 ×2
 *  E: 5d  (in 7d)        loss, roll 33,  bet 1,  player C, v1 ×10
 */
const FIXTURE: RollEvent[] = [
  ev({ ts: NOW - 1 * DAY, roll: 95, bet: 10, outcome: 'win', address: ADDR_A, multiplier: 100 + 47 * 2, target: 47, over: false, gross: 20, net: 10, gameId: 1, commitTx: '0xcommit', verified: true, network: 'testnet' }),
  ev({ ts: NOW - 8 * DAY, roll: 99, bet: 5, outcome: 'loss', address: ADDR_A, multiplier: 4, net: -5, gameId: 2, verified: true }),
  ev({ ts: NOW - 40 * DAY, roll: 50, bet: 2, outcome: 'win', address: ADDR_B, multiplier: 100 + 20 * 2 + 1, target: 20, over: true, gross: 4, net: 2 }),
  ev({ ts: NOW - 400 * DAY, roll: 1, bet: 1, outcome: 'loss', address: ADDR_B, multiplier: 2, net: -1 }),
  ev({ ts: NOW - 5 * DAY, roll: 33, bet: 1, outcome: 'loss', address: ADDR_C, multiplier: 10, net: -1 }),
];

/* ── Empty log ──────────────────────────────────────────────────────── */
for (const range of ['7d', '30d', '12m', 'all'] as RangeKey[]) {
  const d = aggregateRolls([], range, NOW);
  check(
    `empty log [${range}] → all zeros`,
    d.games === 0 && d.staked === 0 && d.wins === 0 && d.losses === 0 &&
    d.winRate === 0 && d.bestRoll === 0 && d.gamesDelta7d === 0 && d.players.length === 0,
  );
}

const EXPECTED_BUCKET_COUNT: Record<RangeKey, number> = { '7d': 7, '30d': 30, '12m': 12, all: 26 };
/**
 * Chart window ≠ card window only for 'all': cards count full history,
 * the chart is capped at a rolling 26 weeks — fixture D (400d) is in the
 * cards but outside the chart. This split is asserted on purpose.
 */
const EXPECTED_IN_BUCKET: Record<RangeKey, { games: number; staked: number }> = {
  '7d': { games: 2, staked: 11 },
  '30d': { games: 3, staked: 16 },
  '12m': { games: 4, staked: 18 },
  all: { games: 4, staked: 18 }, // D (400d) is in the cards, not in the 26-week chart
};
for (const range of ['7d', '30d', '12m', 'all'] as RangeKey[]) {
  const d = aggregateRolls(FIXTURE, range, NOW);
  const bucketGames = d.buckets.reduce((s, b) => s + b.games, 0);
  const bucketStaked = d.buckets.reduce((s, b) => s + b.staked, 0);
  check(`[${range}] bucket skeleton has ${EXPECTED_BUCKET_COUNT[range]} buckets`, d.buckets.length === EXPECTED_BUCKET_COUNT[range]);
  check(`[${range}] buckets hold exactly the in-chart games`, bucketGames === EXPECTED_IN_BUCKET[range].games, `buckets=${bucketGames} expected=${EXPECTED_IN_BUCKET[range].games}`);
  check(`[${range}] buckets hold exactly the in-chart stake`, bucketStaked === EXPECTED_IN_BUCKET[range].staked, `buckets=${bucketStaked} expected=${EXPECTED_IN_BUCKET[range].staked}`);
}
check(
  "'all' split: cards count full history (5 games) while chart caps at 26w (4)",
  (() => { const d = aggregateRolls(FIXTURE, 'all', NOW); return d.games === 5 && d.buckets.reduce((s, b) => s + b.games, 0) === 4; })(),
);

/* ── Stat cards per range (exact numbers) ───────────────────────────── */
const EXPECTED: Record<RangeKey, { games: number; staked: number; wins: number; losses: number; winRate: number; bestRoll: number; delta: number }> = {
  // 7d window: A(1d) + E(5d)
  '7d': { games: 2, staked: 11, wins: 1, losses: 1, winRate: 50, bestRoll: 95, delta: 2 - 1 },
  // 30d window: A + B(8d) + E
  '30d': { games: 3, staked: 16, wins: 1, losses: 2, winRate: 33, bestRoll: 95, delta: 2 - 1 },
  // 12m window: A + B + C(40d) + E   (D at 400d is out)
  '12m': { games: 4, staked: 18, wins: 2, losses: 2, winRate: 50, bestRoll: 95, delta: 2 - 1 },
  // all: everything
  all: { games: 5, staked: 19, wins: 2, losses: 3, winRate: 40, bestRoll: 95, delta: 2 - 1 },
};
for (const range of ['7d', '30d', '12m', 'all'] as RangeKey[]) {
  const e = EXPECTED[range];
  const d = aggregateRolls(FIXTURE, range, NOW);
  check(
    `[${range}] stat cards exact`,
    d.games === e.games && d.staked === e.staked && d.wins === e.wins && d.losses === e.losses &&
    d.winRate === e.winRate && d.bestRoll === e.bestRoll && d.gamesDelta7d === e.delta,
    `got games=${d.games} staked=${d.staked} wins=${d.wins} losses=${d.losses} rate=${d.winRate}% best=${d.bestRoll} Δ7d=${d.gamesDelta7d}`,
  );
}
check(
  'bestRoll ignores losing faces (loss roll 99 < win roll 95)',
  aggregateRolls(FIXTURE, 'all', NOW).bestRoll === 95,
);
check(
  'delta-7d = last 7d (2) − previous 7d (1) = +1',
  aggregateRolls(FIXTURE, 'all', NOW).gamesDelta7d === 1,
);
/* ── Top players rollup ─────────────────────────────────────────────── */
const players = aggregateRolls(FIXTURE, 'all', NOW).players;
check('top players: 3 distinct addresses', players.length === 3, players.map((p) => p.short).join(', '));
check(
  'top players: A (2 games, 1 win, 15 staked) ranks first',
  players[0]?.address === ADDR_A && players[0].games === 2 && players[0].wins === 1 && players[0].staked === 15,
);
check(
  'top players: B (2 games, 1 win, 3 staked) second — staked tie-break after games tie',
  players[1]?.address === ADDR_B && players[1].games === 2 && players[1].wins === 1 && players[1].staked === 3,
);
check(
  'top players: C (1 game, 0 wins, 1 staked) third',
  players[2]?.address === ADDR_C && players[2].games === 1 && players[2].wins === 0 && players[2].staked === 1,
);
check('short address form k5…1111', players[0]?.short === 'k5…1111', players[0]?.short);

const many = Array.from({ length: 10 }, (_, i) =>
  ev({ ts: NOW - i, roll: 50, bet: 1, outcome: 'win', address: `k5:addr${i}addr${i}zz` }));
check('top players sliced to 8 of 10 addresses', rollupPlayers(many).length === 8);

/* ── shortAddress edge cases ────────────────────────────────────────── */
check('shortAddress: long → k5…3456', shortAddress('k5:abcdef123456') === 'k5…3456');
check('shortAddress: short (≤8) passes through', shortAddress('abc') === 'abc');

/* ── Summary ────────────────────────────────────────────────────────── */
console.log('');
if (failed > 0) {
  console.log(`${failed} check(s) FAILED, ${passed} passed — dashboard RECONCILIATION BROKEN`);
  process.exit(1);
}
console.log(`ALL ${passed} EVENT-LOG / DASHBOARD RECONCILIATION CHECKS PASSED`);