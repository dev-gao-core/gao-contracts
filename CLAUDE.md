# Claude Code engineering rules — gao-contracts

These rules govern how Claude Code (and any AI assistant) operates
inside the `dev-gao-core/gao-contracts` repository. Read them
before any audit, fix, deploy, migration, test, or release task.
They are normative for every session and override anything inferred
from training or general defaults.

---

## 1. GitHub source of truth

- The GitHub remote is the only canonical source of truth.
- For this repo, `origin/main` is the canonical base branch unless
  the user explicitly says otherwise.
- Local branches, local files, and worktrees are temporary working
  copies. They are never authoritative.
- Always fetch `origin` and inspect `git status` before starting
  work.

## 2. Deployment safety

- This repo targets DEV/TEST only unless explicitly stated otherwise.
- Mainnet / production deploys require operator-only ceremony from
  a trusted workstation with operator-held custody material.
- Agents MAY draft mainnet deploy commands but MUST NOT execute
  them.
- The dev/test deploy script (`scripts/deployGaoDomainDepositV3.devtest.ts`)
  enforces a chain-id allowlist + mainnet banlist; agents MUST NOT
  weaken either set.

## 3. No AI attribution

Never include AI/Claude attribution in:

- commit messages
- PR titles / bodies / code comments / changelogs / docs / final
  summaries

The following are forbidden:

- `Generated with Claude Code`
- `Co-Authored-By: Claude`
- `AI-generated`
- Any similar AI/assistant attribution footer

## 4. Agent secret-handling — BAN list + ALLOW list

> **Normative for every agent session, no matter how short, no
> matter how dev/test the tier looks.** See
> `docs/security/agent-secret-handling.md` for the full rationale,
> the threat model, the production-tier rules, and the incident
> response sequence. The summary below is the agent-facing
> checklist; the long-form doc is the canonical reference.

### 4.1 Hard-banned commands

The agent MUST NOT run any of the following or any rough
equivalent. This is enforced by
`test/guardrails/agent-secret-command-guardrail.test.ts`.

**Read of a secret file:**

- `cat .env` · `cat .env.*` · `cat .dev.vars` · `cat *.pem` ·
  `cat *.key` · `cat mnemonic*` · `cat id_rsa*` · `cat seed.txt`
- `less .env` · `more .env`
- `head .env` · `head -1 .env` · `tail .env`
- `sed -n '...' .env` · `awk '...' .env` (when it emits the value)
- `grep ... .env` · `rg ... .env` (when the match line carries the value)
- `hexdump .env` · `hexdump -C .env` · `xxd .env` · `od .env` ·
  `od -An -c .env` · `strings .env`

**Print env values:**

- `echo $DEPLOYER_PRIVATE_KEY` (or any private-key / secret /
  RPC URL / mnemonic variable)
- `printenv` · `printenv DEPLOYER_PRIVATE_KEY` · `env` ·
  `env | grep …` · `set | grep …` · `export | grep …`
- `node -e "console.log(process.env.DEPLOYER_PRIVATE_KEY)"`
- `node -e "console.log(JSON.stringify(process.env))"`
- `python -c "import os; print(os.environ['DEPLOYER_PRIVATE_KEY'])"`
- `python -c "import os; print(dict(os.environ))"`

**Secret-store CLIs:**

- `gh secret list` · `gh secret set` · `gh secret delete`
- `wrangler secret list` · `wrangler secret put` ·
  `wrangler secret delete` (unless the operator explicitly
  approves an exact step)
- `aws secretsmanager get-secret-value`
- `gcloud secrets versions access`
- `op read op://...` (1Password CLI fetch)
- `kubectl get secret <name> -o yaml`

**Deploy / signer scripts that log a secret:**

- `console.log(process.env.DEPLOYER_PRIVATE_KEY)` (and any
  similar form: template literal, JSON.stringify, etc.)
- `console.log(process.env)` (whole-env dump)
- Logging an RPC URL that may embed an API key (Alchemy,
  Infura, QuickNode keys are part of the URL itself).
- Logging the signer object itself (`console.log(signer)`) —
  some signer implementations include the private key in the
  inspection output.

### 4.2 Allowed safe operations

**List env variable NAMES only:**

```sh
node -e "const fs=require('fs'); for (const l of fs.readFileSync('.env','utf8').split(/\r?\n/)) { const m=l.match(/^([A-Z0-9_]+)=/); if (m) console.log(m[1]); }"
```

**Presence check (KEY=SET / KEY=MISSING):**

```sh
node -e "require('dotenv').config(); for (const k of ['BASE_SEPOLIA_RPC_URL','DEPLOYER_PRIVATE_KEY']) console.log(k + '=' + (process.env[k] ? 'SET' : 'MISSING'))"
```

**Derive PUBLIC address from private key** (operator-approved
only; output is the public address, NEVER the private key):

```js
const { Wallet } = require("ethers");
const w = new Wallet(process.env.DEPLOYER_PRIVATE_KEY);
console.log(`deployer public address: ${w.address}`);
```

**Always-public values an agent MAY log freely:**

- chainId, network name
- Signer's `address` (public address)
- Public contract addresses, tx hashes, block numbers
- Public allowed-token addresses
- Public RPC URLs that explicitly contain no API key
  (e.g. `https://sepolia.base.org`)

### 4.3 Never output

- Private keys (full or any non-zero-length prefix).
- Mnemonics / seed phrases (any number of words).
- RPC URLs that embed an API key (any
  `*.alchemyapi.io/v2/<KEY>`, `*.infura.io/v3/<KEY>`,
  `quiknode.pro/<KEY>`, etc.).
- HMAC secrets, API keys, JWTs.
- Cloudflare / GitHub / AWS / GCP tokens.
- PEM contents (BEGIN/END PRIVATE KEY lines).

### 4.4 Production rule

- Production private keys MUST NOT live in repo-local `.env`.
- Production deploy uses HSM / KMS / MPC / vendor signer /
  operator-only multisig ceremony.
- Agents MAY draft mainnet deploy commands but MUST NOT
  execute them.
- Production secrets are operator-only; the agent never reads
  them.

### 4.5 Incident response

If the agent accidentally emits any prefix of a secret-typed
value:

1. Self-report in the same turn — variable name, byte count,
   recommended rotation.
2. Operator decides on rotation (mandatory for any
   production-tier variable; dev/test is operator's call for
   single-byte leaks).
3. Rotation evidence captured in the operator change-control
   record.
4. If the leaked variable was a deployer with on-chain
   custody, `transferOwnership` to a fresh address before any
   further use.

Full incident protocol in
`docs/security/agent-secret-handling.md` §4.3.

## 5. Final response format

Every final task report must include:

```
## Status
PR open / Ready to merge / Merged / Deployed / Blocked

## Repository
dev-gao-core/gao-contracts

## Base Branch
main

## Branch
<branch>

## Commit
<hash>

## PR
<url or "not created">

## Changed Files
<list>

## Checks
- npx hardhat compile
- npx hardhat test
- deploy verification (if applicable)

## Notes
Risks, assumptions, follow-up work.
```
