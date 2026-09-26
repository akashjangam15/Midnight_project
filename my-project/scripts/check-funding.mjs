// TEMP: check whether the preprod wallet address has been funded.
import { createClient } from 'graphql-ws';

const address = process.argv[2];
if (!address) {
  console.error('usage: node check-funding.mjs <bech32-address>');
  process.exit(1);
}

const url = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';
const client = createClient({ url, shouldRetry: () => false, keepAlive: 15000 });

const query = `
subscription ($address: UnshieldedAddress!) {
  unshieldedTransactions(address: $address) {
    ... on UnshieldedTransaction {
      transaction { id hash }
      createdUtxos { owner tokenType value }
      spentUtxos { owner tokenType value }
    }
    ... on UnshieldedTransactionsProgress { highestTransactionId }
  }
}`;

let sawTx = false;
const unsub = client.subscribe(
  { query, variables: { address } },
  {
    next: (payload) => {
      const msg = payload.data?.unshieldedTransactions;
      if (!msg) return;
      if (msg.type === 'UnshieldedTransactionsProgress' || msg.highestTransactionId !== undefined) {
        return;
      }
      sawTx = true;
      const created = (msg.createdUtxos ?? []).map((u) => `${u.value} (${u.tokenType})`);
      const spent = (msg.spentUtxos ?? []).map((u) => `${u.value} (${u.tokenType})`);
      console.log(`  tx ${msg.transaction?.id ?? '?'} hash=${msg.transaction?.hash ?? '?'}`);
      if (created.length) console.log(`    CREATED: ${created.join(', ')}`);
      if (spent.length) console.log(`    SPENT:   ${spent.join(', ')}`);
    },
    error: (e) => console.error('subscription error:', JSON.stringify(e)),
    complete: () => console.log('subscription complete'),
  },
);

setTimeout(() => {
  unsub();
  client.dispose();
  console.log(sawTx ? '\nRESULT: address has unshielded transaction history (likely funded).' : '\nRESULT: no unshielded transactions found for this address yet.');
  process.exit(0);
}, 20000);
