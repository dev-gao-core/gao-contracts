# Agent Secret-Handling Guardrails — `gao-contracts`

> **Normative for every agent (Claude Code, any other AI assistant,
> any contractor working through an automated session) operating
> inside this repository.** This document defines the BAN list, the
> ALLOW list, and the test surface that enforces both. Violating
> the BAN list is a security incident that requires rotation
> regardless of the apparent "blast radius" of the leak.
>
> **Trigger for this revision:** during the GaoDomainDepositV3
> Base Sepolia dev/test deploy session (PR
> `dev-gao-core/gao-contracts#12`), an agent ran
> `hexdump -C .env | head -5` and printed the first 10 hex
> characters of `DEPLOYER_PRIVATE_KEY` alongside the public RPC
> URL. The remaining 54 hex characters were not exposed and a
> brute-force is computationally infeasible, **but the
> contract was violated**. These guardrails exist so that mistake
> cannot recur.

---

## 1. Threat model

**What we are protecting:**
- `DEPLOYER_PRIVATE_KEY` — the EOA used to broadcast contract
  deploys + post-deploy admin txs.
- Any other private key referenced by env (`OWNER_PRIVATE_KEY`,
  `SETTLER_PRIVATE_KEY`, etc.) in any tier (dev/test or
  production).
- `BASESCAN_API_KEY`, RPC URLs that embed an API key (Alchemy
  / Infura / QuickNode keys are part of the URL itself).
- Cloudflare account tokens, GitHub PATs, AWS access keys,
  GCP service-account JSON, KMS / HSM credentials.
- Seed phrases / mnemonics, BIP-39 word lists.

**Threat actors:**
- An agent acting on operator instructions but using
  insufficient care (the trigger incident).
- An adversary who later reads the conversation log / commit
  history / CI log and recovers a leaked value or prefix.
- A future engineer who follows an outdated pattern from the
  agent's prior turn.

**What is NOT in scope:**
- The contract source code is public; no protection needed.
- Public on-chain addresses (contract addresses, EOA addresses
  derived from public keys, tx hashes) are intentionally
  public and may be logged freely.
- Public RPC URLs without an API-key suffix (e.g.
  `https://sepolia.base.org`) are dev/test conveniences and
  may be logged — but the canonical posture is "treat any
  `*_RPC_URL` env value as private until proven public".

## 2. BAN list — commands an agent MUST NOT run

The following commands, patterns, and equivalents are
permanently banned. The list is enforced by the test in
`test/guardrails/agent-secret-command-guardrail.test.ts`,
which fails CI when committed code references any banned
literal outside the BAN-list documentation itself.

### 2.1 Reading a secret file

Any command that reads `.env`, `.env.*`, `.dev.vars`, `*.pem`,
`*.key`, `mnemonic*`, `id_rsa*`, `seed.txt`, `recovery.txt`,
or similar secret-file names AND emits the bytes (or any
prefix of them) anywhere — terminal, log file, PR description,
commit message, screenshot, video — is banned. Non-exhaustive
examples:

```sh
cat .env                              # BANNED
cat .env.local                        # BANNED
cat .dev.vars                         # BANNED
cat keys/deployer.pem                 # BANNED
less .env                             # BANNED
more .env                             # BANNED
head .env                             # BANNED
head -1 .env                          # BANNED
tail .env                             # BANNED
sed -n '1,5p' .env                    # BANNED
awk '{print}' .env                    # BANNED
awk -F= '{print $2}' .env             # BANNED  (extracts VALUES)
hexdump -C .env                       # BANNED
hexdump .env                          # BANNED
xxd .env                              # BANNED
od -c .env                            # BANNED
strings .env                          # BANNED
od -An -c .env                        # BANNED
```

Pipes that materialise bytes are also banned (`cat .env | …`,
`< .env …`).

### 2.2 Printing env values

Any command that reads `process.env.X` (or shell `$X`) where
`X` is a secret-typed variable AND emits the value:

```sh
echo $DEPLOYER_PRIVATE_KEY            # BANNED
echo "$DEPLOYER_PRIVATE_KEY"          # BANNED
echo $BASE_SEPOLIA_RPC_URL            # BANNED  (RPC URL may carry an API key)
echo $RPC_URL                         # BANNED
echo $SIGNER_HMAC_SECRET              # BANNED
echo $RECONCILE_SECRET                # BANNED
echo $AUTH_V2_PRIVATE_KEY_PEM         # BANNED
printenv                              # BANNED  (lists ALL env values)
printenv DEPLOYER_PRIVATE_KEY         # BANNED
env                                   # BANNED  (lists ALL env values)
env | grep DEPLOYER                   # BANNED
set                                   # BANNED  (shell builtin; lists vars)
set | grep DEPLOYER                   # BANNED
export | grep DEPLOYER                # BANNED
node -e "console.log(process.env.DEPLOYER_PRIVATE_KEY)"       # BANNED
node -e "console.log(JSON.stringify(process.env))"            # BANNED
python -c "import os; print(os.environ['DEPLOYER_PRIVATE_KEY'])"  # BANNED
python -c "import os; print(dict(os.environ))"                # BANNED
```

### 2.3 Listing or mutating secrets via cloud CLI

```sh
gh secret list                        # BANNED  (lists secret NAMES at scale — may surface
                                      #          new categories the agent should not assume).
                                      #          When the operator needs this, they run it.
gh secret set NAME                    # BANNED  (writes a secret)
gh secret delete NAME                 # BANNED  (destructive)
wrangler secret list                  # BANNED
wrangler secret put NAME              # BANNED  (writes a secret to Cloudflare)
wrangler secret delete NAME           # BANNED
aws secretsmanager get-secret-value   # BANNED
aws ssm get-parameter --with-decryption # BANNED
gcloud secrets versions access        # BANNED
op read op://vault/item/field         # BANNED  (1Password CLI fetch)
kubectl get secret NAME -o yaml       # BANNED
```

### 2.4 Deploy / signer scripts that log secret env values

A deploy script that contains either:

```js
console.log(process.env.DEPLOYER_PRIVATE_KEY)
console.log(`key=${process.env.DEPLOYER_PRIVATE_KEY}`)
console.log(process.env)                  // every env value
console.log(JSON.stringify(process.env))  // every env value
```

…is banned. CI greps every committed script for these
patterns. A deploy script MAY:

- log `signer.getAddress()` (the public address derived from
  the private key).
- log the public `chainId`, `network.name`.
- log public contract addresses (treasury / token / deployed
  contract).
- log tx hashes.

### 2.5 Pattern-shaped leaks

The following patterns indicate a leaked secret EVEN WHEN the
literal command does not appear:

- A 64-hex string (`/^[0-9a-fA-F]{64}$/`) outside a known-tx-hash
  / known-bytes32 context.
- A `0x` + 64-hex string near the literal `PRIVATE_KEY`,
  `DEPLOYER`, `SETTLER`, `SECRET`, `MNEMONIC`, or `KEY` in the
  same line or the immediately preceding line.
- `-----BEGIN [A-Z ]*PRIVATE KEY-----`.
- A 12 / 15 / 18 / 21 / 24-word BIP-39 mnemonic (heuristic:
  12+ space-separated dictionary words appearing in a single
  line in a file that mentions `mnemonic`, `seed`, `recovery`,
  `wallet`).
- A Cloudflare token (`/^[A-Za-z0-9_-]{40}$/` near the literal
  `cloudflare` / `wrangler` / `CF_API_TOKEN`).
- A GitHub PAT (`/^ghp_[A-Za-z0-9]{36}$/` or
  `/^github_pat_[A-Za-z0-9_]{40,}$/`).

CI scans every staged file (and every committed file) for these
patterns and refuses the commit.

## 3. ALLOW list — safe agent operations

Agents MAY do all of the following without operator approval:

### 3.1 List env variable NAMES (never values)

```sh
node -e "const fs=require('fs'); for (const l of fs.readFileSync('.env','utf8').split(/\r?\n/)) { const m=l.match(/^([A-Z0-9_]+)=/); if (m) console.log(m[1]); }"
```

