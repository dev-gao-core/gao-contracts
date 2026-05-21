# GaoSafe — Dev/Test Deploy Runbook (MS-P3.1)

> **Status:** Pre-audit. GaoSafe Genesis **targets Safe-grade core security** and is **designed toward Safe-grade security**. It is **not audited**, **not production-ready**, **not deployed to mainnet**, and **must not be used with real funds**. This runbook covers the DEV/TEST deploy on Base Sepolia only. Mainnet deploy is gated by the consuming-app production-readiness gate (`gaokey-mobile/docs/multisig/production-readiness-gate.md`) which itself depends on an external smart-contract audit. Per the MS-P3.0 plan, third-party audit is currently **deferred**; the operator runs this runbook to support TestFlight + AI audit rounds first.

This document is the operator-facing procedure for deploying `GaoSafeFactory` to Base Sepolia for dev/test use, and for running the post-deploy smoke matrix against it.

---

## 1. Purpose

The operator uses this runbook to:

1. Validate the dev/test deploy artefacts against the compiled bytecode pin (selectors, initcode hash, runtime hash).
2. Optionally broadcast `GaoSafeFactory` to Base Sepolia. The factory's constructor deploys the `GaoSafe` implementation singleton and locks it via `_initialized = true`.
3. Capture a JSON evidence record under `deployments/base-sepolia/multisig/`.
4. Run the smoke matrix (F1-F6, V1-V9, E1-E6, N1-N4, X1-X8, FC1-FC15) either ephemerally (in-memory hardhat) or live (against the deployed factory).

---

## 2. Non-goals — explicitly NOT covered

- ❌ Mainnet deploy of `GaoSafe` or `GaoSafeFactory`. Chain allowlist is hard-coded to Base Sepolia (chainId 84532) with a mainnet banlist.
- ❌ Adding a factory address to `gaokey-mobile/src/multisig/config.ts`. That is a separate, reviewer-signed-off PR after audit + production-readiness gate.
- ❌ Flipping `MULTISIG_FEATURE_ENABLED` in mobile production. Remains `false as const`.
- ❌ Touching real funds. Test wallets only on Base Sepolia.
- ❌ MPC / TSS work. Genesis is on-chain Safe-style multisig with EOA owners.
- ❌ Engaging an external audit firm. Per MS-P3.0, third-party audit is deferred until TestFlight + AI audit rounds are complete.

---

## 3. Pre-deploy checklist

### 3.1 Env variables — presence only

The deploy script logs ONLY presence (`SET`/`MISSING`), never values.

| Env name | Purpose | Required for |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | EOA that broadcasts the deploy tx (and pays gas) on Base Sepolia | live broadcast |
| `BASE_SEPOLIA_RPC_URL` | RPC endpoint for Base Sepolia (may embed API key — NEVER logged) | live broadcast |
| `CONFIRM_DEPLOY_GAOSAFE_FACTORY` | Set to literal `true` to broadcast. Otherwise dry-run. | live broadcast |

Smoke (live mode) additionally needs:

| Env name | Purpose |
|---|---|
| `CONFIRM_SMOKE_GAOSAFE` | Set to literal `true` to broadcast smoke transactions on Base Sepolia |
| `GAO_SAFE_FACTORY_LIVE_ADDRESS` | Optional. If unset, smoke reads `deployments/base-sepolia/multisig/gaosafe-factory-devtest.json` |

### 3.2 Local state pre-check

```bash
git fetch origin
git status --short                    # expect empty
git rev-parse HEAD                    # expect main tip
git branch --show-current             # expect main or your working branch
npx hardhat compile                   # expect "Nothing to compile"
npx hardhat test \
  test/multisig/GaoSafe.test.ts \
  test/multisig/GaoSafeFactory.test.ts \
  test/multisig/GaoSafe.eip712-parity.test.ts \
  test/multisig/GaoSafe.invariants.test.ts \
  test/multisig/GaoSafe.fuzz-signatures.test.ts \
  test/multisig/GaoSafeFactory.fuzz-create2.test.ts \
  test/guardrails/multisig-no-address-literals.test.ts
# expect 73 passing
```

If any of the above fails, STOP. Do not deploy.

### 3.3 ABI byte-identity check (mobile compatibility)

