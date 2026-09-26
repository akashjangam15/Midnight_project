/**
 * my-project dApp shell.
 *
 * Two independent halves, mirroring the contract's public/private split:
 *
 *  1. Wallet — connect via the DApp Connector (WalletConnect + useMidnight).
 *  2. Circuits — run counter.compact's circuits through the *compiled contract*
 *     with compact-runtime. When a wallet is connected, circuits are submitted
 *     on-chain: the wallet generates a zero-knowledge proof locally in the
 *     browser, then submits the transaction to the network.
 *
 * Private state (step, note) is held here and fed to the witnesses. Only what
 * a circuit discloses is ever shown as public ledger state.
 */
import { useMemo, useRef, useState } from 'react';
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  sampleUserAddress,
  type CircuitContext,
} from '@midnight-ntwrk/compact-runtime';

import { Contract, ledger, type Ledger } from '../managed/counter/contract/index.js';
import { createCounterPrivateState, witnesses, type CounterPrivateState } from './witnesses';
import { WalletConnect } from './components/WalletConnect';
import { CircuitCall } from './components/CircuitCall';
import { CONTRACT_ADDRESS, useMidnight } from './hooks/useMidnight';
import { connectOnChain, NETWORK, type OnChainSession } from './onchain';

import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';

type CircuitName = 'increment' | 'publishMessage' | 'reset';

interface LocalCounter {
  contract: Contract<CounterPrivateState>;
  context: CircuitContext<CounterPrivateState>;
}

/** Instantiate counter.compact in-process, the way the constructor runs on chain. */
function deployLocalCounter(step: number, message: string): LocalCounter {
  const contract = new Contract(witnesses);
  const constructorContext = createConstructorContext(
    createCounterPrivateState(step, message),
    sampleUserAddress(),
  );
  const initial = contract.initialState(constructorContext);
  return {
    contract,
    context: createCircuitContext(
      sampleContractAddress(),
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    ),
  };
}

const INITIAL_STEP = 1;
const INITIAL_MESSAGE = 'hello from the browser';

