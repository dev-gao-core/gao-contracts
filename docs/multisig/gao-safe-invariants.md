# GaoSafe Genesis — Invariant Matrix

> **Status:** Pre-audit. GaoSafe Genesis **targets Safe-grade core security** and is **designed toward Safe-grade security**. It is **not audited**, **not production-ready**, **not deployed to mainnet**, and **must not be used with real funds** until the consuming-app production-readiness gate (`gaokey-mobile/docs/multisig/production-readiness-gate.md`) is satisfied.

This document is the auditor-facing index for the property-style invariant tests added in PR 7. Each invariant maps to a named test in `test/multisig/`; each iteration is deterministic and reproducible from the master seed. The matrix complements (does not replace) the 56-case point matrix in [gao-safe-test-plan.md](./gao-safe-test-plan.md).

## 1. Methodology

| Item | Value |
|---|---|
| Toolchain | Existing Hardhat + ethers v6 + chai + Mocha. No Foundry. No new npm dependency. |
| Chain | Hardhat in-memory (chainId 31337). |
| Master seed | `0x6A0FED1357` — locked by the PR 7 plan. |
| Per-property seed | `uint32(keccak256("0x6A0FED1357:<property tag>"))`. Stable across CI runs and machines. |
| PRNG | `mulberry32` over the per-property seed; emits a float in [0, 1). |
| Iterations | **50 per property** by default. Fallback to 30 is allowed only if implementation proves a property exceeds the local runtime budget; the per-file header documents the rationale per the locked PR 7 plan. |
| Failure messages | Every `expect(...)` failure message includes `seed`, `iter`, `master`, and the iteration's derived inputs so any failure is reproducible without rerunning the suite. |

## 2. Invariant matrix

| # | Invariant | Test file | Iterations |
|---|---|---|---|
| I1 | Nonce monotonic: `nonce` increments exactly once per successful `execTransaction`. | `test/multisig/GaoSafe.invariants.test.ts` § I1 | 50 |
| I2 | Threshold ≤ owners.length after every owner-set or threshold mutation. | `test/multisig/GaoSafe.invariants.test.ts` § I2 | 50 |
| I3 | Threshold ≥ 1 after every valid `setup` configuration. | `test/multisig/GaoSafe.invariants.test.ts` § I3 | 50 |
| I4 | Only self-call mutates the owner set (`addOwner` / `removeOwner` / `replaceOwner` / `changeThreshold` revert with `NotSelfCall` when called externally). | `test/multisig/GaoSafe.invariants.test.ts` § I4 | 50 |
| I5 | Uninitialised execution is blocked: the bare implementation singleton reverts `NotSetup` on every `execTransaction` shape. | `test/multisig/GaoSafe.invariants.test.ts` § I5 | 50 |
| I6 | Implementation singleton refuses direct ETH ingress with `ImplementationCannotReceiveEth`. | `test/multisig/GaoSafe.invariants.test.ts` § I6 | 50 |
| I7 | Setup-initialised clones accept direct ETH ingress; balance increments by exactly the transferred value. | `test/multisig/GaoSafe.invariants.test.ts` § I7 | 50 |
| I8a | Non-ascending signature bundle reverts `SignaturesNotSorted`. | `test/multisig/GaoSafe.fuzz-signatures.test.ts` § I8a | 50 |
| I8b | Duplicate-signer bundle reverts `SignaturesNotSorted` (recovered == prev triggers the `recovered <= prev` guard). | `test/multisig/GaoSafe.fuzz-signatures.test.ts` § I8b | 50 |
| I8c | Bundle containing a non-owner signature is rejected (`NotAnOwner` or `SignaturesNotSorted`, depending on relative ordering). | `test/multisig/GaoSafe.fuzz-signatures.test.ts` § I8c | 50 |
| I8d | Strict-ascending owner-only bundle of size threshold is accepted (positive sanity for I8). | `test/multisig/GaoSafe.fuzz-signatures.test.ts` § I8d | 50 |
| I9a | `computeVaultAddress(deployer, clientSalt)` == address actually produced by `createVault(_, _, clientSalt)` when called by `deployer`. | `test/multisig/GaoSafeFactory.fuzz-create2.test.ts` § I9a | 50 |
| I9b | Same `clientSalt` from two different deployers produces two different addresses (deployer binding mitigates address squatting). | `test/multisig/GaoSafeFactory.fuzz-create2.test.ts` § I9b | 50 |
| I10 | Wrong-chain or wrong-vault digest substitution is rejected (bundle's recovered signers fail `isOwner` against the live vault's recomputed digest). | `test/multisig/GaoSafe.invariants.test.ts` § I10 | 50 |

**Total: 14 property-shaped tests across 3 files. 50 iterations per property by default. ≈ 700 deterministic iteration cases.**

