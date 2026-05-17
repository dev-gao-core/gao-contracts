// JS-side EIP-712 builder that mirrors `contracts/multisig/GaoSafe.sol`.
//
// Why this file exists:
//   1. The Genesis contract implements EIP-712 manually (not via OZ
//      EIP712 base contract) to be EIP-1167 clone-safe. The parity
//      test (`GaoSafe.eip712-parity.test.ts`) compares the byte-exact
//      digest produced here against the contract's `hashTx(...)` view
//      AND against ethers' built-in `TypedDataEncoder.hash(...)`.
//   2. PR 3 (gaokey-mobile) re-implements this same builder in
//      `src/multisig/ProposalBuilder.ts`. Pinning the byte layout in
//      gao-contracts first means the mobile builder cannot drift.
//
// This file is consumed only by tests and contains no broadcast logic.

import {
  AbiCoder,
  TypedDataEncoder,
  Wallet,
  concat,
  keccak256,
  toBeHex,
  toUtf8Bytes,
} from "ethers";

const abi = AbiCoder.defaultAbiCoder();

/** EIP-712 domain typehash. Matches `_DOMAIN_TYPEHASH` in GaoSafe.sol. */
export const DOMAIN_TYPEHASH = keccak256(
  toUtf8Bytes(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ),
);

/** keccak256("GaoSafe"). Matches `_NAME_HASH` in GaoSafe.sol. */
export const NAME_HASH = keccak256(toUtf8Bytes("GaoSafe"));

/** keccak256("1"). Matches `_VERSION_HASH` in GaoSafe.sol. */
export const VERSION_HASH = keccak256(toUtf8Bytes("1"));

/** Tx struct typehash. Matches `TX_TYPEHASH` in GaoSafe.sol. */
export const TX_TYPEHASH = keccak256(
  toUtf8Bytes(
    "GaoMultisigTx(uint256 chainId,address vault,uint256 nonce,bytes32 targetsHash,bytes32 valuesHash,bytes32 dataHash,uint256 expiry)",
  ),
);

/** Domain for use with ethers `signTypedData` / `TypedDataEncoder`. */
export interface MultisigDomain {
  name: "GaoSafe";
  version: "1";
  chainId: bigint | number;
  verifyingContract: string;
}

