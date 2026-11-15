import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BlockchainIQClient } from "../src/client.js";
import { MockPayer } from "../src/payers.js";
import { createBlockchainIQTools } from "../src/tools.js";
import {
  PaymentRequiredError,
  parsePaymentRequired,
  selectRequirement,
  type PaymentRequired,
} from "../src/x402.js";
import { startStubServer, type StubServer } from "./stub-server.js";

const realBriefRequired = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/payment-required-brief.json", import.meta.url)),
    "utf8",
  ),
) as PaymentRequired;

test("parses the real 402 header captured from the live /brief endpoint", () => {
  const encoded = Buffer.from(JSON.stringify(realBriefRequired), "utf8").toString("base64");
  const parsed = parsePaymentRequired(encoded);
  assert.equal(parsed.x402Version, 2);
  const base = selectRequirement(parsed);
  assert.equal(base.network, "eip155:8453");
  assert.equal(base.scheme, "exact");
  assert.equal(base.amount, "10000"); // $0.01 in atomic USDC
  assert.equal(base.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(base.payTo, "0x617dA9383fbA67e86137BC4924b8b7E400fB7C9e");
});

test("free sample flows without any payment", async (t) => {
  const stub: StubServer = await startStubServer();
  t.after(() => stub.close());
  const payer = new MockPayer();
  const client = new BlockchainIQClient({ baseUrl: stub.baseUrl, payer });
  const res = await client.getSample<{ data: { chain: string } }>();
  assert.equal(res.status, 200);
  assert.equal(res.data.data.chain, "btc");
  assert.equal(payer.calls.length, 0);
  assert.equal(stub.receivedPayments.length, 0);
});

test("paid brief without a payer throws PaymentRequiredError and spends nothing", async (t) => {
  const stub: StubServer = await startStubServer();
  t.after(() => stub.close());
  const client = new BlockchainIQClient({ baseUrl: stub.baseUrl });
  await assert.rejects(client.getBrief(), (err: unknown) => {
    assert.ok(err instanceof PaymentRequiredError);
    assert.equal(err.requirements.amount, "10000");
    assert.equal(err.requirements.network, "eip155:8453");
    return true;
  });
  assert.equal(stub.receivedPayments.length, 0);
});

test("mock 402 flow: 402 -> mock payment -> 200 with settlement", async (t) => {
  const stub: StubServer = await startStubServer();
  t.after(() => stub.close());
  const payer = new MockPayer();
  const client = new BlockchainIQClient({ baseUrl: stub.baseUrl, payer });
  const res = await client.getBrief<{ data: { coins: Array<{ symbol: string }> } }>();
  assert.equal(res.status, 200);
  assert.equal(res.data.data.coins[0].symbol, "btc");
  assert.equal(payer.calls.length, 1);
  assert.equal(stub.receivedPayments.length, 1);
  const auth = stub.receivedPayments[0].payload.authorization as { to: string; value: string };
  assert.equal(auth.value, "10000");
  assert.equal(auth.to, "0x617dA9383fbA67e86137BC4924b8b7E400fB7C9e");
  assert.equal(res.settlement?.success, true);
  assert.match(res.settlement?.transaction ?? "", /^0x[0-9a-f]{64}$/);
});

test("spend cap refuses an over-cap 402 before the payer is called", async (t) => {
  const stub: StubServer = await startStubServer();
  t.after(() => stub.close());
  const payer = new MockPayer();
  const client = new BlockchainIQClient({
    baseUrl: stub.baseUrl,
    payer,
    maxAmountAtomic: "9999", // one atomic unit below the $0.01 price
  });
  await assert.rejects(client.getBrief(), /exceeds the configured cap/);
  assert.equal(payer.calls.length, 0);
});

test("LangChain tools: sample, paid brief with mock payer, unpaid brief error surface", async (t) => {
  const stub: StubServer = await startStubServer();
  t.after(() => stub.close());

  const paidTools = createBlockchainIQTools(
    new BlockchainIQClient({ baseUrl: stub.baseUrl, payer: new MockPayer() }),
  );
  const byName = Object.fromEntries(paidTools.map((tool) => [tool.name, tool]));

  const sampleOut = JSON.parse((await byName["blockchain_iq_sample"].invoke({})) as string);
  assert.equal(sampleOut.data.dashboardSlug, "bitcoin-network");

  const briefOut = JSON.parse((await byName["blockchain_iq_brief"].invoke({})) as string);
  assert.equal(briefOut.data.coins[0].symbol, "btc");
  assert.equal(briefOut.settlement.success, true);

  const freeTools = createBlockchainIQTools(new BlockchainIQClient({ baseUrl: stub.baseUrl }));
  const unpaid = freeTools.find((tool) => tool.name === "blockchain_iq_brief");
  const unpaidOut = JSON.parse((await unpaid!.invoke({})) as string);
  assert.equal(unpaidOut.error, "payment_required");
  assert.equal(unpaidOut.accepts[0].amount, "10000");
});
