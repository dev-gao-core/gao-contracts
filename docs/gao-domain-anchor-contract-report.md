# GaoDomainAnchor Contract Report

## Summary

| Field | Value |
|---|---|
| Contract | `GaoDomainAnchor` ([contracts/GaoDomainAnchor.sol](../contracts/GaoDomainAnchor.sol)) |
| Solidity | 0.8.24 (matches existing `GaoDomainDeposit`) |
| Framework | Hardhat (matches repo convention) |
| Chain target | Base Sepolia (`baseSepolia`, chainId 84532) — primary; Base mainnet via `--network base` (owner-approved only) |
| Deployment status | **Not deployed in this PR.** Deploy script ready; owner runs `npm run deploy-anchor:base-sepolia` (see § Deployment) |
| Tests | **17/17 pass** for `GaoDomainAnchor.test.ts`; **46/46 full suite** (zero regression to `GaoDomainDeposit`) |
| Branch / PR | `feat/gao-domain-anchor-contract` |

## Why Separate From Payment Contract

`GaoDomainDeposit` is the canonical payment / escrow / settlement contract — it custodies ERC-20 funds, has `Ownable + Pausable + ReentrancyGuard`, holds an allowlisted token list, and exposes a treasury-withdraw path. It carries real custody risk and a wider audit surface.

`GaoDomainAnchor` is the opposite: a deliberately boring append-only proof/log contract. Splitting it out gives us:

- **No custody.** Anchor never holds tokens, so a bug here cannot leak funds.
- **Lower blast radius.** A buggy anchor leaves a wrong public log entry the backend ignores; nothing at risk besides anchor confusion.
- **Smaller audit surface.** ~50 lines of effective Solidity, three external functions, three events, three storage slots, five custom errors — a reviewer can read it in one sitting.
- **Independent lifecycle.** The payment contract upgrades / fixes are gated by treasury concerns; the anchor contract upgrades are gated only by anchor consumers (the worker). Decoupling lets each contract evolve on its own cadence.
- **No dependency.** Anchor never imports / calls / references the payment contract. They share an env var only at deploy time (RPC URL + deployer key).

If a future ticket needs to anchor _payment receipts_ on-chain, the right shape is to call `GaoDomainAnchor.anchorSnapshot(...)` from a settlement reconciler — NOT to extend the payment contract with anchor logic.

## Functions

| Function | Purpose |
|---|---|
| `anchorDomain(bytes32 domainHash, bytes32 payloadHash)` | Anchor a domain ownership / purchase payload hash (`anchorType: domain_purchase` or `domain_ownership_snapshot` from the worker). |
| `anchorSnapshot(bytes32 snapshotId, bytes32 merkleRoot, bytes32 payloadHash)` | Anchor a typed snapshot keyed by `snapshotId` (mapping snapshots, ownership snapshots, future read-model snapshots). |
| `anchorMapping(bytes32 domainHash, bytes32 mappingsHash)` | Anchor the canonical hash of a domain's verified + default wallet mappings. |

All three are public, non-payable, non-mutating on caller funds, and emit one event each.

## Events

| Event | Purpose |
|---|---|
| `DomainAnchored(domainHash, payloadHash, anchorer, timestamp)` | Indexed by `(domainHash, payloadHash, anchorer)` so the worker can `eth_getLogs` filter cheaply. |
| `SnapshotAnchored(snapshotId, merkleRoot, payloadHash, anchorer, timestamp)` | Indexed by `(snapshotId, merkleRoot, anchorer)`. `payloadHash` non-indexed (already known to the backend from the anchor-job row, would just waste a topic slot). |
| `MappingAnchored(domainHash, mappingsHash, anchorer, timestamp)` | Indexed by `(domainHash, mappingsHash, anchorer)`. |

The events are the **primary immutable audit log**. The on-chain storage (next section) is convenience-only.

## Storage

| Mapping | Purpose |
|---|---|
| `mapping(bytes32 => bytes32) public latestDomainPayloadHash` | Last `payloadHash` anchored under each `domainHash` via `anchorDomain`. Single-SLOAD answer to "what's the latest committed domain hash for X". |
| `mapping(bytes32 => bytes32) public latestSnapshotPayloadHash` | Same for snapshots, keyed by `snapshotId`. |
| `mapping(bytes32 => bytes32) public latestMappingHash` | Same for mappings. |

