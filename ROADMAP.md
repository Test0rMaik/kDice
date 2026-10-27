# kDice — Build Roadmap

> **Goal:** Ship kDice, a provably-fair dice game on the Klever Blockchain (K5), in the **Concept A "Neon Vegas"** design language.
> **Status:** 🟢 BUILDING — Phase 1 ✅ · Phase 2 ✅ · Phase 3 ✅ · **Phase 4 in progress 🧱** (4.0–4.2 core contract + dice-math tests done, gate green 2026-10-24; 4.3 partial; 4.4–4.6 pending) · (user chose direction **C: Concept A UI first, then on-chain**)
> **Last updated:** 2026-10-24

---

## Decisions & Assumptions (Phase 0)

| Item | Value | Status |
|---|---|---|
| Design concept | **Concept A — Neon Vegas** | ✅ decided |
| Dashboard naming | **"Overall Dashboard"** (project-wide stats, public) | ✅ decided |
| Stack | **Pure web app — Vite + React 18 + TypeScript (strict)**, no Tauri/Rust | ✅ decided |
| State/persistence | IndexedDB (via Dexie) for the local event log | ✅ default (revisit if needed) |
| Network | **K5 testnet first, mainnet toggle later** | ✅ decided |
| Wallet | **External K5 wallet** (browser extension / mobile) — keys never touch the frontend | ✅ decided |
| Provably fair | **We define our own seed-commitment + on-chain settlement flow** | ✅ decided |
| RPC endpoint | **Public K5 node proxies verified working** (see below) | ✅ verified |
| Versioning | SemVer, starting at `0.1.0`, `CHANGELOG.md` (Keep a Changelog), pinned deps | ✅ policy |

### Open questions for the user (all must be answered before Phase 1)
1. **Testnet vs mainnet** for initial build? — ✅ **K5 testnet first, mainnet toggle later**
2. **Wallet integration model:** — ✅ **External K5 wallet (extension / mobile)**
3. **Provably-fair spec:** — ✅ **We define our own seed-commitment + on-chain settlement flow**
4. **K5 RPC endpoint:** — ✅ **Verified public node proxies (see below)**

---

## Verified K5 RPC Foundation (Phase 0 — tested live, 2026-10-23)

### Reachable node proxies
| Network | Base URL | Chain ID | Verified |
|---|---|---|---|
| **Testnet** | `https://node.testnet.klever.org` | `109` | ✅ |
| **Mainnet** | `https://node.mainnet.klever.org` | `108` | ✅ |
| Devnet | `https://node.devnet.klever.org` | `100001` | ✅ |

- Slot duration: **4000 ms** (from `/network/config` → `klv_slot_duration`).
- Base tx size: 250 · slots/epoch: 150.

### Confirmed-good API routes (raw `fetch`/curl, testnet)
| Method | Route | Note |
|---|---|---|
| GET | `/network/status` | slot / epoch / nonce |
| GET | `/network/config` | chain_id, slot_duration, base_tx_size |
| GET | `/block/by-nonce/{n}` | 200 (bare `/block/` → 404, do not use) |
| GET | `/block/by-hash/{h}` | used by provider |
| GET | `/address/{addr}/balance` | new account → `500` + `code:"internal_issue"` ("account was not found") — **must handle** |
| GET | `/address/{addr}/nonce` | 200, `nonce` / `firstPendingNonce` |
| POST | `/transaction/broadcast` | via provider |
| POST | `/sc/query` | via provider |
| POST | `/v1.0/transaction/send-user-funds/{addr}` | **faucet** (testnet/devnet only) |

### Testnet faucet — CONFIRMED WORKING ✅
- Endpoint: `POST https://node.testnet.klever.org/v1.0/transaction/send-user-funds/{address}`
- SDK call: `provider.requestTestKLV(address)` (`@klever/connect-provider`).
- **Tested live: credited 2,000 KLV** to a fresh address within ~30s.
- Quirks:
  - Returns `{ txHash: "", status: "pending" }` — **txHash is empty**; don't rely on it for `waitForTransaction`. Poll `/address/{addr}/balance` instead.
  - Only available on `isTestnet` networks (throws on mainnet).

### Verified SDK surface (installed & smoke-tested)
- `@klever/connect-core` — address/hash utils (`createKleverAddress`, `isValidAddress`, `formatKLV`, `KLV_MULTIPLIER`), asset/amount types.
- `@klever/connect-crypto` — `generateKeyPairSync()`; **address derivation is `publicKey.toAddress()`** (not `createKleverAddress(publicKey)`).
- `@klever/connect-provider` — `new KleverProvider('testnet')`; `getBalance`, `waitForTransaction`, `requestTestKLV`, `getTransactionUrl`, `getNetwork`.
- Note: packages ship ESM + CJS; crypto exports are **named** (no `default`).

> ⚠️ Dev blocker (faucet / test KLV) **RESOLVED.** Ready to scaffold (Phase 1).

---

## Phase 1 — Scaffold & Design Token Layer ✅
- [x] Init **Vite + React 18 + TypeScript (strict)** project in workspace root
- [x] Tooling: ESLint + Prettier, `npm ci`-ready lockfile, `.gitignore`, git init *(lint via `oxlint`, `npm run lint`)*
- [x] Translate Concept A into a **design token layer**: CSS custom properties (`--neon`, `--gold`, `--red`, `--panel`, `--muted`, `--text`, spacing, radii, shadows, glows) — `src/index.css`
- [x] Fonts per approved spec: **Space Grotesk** (UI) + **JetBrains Mono** (numbers/labels) via Google Fonts CDN (`index.html`), with system fallbacks + `font-variant-numeric: tabular-nums`
  - [ ] *(deferred)* Self-host via `@fontsource` for offline support if the app ships air-gapped
- [x] App shell: header (kDice logo ✅, balance ✅, faucet CTA ✅) + side panels *(theme switcher & wallet CTA intentionally deferred to Phases 4/6)*
- [x] **Gate:** `npm run build` + ESLint clean (0 errors); app renders shell with tokens

## Phase 2 — Play View (Concept A multiplier-dice) ✅
- [x] **Game rule (roll-under):** d100 roll; pick multiplier M ∈ {×2,×4,×10,×50}; win if `roll ≤ target`; `target = floor(100 / (M · (1 + houseEdge)))`; payout = `stake · M` (net `+stake·(M−1)`)
- [x] Rewrite `src/engine/core.ts`: `GameState`, `GameAction` (`roll`/`settle`/`reset`/`seed`), pure `evaluate(face, M, bet)` + `targetFor(M)` (5% house edge); poker-hand `payouts.ts` dropped
- [x] Rewrite `src/engine/rng.ts`: `rollD100(seed)` (mulberry32, crypto-seeded) → 1–100
- [x] Rewrite `src/App.tsx`: topbar (brand + balance), multiplier selector (×2/×4/×10/×50 with targets), chip stake row + MAX + numeric input with validation, ROLL button with stake·×M, win-rate/payout/expected-loss line, single d100 stage, WIN/LOSE banner, broke → re-buy, payout table, history, reset
- [x] Reuse `useSound` (roll rattle / win fanfare / lose dip) + `useRollAnimation` (retargeted to single d100); `Dice` component renders 1 die
- [x] **Gate:** build + oxlint clean; full loop demoable in UI (`npm run dev`) — ✅ verified 2026-10-23

