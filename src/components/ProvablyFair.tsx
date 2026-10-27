/**
 * ProvablyFair.tsx — on-chain block-seed verification panel (Phase 4.5, v3).
 *
 * Look up a kDice game on the K5 chain by gameId and verify it locally:
 *
 *  1. `getCommit(gameId)` / `getRoll(gameId)` over plain `vm/query`
 *     (no SDK — `services/scClient.ts`).
 *  2. Automatic check: the on-chain `win` flag must equal the local
 *     bet-rule decision (v1 `roll <= target`, v2 `over ? roll > t :
 *     roll <= t` — same integer path as the contract, `engine/fair.ts`).
 *  3. Deep check: paste the confirming block's 48-byte random seed and
 *     re-derive the d100 roll locally; it must match the on-chain record
 *     exactly. (Protocol v3: the roll comes from the block seed, so there
 *     are no client seeds and no settlement step to verify.)
 *
 * The local mock game table is untouched — this panel is read-only and
 * works fully offline-tolerant (network errors degrade to a message).
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  betLabel,
  deriveRollFromBlockSeed,
  evaluateOutcome,
  parseBlockSeedHex,
  payoutForBet,
} from '../engine/fair';
import { useGameLedger } from '../services/gameLedger';
import {
  type CommitRecord,
  type RollRecord,
  type SCConfig,
  SCError,
  getCommit,
  getCommitsCount,
  getRoll,
  getRollsCount,
  klvFromStake,
  loadConfig,
  saveConfig,
  shortAddress,
} from '../services/scClient';

interface LookupResult {
  gameId: number;
  commit: CommitRecord | null;
  roll: RollRecord | null;
  /** Commit exists but has no settlement yet (expected mid-game). */
  unsettled: boolean;
}

interface SeedCheck {
  roll: number;
  win: boolean;
  target: number;
  multiplier: number;
}

function tsDisplay(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

/** One labeled value row inside a record card. */
function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }): ReactElement {
  return (
    <div className={`fair__row${tone ? ` fair__row--${tone}` : ''}`}>
      <span className="fair__row-label">{label}</span>
      <span className="fair__row-value">{value}</span>
    </div>
  );
}

function Badge({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }): ReactElement {
  return (
    <span className={`fair__badge${ok ? ' fair__badge--ok' : ' fair__badge--bad'}`} role="status">
      {ok ? '✅ ' : '❌ '}
      {ok ? okText : badText}
    </span>
  );
}

