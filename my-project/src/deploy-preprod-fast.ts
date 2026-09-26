/**
 * FAST-PATH PREPROD DEPLOY — works around servicedesk issue #104
 * (preprod fresh-wallet genesis sync never satisfies isSynced).
 *
 * Why this is safe for THIS wallet (not a general-purpose deploy):
 *   • All funds are UNSHIELDED: exactly one faucet UTXO of 5,000 tNIGHT,
 *     never shielded, never spent. Verified on-chain via the indexer
 *     (tx 625608, hash 6d8b8043…). The shielded child will find ZERO
 *     shielded coins in all of preprod history, and the dust child has
 *     nothing to do until we register the UTXO for dust generation.
 *   • The deploy transaction is built and paid from the unshielded NIGHT
 *     UTXO (fees in DUST generated from it); the shielded child does not
 *     need to be at the tip to receive the change — it catches up later.
 *
 * Strategy instead of waitForSyncedState():
 *   1. Log real per-child telemetry (applied index vs indexer tip) every
 *      heartbeat — this doubles as the sync-progress probe.
 *   2. Proceed when:
 *        • the UNSHIELDED child (owner of the funds) reports
 *          isCompleteWithin(SYNC_GAP), AND
 *        • shielded + dust children have PLATEAUED: their appliedIndex
 *          stopped advancing for PLATEAU_MS while isConnected, AND
 *          their gap to the tip is at most STALL_GAP.
 *      A hard deadline caps the wait; the wallet keeps running so its
 *      children continue syncing in the background during deploy steps.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

import { resolveNetwork, getOrCreateWallet, recordDeployment } from './network';
import { createWallet, persistWalletState, unshieldedToken, type WalletContext } from './wallet';
import { createCounterPrivateState, witnesses } from './witnesses';
import type * as CounterContract from '../managed/counter/contract/index.js';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

const PRIVATE_STATE_ID = 'counterPrivateState';

// ─── Tunables (env-overridable) ────────────────────────────────────────────────
const HEARTBEAT_MS = 30_000; // telemetry cadence
const PLATEAU_MS = 3 * 60_000; // no appliedIndex movement for this long → settled
const SYNC_GAP = 20n; // "close enough to tip" for the unshielded child
const STALL_GAP = 5_000n; // plateau only counts if we're within this of the tip
const HARD_DEADLINE_MS = 30 * 60_000; // absolute cap on the sync phase

// ─── Sync telemetry ────────────────────────────────────────────────────────────

type Progress = {
  appliedIndex: bigint;
  highestRelevantWalletIndex: bigint;
  isConnected: boolean;
};

function childProgress(child: any): Progress | undefined {
  try {
    const p = child.progress;
    if (!p) return undefined;
    // Fields can be individually undefined depending on child kind / phase —
    // coerce defensively so telemetry never crashes.
    return {
      appliedIndex: BigInt(p.appliedIndex ?? 0),
      highestRelevantWalletIndex: BigInt(p.highestRelevantWalletIndex ?? 0),
      isConnected: p.isConnected === true,
    };
  } catch {
    return undefined;
  }
}

function fmt(n: bigint): string {
  return n.toLocaleString('en-US');
}

function logTelemetry(label: string, p: Progress | undefined): void {
  if (!p) {
    console.log(`  ${label.padEnd(11)} (no progress data)`);
    return;
  }
  const gap = p.highestRelevantWalletIndex - p.appliedIndex;
  const near = p.isConnected && gap <= SYNC_GAP ? '✓' : '…';
  console.log(
    `  ${label.padEnd(11)} applied ${fmt(p.appliedIndex)} / tip ${fmt(p.highestRelevantWalletIndex)}` +
      ` (gap ${fmt(gap < 0n ? 0n : gap)}) ${near}`,
  );
}

/**
 * Resolve when unshielded is near-tip AND shielded+dust have plateaued,
 * or when the hard deadline hits (log says which).
 */
