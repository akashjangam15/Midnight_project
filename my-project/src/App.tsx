/**
 * my-project dApp shell.
 *
 * Two independent halves, mirroring the contract's public/private split:
 *
 *  1. Wallet — connect via the DApp Connector (WalletConnect + useMidnight).
 *  2. Circuits — run counter.compact's circuits through the *compiled contract*
 *     with compact-runtime, exactly as tests/counter.test.ts does. This is a
 *     real, in-browser circuit execution (the same code path the chain runs to
 *     verify a proof); it just skips proving/submission for now. Wiring these
 *     calls to the deployed contract over RPC is the next step.
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
import { CONTRACT_ADDRESS, PROOF_SERVER_URL, useMidnight } from './hooks/useMidnight';

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
  if (counterRef.current === null) counterRef.current = deployLocalCounter(INITIAL_STEP, INITIAL_MESSAGE);

  const [step, setStep] = useState(INITIAL_STEP);
  const [message, setMessage] = useState(INITIAL_MESSAGE);
  const [publicLedger, setPublicLedger] = useState<Ledger>(() =>
    ledger(counterRef.current!.context.currentQueryContext.state),
  );

  const privateState: CounterPrivateState = useMemo(
    () => createCounterPrivateState(step, message),
    [step, message],
  );

  /**
   * Run one circuit locally and refresh the public ledger view.
   *
   * The private state is written onto the context *before* the call because
   * the witnesses read it from there — the same ordering the CLI uses.
   */
  async function callCircuit(name: CircuitName): Promise<Record<string, string>> {
    const counter = counterRef.current!;
    counter.context.currentPrivateState = privateState;
    const { context } = counter.contract.impureCircuits[name](counter.context);
    counter.context = context;

    const next = ledger(context.currentQueryContext.state);
    setPublicLedger(next);

    return {
      circuit: `${name}()`,
      count: next.count.toString(),
      updateCount: next.updateCount.toString(),
      publishedMessage: next.publishedMessage,
      executedLocally: 'true (no proof, no submission)',
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
            {CONTRACT_ADDRESS ? (
              <span className="badge">contract {CONTRACT_ADDRESS.slice(0, 10)}…</span>
            ) : (
              <span className="badge badge--warn">no deployed contract</span>
            )}
          </header>

          <div className="circuit-grid">
            <CircuitCall
              name="increment"
              description="Adds the private step to the public count and bumps updateCount. The step itself is never published."
              onCall={() => callCircuit('increment')}
            />
            <CircuitCall
              name="publishMessage"
              description="Discloses the private message on chain. Explicit and irreversible."
              onCall={() => callCircuit('publishMessage')}
            />
            <CircuitCall
              name="reset"
              description="Zeroes the public counters. Reads no witness, so it discloses nothing private."
              onCall={() => callCircuit('reset')}
            />
          </div>

          <p className="note">
            These execute the compiled contract locally through compact-runtime — the same code path
            the chain runs to verify a proof — so no wallet or proof server is required. On-chain
            submission via the connector (proof server: <code>{PROOF_SERVER_URL}</code>) is wired in
            the next step; connect a wallet above to hand it transactions to balance and submit.
          </p>
        </section>
      </main>
    </div>
  );
}
