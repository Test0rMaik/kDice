/**
 * Dashboard.tsx — Phase 3 "Overall Dashboard".
 *
 * Stat cards (KLV spent + sparkline, games + weekly delta, W/L + win rate,
 * best roll), a time-filtered activity area chart, and the top-players
 * table. All data comes from the local event log (services/eventLog) via
 * the reactive `useDashboard` hook — no network.
 */
import { useState } from 'react';
import { useDashboard } from '../hooks/useDashboard';
import { useCountUp } from '../hooks/useCountUp';
import { TrendChart } from './TrendChart';
import type { RangeKey } from '../services/eventLog';

const RANGES: ReadonlyArray<{ key: RangeKey; label: string }> = [
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '12m', label: '12m' },
  { key: 'all', label: 'All time' },
];

export function Dashboard() {
  const [range, setRange] = useState<RangeKey>('30d');
  const d = useDashboard(range);

  const spark = d.buckets.slice(-14).map((b) => b.staked);
  const delta = d.gamesDelta7d;
  const axis = d.buckets.length > 1
    ? [d.buckets[0], d.buckets[Math.floor(d.buckets.length / 2)], d.buckets[d.buckets.length - 1]]
    : [];

  // Phase 4.11: stat cards count up when a roll settles (tween in the
  // hook; instant under prefers-reduced-motion).
  const staked = useCountUp(d.staked);
  const games = useCountUp(d.games);
  const wins = useCountUp(d.wins);
  const losses = useCountUp(d.losses);

  return (
    <div className="dash">
      <div className="dash__head">
        <h2 className="dash__title">Overall Dashboard</h2>
        <div className="range-tabs" role="group" aria-label="time range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              aria-pressed={range === r.key}
              className={`range-tabs__btn${range === r.key ? ' range-tabs__btn--active' : ''}`}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="dash__cards">
        <article className="card">
          <span className="card__label">KLV spent</span>
          <span className="card__value">{staked.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>
          {spark.length > 1 ? (
            <TrendChart
              key={range}
              values={spark}
              width={120}
              height={30}
              ariaLabel={`staked trend over ${range}`}
            />
          ) : (
            <span className="card__muted">no data yet</span>
          )}
        </article>

        <article className="card">
          <span className="card__label">Games</span>
          <span className="card__value">{Math.round(games)}</span>
          <span className={`card__delta${delta >= 0 ? ' card__delta--up' : ' card__delta--down'}`}>
            Δ {delta >= 0 ? '+' : ''}{delta} · 7d
          </span>
        </article>

        <article className="card">
          <span className="card__label">Wins / Losses</span>
          <span className="card__value">
            <span className="card__win">{Math.round(wins)}</span> /{' '}
            <span className="card__loss">{Math.round(losses)}</span>
          </span>
          <span className="card__muted">{d.winRate}% win rate</span>
        </article>

        <article className="card">
          <span className="card__label">Best roll</span>
          <span className="card__value">{d.bestRoll > 0 ? d.bestRoll : '—'}</span>
          <span className="card__muted">winning d100</span>
        </article>
      </div>

      <div className="dash__chart">
        <span className="dash__chart-label">Activity · credits staked</span>
        {d.buckets.some((b) => b.staked > 0) ? (
          <>
            <TrendChart
              key={range}
              values={d.buckets.map((b) => b.staked)}
              width={720}
              height={140}
              fluid
              ariaLabel={`activity chart for ${range}`}
            />
            <div className="dash__axis" aria-hidden="true">
              <span>{axis[0]?.label}</span>
              <span>{axis[1]?.label}</span>
              <span>{axis[2]?.label}</span>
            </div>
          </>
        ) : (
          <p className="dash__empty">
            No rolls in this range yet — hit <b>ROLL</b> and the dashboard comes alive.
          </p>
        )}
      </div>

      <div className="dash__players">
        <h3 className="dash__players-title">Top players</h3>
        {d.players.length > 0 ? (
          <table className="dash__table">
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col" className="dash__num">Games</th>
                <th scope="col" className="dash__num">W/L %</th>
                <th scope="col" className="dash__num">Staked</th>
              </tr>
            </thead>
            <tbody>
              {d.players.map((p) => {
                const pct = p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0;
                return (
                  <tr key={p.address}>
                    <td className="dash__addr">{p.short}</td>
                    <td className="dash__num">{p.games}</td>
                    <td className="dash__num">
                      {/* Concept A `.pill`: green ≥50% win rate, red below */}
                      <span className={`pill ${pct >= 50 ? 'pill--w' : 'pill--l'}`}>{pct}%</span>
                    </td>
                    <td className="dash__num gold-cell">{p.staked}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="dash__empty">No players yet.</p>
        )}
      </div>
    </div>
  );
}