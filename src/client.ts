/**
 * Client for the Blockchain IQ x402 data API.
 *
 * API facts (https://www.blockchainiq.co/agents, verified live 2026-11-15):
 * - Base URL `https://www.blockchainiq.co`, resources under `/api/x402/v1`.
 * - No account, no API key. Free resources: the catalog (`GET /api/x402/v1`),
 *   the sample (`GET /api/x402/v1/sample`) and the free dashboards.
 * - Paid resources answer HTTP 402 with a `PAYMENT-REQUIRED` header
 *   (x402 v2, USDC on Base `eip155:8453`, second rail on Solana). The client
 *   asks its injected {@link Payer} to sign, retries with a
 *   `PAYMENT-SIGNATURE` header, and surfaces the settlement from the
 *   `PAYMENT-RESPONSE` header. Settlement is gasless for the payer.
 * - `/brief` costs $0.01 (amount "10000" atomic USDC) and takes no parameters.
 *   `/event-risk` costs $0.05 and accepts `days` (1-90) and `minImportance`.
 * - A 404 or an error is never charged. The sample returns HTTP 503 when its
 *   figures are missing or stale; that surfaces here as {@link BlockchainIQError}.
 */

import type { Payer } from "./payers.js";
import {
  BlockchainIQError,
  PaymentRequiredError,
  encodeBase64Json,
  parsePaymentRequired,
  parsePaymentResponse,
  selectRequirement,
  type SettleResponse,
} from "./x402.js";

export const DEFAULT_BASE_URL = "https://www.blockchainiq.co";
export const API_PREFIX = "/api/x402/v1";
/** Base mainnet USDC contract, as advertised in the live 402 response. */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_NETWORK = "eip155:8453";

export interface BlockchainIQClientOptions {
  /** Defaults to https://www.blockchainiq.co */
  baseUrl?: string;
  /**
   * Payer used to answer 402 responses. When omitted, paid calls throw
   * {@link PaymentRequiredError} and nothing is spent.
   */
  payer?: Payer;
  /** Custom fetch implementation, e.g. the result of `createPaidFetch`. */
  fetchFn?: typeof fetch;
  /** Preferred payment network. Defaults to Base (`eip155:8453`). */
  network?: string;
  /**
   * Spend cap in atomic units (USDC: "10000" = $0.01). A 402 asking for more
   * is refused before the payer is called.
   */
  maxAmountAtomic?: string;
}

export interface BiqResponse<T> {
  data: T;
  status: number;
  /** Settlement details from the `PAYMENT-RESPONSE` header, when the call was paid. */
  settlement?: SettleResponse;
}

export class BlockchainIQClient {
  private readonly baseUrl: string;
  private readonly payer?: Payer;
  private readonly fetchFn: typeof fetch;
  private readonly network: string;
  private readonly maxAmountAtomic?: bigint;

  constructor(options: BlockchainIQClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.payer = options.payer;
    this.fetchFn = options.fetchFn ?? fetch;
    this.network = options.network ?? BASE_NETWORK;
    this.maxAmountAtomic =
      options.maxAmountAtomic !== undefined ? BigInt(options.maxAmountAtomic) : undefined;
  }

  /**
   * GET a resource path below `/api/x402/v1` (for example `/brief`,
   * `/network/bitcoin`), handling the x402 payment flow when a payer is set.
   */
  async get<T = unknown>(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<BiqResponse<T>> {
    const url = this.buildUrl(path, query);
    let res = await this.fetchFn(url, { method: "GET" });

    if (res.status === 402) {
      res = await this.payAndRetry(url, res);
    }
    if (!res.ok) {
      throw new BlockchainIQError(res.status, await res.text());
    }
    const data = (await res.json()) as T;
    return {
      data,
      status: res.status,
      settlement: parsePaymentResponse(res.headers.get("payment-response")),
    };
  }

  /** The free catalog: every resource, price and response schema. */
  async getCatalog<T = unknown>(): Promise<BiqResponse<T>> {
    return this.get<T>("/");
  }

  /**
   * Free sample: Bitcoin network activity for its latest single day
   * (transactions, active addresses, fees in BTC). Throws
   * {@link BlockchainIQError} with status 503 when the figures are stale.
   */
  async getSample<T = unknown>(): Promise<BiqResponse<T>> {
    return this.get<T>("/sample");
  }

  /** Paid ($0.01): BTC/ETH/SOL/XRP prices and moves, next-48h events, risk flags. */
  async getBrief<T = unknown>(): Promise<BiqResponse<T>> {
    return this.get<T>("/brief");
  }

  /** Paid ($0.05): scheduled market-moving events for the next `days` days. */
  async getEventRisk<T = unknown>(params: { days?: number; minImportance?: number } = {}): Promise<BiqResponse<T>> {
    return this.get<T>("/event-risk", {
      days: params.days,
      minImportance: params.minImportance,
    });
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${API_PREFIX}${normalized}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async payAndRetry(url: string, firstResponse: Response): Promise<Response> {
    const header = firstResponse.headers.get("payment-required");
    if (!header) {
      throw new BlockchainIQError(402, "402 response without a PAYMENT-REQUIRED header");
    }
    const required = parsePaymentRequired(header);
    const requirements = selectRequirement(required, this.network);

    if (this.maxAmountAtomic !== undefined && BigInt(requirements.amount) > this.maxAmountAtomic) {
      throw new Error(
        `Refusing payment: required ${requirements.amount} atomic units exceeds ` +
          `the configured cap of ${this.maxAmountAtomic.toString()}`,
      );
    }
    if (!this.payer) {
      throw new PaymentRequiredError(required, requirements);
    }

    const payload = await this.payer.createPaymentPayload(requirements, required);
    const retry = await this.fetchFn(url, {
      method: "GET",
      headers: { "payment-signature": encodeBase64Json(payload) },
    });
    if (retry.status === 402) {
      const retryHeader = retry.headers.get("payment-required");
      throw new PaymentRequiredError(
        retryHeader ? parsePaymentRequired(retryHeader) : required,
        requirements,
      );
    }
    return retry;
  }
}
