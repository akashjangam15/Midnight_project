/**
 * Private state and witness implementations for counter.compact.
 *
 * The witness functions declared in contracts/counter.compact (privateStep,
 * privateMessage) are *declarations*. This file supplies their implementations
 * — the code the prover runs locally to turn off-chain private state into
 * values the circuit can use.
 *
 * A witness never returns a value to the chain. It is evaluated while
 * building the proof; only the proof is submitted. That is why the private
 * state below (the step, the note) stays on this machine, and why the only
 * way any of it reaches the ledger is an explicit disclose() in a circuit.
 *
 * Imported by src/deploy.ts (to compile the contract with witnesses) and by
 * src/cli.ts (to drive circuits against a deployed instance).
 */

import type { Witnesses } from '../managed/counter/contract/index.js';

const UINT32_MAX = 4_294_967_295;

/**
 * Private state for the counter contract. Never leaves the device — the
 * Midnight.js private-state provider encrypts it, JSON-encodes it, and stores
 * it locally under the contract's privateStateId.
 *
 * `step` is a `number`, not a `bigint`, on purpose: the provider serializes
 * private state with JSON.stringify, which throws on BigInt. The witness
 * converts it to bigint at the circuit boundary, where the contract's type
 * system wants it.
 */
export interface CounterPrivateState {
  /** PRIVATE: how much the next increment() adds. Not on-chain. */
  readonly step: number;
  /** PRIVATE: the note publishMessage() may disclose. Not on-chain until it does. */
  readonly message: string;
}

/**
 * Build private state, validating only what has to hold for the value to
 * survive serialization and fit the circuit's `Uint<32>`.
 *
 * Deliberately NOT checked here: `step > 0`. That rule belongs to the
 * circuit's own assert, so it is enforced on-chain (and is covered by a test
 * exercising the real assertion path) rather than only in local TS.
 */
export const createCounterPrivateState = (step: number | bigint, message: string): CounterPrivateState => {
  const asNumber = typeof step === 'bigint' ? Number(step) : step;
  if (!Number.isInteger(asNumber) || asNumber < 0 || asNumber > UINT32_MAX) {
    throw new Error(
      `private step must be an integer in [0, ${UINT32_MAX}] (fits Uint<32> and JSON private state), received ${String(step)}`,
    );
  }
  return { step: asNumber, message };
};

/**
 * Witness implementations.
 *
 * Each returns `[nextPrivateState, value]`: the private state the prover
 * should hold afterwards, plus the value the circuit consumes. Both here
 * return the state unchanged — a witness may also *update* private state, or
 * read the projected public ledger through `context.ledger`.
 */
export const witnesses: Witnesses<CounterPrivateState> = {
  /** PRIVATE: hands the step to the circuit; publishes nothing by itself. */
  privateStep: (context) => [context.privateState, BigInt(context.privateState.step)],

  /** PRIVATE: hands the note to the circuit; the circuit decides whether to disclose it. */
  privateMessage: (context) => [context.privateState, context.privateState.message],
};
