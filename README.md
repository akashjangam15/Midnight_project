# Midnight Counter (my-project)

> A Compact smart contract on Midnight that keeps its counters' inputs secret: it publishes a running total while proving the increments were valid, without ever revealing the amounts that produced them.

---

## Contract Address

| Network  | Address                                                      |
|----------|--------------------------------------------------------------|
| Preprod  | `6745a61f76cfce55cd4701213a2f79940c919d62725208628a523a0554f69fe3` |

| | |
|---|---|
| Deployer | `mn_addr_preprod1e8rhyn2ulgwpznqarcduj9tu68650dr5qlxt2xmsvaywc0trccys3j0uzx` |
| Deployed at | 2026-09-26T05:44:33Z |

Recorded in `my-project/.midnight-state.json` → `deployments.preprod.address`.

Verified on chain — the public ledger read back as `count = 0`, `updateCount = 0`, `publishedMessage = ""`:

```bash
cd my-project && npm run test:e2e
# ✅ e2e-check passed
#    contractAddress: 6745a61f76cfce55cd4701213a2f79940c919d62725208628a523a0554f69fe3
#    network:          preprod
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

- **Midnight network** — privacy-first blockchain; deployed to `preprod`
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
| Funded wallet | Only for deploying — the deploy script prints the address. The preprod wallet is already funded (5,000 tNIGHT). A local devnet needs no funding. |
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
#    NOTE: on preprod use the fast-path script instead (see Deployment above):
#    npx tsx src/deploy-preprod-fast.ts
npm run deploy -- --network preprod

# 7. Talk to the deployed contract
npm run cli
```

Other useful commands:

```bash
npm run network preprod               # set/show the active network
npm run check-balance -- --network preprod
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

## Idea: campaign rewards platform

> A loyalty/rewards platform where companies run campaigns on-chain, customers claim tokens for verifiable purchases (physical and digital) via a QR-linked per-unit credential, and the conversion value rises with the campaign's verifiable performance — privacy-first, with private purchase inputs and public aggregate telemetry.

This is the longer-term target the counter contract is pointing at. The counter in `my-project/` is the smallest useful piece: private witness inputs, a public aggregate, and one deliberate `disclose()` — the same shape every campaign-telemetry contract here will follow.

---

### Problem

Loyalty programmes are broken in both directions. Companies spend heavily on campaigns and buy "engagement" from platforms that report numbers they cannot audit, while customers earn points that are opaque, expire, and are trapped inside a single brand's app. Nobody can verify the campaign's real performance, the customer has no proof of what they earned, and the purchase data that produced it all gets hoovered up and sold.

A public blockchain makes the privacy problem worse, not better: it would publish every customer's purchase history forever. That is a worse outcome than the points system it replaces.

---

### Refined concept

A platform where companies run campaigns on-chain, both **physical and digital products** can qualify, and every qualifying purchase earns the customer tokens tied to that campaign. The customer claims privately and converts to Midnight's token when they want to use it elsewhere.

**The distinctive part is not "tokens for purchases."** It is:

- purchase verification **without revealing who bought what or when**
- **"this unit was claimed exactly once"** enforceable by proof, while the product code stays secret
- campaign performance **published as aggregate totals**, not as a marketing dashboard's claim
- conversion value **driven by a deterministic rule over verifiable inputs**, not by a promise

---

### How a campaign works (refined)

1. **A company launches a campaign** — qualifying product set (physical + digital), earn per unit, run window, value formula, conversion backing, and who may update performance.
2. **A customer acquires a qualifying unit.** The unit carries a **per-unit credential** that makes the purchase verifiable without publishing the customer's identity or purchase history.
3. **The customer claims tokens for that unit** by QR/code UX, proved by ZK: the unit is valid for the campaign and has not been claimed before, while the credential and customer identity stay private.
4. **Campaign performance is measured as public aggregate** — units claimed, redemptions, sell-through signals the company signs — and feeds the value formula.
5. **The customer converts claimed tokens to Midnight's token** at the current rate and uses them anywhere in the ecosystem, instead of leaving them brand-locked.

---

### Per-unit credential model (the hard part)

The QR code is **one layer of the UX**, not the only secret. The design should treat the per-unit credential as the thing that actually makes the proof possible.

**Physical product — two layers, both needed:**

- **Per-unit secret** — a code/secret bound to that individual unit, tamper-evident on the product or packaging. It should differ per unit (a shared batch secret is weak: one leaked code defeats the batch).
- **Merchant attestation at point of sale** — an attestation that this unit was sold/activated, issued at purchase. This ties the credential to a real sale event rather than a scavenged code.

The QR the customer scans can encode or reference the per-unit secret in a single-use or wallet-bound way, or act as a one-time claim coupon for a unit the customer already bought. It should **not** be a reusable, photographable universal code.

**Digital product — simpler:** the platform issues a non-transferable entitlement at purchase, tied to the transaction, claimable privately. Digital is the easier half and is a good reference implementation before touching physical.

**Double-claim defence.** The claim proof enforces **"claimed exactly once" per unit**. The platform database is not the source of truth; the ZK proof is. The campaign picks a structure for "has not been claimed before" — nullifier-style commitment, used-set, or per-unit state transition — depending on how much privacy vs auditability it wants. That choice is one of the real design forks.

---

### Value formula (performance → value)

"Campaign performance sets the value" only becomes a real contract when it is a **deterministic rule over public, verifiable inputs**, with the update authority and frequency explicit.

**Inputs that are actually measurable:**

- `unitsClaimed` — public aggregate from the ledger
- `redeemedCount` — public aggregate
- Participation / sell-through signals the company publishes **and signs** (auditable, not just asserted)
- Time-window behaviour — e.g., stronger early participation boosts the rate, or the rate ramps over the window

**Example formula shape (illustrative, not final):**

```
rate = baseRate
      + participationBonus(unitsClaimed relative to target)
      + redemptionSignal(redeemedCount relative to unitsClaimed)
      + timeWindowModifier(current time within campaign window)
