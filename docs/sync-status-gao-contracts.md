# Sync Status — gao-contracts

## Timestamp

2026-04-28 UTC.

## Git

| Field | Value |
|---|---|
| Current branch | `main` |
| Local HEAD | `b22c0db` |
| origin/main HEAD | `b22c0db` |
| Working tree clean | ✅ (only `.claude/` untracked — agent state, gitignored by convention) |

Local main and origin/main are in sync. Last 3 commits on main:

```
b22c0db feat(scripts): add allow-usdc helper for GaoDomainDeposit
c012783 feat: add treasury withdrawals for settled domain payments
42b6c2e Initial commit: GaoDomainDeposit + Hardhat scaffolding
```

## GaoDomainAnchor

**The anchor work is on PR #1, NOT on main.** The previous task's stated premise ("PR #1 for GaoDomainAnchor was merged. Contract code should now be on main.") is incorrect against actual repo state. PR #1 is **open and mergeable but not yet merged**.

| Asset | On main? | On PR #1 branch (`feat/gao-domain-anchor-contract`) |
|---|---|---|
| `contracts/GaoDomainAnchor.sol` | ❌ | ✅ |
| `abis/GaoDomainAnchor.json` | ❌ | ✅ |
| `scripts/deployGaoDomainAnchor.ts` | ❌ | ✅ |
| `package.json` `deploy-anchor:base-sepolia` / `deploy-anchor:base` scripts | ❌ | ✅ |
| `test/GaoDomainAnchor.test.ts` | ❌ | ✅ |
| `docs/gao-domain-anchor-contract-report.md` | ❌ | ✅ |

PR state (verified live via `gh pr view 1`):

```
url:        https://github.com/dev-gao-core/gao-contracts/pull/1
state:      OPEN
mergeable:  MERGEABLE
mergeStateStatus: CLEAN
mergedAt:   null
title:      feat: add GaoDomainAnchor contract
head:       feat/gao-domain-anchor-contract
base:       main
```

The branch is one commit ahead of main:

```
4641771 feat: add GaoDomainAnchor contract
```

## Tests (current main)

| Check | Command | Result |
|---|---|---|
| Test suite (existing GaoDomainDeposit only) | `npm test` | **29/29 passing** |

The 17 new anchor tests live on the PR #1 branch; the full anchor + deposit suite runs **46/46** there. Tests don't reach main until PR #1 is merged.

## Deployment Status

| Field | Value |
|---|---|
| Base Sepolia deployed | **No** |
| Deployment artifact path | n/a (no `deployments/` directory on main; `deployments/base-sepolia/` does not exist on the PR branch either — the deploy script writes it post-deploy) |
| Contract address | not yet assigned |
| Tx hash | not yet broadcast |
| Deployer | n/a |
| Chain ID | n/a (target would be 84532 / Base Sepolia) |

`.env` in the repo has `DEPLOYER_PRIVATE_KEY` and `BASE_SEPOLIA_RPC_URL` set (verified key-only inspection — values not echoed). The deploy command is ready to run; nobody has run it yet.

## Next Step

**The next step depends on whether owner wants to merge PR #1 first or deploy from the PR branch.** Two valid orderings:

### Option A — merge PR #1 first, then deploy from main

```bash
cd /Users/cryptobank/workspace/gao-contracts
git fetch origin --prune
gh pr merge 1 --squash --delete-branch
git checkout main
git pull --ff-only origin main
npm test                              # 46/46 expected
npm run deploy-anchor:base-sepolia    # writes abis/ + deployments/base-sepolia/
cat deployments/base-sepolia/GaoDomainAnchor.json
git add deployments/base-sepolia/GaoDomainAnchor.json
git commit -m "deploy: GaoDomainAnchor on Base Sepolia"
git push origin main
```

### Option B — deploy from the PR branch, then merge

```bash
cd /Users/cryptobank/workspace/gao-contracts
git fetch origin --prune
gh pr checkout 1
npm test                              # 46/46 expected
npm run deploy-anchor:base-sepolia
cat deployments/base-sepolia/GaoDomainAnchor.json
git add deployments/base-sepolia/GaoDomainAnchor.json
git commit -m "deploy: GaoDomainAnchor on Base Sepolia"
git push origin HEAD                  # pushes to feat/gao-domain-anchor-contract
gh pr merge 1 --squash --delete-branch
```

Either way, after deployment:
- Capture `BASE_SEPOLIA_ANCHOR_CONTRACT_ADDRESS` printed by the script.
- Move to `gao-id-worker` for the ABI / address integration follow-up (see [sync-status-gao-id-worker.md](../../gao-id-worker/docs/sync-status-gao-id-worker.md)).

## Notes

- Do not commit `.env` — `.gitignore` already excludes it.
- Do not deploy Base mainnet (`npm run deploy-anchor:base`) without explicit operator approval.
- `.claude/` directory is agent state; ignored by convention.
- Existing `GaoDomainDeposit` payment contract is untouched — diff to main is purely additive (anchor only) on the PR branch.