**Important caveat** (also in the contract NatSpec): anchoring is public. Any address can overwrite the latest-hash mapping for any key. The backend MUST NOT treat these reads as authoritative on their own. The authoritative answer is "the latest event whose `anchorer` matches the expected gao-id-worker signer / dapp wallet AND whose `payloadHash` matches the worker's recomputed canonical hash".

The latest-hash mappings exist only as a convenience for clients that want a fast "is this domain anchored at all" check without an event scan.

## Validation

| Check | Custom error |
|---|---|
| `domainHash != 0` (anchorDomain, anchorMapping) | `ZeroDomainHash()` |
| `payloadHash != 0` (anchorDomain, anchorSnapshot) | `ZeroPayloadHash()` |
| `snapshotId != 0` (anchorSnapshot) | `ZeroSnapshotId()` |
| `merkleRoot != 0` (anchorSnapshot) | `ZeroMerkleRoot()` |
| `mappingsHash != 0` (anchorMapping) | `ZeroMappingsHash()` |

Custom errors (instead of `require(_, "msg")`) keep revert payloads small and let the worker decode them strictly.

## Security Notes

| Property | Status |
|---|---|
| **No token custody** | ✅ no `IERC20`, no balances, no payable surface |
| **No payable** | ✅ no `receive()`, no `fallback()`, no `payable` modifiers; raw ETH transfers revert (test 15) |
| **No external calls** | ✅ contract makes zero calls to other contracts; no oracles, no `transfer/call/delegatecall` |
| **No upgradeability** | ✅ plain contract, no proxy pattern; deployment address is permanent |
| **No owner / no access control** | ✅ public anchoring is intentional (rationale below) |
| **No private keys / no signer** | ✅ contract holds no keys; deployer key is owner-controlled |
| **No dependency on payment contract** | ✅ no imports, no addresses, no shared state |
| **Boring + audit-friendly** | ✅ ~140 lines including comments; trivially reviewable |

### Public anchoring rationale

The contract permits any address to call any anchor method. This is safe because:

1. The on-chain **events** are the audit log, not the storage.
2. The backend (gao-id-worker) verifies _which_ event is authoritative by matching `(anchorer, payloadHash)` against the off-chain anchor-job row. A spurious anchor by a third party leaves a stray log entry the backend ignores — it doesn't change anything the backend trusts.
3. Adding owner-only access would force the gao-id-worker to either (a) hold a hot signer key on Cloudflare Workers (security regression) or (b) gate every anchor through a relayer (latency + complexity), neither of which buys anything the off-chain verification doesn't already give us.

If a future ticket decides public anchoring is unacceptable, the contract is small enough that swapping in `Ownable` is a one-PR change — but it's NOT the right default today.

### Backend verification expectations

When the worker reconciles an anchor job (`POST /v2/me/domains/:d/anchor/:id/reconcile`), it MUST:

1. Use the configured `<KEY>_RPC_URL` to fetch the tx receipt for the stored `txHash`.
2. Decode the receipt's logs using the ABI exported here.
3. Match a single `DomainAnchored` / `SnapshotAnchored` / `MappingAnchored` event against the expected `(domainHash | snapshotId, payloadHash | mappingsHash, anchorer)` tuple from the anchor-job row.
4. Only flip status to `confirmed` when (a) the receipt status is success, AND (b) at least one matching event is present, AND (c) the event's `anchorer` is in the expected set (e.g. the user's wallet from the anchor-job's `owner_address`).
5. Otherwise: `failed` (revert) / `pending` (no receipt) / `rpc_not_configured` (no env).

This is the same shape the worker already uses for `escrow.adapter.verifyDepositTx` — see `gao-id-worker/src/contracts/escrow.adapter.ts` for the pattern.

## Tests

```bash
$ npx hardhat test test/GaoDomainAnchor.test.ts
  GaoDomainAnchor
    anchorDomain
      ✔ emits DomainAnchored with the correct fields (1)
      ✔ updates latestDomainPayloadHash to the supplied hash (2)
      ✔ rejects zero domainHash with ZeroDomainHash (3)
      ✔ rejects zero payloadHash with ZeroPayloadHash (4)
    anchorSnapshot
      ✔ emits SnapshotAnchored with the correct fields (5)
      ✔ updates latestSnapshotPayloadHash (6)
      ✔ rejects zero snapshotId (7)
      ✔ rejects zero merkleRoot (8)
      ✔ rejects zero payloadHash (9)
    anchorMapping
      ✔ emits MappingAnchored with the correct fields (10)
      ✔ updates latestMappingHash (11)
      ✔ rejects zero domainHash (12)
      ✔ rejects zero mappingsHash (13)
    multi-anchor / log retention
      ✔ overwrites latest storage but every event remains (14)
      ✔ does not collide across distinct domains
    no payable surface (15)
      ✔ rejects raw ETH sent to the contract
      ✔ anchor methods are not payable

  17 passing (617ms)

$ npm test                       # full suite (existing GaoDomainDeposit + new GaoDomainAnchor)
  46 passing (854ms)
```