```

The formula should be **public, deterministic, and auditable.** The company cannot quietly rewrite it after the fact; the on-chain state reflects the inputs, and the rate is derived from them.

**Who updates performance, and how often:**

- Some inputs are automatic — `unitsClaimed` and `redeemedCount` come straight from the ledger, not from a company assertion.
- The company pushes **signed performance snapshots** on a schedule (e.g., daily or per milestone), rate-limited and auditable.
- The formula should only use inputs that are verifiable; otherwise the company can lie to the dashboard.

This is a governance detail that determines whether the value promise is real. More on-chain aggregate = more trustworthy but less expressive. Signed company snapshots = more signal but more trust in the company's signing and the semantics of its numbers.

---

### Conversion backing (pick a lane early)

This decision changes the architecture a lot.

**Lane A — company-funded redemption pool:**

- The company commits funds to a pool; the rate is set by the company against that pool.
- Conversion is essentially "claimed tokens → pool-funded Midnight tokens at the current rate."
- Lower complexity; the risk sits with the company (underfunded pool, rate promises it cannot meet, pool-exhaustion timing).
- The more natural fit for a first provable version and for a campaign-telemetry demo.

**Lane B — market-rate liquidity:**

- Needs a liquidity source and a price-discovery mechanism.
- More complex; the value is less "company performance" and more "market dynamics."
- Different risk profile and a different contract skeleton.

**Recommendation for a first version:** start with Lane A for the demonstrable loop — company commits to a pool, rate is a deterministic function of public performance, conversion drains the pool. That keeps the first contract version focused on the privacy + aggregate + value-formula story, which is the distinctive part. Layer market liquidity later if wanted.

---

### Why Midnight fits

Privacy is the right call here, not decoration. The purchase-verified rewards loop touches two things people refuse to hand over: **who bought what, and when**.

Midnight lets the same guarantees be checked while keeping the inputs private:

- a purchase entitles you to a claim **without revealing which customer you are or what else you bought**
- the platform can prove **"this unit was claimed exactly once"** while the product code stays secret
- campaign performance can be **published as aggregate totals** — exactly the primitive this repo's counter demonstrates: *private increments in, public totals out*
- every disclosure is a **single auditable call** (`disclose()`), not a leak
- the anti-abuse rules are enforced by the proof, so trust shifts from "the platform's database says so" to a verifiable statement

---

### What exists in this repo today

The counter in `my-project/` is the smallest useful piece of the platform, built and deployed for real: private witness inputs, a public aggregate, and one deliberate `disclose()` — the shape every "campaign telemetry without leaking individual purchases" contract will follow.

---

### Open design questions

- **How is value decided?** "Campaign performance" has to become a deterministic rule: a formula over public, verifiable inputs, plus who is allowed to update it and how often.
- **How does a physical purchase become a claimable token?** Per-unit secret (tamper-evident code on the product), merchant attestation at the point of sale, or both — and each option needs its own double-claim defence.
- **What is the per-unit credential, exactly?** The QR is a UX layer; the credential is what makes the proof possible. Physical needs per-unit secret + merchant attestation; digital can use a non-transferable entitlement.
- **How do we enforce "claimed exactly once"?** Pick the anti-double-claim structure — nullifier/commitment, used-set, or per-unit state transition — based on the privacy vs auditability trade-off.
- **What backs the conversion into Midnight's token?** A company-funded redemption pool means a rate the company sets; a market rate needs a liquidity source. These are very different contracts and very different risk profiles.
- **Regulatory exposure.** A token whose value is driven by campaign performance reads as a financial instrument in many jurisdictions; the design should assume that until proven otherwise.

---

Suggested captures:

1. `docs/screenshots/compile.png` — output of `npm run compile` (`Compiling 3 circuits:` and the four `managed/counter/` directories)
2. `docs/screenshots/deploy.png` — the deploy tail showing `✅ Contract deployed successfully!` and `Contract Address: 6745a61f…69fe3`
3. `docs/screenshots/tests.png` — `npm test` showing `# pass 5`
4. `docs/screenshots/cli.png` — the CLI's public-ledger vs private-state menu output
