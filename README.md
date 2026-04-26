# gao-contracts

Solidity contracts for the Gao platform. Companion repo to
[`dev-gao-core/gao-id-worker`](https://github.com/dev-gao-core/gao-id-worker)
(identity / payment backend) and `test.gao.domains` (frontend UI).

```
gao-contracts/
├── contracts/
│   ├── GaoDomainDeposit.sol       # canonical .gao domain payment escrow
│   └── test/MockERC20.sol         # test-only USDC stand-in (not deployed)
├── scripts/deploy.ts              # deploy + optional USDC allowlist
├── test/GaoDomainDeposit.test.ts  # 16 unit tests
├── hardhat.config.ts
├── package.json
├── tsconfig.json
├── .env.example
└── .gitignore
```

## Wire compatibility (DO NOT BREAK)

The contract's external surface MUST match the gao-id-worker adapter
[`src/contracts/escrow.abi.ts`](https://github.com/dev-gao-core/gao-id-worker/blob/main/src/contracts/escrow.abi.ts):

- `deposit(address buyer, bytes32 invoiceId, bytes32 domainHash, address token, uint256 amount)`
- `getDeposit(bytes32 invoiceId)` returns 9-field tuple
- `isPending(bytes32 invoiceId) returns (bool)`
- `event Deposited(bytes32 indexed invoiceId, address indexed buyer, bytes32 indexed domainHash, address paymentToken, uint256 amount, address payer)`
- `enum Status { NONE=0, DEPOSITED=1, SETTLED=2, REFUNDED=3 }`

Any change to those names / signatures / event topic / enum ordering
needs a coordinated worker + frontend release.

## Setup

```bash
git clone git@github.com:dev-gao-core/gao-contracts.git
cd gao-contracts
cp .env.example .env       # fill in values — never commit .env
npm install
npx hardhat compile
npx hardhat test
```

Disk note: the `npm install` pulls Hardhat + OpenZeppelin and is
~100–200 MB.

## Deploy — Base Sepolia (test)

1. Provision a fresh deploy EOA. Send it ~0.01 Base Sepolia ETH for gas.
2. Fill `.env`:
   ```
   DEPLOYER_PRIVATE_KEY=<the EOA's hex key, NEVER commit>
   BASE_SEPOLIA_RPC_URL=<private RPC with API key>
   GAO_OWNER_ADDRESS=<multisig address — defaults to deployer if unset>
   GAO_USDC_ADDRESS=0x036cbd53842c5426634e7929541ec2318f3dcf7e   # Base Sepolia USDC
   BASESCAN_API_KEY=<your Etherscan key, optional>
   ```
3. Deploy:
   ```bash
   npm run deploy:base-sepolia
   ```
4. The script prints:
   ```
   GAO_DOMAIN_ESCROW_ADDRESS=0x<address>
   GAO_USDC_ADDRESS=0x036cbd…
   ```
5. Wire into the worker (run from a `gao-id-worker` checkout):
   ```bash
   npx wrangler secret put GAO_DOMAIN_ESCROW_ADDRESS
   npx wrangler secret put GAO_USDC_ADDRESS
   npx wrangler deploy
   ```
6. Smoke test:
   ```bash
   curl https://api-test.gao.domains/v2/contracts/health
   # Expect:  "healthy": true
   #          "contracts.escrow.hasBytecode": true
   #          "contracts.usdc.symbol": "USDC"
   ```
7. (Optional) Verify on Basescan:
   ```bash
   npm run verify:base-sepolia <ESCROW_ADDRESS> <INITIAL_OWNER>
   ```

## Deploy — Base mainnet

Same as Base Sepolia but with `BASE_RPC_URL` set and
`npm run deploy:base`. Production deploys MUST set `GAO_OWNER_ADDRESS`
to a Safe multisig — the deployer is never the long-term owner.

USDC on Base mainnet: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

## Operating

After deploy, the multisig (or owner EOA in dev) holds these powers:

- `setAllowedToken(token, allowed)` — toggle ERC-20s accepted by `deposit()`.
- `settle(invoiceId)` — flip a DEPOSITED row to SETTLED. The off-chain
  worker calls this through its own admin tooling once it has written
  the canonical billing PAID row + identity_domains link.
- `refund(invoiceId)` — return funds to the original payer. Permitted
  only while status = DEPOSITED.
- `pause()` / `unpause()` — block new deposits during an incident.
  Settle / refund still function while paused.

The contract intentionally does **not** include a treasury sweep
function. Funds remain in the contract after `settle()`. A future
revision may add `sweep(token, to)` once a treasury policy is set —
that change is non-breaking for the worker (which only consumes the
`Deposited` event for verification).

## Security checklist before mainnet

- [ ] Deployer EOA private key is rotated post-deploy and never reused.
- [ ] `GAO_OWNER_ADDRESS` is a Safe multisig with a quorum of ≥2.
- [ ] USDC address is the **canonical** USDC on the target chain
      (Base Sepolia: `0x036cbd…`, Base mainnet: `0x833589…`).
- [ ] No other tokens are allow-listed.
- [ ] `BASE_RPC_URL` is a private endpoint, not a public RPC.
- [ ] `.env` is gitignored and the deployer machine has secret-store
      backed key access (1Password CLI, AWS KMS, hardware wallet, …).
- [ ] Etherscan source is verified.
- [ ] Worker secrets `GAO_DOMAIN_ESCROW_ADDRESS` + `GAO_USDC_ADDRESS`
      match the deployed values bit-for-bit.
- [ ] `GET /v2/contracts/health` returns `healthy: true` against the
      deployed worker.
- [ ] One end-to-end checkout intent + deposit + settle dry run is
      executed on Base Sepolia before mainnet rollout.

## Test status

`npx hardhat test` — 16 passing.

Coverage:
- happy path: deposit + Deposited event + balances
- payer ≠ buyer (gift / sponsor)
- validation: zero buyer / domainHash / amount / invoiceId, disallowed token, duplicate invoiceId
- read paths: `isPending`, `getDeposit` 9-field tuple
- admin: `settle` / `refund` / `setAllowedToken` / `pause` / `unpause` (all owner-only)
- state machine: cannot refund SETTLED, cannot settle REFUNDED, cannot settle non-DEPOSITED
- pause blocks new deposits but settle/refund remain available
