/**
 * App.tsx — kDice top-level composition (Phase 4.9: on-chain only).
 *
 *  - The HERO is `OnChainDice`: the fully on-chain dice table (a single
 *    commit transaction through the Klever Extension — the confirming
 *    block's seed settles the roll, no separate settle tx). This IS
 *    "the game" — the offline/mock practice table was removed on request.
 *  - `Dashboard` (event-log stats, fed by every settled on-chain game) and
 *    `ProvablyFair` (on-chain commits, rolls, "My games") remain global
 *    sections.
 *  - Wallet session (connect / silent restore / KLV balance) lives in the
 *    header via `services/wallet.ts`; theme (light/dark, Phase 6) persists
 *    via `services/theme.ts` and follows the OS while the user hasn't chosen.
 */
import { useEffect, useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { ProvablyFair } from './components/ProvablyFair';
import { OnChainDice } from './components/OnChainDice';
import { bootstrapWallet, getBalanceKLV, useWallet } from './services/wallet';
import { shortAddress } from './services/scClient';
import {
  applyTheme,
  initialTheme,
  storedTheme,
  toggleTheme as flipTheme,
  type Theme,
} from './services/theme';

export default function App() {
  const wallet = useWallet();
  /** KLV balance of the connected address (null = unknown/offline). */
  const [balance, setBalance] = useState<number | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  // One-shot startup: extension detection (≤3 s) + silent session restore
  // (re-verifies the stored address against the extension — dexscan
  // PT-P2-8 pattern). Runs once per page load regardless of re-renders.
  useEffect(() => {
    void bootstrapWallet();
  }, []);

  // Refresh the KLV balance when the connected address changes. The
  // stale-balance reset happens in the connect/disconnect CLICK handlers
  // (event-driven), not here — avoids setState-during-effect.
  useEffect(() => {
    if (!wallet.connected || !wallet.address) return;
    let cancelled = false;
    void getBalanceKLV(wallet.address)
      .then((b) => {
        if (!cancelled) setBalance(b);
      })
      .catch(() => {
        if (!cancelled) setBalance(null); // offline — header simply omits the balance
      });
    return () => {
      cancelled = true;
    };
  }, [wallet.connected, wallet.address]);

  // Theme applied to <html> so index.css can key off [data-theme].
  // (The pre-paint value comes from public/theme-init.js — no flash.)
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Follow live OS theme flips ONLY while the user hasn't made an explicit
  // choice (storedTheme() === null) — an explicit click always wins.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e: MediaQueryListEvent) => {
      if (storedTheme() === null) setTheme(e.matches ? 'light' : 'dark');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return (
    <div className="app">
      <header className="topbar rise rise-1">
        <div className="brand">
          <span className="logo-die" aria-hidden="true">🎲</span>
          <div>
            <span className="brand__name">k<span className="brand__k">D</span>ice</span>
            <span className="brand__tag">House Always Wins</span>
          </div>
        </div>
        <div className="topbar__right">
          {wallet.extensionAvailable ? (
            wallet.connected ? (
              <button
                type="button"
                className="wallet wallet--on"
                onClick={() => {
                  // Event-driven stale-balance reset (lint-clean alternative
                  // to setState-in-effect) before dropping the session.
                  setBalance(null);
                  wallet.disconnect();
                }}
                title={`${wallet.address ?? ''} — click to disconnect`}
              >
                <span className="wallet__dot" aria-hidden="true" />
                K5 · {shortAddress(wallet.address ?? '…')}
                {balance !== null && (
                  <span className="wallet__balance">
                    {balance.toLocaleString(undefined, { maximumFractionDigits: 6 })} KLV
                  </span>
                )}
              </button>
            ) : (
              <button
                type="button"
                className="wallet wallet--cta"
                onClick={() => {
                  // Clear any stale balance from a previous wallet so it
                  // can't flash next to the newly-connected address.
                  setBalance(null);
                  void wallet.connect().catch(() => undefined);
                }}
                disabled={wallet.connecting}
                title="Connect the Klever Extension wallet"
              >
                ⚡ {wallet.connecting ? 'Connecting…' : 'Connect K5 Wallet'}
              </button>
            )
          ) : (
            <a
              className="wallet"
              href="https://klever.io/extension"
              target="_blank"
              rel="noreferrer"
              title="Klever Extension not detected — open the download page"
            >
              <span className="wallet__dot" aria-hidden="true" />
              Install K5 Wallet
            </a>
          )}
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme(flipTheme(theme))}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>

      {/* Concept A hero band: headline + tag pills + decorative dice stage.
          Purely presentational — the game itself is the on-chain table below. */}
      <section className="hero-intro rise rise-1" aria-label="kDice introduction">
        <div className="hero-intro__copy">
          <h1>
            ROLL ON.
            <br />
            <span>WIN IN KLV.</span>
          </h1>
          <p>
            Provably fair dice on the Klever Blockchain. Pick a side, set your target,
            and watch the neon roll out — every game settles on-chain.
          </p>
          <div className="hero-tags">
            <span className="tag">⛓ On-chain fairness</span>
            <span className="tag">📊 Live stats</span>
            <span className="tag tag--gold">KLV payouts</span>
          </div>
        </div>
        <div className="dice-stage" aria-hidden="true">
          <div className="deco-die">
            <i className="deco-dot" style={{ top: 16, left: 16 }} />
            <i className="deco-dot" style={{ top: 50, left: 50 }} />
            <i className="deco-dot" style={{ top: 84, left: 84 }} />
          </div>
          <div className="deco-die deco-die--m">
            <i className="deco-dot" style={{ top: 16, left: 16 }} />
            <i className="deco-dot" style={{ top: 16, left: 84 }} />
            <i className="deco-dot" style={{ top: 50, left: 50 }} />
            <i className="deco-dot" style={{ top: 84, left: 16 }} />
            <i className="deco-dot" style={{ top: 84, left: 84 }} />
          </div>
        </div>
      </section>

      {/* HERO: the game is the on-chain table (one ROLL click = full game). */}
      <section className="hero rise rise-2" aria-label="on-chain dice table">
        <OnChainDice />
      </section>

      <section className="dashboard rise rise-3" aria-label="overall dashboard">
        <Dashboard />
      </section>

      <section className="rise rise-4" aria-label="provably fair on-chain verification">
        <ProvablyFair />
      </section>

      <footer className="foot">
        kDice · Concept A “Neon Vegas” · provably fair on Klever (K5 testnet) · 5% house edge
      </footer>
    </div>
  );
}