## Phase 3 — Stats & Overall Dashboard (UI-first) ✅
- [x] Stat cards: KLV Spent (sparkline), Games (+weekly delta), Wins/Losses (win rate), Best Roll
- [x] **Overall Dashboard** section: range tabs (7d / 30d / 12m / All time), activity area-chart, top-players table (Player · Games · W/L % · Staked)
- [x] Local **event log** (typed events persisted in IndexedDB via Dexie) feeding the dashboard queries — `src/services/eventLog.ts`
- [x] **Live cross-tab sync:** Dexie 4.4.7 `Dexie.on('storagemutated')` (internal BroadcastChannel) feeds `onRollsChanged`, so every open tab's dashboard updates in real time on a roll from any tab — ✅ manually verified 2026-10-23
- [x] **Gate:** dashboard renders from real (local) event data; build + lint green — ✅ verified 2026-10-23 (vite build + oxlint clean)

## Phase 4 — K5 Smart Contract + On-Chain Provably Fair (Rust `klever-sc`) 🧱

### 4.0 — Decisions (2026-10-23)
| Item | Decision | Rationale |
|---|---|---|
| Contract language | **Rust → WASM via `klever-sc` 0.45.0** (same stack as Ogmara) | Ogmara + appscan prove the stack works; no KAS learning curve |
| Custody model | **Settlement-record only — contract NEVER holds KLV** | No solvency/withdrawal surface = smallest attack surface for testnet (Ogmara's `send_klv_or_revert` pattern not needed) |
| Tooling | **Adapt `Ogmara/smart-contract/tools/`** (zero-build vanilla-JS console; local **Ed25519 signing via `vendor/noble-ed25519.js`** — no koperator CLI, no JS SDK) into `contracts/tools/` | Deploy + upgrade + full endpoint console from one place; key stays in the local console, never in the web frontend |
| **No Klevr JS SDK (project principle)** | Entire project is SDK-free: frontend uses **plain JSON-RPC over HTTP** (`POST {node}/vm/query`, `GET {api}/v1.0/address/{addr}`, `POST {node}/transaction/{send,decode,broadcast}`) — exact pattern proven by Ogmara tools. `@klevr/connect-provider` already absent from `package.json` | Learned from appscan/Ogmara: SDK adds surface area, bloat, and key-in-browser risk; K5 HTTP API is stable JSON |
| Provably-fair derivation (single source of truth) | `h = SHA256(server_seed ‖ player_seed)` (both exactly 32 bytes); `roll = le_u32(h[0..4]) % 100 + 1` (1–100); `target = floor(10000 / (105·m))` (pure integer — **no floats in contract**; `floor(10000/105m)` ≡ `floor(100/(m·1.05))` for m=2/4/10/50); **win iff `roll ≤ target`**; payout = `stake·m` on win | Replaces mock `mulberry32` RNG; identical formula to `engine/core.ts` `targetFor` (switch TS to the integer form too) |
| Anti-spam | `MAX_ACTIVE_COMMITS = 100` per address (Ogmara pattern), owner-tunable | Prevents unbounded commit flooding |
| SHA-256 in contract | `sha2` crate (`default-features = false` for no_std) on `wasm32v1-none` | Ogmara's README claims sha2 usage but no dep in tree — add explicitly |
| Signing for endpoints | Operator PEM in **local** console (koperator `sign-tx` + broadcast) | K5 has no EIP-1193-style browser wallet; `connect-provider` needs keys in JS, which we refuse to do for signing |
| Wallet note | Old "external K5 wallet" decision **superseded** for Phase 4: operator console signs; UI stays read-only vs chain until a wallet model is chosen in Phase 5 | Honest constraint, avoids fake wallet integration |

### 4.1 — Scaffold (`contracts/` dir, mirroring Ogmara layout) ✅
- [x] `contracts/Cargo.toml` — workspace `[".", "meta"]`, `klever-sc =0.45.0`, `sha2 = { version = "0.10", default-features = false }` ✅
- [x] `contracts/meta/Cargo.toml` — `kdice-contract-meta` + `klever-sc-meta 0.45.0` (bin at `src/main.rs`) ✅
- [ ] `contracts/sc-config.json` + `contracts/alloc-leak.json` — **skipped on purpose** (Ogmara artifacts from an older SDK; `sc-meta` 0.45.0 drives the build) — re-verify only if `kdice-contract-meta build` fails
- [x] `contracts/src/{lib.rs,storage.rs,commit.rs,settle.rs,query.rs,events.rs,upgrade.rs,dice.rs}` — module split per Ogmara convention (names drifted: `settle.rs` not `settlement.rs`; **+`dice.rs`** pure-math module, **+`upgrade.rs`** owner admin) — `#[klever_sc::contract]` root trait in `lib.rs` with `#[init]`/`#[upgrade]` in the trait body ✅
- [ ] `.gitignore` addition for `contracts/output|wasm` — **deferred** (current workspace is not a git repo)

### 4.2 — Contract implementation ✅ (unit + 15 scenario tests, all green 2026-10-24)
- [x] `init` / `#[upgrade]` in the `KDiceContract` trait body (`lib.rs`); `#[init]` sets defaults + grants `owner` to the deployer ✅
- [x] `commit(hash: ManagedBuffer /*32B*/, multiplier: u32, stake: BigUint) -> u64` — **drift:** contract assigns `gameId` and returns it (not caller-supplied); validates multiplier + stake>0 + 32-byte hash; enforces per-player active-commit cap ✅
- [x] `settle(gameId: u64, serverSeed: ManagedBuffer /*32B*/, playerSeed: ManagedBuffer /*32B*/)` — **drift:** `multiplier`/`stake` come from the stored commit record (not re-sent, so they can't be gamed); verifies `SHA256(server_seed) == committed`, re-derives roll+target **on-chain**, caller must be the committing player, records `{roll, win, m, stake, payout}`, marks commit consumed ✅
- [x] Views: `getCommit(gameId)`, `getRoll(gameId)`, `getCommitsCount`, `getRollsCount`, `getTarget(m)`, `getMaxActiveCommits`, `getActiveCommits(player)` ✅
- [x] Owner (all `require_owner`-gated): `setName`, `setMaxActiveCommits`, `transferOwner` ✅
- [x] Events: `commit(gameId, player, multiplier, stake)` / `settle(gameId, player, roll, win)` — **drift:** 0.45.0 event ABI allows ≤1 data arg, so extra fields are indexed (see `events.rs`) ✅
- [x] **Unit tests:** dice-math suite ✅ (threshold table 47/23/9/1 = canonical `core.ts` `targetFor` 5% edge, deterministic roll, multiplier validation — 4/4 pass); **`klever-sc-scenario` tests ✅ (15/15 pass, 2026-10-24)** — double-settle revert, wrong-hash revert, oversize-seed revert, max-commits cap, wrong-player revert, unknown-commit revert

### 4.3 — Build & audit 🧱
- [x] `cargo check` ✅ · `cargo clippy --all-targets -- -D warnings` ✅ (clean) · `cargo fmt --check` ✅ — 2026-10-24
- [x] Dependency audit (`cargo audit`, 2026-10-24): 3 advisories, all in `zip 4.6.1` — **dev-only** chain (`klever-sc-scenario → klever-sc-meta → zip`, not compiled into the on-chain wasm); runtime deps are only `klever-sc =0.45.0` + `sha2 0.10.9`. Accepted; re-check on SDK 0.46+
- [x] `kdice-contract-meta build` ✅ → `contracts/output/`: `kdice-contract.{abi.json,wasm,kleversc.json,imports.json}` — **contract size 15,419 bytes**, EI 1.3 OK, **MUST run from `contracts/meta/`** (meta config loads `../Cargo.toml` CWD-relative); ABI exposes all 14 endpoints (2026-10-24)
- [x] Build artifacts clean (`wasm/` crate auto-generated by meta build; `output/` is the deployable bundle) — 0.45.0 no longer runs the older alloc-leak tooling step

### 4.4 — Tooling + deploy (testnet) ✅ 2026-10-24
- [x] Port `Ogmara/smart-contract/tools/` → `contracts/tools/` (vanilla JS + `noble-ed25519.js`; rebranded console; ABI auto-load → `../output/kdice-contract.abi.json`) — kDice-specific deltas: `bytes` args accept 64-char hex (raw 32 bytes) or UTF-8 ≤32 (seeds/hashes are raw, not ASCII-hex-text like Ogmara); **`u16` encode/decode added** (kDice has `u16` endpoints — Ogmara never did); `vmQuery` auto-converts pasted `klv1…` bech32 args to hex (node hex-decodes every arg); faucet fixed to `api.testnet.klever.org` (node host 404s it)
- [x] Fund testnet operator via faucet (2,000 KLV); **deploy** `kdice-contract` → `klv1qqqqqqqqqqqqqpgqxwtjrzvrd62e8l7fksrrzkqqa5xyufm0mvgqndrl9s` (tx `65987c6c…c06b`, upgradeable+readable) — recorded in `contracts/DEPLOYMENTS.md`
- [x] **Verify:** headless `tools/scripts/deploy-verify.mjs` (same lib.js path as the console): sanity views (name/version/max-commits/targets 47/23/9/1) → commit→settle **WIN** (roll **2** ≤ 47, win=true) + **LOSE** (roll **83** > 47, win=false) → `getRoll` on-chain == local SHA-256 re-derivation both games; commit records flip to consumed; `getActiveCommits` net-zero — **all ✅**
- [x] **Gate:** full commit→settle→query cycle green on testnet ✅; all unit tests pass (19/19) ✅; clippy clean ✅ — 2026-10-24

### 4.5 — Frontend integration (read-only chain view first)
- [x] `src/services/scClient.ts` — typed SC query client over **plain JSON-RPC** (`POST {node}/vm/query`; no Klevr SDK): `getCommit`, `getRoll`; strict types (no `any`), timeouts, payload bounds, client-side throttling (AGENTS §5C); node URL configurable (testnet/local), default `https://node.testnet.klever.org`
- [x] `src/engine/fair.ts` — new provably-fair core: `commitHash = SHA256(serverSeed)` (Web Crypto), `deriveRoll`, `targetFor` (integer form) — **single formula, mirrored 1:1 in the contract**
- [x] UI: "Provably Fair" panel (`src/components/ProvablyFair.tsx`) — shows on-chain commit/roll records for a gameId + local recomputation + ✅ match indicator; local mock engine remains for offline play
- [x] **Gate:** panel shows a real testnet record and local derivation matches (`scripts/sc-check.ts` — ALL GATE CHECKS PASSED vs `klv1…rl9s`: 3 commits, 2 rolls, win-flag cross-check ✅ on both settled games); `npm audit --audit-level=high` clean; build + lint green — 2026-10-24

### 4.6 — Versioning & docs
- [ ] Bump `package.json` `0.0.0 → 0.1.0`; `CHANGELOG.md` [Unreleased] → v0.1.0 (2026-10-23) with Added/Changed
- [ ] `contracts/README.md` — build, test, deploy, upgrade (via adapted tools), key custody (testnet)
- [ ] **Phase 4 Gate:** checklist above complete; DEPLOYMENTS.md has testnet address + tx hashes

### 4.7 — Wallet & On-Chain Play (Klever Extension bridge) 🎮 (2026-10-24)
- **Decision:** hand-rolled `window.kleverWeb` bridge (user-approved 2026-10-24) — the same proven pattern as `dexscan/dexscan-api-portal/src/hooks/useKleverWallet.ts` + `Ogmara/web/src/lib/klever.ts`. Zero new deps, keys never leave the extension, consistent with the no-SDK principle. (Supersedes the 4.0 line-110 assumption "K5 has no EIP-1193-style browser wallet" — the official 2026 docs + local dexscan/Ogmara integrations both confirm the extension exists.)
- **Wire facts (verified in local projects + `contracts/tools/lib.js`):** extension injects `window.kleverWeb` — `provider={api,node}` → `initialize()` → `getWalletAddress()`; SC call = `buildTransaction([{type:63,payload:{scType:0,address,callValue:{}}}], [b64("fn@hex@…")])` → `signTransaction` → `broadcastTransactions([tx])` → `data.txsHashes[0]`; tx status = `GET {api}/v1.0/transaction/{hash}` (`status` confirmed/success vs fail/reject); balance = `GET {api}/v1.0/address/{addr}` → `data.account.balance`; explorer `https://testnet.kleverscan.org/transaction/{hash}`
- [x] `src/types/klever.d.ts` — typed `window.kleverWeb` global (no `any`)
- [x] `src/services/wallet.ts` — extension detection (poll ≤3 s), connect (testnet provider pin), silent restore (persist **address**, verify match per dexscan PT-P2-8 lesson), disconnect, event-bus multi-instance sync, `getBalanceKLV(addr)` (404/new-account → 0)
- [x] `src/services/txClient.ts` — `invokeContract(fn, hexArgs)` build→sign→broadcast, `waitForTx(hash, timeout)`, typed `TxError` (stage-tagged), 30 s timeout, size caps (mirror `scClient.ts` hardening, AGENTS §5C); **encoding parity vs `contracts/tools/lib.js` verified** (minimalHex + buildCallData byte-identical for commit/settle args)
- [x] `src/components/OnChainDice.tsx` — on-chain play: stake (KLV) + multiplier → `commit(hash,m,stake)` → confirm → `settle(id,serverSeed,playerSeed)` → confirm → on-chain roll vs local `fair.ts` derivation (✅ verified badge); tx hashes linked to explorer; seeds persisted in `src/services/gameLedger.ts`
- [x] `src/App.tsx` — real wallet header (replaced stub): install-extension link / connect / connected chip + KLV balance; `useRollAnimation` onSettle stabilized via ref wrapper (identity change would restart the animation)
- [x] `src/components/ProvablyFair.tsx` — "My games": connected user's on-chain game list (local ledger + status/result + verified badges + one-click inspect)
- [x] Gates (code): `npm run build` green · `npm run lint` 0 errors (3 pre-existing vendor warnings in `contracts/tools/vendor/`) · `npm audit --audit-level=high` 0 vulnerabilities · encoding parity vs operator tooling ALL OK · preview serves HTTP 200 — 2026-10-24
- [ ] **Gate (manual, needs the user's browser):** extension present → fund via faucet → COMMIT → confirm → SETTLE → confirm → on-chain roll matches local derivation ✅ → record visible in "My games" → deep-verify via ProvablyFair

### 4.8 — On-Chain First: the dice table IS the on-chain game 🎲 (2026-10-24)
- **Context (user report 2026-10-24):** wallet connected + KLV balance correct, but "no transactions to actually roll the dice" — the on-chain flow existed only as a secondary bottom panel while the hero table was still the local mock. **The game itself must be fully on-chain.**
- [x] Version base tagged: `package.json` 0.0.0 → **0.1.0**; `CHANGELOG.md` `[Unreleased]` promoted to `[0.1.0] - 2026-10-24` (base application)
- [x] `src/components/OnChainDice.tsx` — rewritten as the **hero table**: ROLL (commit tx) → die animates to the deterministic local derivation (starts at broadcast, confirmation in background) → SETTLE (settle tx) → on-chain roll read-back + ✅/❌ verified badge → ROLL AGAIN; live stage line (committing/rolling/committed/settling/settled), KLV stake + multiplier chips, win/lose result banner with KLV payout, commit/settle explorer links, sound (roll/win/lose), `sessionRef` guard so stale background confirm/settle chains can never clobber a newer game
- [x] `src/components/PracticeTable.tsx` — the old local-mock table extracted **verbatim** from `App.tsx` (same engine/UX), clearly labeled "OFFLINE PRACTICE — local RNG, mock credits, no transactions"; CREDITS chip moved into its history panel
- [x] `src/App.tsx` — slimmed: hero = `OnChainDice`, then labeled `PracticeTable` section, then Dashboard + ProvablyFair; wallet header keeps KLV balance (mock CREDITS box removed from header)
- [x] `src/index.css` — `.hero`, `.practice__head`, `.onchain__stage`, `.onchain__actions`, `.panel__title--row`, `.balance__value--sm`
- [x] Gates: `npm run build` green (tsc strict + vite, 36 modules) · `npm run lint` 0 errors (3 pre-existing vendor warnings) · `npm audit --audit-level=high` 0 vulnerabilities · `vite preview` HTTP 200 — 2026-10-24
- [ ] **Gate (manual, needs the user's browser):** connect → ROLL (commit tx appears, die animates, game # confirmed) → SETTLE (settle tx) → ✅ verified badge → txs visible on `testnet.kleverscan.org` → game in "My games"

### 4.9 — One-Click Auto-Settle + On-Chain-Only Table 🎲 (2026-10-24)
- **Context (user directive 2026-10-24):** (1) "we do not need the mock game part, therefore remove it and only keep the on-chain game"; (2) "results should automatically be shown, without the user manual action and move directly to a new game — the player wants to play one after another without manually loading his results of the last roll"
- [x] **Mock game removed:** `src/components/PracticeTable.tsx`, `src/components/History.tsx` (its only consumer), `src/engine/core.ts` (mock-credits engine) deleted; their CSS (`.practice*`, `.history*`) removed from `src/index.css`; `src/App.tsx` now renders hero + Dashboard + ProvablyFair only — no sample credits anywhere
- [x] **Auto-flow in `OnChainDice.tsx`:** one ROLL click runs the entire game — commit tx (extension prompt #1) → confirm → game id → **animation gate** (settle never fires while the die tumbles; 1.5 s cap) → settle tx (prompt #2, automatic) → confirm → on-chain roll read-back + local-derivation verification → result banner + ✅ badge + sound → **table auto-returns to ready after ~4 s** (result stays visible until the next ROLL). Manual SETTLE survives only in the error path (reveal failed → `RETRY SETTLE` / `Abandon game`)
- [x] **Dashboard bridge:** every settled on-chain game appends a `RollEvent` to the local event log (`recordRoll`: roll, multiplier, stake, outcome, gross/net payout, address, ts, balanceAfter) — the Overall Dashboard (and the Phase 5 analytics schema) is now fed by real on-chain games instead of the deleted mock table
- [x] Gates: `tsc --noEmit` clean · `npm run build` green · `npm run lint` 0 errors · `npm audit --audit-level=high` 0 vulnerabilities · `vite preview` HTTP 200 — 2026-10-24
- [ ] **Gate (manual, needs the user's browser):** connect → ROLL → (prompt #1) → die rolls → (prompt #2 auto) → ✅ result shown with NO further clicks → ROLL again immediately → dashboard numbers move

### 4.10 — Over/Under Slider + Target 1–99 (contract v2, in-place upgrade) 🎚️ (2026-10-24)
- **Context:** user: "isn't dice normally 'over' and 'under' the rolled number? there is nothing where the player can select this with maybe a slidebar from 1 to 99". v1 only expresses "under" at 4 fixed lines (×2/4/10/50 → 47/23/9/1); a continuous target + side must be committed on-chain for provable fairness.
- **Decision (user-approved 2026-10-24):** upgrade **in place** over `klv1…rl9s` (preserve commit ids + "My games"); zero storage-schema change.
- [x] **Hotfix 4.9.1:** `fair.ts::deriveRoll` BE→LE byte order (was the cause of every "MISMATCHES the local derivation"); new `npm run parity` gate (500 vectors vs testnet-verified reference)
- [x] **Contract v2 (Rust):** `commit(hash, target: u16, over: bool, stake)`; `1 ≤ target ≤ 99`; bet encoding in the existing `multiplier: u32` field — v1: {2,4,10,50} unchanged, v2: `100 + target·2 + over` (disjoint ranges → old records decode exactly, struct layout untouched); `settle` win = `over ? roll > target : roll ≤ target` (v1 values → old `roll ≤ target_for(mult)`); `getPayout(target, over)` view = `floor(9500/denom)` (×100, 5% edge); unit tests (boundaries, encode/decode round-trip, v1 compat); build + clippy + tests
- [x] **Deploy v2 in place** via operator tools (upgrade over same address); live verification: old records still readable + v1-formula settle intact, v2 under-WIN + over-WIN + over-LOSE vs local derivation, parity green
- [x] **Frontend v2:** `fair.ts` bet encode/decode + payout formula; hero: UNDER/OVER toggle + 1–99 slider + live win-%/payout readouts (replaces multiplier chips); commit args (target, over); verification vs decoded bet; `scClient` types + `getPayout`; ProvablyFair shows target/side (v1 games show ×mult); event log gains target/side
- [x] **Gates:** parity (extended) · build · lint · audit · sc-check (v2, live testnet) · preview — all green
- [ ] Manual E2E in browser (slider → ROLL → commit/settle prompts → ✅ verified) — needs the Klever extension; sc-check + `upgrade-v2-verify.mjs` already proved the same on-chain path
- [x] Docs: DEPLOYMENTS.md v2 entry, ROADMAP/CHANGELOG (frontend 0.2.0)

### 4.11 — “Neon Vegas” theme alignment + motion layer ✨ (concept A → app, 2026-10-25)

**Goal:** close the visual gap between the running app and `planning/design-a-neon-vegas.html` (the concept is the design source of truth), then add a motion layer the static concept page lacks. Pure CSS keyframes + tiny hooks — **no new dependencies**.

**Diff found (concept vs. current app):**
| Area | Concept A | Current app |
|---|---|---|
| Header logo | 🎲 gradient die tile (`.logo-die`) + gradient “D” | text only, no die tile |
| Connect button | gold gradient CTA, dark text, gold glow (`.connect`) | quiet outline pill |
| Hero | “ROLL ON. / WIN IN KLV.” 56px headline + subtitle + 3 tag pills + decorative cyan/magenta dice stage | none — straight to the table |
| Play panel | section title “PLAY” + small note (tx fee ≈ 0.001 KLV · resolved on-chain); 2-col grid (controls 380px · result right) | no section title; single centered column (intentional 4.8/4.9 flow) |
| Stake | gold-bordered box, uppercase label, gold mono value (`.stake`) | small neutral input |
| ROLL | “🎲 ROLL THE DICE” + “Potential payout +X KLV” line | “ROLL” + bet sub-line + expectancy line |
| Result | result chip + “on-chain ✓ tx 0x… · target…” prov line | banner + separate tx row (close, restyle) |
| Players table | W/L as green/red **pills** (`.pill`), gold staked column | plain numbers |
| Charts | sparkline/area with neon `drop-shadow` glow | plain stroke (slight glow) |
| Footer | centered concept line | none |
| Motion | static page | only die-shake while rolling + hovers |

- [x] **Header:** `.logo-die` gradient tile next to the kDice brand; Connect K5 button in gold CTA style (keep connect/chip/install logic untouched)
- [x] **Hero band:** “ROLL ON. / WIN IN KLV.” headline (gradient span) + subtitle + tag pills (⛓ On-chain fairness · 📊 Live stats · KLV payouts gold) + decorative two-die stage (ornamental only, no game logic)
- [x] **Table alignment:** “PLAY” section title + small note; **2-column grid on ≥1000px** (controls left 380px · die + result right), vertical on mobile (stage first); gold stake box (`.stake`); “🎲” on ROLL; “Potential payout +X KLV” line under ROLL; result chip + prov line restyle
- [x] **Dashboard/ProvablyFair:** W/L pills (green ≥50% / red <50%, `.pill`), gold staked column, sparkline/area neon glow, footer line
- [x] **Motion layer (CSS `@keyframes` + tiny hooks):**
  - ambient background: slow aurora drift (animated pseudo-layer, GPU-friendly `transform`/`opacity` only)
  - die: idle float + breathing glow; settle landing bounce + glow flash; WIN burst (expanding ring + spark particles, DOM spans)
  - ROLL: halo pulse when ready, shimmer sweep on hover
  - result banner pop-in; stage line (commit/confirm/settle) animated dots
  - stat values count-up on change (`useCountUp` hook); sparkline/area draw-in (`stroke-dashoffset`); staggered panel entrance on first load
  - `@media (prefers-reduced-motion: reduce)` disables the whole layer
- [x] **Gates:** build + lint + parity + audit + preview (2026-10-25 — all green; 3 pre-existing lint warnings live only in the vendored `noble-ed25519.js`)
- [x] **Visual sign-off:** side-by-side checklist vs. the concept file — ✅ user-approved 2026-10-25 ("its working and looks way better than before")
- [ ] **Deferred to end (user):** remaining UI wording mismatch pass (UNDER/OVER labels etc.)

## Phase 5 — Analytics Pipeline (project-wide) ✅
- [x] Event schema finalized — one `RollEvent` per settled roll (user decision: no separate commit/abandoned events) + on-chain traceability (`gameId`, `commitTx`, `settleTx`, `verified`, `network`) so every dashboard row can be re-verified against the contract
- [x] Aggregation queries for all 4 range tabs + top-players rollup (`k5…xxxx` short form) — extracted into pure `aggregateRolls`/`rollupPlayers` with an explicit per-view contract; **bug fixed: cards/players ignored the range tab entirely**
- [x] **Gate:** dashboard numbers reconcile with event log — `npm test` (31 exact-number checks, all 4 tabs, deterministic fixtures) + lint/parity/audit/build all green (2026-10-25)

## Phase 6 — Themes, Polish & Release ✅ (2026-10-25, v0.3.0)
- [x] Light theme + System preference (persisted), verified against tokens — `src/services/theme.ts` + pre-paint `public/theme-init.js` (no flash); `:root[data-theme='light']` palette overrides every token incl. new `--die-*`/`--table-wash` surface variables; header ☀/☾ toggle persists to localStorage and follows the OS `prefers-color-scheme` live until the user chooses
- [x] Responsive layout pass (1280px design → smaller widths) — 640px + 400px breakpoints: topbar compaction (tag drops, tighter wallet chip), wrapping target readout, scrollable top-players table (min-width 440px), tightened controls; no horizontal overflow at 360px
- [x] Security pass: input validation on stake (integer micro-units, bounded), RPC payload bounds (256 KB response cap, 10 s timeout — 4.5), dependency audit `npm audit --audit-level=high` (0 vulns), strict pinning / no typosquatted packages (0 app deps, all `^`-pinned majors from the 0.1.0 audit); **CSP added** (`script-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'none'`; `connect-src 'self' https:` justified by user-configurable self-hosted K5 nodes); no `innerHTML`/`eval`/`document.write`; all `_blank` links `rel="noreferrer"`; no secrets in code
- [x] Bump to `v0.3.0` in `package.json`; `CHANGELOG.md` entry with release date — 2026-10-25 (0.1.0 base → 0.2.0 on-chain rework → 0.3.0 = Phase 5 + Phase 6)
- [x] **Gate:** build ✅ · lint ✅ (0 errors, 3 pre-existing vendor warnings) · parity ✅ · test ✅ (31/31) · audit ✅ 0 vulns (2026-10-25); manual end-to-end test on testnet = user sign-off (dashboard + light theme + 360px spot-check)

---

## Phase 7 (SHIPPED) — Protocol v3: chain-random commit — ✅ v0.4.0 / contract v3 (2026-10-26)
> **Direction (user-chosen, validated):** derive the roll from the **confirming block's
> consensus random seed** — not a player-generated hash/seed. The player commits blind
> (the block doesn't exist yet at commit time) → **cherry-picking is structurally
> impossible.** This replaces the 2-tx commit-reveal with a **1-tx** game and removes
> all secrets.
- **Primitive (verified in klever-sc 0.45.0):** `self.blockchain().get_block_random_seed() -> 48 bytes` (confirming block). ⚠️ Must NOT use `get_prev_block_random_seed` (public before commit → timing cherry-pick survives).
- **Roll formula (parity-friendly, same shape as today):** `roll = LE_u32(SHA256(seed48 ‖ gameId_le64))[0..4] % 100 + 1` → `[1,100]`. `gameId` (sequential commit id) gives per-game independence even within one block.
- **Contract v3:** `commit(target, over, stake)` reads the block seed, derives roll + win, stores record (bet, stake, player, roll, win, seed, block round). `settle` retired. Queries expose roll/win/seed for public re-verification.
- **Frontend v0.4.0:** single-tx flow (one extension prompt, no settle/auto-chain/retry-settle), die animates to the **on-chain** roll read back after commit, ProvablyFair panel verifies from public block seed + gameId + bet (no seed reveal).
- **Honest residual:** validator influence over the block seed (standard block-randomness model; negligible at testnet scale). Upgrade path if needed later: VRF / two-party.
- **Breaking change → v0.4.0** (contract + frontend + `fair.ts`/`scClient.ts` + parity vectors + testnet redeploy).
- **[x] Design sign-off → contract v3 + scenario tests → frontend 1-tx flow → parity gate → redeploy testnet → E2E** — ✅ all done 2026-10-26 (see Session Log).

## Session Log
### 2026-10-26 — Phase 7 shipped: contract v3 live on K5 testnet → **v0.4.0** ✅
- **Build approved by user** → built v3 WASM (`kdice-contract-meta build`, 13,439 B, EI 1.3, `commit` = 3-arg `(target, over, stake)`, `settle` gone).
- **Upgraded live testnet in place** (owner PEM, same address) via new `contracts/tools/scripts/upgrade-v3-verify.mjs`: pre-upgrade snapshot of all 30 records → `upgradeContract` (protocolVersion 2→3) → **zero data loss** (every old commit/roll byte-identical) → 2 real v3 games.
- **E2E parity proven live:** v3 records carry **48-byte block seeds (96 hex)**; on-chain roll == local `sha256(seed‖id)` re-derivation on every game (43=43, 41=41, 32=32, 78=78); win flag == bet rule; `getPayout`/`getTarget` views survive.
- **`sc-check.ts` fixed** to distinguish v3 (96-hex seed) from legacy v1/v2 (64-hex commitment) records and to cross-check each v3 roll against the local derivation → **ALL GATE CHECKS PASSED** against the live v3 chain.
- **Gates:** tsc -b ✅ · parity ✅ (500/500 + 198/198) · npm test ✅ (31/31) · lint ✅ (0 errors) · contract `cargo test` ✅ (18/18) · `clippy -D warnings` ✅.
- **Release:** `package.json`/`package-lock.json` → **0.4.0**, `contracts/Cargo.toml` → **3.0.0**, CHANGELOG `[0.4.0] - 2026-10-26`.
- **Verified non-blocking:** v2 `gameLedger` localStorage entries still load (defensive filter only checks `ts`/`multiplier`/`stakeMicro`); no vestigial `getActiveCommits` UI callers (client method + contract getter remain for backward compat).

### 2026-10-25 — Post-release bug fixes from user E2E → **v0.3.1 shipped** ✅
- **🐛 SECURITY — cherry-pick exploit (user-reported, "massive bug"):** pressing ROLL derived `local.roll` and set it as the die face *before* the commit extension prompt was approved — and `useRollAnimation` renders `finalFace` directly whenever idle, so during stage `'committing'` the **actual result was visible while prompt #1 was pending**. Player sees the outcome → rejects on a loss → re-rolls (new seeds) → approves only winning rolls = "always wins". **Fix:** `setFinalFace(1 + random*100)` (neutral, cosmetic-only) at roll start; the real target `setFinalFace(local.roll)` moved to **after** `invokeContract('commit')` resolves (REVEAL GATE) — bet + hash are then locked on-chain and the outcome is irrevocably fixed. Result banner/✅ badge already came from the on-chain read-back (unchanged).
- **🐛 Dashboard typo (user-reported):** "KL spent" → "KLV spent" (card label + comment).
- **Gates:** build ✅ · lint ✅ (0 errors) · parity ✅ · test ✅ (31/31) · bundle contains "KLV spent" ✅.
- **CHANGELOG:** both fixes under `[0.3.1] - 2026-10-25` (patch: security + typo, backward-compatible); `package.json` → **0.3.1**.
- **Open (user decision):** protocol v3 direction — hash-derivation vs two-party entropy vs block-lottery (see "Structural fairness" note below).
- **Honesty note (structural, flagged not fixed):** both seeds are generated client-side, so a DevTools-savvy player can still compute the roll from in-memory seeds *before* approving the commit prompt (the UI flash — the reported exploit — is gone, but the architectural "secret" is the player's own). True commit-reveal would need one secret generated by the counterparty (server/contract). Decision for a future phase if the threat model requires it.

### 2026-10-25 — Deferred UI wording pass + Phase 6: themes, polish & security (v0.3.0) ✅ — ROADMAP COMPLETE
- **Wording pass (Phase 4.9 deferred item, user picked Option A):** bet buttons now state the exact win condition — `UNDER ≤ 47` / `OVER ≥ 48` — with a "wins on ≤/≥ · % · +KLV" readout; removes the off-by-one ambiguity (OVER 47 does not win on 47). Copy refresh: hint strip, stage lines ("Locking your seeds on-chain…", "Settle didn't land — …Hit RETRY SETTLE", "Roll again?"), result banner ("d100 N" → "rolled N"), payout line ("If you win: +X KLV"), mismatch badge. `OnChainDice.tsx` only — logic untouched.
- **Light theme:** `src/services/theme.ts` (stored choice → OS preference, live follow until explicit choice) + `public/theme-init.js` (pre-paint, no flash, CSP 'self'-safe) + `:root[data-theme='light']` palette (white-glass panels, deeper cyan `#0891B2`/violet `#7C3AED` accents for contrast, `color-scheme` aware). Hardcoded die/table glows extracted into `--die-*`/`--table-wash`/`--bg-deep` surface variables (dark defaults unchanged) so both themes share one set of component rules. Accent-on-accent text inverted to white in light. Zero new dependencies.
- **Responsive pass:** 640px (topbar compaction, brand tag hidden, target readout wraps full-width, result banner wraps, top-players table scrolls at min-width 440px, tightened controls) + 400px (h1 tracking, side gap, stat values).
- **Security pass:** CSP meta in `index.html` (`script-src 'self'` — theme-init is a static file; `style-src 'unsafe-inline'` for React `style=""` attrs only; `connect-src 'self' https:` documented as user-configurable-node allowance; `object-src 'none'`/`base-uri 'self'`/`form-action 'none'`). Audits: no `innerHTML`/`eval`/`document.write`; all `target="_blank"` links carry `rel="noreferrer"`; stake/gameId/config inputs all bounded + validated (existing); no secrets in code (config user-provided, bech32+https validated on load); `npm audit --audit-level=high` = 0 vulnerabilities.
- **Release:** `package.json` → **0.3.0**; CHANGELOG `[0.3.0] - 2026-10-25` (ships Phase 5 + Phase 6); ROADMAP Phase 6 checked off.
- **Gates:** build ✅ · lint ✅ (0 errors; 3 pre-existing vendor warnings) · test ✅ (31/31) · audit ✅ 0 vulns.
- **Open (user):** manual E2E — one testnet game (dashboard + traceability fields) + spot-check light theme toggle and 360px layout.

### 2026-10-25 — Phase 5: Analytics pipeline finalized (schema + reconciliation gate) ✅
- **Scope decision (user-approved, Option A):** one event per SETTLED roll — no separate commit/abandoned events; finalize the schema with on-chain traceability + prove the dashboard reconciles with the log.
- **Schema (`eventLog.ts`):** `RollEvent` gains `gameId`, `commitTx`, `settleTx`, `verified`, `network` (non-indexed optional fields — no Dexie schema/index change). Stale Phase-3/4 "stub" comments rewritten. `OnChainDice.runSettle` now records all five (data was already in scope: game id, both tx hashes, ✅ flag, `networkTag(config.nodeUrl)` — new helper in `scClient.ts`: devnet/testnet/mainnet).
- **Pure core (`eventLog.ts`):** aggregation extracted into exported `aggregateRolls(events, range, now)` + `rollupPlayers` + `shortAddress` with an explicit per-view contract (cards = range window · chart = capped window · delta-7d = GLOBAL over the full log, identical on every tab). `getDashboardData` loads the full local table and delegates ALL range filtering to the core (single source of truth).
- **🐛 Real bug caught by the new tests:** stat cards + top players previously counted the FULL event log on every tab (only the chart was range-filtered) — the 7d tab was showing all-time numbers. Fixed by the per-view contract above.
- **Test gate (`scripts/eventlog-tests.ts`, new `npm test`):** 31 deterministic checks (fixed UTC clock, no browser) — empty log ×4 tabs, bucket skeletons (7/30/12/26) + exact in-chart games/stake per tab, cards-vs-chart split on 'all', exact stat cards per tab (games/staked/wins/losses/winRate/bestRoll/Δ7d), bestRoll-only-wins, delta window math, top-players sort + tie-break + top-8 slice, `shortAddress` edges. Follows the existing esbuild-bundle + Node pattern (zero new dependencies).
- **Gates:** `npm run build` ✅ · `npm run lint` ✅ (0 errors; 3 pre-existing vendor warnings) · `npm run parity` ✅ (198+1200) · `npm test` ✅ (31/31) · `npm audit --audit-level=high` ✅ 0 vulns.
- **Docs:** `CHANGELOG.md` `[Unreleased]` created (was missing since 0.2.0) — 4.11 + Phase 5 + the range-filter fix.
- **Open (user):** manual E2E — play one game on testnet, confirm the dashboard updates and a new event carries the traceability fields (DevTools → Application → IndexedDB → kdice.rolls).

### 2026-10-25 — Phase 4.11: “Neon Vegas” theme alignment + motion layer
- **Concept → app diff** (full table in the 4.11 section) closed: header die-tile logo + gold Connect CTA; hero band (“ROLL ON. / WIN IN KLV.” + tags + decorative cyan/magenta dice); “PLAY” title + note; 2-column Play grid on ≥1000px (user choice: 2-col wide / vertical mobile with die stage first); gold stake box; “🎲 ROLL” + “Potential payout +X KLV”; W/L pills + gold staked column in Top players; footer line.
- **New files:** `src/hooks/useCountUp.ts` (ease-out rAF tween, re-target-safe, instant under `prefers-reduced-motion`).
- **`App.tsx`:** hero-intro section, logo-die, `wallet--cta`, rise classes, footer. **`OnChainDice.tsx`:** restructured into `.game` / `.game__left` / `.game__right` (DOM = left rail + right stage; CSS `order` re-sequences on mobile); WIN burst (ring + 10 sparks), stage-dots, `roll-btn--ready` pulse, `tray--land` settle pop. **`Dashboard.tsx`:** count-up cards, W/L pills, `gold-cell`, charts keyed by range (re-triggers draw-in). **`TrendChart.tsx`:** `pathLength={1}` for resolution-free dash draw-in.
- **`index.css`:** aurora drift (fixed pseudo-layer, transform-only), die idle float + land, burst, roll-pulse + shimmer, pop-in, dot-blink, trend-draw/fade, rise-in stagger, `prefers-reduced-motion` collapse. All pure CSS + 1 tiny hook — zero new dependencies.
- **Gates:** build ✅ · lint ✅ (0 errors; 3 pre-existing warnings in vendored `noble-ed25519.js`) · parity ✅ (198+1200 vectors) · `npm audit --audit-level=high` ✅ 0 vulns · preview ✅ (all 16 new class markers + hero text verified in the production bundle).

### 2026-10-24 — Phase 4.9: one-click auto-settle + on-chain-only table
- **User directive:** remove the mock game entirely (keep only the on-chain game) and make results appear automatically with a direct move to the next game — "the player wants to play one after another without manually loading his results of the last roll".
- **Removed (mock game):** `PracticeTable.tsx`, `History.tsx` (only consumer: PracticeTable), `engine/core.ts` (mock-credits engine — `fair.ts` provably-fair core stays, hero + ProvablyFair use it), `.practice*`/`.history*` CSS, App practice section.
- **Reworked `OnChainDice.tsx`:** `roll()` now owns a single auto chain (commit → confirm → findMyCommit → animation gate → `runSettle` → verify → result → 4 s auto-advance to ready). New `runSettle()` shared by the auto chain and the manual retry; new refs: `animDoneRef` (per-session promise resolved by `onAnimSettle` when the die locks) and `advanceTimerRef` (settled→idle auto-advance, cleared by new sessions). ROLL is available from `idle` AND `settled`; multiplier/stake locked only while busy or in the retry state.
- **Dashboard bridge:** `runSettle` appends a `RollEvent` (fire-and-forget) with the settled roll/stake/payout/address/ts + post-roll KLV balance, so the Overall Dashboard keeps working after the mock removal and the Phase 5 event schema is already fed by real on-chain games.
- **Errors fixed during build gate:** none — `tsc` clean on first pass after the file deletions.
- **Gates:** `npm run build` green · `npm run lint` 0 errors (3 pre-existing vendor warnings) · `npm audit --audit-level=high` 0 vulnerabilities · `vite preview` HTTP 200.
- **Open:** manual testnet E2E of the NEW one-click flow (connect → ROLL → two extension prompts → ✅ result with zero further clicks → ROLL again → dashboard updates).

### 2026-10-24 — Phase 4.8: on-chain first (the table IS the game) + 0.1.0 base
- **User report:** wallet connected + KLV balance correct, but the dice table still produced no transactions — the on-chain loop was buried in a bottom panel while the hero was the local mock. Directive: "the game itself must be fully on-chain" + start with a version bump as the base.
- **Version:** `package.json` 0.0.0 → **0.1.0**; `CHANGELOG.md` `[Unreleased]` → `[0.1.0] - 2026-10-24` (base app: contract + wallet + on-chain panel). New work lands under `[Unreleased]` (→ 0.2.0 candidate). No Cargo/tauri version files (web-only project).
- **Rework:** `OnChainDice.tsx` is now the hero table — ROLL = on-chain commit tx (die animates to the deterministic local derivation right after broadcast; confirmation + game-id lookup continue in the background), SETTLE = on-chain reveal tx + read-back + ✅/❌ verified badge, ROLL AGAIN for a fresh commitment. Live stage line, KLV stake, result banner with payout, explorer links, sound, `sessionRef` supersession guard for in-flight background chains.
- **Local table preserved** as `PracticeTable.tsx` (verbatim extraction of the old App table, clearly labeled OFFLINE — no destructive removal), rendered below the hero with a labeled head.
- **Errors fixed during build gate:** (1) chunked file insert left `const fmtKLV` inside the JSX (TS1382/TS1005) → moved back into the const group; (2) `game?.id !== null` does not narrow `game` for TS (TS18047 ×3) → `game !== null && game.id !== null`; (3) unused `useEffect` import after dropping the ref-wrapper pattern (TS6133) → removed.
- **Gates:** `npm run build` green (tsc strict + vite) · `npm run lint` 0 errors (3 pre-existing vendor warnings) · `npm audit --audit-level=high` 0 vulnerabilities · `vite preview` HTTP 200.
- **Open:** manual testnet E2E through the NEW hero flow (connect → ROLL → SETTLE → ✅ badge → explorer links → "My games").

### 2026-10-24 — Phase 4.7: Klever Extension wallet + on-chain play
- **Research:** ROADMAP 4.0 assumption ("K5 has no EIP-1193-style browser wallet") disproven — official 2026 Klever docs document the extension + `@klever/connect` SDK, and two local projects ship hand-rolled integrations: `dexscan/dexscan-api-portal/src/hooks/useKleverWallet.ts` (React, `window.kleverWeb`, PT-P2-8 silent-restore lesson) and `Ogmara/web/src/lib/klever.ts` (smart-contract `buildTransaction` path + provider-pin-before-initialize race note). User approved the **hand-rolled bridge** (zero new deps, keys stay in the extension).
- `src/types/klever.d.ts` — ambient `window.kleverWeb` types (`provider`, `initialize`, `getWalletAddress`, `buildTransaction`, `signTransaction`, `broadcastTransactions`); opaque `KleverTx` (dApp never inspects it).
- `src/services/wallet.ts` — detection (≤3 s poll), connect with provider pin derived from SC config (`node.X` → `api.X`), silent restore re-verifying stored address (mismatch → refuse attach), disconnect, event-bus `useWallet`, `getBalanceKLV` (`GET {api}/v1.0/address/{addr}`, 404 → 0, 10 s timeout + 64 KB cap).
- `src/services/txClient.ts` — `invokeContract` (callData `fn@hex@…` → btoa; `type:63 / scType:0 / callValue:{}`), `waitForTx` (`GET {api}/v1.0/transaction/{hash}`, confirmed/success vs fail/reject, 5 s poll / 90 s cap, transient retry), `minimalHex` (even-length — node rejects odd), `explorerUrl`, stage-tagged `TxError`, strict arg validation.
- `src/services/gameLedger.ts` — bounded local index of the user's games (seeds/tx/status/verified) + `useGameLedger`.
- `src/components/OnChainDice.tsx` — commit→settle play loop with on-chain-vs-local roll verification badge; `findMyCommit` scans ≤5 newest commits for (player, hash) match (handles concurrent commits).
- `src/App.tsx` — real wallet header (install/connect/chip+balance/disconnect); `handleSettle` exposed to `useRollAnimation` through a ref-stable wrapper (its `onSettle` is in the effect deps — identity changes would restart the animation); `OnChainDice` section wired.
- `src/components/ProvablyFair.tsx` — "My games" table (status/result/✅-badge/inspect → prefill + `doLookup(id)` — param added to dodge the stale `gameIdDraft` closure).
- `src/index.css` — `.onchain__*`, `.wallet__balance`, `.fair__mytable`, `.fair__btn--sm`.
- **Gates:** `tsc -b && vite build` green; oxlint 0 errors (3 pre-existing vendor warnings in `contracts/tools/vendor/noble-ed25519.js`); `npm audit --audit-level=high` 0 vulnerabilities; **encoding parity** vs `contracts/tools/lib.js`: `minimalHex` (0/1/2/47/1e6/1.23e8/1e12) + `buildCallData` for `commit`/`settle` byte-identical — ALL OK; `vite preview` HTTP 200.
- **Open:** manual testnet E2E with the user's Klever Extension (connect → faucet → commit → settle → verify badge) — ROADMAP 4.7 last item.

### 2026-10-24 — Phase 4.5: frontend provably-fair integration + live testnet gate
- `src/engine/fair.ts` — provably-fair core mirroring `contracts/src/dice.rs` 1:1 (commitment, LE-u32 roll, integer target `floor(10000/(105*m))`, Web Crypto SHA-256, 32-byte seed guard rejecting sub-array views).
- `src/services/scClient.ts` — typed read-only `vm/query` client: BIP-173 bech32 encode/decode (no deps), struct decoders for `CommitRecord`/`RollRecord`, even-length hex arg encoding, `VMUserError` → not-found mapping, 10 s timeout, 300 ms throttle queue, 256 KB response cap, config persistence (defaults to the deployed testnet contract).
- `src/components/ProvablyFair.tsx` + `index.css` — "Provably fair — on-chain (K5 testnet)" panel: config (node/contract) inputs, gameId lookup, side-by-side commit/roll cards, live win-flag cross-check badge, and a deep-verification section (paste both 32-byte seeds → local commitment + roll vs on-chain, ✅/❌).
- `src/engine/core.ts` `targetFor` switched to the integer form (single formula with the contract; same 47/23/9/1 values).
- **Live gate (`scripts/sc-check.ts`, run via rolldown bundle + Node):** bech32 round-trip ✅, `getName`=kDice ✅, 3 commits / 2 rolls ✅, `getTarget(2)`=47 ✅, protocol v1 ✅, all commit records decode (32-byte hashes, stake, player addr round-trip) ✅, roll #2 (2→WIN) & #3 (83→LOSE) win flags match local `roll ≤ target` ✅, unsettled commit #1 detected via `VMUserError` ✅, local derivation deterministic ✅ — ALL GATE CHECKS PASSED.
- **Audit:** `tsc -b && vite build` green; oxlint 0 errors (remaining warnings: pre-existing vendor noise); `npm audit` — 0 vulnerabilities.

### 2026-10-24 — Phase 4: klever-sc 0.45.0 migration + gate green
- Resolved all 34 compilation errors (see `contracts/ROADMAP.md`, phases 1–6 ✅) — trait-based contract pattern, event-ABI fixes, `#[init]`/`#[upgrade]` in the trait body, meta bin path.
- Clippy `-D warnings` clean after 3 behavior-identical lints: `commit.rs` unnecessary_cast, `settle.rs`/`upgrade.rs` op_ref; `cargo fmt` import/signature normalization.
- **Test bug fixed:** `dice.rs::targets_match_config` expected `25/12/5/1` (= 50% edge) — corrected to `47/23/9/1` matching canonical `src/engine/core.ts` `targetFor` (5% house edge). Contract logic was already correct.
- `cargo audit`: 3 advisories in `zip 4.6.1` — dev-only chain, not in the on-chain wasm (see 4.3).
- **Meta build green:** ran from `contracts/meta/` (CWD requirement) → `contracts/output/` bundle: `.wasm` (15,419 B) + `.abi.json` (14 endpoints) + `.kleversc.json` (packed, EI 1.3 OK) + `.imports.json`. `wasm/` scaffold auto-generated.
- **Next:** scenario tests (4.2: double-settle revert, wrong-hash revert, oversize-seed revert, max-commits cap) → tools + testnet deploy (4.4).

## Conventions (applied throughout)
- TypeScript strict, **no `any`**; JSDoc (`/** ... */`) on public components, hooks, and service functions
- Comments explain **why** (business rule / edge case / framework quirk), never *what*
- No placeholder/dead code without an explanatory comment
- Security: input validation on all user input, bounded payload parsing, client-side rate limiting on RPC, no secrets in the frontend
- Every phase ends with its **Gate** checked before the next starts
