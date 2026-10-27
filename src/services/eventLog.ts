/**
 * eventLog.ts — kDice local event log (Phase 3 dashboard store, finalized
 * in Phase 5 as the analytics pipeline's single source of truth).
 *
 * Single typed event store backed by IndexedDB (Dexie). Every SETTLED
 * on-chain roll appends one `RollEvent`; the Overall Dashboard derives its
 * views (stat cards, activity buckets, top-players rollup) from this log,
 * and the aggregation core is pure (`aggregateRolls`) so it is unit-tested
 * in `scripts/eventlog-tests.ts` without a browser.
 *
 * Why local and not chain-read for the dashboard: the on-chain record is
 * the source of truth for a game's result, but the chain exposes no
 * per-range stats endpoint — the log mirrors settled games locally for
 * instant rendering, and each event now carries the on-chain traceability
 * fields (gameId + tx hashes + verified flag) so any row can be re-checked
 * against the contract via the ProvablyFair panel.
 */
import Dexie, { type ObservabilitySet, type Table } from 'dexie';

/** One settled on-chain roll. `id` is the Dexie auto-increment primary key. */
export interface RollEvent {
  id?: number;
  /** Milliseconds since epoch (local commit time; chain slot is read-only history). */
  ts: number;
  /** d100 face landed (1–100), as derived on-chain. */
  roll: number;
  /**
   * Stored bet value: v1 multiplier (2|4|10|50) or v2 encoded bet
   * `100 + target·2 + over` (102..299) — decode with `fair.ts::resolveBet`.
   */
  multiplier: number;
  /** v2 bet side (Phase 4.10); v1 records have no target/side fields. */
  target?: number;
  over?: boolean;
  /** Stake committed (KLV). */
  bet: number;
  outcome: 'win' | 'loss';
  /** Gross payout returned (0 on loss). */
  gross: number;
  /** Net = gross − bet (negative on loss). */
  net: number;
  /** Player K5 bech32 address (fed by the connected extension wallet). */
  address: string;
  /** KLV balance right after this roll. */
  balanceAfter: number;

  // ── On-chain traceability (Phase 5) — every dashboard row can be
  //    re-verified against the contract via the ProvablyFair panel ──
  /** Contract-assigned game id. */
  gameId?: number;
  /** Commit tx hash (extension-signed; the only transaction in protocol v3). */
  commitTx?: string;
  /** `true` = on-chain roll matched the local `fair.ts` derivation. */
  verified?: boolean;
  /** Network the game settled on: 'testnet' | 'devnet' | 'mainnet'. */
  network?: string;
}

class KDiceDB extends Dexie {
  rolls!: Table<RollEvent, number>;

  constructor() {
    super('kdice');
    // v1 schema: `ts` indexes range scans, `address` feeds the top-players
    // rollup.
    this.version(1).stores({ rolls: '++id, ts, address' });
  }
}

const store = new KDiceDB();

/**
 * Append one settled roll to the local log.
 * Callers are expected to fire-and-forget (`.catch(() => undefined)`):
 * a failed write degrades dashboard stats but must never block the game loop.
 */
export async function recordRoll(event: Omit<RollEvent, 'id'>): Promise<void> {
  await store.rolls.add(event);
  notifyRollListeners();
}

/**
 * Subscribe to new log entries (drives live dashboard refresh).
 *
 * NOTE: Dexie 4.4.7 doesn't expose a typed `changes()` subscription in its
 * core bundle (LiveQuery ships via dexie-react-hooks), so we keep a small
 * in-module subscriber set. It is fed from two sources: the direct call in
 * `recordRoll` (same-tab guarantee) and the `storagemutated` global
 * subscription below (covers other tabs via Dexie's internal
 * BroadcastChannel), so every committed roll — wherever it happens —
 * refreshes every open dashboard.
 * @returns unsubscribe function
 */
const rollListeners = new Set<() => void>();

export function onRollsChanged(cb: () => void): () => void {
  rollListeners.add(cb);
  return () => {
    rollListeners.delete(cb);
  };
}

function notifyRollListeners(): void {
  for (const cb of rollListeners) {
    // Listeners must be non-throwing; a broken subscriber can't take down
    // the write path.
    try {
      cb();
    } catch {
      /* ignore subscriber errors */
    }
  }
}

