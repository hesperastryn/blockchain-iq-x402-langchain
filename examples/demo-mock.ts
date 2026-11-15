/**
 * End-to-end demo of the x402 flow against a local stub server.
 *
 * No network, no wallet, no funds: the stub replays a real 402 header
 * captured from the live Blockchain IQ API, and MockPayer answers it with a
 * structurally valid (unsigned) payment payload.
 *
 * Run: npm run demo
 */

import { BlockchainIQClient } from "../src/client.js";
import { MockPayer } from "../src/payers.js";
import { createBlockchainIQTools } from "../src/tools.js";
import { PaymentRequiredError } from "../src/x402.js";
import { startStubServer } from "../test/stub-server.js";

const stub = await startStubServer();
try {
  console.log(`Stub Blockchain IQ API at ${stub.baseUrl}\n`);

  console.log("1) Free sample (no payment involved)");
  const freeClient = new BlockchainIQClient({ baseUrl: stub.baseUrl });
  const sample = await freeClient.getSample<{ data: { title: string; asOf: string } }>();
  console.log(`   -> 200, ${sample.data.data.title}, as of ${sample.data.data.asOf}\n`);

  console.log("2) Paid /brief without a payer (nothing is spent)");
  try {
    await freeClient.getBrief();
    console.log("   -> unexpectedly succeeded");
  } catch (err) {
    if (err instanceof PaymentRequiredError) {
      console.log(`   -> 402: ${err.message}\n`);
    } else {
      throw err;
    }
  }

  console.log("3) Paid /brief with MockPayer (402 -> payment -> retry -> 200)");
  const mockClient = new BlockchainIQClient({ baseUrl: stub.baseUrl, payer: new MockPayer() });
  const brief = await mockClient.getBrief<{ data: { coins: Array<{ symbol: string; price: number }> } }>();
  console.log(
    `   -> 200, first coin ${brief.data.data.coins[0].symbol} at ${brief.data.data.coins[0].price}`,
  );
  console.log(`   -> settlement tx (fake, from stub): ${brief.settlement?.transaction}\n`);

  console.log("4) Same call through the LangChain tool");
  const tools = createBlockchainIQTools(mockClient);
  const briefTool = tools.find((t) => t.name === "blockchain_iq_brief");
  const out = (await briefTool!.invoke({})) as string;
  console.log(`   -> tool returned ${out.length} chars of JSON including settlement: ${out.includes('"settlement"')}`);

  console.log("\nDEMO OK");
} finally {
  await stub.close();
}
