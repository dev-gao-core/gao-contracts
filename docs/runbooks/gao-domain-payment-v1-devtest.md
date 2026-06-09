# GaoDomainPaymentV1 — dev/test runbook (DRAFT)

> **Status: DRAFT — dev/test only.** This document covers the dev/test
> build + local verification of `GaoDomainPaymentV1`. It is NOT a mainnet
> ceremony. The Base mainnet (B4) deploy of this contract is operator-only
> and will live in a separate `scripts/mainnet/` script + runbook added in
> a later, reviewed step. No mainnet broadcast is performed by anything in
> this PR.

## 1. What this contract is

`GaoDomainPaymentV1` replaces the `GaoDomainDepositV3` escrow/settle launch
path with a **custody-free, direct-to-treasury** payment + on-chain
evidence model:

- The buyer pays an allowlisted ERC-20 (USDC in v1). The contract forwards
  it to the **Gao Treasury** in the **same transaction** via
  `SafeERC20.safeTransferFrom(buyer -> treasury)`.
- The contract **never holds user funds** — no escrow balance, no
  `settle`, no `withdrawTreasury`, no affiliate ledger. Therefore there is
  **no backend signer / owner key in the purchase path**.
- Each purchase emits one `DomainPurchased` event = the canonical on-chain
  purchase evidence.

### v1 invariants (locked product decisions)

- `payer == owner`: `msg.sender` is both the payer and the domain owner.
  `payForDomain` takes no separate `owner` parameter.
- No on-chain owner mapping. **D1 / resolver is the source of truth** for
  active ownership; the event log + the pre-pinned IPFS profile are the
  immutable evidence.
- Pricing is **not** enforced on-chain (the backend verifies `amount`
  against the quoted invoice). The contract only requires `amount > 0`.
- Refunds and affiliate payouts are **manual / off-chain** from the
  Treasury. There is no on-chain refund or affiliate surface.
- Governance owner = **Safe 2/3** (its only powers: allowlist, treasury,
  pause, stray-token rescue — none can move a user payment or drain the
  treasury).

## 2. Contract surface

| Kind | Signature |
|---|---|
| ctor | `constructor(address initialOwner, address initialTreasury)` |
| user | `payForDomain(bytes32 invoiceId, bytes32 domainHash, string domainName, address token, uint256 amount, string profileURI, bytes32 profileHash)` |
| owner | `setAllowedToken(address token, bool allowed)` |
| owner | `setTreasury(address newTreasury)` |
| owner | `pause()` / `unpause()` |
| owner | `rescueToken(address token, address to, uint256 amount)` |
| view | `treasury()`, `allowedTokens(address)`, `invoicePaid(bytes32)`, `owner()`, `paused()` |

`payForDomain` enforces: non-zero `invoiceId` / `domainHash` / `profileHash`,
non-empty `domainName` / `profileURI`, `amount > 0`, `token` on the
allowlist, `invoiceId` not already paid, and
`keccak256(bytes(domainName)) == domainHash` (the plaintext log cannot
disagree with the indexed hash). Callers MUST pass the already-normalised
(lowercased) handle — the backend computes `domainHash` as
`keccak256(toBytes(domainName.toLowerCase()))`.

## 3. Event signature (pin this in the BE)

```
DomainPurchased(bytes32,address,bytes32,address,string,address,uint256,address,string,bytes32,uint256)
topic0 = 0xa34f1eb416ff3baa71e44f44a96b752df47a5f11d09f9265164b4c5d87cabe10
indexed: invoiceId, payer, domainHash
fields:  invoiceId, payer, domainHash, owner, domainName, token, amount,
         treasury, profileURI, profileHash, timestamp
```

`owner == payer` in v1; both are emitted so the schema is stable if a
future version decouples them. The committed ABI is
`abis/GaoDomainPaymentV1.json`.

## 4. Local build + test (this is the whole dev step)

```sh
cd gao-contracts          # dev-gao-core checkout
npx hardhat compile
npx hardhat test test/GaoDomainPaymentV1.test.ts   # 25 tests
npx hardhat test                                   # full suite (no regressions)
```

## 5. Dev/test deploy (dry-run guarded) — NOT run in the build step

The deploy script refuses every mainnet chainId (Base 8453, Ethereum 1,
etc.) and is dry-run by default. It mirrors
`scripts/deployGaoDomainDepositV3.devtest.ts`.

```sh
# dry-run on Base Sepolia (prints what it would do, sends nothing)
GAO_TREASURY_ADDRESS=0x... \
GAO_USDC_ADDRESS=0x... \
  npx hardhat run scripts/deployGaoDomainPaymentV1.devtest.ts --network baseSepolia

# real dev/test deploy (operator-driven, NOT part of the build step)
CONFIRM_DEPLOY_PAYMENT_V1=true \
GAO_OWNER_ADDRESS=0x... \
GAO_TREASURY_ADDRESS=0x... \
GAO_USDC_ADDRESS=0x... \
  npx hardhat run scripts/deployGaoDomainPaymentV1.devtest.ts --network baseSepolia
```

When the owner is a Safe, the script skips the inline `setAllowedToken`
(the deployer can't sign owner-only calls on the Safe's behalf); the Safe
must run `setAllowedToken(USDC, true)` as its first action.

## 6. Relationship to GaoDomainDepositV3 (legacy)

`GaoDomainDepositV3` and its tests remain in the repo as **legacy** — V3 is
not deployed to any mainnet, and the product launch path moves to
`GaoDomainPaymentV1`. V3 is kept for history and existing dev/test flows;
mark it deprecated in product-facing docs once the BE cuts over.

## 7. Not in scope here (later phases)

- BE integration (`gao-id-worker`): pin `DomainPurchased`, verify the
  payment tx + a matching `Transfer -> treasury` log, pre-pin the IPFS
  profile, `confirmPurchase` without on-chain settle, D1 migration. Gated
  on these contract tests passing + operator approval of the BE phase.
- Mainnet B4 ceremony (operator-only).
- `gao-core` product mirror (not yet).
- External audit (several rounds before product promotion).
