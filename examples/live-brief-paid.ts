/**
 * TEMPLATE for the real paid call — not run by tests or CI.
 *
 * This performs an actual $0.01 USDC payment on Base through x402 to
 * `GET /api/x402/v1/brief`, following the official Blockchain IQ example:
 * the fetch wrapper answers the 402, signs an EIP-3009 authorization and
 * retries; settlement is gasless for the payer (the wallet needs USDC on
 * Base, no ETH). The settlement transaction hash printed at the end is the
 * proof used for a bounty claim.
 *
 * Prerequisites:
 *   npm install @x402/fetch @x402/evm viem
 *   AGENT_PRIVATE_KEY=0x...   (a dedicated wallet holding a little USDC on Base)
 *
 * Run: npx tsx examples/live-brief-paid.ts
 */

import { BlockchainIQClient } from "../src/client.js";
import { createPaidFetch } from "../src/payers.js";

const key = process.env.AGENT_PRIVATE_KEY;
if (!key) {
  console.error("AGENT_PRIVATE_KEY is not set; refusing to run. See the header comment.");
  process.exit(1);
}

const { privateKeyToAccount } = await import("viem/accounts");
const account = privateKeyToAccount(key as `0x${string}`);
console.log(`Paying from ${account.address} (spend cap $0.60 per call)`);

const payFetch = await createPaidFetch({ account, maxAmountPerPayment: 0.6 });
const client = new BlockchainIQClient({ fetchFn: payFetch });
const res = await client.getBrief();
console.log(JSON.stringify(res.data, null, 2));
console.log("Settlement:", JSON.stringify(res.settlement, null, 2));