export function ProvablyFair(): ReactElement {
  const [config, setConfig] = useState<SCConfig>(() => loadConfig());
  const [gameIdDraft, setGameIdDraft] = useState('1');
  const [status, setStatus] = useState<'idle' | 'loading' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [seedDraft, setSeedDraft] = useState('');
  const [seedCheck, setSeedCheck] = useState<SeedCheck | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ commits: number; rolls: number } | null>(null);

  // Chain-wide counters: cheap context for the panel header.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [commits, rolls] = await Promise.all([
          getCommitsCount(config),
          getRollsCount(config),
        ]);
        if (!cancelled) setStats({ commits, rolls });
      } catch {
        /* offline/misconfigured — the panel still works per-lookup */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  const applyConfig = useCallback((nodeUrl: string, contract: string) => {
    const clean: SCConfig = { nodeUrl: nodeUrl.replace(/\/+$/, ''), contract: contract.trim() };
    setConfig(clean);
    saveConfig(clean);
  }, []);

  const doLookup = useCallback(async (targetId?: number) => {
    // `targetId` lets "My games" verify a specific game without racing a
    // stale `gameIdDraft` closure (the draft is set in the same click).
    const gameId = targetId !== undefined ? targetId : Number(gameIdDraft);
    if (!Number.isInteger(gameId) || gameId < 1) {
      setError('Game ID must be a positive integer (it is the commit ordinal, e.g. 1, 2, 3…).');
      return;
    }
    setStatus('loading');
    setError(null);
    setResult(null);
    setSeedCheck(null);
    setSeedError(null);
    // Both lookups are independent: an unsettled game has a commit but no
    // roll — Promise.allSettled keeps the commit visible in that case.
    const [commitRes, rollRes] = await Promise.allSettled([
      getCommit(config, gameId),
      getRoll(config, gameId),
    ]);
    const notFound = (r: PromiseSettledResult<unknown>): boolean =>
      r.status === 'rejected' && r.reason instanceof SCError && r.reason.requireFailed;

    const commit = commitRes.status === 'fulfilled' ? commitRes.value : null;
    const roll = rollRes.status === 'fulfilled' ? rollRes.value : null;

    if (commit === null && roll === null) {
      if (notFound(commitRes) && notFound(rollRes)) {
        setError(`No commit #${gameId} on this contract — try another ID (chain has ${stats?.commits ?? '?'} commits, ${stats?.rolls ?? '?'} rolls).`);
      } else {
        const reason = commitRes.status === 'rejected' ? commitRes.reason : rollRes.status === 'rejected' ? rollRes.reason : null;
        setError(reason instanceof Error ? reason.message : 'Lookup failed');
      }
      setStatus('idle');
      return;
    }
    setResult({ gameId, commit, roll, unsettled: commit !== null && roll === null });
    setStatus('done');
  }, [config, gameIdDraft, stats]);

  const recomputeSeed = useCallback(async () => {
    setSeedError(null);
    setSeedCheck(null);
    const multiplier = result?.roll?.multiplier ?? result?.commit?.multiplier ?? 2;
    const gameId = result?.gameId ?? 1;
    try {
      const seed = parseBlockSeedHex(seedDraft);
      const roll = await deriveRollFromBlockSeed(seed, gameId);
      const { win, target } = evaluateOutcome(roll, multiplier);
      setSeedCheck({ roll, win, target, multiplier });
    } catch (err) {
      setSeedError(err instanceof Error ? err.message : 'Could not recompute from the block seed');
    }
  }, [result, seedDraft]);

  // Live derived checks (recomputed whenever result/seedCheck change).
  const winFlagOk =
    result?.roll != null ? result.roll.win === evaluateOutcome(result.roll.roll, result.roll.multiplier).win : null;
  const rollOk = seedCheck && result?.roll ? seedCheck.roll === result.roll.roll : null;

  // Phase 4.7: the player's own on-chain games (local ledger) — a per-
  // player history view, since the contract exposes no listing endpoint.
  const myGames = useGameLedger().slice(0, 10);

  return (
    <div className="panel fair">
      <h2 className="panel__title">Provably fair — on-chain (K5 testnet)</h2>

      {myGames.length > 0 && (
        <div className="fair__mygames">
          <h3 className="fair__card-title">My games (this browser)</h3>
          <table className="fair__mytable">
            <thead>
              <tr>
                <th>#</th>
                <th>When</th>
                <th>Stake</th>
                <th>Bet</th>
                <th>Status</th>
                <th>Result</th>
                <th>Verify</th>
              </tr>
            </thead>
            <tbody>
              {myGames.map((g) => (
                <tr key={g.ts}>
                  <td>{g.id ?? '…'}</td>
                  <td>{new Date(g.ts).toLocaleString()}</td>
                  <td>{klvFromStake(g.stakeMicro).toLocaleString()} KLV</td>
                  <td>{betLabel(g.multiplier)}</td>
                  <td>{g.status}</td>
                  <td>{g.roll !== null ? `${g.roll} ${g.win ? 'WIN' : 'LOSE'}` : '—'}</td>
                  <td>
                    {g.verified !== null && (
                      <span
                        className={g.verified ? 'fair__badge fair__badge--ok' : 'fair__badge fair__badge--bad'}
                        title={g.verified ? 'on-chain roll matched local derivation' : 'on-chain roll MISMATCHED local derivation'}
                      >
                        {g.verified ? '✅' : '❌'}
                      </span>
                    )}
                    {g.id !== null && (
                      <button
                        type="button"
                        className="fair__btn fair__btn--sm"
                        onClick={() => {
                          const id = g.id;
                          if (id === null) return;
                          setGameIdDraft(String(id));
                          void doLookup(id);
                        }}
                      >
                        inspect
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="fair__config">
        <label className="fair__field">
          <span>Node</span>
          <input
            type="text"
            value={config.nodeUrl}
            onChange={(e) => applyConfig(e.target.value, config.contract)}
            spellCheck={false}
          />
        </label>
        <label className="fair__field">
          <span>Contract</span>
          <input
            type="text"
            value={config.contract}
            onChange={(e) => applyConfig(config.nodeUrl, e.target.value)}
            spellCheck={false}
          />
        </label>
        {stats && (
          <span className="fair__stats">
            {stats.commits} commits · {stats.rolls} rolls
          </span>
        )}
      </div>

      <div className="fair__lookup">
        <label className="fair__field fair__field--game">
          <span>Game ID</span>
          <input
            type="number"
            min={1}
            value={gameIdDraft}
            onChange={(e) => setGameIdDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doLookup();
            }}
          />
        </label>
        <button
          type="button"
          className="fair__btn"
          onClick={() => void doLookup()}
          disabled={status === 'loading'}
        >
          {status === 'loading' ? 'Looking up…' : 'Look up game'}
        </button>
      </div>

      {error && (
        <div className="fair__error" role="alert">
          {error}
        </div>
      )}

      {result && (
        <div className="fair__grid">
          <div className="fair__card">
            <h3 className="fair__card-title">Commit record {result.commit ? `(#${result.gameId})` : ''}</h3>
            {result.commit ? (
              <>
                <Row label="Player" value={shortAddress(result.commit.player)} />
                <Row label="Bet" value={betLabel(result.commit.multiplier)} />
                <Row label="Stake" value={`${klvFromStake(result.commit.stake).toLocaleString()} KLV`} />
                <Row label="Block seed" value={result.commit.hash} />
                <Row label="Committed" value={tsDisplay(result.commit.createdAt)} />
                <Row
                  label="Status"
                  value={result.commit.active ? 'pending (not yet rolled)' : 'settled (rolled from block seed)'}
                  tone={result.commit.active ? undefined : 'ok'}
                />
              </>
            ) : (
              <p className="fair__empty">No commit record (only a roll was found — unusual).</p>
            )}
          </div>

          <div className="fair__card">
            <h3 className="fair__card-title">Roll record {result.roll ? `(#${result.gameId})` : ''}</h3>
            {result.roll ? (
              <>
                <Row label="d100 roll" value={String(result.roll.roll)} />
                <Row
                  label="Bet"
                  value={`${betLabel(result.roll.multiplier)} (target ${evaluateOutcome(result.roll.roll, result.roll.multiplier).target})`}
                />
                <Row label="Outcome" value={result.roll.win ? 'WIN' : 'LOSE'} tone={result.roll.win ? 'ok' : 'bad'} />
                <Row
                  label="Payout"
                  value={result.roll.win ? `${payoutForBet(result.roll.multiplier, klvFromStake(result.roll.stake)).toLocaleString()} KLV` : '0 KLV'}
                />
                <Row label="Settled" value={tsDisplay(result.roll.settledAt)} />
                {winFlagOk !== null && (
                  <Badge
                    ok={winFlagOk}
                    okText="win flag matches the local bet-rule decision"
                    badText="win flag CONTRADICTS the local bet-rule decision"
                  />
                )}
              </>
            ) : (
              <p className="fair__empty">
                {result.unsettled ? 'Roll not visible yet — the roll record appears once the commit confirms (block finality).' : 'No roll record found.'}
              </p>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="fair__seeds">
          <h3 className="fair__card-title">
            Deep verification — re-derive the d100 locally from the confirming block's random seed (48 bytes = 96 hex chars)
          </h3>
          <div className="fair__seed-row">
            <label className="fair__field">
              <span>Block seed (hex)</span>
              <input
                type="text"
                value={seedDraft}
                onChange={(e) => setSeedDraft(e.target.value)}
                placeholder="96 hex characters"
                spellCheck={false}
              />
            </label>
            <button type="button" className="fair__btn" onClick={() => void recomputeSeed()}>
              Re-derive locally
            </button>
          </div>
          {seedError && (
            <div className="fair__error" role="alert">
              {seedError}
            </div>
          )}
          {seedCheck && (
            <div className="fair__seed-result">
              <Row
                label="Local roll"
                value={`${seedCheck.roll} at ${betLabel(seedCheck.multiplier)} (target ${seedCheck.target}) → ${seedCheck.win ? 'WIN' : 'LOSE'}`}
              />
              {rollOk !== null && (
                <Badge ok={rollOk} okText="locally derived roll matches on-chain" badText="derived roll MISMATCH" />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}