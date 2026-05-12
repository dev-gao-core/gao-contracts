# GaoDomainDepositV3 — dev/test deploy + smoke evidence (2026-05-11)

> **Dev/test only.** This document captures evidence for a dev/test
> deploy + smoke of `GaoDomainDepositV3`. **No production touch.**
> No mainnet address changed. No secrets printed. Production launch
> remains BLOCKED.
>
> Source revision: `bc349c5c19d7a1f1f79d0e11a9d8fe2bd2fc9481`
> (`main` of `dev-gao-core/gao-contracts`).
>
> Artifacts in this PR:
> - `scripts/deployGaoDomainDepositV3.devtest.ts` — dev/test-only
>   deploy script (chain-id allowlist, mainnet banlist, dry-run by
>   default, public-value-only logging).
> - `scripts/smokeGaoDomainDepositV3.devtest.ts` — 12-case smoke
>   harness with ephemeral (in-memory) and live modes.
> - This evidence doc.

---

## Part A — Ephemeral (hardhat in-memory) smoke

This run exercises the deploy script's bytecode + the V3 contract's
behaviour against a freshly-deployed V3 instance on the hardhat
in-memory network. It produces real captured evidence WITHOUT
touching any external RPC, any operator-held key, or any
production address.

### Environment

| Field | Value |
|---|---|
| Network | `hardhat` (in-memory) |
| chainId | `31337` |
| Date | 2026-05-11 |
| Source SHA | `bc349c5c19d7a1f1f79d0e11a9d8fe2bd2fc9481` |
| Mode | `EPHEMERAL` |

### Public addresses observed (in-memory; not persistent)

These are hardhat's default deterministic signer addresses; they
have NO mainnet relevance and are reproducible on any clean clone.

| Role | Address |
|---|---|
| Deployer / owner | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| Payer | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| Buyer | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |
| Affiliate | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` |
| Attacker | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` |
| Treasury | `0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc` |
| Redirect target | `0x976EA74026E726554dB657fA54763abd0C3a0aa9` |
| MockERC20 | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| GaoDomainDepositV3 | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |

### Smoke results — 12/12 PASS

| # | Case | Result | Detail |
|---|---|---|---|
| S1 | contract owner matches expected | **PASS** | `owner()` == deployer |
| S2 | treasury matches expected | **PASS** | `treasury()` == fixture address |
| S3 | allowed token configured | **PASS** | `allowedTokens(MockERC20)` == true |
| S4 | deposit succeeds when unpaused | **PASS** | `isPending(invoiceId4)` == true |
| S5 | pause blocks deposit | **PASS** | `deposit()` reverts while paused (EnforcedPause) |
| S6 | settle is owner-only | **PASS** | attacker `settle()` reverts (`OwnableUnauthorizedAccount`) |
| S7 | settle credits ledger only — no auto-transfer | **PASS** | no `Transfer` event on settle tx; affiliate balance unchanged; affiliateWithdrawable credited |
| S8 | public `withdrawAffiliate` reverts (V3 LOCK) | **PASS** | `AffiliateSelfWithdrawDisabled` revert observed |
| S9 | owner `withdrawAffiliateFor` (unpaused) succeeds + pays affiliate | **PASS** | affiliate token-balance delta == credit |
| S10 | `withdrawAffiliateFor` reverts when paused (V3 hardening, V2 did not have this) | **PASS** | revert observed |
| S11 | `withdrawTreasury` succeeds even when paused (per V3 spec §5.5) | **PASS** | treasury balance delta == bucket |
| S12 | refund + rescue + invariant hold | **PASS** | payer refunded; excess rescued; `balanceOf(V3) >= lockedLiability + treasuryWithdrawable + totalAffiliateWithdrawable` |

### How to reproduce

```sh
cd ~/Desktop/gao-contracts
git checkout bc349c5c19d7a1f1f79d0e11a9d8fe2bd2fc9481  # or main if same
npm ci
npx hardhat compile
npx hardhat run scripts/smokeGaoDomainDepositV3.devtest.ts
```

