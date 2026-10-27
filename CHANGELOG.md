# Changelog

All notable changes to kDice are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-10-26

> **Breaking protocol change (contract v3, Phase 7).** Replaces the 2-transaction
> commit-reveal with a **single chain-random commit**: the d100 roll is derived
> **on-chain from the confirming block's consensus random seed** (48 bytes, produced
> by the Klever validator set and unknown to the player at sign-time) mixed with the
> game id. The player commits blind → pre-rolling / cherry-picking is structurally
> impossible. All client-side seeds and the separate `settle` step are retired.

### Added
- **Chain-random roll (contract v3):** `commit(target, over, stake)` reads
  `get_block_random_seed()` (48 B, confirming block), derives
  `d100 = LE_u32(sha256(seed ‖ id_le64)[0..4]) % 100 + 1`, and writes the roll
  record **in the same transaction** — no second `settle` call, no seed reveal.
  The 48-byte seed is stored in the commit record's `hash` field so the dApp and
  anyone can re-derive the roll off-chain from `(seed, game id)` to prove fairness.
  (`contracts/src/commit.rs`, `contracts/src/lib.rs`)
- **v3 parity gate:** `fair.ts` now exposes `blockSeedHash` /
  `deriveRollFromBlockSeed` / `settleFromBlockSeed` / `parseBlockSeedHex` /
  `BLOCK_SEED_LEN`, bit-identical to `dice.rs::derive_roll`. `scripts/fair-parity.ts`
  pins the byte order + formula with 500 random vectors against the Rust reference.
- **v3 upgrade + verify tool:** `contracts/tools/scripts/upgrade-v3-verify.mjs` —
  owner in-place upgrade (2→3), zero-data-loss snapshot check, then real v3 game
  cycles that read back the stored 48-byte seed and assert the on-chain roll ==
  the local re-derivation and the win flag == the bet rule.

### Changed
- **`commit` signature (BREAKING):** `commit(hash, target, over, stake)` (4 args)
  → **`commit(target, over, stake)`** (3 args). The dApp sends one fewer argument
  and no longer generates or reveals any seed. (`OnChainDice.tsx`)
- **ProvablyFair panel:** the dual-seed input is replaced by a single 48-byte
  block-seed input; `recomputeSeed` re-derives from `sha256(seed ‖ id_le64)` and the
  old `hashOk` commitment check is removed. (`ProvablyFair.tsx`)
- **`gameLedger.ts`:** dropped `serverSeedHex` / `playerSeedHex` / `commitmentHex`
  / `settleTx`; status is now `'committing' | 'settled' | 'failed'` (no `committed`
  stage). A game is "settled" the moment the commit confirms (read-back verified).
- **`eventLog.ts`:** `RollEvent` dropped `settleTx` / `playerSeed` / `serverSeed`.
- **`scClient.ts`:** `CommitRecord.hash` documented as the 48-byte block seed (v3).
- **`sc-check.ts`:** now distinguishes v3 records (96-hex seed) from legacy v1/v2
  records (64-hex commitment) and cross-checks each v3 roll against the local
  block-seed derivation.

### Removed
- The `settle` endpoint and the entire commit-reveal flow (2 extension prompts) —
  replaced by one commit transaction. (`OnChainDice.tsx` `runSettle` retired in
  favor of `finalizeGame`, a read-only re-derivation)

### Fixed
- **Live testnet upgraded to v3** (K5, in-place over the existing address):
  `protocolVersion` 2 → 3; all pre-existing commit/roll records preserved
  byte-identical; v3 games verified end-to-end with 48-byte seeds and on-chain roll
  == local derivation.

## [0.3.1] - 2026-10-25

### Fixed
- **Security — cherry-pick exploit on ROLL:** the die displayed the pre-derived result face *while the commit transaction was still awaiting extension confirmation*, so a player could see the outcome, reject the commit on a loss, and re-roll until the die showed a win (effectively only ever committing winning rolls). The face now parks on a neutral value and the real target is revealed **only after the commit confirms** — once bet + hash are irrevocably locked on-chain, the outcome can no longer change. (`OnChainDice.tsx`)
- **Dashboard stat card label:** "KL spent" → "**KLV** spent" (currency typo). (`Dashboard.tsx`)

## [0.3.0] - 2026-10-25