All 17 cases from the contract spec pass. Existing 29 `GaoDomainDeposit` tests pass unchanged — zero regression.

## Deployment

**Not deployed in this PR.** The script + ABI export are wired up; owner runs the deploy in a controlled window.

### Exact command for Base Sepolia

```bash
cd /path/to/gao-contracts

# Required env (already set in .env.example, owner fills .env):
#   DEPLOYER_PRIVATE_KEY     EOA that signs the deploy. No owner to
#                            transfer post-deploy — the contract has
#                            no access control.
#   BASE_SEPOLIA_RPC_URL     RPC endpoint (private with API key).
# Optional:
#   BASESCAN_API_KEY         Used by `npm run verify:base-sepolia` after
#                            deploy.

npm install
npm test                              # confirm 46/46 still passing
npm run deploy-anchor:base-sepolia    # deploys + writes abis/ + deployments/
```

The script writes (post-deploy):

- `abis/GaoDomainAnchor.json` — ABI for the worker to consume (already in repo from this PR's compile; deploy refreshes it).
- `deployments/base-sepolia/GaoDomainAnchor.json` — chain-scoped deployment record (`address`, `txHash`, `chainId: 84532`, `deployedAt`, `workerEnvVar: "BASE_SEPOLIA_ANCHOR_CONTRACT_ADDRESS"`).

It also prints the env-var line the worker needs:

```
BASE_SEPOLIA_ANCHOR_CONTRACT_ADDRESS=0x...
```

### Verify (optional)

```bash
npm run verify:base-sepolia -- 0x<deployed_address>
```

(No constructor args — verification just needs the address.)

### Mainnet — owner-approved only

```bash
# DO NOT RUN without explicit operator approval.
npm run deploy-anchor:base
# → writes deployments/base/GaoDomainAnchor.json
# → prints BASE_ANCHOR_CONTRACT_ADDRESS=0x...
```

## Next Step

Once Base Sepolia deploy lands and the address is captured:

1. **Add the ABI to `gao-id-worker`.** Copy `abis/GaoDomainAnchor.json` to `gao-id-worker/src/contracts/anchor.abi.ts` (matching the existing `escrow.abi.ts` shape: `export const GAO_DOMAIN_ANCHOR_ABI = [...] as const;`).
2. **Set the worker env vars** via `wrangler secret put`:
   ```
   BASE_SEPOLIA_ANCHOR_CONTRACT_ADDRESS=0x...
   BASE_SEPOLIA_RPC_URL=<rpc>
   ANCHOR_PRIMARY_CHAIN=base-sepolia
   ANCHOR_ALLOWED_CHAINS=base-sepolia,base
   ```
3. **Build the calldata builder in `gao-id-worker/src/lib/onchain-anchor.ts`.** Wire `prepareDomainAnchor` to populate a new `calldata` field using the imported ABI — and flip the `requiresContractAbi: true` flag in `me-v2-anchor-handlers.ts:74` to `false`. This is a small follow-up PR in the worker repo (1 file change to `me-v2-anchor-handlers.ts` + 1 new ABI file + 1 lib edit + 1 test).
4. **End-to-end smoke test on `id-test.gao.domains`:**
   - `POST /v2/me/domains/:d/anchor/prepare` → expect `calldata: "0x..."` populated, `requiresContractAbi: false`.
   - dapp / mobile builds + signs tx using the calldata, broadcasts.
   - `POST /v2/me/domains/:d/anchor/:id/submit { txHash, chain: "base-sepolia" }`.
   - `POST /v2/me/domains/:d/anchor/:id/reconcile` → expect `verdict: "confirmed"` after a few blocks.

That follow-up belongs in `gao-id-worker`, not this repo. This PR's scope is **contract + tests + ABI + deploy script + report only**.
