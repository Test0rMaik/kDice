/**
 * OnChainDice.tsx — THE dice table (hero). Fully on-chain play, contract v3.
 *
 * Phase 7 — single-transaction chain-random commit: ONE ROLL click runs a
 * single real K5 transaction through the Klever Extension, no manual steps
 * in between:
 *
 *   1. ROLL click — the die starts tumbling toward a neutral face. The real
 *      outcome does NOT exist yet: it depends on the confirming block's
 *      consensus random seed (unknown to the player at sign-time).
 *   2. `commit(target, over, stake)` tx (extension prompt) — the contract
 *      stores the bet and the confirming block's random seed, then derives
 *      the d100 roll itself: roll = LE_u32(SHA256(block_seed ‖ game_id)[0..4]) % 100 + 1.
 *   3. background: wait for confirmation and locate the game id (the die
 *      keeps tumbling the whole time).
 *   4. read the roll record + the stored 48-byte block seed back, and
 *      re-derive the roll locally from (block seed, game id) — require an
 *      exact match: the ✅ badge is the provably-fair proof.
 *   5. result banner + sound, then the table auto-returns to ready: the
 *      next ROLL is a single click. Every settled game also feeds the
 *      Overall Dashboard event log.
 *
 * Because the player commits blind to a block that does not exist yet, they
 * cannot pre-roll or cherry-pick (the classic commit-reveal weakness of the
 * v2 client-seed model is structurally gone).
 *
 * Bet model (Phase 4.10, contract v2): UNDER/OVER toggle + a 1–99 target
 * slider replace the old fixed ×2/4/10/50 buttons. The win rule is
 * `over ? roll > target : roll ≤ target` and the payout is the contract's
 * continuous 5%-edge `stake × 9500 / (over ? 100−target : target)` — both
 * computed locally from `fair.ts` and cross-checked against the on-chain
 * record after the commit confirms.
 *
 * No KLV moves at commit — the deployed contract is record-only (payouts
 * reconcile off-chain, testnet model). The stake is recorded on-chain and
 * drives the payout math shown here.
 */
