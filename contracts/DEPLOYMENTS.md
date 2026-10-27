# kDice — Deployments

## Testnet (K5)

| Field | Value |
|---|---|
| Contract address | `klv1qqqqqqqqqqqqqpgqxwtjrzvrd62e8l7fksrrzkqqa5xyufm0mvgqndrl9s` |
| Deploy tx | `65987c6c2972236df0b8aef97fad513997cfc013f2af1660cba36a66a934c06b` — [explorer](https://testnet.kleverscan.org/transaction/65987c6c2972236df0b8aef97fad513997cfc013f2af1660cba36a66a934c06b) |
| Deployed | 2026-10-24 |
| **Upgraded to v2.0.0 in place (same address)** | 2026-10-24 (Phase 4.10 — over/under 1–99) |
| **Upgraded to v3.0.0 in place (same address)** | 2026-10-26 (Phase 7 — chain-random commit) |
| Operator (deployer/owner) | `klv16wl46pvce6mfwcfqn54xzd5dvkyqs7g2ehcz7e52spdphkgxmvgqjzk8pu` (testnet-only PEM: `tools/operator-kdice-testnet.pem`) |
| Code metadata | upgradeable + readable (0x0500) |
| WASM (v3) | `output/kdice-contract.wasm` — contract `protocolVersion` now 3 |

### v3.0.0 upgrade (Phase 7, 2026-10-26)
- **Breaking ABI change:** `commit(hash, target, over, stake)` (4 args) → **`commit(target, over, stake)`** (3 args). The roll is now derived **on-chain** from the confirming block's 48-byte consensus random seed + the game id (`LE_u32(sha256(seed‖id_le64)[0..4]) % 100 + 1`) and written in the **same transaction** — the `settle` endpoint is retired and there is no seed reveal.
- **Storage meaning shift (schema unchanged):** `CommitRecord.hash` now carries the 48-byte block seed for v3 records (96 hex); legacy v1/v2 records keep their 32-byte commitment (64 hex). Both decode unambiguously by length.
- **Verified in place** via `tools/upgrade-v3-verify.mjs`: pre-upgrade snapshot of all 30 records → `upgradeContract` (protocolVersion 2→3) → **zero data loss** (every old commit/roll byte-identical) → v3 games with 48-byte seeds where **on-chain roll == local re-derivation** (43=43, 41=41, 32=32, 78=78) and win flag == bet rule; `getPayout`/`getTarget` views survive.
- **Frontend 0.4.0** (this repo): single-tx flow (one extension prompt), `finalizeGame` re-derives from the stored block seed, ProvablyFair panel takes a single 48-byte seed input.

### v2.0.0 upgrade (Phase 4.10, 2026-10-24)
- **ABI change:** `commit(hash, multiplier, stake)` (3 args) → `commit(hash, target, over, stake)` (4 args). Bet stored in the legacy `multiplier: u32` field with disjoint encodings — v1: {2,4,10,50} · v2: `100 + target·2 + over` (102..299), so v1 records keep decoding exactly.
- **New win rule (v2):** `over ? roll > target : roll <= target` (v1 records: unchanged `roll <= target_for(multiplier)`).
- **New payout view:** `getPayout(target, over)` = `floor(9500 / (over ? 100−target : target))` — continuous 5% edge (under@47→202, under@23→413, under@9→1055, under@1/over@99→9500).
- **Verified in place:** all 15 contract unit tests green; live testnet run via `tools/upgrade-v2-verify.mjs` — old v1 records still readable, `getPayout` curve exact, v2 under-WIN + over-WIN + over-LOSE settlements match the local `fair.ts` derivation (commit → settle → roll record cross-checked).
- **Frontend 0.2.0** (this repo): hero table now uses the UNDER/OVER toggle + 1–99 slider and sends the 4-arg commit (bool as `00`/`01`, the node-verified encoding).

### Verified end-to-end cycle (2026-10-24)
- ✅ Deploy confirmed; contract address recovered from the deploy receipt
- ✅ Sanity views: name=kDice · protocolVersion=1 · maxActiveCommits=100 · targets 2→47, 4→23, 10→9, 50→1
- ✅ WIN game #2: commit `ba68138e34b2281c02019133cf08b62608cc2a41a20f90d5e635f14f16c67e04` → settle `280759d523335a7c3d9ebb5c91bb96b68ff5318df5e4d0a5773ecd8ff54164e1` → roll **2**, win **true** (local SHA-256 re-derivation matches)
- ✅ LOSE game #3: commit `e41406f49ef7cfa53d3712b349c9b2deb31ca389c9f3af80168d95f89c2b4861` → settle `776a1250494a1ef5c509f6635411d13ec9f2dbc4b63b5727dcaf04321d3283e4` → roll **83**, win **false**
- ✅ Commit records flip to consumed; `getActiveCommits(operator)` net-zero (1 before → 1 after)

### Fixtures (mirror `tests/scenario_test.rs`)
- Server seed: ASCII `0123456789abcdef0123456789abcdef` (32 bytes)
- WIN player seed: 32×0x00 → hash `…9f` → roll 2 (target 47 at 2×)
- LOSE player seed: 32×0x68 → hash `…1c` → roll 83 (target 47 at 2×)

## Mainnet
_Not deployed yet (Phase 4 is testnet-only; mainnet toggle later — see ROADMAP)._
