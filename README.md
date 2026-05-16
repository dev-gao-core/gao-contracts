# gao-contracts

Solidity contracts for the Gao platform. Companion repo to
[`dev-gao-core/gao-id-worker`](https://github.com/dev-gao-core/gao-id-worker)
(identity / payment backend) and `test.gao.domains` (frontend UI).

```
gao-contracts/
├── contracts/
│   ├── GaoDomainDepositV3.sol      # canonical .gao domain payment escrow
│   ├── GaoDomainDepositV2.sol      # superseded by V3; kept for ABI
│   │                                 compatibility tests + the V2 → V3
│   │                                 migration analysis
│   ├── GaoDomainAnchor.sol         # cross-chain ownership anchor
│   └── test/MockERC20.sol          # test-only ERC20 stand-in (not deployed)
├── scripts/
│   ├── deployGaoDomainDepositV3.devtest.ts  # dev/test V3 deploy
│   │                                          (chain-allowlist + mainnet ban +
│   │                                          CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3=true gate)
│   ├── smokeGaoDomainDepositV3.devtest.ts   # hardhat in-memory V3 smoke
│   ├── deployGaoDomainAnchor.ts             # anchor deploy
│   ├── reverifyV3.ts                        # Basescan re-verify helper
│   └── deploy-domain-deposit-v2.ts          # legacy V2 deploy (kept for
│                                              migration tooling only)
├── test/                                     # hardhat + mocha tests
├── deployments/devtest/baseSepolia/          # V3 dev/test deployment record
├── hardhat.config.ts
└── package.json
```

## Canonical contract: GaoDomainDepositV3

**V3 is the canonical escrow.** The dev/test deployment on Base Sepolia
lives at:

```
0xf2e3db266d631193836351809ea584ff1fee3604
```

V3 hardens V2 with a public-self-withdraw lock (affiliate funds can
only exit via the owner-driven, pausable `withdrawAffiliateFor`) and a
pausable affiliate payout path. See
[`docs/security/affiliate-onchain-withdraw-lock.md`](docs/security/affiliate-onchain-withdraw-lock.md)
for the V2 → V3 analysis and
[`docs/runbooks/v2-to-v3-escrow-migration.md`](docs/runbooks/v2-to-v3-escrow-migration.md)
for the migration ceremony.

V1 (`GaoDomainDeposit`) and its deploy entrypoint have been **removed**
from this repo. V2 source is retained only because V3's ABI
compatibility tests reference it.

## Wire compatibility (DO NOT BREAK)

The contract's external surface MUST match the gao-id-worker adapter
[`src/contracts/escrow.abi.ts`](https://github.com/dev-gao-core/gao-id-worker/blob/main/src/contracts/escrow.abi.ts).
The three money-movement selectors the BE signer relies on:

| Selector | Function |
|---|---|
| `0xacd28cc5` | `settle(bytes32,address,uint256)` |
| `0x0d86419a` | `withdrawTreasury(address,uint256)` |
| `0x9a4b4d4b` | `withdrawAffiliateFor(address,address,uint256)` |

Event signatures (V3):

- `Deposited(bytes32 indexed invoiceId, address indexed payer, address indexed buyer, bytes32 domainHash, address paymentToken, uint256 grossAmount)`
- `Settled(bytes32 indexed invoiceId, address indexed paymentToken, uint256 treasuryAmount, address indexed affiliate, uint256 affiliateAmount)`
- `Refunded(bytes32 indexed invoiceId, address indexed payer, address indexed token, uint256 grossAmount)` — **3 indexed args**
- `TreasuryWithdrawn(address indexed token, address indexed treasury, uint256 amount)`
- `AffiliateWithdrawn(address indexed affiliate, address indexed token, uint256 amount, address caller)`

Any change to those signatures / topics / enum ordering needs a
coordinated worker + frontend release.

## Setup

```bash
git clone git@github.com:dev-gao-core/gao-contracts.git
cd gao-contracts
cp .env.example .env       # fill in values — never commit .env
npm install
npx hardhat compile
npx hardhat test
```

Disk note: `npm install` pulls Hardhat + OpenZeppelin and is
~100–200 MB.

## Deploy — V3 dev/test (Base Sepolia)

The dev/test deploy is driven by
[`scripts/deployGaoDomainDepositV3.devtest.ts`](scripts/deployGaoDomainDepositV3.devtest.ts).
The script enforces a chain-id allowlist + mainnet banlist and refuses
to broadcast unless `CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3=true` is set.

1. Provision a fresh deploy EOA. Send it ~0.01 Base Sepolia ETH for gas.
2. Fill `.env`:
   ```
   DEPLOYER_PRIVATE_KEY=<the EOA's hex key, NEVER commit>
   BASE_SEPOLIA_RPC_URL=<private RPC with API key>
   GAO_OWNER_ADDRESS=<multisig address — defaults to deployer if unset>
   GAO_TREASURY_ADDRESS=<treasury wallet — required non-zero>
   GAO_USDC_ADDRESS=0x036cbd53842c5426634e7929541ec2318f3dcf7e   # Base Sepolia USDC
   BASESCAN_API_KEY=<your Etherscan key, optional>
   ```
3. Dry-run first (default — no broadcast):
   ```bash
   npx hardhat run scripts/deployGaoDomainDepositV3.devtest.ts --network baseSepolia
   ```
4. Real deploy (operator-acknowledged):
   ```bash
   CONFIRM_DEPLOY_DOMAIN_DEPOSIT_V3=true \
     npx hardhat run scripts/deployGaoDomainDepositV3.devtest.ts --network baseSepolia
   ```
5. The script writes
   `deployments/devtest/baseSepolia/GaoDomainDepositV3.json` and prints
   the contract address.
6. Wire into the worker (run from a `gao-id-worker` checkout):
   ```bash
   npx wrangler secret put GAO_DOMAIN_ESCROW_ADDRESS
   npx wrangler secret put GAO_USDC_ADDRESS
   npx wrangler deploy
   ```
7. Smoke test:
   ```bash
   curl https://id-test.gao.domains/v2/contracts/health
   # Expect:  "healthy": true
   #          "contracts.escrow.hasBytecode": true
   #          "contracts.usdc.symbol": "USDC"
   ```
8. (Optional) Verify on Basescan:
   ```bash
   npm run verify:base-sepolia <ESCROW_ADDRESS> <INITIAL_OWNER> <INITIAL_TREASURY>
   ```

## Deploy — production / mainnet

**Production deploy does NOT live in this repo.** The production
ceremony (HSM / KMS / MPC / vendor signer + multisig owner) lives in
a separate operator-only repository. This repo intentionally:

- exposes no `deploy:base` / `deploy:base-mainnet` npm script,
- has no production-tier config file,
- and refuses to broadcast on any of the canonical mainnets
  (Ethereum 1, Base 8453, Optimism 10, Polygon 137, Arbitrum 42161,
  BNB 56, Avalanche 43114) from `scripts/deployGaoDomainDepositV3.devtest.ts`.

The legacy V1 deploy script (`scripts/deploy.ts`) and its
`deploy:base` / `deploy:base-sepolia` npm wrappers have been
**removed** entirely — they targeted the now-retired V1 contract and
had no chain-id allowlist. A regression test in
[`test/guardrails/legacy-v1-deploy-guardrail.test.ts`](test/guardrails/legacy-v1-deploy-guardrail.test.ts)
locks the absence in.

USDC reference values:

- Base Sepolia: `0x036cbd53842c5426634e7929541ec2318f3dcf7e`
- Base mainnet: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (informational
  only — never deployed against from this repo)

## Operating

After deploy, the V3 owner (multisig in production; dev EOA in
dev/test) holds these powers:

- `setAllowedToken(token, allowed)` — toggle ERC-20s accepted by `deposit()`.
- `setTreasury(newTreasury)` — change the wallet that receives `withdrawTreasury` sweeps.
- `settle(invoiceId, affiliate, affiliateAmount)` — flip DEPOSITED → SETTLED;
  splits gross into treasury + affiliate buckets atomically.
- `refund(invoiceId)` — return funds to the original payer (permitted
  only while status = DEPOSITED).
- `withdrawTreasury(token, amount)` — sweep the settled treasury
  bucket to `treasury`. **Not pausable** (per V3 spec, so the
  operator can drain during an incident).
- `withdrawAffiliateFor(affiliate, token, amount)` — pay an affiliate
  out of their accrued balance. **Pausable**.
- `rescueExcessToken(token, to, amount)` — release tokens that
  arrived outside a tracked deposit. Bounded by `excessBalance(token)`.
- `pause()` / `unpause()` — block new deposits AND `withdrawAffiliateFor`.
  `settle` / `refund` / `withdrawTreasury` remain available while paused.

`withdrawAffiliate(token, amount)` (the V2 self-service selector)
**always reverts** with `AffiliateSelfWithdrawDisabled` on V3 — the
selector is preserved so legacy clients targeting the V2 ABI receive
a clear, decode-able revert instead of a generic
"function not found" path.

## Security checklist before production deploy

This repo is dev/test only. Before production deploy from the private
ops repo:

- [ ] V3 contract source matches the deployed bytecode byte-for-byte.
- [ ] Owner is a Safe multisig with quorum ≥ 2 — `transferOwnership`
      executed **before** routing any real funds.
- [ ] `treasury()` is the production revenue wallet, distinct from
      the deployer EOA.
- [ ] USDC address is the canonical USDC on the target chain.
- [ ] No other tokens are allow-listed.
- [ ] Production RPC URL is a private endpoint, not a public RPC.
- [ ] Production deployer custody is HSM / KMS / MPC / vendor signer —
      NEVER a repo-local `.env` private key.
- [ ] Etherscan source is verified.
- [ ] Worker secrets `GAO_DOMAIN_ESCROW_ADDRESS` + `GAO_USDC_ADDRESS`
      match the deployed values bit-for-bit.
- [ ] `GET /v2/contracts/health` returns `healthy: true` against the
      production worker.
- [ ] One end-to-end checkout → deposit → settle → withdrawTreasury
      dry run is executed on Base Sepolia before mainnet rollout.

## Test status

`npx hardhat test` covers V3, V2 (legacy), the Anchor contract, and
the agent-secret-handling + legacy-deploy guardrails.