### Added
- **Phase 6 — Themes, polish & security (2026-10-25):**
  - **Light theme + system preference:** full light palette (white-glass panels, deeper cyan/violet accents, `color-scheme`-aware form controls) via `:root[data-theme='light']`; header ☀/☾ toggle persists to localStorage; follows the OS `prefers-color-scheme` live until the user chooses; pre-paint `public/theme-init.js` prevents any dark→light flash.
  - **Responsive path:** layout now degrades cleanly to 360px (topbar compaction, wrapping target readout, scrollable top-players table, tightened controls) — no horizontal overflow at phone widths.
  - **Security hardening:** Content-Security-Policy (`script-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'none'`, `connect-src 'self' https:` — the https allowance exists because the K5 node URL is user-configurable for self-hosted devnets); no `innerHTML`/`eval`/`document.write` anywhere; all `target="_blank"` links carry `rel="noreferrer"`; no secrets in the codebase (config is user-provided, validated on load).
  - **UI wording pass (Phase 4.9 deferred):** bet buttons now state the exact win condition — `UNDER ≤ 47` / `OVER ≥ 48` — with a "wins on ≤/≥" readout, removing the off-by-one ambiguity (OVER 47 does not win on 47); friendlier stage/result/payout copy throughout the table.
- **Phase 5 — Analytics pipeline finalized (2026-10-25):**
  - `RollEvent` carries on-chain traceability: `gameId`, `commitTx`, `settleTx`, `verified` (on-chain = local derivation), `network` (testnet/devnet/mainnet) — every dashboard row can now be re-checked against the contract via the ProvablyFair panel.
  - New `npm test` gate: `scripts/eventlog-tests.ts` asserts the dashboard aggregation (`aggregateRolls`) against exact numbers for all 4 range tabs + top-players rollup (31 checks, deterministic fixed-clock fixtures, no browser needed).
- **Phase 4.11 — “Neon Vegas” theme alignment + motion layer (2026-10-25):** header die-tile logo + gold Connect CTA; hero band (“ROLL ON. / WIN IN KLV.” + tags + decorative dice); “PLAY” panel with 2-column grid on desktop (controls left · die stage right); gold stake box + “🎲 ROLL” + “Potential payout +X KLV”; WIN burst (ring + sparks), die idle float/landing, ROLL halo pulse + shimmer, result pop-in, animated stage dots, stat count-up, chart draw-in, staggered entrances, aurora drift — all pure CSS `@keyframes` + one tiny hook (`useCountUp`), zero new dependencies, `prefers-reduced-motion` collapses the whole layer.

### Changed
- `eventLog.ts` aggregation core extracted into a pure, exported `aggregateRolls(events, range, now)` with an explicit per-view contract (stat cards = range window · chart = capped window · delta-7d = global, identical on every tab); `getDashboardData` loads the full local table and lets the core own ALL range filtering (single source of truth).
- `Dashboard` stat values animate via count-up; top-players W/L shown as pills; staked column in gold (Concept A alignment).

### Fixed
- **Dashboard range filter (caught by the new Phase 5 tests):** stat cards and top players previously counted the FULL event log on every tab (only the chart was range-filtered) — the 7d tab displayed all-time numbers. All views now filter by their documented window.

## [0.2.0] - 2026-10-24

### Added
- **Phase 4.10 — Over/Under 1–99 (contract v2, in-place upgrade, 2026-10-24):**
  - `fair.ts` v2 bet model: `encodeBet(target, over)` = `100 + target·2 + over` (102..299, disjoint from v1 {2,4,10,50}), `betTargetAndSide` / `betWins` / `resolveBet` / `betLabel` / `payoutFor(target, over)` = `floor(9500 / (over ? 100−target : target))` / `payoutForBet` — bit-identical mirrors of `dice.rs::encode_bet` / `bet_wins` / `payout_per_100`. `evaluateOutcome` + `settleFromSeeds` now take a stored **bet value** (v1 or v2), so old records settle with the v1 rule and new records with `over ? roll > t : roll ≤ t`.
  - Hero table: fixed ×2/4/10/50 buttons replaced by an **UNDER/OVER toggle + 1–99 target slider** with live win-% and payout readouts (5% edge across the whole d100 range); ROLL button and result banner show the bet (e.g. "Over 55"); commit now sends 4 args `commit(hash, target, over, stake)` (bool as node-verified `00`/`01`).
  - `scClient.ts` gains `getPayout(target, over)` (v2 view); record types document the dual bet encoding.
  - `eventLog.ts` `RollEvent` carries optional `target`/`over` for v2 games (v1 events unchanged).
  - `fair-parity.ts` extended: encode/payout parity for all 198 (target, side) pairs + 1,200 win/loss decision vectors vs the Rust reference (v1 multipliers still covered).
  - `sc-check.ts` v2-aware: accepts v1/v2 bet values in records and asserts the `getPayout` curve (fails on a v1 contract — doubles as the upgrade gate).
