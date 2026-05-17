// PR 7 — GaoSafeFactory CREATE2 prediction property tests.
//
// Pins invariant I9 from `docs/multisig/gao-safe-invariants.md`: for
// every `(deployer, clientSalt)` pair, `computeVaultAddress(deployer,
// clientSalt)` equals the address actually produced by
// `createVault(_, _, clientSalt)` when called by `deployer`. Plus the
// negative twin: the same `clientSalt` from two different deployers
// produces two different addresses (the deployer binding mitigates
// address squatting per the contract docstring).
//
// 50 deterministic iterations per sub-property. Master seed
// `0x6A0FED1357` per the PR 7 plan; per-property seed via keccak256.

import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ── PR 7 master seed and PRNG (locked plan) ─────────────────────────────

const MASTER_SEED = "0x6A0FED1357" as const;
const ITERATIONS = 50;

function seedForProperty(propertyTag: string): number {
  const h = ethers.keccak256(
    ethers.toUtf8Bytes(`${MASTER_SEED}:${propertyTag}`),
  );
  return Number(BigInt(h) & 0xffffffffn);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randIntInclusive(rand: () => number, lo: number, hi: number): number {
  return Math.floor(rand() * (hi - lo + 1)) + lo;
}

/** Random 32-byte salt derived deterministically from the PRNG and an iter index. */
function randSalt(rand: () => number, iter: number): string {
  // 16 hex chars from the PRNG (~64 bits) folded into a keccak256 to
  // produce a full 32-byte salt. Deterministic per (seed, iter).
  const draw = randIntInclusive(rand, 0, 0xffff_ffff);
  return ethers.keccak256(
    ethers.toUtf8Bytes(`pr7-fuzz-create2:${MASTER_SEED}:${iter}:${draw}`),
  );
}

// ── shared deployment helpers ───────────────────────────────────────────

async function deployFactory() {
  const F = await ethers.getContractFactory("GaoSafeFactory");
  const factory = await F.deploy();
  await factory.waitForDeployment();
  return factory;
}

/**
 * Extract the deployed vault address from a `createVault` transaction
 * receipt by walking the logs for the `VaultCreated` event.
 */
function parseVaultCreated(
  factory: Awaited<ReturnType<typeof deployFactory>>,
  receipt: { logs: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string }> },
): string | null {
  for (const log of receipt.logs) {
    try {
      const p = factory.interface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (p && p.name === "VaultCreated") {
        return p.args[0] as string;
      }
    } catch {
      /* skip non-matching logs */
    }
  }
  return null;
}

// ── tests ──────────────────────────────────────────────────────────────

describe("PR 7 — GaoSafeFactory CREATE2 property tests", () => {
  // ── I9a ──────────────────────────────────────────────────────────────
  describe("I9a — computeVaultAddress matches the deployed clone address", () => {
    it(`predicted address equals actually-deployed address across ${ITERATIONS} randomised (deployer, clientSalt) pairs`, async () => {
      const seed = seedForProperty("I9a-prediction-matches-deploy");
      const rand = mulberry32(seed);

      const factory = await deployFactory();
      const signers = await ethers.getSigners();
      // Use the first 4 signers as a deterministic deployer pool.
      const deployerPool: HardhatEthersSigner[] = signers.slice(0, 4);
      // Use the first 2 signers as the vault owner set for the deploy
      // call (any 2-owner set with a valid threshold works; the
      // property is about address prediction, not the owner set).
      const ownerSet = [signers[0].address, signers[1].address];
      const threshold = 2;

      for (let i = 0; i < ITERATIONS; i++) {
        const deployerIdx = randIntInclusive(rand, 0, deployerPool.length - 1);
        const deployer = deployerPool[deployerIdx];
        const clientSalt = randSalt(rand, i);

        const predicted = await factory.computeVaultAddress(
          deployer.address,
          clientSalt,
        );
        const tx = await factory
          .connect(deployer)
          .createVault(ownerSet, threshold, clientSalt);
        const receipt = await tx.wait();
        const actual = parseVaultCreated(factory, receipt!);

        expect(
          actual,
          `seed=${seed}, iter=${i}, deployer=${deployer.address}, clientSalt=${clientSalt}: VaultCreated event missing`,
        ).to.not.be.null;
        expect(
          actual!.toLowerCase(),
          `seed=${seed}, iter=${i}, deployer=${deployer.address}, clientSalt=${clientSalt}: prediction mismatch`,
        ).to.equal(predicted.toLowerCase());

        // Sanity: the deployed bytecode is actually present at the
        // predicted address (i.e. we are observing a real clone,
        // not a stale prediction).
        const code = await ethers.provider.getCode(actual!);
        expect(code).to.not.equal("0x");
      }
    });
  });

  // ── I9b ──────────────────────────────────────────────────────────────
  describe("I9b — different deployers with the same clientSalt produce different addresses", () => {
    it(`address differs for every pair (deployerA, deployerB, sharedSalt) across ${ITERATIONS} iterations`, async () => {
      const seed = seedForProperty("I9b-different-deployer-different-address");
      const rand = mulberry32(seed);

      const factory = await deployFactory();
      const signers = await ethers.getSigners();
      // Use a pool of 4 distinct deployer addresses.
      const pool: HardhatEthersSigner[] = signers.slice(0, 4);

      for (let i = 0; i < ITERATIONS; i++) {
        // Pick two DIFFERENT deployer indices deterministically.
        const aIdx = randIntInclusive(rand, 0, pool.length - 1);
        let bIdx = randIntInclusive(rand, 0, pool.length - 1);
        if (bIdx === aIdx) bIdx = (bIdx + 1) % pool.length;

        const a = pool[aIdx];
        const b = pool[bIdx];
        const sharedSalt = randSalt(rand, i);

        const addrA = await factory.computeVaultAddress(a.address, sharedSalt);
        const addrB = await factory.computeVaultAddress(b.address, sharedSalt);
        expect(
          addrA.toLowerCase(),
          `seed=${seed}, iter=${i}, a=${a.address}, b=${b.address}, salt=${sharedSalt}: predictions collided`,
        ).to.not.equal(addrB.toLowerCase());
      }
    });
  });
});
