/**
 * LangChain tools for the Blockchain IQ x402 API.
 *
 * Tools never throw for API/payment problems: they return a JSON string, and
 * failures come back as `{ "error": ... }` JSON so the agent can read the
 * price of a 402 and decide what to do. With no payer configured, paid tools
 * report the exact payment that would be required and spend nothing.
 */

import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { BlockchainIQClient } from "./client.js";
import { BlockchainIQError, PaymentRequiredError } from "./x402.js";

function ok(data: unknown, settlement?: unknown): string {
  return JSON.stringify(settlement ? { settlement, ...(data as object) } : data, null, 2);
}

function fail(err: unknown): string {
  if (err instanceof PaymentRequiredError) {
    return JSON.stringify(
      {
        error: "payment_required",
        message: err.message,
        x402Version: err.required.x402Version,
        resource: err.required.resource,
        accepts: err.required.accepts,
        hint: "Configure a payer (see README) to pay this amount and retry. Nothing was spent.",
      },
      null,
      2,
    );
  }
  if (err instanceof BlockchainIQError) {
    return JSON.stringify({ error: "api_error", status: err.status, body: err.body }, null, 2);
  }
  return JSON.stringify(
    { error: "unexpected", message: err instanceof Error ? err.message : String(err) },
    null,
    2,
  );
}

/** Build the full tool set around a configured client. */
export function createBlockchainIQTools(client: BlockchainIQClient): DynamicStructuredTool[] {
  const sample = tool(
    async () => {
      try {
        const res = await client.getSample();
        return ok(res.data, res.settlement);
      } catch (err) {
        return fail(err);
      }
    },
    {
      name: "blockchain_iq_sample",
      description:
        "FREE. Bitcoin network activity for its latest single day (transactions, active " +
        "addresses, fees in BTC) from Blockchain IQ. Use it to test the integration and " +
        "parsing before any paid call. Returns an error with status 503 when the figures " +
        "are stale.",
      schema: z.object({}),
    },
  );

  const brief = tool(
    async () => {
      try {
        const res = await client.getBrief();
        return ok(res.data, res.settlement);
      } catch (err) {
        return fail(err);
      }
    },
    {
      name: "blockchain_iq_brief",
      description:
        "PAID: $0.01 USDC on Base via x402. Crypto market brief in one call: BTC, ETH, SOL " +
        "and XRP prices with 24h/7d/30d moves and rank, scheduled macro and crypto events " +
        "in the next 48 hours, and short risk flags. Refreshed every minute. Without a " +
        "configured payer it returns the payment requirements and spends nothing.",
      schema: z.object({}),
    },
  );

  const eventRisk = tool(
    async ({ days, minImportance }) => {
      try {
        const res = await client.getEventRisk({ days, minImportance });
        return ok(res.data, res.settlement);
      } catch (err) {
        return fail(err);
      }
    },
    {
      name: "blockchain_iq_event_risk",
      description:
        "PAID: $0.05 USDC on Base via x402. Scheduled market-moving events (US data " +
        "releases, FOMC/ECB/BoJ decisions, Treasury auctions, crypto milestones) with " +
        "importance 1-3. Without a configured payer it returns the payment requirements " +
        "and spends nothing.",
      schema: z.object({
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Look-ahead window in days, 1-90 (default 7)"),
        minImportance: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe("Minimum importance 1-3 (default 1 = everything)"),
      }),
    },
  );

  const resource = tool(
    async ({ path, query }) => {
      try {
        // Only allow paths inside the x402 catalog; never absolute URLs.
        if (!/^[a-z0-9][a-z0-9/_-]*$/i.test(path) || path.includes("..")) {
          return JSON.stringify({ error: "invalid_path", path }, null, 2);
        }
        const res = await client.get(`/${path}`, query);
        return ok(res.data, res.settlement);
      } catch (err) {
        return fail(err);
      }
    },
    {
      name: "blockchain_iq_resource",
      description:
        "GET any Blockchain IQ x402 resource by its path below /api/x402/v1, e.g. " +
        "'macro' ($0.05), 'calendar' ($0.03), 'network/bitcoin' ($0.03), 'networks' " +
        "($0.10), 'stablecoins' ($0.02), 'research/ethereum' ($0.05), or the free " +
        "'free/dashboards'. Paid resources follow the same x402 flow as the dedicated " +
        "tools; without a payer they return the payment requirements and spend nothing.",
      schema: z.object({
        path: z
          .string()
          .describe("Resource path below /api/x402/v1, without a leading slash"),
        query: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .describe("Optional query parameters, e.g. { days: 30 } for stablecoins/history"),
      }),
    },
  );

  return [sample, brief, eventRisk, resource];
}