This emits only the keys (the part before `=`). The value
half is captured by the regex but never emitted. The agent
SHALL use exactly this command — variants like
`awk -F= '{print $1}' .env` are also safe in principle but
prone to operator-side variant errors; stick to the canonical
form.

For a presence check on a single variable:

```sh
test -n "${DEPLOYER_PRIVATE_KEY+set}" && echo "DEPLOYER_PRIVATE_KEY: present" || echo "DEPLOYER_PRIVATE_KEY: missing"
```

This uses parameter-substitution to report presence without
referencing the value.

### 3.2 Boolean presence check via dotenv

```sh
node -e "require('dotenv').config(); for (const k of ['BASE_SEPOLIA_RPC_URL','DEPLOYER_PRIVATE_KEY']) console.log(k + '=' + (process.env[k] ? 'SET' : 'MISSING'))"
```

This is the canonical form. The output is `KEY=SET` or
`KEY=MISSING` — never the value itself.

### 3.3 Derive and print PUBLIC deployer address

When the operator explicitly approves, an agent MAY run a
script that uses `DEPLOYER_PRIVATE_KEY` to derive the public
address AND emits only the address:

```js
const { Wallet } = require("ethers");
const w = new Wallet(process.env.DEPLOYER_PRIVATE_KEY);
console.log(`deployer public address: ${w.address}`);
// MUST NOT print w.privateKey, w._signingKey(), w.publicKey, or
// anything that allows the operator (or anyone reading the log
// later) to reconstruct the private key.
```

Approved use: showing the operator the address that a deploy
will broadcast from BEFORE the broadcast, so they can confirm
funding / nonce / explorer state. Unapproved use: any time the
operator has not explicitly asked.

### 3.4 Emit only public values in deploy logs

A deploy script SHALL log:

- `chainId`, `network.name` — both public.
- Signer's **public** address (`await signer.getAddress()`).
- Constructor args' **public** addresses (owner, treasury,
  token).
- Deploy tx hash, follow-up tx hashes.
- Deployed contract address.
- Post-deploy `owner()`, `treasury()`, `allowedTokens(...)`
  view results.

A deploy script SHALL NOT log:

- `process.env.DEPLOYER_PRIVATE_KEY`, in any form, ever.
- Any RPC URL that may carry an API key.
- The signer object itself (e.g. `console.log(signer)` —
  some signer implementations include the private key in the
  inspection output).

### 3.5 Operator-only secret-touching commands

The following are reserved for the OPERATOR running from a
trusted workstation:

- `wrangler secret put <NAME>` (writes a Cloudflare secret).
- `gh secret set <NAME>` (writes a GitHub Actions secret).
- `op read op://...` (reads from 1Password CLI).
- Hardhat scripts that broadcast on mainnet.

An agent MAY draft these commands in a PR / runbook so the
operator can copy-paste them, but the agent MUST NOT execute
them.

## 4. Production rule

### 4.1 Production private keys

**Production private keys MUST NOT be stored in repo-local `.env`.**
They live in:

- Hardware Security Module (HSM): YubiHSM, AWS CloudHSM, GCP
  Cloud HSM.
- Key Management Service (KMS): AWS KMS, GCP KMS — only the
  key reference is in env; signing is delegated.
- Multi-Party Computation (MPC) custody: Fireblocks, Coinbase
  Cloud, ZenGo for Business, etc.
- Vendor-managed signer service (the H-3 external-signer
  pattern: the signer service holds the key in its own custody
  layer; the worker calls it via service-binding).
- Operator-only ceremony (Safe / multisig with hardware-backed
  signers): the operator signs from their hardware wallet
  during a live ceremony; no automation, no key in any file.

### 4.2 Agent boundaries in production

Agents MAY:

- Draft mainnet deploy commands.
- Document the production cutover ceremony.
- Run dev/test versions of the same ceremony to validate the
  runbook.
- Open PRs that update production-pointing config files (e.g.
  contract addresses, network names), as long as the secret
  material itself is never in the diff.

Agents MUST NOT:

- Execute a mainnet deploy.
- Run `wrangler secret put` against the production
  environment.
- Touch production address records.
- Print production private keys or production RPC URLs in any
  form.

### 4.3 Incident response

If an agent accidentally prints any prefix or value of a
secret-typed variable, the following sequence is mandatory:

1. **Agent self-reports** in the same turn — explicit
   acknowledgement of which variable, how many bytes / hex
   chars leaked, and the recommended rotation.
2. **Operator decides** whether to rotate. For dev/test, the
   operator may opt to defer rotation if the leak is a single
   byte. For any production-tier variable, rotation is
   mandatory.
3. **Rotation evidence** is captured in the change-control
   record:
   - new key fingerprint (operator-only — the agent does not
     see this).
   - old key fingerprint marked retired.
   - audit-log entry capturing the rotation timestamp.
4. **If the leaked variable was a deployer key with on-chain
   custody** (owner of a deployed contract), the operator MUST
   either (a) `transferOwnership` to a fresh address before
   any further use, or (b) treat the contract as
   compromised-pending-rotation.

## 5. Test surface

The test
`test/guardrails/agent-secret-command-guardrail.test.ts`
enforces:

1. **CLAUDE.md contains the BAN list summary.** Hard-required
   strings: every literal listed in §2 of this doc must appear
   in `CLAUDE.md` somewhere (under a single section header
   "Agent secret-handling").
2. **`docs/security/agent-secret-handling.md` exists and is
   non-empty.**
3. **No deploy / signer script logs a banned env value.**
   Grep every `*.ts` / `*.js` / `*.sh` under `scripts/`,
   `src/scripts/`, and `tools/` for `process\.env\.DEPLOYER_PRIVATE_KEY`,
   `process\.env\..*PRIVATE.*`, `process\.env\..*SECRET.*`,
   `process\.env\..*MNEMONIC.*`, `process\.env\..*RPC_URL`
   immediately followed by `console.log` / `console.error` /
   `process.stdout.write` / `process.stderr.write` /
   template-interpolation in a logged string. Allow uses where
   the value is **consumed** (passed to ethers / wrangler) but
   not logged.
4. **Evidence docs don't carry secret-shaped literals.** Grep
   every `docs/deployments/devtest/*.md` and any
   `docs/deployments/staging/*.md` for:
   - `-----BEGIN [A-Z ]*PRIVATE KEY-----`
   - bare 64-hex strings near the words `PRIVATE`,
     `SECRET`, `DEPLOYER`, `MNEMONIC`, `SEED`, `KEY`.
   - URLs ending in `/v2/...?key=...` (RPC API key in the
     query string).
5. **No banned shell literal in any committed file** (the
   ban-list strings themselves are allowed only in the two
   designated docs and in this test file's
   `BANNED_COMMAND_LITERALS` constant).

CI runs `npm test` on every PR; a guardrail violation fails
the PR before any human review.

## 6. Failure modes the guardrail does NOT cover

The guardrail catches static / textual leaks. It does NOT
catch:

- **A leaked secret transmitted over the network** (e.g. a
  deploy script that POSTs the env to a remote logger). The
  mitigation is operator review of every new `fetch(` /
  `axios.` / `http.request(` call site in a `scripts/` PR.
- **A leaked secret typed by the operator in the chat
  interface.** If the operator pastes a private key as part
  of a question, the agent SHALL refuse to incorporate it
  into any committed artifact and SHALL recommend rotation.
- **A leaked secret in a binary artifact** (e.g. a compiled
  contract artifact that embedded a constructor arg by
  mistake). Out of scope; covered by the existing custody
  guardrails on `escrow.writer` etc.

## 7. Status language (do not weaken)

- Agent secret-handling: **HARDENED at the CLAUDE.md +
  docs/security + tests/guardrails layer**. CI enforces.
- Production secret custody: still operator-only, HSM / KMS /
  MPC / vendor / multisig ceremony.
- Production launch: BLOCKED on the rest of the audit punch
  list. This guardrail closes one rung; it does not unblock
  production by itself.
