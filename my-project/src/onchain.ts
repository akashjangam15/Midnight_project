/**
 * On-chain wiring for the browser.
 *
 * When a wallet is connected via the DApp Connector, this module builds the
 * Midnight.js provider set the same way src/cli.ts does on Node — except:
 *
 *  • the zkConfig assets (zkIR, prover/verifier keys) are fetched over HTTP
 *    from public/counter-keys/ (NodeZkConfigProvider reads the filesystem,
 *    which does not exist in a browser);
 *  • balancing and submission go through the WALLET (Lace) instead of a
 *    locally-constructed wallet: the dApp serializes its unbalanced
 *    transaction, the wallet adds fees/inputs and signs, the dApp submits
 *    the sealed transaction back. This is the flow the DApp Connector spec
 *    prescribes for contract interaction, and it means the dApp never
 *    touches keys.
 *
 * The private state store is the same levelPrivateStateProvider used by the
 * CLI — level@10 ships a browser build (IndexedDB), so private state
 * persists per-browser and is encrypted with the local password.
 */
import { Buffer } from 'buffer';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import {
  ZKConfigProvider,
  createProverKey,
  createVerifierKey,
  createZKIR,
  type ProverKey,
  type VerifierKey,
  type ZKIR,
  type MidnightProviders,
} from '@midnight-ntwrk/midnight-js-types';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';

import type * as CounterContract from '../managed/counter/contract/index.js';
import { witnesses, createCounterPrivateState, type CounterPrivateState } from './witnesses';

/** Must match the privateStateId used at deploy time and by the CLI. */
export const PRIVATE_STATE_ID = 'counterPrivateState';

/**
 * Network endpoints for the browser dApp. The project is preprod-only
 * (see README); the proof server stays local (docker compose), the indexer
 * is Midnight's public preprod indexer. Reads of the public ledger go
 * straight to the indexer, so they work even without a proof server.
 */
export const NETWORK = {
  indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
  proofServer: import.meta.env.VITE_PROOF_SERVER_URL?.trim() || 'http://127.0.0.1:6300',
};

// ─── byte/hex helpers ────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
  return new Uint8Array(Buffer.from(raw, 'hex'));
}

// ─── zkConfig assets over HTTP ───────────────────────────────────────────────

/**
 * Serves the same directory layout `compact compile` emits under
 * managed/counter/ — copied into public/counter-keys/ by
 * `npm run sync-keys` — so the URLs mirror the on-disk layout:
 *   /counter-keys/zkir/{circuit}.bzkir
 *   /counter-keys/keys/{circuit}.prover | .verifier
 */
class BrowserZkConfigProvider extends ZKConfigProvider<string> {
  async getZKIR(circuitId: string): Promise<ZKIR> {
    const res = await fetch(`/counter-keys/zkir/${circuitId}.bzkir`);
    if (!res.ok) throw new Error(`zkIR for ${circuitId} not found (${res.status}) — run: npm run sync-keys`);
    return createZKIR(new Uint8Array(await res.arrayBuffer()));
  }
  async getProverKey(circuitId: string): Promise<ProverKey> {
    const res = await fetch(`/counter-keys/keys/${circuitId}.prover`);
    if (!res.ok) throw new Error(`prover key for ${circuitId} not found (${res.status}) — run: npm run sync-keys`);
    return createProverKey(new Uint8Array(await res.arrayBuffer()));
  }
  async getVerifierKey(circuitId: string): Promise<VerifierKey> {
    const res = await fetch(`/counter-keys/keys/${circuitId}.verifier`);
    if (!res.ok) throw new Error(`verifier key for ${circuitId} not found (${res.status}) — run: npm run sync-keys`);
    return createVerifierKey(new Uint8Array(await res.arrayBuffer()));
  }
}

// ─── the wallet bridge (DApp Connector ↔ Midnight.js) ───────────────────────