export default function App() {
  const wallet = useMidnight();

  // ─── Local circuit harness ────────────────────────────────────────────────
  const counterRef = useRef<LocalCounter | null>(null);
  /** Live connection to the DEPLOYED contract (wallet path); null when offline. */
  const sessionRef = useRef<OnChainSession | null>(null);
  
  // Lazy initialize the counter to catch any errors during setup
  const [initError, setInitError] = useState<string | null>(null);
  
  if (counterRef.current === null) {
    try {
      counterRef.current = deployLocalCounter(INITIAL_STEP, INITIAL_MESSAGE);
    } catch (err) {
      console.error('Failed to initialize counter:', err);
      setInitError(err instanceof Error ? err.message : String(err));
      // Return error state
      return (
        <div className="app">
          <div className="error-panel">
            <h1>Initialization Error</h1>
            <p>Failed to initialize the counter contract:</p>
            <pre className="error">{initError}</pre>
            <p>Check the browser console for more details.</p>
          </div>
        </div>
      );
    }
  }

  const [step, setStep] = useState(INITIAL_STEP);
  const [message, setMessage] = useState(INITIAL_MESSAGE);
  const [publicLedger, setPublicLedger] = useState<Ledger>(() => {
    try {
      return ledger(counterRef.current!.context.currentQueryContext.state);
    } catch (err) {
      console.error('Failed to read ledger:', err);
      return { count: 0n, updateCount: 0n, publishedMessage: '' } as Ledger;
    }
  });

  const privateState: CounterPrivateState = useMemo(
    () => createCounterPrivateState(step, message),
    [step, message],
  );

  /**
   * Run one circuit locally for preview, then submit on-chain if wallet connected.
   */
  async function callCircuit(name: CircuitName): Promise<Record<string, string>> {
    const counter = counterRef.current!;
    counter.context.currentPrivateState = privateState;
    const { context } = counter.contract.impureCircuits[name](counter.context);
    counter.context = context;

    const next = ledger(context.currentQueryContext.state);
    setPublicLedger(next);

    const api = wallet.connectedApi;
    if (!api || !CONTRACT_ADDRESS) {
      if (!api) sessionRef.current = null; // wallet disconnected — drop the session
      return {
        circuit: `${name}()`,
        count: next.count.toString(),
        updateCount: next.updateCount.toString(),
        publishedMessage: next.publishedMessage,
        executedLocally: 'true (connect wallet to submit on-chain)',
      };
    }

    return submitOnChain(api, name, CONTRACT_ADDRESS);
  }

  /**
   * Real on-chain submission through the connected wallet (Lace):
   * the browser proves the circuit locally, the wallet balances + signs,
   * the sealed transaction goes to the chain, and the public ledger is
   * re-read from the indexer — the source of truth.
   */
  async function submitOnChain(
    api: ConnectedAPI,
    name: CircuitName,
    contractAddress: string,
  ): Promise<Record<string, string>> {
    if (!sessionRef.current) {
      // First on-chain call (or wallet was reconnected): build providers and
      // bind to the deployed contract. Fetches zk keys, opens the private
      // state store (IndexedDB), resolves the wallet's public keys.
      sessionRef.current = await connectOnChain(api, NETWORK, contractAddress);
    }
    const session = sessionRef.current;

    // The witness reads PRIVATE state from the provider at proving time —
    // persist what the UI currently holds before the call.
    await session.setPrivateState(privateState);

    const tx = await session.callTx[name]();

    // Refresh the public ledger from the indexer.
    const onChain = await session.readLedger();
    setPublicLedger(onChain as Ledger);

    return {
      circuit: `${name}()`,
      count: onChain.count.toString(),
      updateCount: onChain.updateCount.toString(),
      publishedMessage: onChain.publishedMessage,
      submitted: 'true',
      txId: String(tx?.public?.txId ?? '(unknown)'),
      blockHeight: tx?.public?.blockHeight != null ? String(tx.public.blockHeight) : '(indexing)',
      proofGenerated: 'true (locally in browser)',
      privateInputsRevealed: 'false',
    };
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1>my-project · Midnight counter</h1>
        <p className="app__subtitle">
          A Compact contract that keeps a counter public and its inputs private.
        </p>
      </header>

      <main className="app__grid">
        <WalletConnect
          wallets={wallet.wallets}
          status={wallet.status}
          error={wallet.error}
          networkId={wallet.networkId}
          walletName={wallet.walletName}
          snapshot={wallet.snapshot}
          onConnect={wallet.connect}
          onDisconnect={wallet.disconnect}
          onRefresh={wallet.refresh}
          onRescan={wallet.rescan}
        />

        <section className="panel">
          <header className="panel__header">
            <h2>Public ledger</h2>
            <span className="badge">on chain</span>
          </header>
          <div className="row">
            <span className="row__label">count</span>
            <span className="row__value">{publicLedger.count.toString()}</span>
          </div>
          <div className="row">
            <span className="row__label">updateCount</span>
            <span className="row__value">{publicLedger.updateCount.toString()}</span>
          </div>
          <div className="row">
            <span className="row__label">publishedMessage</span>
            <span className="row__value">{JSON.stringify(publicLedger.publishedMessage)}</span>
          </div>
        </section>

        <section className="panel">
          <header className="panel__header">
            <h2>Private state</h2>
            <span className="badge badge--private">this browser only</span>
          </header>
          <label className="field">
            <span className="row__label">step (witness input)</span>
            <input
              type="number"
              min={0}
              max={4294967295}
              value={step}
              onChange={(event) => setStep(Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span className="row__label">message (witness input)</span>
            <input
              type="text"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          <p className="note">
            Neither value is on chain. <code>increment()</code> discloses only the running sum;{' '}
            <code>publishMessage()</code> is the one circuit that reveals the note.
          </p>
        </section>

        <section className="panel panel--wide">
          <header className="panel__header">
            <h2>Circuits</h2>
            <div className="panel__badges">
              {CONTRACT_ADDRESS ? (
                <span className="badge">contract {CONTRACT_ADDRESS.slice(0, 10)}…</span>
              ) : (
                <span className="badge badge--warn">no deployed contract</span>
              )}
              <span className={`badge badge--${wallet.status}`}>
                {wallet.status === 'connected' ? 'wallet connected' : wallet.status === 'connecting' ? 'connecting…' : 'wallet offline'}
              </span>
            </div>
          </header>

          <div className="circuit-grid">
            <CircuitCall
              name="increment"
              description="Adds the private step to the public count and bumps updateCount. The step itself is never published."
              onCall={() => callCircuit('increment')}
              showPrivacyNoticed={wallet.status === 'connected'}
              disabledReason={wallet.status !== 'connected' ? 'Connect a wallet to submit on-chain' : undefined}
            />
            <CircuitCall
              name="publishMessage"
              description="Discloses the private message on chain. Explicit and irreversible."
              onCall={() => callCircuit('publishMessage')}
              showPrivacyNoticed={wallet.status === 'connected'}
              disabledReason={wallet.status !== 'connected' ? 'Connect a wallet to submit on-chain' : undefined}
            />
            <CircuitCall
              name="reset"
              description="Zeroes the public counters. Reads no witness, so it discloses nothing private."
              onCall={() => callCircuit('reset')}
              showPrivacyNoticed={wallet.status === 'connected'}
              disabledReason={wallet.status !== 'connected' ? 'Connect a wallet to submit on-chain' : undefined}
            />
          </div>

          <p className="note">
            {wallet.status === 'connected'
              ? 'Connected: circuits will generate a zero-knowledge proof locally in your browser and submit on-chain. Your private inputs (step, message) never leave this machine — only the proof does.'
              : 'Connect a wallet above to submit circuits on-chain. Until then, circuits run locally to preview the disclosed outputs.'
            }
          </p>
        </section>
      </main>
    </div>
  );
}