import { useCallback, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { Dice } from './Dice';
import {
  betLabel,
  encodeBet,
  hexToBytes,
  payoutFor,
  payoutForBet,
  resolveBet,
  settleFromBlockSeed,
} from '../engine/fair';
import {
  type SCConfig,
  SCError,
  getCommitsCount,
  getCommit,
  getRoll,
  loadConfig,
  networkTag,
} from '../services/scClient';
import { addGame, updateGameByTs, type OnChainGame } from '../services/gameLedger';
import { explorerUrl, invokeContract, minimalHex, TxError, waitForTx } from '../services/txClient';
import { getBalanceKLV, useWallet } from '../services/wallet';
import { recordRoll } from '../services/eventLog';
import { useRollAnimation } from '../hooks/useRollAnimation';
import { useSound } from '../hooks/useSound';

type Stage = 'idle' | 'committing' | 'rolling' | 'settling' | 'settled';

interface Result {
  roll: number;
  win: boolean;
  /** On-chain roll equals the local `fair.ts` derivation. */
  verified: boolean;
  localRoll: number;
}

/** Stake bounds in whole KLV (sanity cap keeps micro-units well inside JS integers). */
const MIN_STAKE_KLV = 0.000001;
const MAX_STAKE_KLV = 1_000_000;

function friendly(err: unknown): string {
  if (err instanceof TxError) return `[${err.stage}] ${err.message}`;
  if (err instanceof SCError) {
    return err.requireFailed ? 'Contract rejected the call: ' + err.message : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function shortHash(hash: string): string {
  return hash.slice(0, 10) + '…' + hash.slice(-6);
}

/**
 * Locate our commit id after it confirms. `commits_count` is the max id,
 * so the newest record is usually ours — but another player's commit can
 * confirm in between, so scan back ≤5 ids for a (player, stake) match.
 * (Protocol v3 records no client commitment — the record's `hash` field is
 * the block seed — so identity is matched on player + stake.)
 */
async function findMyCommit(config: SCConfig, stakeMicro: string, address: string): Promise<number> {
  const max = await getCommitsCount(config);
  const wantStake = stakeMicro.toLowerCase();
  const wantAddr = address.toLowerCase();
  for (let back = 0; back < 5 && max - back >= 1; back++) {
    const id = max - back;
    try {
      const rec = await getCommit(config, id);
      if (rec.stake.toLowerCase() === wantStake && rec.player.toLowerCase() === wantAddr) {
        return id;
      }
    } catch {
      /* id missing — keep scanning */
    }
  }
  // Fallback: the max id is overwhelmingly likely ours (we just committed).
  // A same-stake/same-address concurrent commit would be indistinguishable,
  // so defaulting to the newest record is the safest best-effort answer.
  if (max >= 1) return max;
  throw new TxError('confirm', 'commit confirmed but no commit record found — check "My games" to locate it');
}

export function OnChainDice(): ReactElement {
  const wallet = useWallet();
  const sound = useSound();
  /** v2 bet (Phase 4.10): target 1..99 + side, defaulting to a balanced "Under 50". */
  const [target, setTarget] = useState<number>(50);
  const [over, setOver] = useState<boolean>(false);
  const [stakeDraft, setStakeDraft] = useState('1');
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [game, setGame] = useState<OnChainGame | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  /** Final d100 face the die animates to (local derivation == on-chain roll). */
  const [finalFace, setFinalFace] = useState<number>(1);

  // Guards stale background chains: after "New game" (or a new ROLL) any
  // setState from a previous session's auto chain must be dropped.
  const sessionRef = useRef(0);
  // Per-session animation gate — resolved when the die locks its face, so
  // the on-chain reveal never lands on a tumbling die.
  const animDoneRef = useRef<{ ts: number; p: Promise<void>; r: () => void } | null>(null);
  // Pending "settled → ready" auto-advance timer (cleared by new sessions).
  const advanceTimerRef = useRef(0);

  const busy = stage === 'committing' || stage === 'rolling' || stage === 'settling';
  /** ROLL is available on a fresh table AND right after a settled result. */
  const canRoll = stage === 'idle' || stage === 'settled';

  const stakeNum = Number(stakeDraft);
  const stakeMicro = Number.isFinite(stakeNum) ? Math.round(stakeNum * 1_000_000) : NaN;
  const validStake =
    Number.isInteger(stakeMicro) && stakeMicro >= 1 && stakeMicro <= MAX_STAKE_KLV * 1_000_000;

  const patchGame = useCallback((ts: number, patch: Partial<OnChainGame>) => {
    setGame((prev) => (prev && prev.ts === ts ? { ...prev, ...patch } : prev));
  }, []);
  /**
   * finalizeGame — the post-commit read-back, shared by the auto chain and
   * the manual retry. Protocol v3: the roll is ALREADY settled by the
   * commit tx itself (derived on-chain from the confirming block's random
   * seed), so there is no second transaction to broadcast. Here we read the
   * roll record + the stored 48-byte block seed back, RE-DERIVE the roll
   * locally from (block seed, game id) and require an exact match (the ✅
   * badge). Shows the result, feeds the dashboard event log, and
   * auto-advances the table back to ready.
   * Throws on failure so the caller can park the game in retry state.
   */
  const finalizeGame = async (g: OnChainGame, id: number): Promise<void> => {
    const ts = g.ts;
    const config = loadConfig();
    const onChain = await getRoll(config, id);
    // The whole point of provable fairness: re-derive the roll locally from
    // the same (block seed, game id) the contract used and require an exact
    // match with the record the contract stored when it derived the roll.
    const commitRec = await getCommit(config, id);
    const local = await settleFromBlockSeed(hexToBytes(commitRec.hash), id, g.multiplier);
    const verified =
      onChain.roll === local.roll && onChain.win === local.win && onChain.multiplier === g.multiplier;
    if (sessionRef.current !== ts) {
      updateGameByTs(ts, { status: 'settled', roll: onChain.roll, win: onChain.win, verified });
      return;
    }
    updateGameByTs(ts, { status: 'settled', roll: onChain.roll, win: onChain.win, verified });
    patchGame(ts, { status: 'settled', roll: onChain.roll, win: onChain.win, verified });
    setResult({ roll: onChain.roll, win: onChain.win, verified, localRoll: local.roll });
    setFinalFace(onChain.roll);
    setStage('settled');
    const stakeKLV = Number(g.stakeMicro) / 1_000_000;
    // Payout from the RECORDED bet value (v1 ×mult or v2 9500/denom — the
    // record-only contract reconciles payouts off-chain, display math).
    const gross = onChain.win ? payoutForBet(g.multiplier, stakeKLV) : 0;
    if (onChain.win) sound.win(gross);
    else sound.lose();
    // Feed the Overall Dashboard's event log — one event per settled game
    // (Phase 5 schema: roll, stake, payout, address, ts + on-chain
    // traceability so the row can be re-verified via the ProvablyFair
    // panel). A failed write must never block or disturb the game loop.
    void (async (): Promise<void> => {
      let balanceAfter = 0;
      try {
        balanceAfter = await getBalanceKLV(wallet.address as string);
      } catch {
        balanceAfter = 0; // offline — the stat still lands
      }
      await recordRoll({
        ts,
        roll: onChain.roll,
        multiplier: g.multiplier,
        ...(resolveBet(g.multiplier)?.isV2
          ? { target: resolveBet(g.multiplier)!.target, over: resolveBet(g.multiplier)!.over }
          : {}),
        bet: stakeKLV,
        outcome: onChain.win ? 'win' : 'loss',
        gross,
        net: gross - stakeKLV,
        address: wallet.address as string,
        balanceAfter,
        gameId: id,
        commitTx: g.commitTx ?? undefined,
        verified,
        network: networkTag(config.nodeUrl),
      });
    })().catch(() => undefined);
    // Auto-advance: after a short read-pause the table returns to ready;
    // the result banner + badge stay visible until the next ROLL.
    window.clearTimeout(advanceTimerRef.current);
    advanceTimerRef.current = window.setTimeout(() => {
      if (sessionRef.current === ts) setStage('idle');
    }, 4000);
  };

  /**
   * ROLL — one click runs the ENTIRE on-chain game (Phase 7 chain-random).
   *
   *   1. ROLL click — the die starts tumbling toward a neutral face. The
   *      real outcome does not exist yet: it is fixed only when the
   *      confirming block's consensus random seed is produced by the
   *      Klever validator set (unknown to the player at sign-time).
   *   2. `commit(target, over, stake)` tx (extension prompt) — the
   *      contract stores the bet + the confirming block's seed and
   *      derives the d100 roll on-chain. There is NO second transaction
   *      and NO client seed: the player commits blind to a future block,
   *      so they cannot pre-roll or cherry-pick.
   *   3. background: wait for confirmation → locate the game id (the die
   *      keeps tumbling the whole time);
   *   4. read the roll record + block seed back, re-derive locally
   *      (block seed, game id) → ✅ badge;
   *   5. die locks on the real face → WIN/LOSS banner → auto-advance to
   *      ready; the next ROLL is one click.
   *
   * Failure paths: commit fails → straight back to ROLL-ready with the
   * error (nothing was recorded on-chain); the read-back fails → the game
   * is already settled on-chain, so a manual "RETRY" re-read appears.
   */
  const roll = async (): Promise<void> => {
    if (!canRoll || !wallet.address || !validStake) return;
    window.clearTimeout(advanceTimerRef.current);
    setError(null);
    setResult(null);
    const config = loadConfig();
    const ts = Date.now();
    sessionRef.current = ts;
    // Animation gate: the result (finalFace) only becomes meaningful once
    // the commit confirms; until then the die shows a neutral random face
    // and never leaks a future outcome (there is no local pre-derivation —
    // the roll depends on the confirming block's seed, which does not exist
    // yet).
    let resolveAnim: () => void = () => undefined;
    const animDone = new Promise<void>((res) => { resolveAnim = res; });
    animDoneRef.current = { ts, p: animDone, r: resolveAnim };
    const g: OnChainGame = {
      id: null,
      ts,
      multiplier: encodeBet(target, over),
      stakeMicro: String(stakeMicro),
      commitTx: null,
      status: 'committing',
      roll: null,
      win: null,
      verified: null,
    };
    addGame(g);
    setGame(g);
    // SECURITY (commit-reveal integrity): the outcome must NEVER be
    // visible while the commit is still pending. Park a neutral face and
    // let the real value appear only after the confirming block's seed is
    // stored on-chain (finalizeGame sets finalFace from the on-chain roll).
    setFinalFace(1 + Math.floor(Math.random() * 100));
    setStage('committing');
    try {
      // Contract v3 (Phase 7): `commit(target, over, stake)` — ONE
      // transaction. The bool arg uses the node-verified `00`/`01` hex
      // tokens. The roll is derived on-chain from the confirming block's
      // random seed + the assigned game id (no client seed).
      const tx = await invokeContract(config.contract, 'commit', [
        minimalHex(target),
        over ? '01' : '00',
        minimalHex(stakeMicro),
      ]);
      updateGameByTs(ts, { commitTx: tx });
      patchGame(ts, { commitTx: tx });
      // Broadcast succeeded → let the die fly. (Sound starts with the roll.)
      sound.roll();
      setStage('rolling');
      // ── Auto chain: confirm → (die locks) → verify → ready ──
      // A newer session (sessionRef) always wins: superseded chains keep
      // the LEDGER accurate but never touch UI state.
      void (async () => {
        let id: number;
        try {
          await waitForTx(tx);
          id = await findMyCommit(config, String(stakeMicro), wallet.address as string);
        } catch (err) {
          if (sessionRef.current !== ts) return;
          updateGameByTs(ts, { status: 'failed' });
          patchGame(ts, { status: 'failed' });
          setStage('idle');
          setError(friendly(err) + ' — the commit did not record on-chain. ROLL again to retry.');
          return;
        }
        if (sessionRef.current !== ts) {
          updateGameByTs(ts, { id, status: 'settled' });
          return;
        }
        // Let the die finish its tumble before the on-chain result lands
        // (capped, so a stuck animation can't block the game indefinitely).
        await Promise.race([animDone, new Promise<void>((r) => { window.setTimeout(r, 1500); })]);
        if (sessionRef.current !== ts) {
          updateGameByTs(ts, { id, status: 'settled' });
          return;
        }
        updateGameByTs(ts, { id });
        patchGame(ts, { id });
        setStage('settling');
        try {
          await finalizeGame(g, id);
        } catch (err) {
          if (sessionRef.current !== ts) return;
          // The game IS settled on-chain (the commit derived the roll);
          // only the local read-back failed. Park it for a manual re-read
          // instead of pretending it failed.
          updateGameByTs(ts, { id });
          patchGame(ts, { id });
          setStage('settled');
          setError(friendly(err) + ' — the game is settled on-chain; the read-back did not land. RETRY to re-read the result.');
        }
      })();
    } catch (err) {
      // Broadcast/signature failed (e.g. prompt rejected): no
      // transaction exists at all — reset the table.
      updateGameByTs(ts, { status: 'failed' });
      patchGame(ts, { status: 'failed' });
      setStage('idle');
      setError(friendly(err));
    }
  };
  /**
   * RETRY (manual) — re-reads the already-settled game's on-chain result.
   * Only reachable after the read-back of a confirmed commit failed; the
   * happy path finalizes automatically inside `roll`.
   */
  const retryFinalize = async (): Promise<void> => {
    const g = game;
    if (!g || g.id === null) return;
    setError(null);
    // Mark the in-flight re-read; the ledger only tracks the commit + result,
    // so 'committing' is the generic "still working" status here.
    updateGameByTs(g.ts, { status: 'committing' });
    patchGame(g.ts, { status: 'committing' });
    setStage('rolling');
    try {
      await finalizeGame(g, g.id);
    } catch (err) {
      if (sessionRef.current !== g.ts) return;
      // The game is still settled on-chain — only the read-back failed.
      patchGame(g.ts, { status: 'settled' });
      setStage('settled');
      setError(friendly(err) + ' — the read-back did not land. RETRY again.');
    }
  };

  const newGame = (): void => {
    // Abandon/cancel: drop the pending auto-advance, invalidate the
    // in-flight auto chain, and reset the table.
    window.clearTimeout(advanceTimerRef.current);
    sessionRef.current = 0;
    setStage('idle');
    setError(null);
    setGame(null);
    setResult(null);
  };

  // Animation gate: the hook fires exactly once when the die locks; resolve
  // the in-flight session's promise so the auto chain can reveal. Stable
  // identity matters — useRollAnimation restarts on callback changes.
  const onAnimSettle = useCallback((): void => {
    const a = animDoneRef.current;
    if (a) a.r();
  }, []);

  const { face: displayFace, isRolling } = useRollAnimation(
    stage === 'rolling' ? 'rolling' : 'idle',
    finalFace,
    onAnimSettle,
  );

  const winChancePct = over ? 100 - target : target;
  const stakeKLV = validStake ? stakeNum : 0;
  // Continuous 5%-edge payout, same integer formula as the contract's
  // `getPayout(target, over)` view (parity-locked in scripts/fair-parity).
  const payoutKLV = (stakeKLV * payoutFor(target, over)) / 100;
  // ── Gated states: extension missing / not connected ─────────────
  // (All hooks above have already run, so these early returns are safe.)
  if (!wallet.extensionAvailable) {
    return (
      <div className="table onchain-hero">
        <h2 className="panel__title">kDice — On-Chain (K5 Testnet)</h2>
        <div className="onchain__install">
          <p>
            Klever Extension not detected — it is required for on-chain play
            (the wallet signs every transaction; keys never leave the extension).
          </p>
          <a className="fair__btn" href="https://klever.io/extension" target="_blank" rel="noreferrer">
            Download Klever Extension
          </a>
        </div>
      </div>
    );
  }

  if (!wallet.connected) {
    return (
      <div className="table onchain-hero">
        <h2 className="panel__title">kDice — On-Chain (K5 Testnet)</h2>
        <div className="onchain__connect">
          <p>
            Connect your Klever wallet to play — <b>every roll becomes on-chain</b>:
            one commit transaction locks your bet, and the confirming block's
            consensus seed decides the roll (provably fair, no client seeds).
          </p>
          <button
            type="button"
            className="fair__btn"
            onClick={() => {
              void wallet.connect().catch(() => undefined);
            }}
            disabled={wallet.connecting}
          >
            {wallet.connecting ? 'Connecting…' : 'Connect K5 Wallet'}
          </button>
        </div>
      </div>
    );
  }

  // Result banner values come from the RECORDED game (not the live draft),
  // so editing the stake input after a settle can't skew the payout display.
  const gameStakeKLV = game ? Number(game.stakeMicro) / 1_000_000 : stakeKLV;
  const gamePayoutKLV = game ? payoutForBet(game.multiplier, gameStakeKLV) : payoutKLV;
  const fmtKLV = (v: number): string => v.toLocaleString(undefined, { maximumFractionDigits: 6 });
  // ── Live on-chain table ─────────────────────────────────────────
  return (
    <div className="table onchain-hero">
      <div className="table__hint">
        <b>FULLY ON-CHAIN</b> (K5 Testnet) — pick <b>UNDER</b> or <b>OVER</b> and a target <b>1–99</b>:
        you win if the die lands on your side. Fair payouts minus a flat <b>5% house edge</b>;
        every roll is settled in ONE real transaction — the confirming block's consensus
        seed (unknown to you in advance) decides the die, and the result is re-derived
        locally to prove it's fair.
      </div>

      <div className="game">
        {/* LEFT — bet controls (Concept A: 380px control rail on wide screens;
            on mobile this column drops below the die stage via CSS `order`). */}
        <div className="game__left">
          <div className="play-title">
            <h2>Play</h2>
            <small>tx fee ≈ 0.001 KLV · resolved on-chain</small>
          </div>

      <div className="controls">
        {/* v2 bet (Phase 4.10): side toggle + continuous 1–99 target.
            The slider replaces the fixed ×2/4/10/50 buttons — same 5%
            edge, now a smooth curve across the whole d100 range. */}
        <div className="bet-controls" aria-label="Over/Under bet">
          <div className="sides" role="group">
            <button
              type="button"
              className={`side${!over ? ' side--active' : ''}`}
              disabled={busy}
              onClick={() => setOver(false)}
            >
              UNDER <small>≤ {target}</small>
            </button>
            <button
              type="button"
              className={`side${over ? ' side--active' : ''}`}
              disabled={busy}
              onClick={() => setOver(true)}
            >
              OVER <small>≥ {target + 1}</small>
            </button>
          </div>
          <div className="target-row">
            <input
              type="range"
              min={1}
              max={99}
              step={1}
              value={target}
              disabled={busy}
              onChange={(e) => setTarget(Number(e.target.value))}
              className="target-slider"
              aria-label="Target roll"
            />
            <div className="target-readout">
              <span className="target-num">{target}</span>
              <span className="target-sub">
                {over ? `wins on ≥ ${target + 1}` : `wins on ≤ ${target}`} · {winChancePct}% · +{fmtKLV(payoutKLV)} KLV
              </span>
            </div>
          </div>
        </div>

        <label className="stake-input">
          <span>STAKE (KLV)</span>
          <input
            type="number"
            min={MIN_STAKE_KLV}
            max={MAX_STAKE_KLV}
            step="0.01"
            value={stakeDraft}
            onChange={(e) => setStakeDraft(e.target.value)}
            disabled={busy}
          />
        </label>
      </div>
      {/* ROLL is the only button on the happy path: one click runs the
          whole game (a single on-chain commit that settles the roll) and
          the next ROLL is right here. */}
      {canRoll && (
        <button
          type="button"
          className={`roll-btn${stage === 'idle' ? ' roll-btn--ready' : ''}`}
          onClick={() => void roll()}
          disabled={!validStake}
          aria-label={`roll — settle on-chain in one commit tx, stake ${stakeDraft} KLV on ${betLabel(encodeBet(target, over))}`}
        >
          <span className="roll-btn__label">🎲 ROLL</span>
          <span className="roll-btn__bet">{stakeDraft || 0} KLV · {betLabel(encodeBet(target, over))}</span>
        </button>
      )}

      <div className="payout-line">
        If you win: <b>+{fmtKLV(payoutKLV)} KLV</b>
        <small>win rate {winChancePct}% · 5% house edge</small>
      </div>

      {(wallet.error || error) && (
        <div className="fair__error" role="alert">
          {wallet.error ?? error}
        </div>
      )}
      </div>

      {/* RIGHT — stage: die, progress, result, prov line (Concept A result
          column). On mobile, CSS `order` lifts this column above controls. */}
      <div className="game__right">
        <div className={`tray${isRolling ? ' tray--rolling' : ''}${result !== null ? ' tray--land' : ''}`}>
          <Dice value={displayFace} rolling={isRolling} />
          {result !== null && result.win && (
            <div className="win-burst" aria-hidden="true">
              <span className="burst-ring" />
              {Array.from({ length: 10 }, (_, i) => (
                <span
                  key={i}
                  className="burst-spark"
                  style={{ '--i': i } as CSSProperties}
                />
              ))}
            </div>
          )}
        </div>

        {stage !== 'idle' && (
          <div className="onchain__stage" role="status" aria-live="polite">
            {(stage === 'committing' || stage === 'rolling' || stage === 'settling') && (
              <span className="stage-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            )}
            {stage === 'committing' && 'Broadcasting your commit on-chain…'}
            {stage === 'rolling' && 'Commit broadcast — the die is rolling while the chain finalizes…'}
            {stage === 'settling' && 'Confirmed — the contract is deriving the roll from the block seed…'}
            {stage === 'settled' &&
              (game !== null && game.id !== null
                ? `Game #${game.id} settled — table ready. Roll again?`
                : 'Settled — table ready. Roll again?')}
          </div>
        )}

        {result && game && (
          <div className={`result-banner result--${result.win ? 'win' : 'loss'}`}>
            {result.win ? 'WIN' : 'LOSE'}
            {' · '}rolled {result.roll} — {betLabel(game.multiplier)}
            {' · '}
            {result.win ? (
              <span className="result__net-pos">+{fmtKLV(gamePayoutKLV)} KLV payout</span>
            ) : (
              <span className="result__net-neg">−{fmtKLV(gameStakeKLV)} KLV</span>
            )}
          </div>
        )}

        {/* Manual RETRY only survives in the error path (the commit
            confirmed, but the local read-back of the result failed). */}
      {stage === 'settled' && error && (
        <div className="onchain__actions">
          <button
            type="button"
            className="roll-btn"
            onClick={() => void retryFinalize()}
            disabled={busy || game?.id === null}
            aria-label="retry — re-read the settled result on-chain"
          >
            <span className="roll-btn__label">RETRY</span>
            <span className="roll-btn__bet">
              {game !== null && game.id !== null ? `re-read result · game #${game.id}` : 'waiting for on-chain confirmation…'}
            </span>
          </button>
          <button type="button" className="fair__btn" onClick={newGame} disabled={busy}>
            Abandon game
          </button>
        </div>
      )}

      {game && game.commitTx && (
        <div className="onchain__tx">
          {game.id !== null && <span className="onchain__gid">game #{game.id}</span>}
          <span>
            commit{' '}
            <a href={explorerUrl(game.commitTx)} target="_blank" rel="noreferrer">
              {shortHash(game.commitTx)}
            </a>
          </span>
        </div>
      )}

      {result && (
        <div
          className={result.verified ? 'fair__badge fair__badge--ok' : 'fair__badge fair__badge--bad'}
          role="status"
        >
          {result.verified
            ? '✅ on-chain roll matches the local derivation (provably fair)'
            : '❌ MISMATCH: on-chain roll differs from the local derivation — don’t trust this result'}
        </div>
      )}
      </div>
      </div>
    </div>
  );
}