# Base mainnet deploy runbook — B4 ceremony

> **Operator-only ceremony.** No agent. No CI. No automation. Every
> command in this runbook is executed by hand by the operator on a
> trusted workstation with operator-held custody material. Agents
> MAY review this document and DRAFT commands, but MUST NOT execute
> the broadcast steps.
>
> **Scope:** B4 closure — deploy `GaoDomainDepositV3` and
> `GaoDomainAnchor` on Base mainnet (chainId 8453) for the Gao
> Domains product v1.
>
> **Out of scope:**
>   - Backend signer / HSM / KMS / MPC. Product v1 user purchase
>     and user self-anchor do **NOT** require a backend signer;
>     B2 deferral does not block this ceremony. See
>     `gao-id-worker-ops/docs/go-live-blockers.md` B2.
>   - Treasury sweep / on-chain refund / affiliate cash payout.
>     Those backoffice money ops are deferred behind B2 (H-3 Phase
>     4B external signer adapter).
>   - V2 → V3 migration drain. Base mainnet has no deployed V2;
>     V3 is the first canonical escrow on mainnet.

---

## 1. Why this exists

The dev/test deploy scripts in `scripts/` hard-ban Base mainnet
via `BANNED_MAINNET_CHAIN_IDS` and CLAUDE.md §2 forbids weakening
them. The mainnet ceremony lives in
`scripts/mainnet/`:

- `scripts/mainnet/deployGaoDomainDepositV3.mainnet.ts` — escrow
  (user purchase contract).
- `scripts/mainnet/deployGaoDomainAnchor.mainnet.ts` — anchor
  (user self-anchor contract).

Both scripts mirror the dev/test guard pattern, but inverted:
- `ALLOWED_MAINNET_CHAIN_IDS = {8453}` — only Base mainnet.
- `BANNED_NON_BASE_MAINNET_CHAIN_IDS` — every testnet + every
  foreign mainnet, so a `--network baseSepolia` typo falls closed.
- Hard `CONFIRM_*=true` gate. Default is dry-run.

---

## 2. Preconditions — must be true BEFORE the operator starts

1. ✅ V3 source merged on `main` of `dev-gao-core/gao-contracts`.
2. ✅ Anchor source merged on `main`.
3. ✅ Full hardhat test suite green on the approved SHA
   (`npx hardhat test` — 254/254 PASS as of the audit baseline).
4. ✅ Operator has reviewed V3 against
   `docs/security/affiliate-onchain-withdraw-lock.md` §5 and
   signed off in the operator change-control record.
5. ✅ Operator has decided **initial owner** posture:
    - **Recommended:** Safe / multisig as `GAO_OWNER_ADDRESS`.
    - **Tolerated:** hot EOA temporarily, with `transferOwnership`
      to a Safe scheduled as the first owner action.
6. ✅ Operator has decided **initial treasury** wallet
   (`GAO_TREASURY_ADDRESS`). Must be DISTINCT from owner.
7. ✅ Operator has funded the deployer EOA with Base mainnet ETH
   (~0.01 ETH covers both deploys + the inline `setAllowedToken`).
