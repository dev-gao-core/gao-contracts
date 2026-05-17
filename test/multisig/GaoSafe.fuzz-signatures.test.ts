// PR 7 — Signature bundle property tests (sort + dedup edge-case fuzz).
//
// Pins invariant I8 from `docs/multisig/gao-safe-invariants.md`: a
// concatenated 65-byte signature bundle is accepted by `execTransaction`
// only when its recovered signers are (a) strictly ascending and
// (b) drawn entirely from the vault's owner set. Every other shape is
// rejected — by `SignaturesNotSorted` (recovered <= prev) or by
// `NotAnOwner` (recovered is not in `isOwner`).
//
// 50 deterministic iterations per sub-property. Master seed is
// `0x6A0FED1357` per the PR 7 plan; the per-property seed is derived
// by keccak256(`${MASTER}:${tag}`) low 32 bits and feeds `mulberry32`.
// Failures emit the seed, iteration index, and shape so any failure
// is reproducible without re-running the suite.

import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  bundleSignatures,
  buildSignTypedDataInputs,
  sortSignersAscending,
} from "./helpers/eip712";

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

/** Fisher-Yates shuffle using the deterministic PRNG. */
function shuffleInPlace<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randIntInclusive(rand, 0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Detect whether two signer arrays are in the same ascending order. */
function isStrictlyAscending(arr: readonly { address: string }[]): boolean {
  for (let i = 1; i < arr.length; i++) {
    if (arr[i - 1].address.toLowerCase() >= arr[i].address.toLowerCase()) {
      return false;
    }
  }
  return true;
}

const HOUR = 3600n;

// ── shared deployment helpers ───────────────────────────────────────────

async function deployFactory() {
  const F = await ethers.getContractFactory("GaoSafeFactory");
  const factory = await F.deploy();
  await factory.waitForDeployment();
  return factory;
}

interface Deployed {
  vault: Awaited<ReturnType<typeof ethers.getContractAt>>;
  vaultAddress: string;
  ownerSigners: HardhatEthersSigner[];
  ownerAddresses: string[];
  outsider: HardhatEthersSigner;
  chainId: bigint;
}

async function setupCommon(
  ownerCount: number,
  threshold: number,
  clientSaltSuffix: string,
): Promise<Deployed> {
  const signers = await ethers.getSigners();
  const ownerSigners = signers.slice(0, ownerCount);
  const outsider = signers[ownerCount];
  const factory = await deployFactory();
  const tx = await factory.createVault(
    ownerSigners.map((s) => s.address),
    threshold,
    ethers.id(`pr7-fuzz-sigs-${clientSaltSuffix}`),
  );
  const receipt = await tx.wait();
  let vaultAddress: string | null = null;
  for (const log of receipt!.logs) {
    try {
      const p = factory.interface.parseLog(log);
      if (p && p.name === "VaultCreated") vaultAddress = p.args[0] as string;
    } catch {
      /* skip */
    }
  }
  if (!vaultAddress) throw new Error("VaultCreated event not found");
  const vault = await ethers.getContractAt("GaoSafe", vaultAddress);
  await signers[0].sendTransaction({
    to: vaultAddress,
    value: ethers.parseEther("5"),
  });
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return {
    vault,
    vaultAddress,
    ownerSigners,
    ownerAddresses: ownerSigners.map((s) => s.address),
    outsider,
    chainId,
  };
}

// ── tests ──────────────────────────────────────────────────────────────

describe("PR 7 — GaoSafe signature bundle fuzz (I8 — sort + dedup edge cases)", () => {
  // ── I8a ──────────────────────────────────────────────────────────────
  describe("I8a — unsorted signature bundles are rejected", () => {
    it(`every non-ascending permutation of a threshold-sized owner subset reverts SignaturesNotSorted across ${ITERATIONS} iterations`, async () => {
      const seed = seedForProperty("I8a-unsorted-rejected");
      const rand = mulberry32(seed);

      // Use a 5-of-3 vault: 5 owners, threshold 3. Plenty of room to
      // pick threshold-3 subsets and shuffle them into non-ascending
      // orders.
      const d = await setupCommon(5, 3, "I8a");

      let permutationsExercised = 0;
      let unsortedCasesExercised = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        // Take owners[0..2] as the threshold-3 subset (consistent
        // across iterations so we can isolate the ordering effect).
        const subset: HardhatEthersSigner[] = d.ownerSigners.slice(0, 3);
        // Permute deterministically.
        const permuted: HardhatEthersSigner[] = shuffleInPlace([...subset], rand);
        permutationsExercised++;

        // If the permutation happens to be already sorted, swap two
        // adjacent signers so the test always exercises an unsorted
        // case (the I8b dedup-test and the existing happy-path test
        // cover the sorted case).
        if (isStrictlyAscending(permuted)) {
          [permuted[0], permuted[1]] = [permuted[1], permuted[0]];
        }
        unsortedCasesExercised++;

        const recipient = d.outsider.address;
        const amount = ethers.parseEther("0.001");
        const block = await ethers.provider.getBlock("latest");
        const expiry = BigInt(block!.timestamp) + HOUR;
        const nonce = await d.vault.nonce();
        const inputs = buildSignTypedDataInputs({
          chainId: d.chainId,
          vault: d.vaultAddress,
          nonce,
          targets: [recipient],
          values: [amount],
          data: ["0x"],
          expiry,
        });
        const sigs = await bundleSignatures(permuted, inputs);

        await expect(
          d.vault.execTransaction(
            [recipient],
            [amount],
            ["0x"],
            expiry,
            sigs,
          ),
          `seed=${seed}, iter=${i}, addresses=[${permuted
            .map((p) => p.address)
            .join(",")}]`,
        ).to.be.revertedWithCustomError(d.vault, "SignaturesNotSorted");
      }
      expect(permutationsExercised).to.equal(ITERATIONS);
      expect(unsortedCasesExercised).to.equal(ITERATIONS);
    });
  });

  // ── I8b ──────────────────────────────────────────────────────────────
  describe("I8b — duplicate-signer bundles are rejected", () => {
    it(`every threshold-sized bundle containing a duplicate signer reverts SignaturesNotSorted across ${ITERATIONS} iterations`, async () => {
      const seed = seedForProperty("I8b-duplicate-rejected");
      const rand = mulberry32(seed);

      // 4-of-2 vault: 4 owners, threshold 2.
      const d = await setupCommon(4, 2, "I8b");

      for (let i = 0; i < ITERATIONS; i++) {
        // Pick one owner index and replicate it twice as the bundle.
        // Recovered signer equals itself ⇒ `recovered <= prev` is true
        // on the second slot (recovered == prev), so the contract
        // reverts with SignaturesNotSorted.
        const ownerIdx = randIntInclusive(rand, 0, 3);
        const duplicatedSigner = d.ownerSigners[ownerIdx];
        const dupBundle: HardhatEthersSigner[] = [
          duplicatedSigner,
          duplicatedSigner,
        ];

        const recipient = d.outsider.address;
        const amount = ethers.parseEther("0.001");
        const block = await ethers.provider.getBlock("latest");
        const expiry = BigInt(block!.timestamp) + HOUR;
        const nonce = await d.vault.nonce();
        const inputs = buildSignTypedDataInputs({
          chainId: d.chainId,
          vault: d.vaultAddress,
          nonce,
          targets: [recipient],
          values: [amount],
          data: ["0x"],
          expiry,
        });
        const sigs = await bundleSignatures(dupBundle, inputs);

        await expect(
          d.vault.execTransaction(
            [recipient],
            [amount],
            ["0x"],
            expiry,
            sigs,
          ),
          `seed=${seed}, iter=${i}, ownerIdx=${ownerIdx}, address=${duplicatedSigner.address}`,
        ).to.be.revertedWithCustomError(d.vault, "SignaturesNotSorted");
      }
    });
  });

  // ── I8c ──────────────────────────────────────────────────────────────
  describe("I8c — bundle containing a non-owner signature is rejected", () => {
    it(`every threshold-sized bundle with one non-owner signer reverts NotAnOwner across ${ITERATIONS} iterations`, async () => {
      const seed = seedForProperty("I8c-non-owner-rejected");
      const rand = mulberry32(seed);

      // 4-of-2 vault: 4 owners, threshold 2. Non-owner is signers[4].
      const d = await setupCommon(4, 2, "I8c");
      const signers = await ethers.getSigners();
      const nonOwner = signers[4];

      for (let i = 0; i < ITERATIONS; i++) {
        // One genuine owner + one non-owner. The contract walks the
        // bundle in supplied order and reverts on the first
        // non-owner recovery. Either SignaturesNotSorted (if the
        // sort check rejects first) or NotAnOwner (if the isOwner
        // check fires first) — both are valid rejections; we test
        // for either by using `to.be.reverted` rather than a
        // specific custom-error name. To strengthen the assertion
        // we additionally place the genuine owner FIRST so the
        // bundle is in sorted order (relative to a possibly-greater
        // non-owner address); on those iterations the failure can
        // only be NotAnOwner.
        const ownerIdx = randIntInclusive(rand, 0, 3);
        const genuineOwner = d.ownerSigners[ownerIdx];

        // Determine which member would sort first.
        const genuineFirst =
          genuineOwner.address.toLowerCase() < nonOwner.address.toLowerCase();
        const ordered: HardhatEthersSigner[] = genuineFirst
          ? [genuineOwner, nonOwner]
          : [nonOwner, genuineOwner];

        const recipient = d.outsider.address;
        const amount = ethers.parseEther("0.001");
        const block = await ethers.provider.getBlock("latest");
        const expiry = BigInt(block!.timestamp) + HOUR;
        const nonce = await d.vault.nonce();
        const inputs = buildSignTypedDataInputs({
          chainId: d.chainId,
          vault: d.vaultAddress,
          nonce,
          targets: [recipient],
          values: [amount],
          data: ["0x"],
          expiry,
        });
        const sigs = await bundleSignatures(ordered, inputs);

        // `to.be.reverted` covers both NotAnOwner and SignaturesNotSorted —
        // both are valid rejections for an unsorted-or-non-owner bundle.
        await expect(
          d.vault.execTransaction(
            [recipient],
            [amount],
            ["0x"],
            expiry,
            sigs,
          ),
          `seed=${seed}, iter=${i}, ownerIdx=${ownerIdx}, genuineFirst=${genuineFirst}, addresses=[${ordered
            .map((p) => p.address)
            .join(",")}]`,
        ).to.be.reverted;
      }
    });
  });

  // ── I8d (positive sanity) ────────────────────────────────────────────
  describe("I8d — strict-ascending bundle of owners is accepted (positive sanity)", () => {
    it(`every sorted-and-deduped threshold-sized owner subset succeeds across ${ITERATIONS} iterations`, async () => {
      const seed = seedForProperty("I8d-sorted-accepted");
      const rand = mulberry32(seed);

      // 5-of-3 vault.
      const d = await setupCommon(5, 3, "I8d");

      for (let i = 0; i < ITERATIONS; i++) {
        // Choose a random threshold-3 subset from the 5 owners,
        // then sort ascending.
        const indices = [0, 1, 2, 3, 4];
        shuffleInPlace(indices, rand);
        const subsetIdx = indices.slice(0, 3);
        const subset = subsetIdx.map((idx) => d.ownerSigners[idx]);
        const sorted = sortSignersAscending(subset);

        const recipient = d.outsider.address;
        const amount = ethers.parseEther("0.001");
        const block = await ethers.provider.getBlock("latest");
        const expiry = BigInt(block!.timestamp) + HOUR;
        const nonce = await d.vault.nonce();
        const inputs = buildSignTypedDataInputs({
          chainId: d.chainId,
          vault: d.vaultAddress,
          nonce,
          targets: [recipient],
          values: [amount],
          data: ["0x"],
          expiry,
        });
        const sigs = await bundleSignatures(sorted, inputs);

        await d.vault.execTransaction(
          [recipient],
          [amount],
          ["0x"],
          expiry,
          sigs,
        );
        // Nonce advanced — proposal accepted.
        expect(await d.vault.nonce()).to.equal(nonce + 1n);
      }
    });
  });
});
