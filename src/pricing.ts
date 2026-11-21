import {
  BCMPricingCalculatorClient,
  GetUsageLinesEstimatedCostCommand,
  type RateType,
} from "@aws-sdk/client-bcm-pricing-calculator";
import type { UsageLine } from "./types.js";

/** GetUsageLinesEstimatedCost accepts 1 to 500 usage lines per request. */
export const MAX_LINES_PER_REQUEST = 500;

export const RATE_TYPES: readonly RateType[] = [
  "BEFORE_DISCOUNTS",
  "AFTER_DISCOUNTS",
  "AFTER_DISCOUNTS_AND_COMMITMENTS",
];

export interface LinePrice {
  line: UsageLine;
  /** Monthly cost in USD. Undefined when the line could not be priced. */
  cost?: number;
  error?: string;
}

export interface PricingResult {
  prices: LinePrice[];
}

export type Pricer = (lines: UsageLine[]) => Promise<PricingResult>;

/** The part of the SDK client the pricer uses, so tests can pass a fake. */
export interface PricingClient {
  // biome-ignore lint/suspicious/noExplicitAny: the SDK's overloaded send signature
  send(command: GetUsageLinesEstimatedCostCommand): Promise<any>;
}

/**
 * Prices usage lines with the AWS Pricing Calculator API. The API endpoint lives in us-east-1
 * whatever region the resources are in.
 */
export function createAwsPricer(
  rateType: RateType,
  client: PricingClient = new BCMPricingCalculatorClient({ region: "us-east-1" }),
): Pricer {
  return async (lines) => {
    const prices: LinePrice[] = [];
    for (let start = 0; start < lines.length; start += MAX_LINES_PER_REQUEST) {
      const chunk = lines.slice(start, start + MAX_LINES_PER_REQUEST);
      // Keys must be alphanumeric and at most 10 characters; the index in the chunk is enough.
      const response = await client.send(
        new GetUsageLinesEstimatedCostCommand({
          rateType,
          usage: chunk.map((l, i) => ({
            key: String(i),
            serviceCode: l.serviceCode,
            usageType: l.usageType,
            operation: l.operation,
            amount: l.amount,
          })),
        }),
      );
      const costs = new Map<string, number>();
      for (const item of response.lineItems ?? []) {
        const cost = item.estimatedCost?.cost;
        if (item.key !== undefined && typeof cost === "number") costs.set(item.key, cost);
      }
      const errors = new Map<string, string>();
      for (const e of response.errors ?? []) {
        if (e.key !== undefined) errors.set(e.key, `${e.errorCode}: ${e.errorMessage}`);
      }
      chunk.forEach((line, i) => {
        const key = String(i);
        const cost = costs.get(key);
        if (cost !== undefined) prices.push({ line, cost });
        else
          prices.push({
            line,
            error: errors.get(key) ?? "the API returned no price for this line",
          });
      });
    }
    return { prices };
  };
}
