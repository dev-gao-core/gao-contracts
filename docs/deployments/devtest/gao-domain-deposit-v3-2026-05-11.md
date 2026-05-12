# GaoDomainDepositV3 — dev/test deploy + smoke evidence (2026-05-11)

> **Dev/test only.** This document captures evidence for a dev/test
> deploy + smoke of `GaoDomainDepositV3`. **No production touch.**
> No mainnet address changed. No secrets printed. Production launch
> remains BLOCKED.
>
> Source revision (ephemeral evidence in Part A): `bc349c5c19d7a1f1f79d0e11a9d8fe2bd2fc9481`.
> Source revision (live Base Sepolia evidence in Part C): `18c9b763c82fc94c9b8f2adda3bebaa498dda9a0`
> (`main` of `dev-gao-core/gao-contracts` after PR #11 merged + env-name shim).
>
> Artifacts:
> - `scripts/deployGaoDomainDepositV3.devtest.ts` — dev/test-only
>   deploy script (chain-id allowlist, mainnet banlist, dry-run by
>   default, public-value-only logging, env-name shim accepting
>   either `GAO_*` or `V3_*` names).
> - `scripts/smokeGaoDomainDepositV3.devtest.ts` — 12-case smoke
>   harness with ephemeral (in-memory) + live (read-only + LOCK
>   probe) modes; accepts `V3_LIVE_ADDRESS` or `V3_ADDRESS`.
> - `scripts/reverifyV3.ts` — post-deploy on-chain re-verify
>   used when a deploy script's verify step false-alarms on RPC
>   tip-lag.
> - `deployments/devtest/baseSepolia/GaoDomainDepositV3.json` —
>   live deployment record.
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

### Part C — Base Sepolia live deploy + smoke (executed 2026-05-12)

The operator-driven Base Sepolia deploy + read-only smoke ran from
the operator workstation at 2026-05-12 ~02:42 UTC.

#### Deploy

| Field | Value |
|---|---|
| Network | `baseSepolia` |
| chainId | `84532` |
| V3 dev/test address | `0xF2e3db266d631193836351809EA584fF1fEe3604` |
| Deploy tx hash | `0xdf1cc13dbb77348a4b9211ad2384e9999f4b8dac1f159ca782f6ca91a33be895` |
| `setAllowedToken` tx hash | `0x75eb25751e0e72c18a779baa27a38ddd18484524b4b471778dae313260732884` |
| Deployer (public address) | `0xEbD284F02a4EC19945EE35fB9e03c8a603735781` |
| Owner (post-deploy `owner()`) | `0xEbD284F02a4EC19945EE35fB9e03c8a603735781` (signer-as-owner default) |
| Treasury (post-deploy `treasury()`) | `0x36cC88093d47334327A5CAE3a1E65F1C326fBFB1` |
| Allowed token (Base Sepolia USDC) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Bytecode length | 7358 bytes |
| 28-selector pre-broadcast check | PASS |
| Source verified on Basescan | NO (skipped — `BASESCAN_API_KEY` blank in operator env) |
| Deployment record file | `deployments/devtest/baseSepolia/GaoDomainDepositV3.json` |

> **Note on the deploy script's exit code.** On the live broadcast,
> the deploy script's post-deploy `allowedTokens(USDC)` read returned
> `false` ON FIRST READ due to Base Sepolia public-RPC tip-lag — the
> `setAllowedToken` tx had been included on the write node but the
> verify-read hit a node still on `latest - 1`. The script's
> `retryView` helper retries only on thrown errors, not on stale
> successful reads, so the deploy script exited with code 1 — a
> **false alarm**, not a real failure. A separate read-only
> `scripts/reverifyV3.ts` check seconds later confirmed
> `allowedTokens(USDC) = true` along with every other expected
> value. The deploy did NOT need to be re-broadcast. Follow-up item:
> harden `retryView` to also retry when the read returns a value
> known to be wrong (e.g. expected `true`, got `false`).

#### Re-verify reads (post-RPC-tip propagation)

```
owner():                       0xEbD284F02a4EC19945EE35fB9e03c8a603735781  ✓
treasury():                    0x36cC88093d47334327A5CAE3a1E65F1C326fBFB1  ✓
allowedTokens(USDC):           true                                       ✓
paused():                      false                                      ✓
lockedLiability(USDC):         0                                          ✓
treasuryWithdrawable(USDC):    0                                          ✓
totalAffiliateWithdrawable:    0                                          ✓
```

#### Smoke (live read-only subset)

Smoke harness run: `V3_ADDRESS=0xF2e3db266d631193836351809EA584fF1fEe3604
npx hardhat run scripts/smokeGaoDomainDepositV3.devtest.ts --network baseSepolia`
(without `CONFIRM_SMOKE_V3=true` → read-only + LOCK-probe subset).

| # | Case | Live result | Detail |
|---|---|---|---|
| S1 | contract owner matches expected | **PASS** | `owner()` == `0xEbD284F02a4EC19945EE35fB9e03c8a603735781` |
| S2 | treasury matches expected | **PASS** | `treasury()` == `0x36cC88093d47334327A5CAE3a1E65F1C326fBFB1` |
| S3 | allowed token configured | **PASS** | `allowedTokens(0x036CbD53842c5426634e7929541eC2318f3dCF7e)` == `true` |
| S4 | deposit succeeds when unpaused | **SKIPPED** | live — requires operator-funded payer with Base Sepolia USDC + approval |
| S5 | pause blocks deposit | **SKIPPED** | live — requires live deposit |
| S6 | settle owner-only | **SKIPPED** | live — requires live deposit |
| S7 | settle credits ledger only | **SKIPPED** | live — requires live deposit |
| S8 | public `withdrawAffiliate` reverts (V3 LOCK — `AffiliateSelfWithdrawDisabled`) | **PASS** | reverted as expected on the deployed contract |
| S9 | owner `withdrawAffiliateFor` unpaused | **SKIPPED** | live — requires live deposit + accrued credit |
| S10 | `withdrawAffiliateFor` reverts when paused | **SKIPPED** | live — requires live deposit + accrued credit |
| S11 | `withdrawTreasury` succeeds even when paused | **SKIPPED** | live — requires settled treasury bucket |
| S12 | refund + rescue + invariant hold | **SKIPPED** | live — requires live deposit |

**Active live cases: 4/4 PASS. Skipped (operator-funded paths): 8.**

The ephemeral smoke in Part A exercises every mutating path against
an identical-bytecode V3 instance (12/12 PASS, including S4–S7,
S9–S12). To exercise the mutating subset on the live Base Sepolia
deployment, the operator funds a payer wallet with Base Sepolia
USDC + re-runs the smoke harness with `CONFIRM_SMOKE_V3=true`.

#### Basescan verification status

`BASESCAN_API_KEY` was blank in the operator environment at deploy
time, so the source-code verification step was **skipped**. The
deployed bytecode at `0xF2e3db266d631193836351809EA584fF1fEe3604`
can be verified after the fact via:

```sh
BASESCAN_API_KEY=<set> \
  npx hardhat verify --network baseSepolia \
    0xF2e3db266d631193836351809EA584fF1fEe3604 \
    0xEbD284F02a4EC19945EE35fB9e03c8a603735781 \
    0x36cC88093d47334327A5CAE3a1E65F1C326fBFB1
```

Captured as a follow-up item.

#### Env-name compatibility shim landed alongside this evidence

The operator's `.env` shape used `V3_TREASURY_ADDRESS` and
`V3_ALLOWED_TOKEN_ADDRESSES` (CSV) where the deploy script
originally required `GAO_TREASURY_ADDRESS` / `GAO_USDC_ADDRESS`.
This PR lands a compatibility shim that accepts either set of
names without code change to the operator's workstation. The
shim also defaults `owner` to the deployer signer when no
`GAO_OWNER_ADDRESS` / `V3_OWNER_ADDRESS` is supplied (the dev/test
pattern used in this deploy). Live mode smoke also now accepts
`V3_ADDRESS` as a synonym for `V3_LIVE_ADDRESS`.

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
| Live Base Sepolia V3 deploy + smoke (read-only subset) | **EXECUTED** 2026-05-12 — see Part C. V3 at `0xF2e3db266d631193836351809EA584fF1fEe3604`. |
| Live Base Sepolia V3 mutating smoke (S4–S7, S9–S12) with operator-funded payer | NOT EXECUTED |
| Basescan source verification of the deployed V3 | NOT EXECUTED — `BASESCAN_API_KEY` blank at deploy time; runnable after the fact |
| V2 dev/test drain + decommission **rehearsal** (exercise the migration runbook against a dev/test V2; capture evidence) | NOT EXECUTED |
| BE dev/test switch to V3 (`gao-id-worker` `GAO_DOMAIN_ESCROW_ADDRESS` flip in dev/test) | NOT EXECUTED |
| Third-party audit of V3 source | NOT COMMISSIONED |
| H-9 first deployer-key rotation (runbook in `gao-id-worker/docs/runbooks/h9-deployer-key-rotation.md`) | NOT EXECUTED |
| Regenerated audit baseline (incorporating BE Impl-A → Impl-F + V3 deploy evidence) | NOT REGENERATED |
| Operator production cutover approval (two-person sign-off in change-control record) | NOT GIVEN |

Production launch remains **BLOCKED.**