/**
 * Cross-tab live sync. Dexie 4.4.7 broadcasts committed storage mutations
 * to other tabs over its internal BroadcastChannel and exposes them via the
 * typed `storagemutated` global event. The event fires for local mutations
 * too, so this registration alone would already keep same-tab dashboards
 * fresh — the direct call in `recordRoll` is kept as belt-and-braces
 * (a double-fire only triggers one extra cheap read of a small table).
 *
 * `parts` is keyed by `idb://${dbName}/${tableName}/${indexName}`, so we
 * only react to mutations touching our `rolls` table.
 */
Dexie.on('storagemutated', (parts: ObservabilitySet) => {
  if (Object.keys(parts).some((part) => part.includes('/rolls/'))) {
    notifyRollListeners();
  }
});

/* ------------------------------------------------------------------ *
 *  Dashboard aggregation (read-only views over the log)
 * ------------------------------------------------------------------ */

export type RangeKey = '7d' | '30d' | '12m' | 'all';

/** One bucket of the activity chart. */
export interface ActivityBucket {
  /** Bucket start (ms epoch). */
  t: number;
  /** Short human label (e.g. "10/17", "Mar"). */
  label: string;
  /** Credits staked in this bucket. */
  staked: number;
  /** Settled rolls in this bucket. */
  games: number;
}

/** Per-address rollup for the top-players table. */
export interface PlayerStat {
  address: string;
  /** Display form, short: `k5…8f2d` (per roadmap). */
  short: string;
  games: number;
  wins: number;
  staked: number;
}

/** Aggregated snapshot the Dashboard component renders. */
export interface DashboardData {
  games: number;
  staked: number;
  wins: number;
  losses: number;
  /** 0–100. */
  winRate: number;
  /** Best *winning* face (0 when no wins yet). */
  bestRoll: number;
  /** Games in the last 7d minus the previous 7d (card delta badge). */
  gamesDelta7d: number;
  buckets: ActivityBucket[];
  players: PlayerStat[];
}

/** Initial dashboard state before any query resolves. */
export function emptyDashboard(): DashboardData {
  return {
    games: 0, staked: 0, wins: 0, losses: 0,
    winRate: 0, bestRoll: 0, gamesDelta7d: 0,
    buckets: [], players: [],
  };
}

const DAY = 86_400_000;

function rangeStart(range: RangeKey, now: number): number {
  switch (range) {
    case '7d': return now - 7 * DAY;
    case '30d': return now - 30 * DAY;
    case '12m': return now - 366 * DAY;
    case 'all': return 0;
  }
}

/** `k5…` display form: first 2 + last 4 chars; short ids pass through. */
export function shortAddress(addr: string): string {
  return addr.length > 8 ? `${addr.slice(0, 2)}…${addr.slice(-4)}` : addr;
}

/**
 * Build the chart's bucket skeleton for a range:
 * 7d/30d → daily, 12m → calendar months, all → trailing 26 weeks
 * (capped rolling window; stat cards still count the full history).
 */
function buildBuckets(range: RangeKey, now: number): ActivityBucket[] {
  const out: ActivityBucket[] = [];
  if (range === '7d' || range === '30d') {
    const n = range === '7d' ? 7 : 30;
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now - i * DAY);
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      out.push({ t, label: `${d.getMonth() + 1}/${d.getDate()}`, staked: 0, games: 0 });
    }
  } else if (range === '12m') {
    const base = new Date(now);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
      out.push({
        t: d.getTime(),
        label: d.toLocaleString('en-US', { month: 'short' }),
        staked: 0,
        games: 0,
      });
    }
  } else {
    // "All time" → weekly buckets (Monday-anchored), last 26 weeks.
    const d = new Date(now);
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    const thisMonday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow).getTime();
    for (let i = 25; i >= 0; i--) {
      const t = thisMonday - i * 7 * DAY;
      const b = new Date(t);
      out.push({
        t,
        label: `${b.getMonth() + 1}/${b.getDate()}`,
        staked: 0,
        games: 0,
      });
    }
  }
  return out;
}

/**
 * Fold events into the bucket skeleton. Monthly buckets use exact calendar
 * math (month spans are 28–31d, so a fixed-span index would drift).
 */