async function waitForUsableSync(walletCtx: WalletContext): Promise<void> {
  const start = Date.now();
  // Applied index at the previous heartbeat, per child.
  let prev = { shielded: -1n, unshielded: -1n, dust: -1n };
  // Timestamp (ms) of the last movement per child.
  let lastMove = { shielded: Date.now(), unshielded: Date.now(), dust: Date.now() };
  let plateauSince: number | undefined;

  while (true) {
    // Sample the facade's combined state: each field is the child's latest
    // emitted state object, which carries `.progress` (SyncProgress).
    let snap: any;
    try {
      snap = await Rx.firstValueFrom(
        walletCtx.wallet.state().pipe(Rx.timeout({ first: 20_000 })),
      );
    } catch {
      snap = undefined; // children haven't emitted yet — report and retry
    }    const s = snap ? childProgress(snap.shielded) : undefined;
    const u = snap ? childProgress(snap.unshielded) : undefined;
    const d = snap ? childProgress(snap.dust) : undefined;

    const elapsedMin = ((Date.now() - start) / 60_000).toFixed(1);
    const coinCount = snap?.unshielded?.availableCoins?.length ?? 0;
    console.log(`\n  ── sync telemetry @ ${elapsedMin} min ──`);
    logTelemetry('shielded', s);
    logTelemetry('unshielded', u);
    logTelemetry('dust', d);
    console.log(`  unshielded availableCoins: ${coinCount}  <- funding UTXO gate`);

    const now = Date.now();
    for (const [name, p] of [['shielded', s], ['unshielded', u], ['dust', d]] as const) {
      if (p && p.appliedIndex !== prev[name]) {
        prev[name] = p.appliedIndex;
        lastMove[name] = now;
      }
    }

    // Readiness = the unshielded child SEEING the funding UTXO (all funds are
    // unshielded; nothing else on this wallet matters for the deploy tx) AND
    // the shielded scan having settled. Registration + the checkpointed DUST
    // wait happen AFTER the gate, while the dust child keeps scanning.
    const uReady = coinCount > 0;
    const shieldedSettled = now - lastMove.shielded >= PLATEAU_MS;

    if (uReady && shieldedSettled) {
      console.log('\n  ✓ usable sync reached (funding UTXO visible; shielded scan settled).');
      return;
    }

    if (now - start >= HARD_DEADLINE_MS) {
      console.log(`\n  ⚠ sync hard deadline hit — proceeding (funding UTXO seen: ${coinCount > 0}).`);
      console.log('    (funds are unshielded; shielded/dust children continue syncing in background)');
      return;
    }

    await new Promise((r) => setTimeout(r, HEARTBEAT_MS));
  }
}

/** Wait until the given predicate over the facade state holds, with a cap. */
async function waitForState(
  walletCtx: WalletContext,
  predicate: (s: any) => boolean,
  what: string,
  timeoutMs: number,
): Promise<any> {
  try {
    return await Rx.firstValueFrom(
      walletCtx.wallet.state().pipe(
        Rx.filter(predicate),
        Rx.timeout({ first: timeoutMs }),
      ),
    );
  } catch {
    console.log(`  ⚠ ${what}: condition not met within ${Math.round(timeoutMs / 60_000)} min — proceeding anyway.`);
    // Best-effort snapshot instead of throwing.
    return await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.take(1)));
  }
}

// ─── Setup (mirrors deploy.ts; kept local so the fast path is self-contained) ──

async function waitForProofServer(url: string, maxAttempts = 60, delayMs = 2000): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fetch(url, { method: 'GET', signal: AbortSignal.timeout(3000) });
      return true;
    } catch (err: any) {
      const code = err?.cause?.code || err?.code || '';
      if (code !== 'ECONNREFUSED' && code !== 'UND_ERR_CONNECT_TIMEOUT' && code !== 'UND_ERR_SOCKET') {
        return true;
      }
    }
    if (attempt < maxAttempts) {
      process.stdout.write(`\r  Waiting for proof server... (${attempt}/${maxAttempts})   `);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'managed', 'counter');
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');

