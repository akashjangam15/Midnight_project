/**
 * Unit tests for counter.compact.
 *
 * These run the *compiled contract* directly against compact-runtime — no
 * wallet, no network, no proof server, no `effect` import. That makes them
 * fast (sub-second) and runnable in CI, and it is the same code path the
 * chain executes when it verifies a proof, so the coverage is real:
 * `contract.impureCircuits.<circuit>(context)` performs the ledger transition
 * and returns the new context, exactly as the prover will.
 *
 * Run with:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  sampleUserAddress,
  type CircuitContext,
} from '@midnight-ntwrk/compact-runtime';

import { Contract, ledger, type Ledger } from '../managed/counter/contract/index.js';
import { createCounterPrivateState, witnesses, type CounterPrivateState } from '../src/witnesses';

type CircuitName = 'increment' | 'publishMessage' | 'reset';

/** A locally-executed counter: the contract plus its current circuit context. */
interface LocalCounter {
  contract: Contract<CounterPrivateState>;
  context: CircuitContext<CounterPrivateState>;
}

/**
 * Instantiate the contract in-process, the way the constructor would run on
 * chain. No node is contacted: `sampleContractAddress()`/`sampleUserAddress()`
 * supply well-formed stand-ins for the address and the caller.
 */
function deployLocal(step: number, message: string): LocalCounter {
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

/** Execute a circuit, returning the counter holding the post-call context. */
function call(counter: LocalCounter, name: CircuitName): LocalCounter {
  const { context } = counter.contract.impureCircuits[name](counter.context);
  return { contract: counter.contract, context };
}

/** Read the public ledger out of the current context. */
function readLedger(counter: LocalCounter): Ledger {
  return ledger(counter.context.currentQueryContext.state);
}

/**
 * Hex dump of the *entire raw public state* — every byte the ledger holds,
 * including cell payloads. Used to prove a private value is not on chain.
 */
function encodeToHex(value: unknown): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return `[${value.map(encodeToHex).join(',')}]`;
  if (value instanceof Map) {
    return `{${[...value.entries()].map(([k, v]) => `${encodeToHex(k)}=>${encodeToHex(v)}`).join(',')}}`;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `${k}:${encodeToHex(v)}`).join(',')}}`;
  }
  return String(value);
}

function publicStateHex(counter: LocalCounter): string {
  return encodeToHex(counter.context.currentQueryContext.state.state.encode());
}

/** Little-endian hex of a Uint<32> cell payload — how a value looks on chain. */
function u32Hex(n: number): string {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(n, 0);
  return bytes.toString('hex');
}

// ─── Circuit logic ──────────────────────────────────────────────────────────

test('increment() adds the private step to the public count', () => {
  let counter = deployLocal(5, 'unused note');

  assert.equal(readLedger(counter).count, 0n, 'a fresh contract starts at zero');

  counter = call(counter, 'increment');
  assert.equal(readLedger(counter).count, 5n, '5 + private step 5');
  assert.equal(readLedger(counter).updateCount, 1n);

  counter = call(counter, 'increment');
  assert.equal(readLedger(counter).count, 10n, '5 + private step 5 again');
  assert.equal(readLedger(counter).updateCount, 2n);
});

test('increment() refuses a non-positive private step', () => {
  const counter = deployLocal(0, 'unused note');

  assert.throws(
    () => call(counter, 'increment'),
    /privateStep must be greater than zero/,
    'the assertion in the circuit must abort the call',
  );
  assert.equal(readLedger(counter).count, 0n, 'an aborted call leaves no partial state');
});

// ─── State transitions ──────────────────────────────────────────────────────

test('publishMessage() discloses the private note, and reset() clears only the public counters', () => {
  const secret = 'note-that-should-stay-private';
  let counter = deployLocal(7, secret);

  assert.equal(readLedger(counter).publishedMessage, '', 'nothing published yet');

  counter = call(counter, 'increment');
  counter = call(counter, 'increment');
  counter = call(counter, 'publishMessage');

  assert.equal(readLedger(counter).count, 14n);
  assert.equal(readLedger(counter).updateCount, 2n);
  assert.equal(readLedger(counter).publishedMessage, secret);

  counter = call(counter, 'reset');
  assert.equal(readLedger(counter).count, 0n, 'reset zeroes the total');
  assert.equal(readLedger(counter).updateCount, 0n, 'reset zeroes the call count');
  assert.equal(readLedger(counter).publishedMessage, secret, 'reset does not unpublish');

  counter = call(counter, 'increment');
  assert.equal(readLedger(counter).count, 7n, 'private state survives reset, so increments still work');
});

// ─── Privacy ────────────────────────────────────────────────────────────────

test('private inputs are never exposed in the public ledger state', () => {
  const SECRET_NOTE = 'top-secret-note-42';
  const SECRET_STEP = 100;
  const noteBytes = Buffer.from(SECRET_NOTE, 'utf8').toString('hex');

  let counter = deployLocal(SECRET_STEP, SECRET_NOTE);

  // 1. Structurally, the public ledger exposes the three declared public
  //    fields and nothing else — no witness is a ledger field.
  assert.deepEqual(
    Object.keys(readLedger(counter)).sort(),
    ['count', 'publishedMessage', 'updateCount'],
    'the public ledger API must expose exactly the declared public fields',
  );

  // 2. The note's bytes are absent from the raw public state before the
  //    circuit that discloses it is ever called.
  assert.ok(
    !publicStateHex(counter).includes(noteBytes),
    'the private note leaked into public state without publishMessage()',
  );

  // 3. Only the SUM of the private steps is published. Two increments of the
  //    private step 100 leave the total 200 on chain, and the step value's own
  //    cell encoding appears nowhere in the raw public state — the ledger
  //    records the running total, not the inputs that produced it.
  counter = call(counter, 'increment');
  counter = call(counter, 'increment');

  assert.equal(readLedger(counter).count, 200n, 'only the running total is public');
  assert.equal(readLedger(counter).updateCount, 2n, 'only the call count is public');
  const stateHex = publicStateHex(counter);
  assert.ok(
    !stateHex.includes(u32Hex(SECRET_STEP)),
    'the private step value was serialized into public state',
  );

  // 4. disclose() is the one deliberate crossing point: calling it does put
  //    the bytes on chain, which is what makes step 2 meaningful.
  counter = call(counter, 'publishMessage');
  assert.equal(readLedger(counter).publishedMessage, SECRET_NOTE);
  assert.ok(
    publicStateHex(counter).includes(noteBytes),
    'publishMessage() must disclose the note into the public state',
  );
});

// ─── Private state hygiene ──────────────────────────────────────────────────

test('private state is JSON-serializable and fits Uint<32>', () => {
  const state = createCounterPrivateState(7, 'note');
  assert.equal(state.step, 7);
  assert.equal(
    JSON.parse(JSON.stringify(state)).step,
    7,
    'the private-state provider stringifies private state, so bigint would break the deploy',
  );

  assert.throws(() => createCounterPrivateState(4_294_967_296, 'note'), /fits Uint<32>/);
  assert.throws(() => createCounterPrivateState(-1, 'note'), /fits Uint<32>/);
  assert.throws(() => createCounterPrivateState(1.5, 'note'), /fits Uint<32>/);
});