(Note on numbering: I8 is a family — I8a, I8b, I8c, I8d. Counts above use the family granularity, not the individual sub-properties.)

## 3. Existing point-case coverage these properties complement

Each invariant has at least one point case in the existing 56-case matrix. PR 7's property tests are **density uplifts**, not replacements. Removing the existing point cases is out of scope.

| Property | Existing point case(s) in `gao-safe-test-plan.md` / `GaoSafe.test.ts` |
|---|---|
| I1 (nonce monotonicity) | Implicit in #12 (replay rejection) |
| I2 (threshold ≤ owners.length) | #32 (`removeOwner` with bad newThreshold) |
| I3 (threshold ≥ 1 after setup) | #6, #7, #33 (setup / changeThreshold input validation) |
| I4 (only self-call mutates) | `owner management — onlySelf rejections` describe block |
| I5 (uninit blocked) | #37 (bare implementation), #38 (manually-deployed uninit clone) |
| I6 (impl refuses ETH) | #39 |
| I7 (clone receives ETH) | #36 |
| I8a, I8b, I8c (signature rejections) | `execTransaction — rejections` describe block |
| I8d (sorted-ascending happy path) | #9, #10, #11 (per-kind happy paths exercise sorted bundles) |
| I9a (CREATE2 prediction matches) | F3 |
| I9b (different deployers → different addresses) | F4 |
| I10 (wrong chain / wrong vault) | Existing wrong-chain and wrong-vault cases in `execTransaction — rejections` plus parity cases P5–P7 |

## 4. Why deterministic Mocha and not Foundry

PR 7 deliberately stays on the existing Hardhat / ethers / chai / Mocha toolchain:

- **Toolchain stability.** Adding Foundry would introduce a parallel toolchain (`forge`, `lib/forge-std` submodule, separate CI image), which is a meaningful dependency-and-config change. PR 7 stays within the surface that contracts-CI already exercises.
- **Existing surface reuse.** ethers v6 + chai + Mocha is already proven across the 238-case suite at `fe6ee43`.
- **CI cost.** A ~700-iteration property suite runs in ~1 second against the in-memory chain. Fast enough that running on every PR is free.
- **Sufficient density for the hand-picked properties.** Each row in §2 gains matrix coverage that the existing point cases lacked.

A **future** sibling PR may introduce a Foundry invariant harness with stateful generation and shrinking. That is a separate operator decision and lands in its own reviewable PR with its own toolchain-impact summary. PR 7 explicitly does **not** open that door.

## 5. How to expand the matrix

To add a new invariant Ik:

1. Pick a stable property tag (e.g. `I11-some-new-property`).
2. Add a new `describe('Ik — ...')` block in the appropriate test file.
3. Inside the block, derive the per-property seed via `seedForProperty(tag)` and use `mulberry32(seed)` to drive the iteration.
4. Iterate `ITERATIONS` times (50 by default).
5. Every assertion's failure message must include `seed`, `iter`, `master`, and the iteration's derived inputs.
6. Add a row to §2 of this document.

If a new invariant requires modifying production Solidity to test (e.g. a new `view` helper), the PR introducing it follows the same hard-limit rule that PR 7 follows: **stop and report before changing any production source.**

## 6. Test-file-header rationale for the 30-iteration fallback

Per the locked PR 7 plan, a single property may be reduced from 50 to 30 iterations **only** if implementation proves it exceeds the local runtime budget. If invoked, the test-file header above that property must contain the following rationale, verbatim:

> Per the PR 7 locked plan, this property runs at 30 iterations rather than the default 50. Observed local runtime at 50 iterations: `<NNN>ms`. Reducing to 30 keeps the property's coverage density inside the in-memory chain's runtime budget while staying deterministic.

At PR 7 merge, the observed local runtimes are all well inside the budget; the fallback is **not invoked** for any property in the matrix.

## 7. Cross-references

- `test/multisig/GaoSafe.invariants.test.ts` — I1–I7, I10.
- `test/multisig/GaoSafe.fuzz-signatures.test.ts` — I8a, I8b, I8c, I8d.
- `test/multisig/GaoSafeFactory.fuzz-create2.test.ts` — I9a, I9b.
- `docs/multisig/gao-safe-test-plan.md` — 56-case point-matrix (unchanged by PR 7).
- `docs/multisig/gao-safe-static-analysis.md` — Slither advisory workflow companion.
- `docs/multisig/gao-safe-design.md` — contract design reference.
- `docs/multisig/gao-safe-threat-model.md` — contract threat model reference.
- `gaokey-mobile/docs/multisig/static-analysis-fuzz-plan.md` at `gaokey-mobile@6354d99` — companion mobile-side plan.
