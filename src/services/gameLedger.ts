/**
 * gameLedger.ts — local index of the user's own on-chain kDice games
 * (Phase 4.7).
 *
 * The contract stores global commit/roll records but exposes no
 * per-player listing endpoint (only `getCommitsCount` + point lookups),
 * so the dApp keeps its own index of games it committed — game id, bet,
 * stake, tx hashes — to power "My games" and to re-verify the result later.
 *
 * Protocol v3 (Phase 7): the roll is settled by the commit transaction
 * itself (derived on-chain from the confirming block's random seed), so a
 * local game entry no longer needs any client seeds, a commitment hash, or
 * a settle transaction — it only tracks the commit and the on-chain result.
 */
import { useEffect, useState } from 'react';

/** Lifecycle of one local game entry (v3: one tx, no settle step). */
export type OnChainGameStatus = 'committing' | 'settled' | 'failed';

export interface OnChainGame {
  /** Contract-assigned game id (set once the commit confirms). */
  id: number | null;
  /** Local creation time (ms epoch) — also the stable ledger key. */
  ts: number;
  /**
   * Stored bet value (the contract's `multiplier` field): v1 multiplier
   * {2,4,10,50} or v2 encoded bet `100 + target·2 + over` (Phase 4.10).
   * Kept under the contract's field name so ledger entries map 1:1 to the
   * on-chain records; display via `fair.ts::betLabel`.
   */
  multiplier: number;
  /** Stake in smallest KLV units (6 decimals) — string, lossless. */
  stakeMicro: string;
  /** Commit tx hash (the only on-chain transaction in protocol v3). */
  commitTx: string | null;
  status: OnChainGameStatus;
  /** On-chain result, filled after the commit confirms and the roll is read back. */
  roll: number | null;
  win: boolean | null;
  /** On-chain roll equals the local `fair.ts` re-derivation. */
  verified: boolean | null;
}

const KEY = 'kdice.onchain.games.v1';
/** Bounded store — the ledger is a convenience index, not a database. */
const MAX_ENTRIES = 100;

type Ledger = OnChainGame[];
const listeners = new Set<() => void>();

function load(): Ledger {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive shape check — a hand-edited/corrupt entry must not
    // crash the game UI (AGENTS §5C: untrusted input).
    return (parsed as OnChainGame[]).filter(
      (g) =>
        typeof g === 'object' &&
        g !== null &&
        typeof g.ts === 'number' &&
        typeof g.multiplier === 'number' &&
        typeof g.stakeMicro === 'string',
    ).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

let ledger: Ledger = load();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ledger.slice(0, MAX_ENTRIES)));
  } catch {
    /* storage blocked — in-memory ledger still works for this page */
  }
}

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* a broken listener must never wedge the bus */
    }
  }
}

/** Subscribe to ledger changes. Returns an unsubscribe fn. */
export function subscribeLedger(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Snapshot, newest first. */
export function getGames(): readonly OnChainGame[] {
  return [...ledger].sort((a, b) => b.ts - a.ts);
}

/** Append a new game (newest first). */
export function addGame(game: OnChainGame): OnChainGame {
  ledger = [game, ...ledger].slice(0, MAX_ENTRIES);
  persist();
  notify();
  return game;
}

/** Patch the entry with the given creation ts (stable across id assignment). */
export function updateGameByTs(ts: number, patch: Partial<OnChainGame>): void {
  ledger = ledger.map((g) => (g.ts === ts ? { ...g, ...patch } : g));
  persist();
  notify();
}

/** Find an entry by its contract game id (null when absent). */
export function findGameById(id: number): OnChainGame | null {
  return ledger.find((g) => g.id === id) ?? null;
}

/** React view over the ledger (newest first). */
export function useGameLedger(): readonly OnChainGame[] {
  const [snap, setSnap] = useState<readonly OnChainGame[]>(() => getGames());
  useEffect(() => subscribeLedger(() => setSnap(getGames())), []);
  return snap;
}