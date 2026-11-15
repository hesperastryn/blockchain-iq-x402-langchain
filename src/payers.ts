/**
 * Pluggable payers for the x402 flow.
 *
 * A {@link Payer} turns {@link PaymentRequirements} (from a 402 response) into
 * a signed {@link PaymentPayload} that the client sends on retry. The client
 * ships with NO payer by default: paid calls then fail with a
 * `PaymentRequiredError` describing exactly what would have to be paid, and
 * nothing is ever spent implicitly.
 *
 * - {@link MockPayer} fabricates a structurally valid `exact` EVM payload for
 *   tests and demos. It signs nothing and moves no funds; a real server will
 *   reject its payload. Never use it against the live API expecting data.
 * - {@link createX402EvmPayer} builds a real payer on top of the official
 *   `@x402/evm` scheme client, given a signer (for example a viem account).
 *   Settlement on Base is gasless for the payer: the signed EIP-3009
 *   authorization is submitted by a facilitator, so the wallet needs USDC
 *   but no ETH for gas.
 */

import { randomBytes } from "node:crypto";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "./x402.js";

export interface Payer {
  /** Create a payment payload for the chosen requirement. */
  createPaymentPayload(
    requirements: PaymentRequirements,
    required: PaymentRequired,
  ): Promise<PaymentPayload>;
}

export interface MockPayerOptions {
  /** Address placed in the EIP-3009 `from` field. Defaults to a burn-style mock address. */
  from?: string;
}

/**
 * Test/demo payer. Produces an `exact` EVM payload shaped like a real
 * EIP-3009 `transferWithAuthorization` payment, but with a zero signature.
 * Records every call in {@link MockPayer.calls} for assertions.
 */
export class MockPayer implements Payer {
  readonly calls: PaymentRequirements[] = [];
  private readonly from: string;

  constructor(options: MockPayerOptions = {}) {
    this.from = options.from ?? "0x000000000000000000000000000000000000dEaD";
  }

  async createPaymentPayload(
    requirements: PaymentRequirements,
    required: PaymentRequired,
  ): Promise<PaymentPayload> {
    this.calls.push(requirements);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const authorization = {
      from: this.from,
      to: requirements.payTo,
      value: requirements.amount,
      validAfter: "0",
      validBefore: String(nowSeconds + requirements.maxTimeoutSeconds),
      nonce: `0x${randomBytes(32).toString("hex")}`,
    };
    return {
      x402Version: 2,
      resource: required.resource,
      accepted: requirements,
      payload: {
        // 65 zero bytes: structurally a signature, cryptographically worthless.
        signature: `0x${"00".repeat(65)}`,
        authorization,
      },
    };
  }
}

/** A viem-compatible account/signer, kept structural so `viem` stays optional. */
export interface EvmSigner {
  address: `0x${string}`;
  signTypedData: (args: Record<string, unknown>) => Promise<`0x${string}`>;
}

export interface X402EvmPayerOptions {
  signer: EvmSigner;
}

/**
 * Real payer backed by the official `@x402/evm` exact scheme client.
 * Requires the optional peer dependencies `@x402/evm` (and typically `viem`
 * for the signer). The payment is a signed USDC EIP-3009 authorization;
 * settlement is gasless for the payer.
 */
export async function createX402EvmPayer(options: X402EvmPayerOptions): Promise<Payer> {
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const scheme = new ExactEvmScheme(options.signer);
  return {
    async createPaymentPayload(requirements, required) {
      const partial = await scheme.createPaymentPayload(2, requirements);
      return {
        x402Version: 2,
        resource: required.resource,
        accepted: requirements,
        payload: partial.payload,
      };
    },
  };
}

export interface PaidFetchOptions {
  /** A viem account, e.g. `privateKeyToAccount(process.env.AGENT_PRIVATE_KEY)`. */
  account: EvmSigner;
  /** Spend control from the official example: refuse any single call above this many dollars. */
  maxAmountPerPayment?: number;
}

/**
 * Alternative real-payment route that mirrors the official Blockchain IQ
 * example verbatim: wrap `fetch` with `@x402/fetch` so the 402, the payment
 * and the retry are handled by the wrapper. Pass the returned fetch as
 * `fetchFn` to the client; the client's own payer then stays unset.
 * Requires the optional peer dependencies `@x402/fetch`, `@x402/evm`, `viem`.
 */
export async function createPaidFetch(options: PaidFetchOptions): Promise<typeof fetch> {
  const { wrapFetchWithPayment, x402Client } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const client = x402Client.fromConfig({
    schemes: [{ network: "eip155:*", client: new ExactEvmScheme(options.account) }],
    ...(options.maxAmountPerPayment !== undefined
      ? { spendControls: { maxAmountPerPayment: options.maxAmountPerPayment } }
      : {}),
  });
  return wrapFetchWithPayment(fetch, client) as typeof fetch;
}
