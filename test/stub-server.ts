/**
 * A local stub of the Blockchain IQ x402 API for tests and the demo.
 *
 * - `GET /api/x402/v1/sample` answers 200 with the sample fixture.
 * - `GET /api/x402/v1/brief` and `GET /api/x402/v1/event-risk` are payment
 *   gated: without a `payment-signature` header they answer 402 with a
 *   `payment-required` header (the brief fixture is a real header captured
 *   from the live API on 2026-11-15); with a structurally valid mock payment
 *   they answer 200 plus a `payment-response` header.
 *
 * The stub performs no cryptographic verification — it checks the decoded
 * payload's network, payTo and amount so the client's flow is exercised
 * end to end.
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  decodeBase64Json,
  encodeBase64Json,
  type PaymentPayload,
  type PaymentRequired,
} from "../src/x402.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

const sampleBody = fixture("sample.json");
const briefBody = fixture("brief.json");
const briefRequired = fixture("payment-required-brief.json") as PaymentRequired;

const eventRiskRequired: PaymentRequired = {
  ...briefRequired,
  resource: {
    ...briefRequired.resource,
    url: "https://www.blockchainiq.co/api/x402/v1/event-risk",
    serviceName: "Event Risk - Next 7 Days",
  },
  accepts: briefRequired.accepts.map((a) => ({ ...a, amount: "50000" })),
};

const FAKE_TX = `0x${"ab".repeat(32)}`;

export interface StubServer {
  baseUrl: string;
  /** Every payment payload the stub accepted, in arrival order. */
  receivedPayments: PaymentPayload[];
  close: () => Promise<void>;
}

function gated(
  required: PaymentRequired,
  body: unknown,
  req: IncomingMessage,
  res: ServerResponse,
  receivedPayments: PaymentPayload[],
): void {
  const header = req.headers["payment-signature"];
  if (typeof header === "string") {
    try {
      const payload = decodeBase64Json<PaymentPayload>(header);
      const auth = payload.payload.authorization as { to?: string; value?: string; from?: string };
      const expected = required.accepts[0];
      if (
        payload.accepted?.network === expected.network &&
        auth?.to === expected.payTo &&
        auth?.value === expected.amount
      ) {
        receivedPayments.push(payload);
        res.writeHead(200, {
          "content-type": "application/json",
          "payment-response": encodeBase64Json({
            success: true,
            transaction: FAKE_TX,
            network: expected.network,
            payer: auth.from,
          }),
        });
        res.end(JSON.stringify(body));
        return;
      }
    } catch {
      // fall through to a fresh 402
    }
  }
  res.writeHead(402, {
    "content-type": "application/json",
    "payment-required": encodeBase64Json(required),
  });
  res.end(JSON.stringify({ error: "Payment required", price: required.accepts[0].amount }));
}

export async function startStubServer(): Promise<StubServer> {
  const receivedPayments: PaymentPayload[] = [];
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://stub.local").pathname;
    if (path === "/api/x402/v1/sample") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sampleBody));
    } else if (path === "/api/x402/v1/brief") {
      gated(briefRequired, briefBody, req, res, receivedPayments);
    } else if (path === "/api/x402/v1/event-risk") {
      gated(eventRiskRequired, { data: [] }, req, res, receivedPayments);
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    receivedPayments,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
