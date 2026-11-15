/**
 * Minimal x402 protocol v2 types and header codecs.
 *
 * Wire format (verified against the live Blockchain IQ API on 2026-11-15):
 * - A paid resource answers HTTP 402 with a `PAYMENT-REQUIRED` header whose
 *   value is base64-encoded JSON of a {@link PaymentRequired} object.
 * - The client retries with a `PAYMENT-SIGNATURE` header whose value is
 *   base64-encoded JSON of a {@link PaymentPayload} object.
 * - A settled call answers HTTP 200 with a `PAYMENT-RESPONSE` header whose
 *   value is base64-encoded JSON of a {@link SettleResponse} object.
 */

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  /** Amount in the asset's atomic units (USDC has 6 decimals: "10000" = $0.01). */
  amount: string;
  /** Token contract address (EVM) or mint address (Solana). */
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource?: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  /** Scheme-specific payload. For `exact` on EVM: `{ signature, authorization }`. */
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface SettleResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
}

export function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeBase64Json<T>(encoded: string): T {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as T;
}

/** Parse and validate a `PAYMENT-REQUIRED` header value. */
export function parsePaymentRequired(headerValue: string): PaymentRequired {
  const parsed = decodeBase64Json<PaymentRequired>(headerValue);
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.accepts)) {
    throw new Error("Malformed PAYMENT-REQUIRED header: missing accepts list");
  }
  return parsed;
}

/** Parse a `PAYMENT-RESPONSE` header value, returning undefined when absent/invalid. */
export function parsePaymentResponse(headerValue: string | null): SettleResponse | undefined {
  if (!headerValue) return undefined;
  try {
    return decodeBase64Json<SettleResponse>(headerValue);
  } catch {
    return undefined;
  }
}

/**
 * Pick the requirement to pay: an `exact` scheme entry on the preferred
 * network when available, otherwise the first `exact` entry.
 */
export function selectRequirement(
  required: PaymentRequired,
  preferredNetwork = "eip155:8453",
): PaymentRequirements {
  const exact = required.accepts.filter((a) => a.scheme === "exact");
  const pool = exact.length > 0 ? exact : required.accepts;
  const chosen = pool.find((a) => a.network === preferredNetwork) ?? pool[0];
  if (!chosen) {
    throw new Error("PAYMENT-REQUIRED header contains no payment options");
  }
  return chosen;
}

/** Thrown when a resource requires payment but the client has no payer (or the payer failed). */
export class PaymentRequiredError extends Error {
  readonly required: PaymentRequired;
  readonly requirements: PaymentRequirements;

  constructor(required: PaymentRequired, requirements: PaymentRequirements) {
    super(
      `Payment required: ${requirements.amount} atomic units of ${requirements.asset} ` +
        `on ${requirements.network} to ${requirements.payTo} (scheme: ${requirements.scheme})`,
    );
    this.name = "PaymentRequiredError";
    this.required = required;
    this.requirements = requirements;
  }
}

/** Thrown for non-402 HTTP errors from the API (for example the sample endpoint's 503). */
export class BlockchainIQError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Blockchain IQ API error (HTTP ${status}): ${body.slice(0, 300)}`);
    this.name = "BlockchainIQError";
    this.status = status;
    this.body = body;
  }
}