8. ✅ Operator has a Basescan API key
   (https://basescan.org/myapikey) bound to `BASESCAN_API_KEY`.
9. ✅ Operator has a private Base mainnet RPC endpoint bound to
   `BASE_RPC_URL` (Alchemy / QuickNode / Infura / Coinbase Node).
10. ✅ `gao-id-worker-ops` PR #5 merged
    (`chore(ops): document Base mainnet payment and anchor config
    (#5)`) so `wrangler.prod.template.toml` has the placeholders
    waiting for the deployed addresses.
11. ✅ Two-person operator approval channel exists (out-of-band
    ceremony recorded in the operator change-control record).

---

## 3. Operator inputs — env var NAME-only checklist

> Values NEVER appear in this file. NEVER paste real values into
> chat / PR / Slack / Telegram. The agent CANNOT read `.env`; the
> operator provisions it on the trusted workstation only.

| Env var | Required | Purpose |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | yes | Hot EOA that signs both deploys (+ optionally `setAllowedToken`). Funded with Base ETH. |
| `BASE_RPC_URL` | yes | Base mainnet RPC (private, embeds provider API key). |
| `GAO_OWNER_ADDRESS` | yes (V3) | Initial owner of V3. Safe / multisig recommended. |
| `GAO_TREASURY_ADDRESS` | yes (V3) | Initial treasury wallet (USDC sweep recipient). Must be DISTINCT from owner. |
| `GAO_USDC_ADDRESS` | optional (V3) | If set, MUST equal canonical Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Default = canonical. |
| `BASESCAN_API_KEY` | yes (verify) | One key works for both Sepolia + mainnet under the unified Etherscan v2 API. |
| `CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3_MAINNET` | yes at broadcast | Literal string `"true"` to broadcast V3. Any other value → dry-run. |
| `CONFIRM_DEPLOY_ANCHOR_MAINNET` | yes at broadcast | Literal string `"true"` to broadcast anchor. Any other value → dry-run. |

### Safe / multisig owner caveat

If `GAO_OWNER_ADDRESS` is a Safe / multisig:
- The V3 deploy script will **SKIP** the inline `setAllowedToken`
  call (deployer cannot sign owner-only methods on behalf of the
  Safe).
- The Safe MUST execute `setAllowedToken(USDC, true)` on the V3
  contract address as the **first** owner action after deploy.
- Until that Safe tx confirms, `/v2/contracts/health` returns
  `healthy: false` (USDC is required-allowlisted by the BE
  pre-checkout health surface).

If `GAO_OWNER_ADDRESS == DEPLOYER address` (hot EOA pattern):
- The script calls `setAllowedToken(USDC, true)` inline.
- Operator MUST schedule `transferOwnership(<Safe>)` as soon as
  the Safe is operational. Hot-EOA-as-owner on mainnet is a known
  risk and must not persist into normal operation.

---

## 4. Preflight (no broadcast)

Run all of these in order. Stop and investigate if any step fails.

```sh
# 0. Trusted workstation only. NOT a dev machine. NOT CI.
cd /path/to/gao-contracts

# 1. Sync repo to approved SHA
git fetch origin --prune
git checkout main
git reset --hard origin/main        # must equal the SHA in change-control
git status --short                  # must be clean

# 2. Install deps + compile
npm ci
npx hardhat compile                 # must succeed

# 3. Full test suite (in-memory hardhat — no RPC, no funds)
npx hardhat test                    # expect 254/254 PASS

# 4. Env-presence check — NAME-only, no values printed
node -e "require('dotenv').config(); for (const k of ['DEPLOYER_PRIVATE_KEY','BASE_RPC_URL','GAO_OWNER_ADDRESS','GAO_TREASURY_ADDRESS','BASESCAN_API_KEY']) console.log(k + '=' + (process.env[k] ? 'SET' : 'MISSING'))"

# 5. Derive deployer public address — verifies the funded EOA
#    matches the env key. Output is the PUBLIC address only, never
#    the private key.
node -e "const{Wallet}=require('ethers');console.log('deployer:', new Wallet(process.env.DEPLOYER_PRIVATE_KEY).address)"

# 6. Confirm chainId + balance on Base mainnet via the provided RPC.
#    Expect chainId 8453n and a non-zero balance.
node -e "(async()=>{const{JsonRpcProvider,Wallet,formatEther}=require('ethers');const p=new JsonRpcProvider(process.env.BASE_RPC_URL);const w=new Wallet(process.env.DEPLOYER_PRIVATE_KEY,p);console.log('chainId:',(await p.getNetwork()).chainId);console.log('deployer:',w.address);console.log('balance:',formatEther(await p.getBalance(w.address)),'ETH');})()"

# 7. Mainnet dry-run for V3 — confirm allowlist gate + selector
#    check + env validation all pass before any broadcast.
GAO_OWNER_ADDRESS=<set in env> \
GAO_TREASURY_ADDRESS=<set in env> \
  npx hardhat run scripts/mainnet/deployGaoDomainDepositV3.mainnet.ts --network base
# Expect: "DRY-RUN. No transactions sent." + "PASS (dry-run)"

# 8. Mainnet dry-run for Anchor
npx hardhat run scripts/mainnet/deployGaoDomainAnchor.mainnet.ts --network base
# Expect: "DRY-RUN — no transactions sent."
```

---

## 5. Broadcast — Step 1: Deploy GaoDomainDepositV3

```sh
CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3_MAINNET=true \
GAO_OWNER_ADDRESS=<Safe or hot EOA>           \
GAO_TREASURY_ADDRESS=<distinct wallet>         \
  npx hardhat run scripts/mainnet/deployGaoDomainDepositV3.mainnet.ts --network base
```

Script will:
1. Re-run all gates (chainId 8453, banlist, env, selector matrix).
2. Deploy `GaoDomainDepositV3(initialOwner, initialTreasury)`.
3. If deployer == initialOwner, call `setAllowedToken(USDC, true)`
   inline. If deployer != initialOwner, skip and print the
   Safe-side follow-up instruction.
4. Verify on-chain state: `owner()`, `treasury()`,
   `allowedTokens(USDC)`, `paused() == false`, all liability
   buckets == 0.
5. Write `deployments/base/GaoDomainDepositV3.json`.

Capture from the log:
- V3 contract address.
- V3 deploy tx hash.
- `setAllowedToken` tx hash (if inline) — else "skipped, owner
  follow-up required".
- Block number of each tx (via Basescan).

---

## 6. Broadcast — Step 2: Verify V3 on Basescan

```sh
BASESCAN_API_KEY=<set in env> \
  npx hardhat verify --network base <V3_ADDRESS> <GAO_OWNER_ADDRESS> <GAO_TREASURY_ADDRESS>
```

Verification is **mandatory** — explorers + wallets render raw
bytecode without it, and users cannot read the contract source
to confirm V3 LOCK behaviour.

Capture: Basescan verification URL.

---

## 7. Broadcast — Step 3 (only if owner != deployer): Safe sets USDC allowlist

If deployer != initialOwner (Safe / multisig path):

1. Open the Safe app at https://app.safe.global on Base.
2. Create a new transaction:
   - Target: `<V3_ADDRESS>`
   - Contract method: `setAllowedToken(address token, bool allowed)`
   - `token` = `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
     (canonical Base mainnet USDC)
   - `allowed` = `true`
3. Collect required signatures.
4. Execute.
5. Confirm via Basescan that `allowedTokens(USDC)` returns `true`
   on `<V3_ADDRESS>`.

Capture: Safe tx hash + Basescan confirmation URL.

---

## 8. Broadcast — Step 4: Deploy GaoDomainAnchor

```sh
CONFIRM_DEPLOY_ANCHOR_MAINNET=true \
  npx hardhat run scripts/mainnet/deployGaoDomainAnchor.mainnet.ts --network base
```

Script will:
1. Re-run all gates.
2. Deploy `GaoDomainAnchor` (no constructor args, no owner).
3. Write `abis/GaoDomainAnchor.json` (idempotent — already exists
   from dev/test, content equal to mainnet).
4. Write `deployments/base/GaoDomainAnchor.json`.

Capture:
- Anchor contract address.
- Anchor deploy tx hash.
- Block number.

---

## 9. Broadcast — Step 5: Verify Anchor on Basescan

```sh
BASESCAN_API_KEY=<set in env> \
  npx hardhat verify --network base <ANCHOR_ADDRESS>
```

Anchor has no constructor args, so no positional args to the
verify command.

Capture: Basescan verification URL.

---

## 10. Evidence commit

After the ceremony, commit the deployment artifacts to a new
branch on `dev-gao-core/gao-contracts`:

```sh
# Branch name suggestion:
git checkout -b chore/base-mainnet-b4-deploy-evidence

# Files to add:
git add deployments/base/GaoDomainDepositV3.json
git add deployments/base/GaoDomainAnchor.json
git add abis/GaoDomainAnchor.json   # only if changed (regenerated)

# Add an evidence doc — drop in `docs/deployments/base/` (kebab):
git add docs/deployments/base/b4-2026-MM-DD.md
```

Evidence doc structure (template):

```markdown
# Base mainnet B4 deploy evidence — YYYY-MM-DD

## Chain
- chainId 8453 (Base mainnet)
- Approved source SHA: <ops change-control SHA>

## GaoDomainDepositV3
- Address: 0x...
- Deploy tx: 0x...
- Block: <number>
- Deployer (public addr): 0x...
- Initial owner: 0x...
- Initial treasury: 0x...
- Allowed token: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
- setAllowedToken tx: 0x... | "Safe-executed, see step 7"
- Basescan verify: https://basescan.org/address/0x...#code

## GaoDomainAnchor
- Address: 0x...
- Deploy tx: 0x...
- Block: <number>
- Deployer (public addr): 0x...
- Basescan verify: https://basescan.org/address/0x...#code

## Operator approvers
- <name 1> approved <UTC timestamp>
- <name 2> approved <UTC timestamp>

## Change-control record ID
- <internal record ID>

## What does NOT appear
- No private keys
- No mnemonics
- No RPC URLs (API key embedded)
- No deployer private key prefix
```

Open the artifact PR against `dev-gao-core/gao-contracts main`.
After merge, mirror to `gao-core/gao-contracts` via the existing
mirror process.

---

## 11. Wire BE config (gao-id-worker-ops)

Open a follow-up PR against `gao-core/gao-id-worker-ops`:

- Update `wrangler.prod.template.toml`:
  - `GAO_DOMAIN_ESCROW_ADDRESS = "<V3_ADDRESS>"` (replace
    placeholder).
  - `GAO_TREASURY_ADDRESS = "<TREASURY_ADDRESS>"` (replace
    placeholder).
  - Leave `BASE_RPC_URL` and `BASE_ANCHOR_CONTRACT_ADDRESS` as
    `wrangler secret put` slots — they are still secret-pipe.
- Update `docs/product-resource-inventory.md` §8 — replace
  `<PASTE…>` with the deployed addresses.

The operator then runs (on the **product machine**, not the dev
machine):

```sh
# Product machine — operator only.
npx wrangler secret put GAO_DOMAIN_ESCROW_ADDRESS --env prod
# (paste V3_ADDRESS)

npx wrangler secret put GAO_TREASURY_ADDRESS --env prod
# (paste TREASURY_ADDRESS)

npx wrangler secret put BASE_RPC_URL --env prod
# (paste the private Base mainnet RPC URL with embedded API key)

npx wrangler secret put BASE_ANCHOR_CONTRACT_ADDRESS --env prod
# (paste ANCHOR_ADDRESS)

npx wrangler secret put GAO_RPC_URL --env prod
# (paste the private Base mainnet RPC URL — may equal BASE_RPC_URL)

# … plus all other secrets in
# gao-id-worker-ops/docs/secret-names-checklist.md §1.

npx wrangler deploy --env prod
```

These wrangler steps live in the gao-id-worker-ops runbook
(`docs/product-machine-runbook.md`); they are reproduced here
only as a cross-reference. **Do NOT run wrangler secret put on
the dev machine.**

---

## 12. BE smoke (after wrangler deploy)

From any machine (these endpoints are public):

```sh
curl -sS https://id.gao.global/v2/contracts/config | jq
# Expect: {"chainId": 8453, "networkName": "Base", "escrowAddress": "<V3>", ...}

curl -sS https://id.gao.global/v2/contracts/health | jq
# Expect: {"healthy": true, "reasons": []}

curl -sS https://id.gao.global/v2/contracts/anchors/health | jq
# Expect: {"healthy": true, "chains": [{"key":"base","healthy":true,...}]}
```

All three must return `healthy: true` before opening user
purchase / user self-anchor on `gao.domains`.

---

## 13. Rollback / kill-switch

### V3 escrow

`GaoDomainDepositV3.pause()` halts new deposits (`deposit` reverts
`EnforcedPause`). `settle` / `refund` / `withdrawTreasury` remain
operational so in-flight deposits can wind down and treasury can
drain during an incident. `withdrawAffiliateFor` is also pause-
gated.

To pause:

```solidity
// From the owner Safe / multisig:
GaoDomainDepositV3(<V3_ADDRESS>).pause()
```

To unpause:

```solidity
GaoDomainDepositV3(<V3_ADDRESS>).unpause()
```

### Anchor

`GaoDomainAnchor` has no owner and no pause. There is no on-chain
kill-switch. If a bug is discovered:

- The BE simply stops accepting submitted txHashes from the
  affected anchor address (BE-side mitigation, not on-chain).
- A new `GaoDomainAnchor` is deployed at a new address and
  `BASE_ANCHOR_CONTRACT_ADDRESS` is re-pointed in the worker
  config.
- The old contract's events remain readable but the BE ignores
  them.

---

## 14. Operator non-goals (NOT performed by this runbook)

- ❌ Backend signer / HSM / KMS / MPC wiring (B2, deferred).
- ❌ Treasury sweep automation (B2, deferred).
- ❌ On-chain refund automation (B2, deferred).
- ❌ Affiliate cash payout automation (B2, deferred).
- ❌ Mirror of `gao-signer-skeleton` to `gao-core` (B10, blocked
  on B2).
- ❌ Sovereign gateway prod (B11, needs decision).
- ❌ V2 migration drain (no Base mainnet V2 exists; mainnet V3
  is the first canonical escrow).

These are tracked in
`gao-id-worker-ops/docs/go-live-blockers.md` and are NOT gated by
the B4 ceremony for product v1 launch.

---

## 15. Agent rules of engagement

- Agents MAY review this runbook.
- Agents MAY draft updates to this runbook in a PR.
- Agents MUST NOT execute any step in §4 (preflight), §5–§9
  (broadcast), §11 (wrangler secret put), or §12 (BE smoke).
- Agents MUST NOT read `.env`, MUST NOT echo any value of
  `DEPLOYER_PRIVATE_KEY` / `BASE_RPC_URL` / `BASESCAN_API_KEY` /
  `BASE_ANCHOR_CONTRACT_ADDRESS` (the last is a secret-pipe).
- Agents MAY derive the deployer PUBLIC address from
  `DEPLOYER_PRIVATE_KEY` only when explicitly instructed by the
  operator AND the output is the public address only.
- See `CLAUDE.md` §2 (deployment safety) and §4 (agent secret-
  handling) for the full rules.