/** Types for use with ethers `signTypedData` / `TypedDataEncoder`. */
export const MULTISIG_TYPES = {
  GaoMultisigTx: [
    { name: "chainId", type: "uint256" },
    { name: "vault", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "targetsHash", type: "bytes32" },
    { name: "valuesHash", type: "bytes32" },
    { name: "dataHash", type: "bytes32" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

/** Build the EIP-712 domain separator, byte-exact to GaoSafe.domainSeparator(). */
export function buildDomainSeparator(
  chainId: bigint | number,
  vault: string,
): string {
  return keccak256(
    abi.encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, chainId, vault],
    ),
  );
}

/** keccak256(abi.encodePacked(address[])) — each address LEFT-PADDED to 32 bytes.
 *
 *  Contrary to what the "packed" name suggests, Solidity's
 *  `abi.encodePacked(T[])` uses the standard 32-byte tuple encoding for
 *  every element. Only PRIMITIVE SCALARS get the short packed form;
 *  ARRAY ELEMENTS are always 32 bytes each, concatenated, no length
 *  prefix. So `abi.encodePacked(address[1])` is 32 bytes (12 zero
 *  bytes + 20 bytes address), not 20.
 */
export function buildTargetsHash(targets: readonly string[]): string {
  const packed =
    "0x" +
    targets.map((t) => stripHex(toBeHex(BigInt(t), 32))).join("");
  return keccak256(packed);
}

/** keccak256(abi.encodePacked(uint256[])) — each value as 32 packed bytes. */
export function buildValuesHash(values: readonly (bigint | number)[]): string {
  const packed =
    "0x" +
    values.map((v) => stripHex(toBeHex(BigInt(v), 32))).join("");
  return keccak256(packed);
}

/** keccak256(abi.encodePacked(map(keccak256, data))) — each element hashed, then 32-byte packed. */
export function buildDataHash(data: readonly string[]): string {
  const hashes = data.map((d) => keccak256(d));
  const packed = "0x" + hashes.map((h) => stripHex(h)).join("");
  return keccak256(packed);
}

/** Inner struct hash. */
export function buildStructHash(opts: {
  chainId: bigint | number;
  vault: string;
  nonce: bigint | number;
  targets: readonly string[];
  values: readonly (bigint | number)[];
  data: readonly string[];
  expiry: bigint | number;
}): string {
  return keccak256(
    abi.encode(
      [
        "bytes32",
        "uint256",
        "address",
        "uint256",
        "bytes32",
        "bytes32",
        "bytes32",
        "uint256",
      ],
      [
        TX_TYPEHASH,
        opts.chainId,
        opts.vault,
        opts.nonce,
        buildTargetsHash(opts.targets),
        buildValuesHash(opts.values),
        buildDataHash(opts.data),
        opts.expiry,
      ],
    ),
  );
}

/** Full EIP-712 digest. Byte-exact to GaoSafe.hashTx(...). */
export function buildDigest(opts: {
  chainId: bigint | number;
  vault: string;
  nonce: bigint | number;
  targets: readonly string[];
  values: readonly (bigint | number)[];
  data: readonly string[];
  expiry: bigint | number;
}): string {
  const domain = buildDomainSeparator(opts.chainId, opts.vault);
  const structHash = buildStructHash(opts);
  return keccak256(concat(["0x1901", domain, structHash]));
}

/** Reference digest computed by ethers' built-in TypedDataEncoder.
 *  Used in parity tests as a third independent check. */
export function buildDigestViaEthers(opts: {
  chainId: bigint | number;
  vault: string;
  nonce: bigint | number;
  targets: readonly string[];
  values: readonly (bigint | number)[];
  data: readonly string[];
  expiry: bigint | number;
}): string {
  const domain: MultisigDomain = {
    name: "GaoSafe",
    version: "1",
    chainId: opts.chainId,
    verifyingContract: opts.vault,
  };
  const message = {
    chainId: opts.chainId,
    vault: opts.vault,
    nonce: opts.nonce,
    targetsHash: buildTargetsHash(opts.targets),
    valuesHash: buildValuesHash(opts.values),
    dataHash: buildDataHash(opts.data),
    expiry: opts.expiry,
  };
  return TypedDataEncoder.hash(domain, MULTISIG_TYPES, message);
}

/** Build domain + typed message ready for `signer.signTypedData(...)`. */
export function buildSignTypedDataInputs(opts: {
  chainId: bigint | number;
  vault: string;
  nonce: bigint | number;
  targets: readonly string[];
  values: readonly (bigint | number)[];
  data: readonly string[];
  expiry: bigint | number;
}): {
  domain: MultisigDomain;
  types: typeof MULTISIG_TYPES;
  message: {
    chainId: bigint | number;
    vault: string;
    nonce: bigint | number;
    targetsHash: string;
    valuesHash: string;
    dataHash: string;
    expiry: bigint | number;
  };
} {
  return {
    domain: {
      name: "GaoSafe",
      version: "1",
      chainId: opts.chainId,
      verifyingContract: opts.vault,
    },
    types: MULTISIG_TYPES,
    message: {
      chainId: opts.chainId,
      vault: opts.vault,
      nonce: opts.nonce,
      targetsHash: buildTargetsHash(opts.targets),
      valuesHash: buildValuesHash(opts.values),
      dataHash: buildDataHash(opts.data),
      expiry: opts.expiry,
    },
  };
}

/** Signer abstraction — Hardhat's `getSigners()` items or a raw Wallet. */
interface TypedDataSigner {
  address: string;
  signTypedData(
    domain: MultisigDomain,
    types: typeof MULTISIG_TYPES,
    message: Record<string, unknown>,
  ): Promise<string>;
}

/** Sort signers by address ascending — the order required by the
 *  contract's `_verifySignatures`. Returns a new array; does not mutate. */
export function sortSignersAscending<T extends { address: string }>(
  signers: readonly T[],
): T[] {
  return [...signers].sort((a, b) => {
    const aLow = a.address.toLowerCase();
    const bLow = b.address.toLowerCase();
    if (aLow < bLow) return -1;
    if (aLow > bLow) return 1;
    return 0;
  });
}

/** Have each signer produce a typed-data signature and concatenate
 *  them in the supplied order. Caller is responsible for ordering
 *  (use `sortSignersAscending` for the happy path; pass an unsorted
 *  array for negative tests). */
export async function bundleSignatures(
  signers: readonly TypedDataSigner[],
  inputs: ReturnType<typeof buildSignTypedDataInputs>,
): Promise<string> {
  const sigs: string[] = [];
  for (const signer of signers) {
    sigs.push(
      await signer.signTypedData(inputs.domain, inputs.types, inputs.message),
    );
  }
  return "0x" + sigs.map((s) => stripHex(s)).join("");
}

/** Sign the raw EIP-712 digest as a personal_sign (EIP-191) message.
 *  Used by the EIP-191-rejection test: the resulting signature recovers
 *  to a different address than the EIP-712 digest because the inner
 *  hash includes the "\x19Ethereum Signed Message:\n32" prefix. */
export async function signDigestAsEip191(
  wallet: Wallet,
  digest: string,
): Promise<string> {
  return wallet.signMessage(stripHexToBytes(digest));
}

// ── internals ────────────────────────────────────────────────────────────

function stripHex(s: string): string {
  return s.startsWith("0x") ? s.slice(2) : s;
}

function stripHexToBytes(hex: string): Uint8Array {
  const h = stripHex(hex);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
