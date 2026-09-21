/**
 * CLI for interacting with the deployed counter contract.
 *
 * The menu is deliberately split along the contract's public/private line:
 * options that only read or change PUBLIC ledger state (read, reset, balance)
 * need no witnesses, while increment() and publishMessage() feed PRIVATE
 * witnesses — option 5 shows that local private state, which the chain never
 * sees.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

// Midnight SDK imports
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateWallet, formatWalletBackupNotice, getDeployment } from './network';
import { createWallet, persistWalletState, unshieldedToken, type WalletContext } from './wallet';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { createCounterPrivateState, witnesses, type CounterPrivateState } from './witnesses';

import type * as CounterContract from '../managed/counter/contract/index.js';

// Enable WebSocket for GraphQL subscriptions
// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

// Must match the privateStateId used at deploy time so the CLI reconnects to
// the same private state.
const PRIVATE_STATE_ID = 'counterPrivateState';

const { network, config: networkConfig } = resolveNetwork();
const WALLET = getOrCreateWallet(network);
const SEED = WALLET.seed;
{
  const notice = formatWalletBackupNotice(WALLET, network);
  if (notice) console.log(notice);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'managed', 'counter');

// Load compiled contract
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');

if (!fs.existsSync(contractPath)) {
  console.error('\n❌ Contract not compiled! Run: npm run compile\n');
  process.exit(1);
}

const Counter = (await import(pathToFileURL(contractPath).href)) as typeof CounterContract;

const compiledContract = CompiledContract.make('counter', Counter.Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);

// ─── Providers ─────────────────────────────────────────────────────────────────

async function createProviders(walletCtx: WalletContext) {
  // The SDK requires the private-state password to be at least 16 characters.
  const privateStatePassword = process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';

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

  return {
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
}

// ─── Main CLI ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    my-project counter CLI                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const rl = createInterface({ input: stdin, output: stdout });

  // Check for deployment
  const deployment = getDeployment(network);
  if (!deployment) {
    console.error(`No deploy on file for network ${network}. Run \`npm run deploy -- --network ${network}\` first.`);
    process.exit(1);
  }
  console.log(`  Contract: ${deployment.address}`);
  console.log(`  Network: ${network}\n`);

  try {
    const seed = SEED;

    console.log('  Connecting to wallet...');
    const walletCtx = await createWallet({ network, networkConfig, seed });
    const restoredCount = Object.values(walletCtx.restored).filter(Boolean).length;
    if (restoredCount > 0) {
      console.log(`  Restored ${restoredCount}/3 child wallets from .midnight-wallet-state — sync will resume from saved point.`);
    }

    console.log('  Syncing with network...');
    console.log('  ℹ  This may take several minutes depending on network size.');
    console.log('     RPC disconnection messages during sync are normal and can be safely ignored.\n');
    const syncStart = Date.now();
    const syncInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - syncStart) / 1000);
      process.stdout.write(`\r  ⏳ Still syncing... (${elapsed}s elapsed)   `);
    }, 5000);
    const state = await walletCtx.wallet.waitForSyncedState();
    clearInterval(syncInterval);
    process.stdout.write('\r  ✓ Synced with network.                                      \n');

    // Persist sync state so the next run doesn't have to redo this work.
    await persistWalletState(network, walletCtx);
    const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    console.log(`  Balance: ${balance.toLocaleString()} tNight\n`);

    if (balance === 0n && network !== 'undeployed' && networkConfig.faucet) {
      const address = walletCtx.unshieldedKeystore.getBech32Address();
      console.log('  ⚠ Wallet has no tNight. Fund it from the faucet to send transactions:');
      console.log(`     ${networkConfig.faucet}`);
      console.log(`     Wallet address: ${address}\n`);
    }

    // Setup providers and connect to contract
    console.log('  Connecting to contract...');
    const providers = await createProviders(walletCtx);

    const deployed: any = await findDeployedContract(providers, {
      compiledContract: compiledContract as any,
      contractAddress: deployment.address,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: createCounterPrivateState(1, 'counter CLI note'),
    });

    console.log('  ✅ Connected!\n');

    // ─── helpers ───────────────────────────────────────────────────────────

    /** The private state this machine holds for the contract. */
    const readPrivateState = async (): Promise<CounterPrivateState> =>
      (await providers.privateStateProvider.get(PRIVATE_STATE_ID)) ??
      createCounterPrivateState(1, 'counter CLI note');

    const writePrivateState = async (next: CounterPrivateState): Promise<void> => {
      await providers.privateStateProvider.set(PRIVATE_STATE_ID, next);
    };

    /** Read the PUBLIC ledger straight off the chain, via the indexer. */
    const readPublicLedger = async () => {
      const onChain = await providers.publicDataProvider.queryContractState(deployment.address);
      if (!onChain) return null;
      return Counter.ledger(onChain.data);
    };

    const showLedger = async (): Promise<void> => {
      const publicLedger = await readPublicLedger();
      if (!publicLedger) {
        console.log('\n  (no contract state indexed yet)\n');
        return;
      }
      console.log('\n  ─── Public ledger (on chain, readable by anyone) ───');
      console.log(`  count:            ${publicLedger.count}`);
      console.log(`  updateCount:      ${publicLedger.updateCount}`);
      console.log(`  publishedMessage: ${JSON.stringify(publicLedger.publishedMessage)}\n`);
    };

    const askStep = async (): Promise<number> => {
      const raw = (await rl.question('  Private step to add (never published as-is): ')).trim();
      const step = Number(raw);
      if (!Number.isInteger(step) || step < 1 || step > 4_294_967_295) {
        throw new Error(`step must be an integer in [1, 4294967295], received ${JSON.stringify(raw)}`);
      }
      return step;
    };

    // ─── menu loop ─────────────────────────────────────────────────────────

    let running = true;
    while (running) {
      console.log('─── Menu ───────────────────────────────────────────────────────');
      console.log('  1. Increment the counter (supplies the private witness)');
      console.log('  2. Publish the private message (discloses it on chain)');
      console.log('  3. Read the public ledger');
      console.log('  4. Reset the public counters');
      console.log('  5. Inspect local private state (only visible to you)');
      console.log('  6. Check wallet balance');
      console.log('  7. Exit\n');

      const choice = (await rl.question('  Your choice: ')).trim();

      switch (choice) {
        case '1': {
          try {
            const current = await readPrivateState();
            const step = await askStep();
            // Update PRIVATE state before the call — the witness reads it.
            await writePrivateState(createCounterPrivateState(step, current.message));
            console.log('\n  Submitting transaction (this may take 30-60 seconds)...');
            const tx = await deployed.callTx.increment();
            console.log(`\n  ✅ Incremented by the private step ${step}`);
            console.log(`  Transaction ID: ${tx.public.txId}`);
            console.log(`  Block height: ${tx.public.blockHeight}\n`);
            await showLedger();
          } catch (error) {
            console.error('\n  ❌ Failed:', error instanceof Error ? error.message : error, '\n');
          }
          break;
        }

        case '2': {
          try {
            const current = await readPrivateState();
            const message = await rl.question('  Message to disclose on chain: ');
            await writePrivateState(createCounterPrivateState(current.step, message));
            console.log('\n  Submitting transaction (this may take 30-60 seconds)...');
            const tx = await deployed.callTx.publishMessage();
            console.log(`\n  ✅ Disclosed: ${JSON.stringify(message)} — it is public from now on`);
            console.log(`  Transaction ID: ${tx.public.txId}`);
            console.log(`  Block height: ${tx.public.blockHeight}\n`);
            await showLedger();
          } catch (error) {
            console.error('\n  ❌ Failed:', error instanceof Error ? error.message : error, '\n');
          }
          break;
        }

        case '3': {
          await showLedger();
          break;
        }

        case '4': {
          try {
            console.log('\n  Submitting transaction (this may take 30-60 seconds)...');
            const tx = await deployed.callTx.reset();
            console.log(`\n  ✅ Counters reset`);
            console.log(`  Transaction ID: ${tx.public.txId}`);
            console.log(`  Block height: ${tx.public.blockHeight}\n`);
            await showLedger();
          } catch (error) {
            console.error('\n  ❌ Failed:', error instanceof Error ? error.message : error, '\n');
          }
          break;
        }

        case '5': {
          const privateState = await readPrivateState();
          console.log('\n  ─── Private state (this machine only — never on chain) ───');
          console.log(`  step:    ${privateState.step}`);
          console.log(`  message: ${JSON.stringify(privateState.message)}\n`);
          break;
        }

        case '6': {
          console.log('\n  Checking balance...');
          const currentState = await walletCtx.wallet.waitForSyncedState();
          const currentBalance = currentState.unshielded.balances[unshieldedToken().raw] ?? 0n;
          const dustBalance = currentState.dust.balance(new Date());
          console.log(`\n  tNight: ${currentBalance.toLocaleString()}`);
          console.log(`  DUST:   ${dustBalance.toLocaleString()}\n`);
          break;
        }

        case '7':
          running = false;
          console.log('\n  👋 Goodbye!\n');
          break;

        default:
          console.log('\n  ❌ Invalid choice. Please enter 1-7.\n');
      }
    }

    await persistWalletState(network, walletCtx);
    await walletCtx.wallet.stop();
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
  } finally {
    rl.close();
  }
}

main().catch(console.error);
