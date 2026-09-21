# Midnight Counter (my-project)

> A Compact smart contract on Midnight that keeps its counters' inputs secret: it publishes a running total while proving the increments were valid, without ever revealing the amounts that produced them.

---

## Contract Address

| Network  | Address                                                      |
|----------|--------------------------------------------------------------|
| Preview  | `799afe68b3353f26ec9103fce6c9b3a67a85952ee8cf9e59134ce5662b4eb718` |
| Preprod  | _not deployed yet — [PASTE ADDRESS AFTER DEPLOY]_            |

Deployer wallet: `mn_addr_preview1euad6hf8ghztzn8vt686ywgm2e95hu36rltp9vwy07lrfrh82fasa53yh9`
Deployed: 2026-09-21T10:06:14Z · Recorded in `my-project/.midnight-state.json` → `deployments.preview.address`

Verified on chain — the public ledger read back as `count = 0`, `updateCount = 0`, `publishedMessage = ""`:

```bash
cd my-project && npm run test:e2e
# ✅ e2e-check passed
#    contractAddress: 799afe68b3353f26ec9103fce6c9b3a67a85952ee8cf9e59134ce5662b4eb718
```

---

## What This Does

A counter you can add to in public without ever publishing how much you added.

Anybody can read the total (`count`) and see how many times it was incremented (`updateCount`) — those live on-chain and are permanently visible. But the *amount* of each increment comes from a private witness: it is supplied on the user's own machine while the transaction's zero-knowledge proof is built, and only the proof is submitted. The chain learns that "the total increased by *some* positive amount the caller was entitled to supply", and nothing more.

Two increments of 3 and 5 are therefore indistinguishable on-chain from a single increment of 8: both leave the same public state. The contract can also hold a private note that is invisible until its owner deliberately discloses it with `publishMessage()`, which is the one circuit that puts that note on-chain on purpose.

The point is not the counter — it is the shape of the API: **private inputs in, public aggregate out, with every disclosure a single auditable call.**

---

## Privacy Model

**What is PUBLIC (on-chain, visible to anyone):**
- `ledger count: Uint<32>` — the running total
- `ledger updateCount: Uint<32>` — how many times `increment()` has run
- `ledger publishedMessage: Opaque<"string">` — empty until `publishMessage()` deliberately discloses it
- Every transaction that touched the contract, and each circuit that was called

**What is PRIVATE (private witness, never on-chain):**
- `witness privateStep(): Uint<32>` — the magnitude of each increment
- `witness privateMessage(): Opaque<"string">` — the contract's secret note
- The encrypted local private-state store that holds both (`.midnight-wallet-state/`, `midnight-level-db/`, both gitignored)

**What the user PROVES without revealing:**
- That the increment added a value greater than zero (`assert(step > 0)` holds)
- That the resulting total stayed inside `Uint<32>` (no overflow)
- That the new public `count` equals the old public `count` correctly incremented by *some* private amount
- That the state transition is valid — while the amount itself stays hidden

The Compact compiler's disclosure analysis enforces the boundary: a witness-derived value cannot flow into public state without an explicit `disclose()`. There are exactly two in the contract, both inside circuits whose names say what they publish — verify with:

```bash
cd my-project && grep -n "disclose" contracts/counter.compact
```

---

## Tech Stack

- **Midnight network** — privacy-first blockchain; target network here is `preview`
- **Compact** — Midnight's ZK smart-contract language (compiler pinned to `0.31.1`)
- **Node.js v22** — deploy tooling and tests (`>=22.0.0` required by the SDK)
- **Docker** — local proof server (`midnightntwrk/proof-server:8.1.0`), plus a full local devnet in `docker-compose.yml`
- **Midnight.js 4.1.1** — contracts/wallet SDK for deploy, CLI and e2e scripts
- **TypeScript + tsx** — the tooling is TS, run without a build step
- **node:test** — the unit-test runner (no extra framework dependency)

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js v22+ | `node -v` must report 22 or newer |
| npm | Bundled with Node |
| Compact compiler | `compact update 0.31.1` — pins the version this toolchain expects |
| Docker + Docker Compose | Needed for the proof server; proofs are generated locally even when deploying to a public network |
| Git | To clone the repo |
| Funded wallet | Only for deploying to preview/preprod — the deploy script prints the address and waits for the faucet (10 min default). A local devnet needs no funding. |
| Disk | ~1 GB for the two projects' `node_modules` |

---

## Setup

Step-by-step, from nothing to a deployed contract:

```bash
# 1. Clone (replace with your repository URL once the remote is added)
git clone <YOUR_REPO_URL> midnight_v1
cd midnight_v1/my-project

# 2. Install dependencies
npm install

# 3. Pin the Compact compiler to the version this project targets
compact update 0.31.1

# 4. Compile the contract → managed/counter/{contract,keys,zkir,compiler}
npm run compile

# 5. Start the local proof server (skip if one already listens on :6300)
npm run proof-server:start

# 6. Deploy. Selects/creates a wallet, waits for faucet funding if the
#    balance is 0, registers NIGHT for DUST, then deploys and prints the address.
npm run deploy -- --network preview

# 7. Talk to the deployed contract
npm run cli
```

Other useful commands:

```bash
npm run setup -- --network preview    # steps 5+4+6 in one go
npm run network preview               # set/show the active network
npm run check-balance -- --network preview
npm run build                         # tsc --noEmit
npm run clean                         # delete managed/, state file, wallet cache
```

**Repository layout.** The counter contract and its tooling live in `my-project/` (`contracts/counter.compact`, `managed/`, `src/`, `tests/`, `scripts/`). `mn-demo/` is the earlier hello-world deploy, kept as working reference. `SESSION_CONTEXT.txt` and `SESSION_CONTEXT2.txt` are session logs; the first is gitignored because it contains a wallet recovery phrase.

Environment variables you may need: `COUNTER_STEP` and `COUNTER_MESSAGE` (initial **private** state), `PRIVATE_STATE_PASSWORD` (≥16 chars), `MIDNIGHT_FAUCET_TIMEOUT_MS`, `MIDNIGHT_WALLET_MNEMONIC` / `MIDNIGHT_WALLET_SEED`.

---

## Run Tests

```bash
cd my-project
npm test
```

Five unit tests run the compiled contract directly against `compact-runtime` — no wallet, no node, no proof server, no network — in about 4 seconds:

```
ok 1 - increment() adds the private step to the public count
ok 2 - increment() refuses a non-positive private step
ok 3 - publishMessage() discloses the private note, and reset() clears only the public counters
ok 4 - private inputs are never exposed in the public ledger state
ok 5 - private state is JSON-serializable and fits Uint<32>
# tests 5
# pass 5
# fail 0
```

Test 4 is the privacy proof: it asserts the public ledger exposes exactly the three declared fields, that the secret note's raw bytes are absent from the encoded public state before `publishMessage()` and present after, and that the private step's own cell encoding never appears in public state even though its sum does.

Read-only check against the live deployment (needs a synced wallet, ~5 min):

```bash
npm run test:e2e
```

---

## Initial Idea

**The problem.** Loyalty programmes are broken in both directions. Companies spend heavily on campaigns and buy "engagement" from platforms that report numbers they cannot audit, while customers earn points that are opaque, expire, and are trapped inside a single brand's app. Nobody can verify the campaign's real performance, the customer has no proof of what they earned, and the purchase data that produced it all gets hoovered up and sold.

**The idea.** A platform where companies run their campaigns on-chain, and every physical product a customer buys earns them tokens tied to that specific campaign. The campaign's measured performance determines what those tokens are worth, and a customer can convert them into Midnight's token to use them across contracts and web3 products instead of leaving them stranded in one company's app.

### How a campaign works

1. **A company launches a campaign** on the platform — which products qualify, how much a qualifying purchase earns, and when it runs.
2. **A customer buys a physical product** in the real world. That purchase has to become something verifiable on-chain, one claim per unit.
3. **The customer claims their tokens** for that campaign — without publishing who they are or what else they bought.
4. **Campaign performance sets the value.** How well the campaign is actually going (verified participation, redemption, sell-through) drives the conversion rate rather than a marketing dashboard's claim.
5. **The customer converts to Midnight's token** and uses that anywhere in the ecosystem, rather than holding brand-locked points.

### Why Midnight

This is privacy-first by necessity, not by preference. A purchase-verified rewards scheme touches two things people refuse to hand over: **who bought what, and when**. A public blockchain would publish every customer's purchase history forever, which is a worse outcome than the points system it replaces. Midnight lets the same guarantees be checked while keeping the inputs private:

- a purchase entitles you to a claim **without revealing which customer you are or what else you bought**
- the platform can prove **"this unit was claimed exactly once"** while the product code stays secret
- campaign performance can be **published as aggregate totals** — which is exactly the primitive this repo's counter contract demonstrates: *private increments in, public totals out*
- the anti-abuse rules are enforced by the proof, so trust shifts from "the platform's database says so" to a verifiable statement

### What exists in this repo today

The counter in `my-project/` is the smallest useful piece of that platform, built and deployed for real: private witness inputs, a public aggregate, and one deliberate `disclose()` — the shape every "campaign telemetry without leaking individual purchases" contract will follow.

### Open design questions

- **How is value decided?** "Campaign performance" has to become a deterministic rule: a formula over public, verifiable inputs, plus who is allowed to update it and how often.
- **How does a physical purchase become a claimable token?** Per-unit secret (tamper-evident code on the product), merchant attestation at the point of sale, or both — and each option needs its own double-claim defence.
- **What backs the conversion into Midnight's token?** A company-funded redemption pool means a rate the company sets; a market rate needs a liquidity source. These are very different contracts and very different risk profiles.
- **Regulatory exposure.** A token whose value is driven by campaign performance reads as a financial instrument in many jurisdictions; the design should assume that until proven otherwise.

---

## Screenshots

_[PLACEHOLDER — to be added manually.]_

Suggested captures:

1. `docs/screenshots/compile.png` — output of `npm run compile` (`Compiling 3 circuits:` and the four `managed/counter/` directories)
2. `docs/screenshots/deploy.png` — the deploy tail showing `✅ Contract deployed successfully!` and `Contract Address: 799afe68…b718`
3. `docs/screenshots/tests.png` — `npm test` showing `# pass 5`
4. `docs/screenshots/cli.png` — the CLI's public-ledger vs private-state menu output
