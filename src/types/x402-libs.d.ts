/**
 * Minimal ambient declarations for the optional peer dependencies used by the
 * real-payment adapters in `../payers.js`. They let this package typecheck
 * without installing `@x402/fetch` / `@x402/evm`; install those packages (and
 * `viem`) to actually pay. Shapes follow the official Blockchain IQ example.
 */

declare module "@x402/evm/exact/client" {
  export class ExactEvmScheme {
    constructor(signer: {
      address: `0x${string}`;
      signTypedData: (args: Record<string, unknown>) => Promise<`0x${string}`>;
    });
    createPaymentPayload(
      x402Version: number,
      paymentRequirements: {
        scheme: string;
        network: string;
        amount: string;
        asset: string;
        payTo: string;
        maxTimeoutSeconds: number;
        extra?: Record<string, unknown>;
      },
    ): Promise<{ x402Version: number; payload: Record<string, unknown> }>;
  }
}

declare module "viem/accounts" {
  export function privateKeyToAccount(key: `0x${string}`): {
    address: `0x${string}`;
    signTypedData: (args: Record<string, unknown>) => Promise<`0x${string}`>;
  };
}

declare module "@x402/fetch" {
  export class x402Client {
    static fromConfig(config: {
      schemes: Array<{ network: string; client: unknown }>;
      spendControls?: { maxAmountPerPayment: number };
    }): x402Client;
  }
  export function wrapFetchWithPayment(
    fetchFn: typeof fetch,
    client: x402Client,
  ): typeof fetch;
  export function decodePaymentResponseHeader(header: string): unknown;
}