Expected output ends with:

```
Total: 12  Passed: 12  Failed: 0

PASS

Smoke ran in EPHEMERAL mode on chainId 31337 (hardhat).
This is an in-memory dev/test run; no external RPC was touched.
```

## Part B — Base Sepolia live smoke (awaiting operator execution)

The live deploy + smoke against Base Sepolia (chainId `84532`)
requires operator-held credentials that this session does NOT have
access to. The dev/test deploy script ships in this PR and is
ready for the operator to run from a trusted workstation.

### Required environment (provisioned by operator)

The operator sets the following from a trusted workstation via
1Password-CLI / direnv / `wrangler secret put`. **NONE of these
values appear anywhere in the repo or in this evidence doc.**

| Env var | Purpose | Visibility in this PR |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | EOA used to send the deploy + setAllowedToken tx | NEVER committed |
| `BASE_SEPOLIA_RPC_URL` | RPC endpoint for chainId 84532 | NEVER committed |
| `GAO_OWNER_ADDRESS` | desired V3 owner (public 0x-40-hex) | operator supplies at run-time |
| `GAO_TREASURY_ADDRESS` | desired V3 treasury (public 0x-40-hex) | operator supplies at run-time |
| `GAO_USDC_ADDRESS` | dev/test USDC contract on Base Sepolia (public) | operator supplies at run-time |
| `BASESCAN_API_KEY` | for verification (optional but recommended) | NEVER committed |
| `CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3` | must equal `true` to broadcast | operator sets at run-time |

### Operator runbook (live deploy + verify)

1. **Dry-run first.** From a trusted workstation:

   ```sh
   GAO_OWNER_ADDRESS=0x... \
   GAO_TREASURY_ADDRESS=0x... \
   GAO_USDC_ADDRESS=0x... \
     npx hardhat run scripts/deployGaoDomainDepositV3.devtest.ts --network baseSepolia
   ```

   The script prints public addresses + a pre-broadcast selector
   check + the phrase `DRY-RUN. No transactions sent.` Confirm the
   addresses match operator-side records.

2. **Broadcast.** Re-run with the confirm flag:

   ```sh
   CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3=true \
   GAO_OWNER_ADDRESS=0x... \
   GAO_TREASURY_ADDRESS=0x... \
   GAO_USDC_ADDRESS=0x... \
     npx hardhat run scripts/deployGaoDomainDepositV3.devtest.ts --network baseSepolia
   ```

   The script:
   - Refuses any chainId outside `ALLOWED_DEVTEST_CHAIN_IDS`
     (allow: 31337/1337/84532/11155111/5; banlist: 1/8453/10/137/42161/56/43114).
   - Deploys V3 with `(GAO_OWNER_ADDRESS, GAO_TREASURY_ADDRESS)`.
   - Calls `setAllowedToken(GAO_USDC_ADDRESS, true)`.
   - Runs post-deploy `owner()` / `treasury()` / `allowedTokens()` /
     `paused()` / bucket reads with retry-on-RPC-tip-lag.
   - Writes a deployment record to
     `deployments/devtest/baseSepolia/GaoDomainDepositV3.json`.
   - Prints public addresses + the deploy tx hash. Never prints
     `DEPLOYER_PRIVATE_KEY` or any other secret.

3. **Smoke the deployed contract.** Run the same harness in LIVE
   mode against the address from step 2:

   ```sh
   V3_LIVE_ADDRESS=0x... \
   CONFIRM_SMOKE_V3=true \
   GAO_USDC_ADDRESS=0x... \
     npx hardhat run scripts/smokeGaoDomainDepositV3.devtest.ts --network baseSepolia
   ```

   Live mode runs the read-only cases (S1, S2, S3) + the V3 LOCK
   probe (S8) end-to-end against the deployed contract. Cases
   S4–S7 and S9–S12 are SKIPPED in live mode because they require
   operator-funded test payer / settle privilege; the operator
   should run those manually with explicit tx-by-tx evidence
   capture, OR re-deploy a separate test V3 with operator-funded
   wallets and run the ephemeral smoke against it.

