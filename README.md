# blockchain-iq-x402-langchain

LangChain (TypeScript) tools for the [Blockchain IQ](https://www.blockchainiq.co/agents)
x402 pay-per-call crypto data API: 26 data resources priced per request in USDC
over the open x402 standard. No account, no API key — an unpaid request returns
the price, the agent pays, and the data comes back as JSON.

## Tools

| Tool | Price | What it returns |
| --- | --- | --- |
| `blockchain_iq_sample` | free | Bitcoin network activity for its latest single day (transactions, active addresses, fees in BTC). Test parsing before spending anything. |
| `blockchain_iq_brief` | $0.01 | BTC/ETH/SOL/XRP prices with 24h/7d/30d moves and rank, macro and crypto events in the next 48 hours, short risk flags. Refreshed every minute. |
| `blockchain_iq_event_risk` | $0.05 | Scheduled market-moving events for the next 1–90 days, importance 1–3. |
| `blockchain_iq_resource` | per catalog | Any other resource by path (`macro`, `calendar`, `network/bitcoin`, `networks`, `stablecoins`, `research/ethereum`, the free `free/dashboards`, …). |

## How payment works

The API speaks x402 protocol version 2, paid in USDC on Base (`eip155:8453`,
a second rail exists on Solana):

1. Plain `GET` the resource.
2. Paid resources answer **HTTP 402** with a `PAYMENT-REQUIRED` header:
   base64 JSON naming the price, asset, network and `payTo` address.
3. The client asks its configured **payer** to sign a payment and retries
   with a `PAYMENT-SIGNATURE` header. Settlement is **gasless for the
   payer** — the signed EIP-3009 authorization is submitted by a
   facilitator, so the wallet needs USDC but no ETH for gas.
4. **HTTP 200** with JSON, plus a `PAYMENT-RESPONSE` header carrying the
   settlement transaction hash. A 404 or an error is never charged.

**Safety default: no payer, no spend.** A client constructed without a payer
throws `PaymentRequiredError` (and the tools return it as JSON) describing
exactly what would have to be paid. A `maxAmountAtomic` spend cap can refuse
over-priced 402s before the payer is ever called.

## Install

```bash
npm install blockchain-iq-x402-langchain
# only for real payments:
npm install @x402/fetch @x402/evm viem
```

Requires Node 18+.

## Usage

```ts
import { BlockchainIQClient, createBlockchainIQTools } from "blockchain-iq-x402-langchain";

// Free tools work immediately; paid tools report their price and spend nothing.
const client = new BlockchainIQClient();
const tools = createBlockchainIQTools(client);

// Hand `tools` to any LangChain agent, or call the client directly:
const sample = await client.getSample();
console.log(sample.data);
```

### Run the free sample

```ts
import { BlockchainIQClient } from "blockchain-iq-x402-langchain";

const res = await new BlockchainIQClient().getSample();
console.log(res.data.data); // { chain: "btc", transactions: {...}, activeAddresses: {...}, fees: {...} }
```

Note: the live sample returns HTTP 503 when its figures are missing or more
than 3 days old; the client surfaces that as a `BlockchainIQError`.

### Mock 402 demo and tests (no wallet, no network)

```bash
npm install
npm test        # node:test suite against a local stub replaying a real captured 402
npm run demo    # narrated end-to-end run: free sample, unpaid 402, mock-paid brief, tool call
npm run sample:live   # the real free sample endpoint (may report the documented 503)
```

`MockPayer` fabricates a structurally valid `exact` EVM payload (zero
signature) so the whole 402 → payment → retry → settlement flow can be
exercised offline. A real server will reject it — it moves no funds and
exists for tests and demos only.

## Making a real paid call

You need:

- A dedicated wallet holding a little **USDC on Base** (the cheapest useful
  call, `/brief`, costs **$0.01**). No ETH is needed: settlement is gasless
  for the payer.
- The optional peer packages: `@x402/fetch`, `@x402/evm`, `viem`.

Two equivalent routes, both mirroring the
[official example](https://www.blockchainiq.co/agents):

**A. Wrapped fetch (recommended).** The wrapper handles the 402, the payment
and the retry; keep the client's own payer unset.

```ts
import { privateKeyToAccount } from "viem/accounts";
import { BlockchainIQClient, createPaidFetch } from "blockchain-iq-x402-langchain";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const payFetch = await createPaidFetch({ account, maxAmountPerPayment: 0.6 });
const client = new BlockchainIQClient({ fetchFn: payFetch });

const brief = await client.getBrief();
console.log(brief.settlement); // { success, transaction, network, payer }
```

**B. Scheme payer.** Keep the client's own 402 handling and plug in a payer
backed by the official `@x402/evm` exact scheme:

```ts
import { privateKeyToAccount } from "viem/accounts";
import { BlockchainIQClient, createX402EvmPayer } from "blockchain-iq-x402-langchain";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const payer = await createX402EvmPayer({ signer: account });
const client = new BlockchainIQClient({ payer, maxAmountAtomic: "60000" }); // $0.06 cap
```

A ready-to-run version of route A lives in
[`examples/live-brief-paid.ts`](examples/live-brief-paid.ts); it refuses to
run unless `AGENT_PRIVATE_KEY` is set. Use a dedicated wallet with a small
balance, never a main wallet.

## API reference (surface)

- `BlockchainIQClient` — `getCatalog()`, `getSample()`, `getBrief()`,
  `getEventRisk({ days, minImportance })`, generic `get(path, query)`.
- `createBlockchainIQTools(client)` — the four LangChain tools above. Tools
  return JSON strings; failures are `{ "error": ... }` JSON, never throws.
- `Payer` interface, `MockPayer`, `createX402EvmPayer`, `createPaidFetch`.
- x402 v2 codecs: `parsePaymentRequired`, `parsePaymentResponse`,
  `selectRequirement`, `PaymentRequiredError`, `BlockchainIQError`.

Full resource catalog with prices and schemas: `GET https://www.blockchainiq.co/api/x402/v1`
(free). Market data and analysis, not investment advice.

## License

MIT