- **One-click auto-flow (Phase 4.9):** a single ROLL now runs the whole game — commit → confirm → settle (automatic, second extension prompt) → on-chain roll verified against the local derivation → result shown → the table auto-returns to ready after a short read-pause, so rolls can be played one after another with zero manual steps.

### Changed
- **On-chain first:** the main dice table (`OnChainDice`) is now the fully on-chain game — ROLL broadcasts the `commit` transaction (die animates to the deterministic local derivation while the commit confirms in the background), SETTLE broadcasts the `settle` reveal transaction and verifies the on-chain roll against the local derivation (✅/❌ badge). Live stage line, KLV result/payout banner, commit/settle explorer links, and roll/win/lose sound.
- Header: removed the mock CREDITS box; KLV balance stays in the wallet chip.

### Removed
- **Mock game (Phase 4.9):** the offline practice table (`PracticeTable`), its roll-history list (`History`), the mock-credits engine (`engine/core.ts`), and their CSS are deleted — the on-chain table is the only game, and no sample credits remain anywhere.

### Fixed
- **Roll derivation byte order (Phase 4.9.1, 2026-10-24):** `fair.ts::deriveRoll` read the first 4 digest bytes as **big-endian** while the contract uses `u32::from_le_bytes` (little-endian) — every on-chain roll "mismatched" the local derivation (~99% of digests). Now byte-identical to the verified `deploy-verify.mjs` reference, locked by a new equivalence gate: `npm run parity` (`scripts/fair-parity.ts`, 500 random vectors + fixed vectors vs. the testnet-verified formula).
- Stale in-flight confirmation/settle chains can no longer overwrite a newer game session (`sessionRef` supersession guard in the hero table).
- **Dashboard bridge (Phase 4.9):** every settled on-chain game appends a `RollEvent` to the local event log (roll, stake, payout, address, ts), feeding the Overall Dashboard with real on-chain results after the mock table removal.

## [0.1.0] - 2026-10-24

### Added
- **Phase 4.7 — Wallet & On-Chain Play** (Klever Extension bridge, 2026-10-24):
  - `src/types/klever.d.ts` — typed `window.kleverWeb` global (extension-injected wallet surface; no `any`).
  - `src/services/wallet.ts` — extension detection (≤3 s poll), connect with provider pinning derived from the SC config (wallet and contract always target the same network), silent session restore that re-verifies the stored address against the extension (never silently adopts a different wallet), event-bus multi-component sync, `getBalanceKLV` (404/new account → 0), React `useWallet` hook.
  - `src/services/txClient.ts` — smart-contract invocation through the extension: `invokeContract` (build → sign → broadcast, typed `TxError` stages), `waitForTx` confirmation polling (5 s cadence, 90 s timeout, transient-error retry), `minimalHex` arg encoding, explorer links. Call-data encoding verified byte-identical to `contracts/tools/lib.js`.
  - `src/services/gameLedger.ts` — bounded (100) local index of the user's on-chain games (seeds, tx hashes, status, verified flag) powering "My games" and later settle/re-verify.
  - `src/components/OnChainDice.tsx` — full on-chain play loop: commit seeds hash → confirm → settle (reveal) → on-chain roll cross-checked against local `fair.ts` derivation with ✅/❌ verification badge; tx hashes linked to the explorer.
  - `src/App.tsx` header — real Klever Extension wallet: install link (extension missing), connect, connected chip with short address + KLV balance, disconnect. Replaces the Phase 3 stub.
  - `src/components/ProvablyFair.tsx` — "My games (this browser)" table: status, result, verified badge, one-click inspect.
- `CHANGELOG.md` — this file, Keep a Changelog format.

### Changed
- `useRollAnimation` now receives a ref-stable `onSettle` wrapper (a changing callback identity previously would restart the die animation mid-roll).
- Roadmap: Phase 4.7 added; the Phase 4.0 assumption "K5 has no EIP-1193-style browser wallet" is superseded (Klever Extension + official 2026 docs confirmed).