const initialStepEnv = process.env.COUNTER_STEP?.trim();
const INITIAL_PRIVATE_STATE = createCounterPrivateState(
  initialStepEnv ? Number(initialStepEnv) : 1,
  process.env.COUNTER_MESSAGE?.trim() || 'counter deployed from my-project',
);

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  FAST-PATH deploy — counter → preprod (issue #104 workaround) ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const { network, config: networkConfig } = resolveNetwork();
  if (network !== 'preprod') {
    console.error(`❌ This script is preprod-only (active network: ${network}).`);
    console.error('   Switch first:  npm run network preprod\n');
    process.exit(1);
  }
  const WALLET = getOrCreateWallet(network);
  const seed = WALLET.seed;

  if (!fs.existsSync(contractPath)) {
    console.error('\n❌ Contract not compiled! Run: npm run compile\n');
    process.exit(1);
  }
  const Counter = (await import(pathToFileURL(contractPath).href)) as typeof CounterContract;
  const compiledContract = CompiledContract.make('counter', Counter.Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );

  console.log('─── Wallet setup ───────────────────────────────────────────────\n');
  console.log('  Creating wallet...');
  const walletCtx = await createWallet({ network, networkConfig, seed });
  const restoredCount = Object.values(walletCtx.restored).filter(Boolean).length;
  if (restoredCount > 0) {
    console.log(`  Restored ${restoredCount}/3 child wallets from .midnight-wallet-state.`);
  }

  console.log('\n  Syncing with fast-path gate (telemetry below; not waiting for isSynced)...\n');
  await waitForUsableSync(walletCtx);

  // Persist whatever sync state we have — later runs resume from here.
  await persistWalletState(network, walletCtx);
  console.log('  ✓ wallet state checkpoint saved.');

  const address = walletCtx.unshieldedKeystore.getBech32Address();

  // Balance read from a live snapshot (no isSynced filter — it may never fire).
  const snap = await waitForState(walletCtx, () => true, 'state snapshot', 30_000);
  const balance = snap.unshielded.balances[unshieldedToken().raw] ?? 0n;
  console.log(`\n  Wallet Address: ${address}`);
  console.log(`  Balance: ${balance.toLocaleString()} tNight\n`);

  if (balance === 0n) {
    console.error('❌ Wallet shows 0 tNIGHT. The faucet tx (625608) should have funded it.');
    console.error('   Re-run after re-checking funding; do NOT re-faucet blindly.\n');
    await walletCtx.wallet.stop();
    process.exit(1);
  }

  // ─── DUST registration ──────────────────────────────────────────────────────
  console.log('─── DUST Token Setup ───────────────────────────────────────────\n');
  const dustState = await waitForState(
    walletCtx,
    (s) => s.unshielded.availableCoins.length > 0,
    'available UTXOs',
    5 * 60_000,
  );
  const unregisteredUtxos = (dustState.unshielded.availableCoins as any[]).filter(
    (c) => !c.meta?.registeredForDustGeneration,
  );
  if (unregisteredUtxos.length > 0) {
    console.log(`  Registering ${unregisteredUtxos.length} NIGHT UTXOs for DUST generation...`);
    // signDustRegistration's callback already produces correctly-signed recipe
    // (do NOT double-sign — InputsSignaturesLengthMismatch / custom error 192).
    const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
      unregisteredUtxos,
      walletCtx.unshieldedKeystore.getPublicKey(),
      (payload) => walletCtx.unshieldedKeystore.signData(payload),
    );
    const finalized = await walletCtx.wallet.finalizeRecipe(recipe);
    await walletCtx.wallet.submitTransaction(finalized);
    console.log('  Registration tx submitted.');
  } else {
    console.log('  All NIGHT UTXOs already registered for DUST generation.');
  }

  if (dustState.dust.balance(new Date()) === 0n) {
    console.log('  Waiting for DUST tokens...');
    // DUST becomes spendable only when the dust child's scan reaches the tx.
    // That can take hours on preprod (issue #104) — so instead of one bounded
    // Rx wait (which would abort and waste ALL scan progress), loop in 10-min
    // windows, checkpointing wallet state after every window so an interrupt
    // never costs more than 10 minutes of scanning.
    const dustDeadline = Date.now() + DUST_WAIT_TOTAL_MS;
    let dustOk = false;
    while (Date.now() < dustDeadline) {
      try {
        await Rx.firstValueFrom(
          walletCtx.wallet.state().pipe(
            Rx.throttleTime(5000),
            Rx.filter((s: any) => s.dust.balance(new Date()) > 0n),
            Rx.timeout({ first: DUST_WINDOW_MS }),
          ),
        );
        dustOk = true;
        break;
      } catch {
        const left = Math.round((dustDeadline - Date.now()) / 60000);
        console.log(`  ⏳ no DUST yet — checkpointing wallet state and continuing (${left} min of budget left)...`);
        await persistWalletState(network, walletCtx);
      }
    }
    if (!dustOk) {
      console.log(`\n  ❌ No DUST generated within ${Math.round(DUST_WAIT_TOTAL_MS / 3600000)} h.`);
      console.log('  DUST comes from registered NIGHT UTXOs and pays tx fees.');
      console.log('  Wallet state was checkpointed — re-run to resume from the latest point.');
      await walletWalletStopSafe(walletCtx);
      process.exit(1);
    }
  }
  console.log('  DUST tokens ready!\n');

  // ─── Deploy ─────────────────────────────────────────────────────────────────
  console.log('─── Deploy Contract ────────────────────────────────────────────\n');
  console.log('  Checking proof server...');
  if (!(await waitForProofServer(networkConfig.proofServer))) {
    console.log('\n  ❌ Proof server not responding. Run: npm run proof-server:start\n');
    await walletCtx.wallet.stop();
    process.exit(1);
  }
  process.stdout.write('\r  Proof server ready!                                 \n');

  const privateStatePassword =
    process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';

  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'counter-state',
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  // DUST balance is a time-projection; sleep ~1 block so attempt 1 balances.
  process.stdout.write('  Generating DUST...');
  await new Promise((r) => setTimeout(r, 6000));
  process.stdout.write(' done.\n');

  console.log('  Deploying contract...\n');
  const MAX_RETRIES = 20;
  const RETRY_DELAY_MS = 5000;
  let deployed: Awaited<ReturnType<typeof deployContract>> | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      deployed = await deployContract(providers, {
        compiledContract: compiledContract as any,
        args: [],
        privateStateId: PRIVATE_STATE_ID,
        initialPrivateState: INITIAL_PRIVATE_STATE,
      });
      break;
    } catch (err: any) {
      const errMsg = err?.message || err?.toString() || '';
      const errCause = err?.cause?.message || err?.cause?.toString() || '';
      const fullError = `${errMsg} ${errCause}`;

      const isDustShortage =
        fullError.includes('Not enough Dust') ||
        fullError.includes('Insufficient Funds') ||
        fullError.includes('could not balance dust');

      if (!(isDustShortage && attempt === 1)) {
        console.error(`\n  Attempt ${attempt} error: ${errMsg}`);
        if (errCause && errCause !== errMsg) console.error(`  Cause: ${errCause}`);
      }

      if (
        !isDustShortage &&
        (fullError.includes('Failed to connect to Proof Server') ||
          fullError.includes('connect ECONNREFUSED 127.0.0.1:6300'))
      ) {
        console.log('  ❌ Proof server unreachable. Run: npm run proof-server:start\n');
        await walletCtx.wallet.stop();
        process.exit(1);
      }

      if (isDustShortage) {
        if (attempt < MAX_RETRIES) {
          console.log(`  ⏳ DUST shortage (attempt ${attempt}/${MAX_RETRIES}); retrying in ${RETRY_DELAY_MS / 1000}s...`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        } else {
          console.log(`  ❌ Not enough DUST after ${MAX_RETRIES} retries.`);
          await walletCtx.wallet.stop();
          process.exit(1);
        }
      } else {
        throw err;
      }
    }
  }

  if (!deployed) throw new Error('Deployment failed after all retries');

  const contractAddress = deployed.deployTxData.public.contractAddress;
  console.log('  ✅ Contract deployed successfully!\n');
  console.log(`  Contract Address: ${contractAddress}\n`);

  console.log('  ─── Public ledger state (what anyone can read) ───\n');
  try {
    const onChain = await providers.publicDataProvider.queryContractState(contractAddress);
    if (onChain) {
      const publicLedger = Counter.ledger(onChain.data);
      console.log(`  count:            ${publicLedger.count}`);
      console.log(`  updateCount:      ${publicLedger.updateCount}`);
      console.log(`  publishedMessage: ${JSON.stringify(publicLedger.publishedMessage)}\n`);
    } else {
      console.log('  (not indexed yet — check again in a few seconds with: npm run cli)\n');
    }
  } catch (err: any) {
    console.log(`  (could not read state back: ${err?.message ?? err})\n`);
  }

  console.log('  ─── Private state (on this machine only) ───\n');
  console.log(`  privateStep:    ${INITIAL_PRIVATE_STATE.step}`);
  console.log(`  privateMessage: ${JSON.stringify(INITIAL_PRIVATE_STATE.message)}`);
  console.log('  Neither value above was published by deploying.\n');

  recordDeployment(network, contractAddress, address.toString());
  console.log('  Saved to .midnight-state.json\n');

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  console.log('─── Deployment complete ────────────────────────────────────────\n');
  console.log('  Next: npm run test:e2e   (or update .env first for the web UI)\n');
}

// DUST wait budget: the dust child must scan preprod history tip-ward before
// the registration tx becomes visible; on preprod that can take hours.
const DUST_WINDOW_MS = 10 * 60_000; // checkpoint cadence
// Total wall-clock budget for the DUST wait. Env-overridable so a resume run can
// wait out preprod's long scan (servicedesk #104) without a code edit. Default
// raised 6 h -> 12 h: the previous 6 h run expired while dust was still scanning.
const DUST_WAIT_TOTAL_MS =
  Number(process.env.MIDNIGHT_DUST_WAIT_TOTAL_MS ?? 12 * 60 * 60_000);

async function walletWalletStopSafe(walletCtx: WalletContext): Promise<void> {
  try {
    await walletCtx.wallet.stop();
  } catch {
    /* best-effort */
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