```bash
shasum -a 256 abis/multisig/GaoSafe.json abis/multisig/GaoSafeFactory.json
# expected:
#   ee21f7af040b2e579c7e8c2985d2e16cf51b6b84cdbd72116eda994ca13549d1  abis/multisig/GaoSafe.json
#   1af102026245f187025bc716fce033f25967fc8b8b2f6fc99886573240d8a90f  abis/multisig/GaoSafeFactory.json
```

If hashes differ, the ABI has drifted from the mobile pin. STOP and investigate before deploy.

---

## 4. Verify chainId

After running the dry-run command (§5), look for the line:

```
Network: baseSepolia (chainId 84532)  ✓ allowlist
```

If you see any other chainId, the script will abort with `REFUSED`. Do NOT attempt to bypass the chain allowlist.

The deploy script hard-codes:

- `ALLOWED_DEVTEST_CHAIN_IDS = [84532]` (Base Sepolia only)
- `BANNED_MAINNET_CHAIN_IDS = [1, 137, 42161, 10, 8453, 56]` (Ethereum, Polygon, Arbitrum, Optimism, Base, BSC mainnets)

Both gates are independent. Either alone is sufficient to abort.

---

## 5. Dry-run command

Always start with a dry-run. The dry-run writes an evidence record but broadcasts no transaction.

```bash
npx hardhat run scripts/multisig/deployGaoSafeFactory.devtest.ts \
  --network baseSepolia
```

Expected output (selected lines):

```
Env presence (values never printed):
  DEPLOYER_PRIVATE_KEY  : SET
  BASE_SEPOLIA_RPC_URL  : SET
  CONFIRM_DEPLOY_GAOSAFE_FACTORY: MISSING
Network: baseSepolia (chainId 84532)  ✓ allowlist
Solidity      : 0.8.24
Optimizer runs: 200
bytecodeHash  : ipfs
OZ contracts  : 5.6.1
Deployer addr : 0x...   (public address only)
Selector pre-check: GaoSafe (...) + Factory (...) all present ✓
Factory initcode hash: 0x...
Impl    initcode hash: 0x...

DRY-RUN. No transactions broadcast.
To broadcast (DEV/TEST ONLY on Base Sepolia), re-run with:
  CONFIRM_DEPLOY_GAOSAFE_FACTORY=true \
    npx hardhat run scripts/multisig/deployGaoSafeFactory.devtest.ts --network baseSepolia
Dry-run evidence: deployments/base-sepolia/multisig/gaosafe-factory-devtest.dry-run.json
PASS (dry-run)
```

Evidence file: `deployments/base-sepolia/multisig/gaosafe-factory-devtest.dry-run.json`.

---

## 6. Live deploy command — operator-approved only

> Only proceed after the dry-run has produced the expected output AND the operator has:
> - Verified the dry-run evidence file looks correct.
> - Confirmed the chainId is 84532.
> - Confirmed the deployer EOA on Base Sepolia has sufficient testnet ETH for the deploy (≈ 0.01 ETH headroom for safety).
> - Confirmed the deployer EOA is NOT a production custody address. Use a fresh dev/test wallet.

```bash
CONFIRM_DEPLOY_GAOSAFE_FACTORY=true \
  npx hardhat run scripts/multisig/deployGaoSafeFactory.devtest.ts \
  --network baseSepolia
```

The script will:

1. Re-validate chain allowlist + mainnet banlist + env presence.
2. Compile-time selector pre-check on `GaoSafe` and `GaoSafeFactory`.
3. Broadcast `GaoSafeFactory.deploy()` — constructor itself deploys the impl singleton.
4. Read post-deploy state: `factory.implementation()`, runtime bytecode for both addresses, runtime bytecode hash for both.
5. Verify implementation singleton lock by static-calling `setup(...)` on the bare impl and confirming it reverts (expected: `AlreadyInitialized`).
6. Write evidence to `deployments/base-sepolia/multisig/gaosafe-factory-devtest.json`.

Expected output (selected lines):

```
CONFIRM_DEPLOY_GAOSAFE_FACTORY=true — broadcasting.
  deploy tx: 0x...
  factory  : 0x...
  impl     : 0x...
Factory runtime hash: 0x...
Impl    runtime hash: 0x...
Impl singleton lock verified ✓
  block    : <number>
Evidence written: deployments/base-sepolia/multisig/gaosafe-factory-devtest.json
PASS
```

---

## 7. Smoke test

### 7.1 Ephemeral mode (in-memory hardhat — no Base Sepolia needed)

```bash
npx hardhat run scripts/multisig/smokeGaoSafe.devtest.ts
```