function foldIntoBuckets(events: RollEvent[], buckets: ActivityBucket[], range: RangeKey): void {
  if (!buckets.length) return;
  const first = buckets[0].t;
  const lastIdx = buckets.length - 1;
  const firstDate = new Date(first);
  for (const e of events) {
    if (e.ts < first) continue; // older history counts in cards, just not the chart
    let idx: number;
    if (range === '12m') {
      const d = new Date(e.ts);
      idx = (d.getFullYear() - firstDate.getFullYear()) * 12 + d.getMonth() - firstDate.getMonth();
    } else if (range === '7d' || range === '30d') {
      idx = Math.floor((e.ts - first) / DAY);
    } else {
      idx = Math.floor((e.ts - first) / (7 * DAY));
    }
    if (idx >= lastIdx) idx = lastIdx;
    buckets[idx].staked += e.bet;
    buckets[idx].games += 1;
  }
}

/**
 * Per-address rollup for the top-players table.
 * Pure: takes the already range-filtered events. Sort: games desc, then
 * staked desc (stable tie-break so the "Top players" table is deterministic).
 */
export function rollupPlayers(
  events: readonly RollEvent[],
  limit = 8,
): PlayerStat[] {
  const byPlayer = new Map<string, PlayerStat>();
  for (const e of events) {
    let p = byPlayer.get(e.address);
    if (!p) {
      p = { address: e.address, short: shortAddress(e.address), games: 0, wins: 0, staked: 0 };
      byPlayer.set(e.address, p);
    }
    p.games += 1;
    p.staked += e.bet;
    if (e.outcome === 'win') p.wins += 1;
  }
  return [...byPlayer.values()]
    .sort((a, b) => b.games - a.games || b.staked - a.staked)
    .slice(0, limit);
}

/**
 * Pure aggregation core — the ONLY place dashboard numbers are computed
 * from `RollEvent[]` (Phase 5 gate: "dashboard reconciles with the event
 * log" is asserted against this function in `scripts/eventlog-tests.ts`).
 *
 * Contract: `events` is the FULL log (or any superset) — this function
 * applies the range per view, so callers can never over/under-count:
 *  - stat cards + top players → the range window ('all' = full history)
 *  - activity chart → its capped window (e.g. 'all' = trailing 26 weeks)
 *  - delta-7d badge → GLOBAL (last 7d vs previous 7d over the full log),
 *    so it reads the same on every tab — with a per-tab pre-filter the
 *    '7d' tab would lose the previous window and overstate the delta.
 *
 * `now` is injected (not `Date.now()` inside) so tests are deterministic.
 */
export function aggregateRolls(
  events: readonly RollEvent[],
  range: RangeKey,
  now: number,
): DashboardData {
  const start = rangeStart(range, now);
  const inRange = events.filter((e) => e.ts >= start);

  let wins = 0;
  let losses = 0;
  let staked = 0;
  let bestRoll = 0;
  for (const e of inRange) {
    staked += e.bet;
    if (e.outcome === 'win') {
      wins += 1;
      // "Best roll" is defined as the best *winning* face (dashboard copy).
      if (e.roll > bestRoll) bestRoll = e.roll;
    } else {
      losses += 1;
    }
  }
  const games = inRange.length;
  const winRate = games > 0 ? Math.round((wins / games) * 100) : 0;

  // Weekly delta badge is a global fact (see contract above).
  const inLast7 = (e: RollEvent): boolean => e.ts >= now - 7 * DAY;
  const inPrev7 = (e: RollEvent): boolean => e.ts < now - 7 * DAY && e.ts >= now - 14 * DAY;
  const gamesDelta7d = events.filter(inLast7).length - events.filter(inPrev7).length;

  const buckets = buildBuckets(range, now);
  foldIntoBuckets(inRange, buckets, range);

  return {
    games, staked, wins, losses, winRate, bestRoll, gamesDelta7d,
    buckets, players: rollupPlayers(inRange),
  };
}

/**
 * Aggregate the local log for one range tab.
 * Loads the full local table (small — one row per settled game) and lets
 * `aggregateRolls` own ALL range filtering (single source of truth).
 */
export async function getDashboardData(range: RangeKey): Promise<DashboardData> {
  const events = await store.rolls.toArray();
  return aggregateRolls(events, range, Date.now());
}