4. **Verify on Basescan.**

   ```sh
   npx hardhat verify --network baseSepolia \
     <V3_ADDRESS> <GAO_OWNER_ADDRESS> <GAO_TREASURY_ADDRESS>
   ```

5. **Capture evidence.** Append to this doc under "Part C — Base
   Sepolia live smoke (executed)":
   - V3 address (public 0x-40-hex)
   - Deploy tx hash
   - Block number
   - Basescan verification URL
   - Tx hashes for each smoke case run
   - Operator name + workstation hostname (NOT the deployer key
     fingerprint)

### Part C — Base Sepolia live smoke (executed)

> **Awaiting operator execution.** No live smoke has been run from
> this session — the operator does so from a trusted workstation
> with credentials this session does not have access to.

| Field | Value |
|---|---|
| V3 dev/test address (Base Sepolia) | _AWAITING OPERATOR EXECUTION_ |
| Deploy tx hash | _AWAITING OPERATOR EXECUTION_ |
| Block number | _AWAITING OPERATOR EXECUTION_ |
| Basescan verification URL | _AWAITING OPERATOR EXECUTION_ |
| chainId | `84532` (Base Sepolia) |
| Smoke S1–S3 (live mode) | _AWAITING OPERATOR EXECUTION_ |
| Smoke S8 V3 LOCK probe (live mode) | _AWAITING OPERATOR EXECUTION_ |
| Smoke S4–S7, S9–S12 (operator-run manual, or via a fresh ephemeral V3 with operator wallets) | _AWAITING OPERATOR EXECUTION_ |

## Part D — Storage hygiene + scope

| Hygiene check | Evidence |
|---|---|
| No `DEPLOYER_PRIVATE_KEY` value in any artifact | grep `DEPLOYER_PRIVATE_KEY=` in committed files → (none) |
| No raw RPC URL in any artifact | grep `BASE_SEPOLIA_RPC_URL=` in committed files → (none) |
| No mainnet chain id in the script's allowlist | `ALLOWED_DEVTEST_CHAIN_IDS` = {31337, 1337, 84532, 11155111, 5} |
| Mainnet ids explicitly banned | `BANNED_MAINNET_CHAIN_IDS` = {1, 8453, 10, 137, 42161, 56, 43114} |
| Dry-run gated by `CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3=true` | yes — default exits before broadcast |
| Live-mode smoke gated by `CONFIRM_SMOKE_V3=true` | yes — refuses without the env flag |
| Deployment record path | `deployments/devtest/<network>/GaoDomainDepositV3.json` (NOT under `deployments/<network>/` which is the V2 production-track path) |
| No production address changed | confirmed by inspection of the diff |
| No BE config change | this is a contracts-repo-only PR |
| No `wrangler` invocation | confirmed |
| No mainnet RPC URL committed | confirmed |
| No AI attribution footer | confirmed |

## Remaining blockers to production launch

The dev/test deploy + ephemeral smoke is one rung on the production
ladder. Production launch remains **BLOCKED** on the following
independent items:

| Blocker | State |
|---|---|
| V2 dev/test drain + decommission **rehearsal** (exercise the migration runbook against a dev/test V2; capture evidence) | NOT EXECUTED |
| BE dev/test switch to V3 (`gao-id-worker` `GAO_DOMAIN_ESCROW_ADDRESS` flip in dev/test) | NOT EXECUTED |
| Live Base Sepolia V3 deploy + smoke (operator-only, per Part B above) | NOT EXECUTED |
| Third-party audit of V3 source | NOT COMMISSIONED |
| H-9 first deployer-key rotation (runbook in `gao-id-worker/docs/runbooks/h9-deployer-key-rotation.md`) | NOT EXECUTED |
| Regenerated audit baseline (incorporating BE Impl-A → Impl-F + V3 deploy evidence) | NOT REGENERATED |
| Operator production cutover approval (two-person sign-off in change-control record) | NOT GIVEN |

Production launch remains **BLOCKED.**