/**
 * Midnight.js hands us an unbalanced transaction
 * (Transaction<SignatureEnabled, Proof, PreBinding> — ledger's "unsealed"),
 * we hand the wallet its serialized form; the wallet pays fees, selects
 * coins, and SIGNS, returning the balanced sealed transaction
 * (Transaction<SignatureEnabled, Proof, Binding> = FinalizedTransaction)
 * which we submit back through the wallet.
 *
 * The dApp holds no keys anywhere in this flow.
 */
async function balanceTxViaWallet(api: ConnectedAPI, tx: ledger.Transaction<any, any, any>): Promise<ledger.FinalizedTransaction> {
  const serialized = toHex(tx.serialize());
  const { tx: balancedHex } = await api.balanceUnsealedTransaction(serialized, { payFees: true });
  return ledger.Transaction.deserialize(
    'signature',
    'proof',
    'binding',
    fromHex(balancedHex),
  ) as unknown as ledger.FinalizedTransaction;
}

// ─── provider set ─────────────────────────────────────────────────────────────

export type CounterProviders = MidnightProviders;

export async function createBrowserProviders(
  api: ConnectedAPI,
  networkConfig: { indexer: string; indexerWS: string; proofServer: string },
): Promise<CounterProviders> {  const [addresses, shielded] = await Promise.all([api.getUnshieldedAddress(), api.getShieldedAddresses()]);

  // WalletProvider's getters are synchronous; resolve the wallet's public
  // keys once up front and serve them from cache.
  const walletProvider = {
    getCoinPublicKey: () => shielded.shieldedCoinPublicKey,
    getEncryptionPublicKey: () => shielded.shieldedEncryptionPublicKey,
    balanceTx: (tx: any) => balanceTxViaWallet(api, tx),
  };

  const zkConfigProvider = new BrowserZkConfigProvider();

  const privateStateProvider = levelPrivateStateProvider({
    privateStateStoreName: 'counter-state',
    accountId: addresses.unshieldedAddress,
    privateStoragePasswordProvider: () => 'Local-Devnet-Development-Placeholder-1',
  });

  return {
    privateStateProvider,
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: {
      submitTx: async (tx: any) => {
        await api.submitTransaction(toHex(tx.serialize()));
        return tx.transactionHash();
      },
    },
  };
}

// ─── high-level connect ──────────────────────────────────────────────────────

export interface OnChainSession {
  address: string;
  /** Submit one circuit: deployed.callTx[name]() — proves + balances + submits. */
  callTx: Record<'increment' | 'publishMessage' | 'reset', () => Promise<any>>;
  /** Read the public ledger straight off the indexer. */
  readLedger: () => Promise<{ count: bigint; updateCount: bigint; publishedMessage: string }>;
  /** Persist private state (the witness reads it at proving time). */
  setPrivateState: (state: CounterPrivateState) => Promise<void>;
}

export async function connectOnChain(
  api: ConnectedAPI,
  networkConfig: { indexer: string; indexerWS: string; proofServer: string },
  contractAddress: string,
): Promise<OnChainSession> {
  const providers = await createBrowserProviders(api, networkConfig);

  const Counter = (await import('../managed/counter/contract/index.js')) as typeof CounterContract;
  const compiledContract = CompiledContract.make('counter', Counter.Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    // zk assets come from BrowserZkConfigProvider over HTTP, not disk.
    CompiledContract.withCompiledFileAssets(''),
  );

  const deployed = await findDeployedContract(providers as any, {
    compiledContract: compiledContract as any,
    contractAddress,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: createCounterPrivateState(1, 'counter deployed from my-project'),
  });

  const readLedger = async () => {
    const onChain = await providers.publicDataProvider.queryContractState(contractAddress);
    if (!onChain) throw new Error('Contract state not indexed yet — retry in a few seconds.');
    const l = Counter.ledger(onChain.data);
    return { count: l.count, updateCount: l.updateCount, publishedMessage: l.publishedMessage };
  };

  return {
    address: contractAddress,
    callTx: deployed.callTx as any,
    readLedger,
    setPrivateState: (state) => providers.privateStateProvider.set(PRIVATE_STATE_ID, state),
  };
}
