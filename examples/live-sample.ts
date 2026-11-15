/**
 * Real call to the free live sample endpoint. No payment, no wallet.
 *
 * Note: the live sample returns HTTP 503 when its Bitcoin figures are
 * missing or more than 3 days old; that is reported, not retried.
 *
 * Run: npm run sample:live
 */

import { BlockchainIQClient } from "../src/client.js";
import { BlockchainIQError } from "../src/x402.js";

const client = new BlockchainIQClient();
try {
  const res = await client.getSample();
  console.log(JSON.stringify(res.data, null, 2));
} catch (err) {
  if (err instanceof BlockchainIQError) {
    console.log(`Live sample unavailable right now (HTTP ${err.status}): ${err.body}`);
  } else {
    throw err;
  }
}