Smoke matrix:

- **F1-F6** factory verification: `implementation()` non-zero, singleton not setup, bytecode hash recorded, direct `setup()` on impl reverts `AlreadyInitialized`, direct ETH to bare impl reverts `ImplementationCannotReceiveEth`.
- **V1-V9** vault creation: `computeVaultAddress` predicts, `createVault` succeeds + emits `VaultCreated`, deployed == predicted, owners + threshold + nonce set correctly, salt collision reverts, deployer-binding produces different addresses.
- **E1-E6** EIP-712: `domainSeparator` matches JS, `hashTx` matches JS digest, clone-safety (two clones produce different domain separators), `signTypedData` recovers owner, sorted threshold bundle executes.
- **N1-N4** nonce/replay: nonce increments after success, replay rejected, failed inner call leaves nonce unchanged, stale nonce rejected.
- **X1-X8** execute paths: native transfer, ERC20 transfer (MockERC20), batch, addOwner/removeOwner/replaceOwner via self-call. X7/X8 (threshold change) are SKIPPED in ephemeral due to owner-set drift in earlier steps; they are covered by `test/multisig/GaoSafe.test.ts`.
- **FC1-FC15** failure cases: expired, duplicate, unsorted, non-owner, insufficient, EIP-191 personal_sign, wrong chain, wrong vault, payload mutation, failed inner call (covered via N3), external owner-management, last-owner removal (SKIPPED — covered by test #31), bare-impl setup (covered via F5), bare-impl execTransaction (`NotSetup`), uninit clone (SKIPPED — covered by test #38).

Evidence: `deployments/base-sepolia/multisig/smoke-results.json`. Counts at end: `PASS / FAIL / SKIPPED / total`.

### 7.2 Live mode (against the deployed factory on Base Sepolia)

> Requires the live deploy from §6 to have succeeded AND the deployer EOA to have sufficient testnet ETH for smoke broadcast (a few transactions; budget ~0.05 ETH headroom).

```bash
CONFIRM_SMOKE_GAOSAFE=true \
  npx hardhat run scripts/multisig/smokeGaoSafe.devtest.ts \
  --network baseSepolia
```

In live mode, X1-X3, N1-N4, FC1-FC9 / FC11 / FC14 still run; X4-X6 require additional dev/test wallets with funds and are gated by operator approval (the script will SKIP these by default in live mode to keep gas costs bounded for the headless run).

Evidence file is the same path: `deployments/base-sepolia/multisig/smoke-results.json`. The `mode` field disambiguates.

---

## 8. Evidence files — paths and format

| File | When written | Content |
|---|---|---|
| `deployments/base-sepolia/multisig/gaosafe-factory-devtest.dry-run.json` | Dry-run | Toolchain pin, selectors, initcode hashes, deployer public addr, timestamp |
| `deployments/base-sepolia/multisig/gaosafe-factory-devtest.json` | Live deploy | Above + factory address, impl address, both runtime bytecode hashes, tx hash, block number |
| `deployments/base-sepolia/multisig/smoke-results.json` | Each smoke run | Mode (ephemeral/live), chainId, factory/impl addresses, per-check status, summary counts |

Commit the JSON evidence files alongside the code change in the same PR. They are explicit signals that the deployment is dev/test, not production.

---

## 9. How to verify there is no mainnet leak

After any deploy or smoke run:

1. Open the evidence JSON and confirm `"chainId": 84532` and `"network": "baseSepolia"`.
2. `grep -r "8453\|chainId.*1[^0-9]" deployments/base-sepolia/multisig/*.json` — should return zero hits for mainnet IDs (1, 137, 42161, 10, 8453, 56). The string `84532` is OK.
3. The script's first lines log the chainId; if you ran the script you saw the allowlist verdict.
4. Block-explorer side: search the `factoryAddress` from the evidence on https://sepolia.basescan.org. The address must exist on Base Sepolia. It must NOT exist on https://basescan.org (mainnet).

If any check fails, STOP. Do not add the address to the mobile factory registry under any circumstances.

---

## 10. How to record tx hashes / block numbers

The deploy + smoke scripts auto-record:

- `deployTxHash` — broadcast transaction hash from the factory deploy
- `deployBlockNumber` — block number from the deploy receipt
- Per-check `details` field in smoke-results.json may contain on-chain artefacts (predicted address, runtime bytecode hash, etc.)

Cross-reference with block explorer:

- https://sepolia.basescan.org/tx/<deployTxHash>
- https://sepolia.basescan.org/address/<factoryAddress>
- https://sepolia.basescan.org/address/<implementationAddress>

Confirm each address shows compiled bytecode that matches `<...>RuntimeBytecodeHash`. The block explorer's "Contract" tab will only show source if you run `npx hardhat verify --network baseSepolia <factoryAddress>` (out of scope for this runbook).

---

## 11. Rollback / failure handling

### 11.1 Dry-run fails

- Cause: selector mismatch / compile drift / env missing.
- Action: Read the FAIL message. Re-run `npx hardhat compile`. Confirm env presence. Do NOT proceed to live until dry-run is clean.

### 11.2 Live deploy fails before tx broadcast

- Cause: chain allowlist refusal, env missing, insufficient gas estimate.
- Action: No on-chain state changed. Fix the operator-side issue and re-run dry-run, then live.

### 11.3 Live deploy fails after tx broadcast

- Cause: post-deploy verification failed (e.g. impl singleton not locked, runtime bytecode hash unexpected).
- Action:
  1. The factory contract IS now on chain at the broadcast address.
  2. DO NOT register this address anywhere (mobile, docs, evidence — leave evidence file but mark `mode: "broadcast-failed"` by hand-editing the JSON if needed).
  3. Investigate the verification failure. The deployed factory should NOT be used.
  4. Open an issue / report to the operator describing exactly what verification failed.
  5. Re-deploy from scratch with a different `clientSalt` (when V8 collision check would otherwise trigger). Note: the factory itself has no salt — only `createVault` does. A new factory deploy from the same EOA at a different nonce will produce a different factory address.

### 11.4 Smoke run has FAIL rows

- Cause: behaviour drift from the test suite, RPC tip-lag, or operator misconfig.
- Action:
  1. Look at the FAIL row's `details` field for the underlying revert message or error.
  2. Re-run the relevant test from `test/multisig/`. The unit tests have richer assertions and often surface the root cause.
  3. If a Hardhat test passes but the smoke FAILs, suspect RPC tip-lag (live mode) — re-run after waiting one block.
  4. Do NOT proceed to MS-P3.3 (mobile dev/test integration) until smoke is clean.

---

## 12. What this runbook explicitly does NOT do

- ❌ Mainnet — chain allowlist refuses every mainnet ID.
- ❌ Production environment — `deployments/base-sepolia/multisig/` is the explicit dev/test signal.
- ❌ Mobile feature flag — `MULTISIG_FEATURE_ENABLED` stays `false as const`. Touching it is out of scope.
- ❌ Mobile factory address registration — `MULTISIG_FACTORY_BY_CHAIN` stays `Object.freeze({})` in production. A separate dev-only map (`MULTISIG_FACTORY_BY_CHAIN_DEV`) lands in MS-P3.3, gated by `EXPO_PUBLIC_MULTISIG_DEV_FLAG`.
- ❌ Real funds — Base Sepolia testnet ETH only.
- ❌ MPC / TSS — Genesis is on-chain Safe-style multisig with independent EOA owners.
- ❌ External audit engagement — deferred per MS-P3.0 plan; this runbook supports the build-test-AI-audit phase first.
- ❌ Modifying `contracts/multisig/*.sol`, `abis/multisig/*.json`, `hardhat.config.ts`, `package*.json`, `slither.config.json`, or `.github/workflows/contracts-*.yml`. The Solidity / ABI surface is byte-identical to PR #17 (`ac14411`).

---

## 13. Where this fits in the MS-P3 roadmap

| Phase | Status |
|---|---|
| MS-P3.0 | ✅ Planning complete |
| **MS-P3.1** | **This runbook + deploy + smoke scripts (current)** |
| MS-P3.2 | Dev/test deploy on Base Sepolia (operator-only, runs the script in §6) |
| MS-P3.3 | Mobile dev/test integration PR (dev flag + dev factory map for Base Sepolia) |
| MS-P3.4 | TestFlight internal build with multisig surface enabled in dev build only |
| MS-P3.5 | Full device test evidence collection |
| MS-P3.6 | 6 independent AI audit rounds |
| MS-P3.7 | Remediation iterations |
| MS-P3.8 | Freeze final candidate |
| MS-P4 | External third-party audit (later) |

After MS-P3.1 lands, MS-P3.2 is "operator runs the script". The operator is the only party who broadcasts.
