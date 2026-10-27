# kDice

**Provably-fair on-chain dice on the Klever blockchain.**

kDice is a full-stack dice game where the roll is generated **on-chain from the
confirming block's consensus random seed** — no server RNG, no commit/reveal
round, no seed to trust. You sign one transaction, the contract writes the roll
in the same atomic step, and the dApp re-derives the exact roll locally so you
can verify it yourself.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## The v3 protocol (chain-random)

```
seed   = 48-byte consensus random seed of the block confirming your bet
roll   = LE_u32( sha256( seed ‖ game_id_le64 )[0..4] ) % 100 + 1
win    = over ? roll > target : roll <= target
```

- **One prompt per bet** — `commit(target, over, stake)` does the roll in the
  same transaction; there is no `settle` call and nothing to reveal.
- **Client-side verification** — the dApp stores the block seed with every game
  and re-derives the roll locally (same SHA-256 over `seed‖id`) so any
  mismatch is visible before you accept the result.
- **Deterministic & auditable** — given the block (anyone can fetch it) and the
  game id, the roll is mathematically fixed. See `src/engine/fair.ts` and
  `contracts/src/dice.rs`.

## Repository layout

| Path | What |
|---|---|
| `src/` | dApp (React 19 + TypeScript + Vite) — bet UI, ProvablyFair panel, local game ledger (Dexie) |
| `src/engine/fair.ts` | Local roll re-derivation (the verification engine) |
| `contracts/src/` | Rust smart contract (klever-sc) — commit, queries, upgrades |
| `contracts/tests/` | Scenario tests (`cargo test`) |
| `scripts/` | `fair-parity.ts` (client↔math parity), `eventlog-tests.ts`, `sc-check.ts` (live-chain verification) |
| `contracts/DEPLOYMENTS.md` | Live addresses, upgrade history, exact build/deploy steps |
| `ROADMAP.md` | Phased project history & plan |

## Quickstart (dApp)

```bash
npm install
npm run dev        # local dev server (Vite)
```

Point the app at the testnet contract and sign with the Klever wallet
extension — private keys never leave the extension; the dApp only handles
opaque transaction bytes.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `npm run build` / `npm run preview` | Vite dev / type-check + build / preview |
| `npm test` | Event-log decoding tests (31) |
| `npm run parity` | Client ↔ contract math parity (500 derivations + 198 bet-rule cases) |
| `npm run lint` | oxlint |

## Contract

```bash
cd contracts
cargo test                          # scenario tests
```

Build & deploy: see [`contracts/DEPLOYMENTS.md`](./contracts/DEPLOYMENTS.md)
(the contract is built through the `meta` crate; the live testnet deployment is
upgraded in place by the owner).

## Verification (trust model)

- On-chain roll vs. local re-derivation is cross-checked in **three** places:
  `cargo test` scenarios, `npm run parity` (500/500), and `scripts/sc-check.ts`
  against the **live chain**.
- Caveat: block seeds are validator-influenced (standard block-randomness
  model). The upgrade path if a stronger threat model is ever required is
  VRF / two-party entropy.

## Contributing

Issues and PRs welcome — this is MIT-licensed. Please run `npm test`,
`npm run parity`, and `cargo test` (plus `clippy`) before opening a PR that
touches game logic.

## License

[MIT](./LICENSE) © 2026 Maik
